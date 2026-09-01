"""
Template structure validation and integrity checking.

Ensures that locked templates maintain their structure while allowing
only field value modifications.
"""
from typing import Any
from app.db.models import Template


class TemplateStructureValidator:
    """Validates template structure integrity for locked templates."""

    @staticmethod
    def get_structure_signature(schema: dict[str, Any]) -> str:
        """
        Generate a structure signature for a template schema.
        
        This captures only the structural elements (sections, field IDs, labels, types)
        and excludes values and optional metadata. Used to detect unauthorized structural changes.
        """
        sections = schema.get("sections", [])
        signature_parts = []
        
        for section in sections:
            section_id = section.get("section_id", "")
            section_name = section.get("section_name", "")
            section_part = f"SECTION:{section_id}:{section_name}"
            signature_parts.append(section_part)
            
            fields = section.get("fields", [])
            for field in fields:
                field_id = field.get("field_id", "")
                field_label = field.get("field_label", "")
                data_type = field.get("data_type", "")
                required = field.get("required", False)
                field_part = f"FIELD:{field_id}:{field_label}:{data_type}:{required}"
                signature_parts.append(field_part)
        
        return "|".join(signature_parts)

    @staticmethod
    def get_original_structure_signature(template: Template) -> str:
        """Get structure signature from the template's stored schema."""
        return TemplateStructureValidator.get_structure_signature(template.schema)  # type: ignore[arg-type]

    @staticmethod
    def validate_structure_unchanged(template: Template, new_schema: dict[str, Any]) -> bool:
        """
        Check if template structure is unchanged between current and new schema.
        
        Returns True if structure is unchanged, False if modifications detected.
        Only relevant for locked templates.
        """
        if not template.structure_locked:
            return True  # Unlocked templates can be modified freely
        
        original_sig = TemplateStructureValidator.get_original_structure_signature(template)
        new_sig = TemplateStructureValidator.get_structure_signature(new_schema)
        
        return original_sig == new_sig

    @staticmethod
    def validate_section_count(template: Template, new_schema: dict[str, Any]) -> bool:
        """Ensure number of sections hasn't changed in locked template."""
        if not template.structure_locked:
            return True
        
        original_sections = len(template.schema.get("sections", []))
        new_sections = len(new_schema.get("sections", []))
        return original_sections == new_sections

    @staticmethod
    def validate_field_count_per_section(template: Template, new_schema: dict[str, Any]) -> bool:
        """Ensure field count per section hasn't changed in locked template."""
        if not template.structure_locked:
            return True
        
        original_sections = {
            s.get("section_id"): len(s.get("fields", []))
            for s in template.schema.get("sections", [])
        }
        
        new_sections = {
            s.get("section_id"): len(s.get("fields", []))
            for s in new_schema.get("sections", [])
        }
        
        return original_sections == new_sections

    @staticmethod
    def validate_locked_template(template: Template, new_schema: dict[str, Any]) -> tuple[bool, str]:
        """
        Comprehensive validation for locked templates.
        
        Returns: (is_valid, error_message)
        """
        if not template.structure_locked:
            return True, ""
        
        # Check structure signature
        if not TemplateStructureValidator.validate_structure_unchanged(template, new_schema):
            return False, "Template structure is locked and cannot be modified. Only field values can be changed."
        
        # Check section count
        if not TemplateStructureValidator.validate_section_count(template, new_schema):
            return False, "Cannot add or remove sections from a locked template."
        
        # Check field count
        if not TemplateStructureValidator.validate_field_count_per_section(template, new_schema):
            return False, "Cannot add or remove fields from a locked template section."
        
        return True, ""

    @staticmethod
    def lock_template_structure(template: Template) -> None:
        """Mark a template's structure as locked (immutable)."""
        template.structure_locked = True  # type: ignore[assignment]

    @staticmethod
    def unlock_template_structure(template: Template) -> None:
        """Mark a template's structure as unlocked (mutable)."""
        template.structure_locked = False  # type: ignore[assignment]


# ---------------------------------------------------------------------------
# DocumentTemplateValidator
# ---------------------------------------------------------------------------

import re
from dataclasses import dataclass, field as dc_field
from pathlib import Path
from typing import Literal

try:
    from rapidfuzz import fuzz as _fuzz
    _HAS_RAPIDFUZZ = True
except ImportError:
    _HAS_RAPIDFUZZ = False

_FUZZY_THRESHOLD = 70  # lower than extraction (85) — we only need to confirm
                       # a section label exists somewhere, not extract a value


@dataclass
class StructuralValidationResult:
    """
    Result of a presence-based structural check.

    status:
        "MATCH"    — every expected section has at least one label hit.
        "REVIEW"   — section headings found but some individual fields are
                     missing (normal for documents with extra/renamed fields).
        "MISMATCH" — one or more whole sections have zero label hits
                     (document is likely a different specification).
    details:
        Human-readable list of what was missing / suspect.
    """
    status: Literal["MATCH", "REVIEW", "MISMATCH"]
    details: list[str] = dc_field(default_factory=list)


def _any_pattern_in_corpus(patterns: list[str], corpus: str, threshold: int = _FUZZY_THRESHOLD) -> bool:
    """
    Return True if any of *patterns* appears (exactly or fuzzily) in *corpus*.

    Exact check: case-insensitive substring.
    Fuzzy check: rapidfuzz WRatio on each 150-char sliding window of *corpus*.
    """
    corpus_lower = corpus.lower()
    for p in patterns:
        # Fast exact check first
        if p.lower() in corpus_lower:
            return True
    if not _HAS_RAPIDFUZZ:
        return False
    # Fuzzy: slide a window over the corpus to avoid comparing the full page
    # text against short patterns (which would always score very low in WRatio)
    for p in patterns:
        p_len = len(p)
        window_size = max(p_len + 20, 60)
        for start in range(0, len(corpus), max(1, window_size // 2)):
            window = corpus[start:start + window_size]
            if _fuzz.partial_ratio(p.lower(), window.lower()) >= threshold:
                return True
    return False


class DocumentTemplateValidator:
    """
    Presence-based structural check: does the source document contain the
    expected content, regardless of page order or layout?

    All checks are presence-based — order and page position are NOT checked.
    This means a document with sections in a different order still passes as
    MATCH, which is intentional (different project revisions legitimately
    reorder sections).

    Usage::
        result = DocumentTemplateValidator.validate_pre_extraction(schema, pages)
        # result.status in {"MATCH", "REVIEW", "MISMATCH"}

        result = DocumentTemplateValidator.validate_pre_download(schema, docx_path)
    """

    @staticmethod
    def validate_pre_extraction(
        schema: dict[str, Any],
        pages: list[dict[str, Any]],
    ) -> StructuralValidationResult:
        """
        Scan all page text for the presence of each section's expected labels.

        Called immediately after document parse, before DeterministicExtractor
        runs.  Fast: pure string comparison on already-extracted page text.

        Parameters
        ----------
        schema:
            Parsed template schema dict.
        pages:
            List of {"page_number": int, "text": str} dicts (one per page).
        """
        # Build a single corpus string from all page text
        corpus = "\n".join(p.get("text") or "" for p in pages)
        return DocumentTemplateValidator._check_schema_against_corpus(schema, corpus)

    @staticmethod
    def validate_pre_download(
        schema: dict[str, Any],
        output_docx_path: Path,
    ) -> StructuralValidationResult:
        """
        Same presence check on the generated output docx before download.

        Extracts plain text from the docx (no PDF conversion needed — we just
        need the text to verify labels are present) and runs the same check.
        """
        try:
            from docx import Document as DocxDocument
            doc = DocxDocument(str(output_docx_path))
            paragraphs = [p.text for p in doc.paragraphs]
            # Also grab table cell text
            for table in doc.tables:
                for row in table.rows:
                    for cell in row.cells:
                        paragraphs.append(cell.text)
            corpus = "\n".join(paragraphs)
        except Exception as exc:
            return StructuralValidationResult(
                status="REVIEW",
                details=[f"Could not read generated docx for validation: {exc}"],
            )
        return DocumentTemplateValidator._check_schema_against_corpus(schema, corpus)

    @staticmethod
    def _check_schema_against_corpus(
        schema: dict[str, Any],
        corpus: str,
    ) -> StructuralValidationResult:
        """
        Core comparison logic: for each section in the schema, check whether
        at least one of the section's field labels (or the section name itself)
        appears anywhere in *corpus*.
        """
        missing_sections: list[str] = []
        partial_sections: list[str] = []

        for section in schema.get("sections", []):
            section_name: str = section.get("section_name", "")
            section_id: str = section.get("section_id", "")
            is_table = section.get("field_type") == "table"

            if is_table:
                # For table sections: check that at least one expected row
                # label appears somewhere in the document
                rows = section.get("rows", [])
                row_labels = [
                    r["values"][0]
                    for r in rows
                    if r.get("values") and r["values"][0]
                ]
                if not row_labels:
                    continue  # Nothing to check for empty tables
                found_any = any(
                    _any_pattern_in_corpus([lbl], corpus)
                    for lbl in row_labels
                )
                if not found_any:
                    missing_sections.append(
                        f"Table section '{section_name}' (id={section_id}): "
                        f"no expected row labels found in document"
                    )
                continue

            # Text section: check field labels
            fields = section.get("fields", [])
            if not fields:
                continue

            found_count = 0
            for fld in fields:
                patterns: list[str] = fld.get("label_patterns") or [fld.get("field_label", "")]
                if _any_pattern_in_corpus(patterns, corpus):
                    found_count += 1

            if found_count == 0:
                missing_sections.append(
                    f"Section '{section_name}' (id={section_id}): "
                    f"none of its {len(fields)} field labels found in document"
                )
            elif found_count < len(fields) * 0.5:
                # Less than half the fields found — flag as partial
                partial_sections.append(
                    f"Section '{section_name}' (id={section_id}): "
                    f"only {found_count}/{len(fields)} field labels found"
                )

        if missing_sections:
            return StructuralValidationResult(
                status="MISMATCH",
                details=missing_sections + partial_sections,
            )
        if partial_sections:
            return StructuralValidationResult(
                status="REVIEW",
                details=partial_sections,
            )
        return StructuralValidationResult(status="MATCH", details=[])
