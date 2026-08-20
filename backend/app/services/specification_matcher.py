"""Detects which master-template specifications appear in a project's
uploaded source document.

This is the "6. Detect which specifications from the 13 templates exist
in the uploaded document" + "7. Match each detected specification to the
correct default template" step of the workflow. It runs entirely on data
already produced by the real parsing pipeline (DocumentPage.text, written
by DocumentService.process_document from the actual uploaded file) and
the real master-template schemas on disk (via TemplateService) — nothing
here is mocked or fabricated.

Matching is deterministic and rule-based, in the same spirit as the
"deterministic rules first" ordering used for value extraction, with
three signals in priority order:

1. Title match (strongest, primary signal): a specification's unique,
   human-readable name — e.g. "ELECTRICAL DESIGN BASIS" — is what
   actually identifies it, and it's printed as a standalone heading on
   the document (see templates/specification_01: "IP-009" /
   "PASHMINA PROJECT" / "ELECTRICAL DESIGN BASIS" all appear as separate
   heading lines on page 1). This is far more reliable than the internal
   document-number code, which can vary in formatting/OCR quality and
   isn't what a reviewer would recognize the spec by.
2. Document-number match (supporting signal): the template's official
   doc number (e.g. "IP009-43-00-01-0") appearing verbatim on a page.
   Corroborates a title match, or gives a weaker match on its own if the
   title isn't found (e.g. scanned/OCR'd pages that garble the heading).
3. Section/field label overlap (weakest signal): how many of the
   template's section and field labels appear on a page. Only used to
   fine-tune confidence, never enough on its own to reach MATCH, since
   many specs share generic field names like "Project Name".

This intentionally does NOT use Qdrant/Qwen — those are reserved for
*value* extraction once a specification is already matched (requirement
#8). Detection only needs to answer "is this specification present",
which the deterministic signals above answer well and cheaply, and stays
inspectable/debuggable rather than depending on a model round-trip for
every one of the 13 templates on every upload.
"""
from __future__ import annotations

import re
from typing import Any, cast

from sqlalchemy.orm import Session

from app.db.models import Document, DocumentPage
from app.services.template_service import TemplateService

MATCH_THRESHOLD = 0.6
REVIEW_THRESHOLD = 0.15

# Placeholder names used for specs whose real title hasn't been captured
# yet (e.g. specification_02/03, which don't have a source .docx checked
# in). Titles matching this pattern are NOT trustworthy as a unique
# identifying signal - matching literal text "Specification 02" against
# an unrelated document would be meaningless - so they're excluded from
# the title signal and the matcher falls back to doc-number + labels.
_PLACEHOLDER_TITLE_RE = re.compile(r"^specification\s*\d+$")


def _normalize(text: Any) -> str:
    return re.sub(r"\s+", " ", str(text) if text is not None else "").strip().lower()


class SpecificationMatcher:
    def __init__(self, db: Session):
        self.db = db
        self.template_service = TemplateService(db)

    def _signals_for_template(self, template: dict[str, Any]) -> tuple[str | None, str, list[str]]:
        raw_title = str(template.get("template_name") or "")
        normalized_title = _normalize(raw_title)
        
        # Explicit variable used for type-checker clarity:
        title: str | None = normalized_title

        # A real, specific spec name (e.g. "electrical design basis") is a
        # strong unique signal; a placeholder like "specification 02" is
        # not - don't use it for matching.
        if not title or _PLACEHOLDER_TITLE_RE.match(title) or len(title) < 6:
            title = None

        spec_number = _normalize(str(template.get("specification_number") or ""))

        labels: list[str] = []
        for section in template.get("sections", []) or []:
            name = section.get("section_name")
            if name:
                labels.append(_normalize(name))
            for field in section.get("fields", []) or []:
                label = field.get("field_label")
                if label:
                    labels.append(_normalize(label))
        # Drop very short/common labels (e.g. "General", "Date") that would
        # match almost any document and dilute the signal.
        labels = [l for l in dict.fromkeys(labels) if len(l) >= 4]
        return title, spec_number, labels

    def detect(self, document: Document) -> list[dict[str, Any]]:
        self.template_service.sync_templates_if_needed()
        templates = self.template_service.list_templates()

        pages = (
            self.db.query(DocumentPage)
            .filter_by(document_id=document.id)
            .order_by(DocumentPage.page_number)
            .all()
        )
        page_texts: list[tuple[int, str]] = [
            (cast(int, p.page_number), _normalize(p.text)) for p in pages
        ]

        results: list[dict[str, Any]] = []
        for template in templates:
            title, spec_number, labels = self._signals_for_template(template)
            matched_pages: list[int] = []
            title_hit = False
            number_hit = False
            label_hit_count = 0

            for page_number, text in page_texts:
                page_matched = False
                if title and title in text:
                    title_hit = True
                    page_matched = True
                if spec_number and spec_number in text:
                    number_hit = True
                    page_matched = True
                overlap = sum(1 for label in labels if label in text)
                if overlap:
                    label_hit_count += overlap
                    page_matched = True
                if page_matched:
                    matched_pages.append(int(page_number))

            label_signal = min(1.0, label_hit_count / max(len(labels), 1))

            if title_hit:
                # Title is the authoritative signal: high floor, extra
                # credit if the doc number also matches, small boost from
                # label overlap.
                confidence = 0.75
                if number_hit:
                    confidence += 0.15
                confidence += 0.10 * label_signal
            elif number_hit:
                # Doc number alone (title missing/garbled/not captured
                # yet) - still a meaningful but weaker signal.
                confidence = 0.45 + 0.2 * label_signal
            elif label_signal > 0:
                # Labels alone are the weakest signal - generic field
                # names are shared across many specs - so this can never
                # reach MATCH on its own, only REVIEW.
                confidence = min(0.55, 0.15 + 0.4 * label_signal)
            else:
                confidence = 0.0

            confidence = round(min(confidence, 1.0), 2)

            if confidence >= MATCH_THRESHOLD:
                status = "matched"
            elif confidence >= REVIEW_THRESHOLD:
                status = "review"
            else:
                status = "not_found"

            results.append(
                {
                    "template_id": template["template_id"],
                    "template_name": template["template_name"],
                    "specification_number": template.get("specification_number"),
                    "match_status": status,
                    "match_confidence": confidence,
                    "matched_pages": matched_pages,
                }
            )

        # Strongest matches first, so the confirm-and-extract screen leads
        # with what's most likely correct.
        results.sort(key=lambda r: r["match_confidence"], reverse=True)
        return results