""""Verify Document & Template" (requirement #10): for a completed
extraction job, compares every extracted value against what its matched
master template requires and returns a MATCH / MISMATCH / NOT FOUND /
REVIEW verdict per field.

Runs against real data already on the job/template (no fabricated
values): the field's stored value, confidence, human validation_status,
and the template schema's `required` flag / `validation_rules`.
"""
from __future__ import annotations

import re
from typing import Any, cast

from sqlalchemy.orm import Session

from app.db.models import ExtractionJob, Template

LOW_CONFIDENCE_THRESHOLD = 0.5


class VerificationService:
    def __init__(self, db: Session):
        self.db = db

    def _field_definitions(self, template: Template | None) -> dict[str, dict[str, Any]]:
        if not template:
            return {}
        schema = cast(dict[str, Any], template.schema) if isinstance(template.schema, dict) else {}
        defs: dict[str, dict[str, Any]] = {}
        for section in schema.get("sections", []) or []:
            for field in section.get("fields", []) or []:
                field_id = field.get("field_id")
                if field_id:
                    defs[field_id] = field
        return defs

    def verify_job(self, job: ExtractionJob) -> list[dict[str, Any]]:
        template = self.db.query(Template).filter_by(id=job.template_id).first()
        field_defs = self._field_definitions(template)

        results: list[dict[str, Any]] = []
        for extracted in job.extracted_fields:
            field_def = field_defs.get(extracted.field_id, {})
            required = bool(field_def.get("required", False))
            expected_hint = field_def.get("extraction_hint")
            value = (extracted.value or "").strip()

            status = "match"
            reason: str | None = None

            if extracted.validation_status == "rejected":
                status = "mismatch"
                reason = "This value was rejected during review."
            elif not value:
                status = "not_found" if required else "review"
                reason = (
                    "Required value was not found in the source document."
                    if required
                    else "Optional value was not found in the source document."
                )
            elif extracted.confidence is not None and extracted.confidence < LOW_CONFIDENCE_THRESHOLD:
                status = "review"
                reason = f"Low extraction confidence ({round(extracted.confidence * 100)}%) — please double-check."
            else:
                mismatch_reason = self._check_validation_rules(value, field_def.get("validation_rules") or [])
                if mismatch_reason:
                    status = "mismatch"
                    reason = mismatch_reason

            results.append(
                {
                    "field_id": extracted.field_id,
                    "status": status,
                    "expected_hint": expected_hint,
                    "reason": reason,
                }
            )
        return results

    def _check_validation_rules(self, value: str, rules: list[Any]) -> str | None:
        for rule in rules:
            if not isinstance(rule, dict):
                continue
            pattern = rule.get("pattern")
            if pattern:
                try:
                    if not re.search(pattern, value):
                        return rule.get("message") or "Value does not match the pattern this template requires."
                except re.error:
                    continue
            min_length = rule.get("min_length")
            if isinstance(min_length, int) and len(value) < min_length:
                return rule.get("message") or f"Value is shorter than the required {min_length} characters."
        return None