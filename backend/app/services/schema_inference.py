"""Draft schema inference for uploaded specification templates.

This produces a *starting point* schema (sections/fields) from the text of
an uploaded .doc/.docx so a human can validate and edit it in the
Pending Templates preview screen before it's approved as a master
template. It's deliberately conservative and rule-based (no model call) -
it must never be trusted as the final schema, only a time-saving draft.
"""
import html
import logging
import re
import shutil
import subprocess
import tempfile
import uuid
from pathlib import Path
from typing import Any, Callable

logger = logging.getLogger(__name__)

# --- DEPLOYMENT CANARY -------------------------------------------------
print("[schema_inference] loaded: page-image + spacing fix build 2026-08-14-v3", flush=True)
# -------------------------------------------------------------------------

from app.core.config import settings

import docx  # type: ignore[import-not-found]
from docx.document import Document as DocxDocumentType  # type: ignore[import-not-found]
from docx.enum.text import WD_ALIGN_PARAGRAPH  # type: ignore[import-not-found]
from docx.oxml.ns import qn  # type: ignore[import-not-found]
from docx.table import Table, _Cell  # type: ignore[import-not-found]
from docx.text.paragraph import Paragraph  # type: ignore[import-not-found]

try:
    import fitz  # type: ignore[import-not-found]
except ImportError:
    fitz = None

_LABEL_LINE_RE = re.compile(
    r"^(?:(?P<prefix>[a-zA-Z]{1,3}[\.)]|[-*•])\s+)?(?P<label>[A-Za-z][A-Za-z0-9/&().' ][A-Za-z0-9/&().' -]{0,59})\s*(?P<sep>:|\s+-\s+)\s*(?P<value>.*)$"
)
_BLANK_LINE_RE = re.compile(
    r"^(?:(?P<prefix>[a-zA-Z]{1,3}[\.)]|[-*•])\s+)?(?P<label>[A-Za-z][A-Za-z0-9/&().' ][A-Za-z0-9/&().' -]{0,59})\s*_{3,}\s*$"
)
_LABEL_ONLY_RE = re.compile(
    r"^(?:(?P<prefix>[a-zA-Z]{1,3}[\.)]|[-*•])\s+)?(?P<label>[A-Za-z][A-Za-z0-9/&().' ][A-Za-z0-9/&().' -]{0,59})\s*$"
)

_STOPWORD_LABELS = {"note", "notes", "warning", "caution", "page", "section"}

_LIST_MARKER_RE = re.compile(r"^(?:[a-zA-Z]|[ivxlcdm]+|[0-9]+)[\.\)]?$")


def _normalize_label(label: str) -> str:
    cleaned = (label or "").strip()
    if not cleaned:
        return ""
    cleaned = re.sub(r"^[-*•]\s+", "", cleaned)
    cleaned = re.sub(r"^(?:[a-zA-Z]{1,3}[\.)])\s+", "", cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return cleaned.rstrip(":").strip()


def _looks_like_real_label(label: str) -> bool:
    stripped = _normalize_label(label)
    if not stripped:
        return False
    if _LIST_MARKER_RE.match(stripped):
        return False
    return True


def _iter_block_items(doc: DocxDocumentType):
    body = doc.element.body
    for child in body.iterchildren():
        if child.tag == qn("w:p"):
            yield Paragraph(child, doc)
        elif child.tag == qn("w:tbl"):
            yield Table(child, doc)


def _slugify(text: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "_", text.strip().lower()).strip("_")
    return slug or "field"


def _resolve_soffice_executable() -> str | None:
    configured = getattr(settings, "LIBREOFFICE_PATH", None)
    if configured:
        configured_path = Path(configured).expanduser()
        if configured_path.exists():
            return str(configured_path)
        resolved = shutil.which(str(configured_path))
        if resolved:
            return resolved
        logger.warning("Configured LibreOffice path does not exist: %s", configured)

    resolved = shutil.which("soffice.exe") or shutil.which("soffice") or shutil.which("soffice.com")
    if resolved:
        return resolved
    return None


def _run_soffice(args: list[str], timeout: int = 120) -> None:
    soffice_executable = _resolve_soffice_executable()
    if not soffice_executable:
        raise FileNotFoundError("LibreOffice executable not found. Set LIBREOFFICE_PATH in the environment.")

    with tempfile.TemporaryDirectory(prefix="lo_profile_") as profile_dir:
        command = [
            soffice_executable,
            "--headless",
            "--norestore",
            f"-env:UserInstallation=file://{profile_dir}",
            *args,
        ]
        try:
            result = subprocess.run(
                command,
                check=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=timeout,
            )
        except subprocess.CalledProcessError as exc:
            print(
                f"[schema_inference] soffice conversion failed (exit {exc.returncode}): "
                f"{(exc.stderr or b'').decode(errors='replace')[:2000]}",
                flush=True,
            )
            logger.warning(
                "soffice conversion failed (exit %s): %s",
                exc.returncode,
                (exc.stderr or b"").decode(errors="replace")[:2000],
            )
            raise
        except subprocess.TimeoutExpired:
            print(f"[schema_inference] soffice conversion timed out after {timeout}s: {command}", flush=True)
            logger.warning("soffice conversion timed out after %ss: %s", timeout, command)
            raise
        else:
            if result.stderr:
                logger.debug("soffice stderr: %s", result.stderr.decode(errors="replace")[:2000])


def _convert_doc_to_docx(path: Path) -> Path:
    if _resolve_soffice_executable() is not None:
        output_dir = path.parent
        _run_soffice(["--convert-to", "docx", "--outdir", str(output_dir), str(path)])
        return output_dir / (path.stem + ".docx")

    if shutil.which("winword") is not None or Path("C:/Program Files/Microsoft Office/root/Office16/WINWORD.EXE").exists():
        try:
            import pythoncom  # type: ignore[import-not-found]
            import win32com.client  # type: ignore[import-not-found]
        except ImportError as exc:
            raise FileNotFoundError(
                "Neither LibreOffice nor Word automation is available for .doc conversion. "
                "Please convert the file to .docx before uploading."
            ) from exc

        output_dir = path.parent
        output_path = output_dir / (path.stem + ".docx")
        pythoncom.CoInitialize()
        word = None
        try:
            word = win32com.client.Dispatch("Word.Application")
            word.Visible = False
            doc = word.Documents.Open(str(path), ReadOnly=True)
            doc.SaveAs2(str(output_path), FileFormat=16)
            doc.Close(SaveChanges=False)
        finally:
            if word is not None:
                try:
                    word.Quit()
                except Exception:
                    pass
            try:
                pythoncom.CoUninitialize()
            except Exception:
                pass
        return output_path

    raise FileNotFoundError(
        "Neither LibreOffice 'soffice' nor Microsoft Word is available to convert .doc templates to .docx. "
        "Please convert the file to .docx before uploading."
    )


def _docx_to_pdf(docx_path: Path) -> Path:
    from app.services import gotenberg_client

    if gotenberg_client.is_configured():
        try:
            return gotenberg_client.convert_docx_to_pdf(docx_path, docx_path.parent)
        except Exception:
            pass

    if _resolve_soffice_executable() is not None:
        output_dir = docx_path.parent
        _run_soffice(["--convert-to", "pdf", "--outdir", str(output_dir), str(docx_path)])
        return output_dir / (docx_path.stem + ".pdf")

    if shutil.which("winword") is not None or Path("C:/Program Files/Microsoft Office/root/Office16/WINWORD.EXE").exists():
        try:
            import pythoncom  # type: ignore[import-not-found]
            import win32com.client  # type: ignore[import-not-found]
        except ImportError as exc:
            raise FileNotFoundError("Word automation not available") from exc

        output_dir = docx_path.parent
        output_path = output_dir / (docx_path.stem + ".pdf")
        pythoncom.CoInitialize()
        word = None
        try:
            word = win32com.client.Dispatch("Word.Application")
            word.Visible = False
            doc = word.Documents.Open(str(docx_path), ReadOnly=True)
            doc.SaveAs2(str(output_path), FileFormat=17)
            doc.Close(SaveChanges=False)
        finally:
            if word is not None:
                try:
                    word.Quit()
                except Exception:
                    pass
            try:
                pythoncom.CoUninitialize()
            except Exception:
                pass
        return output_path

    raise FileNotFoundError("Neither LibreOffice nor Word available for PDF conversion")


def _pdf_to_page_images(pdf_path: Path, output_dir: Path, dpi: int = 150) -> list[str]:
    if not fitz:
        print("[schema_inference] PyMuPDF (fitz) is not importable - cannot render page images", flush=True)
        return []

    try:
        pdf_doc = fitz.open(str(pdf_path))
        image_paths = []

        for page_num in range(len(pdf_doc)):
            try:
                page = pdf_doc[page_num]
                mat = fitz.Matrix(dpi / 72, dpi / 72)
                pix = page.get_pixmap(matrix=mat,colorspace=fitz.csRGB, alpha=False)

                image_path = output_dir / f"page_{page_num + 1}.png"
                pix.save(str(image_path))
                image_paths.append(str(image_path.resolve()))
            except Exception as exc:
                print(f"[schema_inference] failed to render page {page_num + 1} of {pdf_path}: {exc!r}", flush=True)
                continue

        pdf_doc.close()
        return image_paths
    except Exception as exc:
        print(f"[schema_inference] failed to open PDF {pdf_path} for rendering: {exc!r}", flush=True)
        return []


def _pdf_page_texts(pdf_path: Path) -> list[str]:
    if fitz is None:
        return []

    try:
        pdf_doc = fitz.open(str(pdf_path))
        texts: list[str] = []
        try:
            for page in pdf_doc:
                raw_text = page.get_text("text")
                texts.append(str(raw_text) if raw_text else "")
        finally:
            pdf_doc.close()
        return texts
    except Exception as exc:
        print(
            f"[schema_inference] failed to extract page texts from "
            f"{pdf_path}: {exc!r}",
            flush=True,
        )
        return []
        
_WHITESPACE_RE = re.compile(r"\s+")


def _normalize_for_match(text: str) -> str:
    return _WHITESPACE_RE.sub(" ", text).strip().lower()


def extract_deterministic_page_data(page_text: str) -> dict[str, Any]:
    cleaned = (page_text or "").replace("\r\n", "\n").replace("\r", "\n")
    lines = [line.strip() for line in cleaned.split("\n") if line.strip()]

    field_labels: list[str] = []
    for line in lines:
        candidate = _candidate_field_from_line(line)
        if candidate:
            field_labels.append(candidate["label"])

    table_rows: list[list[str]] = []
    for line in lines:
        if "|" in line or "\t" in line:
            row = [part.strip() for part in re.split(r"\s*\|\s*|\t+", line) if part.strip()]
            if len(row) >= 2:
                table_rows.append(row)

    normalized_text = "\n".join(lines)
    total_words = sum(len(re.findall(r"[A-Za-z0-9]+", line)) for line in lines)
    layout_score = 0.0
    if lines:
        score = 0.4
        score += min(0.3, len(field_labels) / max(1, len(lines)) * 1.0)
        score += min(0.2, len(table_rows) * 0.1)
        score += min(0.1, total_words / max(1, len(lines)) * 0.02)
        layout_score = min(1.0, max(0.0, score))

    return {
        "normalized_text": normalized_text,
        "field_labels": field_labels,
        "table_count": len(table_rows),
        "table_rows": table_rows,
        "layout_score": round(layout_score, 3),
        "line_count": len(lines),
    }


def compare_page_to_source(source_text: str, extracted_text: str) -> dict[str, Any]:
    source_clean = (source_text or "").replace("\r\n", "\n").replace("\r", "\n")
    extracted_clean = (extracted_text or "").replace("\r\n", "\n").replace("\r", "\n")

    source_tokens = set(re.findall(r"[A-Za-z0-9][A-Za-z0-9/.-]*", _normalize_for_match(source_clean)))
    extracted_tokens = set(re.findall(r"[A-Za-z0-9][A-Za-z0-9/.-]*", _normalize_for_match(extracted_clean)))

    coverage_ratio = 1.0 if not source_tokens else len(source_tokens & extracted_tokens) / len(source_tokens)
    source_rows = []
    extracted_rows = []
    for chunk in source_clean.split("\n"):
        row = [part.strip() for part in re.split(r"\s*\|\s*|\t+", chunk) if part.strip()]
        if len(row) >= 2:
            source_rows.append(" | ".join(row))
    for chunk in extracted_clean.split("\n"):
        row = [part.strip() for part in re.split(r"\s*\|\s*|\t+", chunk) if part.strip()]
        if len(row) >= 2:
            extracted_rows.append(" | ".join(row))

    table_match_ratio = 0.0
    if source_rows or extracted_rows:
        source_set = set(source_rows)
        extracted_set = set(extracted_rows)
        if source_set or extracted_set:
            table_match_ratio = len(source_set & extracted_set) / max(1, len(source_set | extracted_set))

    page_coverage = {
        "covered_tokens": len(source_tokens & extracted_tokens),
        "total_tokens": len(source_tokens),
        "coverage_ratio": round(float(coverage_ratio), 3),
    }

    return {
        "coverage_ratio": round(float(coverage_ratio), 3),
        "table_match_ratio": round(float(table_match_ratio), 3),
        "page_coverage": page_coverage,
        "source_table_rows": source_rows,
        "extracted_table_rows": extracted_rows,
    }


class _PageLocator:
    def __init__(self, page_texts: list[str]):
        self._normalized_pages = [_normalize_for_match(t) for t in page_texts]
        self._cursor = 0

    def locate(self, needle: str, fallback_page: int) -> int:
        if not self._normalized_pages:
            return fallback_page
        key = _normalize_for_match(needle)
        if not key:
            return max(1, min(fallback_page, len(self._normalized_pages)))
        for offset in range(self._cursor, len(self._normalized_pages)):
            if key in self._normalized_pages[offset]:
                self._cursor = offset
                return offset + 1
        return max(1, min(self._cursor + 1, len(self._normalized_pages)))


def _docx_to_page_images(docx_path: Path, output_dir: Path) -> list[str]:
    print(f"[schema_inference] _docx_to_page_images starting for {docx_path}", flush=True)
    try:
        pdf_path = _docx_to_pdf(docx_path)
    except Exception as exc:
        print(f"[schema_inference] failed to convert {docx_path} to PDF: {exc!r}", flush=True)
        logger.exception("Failed to convert %s to PDF for page-image rendering", docx_path)
        return []

    try:
        image_paths = _pdf_to_page_images(pdf_path, output_dir)
    finally:
        try:
            pdf_path.unlink()
        except Exception:
            pass
    if not image_paths:
        print(f"[schema_inference] PDF-to-image rendering produced 0 pages for {docx_path}", flush=True)
        logger.warning("PDF-to-image rendering produced 0 pages for %s", docx_path)
    else:
        print(f"[schema_inference] rendered {len(image_paths)} page images for {docx_path}", flush=True)
    return image_paths


_NUMBERED_HEADING_RE = re.compile(
    r"^(?P<number>\d{1,2}(?:\.\d{1,2}){0,2})\.?\s+(?P<title>[A-Za-z][A-Za-z0-9 &/\-,\.\(\)]{1,80})$"
)


def _numbered_heading_match(text: str) -> re.Match | None:
    text = text.strip()
    if not text or len(text) > 100:
        return None
    return _NUMBERED_HEADING_RE.match(text)


def _looks_like_heading(paragraph) -> bool:
    style_name = (paragraph.style.name if paragraph.style else "") or ""
    if style_name.lower().startswith("heading") or style_name.lower() == "title":
        return True
    text = paragraph.text.strip()
    if _numbered_heading_match(text):
        return True
    return bool(text) and len(text) <= 60 and text.upper() == text and not text.endswith((".", ":"))


def _table_heading_text(table) -> str | None:
    try:
        rows = table.rows
        if len(rows) != 1 or len(rows[0].cells) < 1:
            return None
        unique_cells = {id(c._tc): c for c in rows[0].cells}
        if len(unique_cells) != 1:
            return None
        cell = next(iter(unique_cells.values()))
        text = _extract_cell_text(cell).strip()
        return text if _numbered_heading_match(text) else None
    except (IndexError, AttributeError, TypeError):
        return None


def _candidate_field_match(line: str) -> re.Match | None:
    line_stripped = line.strip()
    if not line_stripped or len(line_stripped) > 120:
        return None
    try:
        candidates = [
            _LABEL_LINE_RE.match(line_stripped),
            _BLANK_LINE_RE.match(line_stripped),
            _LABEL_ONLY_RE.match(line_stripped),
        ]
        match = next((candidate for candidate in candidates if candidate is not None), None)
        if not match:
            return None
        label = match.group("label")
        if not label:
            return None
        label = label.strip()
        if not label or label.lower() in _STOPWORD_LABELS:
            return None
        if label.startswith("-"):
            label = label.lstrip("-").strip()
        label_words = label.split()
        if len(label_words) > 8:
            return None
        value = (match.groupdict().get("value") or "").strip()
        if not _looks_like_real_label(label):
            return None
        if value:
            return match
        return match
    except (IndexError, AttributeError):
        return None


def _candidate_field_from_line(line: str) -> dict[str, str] | None:
    match = _candidate_field_match(line)
    if not match:
        return None
    label = match.group("label").strip()
    value = (match.groupdict().get("value") or "").strip()
    return {"label": label, "value": value} if value else {"label": label}


def _value_start_offset(raw_text: str, match: re.Match) -> int:
    lead_ws = len(raw_text) - len(raw_text.lstrip())
    groups = match.groupdict()
    if "value" in groups and groups.get("value") is not None:
        return lead_ws + match.start("value")
    return lead_ws + match.end("label")


def _dedupe_merged_cells(cells: list[str]) -> list[str]:
    deduped: list[str] = []
    for cell in cells:
        if deduped and deduped[-1] == cell:
            continue
        deduped.append(cell)
    return deduped


# ---------------------------------------------------------------------
# Defensive cell access
# ---------------------------------------------------------------------
#
# python-docx's `row.cells` property maps cells to grid-column positions
# using the table's declared `tblGrid`. When a table's gridSpan/vMerge
# bookkeeping doesn't line up cleanly with that declared grid - common in
# older Word docs, docs converted from PDF, or tables assembled by
# copy-pasting from another file - that internal mapping does a list
# index lookup that goes out of range and raises a bare
# `IndexError: list index out of range` with no identifying detail.
#
# `_render_table` (the main structure-aware renderer) already avoids this
# by walking `tbl.tr_lst` / `tc.tcPr` directly instead of using
# `row.cells`. `_safe_row_cells` gives every other call site in this
# module the same immunity: try the fast/normal path first, and only fall
# back to a raw-XML walk (which cannot raise this particular error) if the
# fast path fails. This means a single malformed table degrades to "read
# it as literally as possible" instead of aborting the parse of the whole
# document - which is what previously made an upload with a merged-cell
# title block get rejected outright with an unhelpful error message.
def _safe_row_cells(row) -> list:
    """Return this row's cells, tolerating malformed grid/merge bookkeeping.

    Returns the same list-of-_Cell shape as `row.cells` on the normal
    path. On any IndexError from that lookup, falls back to reading the
    row's `<w:tc>` elements directly (same approach `_render_table` uses),
    so callers never see the exception - worst case they get however many
    cells could actually be read off the row.
    """
    try:
        return list(row.cells)
    except IndexError:
        logger.warning(
            "row.cells raised IndexError on a malformed table row (grid/merge "
            "mismatch); falling back to raw tc_lst walk",
            exc_info=True,
        )
    except Exception:
        logger.warning("unexpected error reading row.cells; falling back to raw tc_lst walk", exc_info=True)

    cells: list = []
    try:
        for tc in row._tr.tc_lst:
            try:
                cells.append(_Cell(tc, row.table))
            except Exception:
                continue
    except Exception:
        logger.warning("raw tc_lst fallback also failed for this row; returning no cells", exc_info=True)
        return []
    return cells


def _safe_table_rows(table) -> list:
    """Return this table's rows, or an empty list if even that fails.

    `table.rows` itself is normally safe, but a table object built from
    corrupted/unexpected XML can still misbehave here - guard it the same
    way as cell access so a single bad table can never abort the whole
    document parse.
    """
    try:
        return list(table.rows)
    except Exception:
        logger.warning("table.rows raised; treating table as having no rows", exc_info=True)
        return []


def _rows_from_tables_single(
    table,
    table_index: int = 0,
) -> list[dict[str, Any]]:
    """
    Extract every field from a table.

    Supports:

        Label | Value

        Label | Value | Label | Value

        Label | blank

        Label: Value
    """
    candidates: list[dict[str, Any]] = []

    for row_index, row in enumerate(_safe_table_rows(table)):
        try:
            cells = _extract_row_cells(row)
        except Exception:
            logger.exception(
                "Failed to extract table %s row %s",
                table_index + 1,
                row_index + 1,
            )
            continue

        if not any(cells):
            continue

        embedded_fields = []

        for cell_index, cell_text in enumerate(cells):
            embedded = _candidate_field_from_line(cell_text)

            if embedded:
                label = _normalize_label(embedded["label"])
                if not label:
                    continue
                embedded_fields.append(
                    {
                        "field_id": _make_table_field_id(
                            label,
                            table_index,
                            row_index,
                            cell_index,
                        ),
                        "label": label,
                        "value": embedded.get("value", ""),
                        "table_index": table_index,
                        "row_index": row_index,
                        "cell_index": cell_index,
                    }
                )

        if embedded_fields:
            candidates.extend(embedded_fields)
            continue

        for cell_index in range(0, len(cells) - 1, 2):
            raw_label = cells[cell_index].strip()
            label = _normalize_label(raw_label)
            value = cells[cell_index + 1].strip()

            if not label or not _is_table_label(label):
                continue

            candidates.append(
                {
                    "field_id": _make_table_field_id(
                        label,
                        table_index,
                        row_index,
                        cell_index,
                    ),
                    "label": label,
                    "value": value,
                    "table_index": table_index,
                    "row_index": row_index,
                    "cell_index": cell_index,
                }
            )

        if (
            len(cells) == 2
            and not candidates
        ):
            raw_label = cells[1].strip()
            label = _normalize_label(raw_label)
            if label and _is_table_label(label):
                candidates.append(
                    {
                        "field_id": _make_table_field_id(
                            label,
                            table_index,
                            row_index,
                            1,
                        ),
                        "label": label,
                        "value": cells[0],
                        "table_index": table_index,
                        "row_index": row_index,
                        "cell_index": 1,
                    }
                )

    return candidates


def _rows_from_tables(
    doc: DocxDocumentType,
) -> list[dict[str, Any]]:
    candidates: list[dict[str, Any]] = []

    for table_index, table in enumerate(doc.tables):
        try:
            table_candidates = _rows_from_tables_single(
                table=table,
                table_index=table_index,
            )
        except Exception:
            # One structurally broken table should never take down field
            # extraction for the rest of the document.
            logger.exception("Failed to extract fields from table %s; skipping it", table_index + 1)
            continue

        candidates.extend(table_candidates)

    return candidates


def _count_document_pages(doc: DocxDocumentType) -> int:
    page_breaks = 0
    try:
        for paragraph in doc.paragraphs:
            try:
                if not hasattr(paragraph, 'runs'):
                    continue
                for run in paragraph.runs:
                    try:
                        if not hasattr(run, '_element'):
                            continue
                        lastrendered = run._element.findall(".//w:lastRenderedPageBreak", namespaces={"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"})
                        if lastrendered:
                            page_breaks += 1
                        for br in run._element.findall(".//w:br", namespaces={"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}):
                            if br.get("{http://schemas.openxmlformats.org/wordprocessingml/2006/main}type") == "page":
                                page_breaks += 1
                    except (IndexError, AttributeError, TypeError):
                        continue
            except (IndexError, AttributeError, TypeError):
                continue
    except (IndexError, AttributeError, TypeError):
        pass
    return max(1, page_breaks + 1)


def _render_docx_preview_html(doc: DocxDocumentType) -> str:
    """Render full document as single HTML string, in true document order."""
    fragments: list[str] = []

    try:
        for block in _iter_block_items(doc):
            try:
                if isinstance(block, Table):
                    rows_html = []
                    if not _safe_table_rows(block):
                        continue
                    for row in _safe_table_rows(block):
                        try:
                            cells = _safe_row_cells(row)
                            if not cells:
                                continue
                            cell_htmls = [html.escape(_extract_cell_text(cell)) for cell in cells]
                            row_html = "".join(f"<td>{cell_html}</td>" for cell_html in cell_htmls)
                            rows_html.append(f"<tr>{row_html}</tr>")
                        except (IndexError, AttributeError, TypeError):
                            continue
                    if rows_html:
                        fragments.append(f"<table><tbody>{''.join(rows_html)}</tbody></table>")
                else:
                    text = block.text.strip()
                    if not text:
                        continue
                    if _looks_like_heading(block):
                        fragments.append(f"<h3>{html.escape(text)}</h3>")
                    else:
                        indent_style = _paragraph_indent_style(block)
                        fragments.append(
                            f"<p style=\"white-space:pre-wrap; {indent_style}\">"
                            f"{_escape_preserve_spacing(text)}</p>"
                        )
            except (IndexError, AttributeError, TypeError):
                continue
    except (IndexError, AttributeError, TypeError):
        pass

    return "".join(fragments)


def _render_document_sections(doc: DocxDocumentType) -> list[dict[str, Any]]:
    """Render document as separate scrollable sections with full formatting."""
    sections: list[dict[str, Any]] = []
    current_section: dict[str, Any] = {
        "section_id": "cover",
        "section_name": "Cover",
        "section_number": 0,
        "content_html": "",
        "paragraphs": [],
    }
    section_count = 0
    table_count = 0

    try:
        for block in _iter_block_items(doc):
            try:
                if isinstance(block, Table):
                    table_count += 1
                    heading_text = _table_heading_text(block)
                    if heading_text and current_section["paragraphs"]:
                        _finalize_section(current_section)
                        sections.append(current_section)
                        section_count += 1
                        current_section = {
                            "section_id": f"section_{section_count}",
                            "section_name": heading_text,
                            "section_number": section_count,
                            "content_html": "",
                            "paragraphs": [],
                        }
                    table_html = _render_table(block)
                    if table_html:
                        current_section["paragraphs"].append({
                            "text": heading_text or f"[Table {table_count}]",
                            "html": table_html,
                            "is_heading": bool(heading_text),
                        })
                    continue

                paragraph = block
                text = paragraph.text.strip()

                is_heading = _looks_like_heading(paragraph)

                if is_heading and current_section["paragraphs"]:
                    _finalize_section(current_section)
                    sections.append(current_section)
                    section_count += 1
                    current_section = {
                        "section_id": f"section_{section_count}",
                        "section_name": text or f"Section {section_count}",
                        "section_number": section_count,
                        "content_html": "",
                        "paragraphs": [],
                    }

                para_html = _render_paragraph(paragraph)
                if para_html:
                    current_section["paragraphs"].append({
                        "text": text,
                        "html": para_html,
                        "is_heading": is_heading,
                    })

            except (IndexError, AttributeError, TypeError):
                continue

        if current_section["paragraphs"]:
            _finalize_section(current_section)
            sections.append(current_section)

    except (IndexError, AttributeError, TypeError):
        pass

    if not sections:
        sections = [{
            "section_id": "cover",
            "section_name": "Document",
            "section_number": 0,
            "content_html": "<p>No content</p>",
            "paragraphs": [],
        }]

    return sections


def _paragraph_indent_style(paragraph) -> str:
    try:
        pf = paragraph.paragraph_format
        styles = []
        if pf.left_indent is not None:
            styles.append(f"margin-left:{pf.left_indent.pt}pt")
        if pf.first_line_indent is not None:
            styles.append(f"text-indent:{pf.first_line_indent.pt}pt")
        return "; ".join(styles)
    except (AttributeError, ValueError, TypeError):
        return ""


def _escape_preserve_spacing(text: str) -> str:
    return html.escape(text).replace("\t", "\u2003\u2003")


_FIELD_SPAN_STYLE = (
    "background:#fff8dc; outline:1px dashed #c99a1e; outline-offset:1px; "
    "padding:0 2px; border-radius:2px; cursor:text;"
)


def _tag_open(field_id: str) -> str:
    fid = html.escape(field_id, quote=True)
    return (
        f'<span class="tpl-field-group" data-field-id="{fid}">'
        f'<span class="tpl-field" data-field-id="{fid}" '
        f'contenteditable="true" style="{_FIELD_SPAN_STYLE}">'
    )


def _tag_close(field_id: str) -> str:
    fid = html.escape(field_id, quote=True)
    actions = (
        f'<span class="tpl-field-actions" contenteditable="false" data-field-id="{fid}">'
        f'<button type="button" class="tpl-act tpl-act-keep" data-action="keep" '
        f'data-field-id="{fid}" title="Keep this value">&#10003;</button>'
        f'<button type="button" class="tpl-act tpl-act-edit" data-action="edit" '
        f'data-field-id="{fid}" title="Edit this value">&#9998;</button>'
        f'<button type="button" class="tpl-act tpl-act-remove" data-action="remove" '
        f'data-field-id="{fid}" title="Remove this value">&#10005;</button>'
        f'</span>'
    )
    return "</span>" + actions + "</span>"


def _alignment_css(paragraph) -> str:
    try:
        mapping = {
            WD_ALIGN_PARAGRAPH.CENTER: "center",
            WD_ALIGN_PARAGRAPH.RIGHT: "right",
            WD_ALIGN_PARAGRAPH.JUSTIFY: "justify",
        }
        css = mapping.get(paragraph.alignment)
        return f"text-align:{css};" if css else ""
    except Exception:
        return ""


def _run_style_tags(run) -> tuple[str, str]:
    open_tag, close_tag = "", ""
    try:
        size_pt = run.font.size.pt if run.font and run.font.size else None
    except Exception:
        size_pt = None
    if size_pt:
        open_tag += f'<span style="font-size:{size_pt}pt;">'
        close_tag = "</span>" + close_tag
    if getattr(run, "underline", False):
        open_tag += "<u>"
        close_tag = "</u>" + close_tag
    if getattr(run, "italic", False):
        open_tag += "<em>"
        close_tag = "</em>" + close_tag
    if getattr(run, "bold", False):
        open_tag += "<strong>"
        close_tag = "</strong>" + close_tag
    return open_tag, close_tag


def _render_runs_html(paragraph, field_id: str | None = None, value_start: int | None = None) -> str:
    try:
        runs = list(paragraph.runs)
        if not runs:
            return ""
        should_tag = field_id is not None and value_start is not None
        tag_field_id = field_id
        tag_value_start = value_start
        parts: list[str] = []
        consumed = 0
        field_opened = not should_tag
        for run in runs:
            text = run.text
            if text == "":
                continue
            run_start = consumed
            run_end = consumed + len(text)
            consumed = run_end
            open_tag, close_tag = _run_style_tags(run)

            if should_tag and not field_opened and tag_field_id is not None and tag_value_start is not None:
                if run_end <= tag_value_start:
                    parts.append(open_tag + _escape_preserve_spacing(text) + close_tag)
                    continue
                if run_start < tag_value_start < run_end:
                    split_at = tag_value_start - run_start
                    before, after = text[:split_at], text[split_at:]
                    if before:
                        parts.append(open_tag + _escape_preserve_spacing(before) + close_tag)
                    parts.append(_tag_open(tag_field_id))
                    field_opened = True
                    parts.append(open_tag + _escape_preserve_spacing(after) + close_tag)
                    continue
                parts.append(_tag_open(tag_field_id))
                field_opened = True

            parts.append(open_tag + _escape_preserve_spacing(text) + close_tag)

        if should_tag and not field_opened and tag_field_id is not None:
            parts.append(_tag_open(tag_field_id) + "&nbsp;")
            field_opened = True
        if should_tag and field_opened and tag_field_id is not None:
            parts.append(_tag_close(tag_field_id))

        return "".join(parts)
    except Exception:
        logger.warning("run rendering failed for paragraph, falling back to plain text", exc_info=True)
        return ""


def _render_paragraph(paragraph, field_id: str | None = None, value_start: int | None = None) -> str:
    try:
        raw_text = paragraph.text
        text = raw_text.strip()
        if not text:
            return "<p style=\"margin:0; line-height:1.5; min-height:1em;\">&nbsp;</p>"

        indent_style = _paragraph_indent_style(paragraph)
        align_style = _alignment_css(paragraph)
        inner = _render_runs_html(paragraph, field_id=field_id, value_start=value_start)
        if not inner:
            inner = _escape_preserve_spacing(text)

        if _looks_like_heading(paragraph):
            return (
                f"<h2 style=\"margin-top:1em; margin-bottom:0.5em; font-weight:bold; "
                f"white-space:pre-wrap; {indent_style} {align_style}\">{inner}</h2>"
            )
        else:
            return (
                f"<p style=\"margin:0.5em 0; line-height:1.5; white-space:pre-wrap; "
                f"{indent_style} {align_style}\">{inner}</p>"
            )
    except (IndexError, AttributeError, TypeError):
        return ""


def _render_table_plain(table) -> str:
    """Simple text-only table renderer - kept as a fallback for when the
    structure-aware renderer below hits something unexpected, so one bad
    table degrades instead of blanking the page. Uses `_safe_row_cells`
    throughout so a malformed grid/merge never raises here either.
    """
    try:
        rows = _safe_table_rows(table)
        if not rows:
            return ""

        rows_html = []
        for row in rows:
            try:
                cells = _safe_row_cells(row)
                if not cells:
                    continue
                cell_tds = []
                for cell in cells:
                    cell_text = cell.text.strip()
                    cell_tds.append(
                        f"<td style=\"border:1px solid #ccc; padding:0.5em; "
                        f"word-break:break-word; overflow-wrap:anywhere;\">{html.escape(cell_text)}</td>"
                    )
                rows_html.append(f"<tr>{''.join(cell_tds)}</tr>")
            except (IndexError, AttributeError, TypeError):
                continue

        if rows_html:
            return (
                f"<table style=\"border-collapse:collapse; width:100%; margin:1em 0; "
                f"table-layout:fixed;\"><tbody>{''.join(rows_html)}</tbody></table>"
            )
        return ""
    except (IndexError, AttributeError, TypeError):
        return ""


def _cell_border_css(tc) -> str:
    try:
        tcPr = tc.tcPr
        borders = tcPr.find(qn('w:tcBorders')) if tcPr is not None else None
        if borders is None:
            return ""
        sides = {"top": "top", "left": "left", "bottom": "bottom", "right": "right"}
        css_parts = []
        for xml_side, css_side in sides.items():
            side_el = borders.find(qn(f'w:{xml_side}'))
            if side_el is None:
                css_parts.append(f"border-{css_side}:none")
                continue
            val = side_el.get(qn('w:val')) or ""
            if val in ("nil", "none"):
                css_parts.append(f"border-{css_side}:none")
                continue
            sz = side_el.get(qn('w:sz'))
            width_px = max(1, round(int(sz) / 8)) if sz and sz.isdigit() else 1
            color = side_el.get(qn('w:color')) or "auto"
            css_color = "#999" if not color or color.lower() == "auto" else f"#{color}"
            css_parts.append(f"border-{css_side}:{width_px}px solid {css_color}")
        return "; ".join(css_parts)
    except (AttributeError, TypeError, ValueError):
        return ""


def _render_table(
    table,
    add_field: Callable[[str, str | None], str | None] | None = None,
) -> str:
    """Render a table matching the source's column widths and merged
    cells (colspan/rowspan), with per-run formatting inside each cell.

    This walks the raw `tbl.tr_lst` / `tc.tcPr` XML directly rather than
    using `row.cells`, so it is already immune to the grid/merge-mismatch
    IndexError that `_safe_row_cells` exists to work around elsewhere in
    this module. Any *other* unexpected failure still falls back to
    `_render_table_plain` via the outer except below.
    """
    try:
        tbl = table._tbl
        grid_cols = list(tbl.tblGrid.gridCol_lst) if tbl.tblGrid is not None else []
        col_widths_twips = [int(gc.get(qn('w:w')) or 0) for gc in grid_cols]
        total_width = sum(col_widths_twips) or 1
        col_widths_pct = [w / total_width * 100 for w in col_widths_twips]

        open_vmerge: dict[int, dict] = {}
        row_records: list[list[dict]] = []

        for tr in tbl.tr_lst:
            row_cells: list[dict] = []
            col_idx = 0
            for tc in tr.tc_lst:
                try:
                    tcPr = tc.tcPr
                    gs = tcPr.find(qn('w:gridSpan')) if tcPr is not None else None
                    colspan = int(gs.get(qn('w:val'))) if gs is not None else 1
                    vm = tcPr.find(qn('w:vMerge')) if tcPr is not None else None
                    vm_val = vm.get(qn('w:val')) if vm is not None else None

                    if vm is not None and vm_val != 'restart':
                        owner = open_vmerge.get(col_idx)
                        if owner is not None:
                            owner['rowspan'] += 1
                        col_idx += max(colspan, 1)
                        continue

                    cell = _Cell(tc, table)
                    cell_text = _extract_cell_text(cell)

                    explicit_border_css = _cell_border_css(tc)
                    style_bits = [
                        explicit_border_css or "border:1px solid #ccc",
                        "padding:0.4em 0.6em",
                        "vertical-align:top",
                        "word-break:break-word",
                        "overflow-wrap:anywhere",
                    ]
                    if col_widths_pct and col_idx < len(col_widths_pct):
                        width_pct = sum(col_widths_pct[col_idx: col_idx + colspan])
                        if width_pct:
                            style_bits.append(f"width:{width_pct:.2f}%")

                    cell_field_id = None
                    cell_match = _candidate_field_match(cell_text) if add_field else None
                    cell_match_value = (cell_match.groupdict().get("value") or "").strip() if cell_match else ""
                    cell_is_weak_match = bool(cell_match and cell_match.re is _LABEL_ONLY_RE)
                    if add_field is not None and cell_match and not cell_is_weak_match and cell_match_value:
                        cell_field_id = add_field(cell_match.group("label").strip(), cell_match_value)
                    cell_pending_label = (
                        cell_match.group("label").strip()
                        if cell_match and not cell_is_weak_match and not cell_match_value
                        else None
                    )

                    cell_paras_html = []
                    for p in cell.paragraphs:
                        p_field_id = None
                        p_value_start = None
                        if cell_field_id and cell_match and p.text.strip() == cell_text:
                            p_field_id = cell_field_id
                            p_value_start = _value_start_offset(p.text, cell_match)
                        cell_paras_html.append(_render_paragraph(p, field_id=p_field_id, value_start=p_value_start))
                    cell_html = "".join(h for h in cell_paras_html if h) or "&nbsp;"

                    record = {
                        "rowspan": 1,
                        "colspan": colspan,
                        "style": "; ".join(style_bits),
                        "html": cell_html,
                        "text": cell_text,
                        "tagged": cell_field_id is not None,
                        "pending_label_text": cell_pending_label,
                    }
                    if vm is not None and vm_val == 'restart':
                        open_vmerge[col_idx] = record
                    else:
                        open_vmerge.pop(col_idx, None)

                    row_cells.append(record)
                    col_idx += max(colspan, 1)
                except Exception:
                    # One malformed <w:tc> should never take down the
                    # whole table render - skip it and keep going.
                    logger.warning("failed to render one table cell; skipping it", exc_info=True)
                    col_idx += 1
                    continue
            row_records.append(row_cells)

        removed_cells: set[tuple[int, int]] = set()

        def _col_positions(row_cells: list[dict]) -> list[int]:
            positions = []
            idx = 0
            for rec in row_cells:
                positions.append(idx)
                idx += max(rec["colspan"], 1)
            return positions

        def _borderless(style: str, side: str) -> bool:
            return f"border-{side}:none" in style

        all_columns = {c for row in row_records for c in _col_positions(row)}
        for col in sorted(all_columns):
            chain: list[tuple[int, int]] = []
            for row_i, row_cells in enumerate(row_records):
                for pos_i, c in enumerate(_col_positions(row_cells)):
                    if c == col and row_cells[pos_i]["colspan"] == 1:
                        chain.append((row_i, pos_i))
                        break
            anchor: tuple[int, int] | None = None
            prev_rec: dict | None = None
            for row_i, pos_i in chain:
                rec = row_records[row_i][pos_i]
                if (
                    anchor is not None
                    and prev_rec is not None
                    and not rec["text"]
                    and _borderless(prev_rec["style"], "bottom")
                    and _borderless(rec["style"], "top")
                ):
                    row_records[anchor[0]][anchor[1]]["rowspan"] += 1
                    removed_cells.add((row_i, pos_i))
                    prev_rec = rec
                    continue
                anchor = (row_i, pos_i)
                prev_rec = rec

        if removed_cells:
            row_records = [
                [rec for pos_i, rec in enumerate(row_cells) if (row_i, pos_i) not in removed_cells]
                for row_i, row_cells in enumerate(row_records)
            ]

        if add_field is not None:
            field_adder = add_field
            def _is_label_like(cell: dict) -> bool:
                text = cell["text"]
                return bool(
                    text
                    and len(text) <= 60
                    and len(text.split()) <= 8
                    and text.lower() not in _STOPWORD_LABELS
                    and _looks_like_real_label(text)
                )

            def _label_cell_text(cell_text: str) -> str:
                match = _candidate_field_match(cell_text)
                return match.group("label").strip() if match else cell_text

            def _looks_like_value_code(text: str) -> bool:
                stripped = (text or "").strip()
                if not stripped:
                    return False
                digits = sum(ch.isdigit() for ch in stripped)
                return digits >= 2 and digits / len(stripped) >= 0.2

            for row_cells in row_records:
                i = 0
                n = len(row_cells)
                while i < n:
                    cell = row_cells[i]
                    if not cell["tagged"] and cell.get("pending_label_text") and i + 1 < n:
                        value_cell = row_cells[i + 1]
                        if not value_cell["tagged"] and value_cell["text"]:
                            field_id = field_adder(cell["pending_label_text"], value_cell["text"])
                            if field_id:
                                value_cell["html"] = _tag_open(field_id) + value_cell["html"] + _tag_close(field_id)
                                value_cell["tagged"] = True
                                cell["tagged"] = True
                            i += 2
                            continue
                    i += 1

                untagged = [c for c in row_cells if not c["tagged"]]
                non_empty = [c for c in untagged if c["text"]]
                pair = None
                if len(non_empty) == 2:
                    pair = (non_empty[0], non_empty[1])
                elif len(untagged) == 2 and len(non_empty) == 1:
                    pair = tuple(untagged)

                if pair:
                    label_cell, value_cell = pair
                    if not _is_label_like(label_cell) and _is_label_like(value_cell):
                        label_cell, value_cell = value_cell, label_cell

                    if (
                        _is_label_like(label_cell)
                        and not _looks_like_value_code(label_cell["text"])
                    ):
                        field_id = field_adder(_label_cell_text(label_cell["text"]), value_cell["text"] or None)
                        if field_id:
                            value_cell["html"] = _tag_open(field_id) + value_cell["html"] + _tag_close(field_id)
                            value_cell["tagged"] = True

            if len(row_records) >= 2:
                header_row = row_records[0]
                header_cells = [c for c in header_row if c["text"]]
                is_header_row = (
                    len(header_cells) >= 3
                    and all(len(c["text"]) <= 24 and len(c["text"].split()) <= 4 for c in header_cells)
                    and all(":" not in c["text"] and c.get("pending_label_text") is None for c in header_row)
                    and all(not _looks_like_value_code(c["text"]) for c in header_cells)
                )
                if is_header_row:
                    for data_row_index, data_row in enumerate(row_records[1:], start=1):
                        for col_idx, cell in enumerate(data_row):
                            if cell["tagged"] or col_idx >= len(header_row):
                                continue
                            header_label = header_row[col_idx]["text"]
                            if not header_label:
                                continue
                            field_id = field_adder(f"{header_label} (row {data_row_index})", cell["text"])
                            if field_id:
                                cell["html"] = _tag_open(field_id) + cell["html"] + _tag_close(field_id)
                                cell["tagged"] = True

        html_rows = []
        for row_cells in row_records:
            tds = []
            for c in row_cells:
                rowspan_attr = f' rowspan="{c["rowspan"]}"' if c["rowspan"] > 1 else ""
                colspan_attr = f' colspan="{c["colspan"]}"' if c["colspan"] > 1 else ""
                tds.append(f'<td style="{c["style"]}"{colspan_attr}{rowspan_attr}>{c["html"]}</td>')
            if tds:
                html_rows.append(f"<tr>{''.join(tds)}</tr>")

        if not html_rows:
            return ""
        return (
            '<table style="border-collapse:collapse; width:100%; margin:1em 0; '
            'font-family:inherit; table-layout:fixed;"><tbody>' + "".join(html_rows) + "</tbody></table>"
        )
    except Exception:
        logger.warning("structure-aware table render failed, falling back to plain table", exc_info=True)
        return _render_table_plain(table)


def _finalize_section(section: dict[str, Any]) -> None:
    try:
        html_parts = [p.get("html", "") for p in section.get("paragraphs", []) if p.get("html")]
        section["content_html"] = "".join(html_parts)
    except (IndexError, AttributeError, TypeError):
        section["content_html"] = ""


def infer_schema_sections(source_path: Path) -> tuple[list[dict[str, Any]], str]:
    """Returns (sections, extracted_text_preview)."""
    sections, text_preview, _, _, _, _, _ = infer_schema_sections_with_page_count(source_path)
    return sections, text_preview


def extract_docx_text_pages(source_path: Path) -> list[tuple[int, str]]:
    if source_path.suffix.lower() == ".doc":
        try:
            source_path = _convert_doc_to_docx(source_path)
        except Exception:
            return []

    try:
        doc = docx.Document(str(source_path))
    except Exception:
        return []

    estimated_total_pages = _count_document_pages(doc)
    page_boundaries = _detect_page_boundaries_heuristic(doc, estimated_total_pages)
    paragraphs_per_page = None
    if not page_boundaries:
        text_content_paragraphs = [p for p in doc.paragraphs if p.text.strip()]
        paragraphs_per_page = max(1, len(text_content_paragraphs) // max(1, estimated_total_pages))

    page_text_fragments: dict[int, list[str]] = {}
    current_page = 1
    total_block_count = len(list(_iter_block_items(doc)))
    for block_index, block in enumerate(_iter_block_items(doc)):
        try:
            if isinstance(block, Table):
                current_page = _estimate_page_from_position(
                    block_index, total_block_count, page_boundaries, paragraphs_per_page, estimated_total_pages
                )
                for row in _safe_table_rows(block):
                    try:
                        cells = _dedupe_merged_cells([c.strip() for c in _extract_row_cells(row)])
                    except Exception:
                        continue
                    row_text = "\t".join(c for c in cells if c)
                    if row_text:
                        page_text_fragments.setdefault(current_page, []).append(row_text)
                continue

            text = block.text.strip()
            if text:
                current_page = _estimate_page_from_position(
                    block_index, total_block_count, page_boundaries, paragraphs_per_page, estimated_total_pages
                )
                page_text_fragments.setdefault(current_page, []).append(text)
        except Exception:
            # A single malformed block should never abort text extraction
            # for the rest of the document.
            logger.warning("failed to extract text for block %s; skipping it", block_index, exc_info=True)
            continue

    pages: list[tuple[int, str]] = []
    for page_num in range(1, max(estimated_total_pages, 1) + 1):
        pages.append((page_num, "\n".join(page_text_fragments.get(page_num, []))))
    overflow = [p for p in page_text_fragments if p > len(pages)]
    if overflow and pages:
        last_num, last_text = pages[-1]
        extra = "\n".join("\n".join(page_text_fragments[p]) for p in sorted(overflow))
        pages[-1] = (last_num, (last_text + "\n" + extra).strip() if last_text else extra)
    return pages


def get_document_sections_for_display(source_path: Path) -> list[dict[str, Any]]:
    """Get document rendered as separate scrollable sections with full formatting."""
    target_path = source_path
    if source_path.suffix.lower() == ".doc":
        try:
            target_path = _convert_doc_to_docx(source_path)
        except Exception as exc:
            raise ValueError(f"Could not convert .doc file to .docx: {exc}") from exc

    try:
        doc = docx.Document(str(target_path))
    except Exception as exc:
        raise ValueError(f"Could not open document: {exc}") from exc

    try:
        return _render_document_sections(doc)
    except Exception:
        # Rendering sections is a display nicety, not the thing that
        # should gate whether an upload is accepted - degrade to a single
        # empty section rather than raising.
        logger.exception("Failed to render document sections for display; returning a minimal placeholder")
        return [{
            "section_id": "cover",
            "section_name": "Document",
            "section_number": 0,
            "content_html": "<p>Preview unavailable for this document.</p>",
            "paragraphs": [],
        }]


def _detect_page_boundaries_heuristic(doc: DocxDocumentType, estimated_total_pages: int) -> dict[int, int]:
    if estimated_total_pages <= 1:
        return {}

    boundaries = {}
    block_index = 0
    cumulative_blank_lines = 0

    try:
        total_blocks_for_estimate = len(list(_iter_block_items(doc)))
        for block in _iter_block_items(doc):
            try:
                if isinstance(block, Table):
                    if block_index > 0:
                        est_page = 1 + (block_index * estimated_total_pages) // (total_blocks_for_estimate + 1)
                        if est_page not in boundaries.values() and est_page <= estimated_total_pages:
                            boundaries[block_index] = est_page
                    block_index += 1
                    cumulative_blank_lines = 0
                    continue

                text = block.text.strip()

                has_page_break = False
                try:
                    if hasattr(block, 'runs'):
                        for run in block.runs:
                            if hasattr(run, '_element'):
                                breaks = run._element.findall(".//w:br",
                                    namespaces={"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"})
                                for br in breaks:
                                    if br.get("{http://schemas.openxmlformats.org/wordprocessingml/2006/main}type") == "page":
                                        has_page_break = True
                                        break
                except (IndexError, AttributeError, TypeError):
                    pass

                if has_page_break and block_index > 0:
                    est_page = min(estimated_total_pages, 1 + len(boundaries))
                    if est_page <= estimated_total_pages:
                        boundaries[block_index] = est_page

                if not text:
                    cumulative_blank_lines += 1
                    if cumulative_blank_lines >= 3 and block_index > 0:
                        est_page = min(estimated_total_pages, 1 + len(boundaries))
                        if est_page <= estimated_total_pages and block_index not in boundaries:
                            boundaries[block_index] = est_page
                        cumulative_blank_lines = 0
                else:
                    if _looks_like_heading(block) and block_index > 0:
                        est_page = min(estimated_total_pages, 1 + len(boundaries))
                        if est_page <= estimated_total_pages and block_index not in boundaries:
                            boundaries[block_index] = est_page
                    cumulative_blank_lines = 0

                block_index += 1
            except (IndexError, AttributeError, TypeError):
                block_index += 1
                continue
    except (IndexError, AttributeError, TypeError):
        pass

    return boundaries


def _estimate_page_from_position(
    block_index: int,
    total_blocks: int,
    page_boundaries: dict[int, int],
    paragraphs_per_page: int | None,
    estimated_total_pages: int,
) -> int:
    if total_blocks <= 0:
        return 1

    if not page_boundaries:
        if paragraphs_per_page and paragraphs_per_page > 0:
            return min(estimated_total_pages, max(1, 1 + (block_index // max(1, paragraphs_per_page))))

        if estimated_total_pages > 1:
            return min(estimated_total_pages, max(1, 1 + int((block_index / max(1, total_blocks)) * estimated_total_pages)))
        return 1

    applicable_page = 1
    for boundary_index in sorted(page_boundaries.keys()):
        if boundary_index <= block_index:
            applicable_page = page_boundaries[boundary_index]
        else:
            break

    return min(estimated_total_pages, max(1, applicable_page))


def _iter_block_items_of(container, doc: DocxDocumentType):
    element = container._element
    for child in element.iterchildren():
        if child.tag == qn("w:p"):
            yield Paragraph(child, doc)
        elif child.tag == qn("w:tbl"):
            yield Table(child, doc)


def _render_header_footer_html(container, doc: DocxDocumentType, add_field=None) -> str:
    if container is None:
        return ""
    fragments: list[str] = []
    try:
        for block in _iter_block_items_of(container, doc):
            try:
                if isinstance(block, Table):
                    table_html = _render_table(block, add_field=add_field)
                    if table_html:
                        fragments.append(table_html)
                    continue
                text = block.text.strip()
                if not text:
                    continue
                fragments.append(_render_paragraph(block))
            except Exception:
                # One bad paragraph/table in the header/footer shouldn't
                # blank out the rest of the title block.
                logger.warning("failed to render one header/footer block; skipping it", exc_info=True)
                continue
    except Exception:
        logger.warning("header/footer render failed", exc_info=True)
        return ""
    if not fragments:
        return ""
    return (
        '<div class="tpl-header-footer" style="margin-bottom:0.75em;">'
        + "".join(fragments)
        + "</div>"
    )


def _apply_static_paragraph_edit(paragraph: Paragraph, new_text: str) -> None:
    """Overwrite a static paragraph's wording in place.

    Keeps the paragraph's first run (so its font/bold/size/etc. carries
    over) and puts the new text there; any additional runs in the same
    paragraph are removed. This means a paragraph with more than one
    formatting change mid-sentence collapses to a single uniform style
    when edited - acceptable because it only affects blocks the reviewer
    explicitly edits, never blocks left untouched.
    """
    runs = list(paragraph.runs)
    if runs:
        runs[0].text = new_text
        for extra in runs[1:]:
            extra._element.getparent().remove(extra._element)
    else:
        paragraph.add_run(new_text)


def infer_schema_sections_with_page_count(
    source_path: Path,
    output_dir: Path | None = None,
) -> tuple[list[dict[str, Any]], str, int, str, list[str], list[str], list[dict[str, Any]]]:
    """Parse a .doc/.docx into a draft schema.

    This is deliberately defensive throughout: a single malformed table,
    row, cell, header, or footer must never abort the parse of the whole
    document (that used to surface as an opaque "Could not read the
    document: list index out of range" and reject the upload entirely).
    Only two things are still allowed to fail the whole parse, because
    they mean there is no usable document to draft a schema from at all:
    converting a legacy .doc to .docx, and opening the resulting file with
    python-docx in the first place.
    """
    target_path = source_path
    if source_path.suffix.lower() == ".doc":
        try:
            target_path = _convert_doc_to_docx(source_path)
        except Exception as exc:
            raise ValueError(f"Could not convert .doc file to .docx: {exc}") from exc

    try:
        doc = docx.Document(str(target_path))
    except Exception as exc:
        raise ValueError(f"Could not open document: {exc}") from exc

    page_texts: list[str] = []
    pdf_path: Path | None = None
    try:
        pdf_path = _docx_to_pdf(target_path)
        page_texts = _pdf_page_texts(pdf_path)
    except Exception as exc:
        # Rendering to PDF (for exact page numbers / page images) is a
        # nice-to-have, not a requirement - the heuristic page estimator
        # below covers this case. Never let a missing/broken LibreOffice
        # install reject an otherwise-good upload.
        print(f"[schema_inference] could not render {target_path} to PDF for page-accurate field assignment: {exc!r}", flush=True)
        logger.warning("Could not render %s to PDF for page-accurate field assignment", target_path, exc_info=True)

    locator = _PageLocator(page_texts)
    have_real_pages = bool(page_texts)
    text_content_paragraphs = [p for p in doc.paragraphs if p.text.strip()]
    estimated_total_pages = len(page_texts) if have_real_pages else _count_document_pages(doc)
    page_boundaries = _detect_page_boundaries_heuristic(doc, estimated_total_pages)
    paragraphs_per_page = None if page_boundaries else max(1, len(text_content_paragraphs) // max(1, estimated_total_pages))

    sections: list[dict[str, Any]] = []
    current_section: dict[str, Any] = {"section_id": "general", "section_name": "General", "fields": [], "page_number": 1}
    seen_field_ids: set[str] = set()
    seen_labels: set[str] = set()
    label_to_field_id: dict[str, str] = {}
    section_count = 0
    current_page = 1
    page_html_fragments: dict[int, list[str]] = {}
    numbered_section_seen = False
    cover_title_count = 0

    # Static content blocks: paragraphs/whole tables that carry no detected
    # dynamic field. Reviewers can still edit this wording (it's the fixed
    # boilerplate/labels of the master template itself), separately from
    # the Dynamic Fields list above - collected in the same single pass so
    # it never drifts out of sync with what was actually tagged as a field.
    static_blocks: list[dict[str, Any]] = []
    static_block_counter = 0
    prev_block_was_heading = False

    def _add_static_block(
        page_num: int,
        block_type: str,
        text: str,
        looks_like_blank_field: bool = False,
        paragraph_index: int | None = None,
    ) -> str:
        nonlocal static_block_counter
        static_block_counter += 1
        block_id = f"static_{static_block_counter}"
        static_blocks.append(
            {
                "block_id": block_id,
                "page_number": page_num,
                "block_type": block_type,
                "text": text,
                # Hint only - never auto-promoted. Set when a blank
                # paragraph/table sits right after a heading or cover
                # title, which is where "fill in later" blanks (signature
                # lines, dates, prepared-by) usually live. The reviewer
                # decides whether to actually promote it to a field.
                "looks_like_blank_field": looks_like_blank_field,
                # Stable position in doc.paragraphs used to relocate this
                # exact paragraph later for a text edit, without having to
                # redo the static/dynamic classification pass. None for
                # table blocks (not editable - see apply_static_block_edits).
                "paragraph_index": paragraph_index,
            }
        )
        return block_id

    def _cover_title_label(text: str) -> str:
        nonlocal cover_title_count
        cover_title_count += 1
        stripped = text.strip()
        upper = stripped.upper()
        if "PROJECT" in upper:
            return "Project Name"
        if (
            re.fullmatch(r"[A-Z0-9][A-Z0-9\-]{2,19}", stripped)
            and any(ch.isdigit() for ch in stripped)
        ):
            return "Document Code"
        if (
            cover_title_count >= 3
            and len(stripped.split()) == 1
            and re.fullmatch(r"[A-Z][A-Z]{2,29}", stripped)
        ):
            return "Location"
        return f"Cover Title Line {cover_title_count}"

    def _record_page_html(page_num: int, fragment: str) -> None:
        if not fragment:
            return
        page_html_fragments.setdefault(max(1, page_num), []).append(fragment)

    def add_field(
        label: str,
        page_num: int,
        sample_value: str | None = None,
        explicit_field_id: str | None = None,
    ) -> str | None:
        normalized_label = re.sub(r"\s+", " ", (label or "").strip())
        label_key = normalized_label.lower()
        if label_key in label_to_field_id:
            return label_to_field_id[label_key]

        base_id = explicit_field_id or _slugify(normalized_label)
        field_id = base_id
        suffix = 2
        while field_id in seen_field_ids:
            field_id = f"{base_id}_{suffix}"
            suffix += 1

        seen_field_ids.add(field_id)
        seen_labels.add(label_key)
        label_to_field_id[label_key] = field_id

        hint = f"Extract the {normalized_label.lower()} from the source document."
        if sample_value:
            hint += f" Example from source: \"{sample_value[:120]}\"."

        current_section["fields"].append(
            {
                "field_id": field_id,
                "field_label": normalized_label,
                "data_type": "string",
                "required": False,
                "page_number": page_num,
                "extraction_hint": hint,
                "default_value": sample_value or "",
                "validation_rules": [],
            }
        )
        return field_id

    total_block_count = len(list(_iter_block_items(doc)))
    table_index_counter = 0
    paragraph_counter = 0
    for block_index, block in enumerate(_iter_block_items(doc)):
        try:
            if isinstance(block, Table):
                table_index_counter += 1

                if not have_real_pages:
                    current_page = _estimate_page_from_position(
                        block_index,
                        total_block_count,
                        page_boundaries,
                        paragraphs_per_page,
                        estimated_total_pages,
                    )

                def _add_table_field(
                    label: str,
                    value: str | None,
                    _page: int = current_page,
                    _table_index: int = table_index_counter,
                ) -> str | None:
                    page_for_field = locator.locate(f"{label} {value or ''}", _page) if have_real_pages else _page
                    explicit_id = f"{_slugify(label)}_table_{_table_index}"
                    return add_field(
                        label=label,
                        page_num=page_for_field,
                        sample_value=value,
                        explicit_field_id=explicit_id,
                    )

                fields_before = len(seen_field_ids)
                _record_page_html(current_page, _render_table(block, add_field=_add_table_field))
                table_had_fields = len(seen_field_ids) > fields_before
                if not table_had_fields:
                    # Whole table produced zero fields (e.g. a legend/notes
                    # table, or one with only static labels) - offer it as
                    # one editable static block rather than silently
                    # locking it. Tables that DID produce at least one
                    # field stay entirely in the Dynamic Fields list, per
                    # the "forms and tables inside them are mostly
                    # dynamic" review rule - we don't split a single table
                    # across both forms.
                    try:
                        row_lines: list[str] = []
                        for row in _safe_table_rows(block):
                            try:
                                cell_texts = [
                                    _extract_cell_text(c).strip() for c in _safe_row_cells(row)
                                ]
                            except Exception:
                                continue
                            cell_texts = [c for c in cell_texts if c]
                            if cell_texts:
                                row_lines.append(" | ".join(cell_texts))
                        table_text = "\n".join(row_lines)
                    except Exception:
                        table_text = ""
                    if table_text:
                        _add_static_block(current_page, "table", table_text)
                prev_block_was_heading = False
                continue

            paragraph = block
            raw_text = paragraph.text
            text = raw_text.strip()
            this_paragraph_index = paragraph_counter
            paragraph_counter += 1

            if have_real_pages:
                if text:
                    current_page = locator.locate(text, current_page)
            elif text:
                current_page = _estimate_page_from_position(
                    block_index,
                    total_block_count,
                    page_boundaries,
                    paragraphs_per_page,
                    estimated_total_pages,
                )

            field_id = None
            value_start = None
            is_numbered_heading = bool(_numbered_heading_match(text))
            is_heading = _looks_like_heading(paragraph)
            is_cover_title = (
                not numbered_section_seen and is_heading and not is_numbered_heading and current_page == 1
            )
            if text and is_cover_title:
                field_id = add_field(_cover_title_label(text), current_page, text)
                if field_id:
                    value_start = 0
            elif text and not is_heading:
                match = _candidate_field_match(text)
                if match:
                    value = (match.groupdict().get("value") or "").strip()
                    field_id = add_field(match.group("label").strip(), current_page, value or None)
                    if field_id:
                        value_start = _value_start_offset(raw_text, match)
                # NOTE: paragraphs that don't match a "Label: value" /
                # "Label ____" shape are deliberately left untagged here.
                # This used to fall through to tagging the ENTIRE
                # paragraph as its own editable field
                # (`_prose_paragraph_label`), which is what turned every
                # ordinary sentence, clause, and table-header word into
                # its own individually-editable box in the preview -
                # reviewers only want the actual form VALUES editable
                # (spec no., project no., revision, etc.), not static
                # narrative or structural text. Static text still renders
                # normally via `_render_paragraph` below; it's just not
                # wrapped in a `data-field-id` span, so it's read-only in
                # the preview, matching the locked-source-layout behavior
                # the reviewer UI already describes ("everything else
                # stays locked to the source layout").

            _record_page_html(current_page, _render_paragraph(paragraph, field_id=field_id, value_start=value_start))

            if not text:
                # A blank line right after a heading/cover title is often a
                # "fill in later" spot (signature, date, prepared-by) that
                # never matched a "Label: value" pattern because there's no
                # text there at all to match against - surface it as a
                # promotable static block instead of silently dropping it,
                # so it's at least visible and one click away from being
                # turned into a real dynamic field during review.
                if prev_block_was_heading:
                    _add_static_block(
                        current_page, "paragraph", "", looks_like_blank_field=True,
                        paragraph_index=this_paragraph_index,
                    )
                prev_block_was_heading = False
                continue
            if field_id is None:
                _add_static_block(
                    current_page, "heading" if is_heading else "paragraph", text,
                    paragraph_index=this_paragraph_index,
                )
            prev_block_was_heading = is_heading
            if is_numbered_heading:
                numbered_section_seen = True
            if is_heading and not is_cover_title:
                if current_section["fields"]:
                    sections.append(current_section)
                section_count += 1
                current_section = {
                    "section_id": f"{_slugify(text)}_{section_count}",
                    "section_name": text.title() if text.upper() == text else text,
                    "fields": [],
                    "page_number": current_page,
                }
        except Exception:
            # A single malformed block (bad table grid, corrupted
            # paragraph XML, etc.) must never abort the whole parse - skip
            # it, log it, and keep going so the rest of the document still
            # produces a usable draft schema.
            logger.exception(
                "Failed to process block %s while inferring schema; skipping it and continuing",
                block_index,
            )
            continue

    if current_section["fields"]:
        sections.append(current_section)

    if not sections:
        sections = [{"section_id": "general", "section_name": "General", "fields": [], "page_number": 1}]

    document_text_parts: list[str] = []
    for block in _iter_block_items(doc):
        try:
            if isinstance(block, Table):
                for row_index, row in enumerate(_safe_table_rows(block)):
                    try:
                        cells = _extract_row_cells(row)
                    except Exception:
                        continue
                    if any(cells):
                        document_text_parts.append(f"[TABLE ROW {row_index + 1}] " + " | ".join(cells))
            else:
                text = _clean_extracted_text(block.text)
                if text:
                    document_text_parts.append(text)
        except Exception:
            continue

    text_preview = "\n".join(document_text_parts)[:2000]

    try:
        preview_html = _render_docx_preview_html(doc)
    except Exception:
        logger.exception("Failed to render full-document preview HTML; continuing without it")
        preview_html = ""

    page_images: list[str] = []
    if output_dir and pdf_path is not None:
        try:
            output_dir.mkdir(parents=True, exist_ok=True)
            page_images = _pdf_to_page_images(pdf_path, output_dir)
        except Exception:
            pass
    if pdf_path is not None:
        try:
            pdf_path.unlink()
        except Exception:
            pass

    if have_real_pages:
        page_count = len(page_texts)
    elif page_images:
        page_count = len(page_images)
    else:
        page_count = _count_document_pages(doc)

    def _header_footer_add_field(prefix: str, page_num: int):
        counter = {"n": 0}

        def _add(label: str, value: str | None) -> str | None:
            counter["n"] += 1
            return add_field(
                label=label,
                page_num=page_num,
                sample_value=value,
                explicit_field_id=f"{_slugify(label)}_{prefix}_{counter['n']}",
            )

        return _add

    header_html_first = ""
    header_html_default = ""
    footer_html_first = ""
    footer_html_default = ""
    try:
        section = doc.sections[0] if doc.sections else None
        if section is not None:
            uses_first_page = bool(section.different_first_page_header_footer)
            header_html_default = _render_header_footer_html(
                section.header, doc, add_field=_header_footer_add_field("hdr", 2)
            )
            footer_html_default = _render_header_footer_html(
                section.footer, doc, add_field=_header_footer_add_field("ftr", 2)
            )
            if uses_first_page:
                header_html_first = _render_header_footer_html(
                    section.first_page_header, doc, add_field=_header_footer_add_field("hdr", 1)
                )
                footer_html_first = _render_header_footer_html(
                    section.first_page_footer, doc, add_field=_header_footer_add_field("ftr", 1)
                )
            else:
                header_html_first = header_html_default
                footer_html_first = footer_html_default
    except Exception:
        # Header/footer rendering (the repeating title block) is valuable
        # but not load-bearing - a document with an unusual/broken section
        # setup should still parse and produce a schema, just without the
        # repeating title-block fields.
        logger.warning("could not render document header/footer", exc_info=True)

    page_html: list[str] = []
    for page_num in range(1, max(page_count, 1) + 1):
        fragments = page_html_fragments.get(page_num, [])
        header_frag = header_html_first if page_num == 1 else header_html_default
        footer_frag = footer_html_first if page_num == 1 else footer_html_default
        page_html.append(header_frag + "".join(fragments) + footer_frag)
    overflow_pages = [p for p in page_html_fragments if p > len(page_html)]
    if overflow_pages and page_html:
        for p in sorted(overflow_pages):
            page_html[-1] += "".join(page_html_fragments[p])

    return sections, text_preview, page_count, preview_html, page_images, page_html, static_blocks


def apply_static_block_edits(
    source_path: Path,
    edits: list[dict[str, Any]],
) -> list[str]:
    """Write edited static-block wording directly into the master/pending
    .docx, in place, by paragraph position - deliberately NOT a re-run of
    infer_schema_sections_with_page_count(), so it can never regenerate
    (and thereby discard) sections a reviewer already hand-edited.

    `edits` is a list of {"block_id", "paragraph_index", "text"} - the
    paragraph_index values must come from the static_blocks this same
    document previously produced. Table-type static blocks have no
    paragraph_index and are silently skipped (whole-table wording isn't
    safe to rewrite from a single flattened text blob without risking the
    "tables keep their exact structure" requirement - that needs a
    cell-by-cell editor, not this).

    Returns the list of block_ids actually written, so the caller can
    tell which requested edits were applied vs skipped.
    """
    doc = docx.Document(str(source_path))
    paragraphs = doc.paragraphs
    applied: list[str] = []
    for edit in edits:
        idx = edit.get("paragraph_index")
        block_id = edit.get("block_id")
        new_text = edit.get("text", "")
        if idx is None or not isinstance(idx, int) or idx < 0 or idx >= len(paragraphs):
            continue
        _apply_static_paragraph_edit(paragraphs[idx], new_text)
        applied.append(block_id)
    if applied:
        doc.save(str(source_path))
    return applied


def _clean_extracted_text(value: str | None) -> str:
    if not value:
        return ""

    value = value.replace("\r\n", "\n")
    value = value.replace("\r", "\n")
    value = value.replace("\xa0", " ")

    lines = []

    for line in value.split("\n"):
        line = re.sub(r"[ \t]+", " ", line).strip()

        if line:
            lines.append(line)

    return "\n".join(lines)


def _extract_cell_text(cell: _Cell) -> str:
    """
    Extract all text from a table cell, including multiline and nested-table
    content.
    """
    parts = []

    try:
        for paragraph in cell.paragraphs:
            text = _clean_extracted_text(paragraph.text)

            if text:
                parts.append(text)
    except Exception:
        logger.warning("failed to read paragraphs from a table cell", exc_info=True)

    try:
        for nested_table in cell.tables:
            nested_rows = []

            for row in _safe_table_rows(nested_table):
                nested_cells = []

                for nested_cell in _safe_row_cells(row):
                    try:
                        nested_text = _extract_cell_text(nested_cell)
                    except Exception:
                        continue

                    if nested_text:
                        nested_cells.append(nested_text)

                if nested_cells:
                    nested_rows.append(" | ".join(nested_cells))

            if nested_rows:
                parts.append("\n".join(nested_rows))
    except Exception:
        logger.warning("failed to read nested tables from a table cell", exc_info=True)

    return "\n".join(parts).strip()


def _extract_row_cells(row) -> list[str]:
    """
    Keep blank cells because a blank cell is usually the editable value
    location in a form. Uses `_safe_row_cells` so a malformed grid/merge
    on this row degrades to "read whatever cells could be read" instead
    of raising and aborting the whole document parse.
    """
    return [_extract_cell_text(cell) for cell in _safe_row_cells(row)]


def _is_table_label(value: str) -> bool:
    value = re.sub(r"\s+", " ", (value or "").strip())

    if not value:
        return False

    if _LIST_MARKER_RE.fullmatch(value):
        return False

    if value.lower() in _STOPWORD_LABELS:
        return False

    if len(value) > 80:
        return False

    if len(value.split()) > 8:
        return False

    return True


def _make_table_field_id(
    label: str,
    table_index: int,
    row_index: int,
    cell_index: int,
) -> str:
    return (
        f"{_slugify(label)}"
        f"_table_{table_index + 1}"
        f"_row_{row_index + 1}"
        f"_cell_{cell_index + 1}"
    )


# =========================================================================
# Per-page structured extraction (page_number / header / paragraphs /
# tables / forms / images / text)
# =========================================================================
#
# Everything above this point produces either a flat schema draft
# (`sections[].fields[]`) or rendered HTML (`page_html`, `preview_html`).
# Neither is the shape needed by a page-by-page editor that wants to
# reason about a page's *content types* separately - "this page has a
# header, two paragraphs, one table, and one form field" - rather than
# just a blob of markup.
#
# `extract_page_structure()` builds that contract:
#
#   {
#     "page_number": 1,
#     "header": "...",
#     "paragraphs": [...],
#     "tables": [...],
#     "forms": [...],
#     "images": [...],
#     "text": "...",
#   }
#
# Ground rules this function follows, matching the master-template
# requirements this module has always followed for its other outputs:
#   - No AI/model call of any kind - this whole module has never made one.
#   - The template's structure is never redesigned, flattened, or
#     regenerated: paragraphs are kept as whole blocks (never split
#     line-by-line), tables keep every cell including empty ones, and
#     rowspan/colspan/borders/column widths are preserved.
#   - Every block is attributed to the real page it appears on when a
#     rendered PDF is available (see `_PageLocator`); otherwise it falls
#     back to the same heuristic estimator used elsewhere in this module.
#   - A malformed block/table/row never aborts the whole page-structure
#     extraction - it's skipped and logged, exactly like the rest of this
#     module.


def _extract_header_footer_text(container, doc: DocxDocumentType) -> str:
    """Plain-text (not HTML) rendition of a header/footer part, for the
    page-structure JSON's ``header`` field. Table rows are joined with
    " | " per row rather than dropped, so a tabular title block still
    reads sensibly as text instead of collapsing to nothing.
    """
    if container is None:
        return ""
    parts: list[str] = []
    try:
        for block in _iter_block_items_of(container, doc):
            try:
                if isinstance(block, Table):
                    for row in _safe_table_rows(block):
                        cells = _extract_row_cells(row)
                        row_text = " | ".join(c for c in cells if c)
                        if row_text:
                            parts.append(row_text)
                else:
                    text = block.text.strip()
                    if text:
                        parts.append(text)
            except Exception:
                continue
    except Exception:
        logger.warning("failed to extract header/footer plain text", exc_info=True)
    return "\n".join(parts)


def _extract_table_structure(
    table,
    table_index: int,
    page_num: int,
) -> dict[str, Any]:
    """Structured (non-HTML) representation of one table for the
    page-structure contract: rows of cells, each cell carrying its text,
    rowspan/colspan, border presence, column-width percentage, and
    whether it looks like an editable form value.

    Never drops empty cells (an empty cell is frequently the editable
    value location in a form) and never flattens the table into plain
    text. Walks the raw `tbl.tr_lst`/`tc.tcPr` XML directly - the same
    technique `_render_table` uses - so it inherits immunity to the
    grid/merge-mismatch IndexError that `_safe_row_cells` exists to work
    around elsewhere in this module.

    Note: this preserves rowspan/colspan from explicit `vMerge`/
    `gridSpan` markup. It does not additionally synthesize a rowspan for
    the "fake merge via hidden borders" pattern that `_render_table`
    detects purely for pixel-perfect HTML rendering - that heuristic is
    an HTML-rendering nicety, not part of the document's actual
    structure, so it's intentionally left out of this structural
    extraction.
    """
    try:
        tbl = table._tbl
        grid_cols = list(tbl.tblGrid.gridCol_lst) if tbl.tblGrid is not None else []
        col_widths_twips = [int(gc.get(qn('w:w')) or 0) for gc in grid_cols]
        total_width = sum(col_widths_twips) or 1
        col_widths_pct = [w / total_width * 100 for w in col_widths_twips]

        open_vmerge: dict[int, dict] = {}
        rows_out: list[list[dict[str, Any]]] = []

        for row_index, tr in enumerate(tbl.tr_lst):
            row_cells: list[dict[str, Any]] = []
            col_idx = 0
            for tc in tr.tc_lst:
                try:
                    tcPr = tc.tcPr
                    gs = tcPr.find(qn('w:gridSpan')) if tcPr is not None else None
                    colspan = int(gs.get(qn('w:val'))) if gs is not None else 1
                    vm = tcPr.find(qn('w:vMerge')) if tcPr is not None else None
                    vm_val = vm.get(qn('w:val')) if vm is not None else None

                    if vm is not None and vm_val != 'restart':
                        owner = open_vmerge.get(col_idx)
                        if owner is not None:
                            owner['rowspan'] += 1
                        col_idx += max(colspan, 1)
                        continue

                    cell = _Cell(tc, table)
                    cell_text = _extract_cell_text(cell)  # kept even if empty - never dropped
                    has_border = _cell_border_css(tc) != ""

                    match = _candidate_field_match(cell_text)
                    is_weak_match = bool(match and match.re is _LABEL_ONLY_RE)
                    field_id = None
                    if match and not is_weak_match:
                        value = (match.groupdict().get("value") or "").strip()
                        label = match.group("label").strip()
                        field_id = _make_table_field_id(label, table_index, row_index, col_idx)

                    width_pct = None
                    if col_widths_pct and col_idx < len(col_widths_pct):
                        width_pct = round(sum(col_widths_pct[col_idx: col_idx + colspan]), 2)

                    record = {
                        "row": row_index,
                        "col": col_idx,
                        "rowspan": 1,
                        "colspan": colspan,
                        "text": cell_text,
                        "has_border": has_border,
                        "width_pct": width_pct,
                        "is_editable": field_id is not None,
                        "field_id": field_id,
                        "page_number": page_num,
                    }
                    if vm is not None and vm_val == 'restart':
                        open_vmerge[col_idx] = record
                    else:
                        open_vmerge.pop(col_idx, None)

                    row_cells.append(record)
                    col_idx += max(colspan, 1)
                except Exception:
                    logger.warning(
                        "failed to extract one cell in table %s row %s; skipping it",
                        table_index, row_index, exc_info=True,
                    )
                    col_idx += 1
                    continue
            rows_out.append(row_cells)

        return {
            "table_index": table_index,
            "page_number": page_num,
            "row_count": len(rows_out),
            "col_count": len(grid_cols) or (max((len(r) for r in rows_out), default=0)),
            "rows": rows_out,
        }
    except Exception:
        logger.warning("failed to extract structure for table %s; returning empty table", table_index, exc_info=True)
        return {
            "table_index": table_index,
            "page_number": page_num,
            "row_count": 0,
            "col_count": 0,
            "rows": [],
        }


def extract_page_structure(source_path: Path) -> list[dict[str, Any]]:
    """Parse a .doc/.docx into the per-page structured contract:

        {
          "page_number": 1,
          "header": "...",
          "paragraphs": [...],
          "tables": [...],
          "forms": [...],
          "images": [...],
          "text": "...",
        }

    Rules followed (see module-level comment above for the full
    rationale):
      - Paragraphs are kept as complete blocks - a multi-line paragraph
        in the source is one entry in `paragraphs`, never split per
        visual line.
      - Tables are never flattened to text and never lose empty cells;
        see `_extract_table_structure`.
      - "forms" holds label/value pairs found OUTSIDE of tables (e.g. a
        bare "Label: value" or "Label ____" paragraph line) - these are
        the dynamic form-field-style values a reviewer would edit,
        kept separate from ordinary narrative `paragraphs`.
      - `header` is the document's repeating header/footer title-block
        text (kept distinct from page content, never merged into
        `paragraphs`), using the first-page header/footer when the
        document defines one, and the default header/footer otherwise.
      - Page 1 gets no special-cased content mangling here - whatever is
        actually on page 1 is reported as-is; page 1 is only visually/
        structurally distinct because it's whatever content genuinely
        lives there (typically a cover/title block with few or no body
        paragraphs).
      - The real page a block lives on is used whenever a PDF render is
        available; otherwise the same heuristic estimator used by
        `infer_schema_sections_with_page_count` is used, so page numbers
        are always populated (never null/omitted).
      - One malformed block, table, or row is skipped (logged) rather
        than aborting extraction for the rest of the document - matching
        every other function in this module.
    """
    target_path = source_path
    if source_path.suffix.lower() == ".doc":
        try:
            target_path = _convert_doc_to_docx(source_path)
        except Exception as exc:
            raise ValueError(f"Could not convert .doc file to .docx: {exc}") from exc

    try:
        doc = docx.Document(str(target_path))
    except Exception as exc:
        raise ValueError(f"Could not open document: {exc}") from exc

    page_texts: list[str] = []
    pdf_path: Path | None = None
    try:
        pdf_path = _docx_to_pdf(target_path)
        page_texts = _pdf_page_texts(pdf_path)
    except Exception as exc:
        logger.warning("Could not render %s to PDF for page-accurate structure extraction", target_path, exc_info=True)
    finally:
        if pdf_path is not None:
            try:
                pdf_path.unlink()
            except Exception:
                pass

    locator = _PageLocator(page_texts)
    have_real_pages = bool(page_texts)
    text_content_paragraphs = [p for p in doc.paragraphs if p.text.strip()]
    estimated_total_pages = len(page_texts) if have_real_pages else _count_document_pages(doc)
    page_boundaries = _detect_page_boundaries_heuristic(doc, estimated_total_pages)
    paragraphs_per_page = None if page_boundaries else max(1, len(text_content_paragraphs) // max(1, estimated_total_pages))
    total_block_count = len(list(_iter_block_items(doc)))

    # header/footer text - rendered once, applied to every page (first-page
    # variant on page 1 if the document defines one), never merged into
    # per-page paragraphs.
    header_text_first = ""
    header_text_default = ""
    try:
        section = doc.sections[0] if doc.sections else None
        if section is not None:
            uses_first_page = bool(section.different_first_page_header_footer)
            header_text_default = _extract_header_footer_text(section.header, doc)
            header_text_first = (
                _extract_header_footer_text(section.first_page_header, doc)
                if uses_first_page else header_text_default
            )
    except Exception:
        logger.warning("could not extract document header text", exc_info=True)

    pages: dict[int, dict[str, Any]] = {}

    def _get_page(page_num: int) -> dict[str, Any]:
        page_num = max(1, page_num)
        if page_num not in pages:
            pages[page_num] = {
                "page_number": page_num,
                "header": header_text_first if page_num == 1 else header_text_default,
                "paragraphs": [],
                "tables": [],
                "forms": [],
                "images": [],
                "text": "",
            }
        return pages[page_num]

    current_page = 1
    table_index_counter = 0
    for block_index, block in enumerate(_iter_block_items(doc)):
        try:
            if isinstance(block, Table):
                table_index_counter += 1
                if not have_real_pages:
                    current_page = _estimate_page_from_position(
                        block_index, total_block_count, page_boundaries, paragraphs_per_page, estimated_total_pages,
                    )
                page_entry = _get_page(current_page)
                table_struct = _extract_table_structure(block, table_index_counter, current_page)
                page_entry["tables"].append(table_struct)  # never flattened, never dropped
                continue

            paragraph = block
            text = paragraph.text.strip()
            if not text:
                continue

            if have_real_pages:
                current_page = locator.locate(text, current_page)
            else:
                current_page = _estimate_page_from_position(
                    block_index, total_block_count, page_boundaries, paragraphs_per_page, estimated_total_pages,
                )

            page_entry = _get_page(current_page)

            match = _candidate_field_match(text)
            if match and not _looks_like_heading(paragraph):
                # A "Label: value" / "Label ____" line outside a table -
                # this is a form-style dynamic field, kept separate from
                # ordinary narrative paragraphs.
                value = (match.groupdict().get("value") or "").strip()
                label = match.group("label").strip()
                page_entry["forms"].append({
                    "label": label,
                    "value": value,
                    "is_editable": True,
                    "field_id": f"{_slugify(label)}_p{block_index}",
                    "page_number": current_page,
                })
            else:
                # Whole paragraph, never split line-by-line.
                page_entry["paragraphs"].append({
                    "text": text,
                    "is_heading": _looks_like_heading(paragraph),
                })
        except Exception:
            logger.exception(
                "Failed to process block %s while extracting page structure; skipping it and continuing",
                block_index,
            )
            continue

    if not pages:
        pages[1] = _get_page(1)

    # Fill "text" per page: prefer the real PDF-extracted page text
    # (ground truth for what's actually on that rendered page) and fall
    # back to concatenating whatever paragraphs/table cell text we
    # attributed to that page ourselves.
    ordered_page_nums = sorted(pages.keys())
    for page_num in ordered_page_nums:
        page_entry = pages[page_num]
        if have_real_pages and 1 <= page_num <= len(page_texts):
            page_entry["text"] = page_texts[page_num - 1]
        else:
            parts = [p["text"] for p in page_entry["paragraphs"]]
            for t in page_entry["tables"]:
                for row in t["rows"]:
                    row_text = " | ".join(c["text"] for c in row if c["text"])
                    if row_text:
                        parts.append(row_text)
            for f in page_entry["forms"]:
                parts.append(f"{f['label']}: {f['value']}")
            page_entry["text"] = "\n".join(parts)

    # Ensure every page number up to the estimated/known total is present
    # (a page with, e.g., only an image or nothing extractable should
    # still appear in the output rather than being silently omitted).
    final_total_pages = len(page_texts) if have_real_pages else estimated_total_pages
    result = [_get_page(p) for p in range(1, max(final_total_pages, max(ordered_page_nums, default=1)) + 1)]
    return result