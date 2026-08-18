"""Page-by-page template analysis with Ollama validation.

This service orchestrates the workflow of analyzing an uploaded template page by page,
extracting field structure from each page, validating extracted values with Ollama,
and collecting user feedback before finalizing the master template.
"""
import html as html_lib
import json
import logging
import re
from typing import Optional, Any
from pathlib import Path
from sqlalchemy.orm import Session

from app.db.models import Template
from app.services.model import ModelService
from app.core.config import settings
from app.services.schema_inference import extract_deterministic_page_data, compare_page_to_source
from app.services.template_service import TemplateService

logger = logging.getLogger(__name__)


def build_page_text_from_fields(fields: list[dict[str, Any]]) -> str:
    """Reconstruct page prose from detected field labels and values.

    This preserves the labels the HTML stripping step would otherwise erase,
    which is critical when a page has structured text like "Project Name: ..."
    or "Document Number: ..." but the raw HTML is mostly empty containers.
    """
    if not fields:
        return ""

    lines: list[str] = []
    for field in fields:
        label = (
            field.get("field_label")
            or field.get("label")
            or field.get("field_name")
            or field.get("name")
            or "Unknown field"
        )
        value = field.get("value")
        if value is None:
            value = field.get("field_value") or field.get("default_value") or ""
        if isinstance(value, (dict, list)):
            value = json.dumps(value, ensure_ascii=False)
        value = str(value).strip() if value is not None else ""
        if value:
            lines.append(f"{label}: {value}")
        else:
            lines.append(label)

    return "\n".join(lines).strip()


class PageAnalysisService:
    """Orchestrate page-by-page template analysis and validation."""

    def __init__(self, db: Session):
        self.db = db
        self.model_service = ModelService()
        self.pending_storage_path = Path(settings.STORAGE_PATH) / "pending_templates"

    def analyze_page_structure(
        self,
        template_id: int,
        page_number: int,
        page_image_url: str,
        extracted_fields: list[dict[str, Any]],
    ) -> dict[str, Any]:
        """
        Analyze a single page's structure and return extracted fields with confidence scores.

        Args:
            template_id: ID of the pending template
            page_number: Page number (1-indexed)
            page_image_url: URL to the page image
            extracted_fields: Auto-extracted fields from the page

        Returns:
            Dict containing:
            - page_number: int
            - total_pages: int
            - fields: list of extracted fields with confidence scores
            - structure_summary: Human-readable description of page structure
            - validation_status: 'pending', 'validated', or 'needs_review'
        """
        template = self.db.query(Template).filter_by(id=template_id).first()
        if not template:
            raise ValueError(f"Template {template_id} not found")

        schema = template.schema or {}
        page_images = schema.get("page_images", [])
        total_pages = len(page_images)

        # Build structure summary from the extracted fields
        structure_summary = self._build_structure_summary(extracted_fields)

        return {
            "page_number": page_number,
            "total_pages": total_pages,
            "page_image_url": page_image_url,
            "fields": extracted_fields,
            "structure_summary": structure_summary,
            "validation_status": "pending",
            "user_validated": False,
        }

    def validate_page_with_ollama(
        self,
        template_id: int,
        page_number: int,
        page_text: str,
        extracted_fields: list[dict[str, Any]],
    ) -> dict[str, Any]:
        """
        Use Ollama to validate and extract field values from page text.

        Args:
            template_id: ID of the pending template
            page_number: Page number (1-indexed)
            page_text: OCR or extracted text from the page
            extracted_fields: Fields to validate/extract

        Returns:
            Dict containing:
            - page_number: int
            - validated_fields: Fields with Ollama-extracted values and confidence scores
            - suggestions: Ollama suggestions for fields that weren't found
            - needs_user_review: bool indicating if human review is recommended
        """
        template = self.db.query(Template).filter_by(id=template_id).first()
        if not template:
            raise ValueError(f"Template {template_id} not found")

        schema = template.schema or {}
        fallback_page_text = build_page_text_from_fields(extracted_fields)
        normalized_page_text = page_text.strip() if isinstance(page_text, str) else ""
        if not normalized_page_text and fallback_page_text:
            page_text = fallback_page_text
        elif normalized_page_text and fallback_page_text and len(normalized_page_text) < len(fallback_page_text):
            page_text = fallback_page_text

        deterministic_extraction = extract_deterministic_page_data(page_text)
        source_preview = (schema.get("text_preview") or page_text or "")
        page_fidelity = compare_page_to_source(source_preview, page_text)

        # Prepare the validation prompt for Ollama
        prompt = self._build_validation_prompt(extracted_fields, page_text, schema, page_number)

        # Call Ollama for field value extraction and validation
        try:
            if not self.model_service.is_available():
                logger.warning("Ollama model not available for validation")
                return {
                    "page_number": page_number,
                    "validated_fields": extracted_fields,
                    "suggestions": [],
                    "needs_user_review": True,
                    "error": "Model not available - manual review required",
                    "deterministic_extraction": deterministic_extraction,
                    "page_fidelity": page_fidelity,
                }

            # Call the model for validation
            response = self.model_service.validate_and_extract(prompt)

            # Parse the response and extract validated fields
            validated_fields = self._parse_validation_response(response, extracted_fields)

            return {
                "page_number": page_number,
                "validated_fields": validated_fields,
                "suggestions": self._extract_suggestions(response),
                "needs_user_review": self._assess_confidence(validated_fields),
                "model_response": response.get("reasoning"),
                "deterministic_extraction": deterministic_extraction,
                "page_fidelity": page_fidelity,
            }
        except Exception as exc:
            logger.error(f"Ollama validation failed for page {page_number}: {exc}")
            return {
                "page_number": page_number,
                "validated_fields": extracted_fields,
                "suggestions": [],
                "needs_user_review": True,
                "error": str(exc),
                "deterministic_extraction": deterministic_extraction,
                "page_fidelity": page_fidelity,
            }

    def collect_user_validation(
        self,
        template_id: int,
        page_number: int,
        user_feedback: dict[str, Any],
    ) -> dict[str, Any]:
        """
        Record user validation/correction for a page's extracted fields.

        Args:
            template_id: ID of the pending template
            page_number: Page number (1-indexed)
            user_feedback: Dict with field corrections and approvals

        Returns:
            Dict with validation result and any conflicts
        """
        template = self.db.query(Template).filter_by(id=template_id).first()
        if not template:
            raise ValueError(f"Template {template_id} not found")

        # Store user feedback in the template's validation_log
        if not hasattr(template, "validation_log"):
            template.validation_log = {}
        if not isinstance(template.validation_log, dict):
            template.validation_log = {}

        if "pages" not in template.validation_log:
            template.validation_log["pages"] = {}

        template.validation_log["pages"][str(page_number)] = {
            "timestamp": json.dumps({"validated_at": str(__import__("datetime").datetime.utcnow())}),
            "feedback": user_feedback,
        }

        self.db.add(template)
        self.db.commit()

        return {
            "page_number": page_number,
            "status": "validated",
            "stored_feedback": len(user_feedback.get("corrections", {})),
        }

    def finalize_master_template(
        self,
        template_id: int,
        final_schema: dict[str, Any],
        validation_summary: dict[str, Any],
    ) -> dict[str, Any]:
        """
        Finalize the master template after all pages have been validated.

        Args:
            template_id: ID of the pending template
            final_schema: Finalized schema with all sections and fields
            validation_summary: Summary of validation across all pages

        Returns:
            Dict with finalization result

        NOTE: this used to set ``template.status = "pending_approval"``,
        but ``get_pending_template``/``list_pending_templates`` (which the
        Pending Templates screen and the approve endpoint both rely on)
        only ever match ``status == "pending"``. A finalized template
        immediately vanished from the pending list *and* could no longer
        be approved (approve_pending_template looks it up the same way),
        so it silently never became a real, usable master template.
        Page-by-page review already *is* the human approval step for this
        workflow, so finishing it now goes straight through the same
        activation path as a manual approve.
        """
        template = self.db.query(Template).filter_by(id=template_id).first()
        if not template:
            raise ValueError(f"Template {template_id} not found")

        # Merge onto the existing schema rather than overwriting it -
        # final_schema is built client-side from the pending template
        # response and may be missing keys (page_images, page_html,
        # document_sections, ...) that were only ever computed server-side.
        existing_schema = template.schema if isinstance(template.schema, dict) else {}
        merged_schema = {**existing_schema, **final_schema}
        for key in ("page_images", "page_html", "document_sections", "text_preview", "preview_html", "sections"):
            if not merged_schema.get(key) and existing_schema.get(key):
                merged_schema[key] = existing_schema[key]

        template.schema = merged_schema
        template.validation_complete = True
        self.db.add(template)
        self.db.commit()

        # Actually activate it as a master template (locks the final
        # template_id, sets is_active=True, status="active") instead of
        # leaving it stranded in an unreachable in-between status.
        result = TemplateService(self.db).approve_pending_template(template_id)

        return {
            "template_id": result.get("template_id", template_id),
            "status": "active",
            "pages_validated": validation_summary.get("total_pages_validated"),
            "fields_extracted": validation_summary.get("total_fields_extracted"),
            "confidence_average": validation_summary.get("average_confidence"),
        }

    def get_page_preview(
        self,
        template_id: int,
        page_number: int,
    ) -> dict[str, Any]:
        """Get preview data for a specific page during template review."""
        template = self.db.query(Template).filter_by(id=template_id).first()
        if not template:
            raise ValueError(f"Template {template_id} not found")

        schema = template.schema or {}
        page_images = schema.get("page_images") or []
        page_html_list = schema.get("page_html") or []
        total_pages = max(len(page_images), len(page_html_list), int(schema.get("page_count") or 1), 1)

        if page_number < 1:
            raise ValueError(f"Page {page_number} not found")
        if page_number > total_pages:
            raise ValueError(f"Page {page_number} not found (template has {total_pages} pages)")

        page_image_url = page_images[page_number - 1] if page_images and page_number <= len(page_images) else ""
        page_html = page_html_list[page_number - 1] if page_html_list and page_number <= len(page_html_list) else ""

        page_fields = self._get_fields_for_page(schema, page_number)
        if not page_fields and page_html:
            page_fields = self._get_fields_matching_page_html(schema, page_html, page_number)
        if not page_fields and page_html:
            page_fields = self._build_dynamic_page_fields(page_html, page_number)

        page_sections = self._get_sections_for_page(schema, page_number)
        if not page_sections and page_fields:
            page_sections = self._get_sections_for_fields(schema, page_fields)

        return {
            "page_number": page_number,
            "total_pages": total_pages,
            "page_image_url": page_image_url,
            "page_html": page_html,
            "fields_on_page": page_fields,
            "sections_on_page": page_sections,
        }

    # --- Private Helper Methods ---

    def _build_structure_summary(self, fields: list[dict[str, Any]]) -> str:
        """Generate a human-readable summary of the page structure."""
        if not fields:
            return "No structured fields detected on this page."

        field_types = {}
        for field in fields:
            ftype = field.get("data_type", "text")
            field_types[ftype] = field_types.get(ftype, 0) + 1

        summary_parts = [f"Detected {len(fields)} fields: "]
        for ftype, count in sorted(field_types.items()):
            summary_parts.append(f"{count} {ftype}")

        return ", ".join(summary_parts)

    def _build_validation_prompt(
        self,
        fields: list[dict[str, Any]],
        page_text: str,
        schema: dict[str, Any],
        page_number: int,
    ) -> str:
        """Build the prompt for Ollama to validate fields on this page."""
        prompt_parts = [
            "You are a document field extraction validator. Extract and validate the following fields from the document text.",
            f"This is page {page_number} of the document.",
            "",
            "FIELDS TO EXTRACT AND VALIDATE:",
        ]

        for field in fields:
            label = field.get("field_label", field.get("label", "Unknown"))
            ftype = field.get("data_type", "text")
            hint = field.get("extraction_hint", "")
            prompt_parts.append(f"- {label} (type: {ftype}) {hint}")

        prompt_parts.extend([
            "",
            "DOCUMENT TEXT:",
            page_text,
            "",
            "For each field:",
            "1. Search for the value in the document text",
            "2. If found, provide the exact text with confidence (0.0-1.0)",
            "3. If not found, explain why",
            "4. Suggest alternative names if the field might be labeled differently",
            "",
            "Response format: JSON with field results and confidence scores",
        ])

        return "\n".join(prompt_parts)

    def _parse_validation_response(
        self,
        response: dict[str, Any],
        extracted_fields: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        """Parse Ollama response and extract validated fields with confidence scores."""
        # This is a placeholder - actual parsing depends on the model response format
        validated = []
        for field in extracted_fields:
            field_copy = dict(field)
            field_copy["confidence"] = 0.5  # Default placeholder
            field_copy["validation_status"] = "pending_user_review"
            validated.append(field_copy)
        return validated

    def _extract_suggestions(self, response: dict[str, Any]) -> list[str]:
        """Extract suggestions from model response."""
        return response.get("suggestions", [])

    def _assess_confidence(self, fields: list[dict[str, Any]]) -> bool:
        """Assess if fields need user review based on confidence scores."""
        avg_confidence = sum(f.get("confidence", 0.5) for f in fields) / max(len(fields), 1)
        return avg_confidence < 0.7  # Flag for review if avg confidence < 70%

    def _get_fields_for_page(
        self,
        schema: dict[str, Any],
        page_number: int,
    ) -> list[dict[str, Any]]:
        """Get all fields associated with a specific page.

        Some older pending templates were stored without explicit page_number
        values on every field. In that case we fall back to the section's
        page_number, which is still strongly page-scoped and lets the review
        screen stay page-specific instead of dumping the entire template field
        list into the current page.
        """
        fields: list[dict[str, Any]] = []
        for section in schema.get("sections", []):
            section_page = section.get("page_number")
            for field in section.get("fields", []):
                field_page = field.get("page_number")
                resolved_page = field_page if field_page is not None else section_page
                if resolved_page == page_number:
                    patched = dict(field)
                    patched["page_number"] = page_number
                    fields.append(patched)
        return fields

    def _get_sections_for_page(
        self,
        schema: dict[str, Any],
        page_number: int,
    ) -> list[dict[str, Any]]:
        """Get all sections that have content on a specific page."""
        sections = []
        for section in schema.get("sections", []):
            section_page = section.get("page_number")
            if any(
                (f.get("page_number") is not None and f.get("page_number") == page_number)
                or (f.get("page_number") is None and section_page == page_number)
                for f in section.get("fields", [])
            ):
                sections.append({
                    "section_id": section.get("section_id"),
                    "section_name": section.get("section_name"),
                    "field_count": len([
                        f for f in section.get("fields", [])
                        if (f.get("page_number") is not None and f.get("page_number") == page_number)
                        or (f.get("page_number") is None and section_page == page_number)
                    ]),
                })
        return sections

    def _get_fields_matching_page_html(
        self,
        schema: dict[str, Any],
        page_html: str,
        page_number: int,
    ) -> list[dict[str, Any]]:
        """Match labels to the current page HTML when page metadata is missing.

        This keeps the review page dynamic: each preview request checks the
        actual HTML for that page and only returns the fields whose labels
        appear in that page's text, instead of reusing stale metadata from a
        historical template record.
        """
        if not page_html:
            return []

        def normalize(value: Any) -> str:
            text = html_lib.unescape(str(value or ""))
            text = re.sub(r"<[^>]+>", " ", text)
            text = re.sub(r"\s+", " ", text)
            return text.strip().lower()

        plain_text = normalize(page_html)
        matches: list[dict[str, Any]] = []
        for section in schema.get("sections", []):
            section_text = normalize(section.get("section_name"))
            for field in section.get("fields", []):
                label = str(field.get("field_label") or field.get("label") or field.get("field_name") or "").strip()
                if not label:
                    continue
                label_norm = normalize(label)
                if label_norm in plain_text or section_text and label_norm in section_text:
                    patched = dict(field)
                    patched["page_number"] = page_number
                    matches.append(patched)
        return matches

    def _get_sections_for_fields(
        self,
        schema: dict[str, Any],
        fields: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        """Return section summaries from fields matched to the current page."""
        matched_ids = {field.get("field_id") for field in fields if field.get("field_id")}
        sections: list[dict[str, Any]] = []
        for section in schema.get("sections", []):
            matched_fields = [f for f in section.get("fields", []) if f.get("field_id") in matched_ids]
            if matched_fields:
                sections.append({
                    "section_id": section.get("section_id"),
                    "section_name": section.get("section_name"),
                    "field_count": len(matched_fields),
                })
        return sections

    def _build_dynamic_page_fields(self, page_html: str, page_number: int) -> list[dict[str, Any]]:
        """Generate a page-local editable field list from visible HTML text.

        This covers title pages and other pages that contain real values but no
        explicit field metadata. The user still reviews each extracted value and
        decides whether to keep, edit, or reject it before finalizing.
        """
        if not page_html:
            return []

        matches = re.findall(r"<(?:h[1-6]|p|li|td|th|div|span)[^>]*>(.*?)</(?:h[1-6]|p|li|td|th|div|span)>", page_html, flags=re.I | re.S)
        text_blocks: list[str] = []
        for match in matches:
            plain = html_lib.unescape(re.sub(r"<[^>]+>", " ", match))
            cleaned = re.sub(r"\s+", " ", plain).strip()
            if cleaned and cleaned not in text_blocks:
                text_blocks.append(cleaned)

        if not text_blocks:
            plain = html_lib.unescape(re.sub(r"<[^>]+>", " ", page_html))
            for chunk in re.split(r"\s*\n\s*", re.sub(r"\s+", " ", plain).strip()):
                chunk = chunk.strip()
                if chunk and chunk not in text_blocks:
                    text_blocks.append(chunk)

        fields: list[dict[str, Any]] = []
        for idx, block in enumerate(text_blocks, start=1):
            if block in {"&nbsp;", ""}:
                continue
            label = block
            value = block
            if ":" in block and len(block.split(":", 1)[0].strip()) <= 60:
                left, right = block.split(":", 1)
                label = left.strip() or f"Page value {idx}"
                value = right.strip()
            elif len(block) > 80:
                label = f"Page value {idx}"
                value = block
            else:
                label = f"Value {idx}"
                value = block

            value = value.strip()
            if not value:
                continue
            fields.append({
                "field_id": f"dynamic_page_{page_number}_{idx}",
                "field_label": label,
                "label": label,
                "field_name": label,
                "data_type": "string",
                "required": False,
                "page_number": page_number,
                "value": value,
                "default_value": value,
                "field_value": value,
                "extraction_hint": "User review: keep, edit, or reject this extracted page value before finalizing.",
                "validation_rules": [],
            })

        return fields[:20]