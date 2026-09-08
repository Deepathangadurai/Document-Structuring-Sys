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
"deterministic rules first" ordering used for value extraction. Real
uploaded documents in this workflow are frequently just filled-in value
sheets — no title page, no printed spec number, only field labels and
their values — so title/number can't be treated as required gatekeepers.
Instead there are two signals, and label overlap is the *primary* one:

1. Section/field label overlap (primary signal): how many of the
   template's section and field labels appear anywhere in the document,
   weighted by how DISTINCTIVE each label is across the whole template
   set (inverse document frequency) rather than raw count. A label that
   only appears in one template's schema (e.g. "Time within which DG can
   be fully loaded") is strong, near-unique evidence; a label shared by
   many templates (e.g. "Date", "Service") barely moves the needle. This
   lets a document with no title or number at all still reach MATCH on
   label evidence alone, while still resisting false positives from
   generic shared vocabulary, since those labels are weighted down
   automatically rather than manually blacklisted.
2. Title / document-number match (corroborating signal, optional): when
   a title (e.g. "ELECTRICAL DESIGN BASIS") or the official doc number
   (e.g. "IP009-43-00-01-0") IS present, it's strong corroborating
   evidence and boosts confidence — but its ABSENCE no longer caps the
   score, since plenty of real uploads simply won't have either.

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

# Every one of the 13 spec templates shares the same corporate header/
# footer format (Spec. No. / Rev. / Project No. / Description / Area /
# Sheet / Client Name / Project Name / General, etc.) - these fields
# exist on literally every spec sheet by construction, so finding them
# says nothing about WHICH spec this is. Cross-template rarity can't
# catch this on its own while most templates are still placeholders with
# no real fields to compare against, so it's an explicit stoplist rather
# than something learned from the current (mostly empty) template set.
_BOILERPLATE_LABELS = {
    "general", "description", "revision", "rev", "rev.", "spec. no.",
    "spec no", "spec. no", "project no.", "project no", "project name",
    "client name", "location", "area", "sheet", "date", "page",
}


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
        # useful corroborating signal; a placeholder like "specification 02"
        # is not - don't use it for matching.
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
        # Drop very short labels (e.g. "OK") - too short to be a reliable
        # substring match at all - and known universal boilerplate, which
        # would match every spec sheet equally and contribute nothing to
        # telling them apart.
        labels = [
            l for l in dict.fromkeys(labels)
            if len(l) >= 4 and l not in _BOILERPLATE_LABELS
        ]
        return title, spec_number, labels

    def _label_weights(
        self, templates: list[dict[str, Any]]
    ) -> tuple[dict[str, list[str]], dict[str, float]]:
        """Computes an IDF-style weight per distinct label across ALL
        templates: a label found in only one template's schema is highly
        distinctive (weight approaches 1.0); a label shared by many
        templates is generic and contributes very little (weight approaches
        0). This is what lets label overlap alone carry a MATCH decision -
        the earlier flat "count of hits" approach couldn't distinguish a
        page full of "Date"/"Service" hits (meaningless) from a handful of
        hits on genuinely spec-specific field names (decisive).
        """
        labels_by_template: dict[str, list[str]] = {}
        doc_freq: dict[str, int] = {}
        for template in templates:
            _, _, labels = self._signals_for_template(template)
            labels_by_template[template["template_id"]] = labels
            for label in set(labels):
                doc_freq[label] = doc_freq.get(label, 0) + 1

        total_templates = max(len(templates), 1)
        weight: dict[str, float] = {}
        for label, freq in doc_freq.items():
            rarity = 1.0 - (freq - 1) / total_templates
            # Cross-template rarity alone can't distinguish "date" from
            # "time within which DG can be fully loaded" while only one
            # template (specification_01) has real fields checked in -
            # both currently have freq=1 simply because nothing else
            # exists to compare against yet. Word-count is a cheap proxy
            # for specificity that works from day one: short, generic
            # labels are discounted regardless of how many templates
            # exist to compare against; this naturally fades in
            # importance as more real templates are added and
            # cross-template rarity becomes meaningful on its own.
            specificity = min(1.0, len(label.split()) / 3)
            weight[label] = rarity * specificity
        return labels_by_template, weight

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
        full_text = " ".join(text for _, text in page_texts)

        labels_by_template, label_weight = self._label_weights(templates)

        results: list[dict[str, Any]] = []
        for template in templates:
            title, spec_number, _ = self._signals_for_template(template)
            labels = labels_by_template[template["template_id"]]
            matched_pages: list[int] = []
            title_hit = False
            number_hit = False

            # Combine matched labels as independent evidence (noisy-OR),
            # not as "coverage of the full template". A real upload is
            # often a partial excerpt of a much longer master (e.g. pages
            # 1-3 of a 20-page spec) - most of the template's fields
            # genuinely won't be present, and that should NOT depress
            # confidence. What matters is: of the labels we DID find, how
            # strongly do they point to this template? A few highly
            # distinctive matches should already be enough.
            miss_probability = 1.0
            for label in labels:
                if label in full_text:
                    miss_probability *= (1.0 - label_weight.get(label, 0.0))
            label_signal = 1.0 - miss_probability

            for page_number, text in page_texts:
                page_matched = False
                if title and title in text:
                    title_hit = True
                    page_matched = True
                if spec_number and spec_number in text:
                    number_hit = True
                    page_matched = True
                if any(label in text for label in labels):
                    page_matched = True
                if page_matched:
                    matched_pages.append(page_number)

            # label_signal (computed above) is the primary confidence
            # source: it can reach MATCH on its own with no title or
            # number present at all, and does not require the uploaded
            # document to contain anywhere near the template's full field
            # count - see the noisy-OR comment above.
            confidence = label_signal

            # Title/number are corroborating boosts when present, not
            # gatekeepers - their absence never caps the score below what
            # label evidence alone earned.
            if title_hit:
                confidence = max(confidence, 0.7) + 0.15
            if number_hit:
                confidence += 0.15

            confidence = round(min(confidence, 1.0), 2)

            if confidence >= MATCH_THRESHOLD:
                status = "matched"
            elif confidence >= REVIEW_THRESHOLD:
                status = "review"
            else:
                status = "not_found"

            # Anything below 50% is noise for this workflow (a real spec
            # match should be well past REVIEW_THRESHOLD) - don't surface
            # it on the confirm-and-extract screen at all.
            if confidence < 0.5:
                continue

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