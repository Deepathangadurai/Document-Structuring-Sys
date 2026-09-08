r"""
block_tree_service.py
=====================
Canonical document representation for the Block-Tree extraction pipeline.

Both master templates and uploaded client documents are converted into an
identical hierarchical tree:

    StructuredDocumentTree
    └── DocumentSection (one per detected heading)
        ├── section_number: "4.1.1"
        ├── heading_text:   "11 KV OUTDOOR LOAD BREAK SWITCH"
        ├── level:          3  (derived from dot-count, not Word Heading style)
        ├── blocks: list[ContentBlock]
        │   ├── paragraph  — text + optional field_binding
        │   └── table      — table_data + cell_bindings/row_bindings
        └── subsections: list[DocumentSection]

Key design decisions
--------------------
* A Field is a *property* of a block, not a separate block type.  The parser
  does NOT guess which paragraphs are fields; it only knows headings,
  paragraphs, and tables.  The schema overlay in parse_docx() annotates
  which content blocks carry dynamic values.

* Headings are detected by SECTION_NUM_RE (^\d+(\.\d+)*\s+) and formatting
  heuristics (bold/underlined/caps paragraphs), NOT by paragraph.style.name.
  Real engineering spec documents in this project use style='Normal' for
  all headings — Word Heading styles are absent.

* Section alignment (align_and_populate) uses exact section-number matching
  first, then rapidfuzz token_sort_ratio >= 85 on heading text as fallback.

* Tables support multi-field bindings:
  - row_bindings["2"] → field bound to Col-1 of row 2 (key-value tables)
  - cell_bindings["1:2"] → field bound to cell at row 1, col 2 (grids)
"""

from __future__ import annotations

import copy
import logging
import re
import uuid
from pathlib import Path
from typing import Any, Optional

try:
    from rapidfuzz import fuzz as _fuzz
    _HAS_RAPIDFUZZ = True
except ImportError:
    _HAS_RAPIDFUZZ = False

try:
    from pydantic import BaseModel, Field
    _HAS_PYDANTIC = True
except ImportError:
    _HAS_PYDANTIC = False

try:
    from docx import Document as DocxDocument
    from docx.oxml.ns import qn
    _HAS_DOCX = True
except ImportError:
    _HAS_DOCX = False

try:
    import fitz  # PyMuPDF
    _HAS_FITZ = True
except ImportError:
    _HAS_FITZ = False

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Heading detection — patterns & constants
# ---------------------------------------------------------------------------

# Primary: numbered heading e.g. "4.1.1 11 KV OUTDOOR LOAD BREAK SWITCH"
SECTION_NUM_RE = re.compile(r"^(\d+(?:[\.\s]+\d+)*\.?)\s+(.+)$")

# For unnumbered headings: short, no trailing period, text is ≤ 8 words
_MAX_HEADING_WORDS = 8
_MAX_HEADING_CHARS = 120

SECTION_ALIGN_THRESHOLD = 85  # rapidfuzz token_sort_ratio minimum for section match


# ===========================================================================
# Data models
# ===========================================================================

class FieldProperty:
    """Semantic variable metadata attached to a block or table cell."""

    __slots__ = (
        "field_id", "field_label", "value", "default_value",
        "is_dynamic", "required", "confidence",
        "source_reference", "verification_status",
    )

    def __init__(
        self,
        field_id: str,
        field_label: str,
        value: Optional[str] = None,
        default_value: Optional[str] = None,
        is_dynamic: bool = True,
        required: bool = False,
        confidence: Optional[float] = None,
        source_reference: Optional[dict] = None,
        verification_status: Optional[str] = None,
    ):
        self.field_id = field_id
        self.field_label = field_label
        self.value = value
        self.default_value = default_value
        self.is_dynamic = is_dynamic
        self.required = required
        self.confidence = confidence
        self.source_reference = source_reference
        self.verification_status = verification_status

    def to_dict(self) -> dict:
        return {
            "field_id": self.field_id,
            "field_label": self.field_label,
            "value": self.value,
            "default_value": self.default_value,
            "is_dynamic": self.is_dynamic,
            "required": self.required,
            "confidence": self.confidence,
            "source_reference": self.source_reference,
            "verification_status": self.verification_status,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "FieldProperty":
        return cls(
            field_id=d.get("field_id", ""),
            field_label=d.get("field_label", ""),
            value=d.get("value"),
            default_value=d.get("default_value"),
            is_dynamic=bool(d.get("is_dynamic", True)),
            required=bool(d.get("required", False)),
            confidence=d.get("confidence"),
            source_reference=d.get("source_reference"),
            verification_status=d.get("verification_status"),
        )

    def clone(self) -> "FieldProperty":
        return FieldProperty.from_dict(self.to_dict())


class ContentBlock:
    """Physical content item inside a section.

    block_type in {"paragraph", "table", "bullet_item"}

    For paragraphs:
        field_binding  — optional single field annotation

    For tables:
        table_data     — list[list[str]]  raw cell grid
        row_bindings   — dict keyed by str(row_index)   e.g. {"2": FieldProperty}
                         for key-value parameter tables where col-0 is the label
                         and col-1 is the extracted/entered value.
        cell_bindings  — dict keyed by "row:col"         e.g. {"0:1": FieldProperty}
                         for arbitrary cell → field mappings (signature grids, etc.)
    """

    __slots__ = (
        "block_id", "block_type", "text",
        "field_binding",
        "table_data", "row_bindings", "cell_bindings",
        "page_number",
    )

    def __init__(
        self,
        block_id: str,
        block_type: str,
        text: str = "",
        field_binding: Optional[FieldProperty] = None,
        table_data: Optional[list[list[str]]] = None,
        row_bindings: Optional[dict[str, FieldProperty]] = None,
        cell_bindings: Optional[dict[str, FieldProperty]] = None,
        page_number: Optional[int] = None,
    ):
        self.block_id = block_id
        self.block_type = block_type
        self.text = text
        self.field_binding = field_binding
        self.table_data = table_data
        self.row_bindings = row_bindings
        self.cell_bindings = cell_bindings
        self.page_number = page_number

    def to_dict(self) -> dict:
        d: dict[str, Any] = {
            "block_id": self.block_id,
            "block_type": self.block_type,
            "text": self.text,
            "page_number": self.page_number,
            "field_binding": self.field_binding.to_dict() if self.field_binding else None,
            "table_data": self.table_data,
        }
        if self.row_bindings is not None:
            d["row_bindings"] = {k: v.to_dict() for k, v in self.row_bindings.items()}
        if self.cell_bindings is not None:
            d["cell_bindings"] = {k: v.to_dict() for k, v in self.cell_bindings.items()}
        return d

    @classmethod
    def from_dict(cls, d: dict) -> "ContentBlock":
        fb_raw = d.get("field_binding")
        field_binding = FieldProperty.from_dict(fb_raw) if fb_raw else None

        rb_raw = d.get("row_bindings") or {}
        row_bindings = {k: FieldProperty.from_dict(v) for k, v in rb_raw.items()} if rb_raw else None

        cb_raw = d.get("cell_bindings") or {}
        cell_bindings = {k: FieldProperty.from_dict(v) for k, v in cb_raw.items()} if cb_raw else None

        return cls(
            block_id=d.get("block_id", _uid()),
            block_type=d.get("block_type", "paragraph"),
            text=d.get("text", ""),
            field_binding=field_binding,
            table_data=d.get("table_data"),
            row_bindings=row_bindings,
            cell_bindings=cell_bindings,
            page_number=d.get("page_number"),
        )

    def clone(self) -> "ContentBlock":
        return ContentBlock.from_dict(self.to_dict())


class DocumentSection:
    """Hierarchical section: a heading + ordered content blocks + subsections."""

    def __init__(
        self,
        section_id: str,
        heading_text: str,
        level: int = 1,
        section_number: Optional[str] = None,
        blocks: Optional[list[ContentBlock]] = None,
        subsections: Optional[list["DocumentSection"]] = None,
    ):
        self.section_id = section_id
        self.section_number = section_number  # "4.1.1" or None for unnumbered
        self.heading_text = heading_text
        self.level = level
        self.blocks: list[ContentBlock] = blocks or []
        self.subsections: list["DocumentSection"] = subsections or []

    def to_dict(self) -> dict:
        return {
            "section_id": self.section_id,
            "section_number": self.section_number,
            "heading_text": self.heading_text,
            "level": self.level,
            "blocks": [b.to_dict() for b in self.blocks],
            "subsections": [s.to_dict() for s in self.subsections],
        }

    @classmethod
    def from_dict(cls, d: dict) -> "DocumentSection":
        blocks = [ContentBlock.from_dict(b) for b in (d.get("blocks") or [])]
        subsections = [DocumentSection.from_dict(s) for s in (d.get("subsections") or [])]
        return cls(
            section_id=d.get("section_id", _uid()),
            heading_text=d.get("heading_text", ""),
            level=int(d.get("level", 1)),
            section_number=d.get("section_number"),
            blocks=blocks,
            subsections=subsections,
        )

    def clone(self) -> "DocumentSection":
        return DocumentSection.from_dict(self.to_dict())

    def all_sections_flat(self) -> list["DocumentSection"]:
        """Depth-first flat list of self + all nested subsections."""
        result: list[DocumentSection] = [self]
        for sub in self.subsections:
            for s in sub.all_sections_flat():
                result.append(s)
        return result


class StructuredDocumentTree:
    """Root document model — the canonical form of a master template or upload."""

    def __init__(
        self,
        document_id: str,
        title: str = "",
        specification_number: Optional[str] = None,
        sections: Optional[list[DocumentSection]] = None,
        source_filename: Optional[str] = None,
    ):
        self.document_id = document_id
        self.title = title
        self.specification_number = specification_number
        self.sections: list[DocumentSection] = sections or []
        self.source_filename = source_filename

    def to_dict(self) -> dict:
        return {
            "document_id": self.document_id,
            "title": self.title,
            "specification_number": self.specification_number,
            "source_filename": self.source_filename,
            "sections": [s.to_dict() for s in self.sections],
        }

    @classmethod
    def from_dict(cls, d: dict) -> "StructuredDocumentTree":
        sections = [DocumentSection.from_dict(s) for s in (d.get("sections") or [])]
        return cls(
            document_id=d.get("document_id", _uid()),
            title=d.get("title", ""),
            specification_number=d.get("specification_number"),
            sections=sections,
            source_filename=d.get("source_filename"),
        )

    def all_sections_flat(self) -> list[DocumentSection]:
        """Flat list of every section across the whole document, depth-first."""
        result: list[DocumentSection] = []
        for s in self.sections:
            result.extend(s.all_sections_flat())
        return result


# ===========================================================================
# Heading detection helpers
# ===========================================================================

def _uid() -> str:
    return uuid.uuid4().hex[:12]


def _detect_heading(
    text: str,
    runs_bold: bool,
    runs_underline: bool,
    body_started: bool = True,
) -> tuple[bool, Optional[str], str, int]:
    """Determine whether a paragraph text is a section heading.

    Returns:
        (is_heading, section_number_or_None, clean_heading_text, level)

    Detection rules (applied in priority order):
    1. SECTION_NUM_RE: "4.1.1 TITLE" — most reliable, level = dot count.
    2. Unnumbered uppercase / bold-underline short title (level 1 fallback, only after body has started).
    """
    stripped = text.strip()
    if not stripped or len(stripped) > _MAX_HEADING_CHARS:
        return False, None, stripped, 0

    # Rule A — numbered section (primary, most reliable)
    m = SECTION_NUM_RE.match(stripped)
    if m:
        raw_num = m.group(1).strip().rstrip(".")
        clean_num = re.sub(r"\.\.+", ".", raw_num)
        clean_title = m.group(2).strip()

        # Check if this line is actually a key-value parameter line (e.g. "2.2.1 Equipment Design temp : 45 Deg. C.")
        colon_pos = clean_title.find(":")
        dash_pos = clean_title.find(" - ")
        sep_pos = colon_pos if colon_pos > 0 else dash_pos
        if sep_pos > 0 and len(clean_title[sep_pos + 1:].strip()) > 0:
            # It's a key-value parameter line, not a section heading!
            return False, None, stripped, 0

        sec_num = clean_num
        title = clean_title
        level = len(clean_num.split("."))
        return True, sec_num, title, level

    # Rule B — unnumbered major heading (only once body has started, e.g. "SCOPE", "DESIGN PHILOSOPHY"):
    # short text, no trailing period, and either all-caps or all runs bold/underlined
    word_count = len(stripped.split())
    ends_sentence = stripped.endswith(".")
    is_allcaps = stripped.isupper() and word_count <= _MAX_HEADING_WORDS
    is_formatted = (runs_bold or runs_underline) and word_count <= _MAX_HEADING_WORDS

    # Bullet/checkbox/list lines are never section headings
    if stripped.startswith(("[", "(", "-", "*", "•", "–")):
        return False, None, stripped, 0

    if body_started and not ends_sentence and (is_allcaps or is_formatted):
        # If it has a colon with a value, it's a parameter, not a heading
        colon_pos = stripped.find(":")
        if colon_pos > 0 and len(stripped[colon_pos + 1:].strip()) > 0:
            return False, None, stripped, 0
        return True, None, stripped, 1

    return False, None, stripped, 0


def _para_formatting(para) -> tuple[bool, bool]:
    """Return (any_run_bold, any_run_underlined) for a python-docx paragraph."""
    bold = False
    underline = False
    for run in para.runs:
        if run.text.strip():
            if run.bold:
                bold = True
            if run.underline:
                underline = True
    return bold, underline


# ===========================================================================
# Schema overlay helpers
# ===========================================================================

def _build_field_index(schema: dict) -> dict[str, dict]:
    """Build label→field_info mapping from a schema.json sections structure.

    Used to overlay field_binding annotations on blocks while parsing.
    Keys are lowercase-stripped field labels for case-insensitive lookup.
    """
    index: dict[str, dict] = {}
    for section in schema.get("sections", []):
        for field in section.get("fields", []):
            label = str(field.get("field_label") or "").strip().lower()
            if label:
                index[label] = field
        # Handle table sections
        for row in section.get("rows", []):
            values = row.get("values", [])
            if values:
                label = str(values[0]).strip().lower()
                if label:
                    index[label] = {
                        "field_id": row.get("row_id", label),
                        "field_label": values[0],
                        "is_dynamic": True,
                        "required": False,
                    }
    return index


def _match_field_for_text(text: str, field_index: dict[str, dict]) -> Optional[FieldProperty]:
    """Try to find a field binding for the text of a paragraph block.

    Strategy: look for 'Label: value' or 'Label - value' pattern and
    check if the label portion matches a known schema field.
    """
    colon_pos = text.find(":")
    dash_pos = text.find(" - ")
    sep_pos = -1
    if colon_pos > 0 and (dash_pos < 0 or colon_pos <= dash_pos):
        sep_pos = colon_pos
    elif dash_pos > 0:
        sep_pos = dash_pos

    if sep_pos < 0:
        # No separator — can't be a label:value paragraph
        return None

    raw_label = text[:sep_pos].strip()
    candidate_label = raw_label.lower()
    clean_label = re.sub(r"^\d+(?:[\.\s]+\d+)*\.?\s*", "", candidate_label).strip()

    if not candidate_label or len(candidate_label) > 120:
        return None

    val_text = text[sep_pos + 1:].strip() or None

    # Exact match first
    field = field_index.get(candidate_label) or field_index.get(clean_label)
    if field:
        return FieldProperty(
            field_id=str(field.get("field_id", clean_label or candidate_label)),
            field_label=str(field.get("field_label", raw_label)),
            value=val_text,
            default_value=str(field.get("default_value") or "") or None,
            is_dynamic=bool(field.get("is_dynamic", True)),
            required=bool(field.get("required", False)),
        )

    # Fuzzy match fallback (only when rapidfuzz is available)
    if _HAS_RAPIDFUZZ:
        best_score = 0.0
        best_field = None
        for label_key, fld in field_index.items():
            for target_cand in (clean_label, candidate_label):
                score = _fuzz.token_sort_ratio(target_cand, label_key)
                if score > best_score:
                    best_score = score
                    best_field = fld
        if best_score >= 85 and best_field:
            return FieldProperty(
                field_id=str(best_field.get("field_id", clean_label or candidate_label)),
                field_label=str(best_field.get("field_label", raw_label)),
                value=val_text,
                default_value=str(best_field.get("default_value") or "") or None,
                is_dynamic=bool(best_field.get("is_dynamic", True)),
                required=bool(best_field.get("required", False)),
            )

    return None


# ===========================================================================
# .docx parser
# ===========================================================================

def _iter_body_elements(doc):
    """Yield (element_type, element) for paragraphs and tables in body order.

    python-docx's `doc.paragraphs` and `doc.tables` iterate in isolation;
    `doc.element.body` gives the actual XML order needed to interleave them.
    """
    body = doc.element.body
    for child in body:
        tag = child.tag.split("}")[-1] if "}" in child.tag else child.tag
        if tag == "p":
            yield "paragraph", child
        elif tag == "tbl":
            yield "table", child


def _xml_para_text(p_element, doc) -> tuple[str, bool, bool]:
    """Extract text, bold, and underline state from a raw paragraph XML element."""
    from docx.text.paragraph import Paragraph
    para = Paragraph(p_element, doc)
    bold, underline = _para_formatting(para)
    return para.text, bold, underline


def _xml_table_data(tbl_element, doc) -> list[list[str]]:
    """Extract table cell texts as a 2D list from a raw table XML element.

    Robust to merged cells and irregular column layouts that cause python-docx's
    table.rows indexing to raise IndexError.
    """
    try:
        from docx.table import Table
        tbl = Table(tbl_element, doc)
        rows: list[list[str]] = []
        for row in tbl.rows:
            rows.append([cell.text.strip() for cell in row.cells])
        return rows
    except Exception:
        pass

    # XML fallback: parse direct w:tr and w:tc elements
    ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
    fallback_rows: list[list[str]] = []
    for tr in tbl_element.findall(".//w:tr", ns):
        row_cells = []
        for tc in tr.findall("./w:tc", ns):
            cell_text = "".join(t.text or "" for t in tc.findall(".//w:t", ns)).strip()
            row_cells.append(cell_text)
        if row_cells:
            fallback_rows.append(row_cells)
    return fallback_rows


def parse_docx(
    path: Path,
    document_id: str,
    schema: Optional[dict] = None,
) -> StructuredDocumentTree:
    """Parse a .docx file into a StructuredDocumentTree.

    Args:
        path:        Absolute path to the .docx file.
        document_id: Identifier for the resulting tree (template_id or doc uuid).
        schema:      Optional schema dict used to overlay field_binding
                     annotations on paragraph blocks (for master templates).
    """
    if not _HAS_DOCX:
        raise RuntimeError("python-docx is not installed")

    doc = DocxDocument(str(path))
    field_index = _build_field_index(schema) if schema else {}

    tree = StructuredDocumentTree(
        document_id=document_id,
        title=path.stem,
        source_filename=path.name,
    )

    # Stack-based section building: (section, level)
    # We maintain a flat stack so we can handle arbitrary nesting depth.
    section_stack: list[DocumentSection] = []
    current_section: Optional[DocumentSection] = None

    def _push_section(sec: DocumentSection) -> None:
        nonlocal current_section
        if not section_stack:
            tree.sections.append(sec)
        else:
            parent = section_stack[-1]
            # Nest under parent if level is deeper, else find the right level
            if sec.level > parent.level:
                parent.subsections.append(sec)
            else:
                # Pop back to correct parent level
                while section_stack and section_stack[-1].level >= sec.level:
                    section_stack.pop()
                if section_stack:
                    section_stack[-1].subsections.append(sec)
                else:
                    tree.sections.append(sec)
        section_stack.append(sec)
        current_section = sec

    blk_counter = 0
    in_toc = False
    body_started = False
    pending_heading: Optional[tuple[str, bool, bool]] = None

    for elem_type, elem in _iter_body_elements(doc):
        if elem_type == "paragraph":
            text, bold, underline = _xml_para_text(elem, doc)
            stripped = text.strip()
            if not stripped:
                continue

            stripped_upper = stripped.upper()
            if stripped_upper in ("CONTENTS", "TABLE OF CONTENTS", "INDEX"):
                in_toc = True
                continue

            if in_toc:
                word_count = len(stripped.split())
                if word_count > 8 or (stripped.endswith(".") and word_count > 4):
                    in_toc = False
                    body_started = True
                    if pending_heading:
                        p_text, p_bold, p_underline = pending_heading
                        is_h, sec_num, title, level = _detect_heading(p_text, p_bold, p_underline, body_started=True)
                        if is_h:
                            new_sec = DocumentSection(
                                section_id=f"sec_{_uid()}",
                                section_number=sec_num,
                                heading_text=title,
                                level=level,
                            )
                            _push_section(new_sec)
                        pending_heading = None
                else:
                    pending_heading = (text, bold, underline)
                    continue

            if not body_started:
                # Content before body started is Cover Page / Preamble!
                blk_counter += 1
                preamble = _ensure_preamble(tree)
                preamble.blocks.append(ContentBlock(
                    block_id=f"blk_{blk_counter:04d}",
                    block_type="paragraph",
                    text=text,
                ))
                continue

            is_heading, sec_num, title, level = _detect_heading(
                text, bold, underline, body_started=body_started
            )

            if is_heading:
                new_sec = DocumentSection(
                    section_id=f"sec_{_uid()}",
                    section_number=sec_num,
                    heading_text=title,
                    level=level,
                )
                _push_section(new_sec)
            else:
                # Content block — paragraph or bullet item
                blk_counter += 1
                field_binding = _match_field_for_text(text, field_index) if field_index else None
                block = ContentBlock(
                    block_id=f"blk_{blk_counter:04d}",
                    block_type="paragraph",
                    text=text,
                    field_binding=field_binding,
                )
                if current_section is not None:
                    current_section.blocks.append(block)
                else:
                    # Content before any section heading → preamble section
                    preamble = _ensure_preamble(tree)
                    preamble.blocks.append(block)

        elif elem_type == "table":
            table_data = _xml_table_data(elem, doc)
            if not table_data:
                continue
            blk_counter += 1

            # Build row_bindings if schema is provided
            row_bindings: Optional[dict[str, FieldProperty]] = None
            if field_index:
                row_bindings = {}
                for r_idx, row in enumerate(table_data):
                    if not row:
                        continue
                    label_candidate = row[0].strip().lower()
                    if not label_candidate:
                        continue
                    field = field_index.get(label_candidate)
                    if not field and _HAS_RAPIDFUZZ:
                        best_score = 0.0
                        best_field = None
                        for lk, fld in field_index.items():
                            score = _fuzz.token_sort_ratio(label_candidate, lk)
                            if score > best_score:
                                best_score = score
                                best_field = fld
                        if best_score >= 85 and best_field:
                            field = best_field
                    if field:
                        row_bindings[str(r_idx)] = FieldProperty(
                            field_id=str(field.get("field_id", label_candidate)),
                            field_label=str(field.get("field_label", row[0].strip())),
                            is_dynamic=bool(field.get("is_dynamic", True)),
                            required=bool(field.get("required", False)),
                            default_value=str(field.get("default_value") or "") or None,
                        )
                if not row_bindings:
                    row_bindings = None

            block = ContentBlock(
                block_id=f"blk_{blk_counter:04d}",
                block_type="table",
                table_data=table_data,
                row_bindings=row_bindings,
            )
            if current_section is not None:
                current_section.blocks.append(block)
            else:
                preamble = _ensure_preamble(tree)
                preamble.blocks.append(block)

    return tree


def _ensure_preamble(tree: StructuredDocumentTree) -> DocumentSection:
    """Return (creating if necessary) a top-level preamble section for
    content that appears before the first detected heading."""
    if tree.sections and tree.sections[0].section_number is None and tree.sections[0].heading_text == "__preamble__":
        return tree.sections[0]
    preamble = DocumentSection(
        section_id="sec_preamble",
        heading_text="__preamble__",
        level=0,
    )
    tree.sections.insert(0, preamble)
    return preamble


# ===========================================================================
# .pdf parser
# ===========================================================================

def parse_pdf(
    path: Path,
    document_id: str,
) -> StructuredDocumentTree:
    """Parse a PDF into a StructuredDocumentTree using PyMuPDF.

    Note: This path is less precise than parse_docx(). PDFs don't carry
    explicit style/run metadata, so heading detection relies purely on the
    SECTION_NUM_RE pattern and font-size heuristics.  In practice, numbered
    section headings (4.1.1 TITLE) are reliably detected; unnumbered headings
    may occasionally be missed.
    """
    if not _HAS_FITZ:
        raise RuntimeError("PyMuPDF (fitz) is not installed")

    tree = StructuredDocumentTree(
        document_id=document_id,
        title=path.stem,
        source_filename=path.name,
    )

    pdf = fitz.open(str(path))  # type: ignore[attr-defined]

    section_stack: list[DocumentSection] = []
    current_section: Optional[DocumentSection] = None
    blk_counter = 0

    def _push_section(sec: DocumentSection) -> None:
        nonlocal current_section
        if not section_stack:
            tree.sections.append(sec)
        else:
            parent = section_stack[-1]
            if sec.level > parent.level:
                parent.subsections.append(sec)
            else:
                while section_stack and section_stack[-1].level >= sec.level:
                    section_stack.pop()
                if section_stack:
                    section_stack[-1].subsections.append(sec)
                else:
                    tree.sections.append(sec)
        section_stack.append(sec)
        current_section = sec

    for page_num, page in enumerate(pdf, start=1):
        blocks = page.get_text("blocks")  # (x0, y0, x1, y1, text, block_no, block_type)
        for block in blocks:
            if block[6] != 0:  # skip image blocks
                continue
            raw_text = block[4].strip()
            if not raw_text:
                continue

            # Split into lines; each line may be a heading or a content line
            for line in raw_text.splitlines():
                line = line.strip()
                if not line:
                    continue

                # PDF: no run metadata — use only SECTION_NUM_RE for detection
                # (font-size heuristic: block[3]-block[1] / number_of_lines as
                # a rough proxy is unreliable; numbered pattern is far more precise)
                is_heading, sec_num, title, level = _detect_heading(
                    line,
                    runs_bold=False,    # not available from PDF text blocks
                    runs_underline=False,
                )

                if is_heading:
                    new_sec = DocumentSection(
                        section_id=f"sec_{_uid()}",
                        section_number=sec_num,
                        heading_text=title,
                        level=level,
                    )
                    _push_section(new_sec)
                else:
                    blk_counter += 1
                    block_obj = ContentBlock(
                        block_id=f"blk_{blk_counter:04d}",
                        block_type="paragraph",
                        text=line,
                        page_number=page_num,
                    )
                    if current_section is not None:
                        current_section.blocks.append(block_obj)
                    else:
                        preamble = _ensure_preamble(tree)
                        preamble.blocks.append(block_obj)

    pdf.close()
    return tree


# ===========================================================================
# Section-to-section alignment and tree population
# ===========================================================================

def _section_key(sec: DocumentSection) -> str:
    """Canonical string used for exact section number comparison."""
    return (sec.section_number or "").strip().rstrip(".")


def _find_best_match(
    master_sec: DocumentSection,
    upload_sections: list[DocumentSection],
) -> Optional[DocumentSection]:
    """Find the best matching uploaded section for a master section.

    Priority:
    1. Exact section_number match (e.g. "4.1.1" == "4.1.1").
    2. rapidfuzz token_sort_ratio >= SECTION_ALIGN_THRESHOLD on heading_text.
    """
    master_key = _section_key(master_sec)

    # Pass 1: exact number match
    if master_key:
        for up_sec in upload_sections:
            if _section_key(up_sec) == master_key:
                return up_sec

    # Pass 2: fuzzy heading text match
    if _HAS_RAPIDFUZZ:
        best_score = 0.0
        best_match: Optional[DocumentSection] = None
        master_heading_norm = master_sec.heading_text.strip().lower()
        for up_sec in upload_sections:
            score = _fuzz.token_sort_ratio(
                master_heading_norm,
                up_sec.heading_text.strip().lower(),
            )
            if score > best_score:
                best_score = score
                best_match = up_sec
        if best_score >= SECTION_ALIGN_THRESHOLD and best_match:
            return best_match

    return None


def _build_upload_text_for_section(upload_sec: DocumentSection) -> str:
    """Concatenate all paragraph text from an uploaded section into a single
    searchable string for field value extraction."""
    lines: list[str] = []
    for block in upload_sec.blocks:
        if block.block_type in ("paragraph", "bullet_item") and block.text:
            lines.append(block.text)
        elif block.block_type == "table" and block.table_data:
            for row in block.table_data:
                lines.append("\t".join(cell for cell in row if cell))
    return "\n".join(lines)


_LABEL_VALUE_SPLIT_RE = re.compile(r"(?::\s*| - )(.*)", re.DOTALL)


def _extract_value_for_field(
    field_label: str,
    section_text: str,
    page_number: Optional[int] = None,
) -> Optional[tuple[str, float, dict]]:
    """Search section_text for 'field_label: value' and return (value, confidence, source_ref).

    Returns None if not found.
    """
    # Build a simple pattern: (label variants) followed by colon or dash, then value
    label_escaped = re.escape(field_label.strip())
    pattern = re.compile(
        rf"(?:{label_escaped})\s*[:\-]?\s*(.+)",
        re.IGNORECASE,
    )

    for line in section_text.splitlines():
        m = pattern.search(line.strip())
        if m:
            value = m.group(1).strip()
            if value:
                return (
                    value,
                    1.0,
                    {"page_number": page_number, "source_text": line.strip(), "bounding_box": None},
                )

    # Fuzzy label matching on lines
    if _HAS_RAPIDFUZZ:
        best_score = 0.0
        best_line = ""
        best_value = ""
        for line in section_text.splitlines():
            line = line.strip()
            if not line:
                continue
            colon_pos = line.find(":")
            if colon_pos <= 0:
                continue
            candidate_label = line[:colon_pos].strip()
            score = _fuzz.WRatio(field_label.lower(), candidate_label.lower())
            if score > best_score:
                best_score = score
                best_line = line
                best_value = line[colon_pos + 1:].strip()
        if best_score >= 85 and best_value:
            confidence = round(min(best_score / 100.0, 0.94), 3)
            return (
                best_value,
                confidence,
                {"page_number": page_number, "source_text": best_line, "bounding_box": None},
            )

    return None


def _populate_section(
    master_sec: DocumentSection,
    upload_sec: DocumentSection,
) -> None:
    """Populate dynamic field values in master_sec blocks from upload_sec content.

    Mutates master_sec in-place (which is already a clone of the original master).
    """
    section_text = _build_upload_text_for_section(upload_sec)

    # Find page_number hint from the upload section's blocks
    page_hint: Optional[int] = None
    for blk in upload_sec.blocks:
        if blk.page_number is not None:
            page_hint = blk.page_number
            break

    # Populate paragraph field_bindings
    for block in master_sec.blocks:
        if block.block_type == "paragraph" and block.field_binding and block.field_binding.is_dynamic:
            result = _extract_value_for_field(
                block.field_binding.field_label,
                section_text,
                page_hint,
            )
            if result:
                value, confidence, source_ref = result
                block.field_binding.value = value
                block.field_binding.confidence = confidence
                block.field_binding.source_reference = source_ref

        # Populate table row_bindings
        if block.block_type == "table" and block.row_bindings:
            # Build upload table rows for comparison
            upload_table_rows: list[list[str]] = []
            for ub in upload_sec.blocks:
                if ub.block_type == "table" and ub.table_data:
                    upload_table_rows.extend(ub.table_data)

            for row_key, fp in block.row_bindings.items():
                if not fp.is_dynamic:
                    continue
                # Match by row label (col-0) in upload table rows
                label_norm = fp.field_label.strip().lower()
                for urow in upload_table_rows:
                    if not urow:
                        continue
                    ucell0 = urow[0].strip().lower()
                    score = _fuzz.token_sort_ratio(label_norm, ucell0) if _HAS_RAPIDFUZZ else (
                        100 if label_norm == ucell0 else 0
                    )
                    if score >= 85 and len(urow) > 1:
                        fp.value = urow[1].strip() or None
                        fp.confidence = round(min(score / 100.0, 1.0), 3)
                        fp.source_reference = {
                            "page_number": page_hint,
                            "source_text": "\t".join(urow),
                            "bounding_box": None,
                        }
                        break

        # Populate table cell_bindings
        if block.block_type == "table" and block.cell_bindings:
            # Use the section text for cell-level extraction
            for cell_key, fp in block.cell_bindings.items():
                if not fp.is_dynamic:
                    continue
                result = _extract_value_for_field(fp.field_label, section_text, page_hint)
                if result:
                    value, confidence, source_ref = result
                    fp.value = value
                    fp.confidence = confidence
                    fp.source_reference = source_ref


def align_and_populate(
    master_tree: StructuredDocumentTree,
    upload_tree: StructuredDocumentTree,
) -> StructuredDocumentTree:
    """Clone the master tree and populate dynamic field values from the upload tree.

    - All static boilerplate (paragraphs, headings, tables without field_binding)
      is preserved exactly from the master clone.
    - Dynamic field blocks get their 'value' populated when a matching upload
      section is found; otherwise they keep 'default_value'.
    - Upload document's page-number ordering is irrelevant: matching is purely
      by section_number and heading_text.

    Returns:
        A new StructuredDocumentTree (clone of master) with values populated.
    """
    # Deep-clone the master so we never mutate the original
    populated = StructuredDocumentTree.from_dict(master_tree.to_dict())
    populated.document_id = f"populated_{master_tree.document_id}"

    upload_flat = upload_tree.all_sections_flat()
    master_flat = populated.all_sections_flat()

    for master_sec in master_flat:
        upload_sec = _find_best_match(master_sec, upload_flat)
        if upload_sec is None:
            logger.debug(
                "No upload match for master section %r (%s) — keeping defaults",
                master_sec.heading_text,
                master_sec.section_number,
            )
            continue

        logger.debug(
            "Aligned master %r → upload %r",
            master_sec.heading_text,
            upload_sec.heading_text,
        )
        _populate_section(master_sec, upload_sec)

    return populated


# ===========================================================================
# Convenience: extract flat field list from a populated tree
# ===========================================================================

def extract_fields_from_tree(tree: StructuredDocumentTree) -> list[dict]:
    """Flatten all FieldProperty instances from a tree into a list of dicts.

    Useful for populating the extracted_fields relational table alongside
    the JSON populated_tree for backward-compatible dashboard queries.
    """
    fields: list[dict] = []
    for sec in tree.all_sections_flat():
        for block in sec.blocks:
            if block.field_binding:
                fp = block.field_binding
                fields.append({
                    "field_id": fp.field_id,
                    "field_label": fp.field_label,
                    "value": fp.value,
                    "default_value": fp.default_value,
                    "confidence": fp.confidence,
                    "is_dynamic": fp.is_dynamic,
                    "required": fp.required,
                    "source_reference": fp.source_reference,
                    "section_id": sec.section_id,
                    "section_number": sec.section_number,
                })
            if block.row_bindings:
                for fp in block.row_bindings.values():
                    fields.append({
                        "field_id": fp.field_id,
                        "field_label": fp.field_label,
                        "value": fp.value,
                        "default_value": fp.default_value,
                        "confidence": fp.confidence,
                        "is_dynamic": fp.is_dynamic,
                        "required": fp.required,
                        "source_reference": fp.source_reference,
                        "section_id": sec.section_id,
                        "section_number": sec.section_number,
                    })
            if block.cell_bindings:
                for fp in block.cell_bindings.values():
                    fields.append({
                        "field_id": fp.field_id,
                        "field_label": fp.field_label,
                        "value": fp.value,
                        "default_value": fp.default_value,
                        "confidence": fp.confidence,
                        "is_dynamic": fp.is_dynamic,
                        "required": fp.required,
                        "source_reference": fp.source_reference,
                        "section_id": sec.section_id,
                        "section_number": sec.section_number,
                    })
    return fields
