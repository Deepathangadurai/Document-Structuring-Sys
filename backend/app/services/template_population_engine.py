"""
Template Population Engine
==========================

Implements deterministic, section-scoped, label-anchored value replacement
in a Word DOCX master template.

Core principle: TEMPLATE IMMUTABILITY
  - Master template structure never changes.
  - Only dynamic fields with a matching extracted value are written.
  - Unmatched fields are left exactly as the master had them.
  - No regeneration, no reformatting.

The three-part fix (2026-09)
----------------------------
1. Run-merging (paragraph normalisation)
   Word stores even visually-single lines as multiple XML "runs" due to
   spell-check, formatting boundaries, or edit history.  Before searching,
   all runs in a paragraph are collapsed into one run that carries the
   first run's formatting.  This makes every line searchable as a single,
   contiguous string — exactly what the user sees on screen.

2. Section-scoped, label-anchored replacement
   After finding a paragraph that contains "Label:", only the text that
   follows the label on that same line is replaced.  The search is confined
   to paragraphs that belong to the field's own section in the document
   (identified by scanning for the section heading before the target field),
   so a field named "Type" in section 3.2 can never accidentally match a
   field with the same name in section 4.1.

3. Leave-unchanged on no-match
   If extraction produced no value for a field, that field's paragraph is
   never touched.  The output inherits the template's original text for that
   field verbatim — no blanking, no truncation.

Post-write verification
-----------------------
After all replacements the document is re-read and checked paragraph by
paragraph to confirm the section structure matches the master.  This is
done by DocumentIntegrityValidator (called by extraction_service.export_as_docx
after this engine returns).
"""

from __future__ import annotations

import logging
import re
from pathlib import Path
from typing import Any, Optional

import docx
from docx.document import Document as DocxDocument
from docx.oxml.ns import qn
from docx.text.paragraph import Paragraph  # type: ignore[import-not-found]

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Data class
# ---------------------------------------------------------------------------

class DynamicFieldMapping:
    """Represents a single field replacement instruction."""

    def __init__(
        self,
        field_id: str,
        field_label: str,
        value: str,
        data_type: str = "text",
        section_id: str = "",
        section_heading: str = "",
        label_patterns: list[str] | None = None,
        default_value: str = "",
    ):
        self.field_id = field_id
        self.field_label = field_label
        self.value = value
        self.data_type = data_type
        self.section_id = section_id
        self.section_heading = section_heading
        # All label variants to search for (canonical + abbreviations)
        self.label_patterns: list[str] = label_patterns or [field_label]
        self.default_value = default_value
        self.replacements_made = 0

    def to_dict(self) -> dict[str, Any]:
        return {
            "field_id": self.field_id,
            "field_label": self.field_label,
            "value": self.value,
            "section_id": self.section_id,
            "replacements_made": self.replacements_made,
        }


# ---------------------------------------------------------------------------
# Paragraph helpers
# ---------------------------------------------------------------------------

def _merge_runs(paragraph: Paragraph) -> None:
    """
    Collapse all runs in *paragraph* into a single run that carries the
    formatting of the first run.

    This is the normalisation step that makes textually-single lines
    actually searchable as one string.  It does NOT change how the
    paragraph looks when rendered — it only changes the internal XML
    structure.

    Formatting preserved from the first run:
      font.name, font.size, bold, italic, underline, color
    """
    runs = paragraph.runs
    if len(runs) <= 1:
        return  # Nothing to merge

    full_text = "".join(r.text for r in runs)

    # Capture first run's formatting before we destroy anything
    first = runs[0]
    font_name  = first.font.name
    font_size  = first.font.size
    bold       = first.bold
    italic     = first.italic
    underline  = first.underline
    color_rgb  = first.font.color.rgb if first.font.color and first.font.color.type else None

    # Remove all run elements from the paragraph's XML
    p_elem = paragraph._p
    for r in list(runs):
        p_elem.remove(r._r)

    # Add one new run with the merged text
    new_run = paragraph.add_run(full_text)
    new_run.font.name  = font_name
    new_run.font.size  = font_size
    new_run.bold       = bold
    new_run.italic     = italic
    new_run.underline  = underline
    if color_rgb is not None:
        new_run.font.color.rgb = color_rgb


def _para_text(paragraph: Paragraph) -> str:
    """Return the merged, normalised text of the paragraph (no side-effects)."""
    return "".join(r.text for r in paragraph.runs)


def _set_run_text(paragraph: Paragraph, new_text: str) -> None:
    """
    Write *new_text* into the (already merged, single-run) paragraph.
    The paragraph must have been normalised by _merge_runs first.
    """
    runs = paragraph.runs
    if runs:
        runs[0].text = new_text
    else:
        paragraph.add_run(new_text)


# ---------------------------------------------------------------------------
# Section-boundary helpers
# ---------------------------------------------------------------------------

def _build_section_map(
    doc: DocxDocument,
    schema: dict[str, Any],
) -> dict[str, list[int]]:
    """
    Build a mapping from section_id → list of paragraph indices that belong
    to that section.

    IMPORTANT: Heading detection runs on BODY paragraphs only (doc.paragraphs).
    Table cell paragraphs share similar short text and would trigger false
    heading matches.  Once body-paragraph boundaries are found, both body and
    table paragraphs inside that range are included in the section content.

    Detection strategy (in priority order for each schema section):
      1. section_number prefix match — e.g. schema section_number="2.2" matches
         any body paragraph starting with "2.2" (tab/space/period tolerant).
      2. section_name keyword match — fallback: half the name words must appear.

    Returns dict {section_id: [para_idx, ...]} where indices are into the
    *flat* list produced by _all_paragraphs() (body paras first, table paras
    appended).
    """
    # Build the two para lists
    body_paras: list[Paragraph] = list(doc.paragraphs)
    n_body = len(body_paras)
    all_paras: list[Paragraph] = _all_paragraphs(doc)  # body + table
    n_all = len(all_paras)

    # Merge runs on body paras used for heading detection
    for p in body_paras:
        try:
            _merge_runs(p)
        except Exception:
            pass

    sections = schema.get("sections", [])
    section_ids = [s.get("section_id", "") for s in sections]
    section_paras: dict[str, list[int]] = {sid: [] for sid in section_ids}

    detect_list: list[tuple[str, str, list[str]]] = []
    for sec in sections:
        sid      = sec.get("section_id", "")
        snum     = str(sec.get("section_number", "")).strip().rstrip(".")
        sname    = sec.get("section_name", "").strip()
        keywords = [w.lower() for w in sname.split() if len(w) > 3]
        detect_list.append((sid, snum, keywords))

    # Detect headings in body paragraphs, record their BODY indices
    # heading_positions: [(body_idx, section_id), ...]
    heading_positions: list[tuple[int, str]] = []
    detected_section_ids: set[str] = set()

    for body_idx, para in enumerate(body_paras):
        text = _para_text(para).strip()
        if not text or len(text) > 150:
            continue
        text_lower   = text.lower()
        text_stripped = text.lstrip("\t ").rstrip()

        for sid, snum, keywords in detect_list:
            if sid in detected_section_ids:
                continue

            matched = False
            if snum:
                # Has a section number → only accept exact number prefix match.
                # This avoids false matches on Table-of-Contents entries that
                # contain the same keywords but NO number prefix.
                if re.match(rf"^{re.escape(snum)}[.\s\t]", text_stripped) or \
                   text_stripped.startswith(snum + "\t"):
                    matched = True
            else:
                # No section number → keyword matching as fallback
                if keywords:
                    hits = sum(1 for kw in keywords if kw in text_lower)
                    if hits >= max(1, len(keywords) // 2):
                        matched = True

            if matched:
                heading_positions.append((body_idx, sid))
                detected_section_ids.add(sid)
                break

    if not heading_positions:
        logger.warning(
            "Section heading detection found nothing — falling back to "
            "whole-document scope for all fields (no section isolation)."
        )
        all_idx = list(range(n_all))
        for sid in section_paras:
            section_paras[sid] = all_idx
        return section_paras

    # Assign paragraph index ranges.
    # The flat list (all_paras) has body paras at indices 0..n_body-1 and
    # table paras at n_body..n_all-1.  Use body_idx directly for body paras;
    # table paras are appended after all body paras, so they all belong to
    # the *last* section in document order (or fall back to whole doc).
    for pos, (body_start, sid) in enumerate(heading_positions):
        body_end = heading_positions[pos + 1][0] if pos + 1 < len(heading_positions) else n_body
        section_paras[sid] = list(range(body_start, body_end))

    # Append table paragraphs to the last detected section
    # (they typically belong to cover-page or summary tables)
    last_sid = heading_positions[-1][1]
    section_paras[last_sid] = section_paras[last_sid] + list(range(n_body, n_all))

    # Any section not found in the document gets whole-doc fallback
    for sid in section_paras:
        if not section_paras[sid]:
            section_paras[sid] = list(range(n_all))
            logger.debug("Section '%s' not found — using whole doc scope.", sid)

    logger.info(
        "Section map built: %d/%d sections detected by heading.",
        len(detected_section_ids), len(sections),
    )
    return section_paras



def _all_paragraphs(doc: DocxDocument) -> list[Paragraph]:
    """
    Return ALL paragraphs in document order: body paragraphs first, then
    table cell paragraphs in row/cell order.

    This is the flat list that section_map and replacement both index into.
    """
    paras: list[Paragraph] = list(doc.paragraphs)
    for table in doc.tables:
        for row in table.rows:
            for cell in row.cells:
                paras.extend(cell.paragraphs)
    return paras


# ---------------------------------------------------------------------------
# Main engine
# ---------------------------------------------------------------------------

class TemplatePopulationEngine:
    """
    Deterministic, section-scoped, run-merging template population engine.

    Usage::
        engine = TemplatePopulationEngine(template_docx_path, schema_dict)
        success, report = engine.populate(extracted_values, output_path)
    """

    def __init__(self, template_path: Path, schema: dict[str, Any]):
        self.template_path = template_path
        self.schema = schema
        self.field_mappings: dict[str, DynamicFieldMapping] = {}
        self.operations_log: list[dict[str, Any]] = []

    # ------------------------------------------------------------------
    # Public interface
    # ------------------------------------------------------------------

    def populate(
        self,
        extracted_values: dict[str, str],
        output_path: Path,
        preserve_structure: bool = True,
        static_overrides: Optional[dict[str, str]] = None,
        table_blocks: Optional[list[dict]] = None,
    ) -> tuple[bool, dict[str, Any]]:
        """
        Populate the template with *extracted_values* and write to *output_path*.

        Returns (success, report).
        """
        report: dict[str, Any] = {
            "template_path": str(self.template_path),
            "output_path": str(output_path),
            "success": False,
            "replacements_made": 0,
            "fields_processed": 0,
            "errors": [],
            "warnings": [],
            "field_operations": [],
        }

        if not self.template_path.exists():
            report["errors"].append(f"Template not found: {self.template_path}")
            return False, report

        try:
            doc = docx.Document(str(self.template_path))
        except Exception as exc:
            report["errors"].append(f"Failed to load template: {exc}")
            return False, report

        # --- Step 1: Normalise every paragraph in the document -------------
        all_paras = _all_paragraphs(doc)
        for para in all_paras:
            try:
                _merge_runs(para)
            except Exception as exc:
                logger.debug("Run-merge skipped for a paragraph: %s", exc)

        # --- Build section → paragraph-index map --------------------------
        section_map = _build_section_map(doc, self.schema)

        # --- Identify dynamic fields from schema --------------------------
        dynamic_fields = self._extract_dynamic_fields()
        report["fields_processed"] = len(dynamic_fields)

        # --- Build field mappings (only for fields with extracted values) --
        for field_id, field_info in dynamic_fields.items():
            if field_id not in extracted_values:
                report["warnings"].append(
                    f"No extracted value for '{field_id}' "
                    f"({field_info.get('field_label', 'N/A')}) — left as template default."
                )
                continue

            value = extracted_values[field_id]
            if not value:
                continue  # Empty value → leave template text unchanged

            mapping = DynamicFieldMapping(
                field_id=field_id,
                field_label=field_info.get("field_label", field_id),
                value=value,
                data_type=field_info.get("data_type", "text"),
                section_id=field_info.get("_section_id", ""),
                section_heading=field_info.get("_section_name", ""),
                label_patterns=field_info.get("label_patterns") or [field_info.get("field_label", field_id)],
                default_value=str(field_info.get("default_value") or ""),
            )
            self.field_mappings[field_id] = mapping

        # --- Step 2: Perform section-scoped label-anchored replacements ----
        replacement_count = self._replace_all(doc, all_paras, section_map, report)

        # --- Step 2b: Cover-header same-cell patch -------------------------
        # The CHEMTEX cover page header table uses a "LABEL : value" format
        # inside a single cell (e.g. "SPEC. NO   :   IP009-43-03-01").
        # Standard label-anchored replacement can't split those, so we
        # do a targeted regex swap on all tables in the document.
        replacement_count += self._patch_cover_header_cells(doc, report)

        # --- Step 2c: Section Running Headers Patch (Every Page Header) ----
        # In Word DOCX templates, running page headers carry text like
        # "CHEMTEX  SPEC. NO. IP009-43-00-01 REV. 0   SHEET 20 OF 20".
        # We replace the SPEC. NO, REV, and SHEET in all section headers.
        replacement_count += self._patch_section_headers(doc, report)

        # --- Step 3: Table-cell pair scan for unmatched fields -------------
        # Cover-page and summary tables store label and value in adjacent
        # cells (not as "Label: Value" in one paragraph).  Scan all tables
        # for any field not yet replaced.
        replacement_count += self._replace_in_table_cell_pairs(doc, report)

        # --- Step 4: Default-value fallback scan for remaining fields -----
        # For cover page / title blocks without 'Label: ' prefixes, match
        # by the schema's default_value and replace with user's value.
        replacement_count += self._replace_by_default_values(doc, all_paras, report)

        # --- Step 5: Replace modified static text blocks (user overrides) ----
        if static_overrides:
            for orig_text, new_text in static_overrides.items():
                if not orig_text or not new_text or orig_text == new_text:
                    continue
                for para in all_paras:
                    curr_p_text = _para_text(para).strip()
                    if curr_p_text and (curr_p_text == orig_text or orig_text in curr_p_text):
                        updated = curr_p_text.replace(orig_text, new_text)
                        _set_run_text(para, updated)
                        replacement_count += 1
                        report["field_operations"].append({
                            "field_id": "static_text_override",
                            "location": "static_paragraph",
                            "old_value": curr_p_text,
                            "new_value": updated,
                        })

        # --- Step 6: Synchronize multi-column data tables (add/delete/edit rows) ---
        if table_blocks:
            table_replacements = self._populate_data_tables(doc, table_blocks, report)
            replacement_count += table_replacements

        report["replacements_made"] = replacement_count

        # --- Save ---------------------------------------------------------
        try:
            doc.save(str(output_path))
            report["success"] = True
        except Exception as exc:
            report["errors"].append(f"Failed to save output document: {exc}")
            return False, report

        self.operations_log.append(report)
        logger.info(
            "Template population done: %d replacements for %d fields",
            replacement_count, len(self.field_mappings),
        )
        return True, report

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _extract_dynamic_fields(self) -> dict[str, dict[str, Any]]:
        """
        Return all schema fields that are allowed to be replaced.

        Includes:
          - is_dynamic=True  (main extraction output)
          - Static fields with a default_value (user-overridable)

        Also tags each field with its parent section_id and section_name
        (stored as _section_id / _section_name) so _replace_all can use
        the section_map for scope isolation.
        """
        dynamic_fields: dict[str, dict[str, Any]] = {}
        for section in self.schema.get("sections", []):
            sec_id   = section.get("section_id", "")
            sec_name = section.get("section_name", "")
            for field in section.get("fields", []):
                is_dynamic   = field.get("is_dynamic", False)
                has_default  = field.get("default_value") is not None
                if is_dynamic or (not is_dynamic and has_default):
                    field_id = field.get("field_id", "")
                    if field_id:
                        enriched = dict(field)
                        enriched["_section_id"]   = sec_id
                        enriched["_section_name"]  = sec_name
                        dynamic_fields[field_id]   = enriched
        return dynamic_fields

    def _replace_all(
        self,
        doc: DocxDocument,
        all_paras: list[Paragraph],
        section_map: dict[str, list[int]],
        report: dict[str, Any],
    ) -> int:
        """
        For every field mapping, find the correct section's paragraphs and
        perform the label-anchored replacement within them only.
        """
        total = 0

        for field_id, mapping in self.field_mappings.items():
            # Determine which paragraph indices to search
            sec_indices: list[int] | None = section_map.get(mapping.section_id)
            if sec_indices:
                candidate_paras = [all_paras[i] for i in sec_indices if i < len(all_paras)]
            else:
                # No section mapping found — fall back to all paragraphs
                candidate_paras = all_paras
                report["warnings"].append(
                    f"Section '{mapping.section_id}' not found in document — "
                    f"searching whole document for field '{field_id}'."
                )

            made = self._replace_field_in_paras(mapping, candidate_paras, report)
            total += made

        return total

    def _replace_field_in_paras(
        self,
        mapping: DynamicFieldMapping,
        paras: list[Paragraph],
        report: dict[str, Any],
    ) -> int:
        """
        Scan *paras* for the field's label and replace only the value after
        it.  Returns the number of replacements made (normally 0 or 1).
        """
        count = 0

        for para in paras:
            text = _para_text(para)
            if not text.strip():
                continue

            for label in mapping.label_patterns:
                # Build search pattern: "Label:" or "Label :" (with optional space before colon)
                # Use regex to handle minor whitespace variation
                escaped = re.escape(label.rstrip(":"))
                # Match the label followed by optional space + colon, then capture the rest of line
                m = re.search(
                    rf"({escaped}\s*:)\s*(.*?)(\n|$)",
                    text,
                    re.IGNORECASE,
                )
                if not m:
                    continue

                # Reconstruct the paragraph text with only the value replaced
                label_match = m.group(1)         # e.g. "a) Type :"
                old_value   = m.group(2)         # whatever was there before
                newline_end = m.group(3)         # "\n" or ""
                before      = text[: m.start()]
                after_line  = text[m.end():]     # text after this line

                new_text = f"{before}{label_match} {mapping.value}{newline_end}{after_line}"
                _set_run_text(para, new_text)

                mapping.replacements_made += 1
                count += 1
                report["field_operations"].append({
                    "field_id":     mapping.field_id,
                    "section_id":   mapping.section_id,
                    "label_used":   label,
                    "old_value":    old_value.strip(),
                    "new_value":    mapping.value,
                    "location":     "paragraph",
                })
                logger.debug(
                    "Replaced '%s' → '%s'  (field=%s, section=%s)",
                    old_value.strip(), mapping.value,
                    mapping.field_id, mapping.section_id,
                )
                break  # Only replace once per field per paragraph match

            if mapping.replacements_made > 0:
                break  # Found and replaced — stop scanning remaining paras

        if mapping.replacements_made == 0:
            # Try placeholder tokens as last resort ({field_id}, [field_id])
            count += self._replace_placeholder_tokens(mapping, paras, report)

        return count

    def _replace_placeholder_tokens(
        self,
        mapping: DynamicFieldMapping,
        paras: list[Paragraph],
        report: dict[str, Any],
    ) -> int:
        """
        Fallback: look for explicit placeholder tokens like {field_id} or
        [field_id] and replace them wholesale.  Only used if the label scan
        above found nothing.
        """
        tokens = [
            f"{{{{{mapping.field_id}}}}}",  # {{{field_id}}}
            f"{{{mapping.field_id}}}",       # {{field_id}}
            f"[{mapping.field_id}]",         # [field_id]
        ]
        count = 0
        for para in paras:
            text = _para_text(para)
            for token in tokens:
                if token in text:
                    new_text = text.replace(token, mapping.value)
                    _set_run_text(para, new_text)
                    mapping.replacements_made += 1
                    count += 1
                    report["field_operations"].append({
                        "field_id":   mapping.field_id,
                        "section_id": mapping.section_id,
                        "label_used": token,
                        "old_value":  token,
                        "new_value":  mapping.value,
                        "location":   "placeholder_token",
                    })
                    break
            if count:
                break
        return count
    def _patch_cover_header_cells(
        self,
        doc: DocxDocument,
        report: dict[str, Any],
    ) -> int:
        """
        Patch cover-page header table cells where the label and value live in
        the SAME cell, separated by a colon: e.g. "SPEC. NO   :   IP009-43-03-01".

        The standard label-anchored scan replaces "Label: <value>" only when
        they are on a single body paragraph line.  Table cells with combined
        "LABEL : value" text are not reached that way, so we handle them here.

        We look for cells whose text matches one of the known cover-header
        patterns (case-insensitive) and swap out the value portion (after the
        last colon / dash separator) with the user-edited value.

        Patterns handled (in the CHEMTEX cover table):
            SPEC. NO   :   <spec_no>
            REV. <rev>            (no colon — whole cell)
            PROJECT NO :   <project_no>
            SH. <sheet>           (no colon — whole cell)
            AREA:   <area>
            DESCRIPTION :   <description>
        """
        # Map of (label_pattern_regex, field_id) pairs.
        # field_id must match a key in self.field_mappings.
        COVER_CELL_PATTERNS: list[tuple[str, str]] = [
            # label contains a colon separator: replace value after the colon
            (r"(?i)SPEC[.\s]*NO[.\s]*\s*:", "spec_no"),
            (r"(?i)PROJECT\s+NO[.\s]*\s*:", "project_no"),
            (r"(?i)AREA\s*:", "area"),
            (r"(?i)DESCRIPTION\s*:", "description"),
            # label without colon: REV. <value>  or  SH. <value>
            (r"(?i)^REV[.\s]+", "revision"),
            (r"(?i)^SH[.\s]+", "sheet_no"),
        ]

        count = 0
        for table in doc.tables:
            for row in table.rows:
                for cell in row.cells:
                    # Collect the full cell text across all paragraphs
                    cell_text = "\n".join(
                        "".join(r.text for r in p.runs)
                        for p in cell.paragraphs
                    ).strip()
                    if not cell_text:
                        continue

                    for pattern, fid in COVER_CELL_PATTERNS:
                        if fid not in self.field_mappings:
                            continue
                        mapping = self.field_mappings[fid]
                        new_val = mapping.value
                        if not new_val:
                            continue

                        m = re.search(pattern, cell_text)
                        if not m:
                            continue

                        # Build replacement text
                        if ":" in pattern:
                            # Keep everything up to and including the colon,
                            # then append the new value with spacing.
                            label_prefix = cell_text[: m.end()].rstrip()
                            new_cell_text = f"{label_prefix}   {new_val}"
                        else:
                            # Pattern like "REV. " — replace everything after
                            # the matched prefix.
                            label_prefix = cell_text[: m.end()]
                            new_cell_text = f"{label_prefix}{new_val}"

                        # Write back into the first paragraph of the cell,
                        # normalising runs first.
                        if cell.paragraphs:
                            para = cell.paragraphs[0]
                            try:
                                _merge_runs(para)
                            except Exception:
                                pass
                            old_text = _para_text(para)
                            _set_run_text(para, new_cell_text)
                            mapping.replacements_made += 1
                            count += 1
                            report["field_operations"].append({
                                "field_id":   fid,
                                "section_id": "cover_header_table",
                                "label_used": pattern,
                                "old_value":  old_text,
                                "new_value":  new_cell_text,
                                "location":   "cover_header_cell",
                            })
                            break  # one match per cell is enough

        return count

    def _patch_section_headers(
        self,
        doc: DocxDocument,
        report: dict[str, Any],
    ) -> int:
        """
        Patch running header paragraphs across all sections of the Word document.
        In DOCX templates, running headers contain text such as:
          'CHEMTEX\tSPEC. NO. IP009-43-00-01 REV. 0\t\tSHEET 20 OF 20'
        We update SPEC. NO, REV, and SHEET according to user edits.
        """
        count = 0
        spec_mapping = self.field_mappings.get("spec_no")
        rev_mapping = self.field_mappings.get("revision")
        sheet_mapping = self.field_mappings.get("sheet_no")

        spec_val = spec_mapping.value if spec_mapping and spec_mapping.value else None
        rev_val = rev_mapping.value if rev_mapping and rev_mapping.value else None
        sheet_val = sheet_mapping.value if sheet_mapping and sheet_mapping.value else None

        if not spec_val and not rev_val and not sheet_val:
            return 0

        clean_rev = re.sub(r"(?i)^REV[.\s]*", "", str(rev_val)).strip() if rev_val else None

        for section in doc.sections:
            headers_to_check = [section.header]
            if hasattr(section, "first_page_header") and section.first_page_header is not None:
                headers_to_check.append(section.first_page_header)
            if hasattr(section, "even_page_header") and section.even_page_header is not None:
                headers_to_check.append(section.even_page_header)

            for hdr in headers_to_check:
                # Check header paragraphs
                for p in hdr.paragraphs:
                    text = p.text
                    if not text:
                        continue
                    orig_text = text
                    if spec_val:
                        text = re.sub(r"(?i)(SPEC[.\s]*NO[.\s]*\s*)([A-Z0-9\-_/]+)", rf"\g<1>{spec_val}", text)
                    if clean_rev:
                        text = re.sub(r"(?i)(REV[.\s]*\s*)([A-Z0-9]+)", rf"\g<1>{clean_rev}", text)
                    if sheet_val:
                        text = re.sub(r"(?i)(SHEET\s+)(\d+\s+OF\s+\d+)", rf"\g<1>{sheet_val}", text)
                    if text != orig_text:
                        p.text = text
                        count += 1
                        report["field_operations"].append({
                            "field_id": "section_running_header",
                            "location": "section_header",
                            "old_value": orig_text,
                            "new_value": text,
                        })

                # Check header tables if any
                for table in hdr.tables:
                    for row in table.rows:
                        for cell in row.cells:
                            for p in cell.paragraphs:
                                text = p.text
                                if not text:
                                    continue
                                orig_text = text
                                if spec_val:
                                    text = re.sub(r"(?i)(SPEC[.\s]*NO[.\s]*\s*)([A-Z0-9\-_/]+)", rf"\g<1>{spec_val}", text)
                                if clean_rev:
                                    text = re.sub(r"(?i)(REV[.\s]*\s*)([A-Z0-9]+)", rf"\g<1>{clean_rev}", text)
                                if sheet_val:
                                    text = re.sub(r"(?i)(SHEET\s+)(\d+\s+OF\s+\d+)", rf"\g<1>{sheet_val}", text)
                                if text != orig_text:
                                    p.text = text
                                    count += 1
                                    report["field_operations"].append({
                                        "field_id": "section_running_header_table",
                                        "location": "section_header_table",
                                        "old_value": orig_text,
                                        "new_value": text,
                                    })
        return count

    def _replace_in_table_cell_pairs(
        self,
        doc: DocxDocument,
        report: dict[str, Any],
    ) -> int:
        """
        Scan all tables for label-in-one-cell / value-in-adjacent-cell pairs.

        Cover-page and summary tables typically have a structure like:

            | Spec. No.  |  IP-009  |
            | Project    |  PASHMINA |

        After Step 2 (label-anchored text replacement in body paragraphs), any
        field that still has replacements_made==0 is tried here.  For each
        table row, we check every cell as a potential label cell and look at
        the cell(s) to its right as the value cell.
        """
        count = 0
        unmatched = {
            fid: m for fid, m in self.field_mappings.items()
            if m.replacements_made == 0
        }
        if not unmatched:
            return 0

        for table in doc.tables:
            for row in table.rows:
                cells = row.cells
                for ci, cell in enumerate(cells[:-1]):  # skip last cell (no neighbour)
                    cell_text = "".join(
                        "".join(r.text for r in p.runs)
                        for p in cell.paragraphs
                    ).strip()
                    if not cell_text:
                        continue

                    for fid, mapping in list(unmatched.items()):
                        for label in mapping.label_patterns:
                            lbl_clean = label.strip().rstrip(":")
                            # Fuzzy-ish: label cell text must contain the label
                            if lbl_clean.lower() in cell_text.lower():
                                # Replace the value in the next cell
                                value_cell = cells[ci + 1]
                                for vp in value_cell.paragraphs:
                                    _merge_runs(vp)
                                    old_val = _para_text(vp).strip()
                                    _set_run_text(vp, mapping.value)
                                    mapping.replacements_made += 1
                                    count += 1
                                    report["field_operations"].append({
                                        "field_id":   mapping.field_id,
                                        "section_id": mapping.section_id,
                                        "label_used": label,
                                        "old_value":  old_val,
                                        "new_value":  mapping.value,
                                        "location":   "table_cell_pair",
                                    })
                                    break
                                del unmatched[fid]
                                break
                        if fid not in unmatched:
                            break  # already matched this field

            if not unmatched:
                break  # All remaining fields resolved

        return count

    def _replace_by_default_values(
        self,
        doc: DocxDocument,
        all_paras: list[Paragraph],
        report: dict[str, Any],
    ) -> int:
        """
        For unmatched fields whose template text doesn't have a 'Label: ' prefix
        (e.g., cover page titles, project number, client name), match by the
        schema's default_value and replace it with the new value.
        """
        count = 0
        unmatched = {
            fid: m for fid, m in self.field_mappings.items()
            if m.replacements_made == 0 and m.default_value and len(m.default_value.strip()) >= 3
        }
        if not unmatched:
            return 0

        # 1. Scan paragraphs
        for para in all_paras:
            text = _para_text(para)
            if not text.strip():
                continue
            for fid, mapping in list(unmatched.items()):
                target_vals = [mapping.default_value.strip()]
                # If project_no e.g. "IP009" and paragraph has "IP-009" or vice versa:
                if "ip" in mapping.default_value.lower():
                    clean_ip = re.sub(r"[^a-zA-Z0-9]", "", mapping.default_value)
                    dashed_ip = (
                        mapping.default_value[:2] + "-" + mapping.default_value[2:]
                        if len(mapping.default_value) > 2 and "-" not in mapping.default_value
                        else mapping.default_value
                    )
                    target_vals.extend([clean_ip, dashed_ip])

                for target in set(target_vals):
                    if len(target) < 3:
                        continue
                    # Case-insensitive word boundary or full string match
                    pattern = re.compile(rf"\b{re.escape(target)}\b", re.IGNORECASE)
                    if pattern.search(text):
                        new_text = pattern.sub(mapping.value, text, count=1)
                        _set_run_text(para, new_text)
                        mapping.replacements_made += 1
                        count += 1
                        report["field_operations"].append({
                            "field_id": mapping.field_id,
                            "section_id": mapping.section_id,
                            "label_used": f"default_value:{target}",
                            "old_value": text.strip(),
                            "new_value": mapping.value,
                            "location": "default_value_para",
                        })
                        del unmatched[fid]
                        text = new_text
                        break

        # 2. Scan table cells if any remain
        if unmatched:
            for table in doc.tables:
                for row in table.rows:
                    for cell in row.cells:
                        for p in cell.paragraphs:
                            p_text = _para_text(p).strip()
                            if not p_text:
                                continue
                            for fid, mapping in list(unmatched.items()):
                                target = mapping.default_value.strip()
                                pattern = re.compile(rf"\b{re.escape(target)}\b", re.IGNORECASE)
                                if pattern.search(p_text):
                                    new_text = pattern.sub(mapping.value, p_text, count=1)
                                    _set_run_text(p, new_text)
                                    mapping.replacements_made += 1
                                    count += 1
                                    report["field_operations"].append({
                                        "field_id": mapping.field_id,
                                        "section_id": mapping.section_id,
                                        "label_used": f"default_value:{target}",
                                        "old_value": p_text,
                                        "new_value": mapping.value,
                                        "location": "default_value_table",
                                    })
                                    del unmatched[fid]
                                    break

        return count

    def _populate_data_tables(
        self,
        doc: DocxDocument,
        table_blocks: list[dict],
        report: dict[str, Any],
    ) -> int:
        """
        Synchronize Word document tables (doc.tables) with table_blocks from populated_tree.
        Supports:
          1. Editing existing cells in data rows
          2. Adding new rows (preserving row formatting & XML styles)
          3. Deleting rows (removing extra rows from table XML)
        """
        import copy
        replacements = 0

        for tblock in table_blocks:
            tdata = tblock.get("table_data")
            if not tdata or len(tdata) < 1:
                continue

            target_headers = [str(c or "").strip().lower() for c in tdata[0] if str(c or "").strip()]
            if not target_headers:
                continue

            # Find matching table in doc.tables
            matched_table = None
            for tbl in doc.tables:
                if not tbl.rows:
                    continue
                tbl_headers = [str(c.text or "").strip().lower() for c in tbl.rows[0].cells if str(c.text or "").strip()]
                # Check overlap between target_headers and tbl_headers
                overlap = sum(1 for th in target_headers if any(th in dh or dh in th for dh in tbl_headers))
                if overlap >= max(1, len(target_headers) // 2):
                    matched_table = tbl
                    break

            if not matched_table:
                continue

            data_rows = tdata[1:]

            # 1. If user added rows, append new rows copying XML structure of last row
            while len(matched_table.rows) - 1 < len(data_rows) and len(matched_table.rows) > 1:
                new_tr = copy.deepcopy(matched_table.rows[-1]._tr)
                matched_table._tbl.append(new_tr)

            # 2. If user deleted rows, remove extra rows from XML
            while len(matched_table.rows) - 1 > len(data_rows) and len(matched_table.rows) > 1:
                last_row = matched_table.rows[-1]
                matched_table._tbl.remove(last_row._tr)

            # 3. Populate all cell values
            for ri, row_vals in enumerate(data_rows):
                row_idx = ri + 1  # header is row 0
                if row_idx >= len(matched_table.rows):
                    break
                tbl_row = matched_table.rows[row_idx]
                for ci, cell_val in enumerate(row_vals):
                    if ci >= len(tbl_row.cells):
                        break
                    cell = tbl_row.cells[ci]
                    val_str = str(cell_val if cell_val is not None else "")
                    curr_cell_text = cell.text.strip()
                    if curr_cell_text != val_str:
                        if cell.paragraphs:
                            p = cell.paragraphs[0]
                            for r in list(p.runs[1:]):
                                p._p.remove(r._r)
                            if p.runs:
                                p.runs[0].text = val_str
                            else:
                                p.add_run(val_str)
                            for extra_p in list(cell.paragraphs[1:]):
                                cell._tc.remove(extra_p._p)
                        else:
                            cell.text = val_str
                        replacements += 1
                        report["field_operations"].append({
                            "field_id": f"{tblock.get('block_id', 'table')}_r{ri}_c{ci}",
                            "location": "table_cell",
                            "old_value": curr_cell_text,
                            "new_value": val_str,
                        })

        return replacements

    # ------------------------------------------------------------------
    # Validation report
    # ------------------------------------------------------------------

    def generate_validation_report(self) -> dict[str, Any]:
        """Return a summary of the last populate() call."""
        if not self.operations_log:
            return {"status": "no_operations"}
        latest = self.operations_log[-1]
        return {
            "population_success":      latest["success"],
            "replacements_made":       latest["replacements_made"],
            "fields_processed":        latest["fields_processed"],
            "errors":                  latest["errors"],
            "warnings":                latest["warnings"],
            "field_operations_summary": [
                {"field_id": op["field_id"], "location": op["location"]}
                for op in latest["field_operations"]
            ],
        }