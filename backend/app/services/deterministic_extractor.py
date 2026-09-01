"""
DeterministicExtractor
======================
Replaces the Qwen2.5-VL / ModelService extraction pipeline with a purely
deterministic, millisecond-speed label matcher.  No model, no network I/O.

Algorithm
---------
Text fields  (every dynamic field in a non-table section):
  1. Exact match  — compiled (pattern1|pattern2|...)\\s*[:\\-]\\s*(.+) regex,
                    IGNORECASE, scanned over every line of every page.
                    First hit wins.  confidence = 1.0
  2. Fuzzy match  — rapidfuzz.fuzz.WRatio ≥ 85 on the portion of each line
                    before the first ':' or '-'.  Best score wins across all
                    pages.  confidence = score / 100.0  (naturally 0.70–0.94)
  3. No match     — value = None, confidence = 0.0

Table fields  (sections with field_type == "table"):
  Each row in the schema has a "values" list; values[0] is the row label.
  The extractor scans every parsed table row (tab-separated, from
  table_rows_by_page) across all pages and fuzzy-matches the row label
  against the first cell.  On a hit it takes the remaining cells as values.
  confidence = 1.0 on exact / fuzzy score on fuzzy / 0.0 on miss.

Output per field (matches the shape _store_extracted_fields already expects):
  {
      "field_id":   str,
      "field_name": str,            # the canonical field_label from schema
      "value":      str | None,
      "confidence": float,
      "source": {
          "page_number": int | None,
          "source_text": str | None,   # exact matched line / cell text
          "confidence": float
      }
  }
"""

from __future__ import annotations

import logging
import re
from typing import Any

try:
    from rapidfuzz import fuzz as _fuzz
    _HAS_RAPIDFUZZ = True
except ImportError:  # pragma: no cover – graceful degradation during unit tests
    _HAS_RAPIDFUZZ = False

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
FUZZY_THRESHOLD = 85          # WRatio score (0-100) required for a fuzzy hit
CONFIDENCE_EXACT = 1.0
CONFIDENCE_FUZZY_MAX = 0.94   # cap so fuzzy never claims 1.0
CONFIDENCE_FUZZY_MIN = 0.70   # floor so anything below threshold is 0
CONFIDENCE_NONE = 0.0

# Pre-compiled splitter: first ':' or ' -' (with a space before the dash
# to avoid splitting on hyphenated words like "Star-delta")
_LABEL_VALUE_SPLIT = re.compile(r"(?::\s*| - )(.*)", re.DOTALL)


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _build_label_regex(patterns: list[str]) -> re.Pattern[str]:
    """
    Build a single compiled regex that matches any of the *patterns*
    immediately followed by an optional colon or dash separator, then
    captures the rest of the line as the value.

    Input patterns are literal strings; we re.escape them so special
    characters in engineering labels (brackets, slashes, '&', etc.) are
    matched verbatim.
    """
    escaped = [re.escape(p) for p in patterns]
    combined = "|".join(escaped)
    # The separator can be: ' :' / ': ' / ':' / ' - ' (colon variants most
    # common in the engineering spec format "Label : Value")
    pattern = rf"(?:{combined})\s*[:\-]\s*(.+)"
    return re.compile(pattern, re.IGNORECASE)


def _extract_line_label(line: str) -> str:
    """
    Return the portion of *line* before the first ':' or ' - ', stripped.
    Used as the candidate label in fuzzy matching.
    """
    m = re.split(r"\s*[:\-]\s*", line, maxsplit=1)
    return m[0].strip() if m else line.strip()


def _extract_line_value(line: str) -> str | None:
    """
    Return the portion of *line* after the first ':' or ' - ', stripped.
    Returns None if no separator is found.
    """
    m = _LABEL_VALUE_SPLIT.search(line)
    if m:
        v = m.group(1).strip()
        return v if v else None
    return None


def _fuzzy_score(candidate: str, patterns: list[str]) -> float:
    """
    Return the best WRatio score (0–100) of *candidate* against any of
    *patterns*.  Returns 0 if rapidfuzz is unavailable.
    """
    if not _HAS_RAPIDFUZZ or not patterns:
        return 0.0
    best = max(_fuzz.WRatio(candidate, p) for p in patterns)
    return float(best)


# ---------------------------------------------------------------------------
# Core extraction methods
# ---------------------------------------------------------------------------

def _scan_text_field(
    field: dict[str, Any],
    pages: list[dict[str, Any]],
) -> dict[str, Any]:
    """
    Scan every line of every page for *field*.

    Returns a result dict with value / confidence / source filled in.
    """
    field_id = field["field_id"]
    field_label = field["field_label"]
    patterns: list[str] = field.get("label_patterns") or [field_label]

    # Build exact-match regex once per field
    exact_re = _build_label_regex(patterns)

    # Pass 1 — exact regex match
    for page in pages:
        page_num = page.get("page_number", 0)
        text = page.get("text") or ""
        for line in text.splitlines():
            line = line.strip()
            if not line:
                continue
            m = exact_re.match(line)
            if m:
                value = m.group(1).strip()
                if value:
                    return {
                        "field_id": field_id,
                        "field_name": field_label,
                        "value": value,
                        "confidence": CONFIDENCE_EXACT,
                        "source": {
                            "page_number": page_num,
                            "source_text": line,
                            "confidence": CONFIDENCE_EXACT,
                        },
                    }

    # Pass 2 — fuzzy match (best across all pages)
    if not _HAS_RAPIDFUZZ:
        logger.debug("rapidfuzz not available; skipping fuzzy pass for %s", field_id)
    else:
        best_score = 0.0
        best_value: str | None = None
        best_line: str | None = None
        best_page: int | None = None

        for page in pages:
            page_num = page.get("page_number", 0)
            text = page.get("text") or ""
            for line in text.splitlines():
                line = line.strip()
                if not line or ":" not in line and " - " not in line:
                    continue
                candidate_label = _extract_line_label(line)
                if len(candidate_label) < 3:
                    continue
                score = _fuzzy_score(candidate_label, patterns)
                if score >= FUZZY_THRESHOLD and score > best_score:
                    value = _extract_line_value(line)
                    if value:
                        best_score = score
                        best_value = value
                        best_line = line
                        best_page = page_num

        if best_value is not None:
            # Map the raw score (85–100) onto CONFIDENCE_FUZZY_MIN–CONFIDENCE_FUZZY_MAX
            normalised = CONFIDENCE_FUZZY_MIN + (
                (best_score - FUZZY_THRESHOLD) / (100.0 - FUZZY_THRESHOLD)
            ) * (CONFIDENCE_FUZZY_MAX - CONFIDENCE_FUZZY_MIN)
            normalised = round(min(CONFIDENCE_FUZZY_MAX, max(CONFIDENCE_FUZZY_MIN, normalised)), 4)
            return {
                "field_id": field_id,
                "field_name": field_label,
                "value": best_value,
                "confidence": normalised,
                "source": {
                    "page_number": best_page,
                    "source_text": best_line,
                    "confidence": normalised,
                },
            }

    # No match
    return {
        "field_id": field_id,
        "field_name": field_label,
        "value": None,
        "confidence": CONFIDENCE_NONE,
        "source": {"page_number": None, "source_text": None, "confidence": CONFIDENCE_NONE},
    }


def _scan_table_section(
    section: dict[str, Any],
    table_rows_by_page: dict[int, list[str]],
) -> list[dict[str, Any]]:
    """
    Content-anchored table extraction.

    The schema's ``rows`` list declares the expected rows; each row's
    first value (values[0]) is the row label that the matcher will look
    for in the first cell of any parsed table row across all pages.

    Returns one result dict per schema column per matched row.  Unmatched
    rows produce None values.

    Table sections are identified by ``section.get("field_type") == "table"``.
    The result field_id follows the pattern ``{section_id}_{row_id}_{col_idx}``.
    """
    section_id = section.get("section_id", "unknown_table")
    columns: list[str] = section.get("columns", [])
    schema_rows: list[dict] = section.get("rows", [])

    results: list[dict[str, Any]] = []

    # Flatten all parsed table rows from every page into a single lookup list
    # Each entry: (page_num, cells: list[str])
    all_parsed_rows: list[tuple[int, list[str]]] = []
    for page_num, rows in sorted(table_rows_by_page.items()):
        for row_text in rows:
            cells = [c.strip() for c in row_text.split("\t") if c.strip()]
            if cells:
                all_parsed_rows.append((page_num, cells))

    for schema_row in schema_rows:
        row_id = schema_row.get("row_id", "")
        row_values: list[str | None] = schema_row.get("values", [])
        if not row_values:
            continue

        # The first value in the schema row is the row label to match against
        row_label = row_values[0]
        row_label_patterns = [row_label] if row_label else []

        # Exact match first
        matched_cells: list[str] | None = None
        matched_page: int | None = None
        matched_row_text: str | None = None
        matched_confidence = CONFIDENCE_NONE

        # Build exact regex for the row label
        if row_label:
            row_re = re.compile(re.escape(row_label), re.IGNORECASE)
        else:
            row_re = None

        for page_num, cells in all_parsed_rows:
            first_cell = cells[0] if cells else ""
            if row_re and row_re.fullmatch(first_cell.strip()):
                matched_cells = cells
                matched_page = page_num
                matched_row_text = "\t".join(cells)
                matched_confidence = CONFIDENCE_EXACT
                break

        # Fuzzy fallback
        if matched_cells is None and _HAS_RAPIDFUZZ and row_label:
            best_score = 0.0
            for page_num, cells in all_parsed_rows:
                first_cell = cells[0] if cells else ""
                score = _fuzz.WRatio(first_cell.strip(), row_label)
                if score >= FUZZY_THRESHOLD and score > best_score:
                    best_score = score
                    matched_cells = cells
                    matched_page = page_num
                    matched_row_text = "\t".join(cells)
                    normalised = CONFIDENCE_FUZZY_MIN + (
                        (best_score - FUZZY_THRESHOLD) / (100.0 - FUZZY_THRESHOLD)
                    ) * (CONFIDENCE_FUZZY_MAX - CONFIDENCE_FUZZY_MIN)
                    matched_confidence = round(
                        min(CONFIDENCE_FUZZY_MAX, max(CONFIDENCE_FUZZY_MIN, normalised)), 4
                    )

        # Emit one result per column (skip col 0 — that's the row label)
        for col_idx, col_name in enumerate(columns):
            field_id = f"{section_id}__{row_id}__col{col_idx}"
            if matched_cells is not None and col_idx < len(matched_cells):
                value = matched_cells[col_idx] or None
            else:
                value = None
            confidence = matched_confidence if value is not None else CONFIDENCE_NONE
            results.append({
                "field_id": field_id,
                "field_name": f"{col_name} (row: {row_label})",
                "value": value,
                "confidence": confidence,
                "source": {
                    "page_number": matched_page if value is not None else None,
                    "source_text": matched_row_text if value is not None else None,
                    "confidence": confidence,
                },
                # Extra metadata so callers can identify this as a table cell
                "_table_meta": {
                    "section_id": section_id,
                    "row_id": row_id,
                    "col_idx": col_idx,
                    "col_name": col_name,
                },
            })

    return results


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

class DeterministicExtractor:
    """
    Public entry point.  Instantiate once per extraction job; call
    ``extract(schema, pages, table_rows_by_page)``.
    """

    def extract(
        self,
        schema: dict[str, Any],
        pages: list[dict[str, Any]],
        table_rows_by_page: dict[int, list[str]],
    ) -> dict[str, Any]:
        """
        Run deterministic extraction over the entire document.

        Parameters
        ----------
        schema:
            The parsed template schema dict (loaded from schema.json).
        pages:
            List of page dicts: [{"page_number": int, "text": str}, ...]
        table_rows_by_page:
            Dict mapping page_number → list of tab-separated table row strings,
            as produced by document_service._extract_docx_pages and stored in
            DocumentPage.text with the ``[TABLE ROW]`` prefix stripped by
            ExtractionService._load_table_rows().

        Returns
        -------
        dict matching the shape that _store_extracted_fields already consumes:
            {
                "template_id":      str,
                "template_version": str,
                "fields":           list[field_result_dict],
            }
        """
        all_fields: list[dict[str, Any]] = []

        for section in schema.get("sections", []):
            is_table = section.get("field_type") == "table"

            if is_table:
                # Content-anchored table row scan
                table_results = _scan_table_section(section, table_rows_by_page)
                all_fields.extend(table_results)
            else:
                # Whole-document label scan for each text field
                for field in section.get("fields", []):
                    if not field.get("is_dynamic", True):
                        # Static (non-dynamic) fields are seeded separately;
                        # don't extract them.
                        continue
                    result = _scan_text_field(field, pages)
                    all_fields.append(result)

        logger.info(
            "DeterministicExtractor: %d fields processed (%d pages, %d table rows)",
            len(all_fields),
            len(pages),
            sum(len(v) for v in table_rows_by_page.values()),
        )

        return {
            "template_id": schema.get("template_id"),
            "template_version": schema.get("version"),
            "fields": all_fields,
        }
