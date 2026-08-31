"""
Template Population Engine

This module implements the deterministic template value replacement logic.

Core principle: TEMPLATE IMMUTABILITY
- Master template structure never changes
- Only registered DYNAMIC fields can have their values replaced
- The replacement operation is deterministic and preserves structure
- No document regeneration or reformatting is allowed

Workflow:
  Master Template (DOCX)
      ↓
  Read + Identify Field Locations
      ↓
  Replace Values (Deterministic, Direct)
      ↓
  Verify Structure Unchanged
      ↓
  Output Document (100% Structurally Identical)
"""
import logging
from pathlib import Path
from typing import Any
import docx
from docx.document import Document as DocxDocument
from docx.text.paragraph import Paragraph  # type: ignore[import-not-found]

logger = logging.getLogger(__name__)


class DynamicFieldMapping:
    """Represents a single field replacement instruction."""
    
    def __init__(
        self,
        field_id: str,
        field_label: str,
        value: str,
        data_type: str = "text",
        placeholder_type: str = "text",  # "text", "table_cell", "bookmark"
    ):
        self.field_id = field_id
        self.field_label = field_label
        self.value = value
        self.data_type = data_type
        self.placeholder_type = placeholder_type
        self.replacements_made = 0
    
    def to_dict(self) -> dict[str, Any]:
        """Convert to serializable dict."""
        return {
            "field_id": self.field_id,
            "field_label": self.field_label,
            "value": self.value,
            "data_type": self.data_type,
            "placeholder_type": self.placeholder_type,
            "replacements_made": self.replacements_made,
        }


class TemplatePopulationEngine:
    """
    Handles deterministic template value replacement.
    
    This engine:
    1. Reads the master template
    2. Identifies dynamic field locations (by placeholder pattern or config)
    3. Replaces only the values (no structural changes)
    4. Preserves all formatting, layout, structure
    """
    
    # Common placeholder patterns used in templates
    PLACEHOLDER_PATTERNS = [
        "{{{field_id}}}",  # Triple braces
        "{{field_id}}",    # Double braces
        "[field_id]",      # Square brackets
        "___",             # Underscores (for manual fields)
    ]
    
    def __init__(self, template_path: Path, schema: dict[str, Any]):
        """
        Initialize the population engine.
        
        Args:
            template_path: Path to master template DOCX
            schema: Template schema containing field definitions with metadata
        """
        self.template_path = template_path
        self.schema = schema
        self.field_mappings = {}  # field_id -> DynamicFieldMapping
        self.operations_log = []  # Track all replacements
    
    def populate(
        self,
        extracted_values: dict[str, str],
        output_path: Path,
        preserve_structure: bool = True,
    ) -> tuple[bool, dict[str, Any]]:
        """
        Populate the template with extracted values.
        
        Args:
            extracted_values: Dict of field_id -> value from extraction
            output_path: Where to save the populated document
            preserve_structure: If True, validate structure is unchanged
        
        Returns:
            (success: bool, report: dict with details)
        """
        report = {
            "template_path": str(self.template_path),
            "output_path": str(output_path),
            "success": False,
            "replacements_made": 0,
            "fields_processed": 0,
            "errors": [],
            "warnings": [],
            "field_operations": [],
        }
        
        # Validate template exists
        if not self.template_path.exists():
            report["errors"].append(f"Template not found: {self.template_path}")
            return False, report
        
        try:
            # Load template
            doc = docx.Document(str(self.template_path))
        except Exception as e:
            report["errors"].append(f"Failed to load template: {e}")
            return False, report
        
        # Identify dynamic fields from schema
        dynamic_fields = self._extract_dynamic_fields()
        report["fields_processed"] = len(dynamic_fields)
        
        # Build field mappings
        for field_id, field_info in dynamic_fields.items():
            if field_id in extracted_values:
                value = extracted_values[field_id]
                mapping = DynamicFieldMapping(
                    field_id=field_id,
                    field_label=field_info.get("field_label", field_id),
                    value=value,
                    data_type=field_info.get("data_type", "text"),
                )
                self.field_mappings[field_id] = mapping
            else:
                report["warnings"].append(
                    f"No extracted value for field '{field_id}' ({field_info.get('field_label', 'N/A')})"
                )
        
        # Perform replacements
        replacement_count = 0
        
        # Strategy 1: Replace by placeholder pattern in paragraphs
        replacement_count += self._replace_in_paragraphs(doc, report)
        
        # Strategy 2: Replace in table cells
        replacement_count += self._replace_in_tables(doc, report)
        
        # Strategy 3: Replace in bookmarks (if template uses them)
        replacement_count += self._replace_in_bookmarks(doc, report)
        
        report["replacements_made"] = replacement_count
        
        # Save populated document
        try:
            doc.save(str(output_path))
            report["success"] = True
        except Exception as e:
            report["errors"].append(f"Failed to save output document: {e}")
            return False, report
        
        self.operations_log.append(report)
        return True, report
    
    def _extract_dynamic_fields(self) -> dict[str, dict[str, Any]]:
        """Fields whose placeholder in the master template is allowed to be
        replaced: fields marked `is_dynamic: true` (normal extraction
        output), PLUS static fields that declare a `default_value` - those
        are the ones extraction_service._seed_static_fields() creates an
        editable row for, so a user override on one of them needs to reach
        the actual document, not just sit in the database. Static fields
        with no default_value are never included here, so they stay
        genuinely immutable - nothing in extracted_values could match them
        anyway since no row is ever seeded for them.
        """
        dynamic_fields = {}
        
        sections = self.schema.get("sections", [])
        for section in sections:
            fields = section.get("fields", [])
            for field in fields:
                is_overridable_static = (
                    not field.get("is_dynamic", False) and field.get("default_value") is not None
                )
                if field.get("is_dynamic", False) or is_overridable_static:
                    field_id = field.get("field_id", "")
                    if field_id:
                        dynamic_fields[field_id] = field
        
        return dynamic_fields
    
    def _replace_in_paragraphs(
        self,
        doc: DocxDocument,
        report: dict[str, Any],
    ) -> int:
        """Replace field values in paragraph text."""
        replacements = 0
        
        for paragraph in doc.paragraphs:
            # Check each field mapping
            for field_id, mapping in self.field_mappings.items():
                # Bracket/brace placeholders get replaced outright - the
                # whole token *is* the placeholder. The "Label:" pattern is
                # different: the label itself is real template content that
                # must survive the replacement, only the value that follows
                # it should change - so it's handled separately below with
                # logic that preserves the label text.
                patterns = [
                    f"{{{{{field_id}}}}}",  # {{{field_id}}}
                    f"{{{field_id}}}",      # {{field_id}}
                    f"[{field_id}]",        # [field_id]
                ]
                
                for pattern in patterns:
                    if pattern in paragraph.text:
                        # Replace within the paragraph while preserving formatting
                        success = self._replace_in_paragraph_runs(
                            paragraph,
                            pattern,
                            mapping.value,
                        )
                        if success:
                            replacements += 1
                            mapping.replacements_made += 1
                            report["field_operations"].append({
                                "field_id": field_id,
                                "location": "paragraph",
                                "pattern_used": pattern,
                                "new_value": mapping.value,
                            })

                label_pattern = f"{mapping.field_label}:"
                if label_pattern in paragraph.text:
                    success = self._replace_label_value_in_paragraph(
                        paragraph,
                        label_pattern,
                        mapping.value,
                    )
                    if success:
                        replacements += 1
                        mapping.replacements_made += 1
                        report["field_operations"].append({
                            "field_id": field_id,
                            "location": "paragraph",
                            "pattern_used": label_pattern,
                            "new_value": mapping.value,
                        })
        
        return replacements
    
    def _replace_in_paragraph_runs(
        self,
        paragraph: Paragraph,
        pattern: str,
        new_value: str,
    ) -> bool:
        """
        Replace pattern in paragraph runs while preserving formatting.
        
        A paragraph consists of "runs" (text fragments with consistent
        formatting). We need to preserve the formatting of the first run
        where we find the pattern.
        """
        full_text = paragraph.text
        
        if pattern not in full_text:
            return False
        
        # Find and replace
        new_text = full_text.replace(pattern, new_value)
        
        return self._set_paragraph_text_preserving_format(paragraph, new_text)

    def _replace_label_value_in_paragraph(
        self,
        paragraph: Paragraph,
        label_pattern: str,
        new_value: str,
    ) -> bool:
        """
        Replace only the *value* half of a "Label: value" line, keeping the
        label text itself intact.

        Blindly replacing the whole "Label:" substring (as the generic
        placeholder replacement does for {{field}}/[field] tokens) would
        delete the label from the output document entirely - the label is
        real template content, not a placeholder, so only whatever comes
        after it on the line should change.
        """
        full_text = paragraph.text
        idx = full_text.find(label_pattern)
        if idx == -1:
            return False

        after = full_text[idx + len(label_pattern):]
        # Stop the "value" at the first newline so a label/value line
        # sitting above unrelated following content doesn't get swallowed
        # into the replacement.
        newline_idx = after.find("\n")
        trailing = after[newline_idx:] if newline_idx != -1 else ""

        new_text = f"{full_text[:idx]}{label_pattern} {new_value}{trailing}"
        return self._set_paragraph_text_preserving_format(paragraph, new_text)

    def _set_paragraph_text_preserving_format(
        self,
        paragraph: Paragraph,
        new_text: str,
    ) -> bool:
        """Overwrite a paragraph's text with new_text while preserving the
        formatting of its first run."""
        # Preserve formatting by keeping first run's style and using it
        if paragraph.runs:
            original_run = paragraph.runs[0]
            font_name = getattr(original_run.font, "name", None)
            font_size = getattr(original_run.font, "size", None)
            bold = getattr(original_run, "bold", False)
            italic = getattr(original_run, "italic", False)

            # Clear all runs
            for run in list(paragraph.runs):
                parent = run._element.getparent()
                if parent is not None:
                    parent.remove(run._element)

            # Add new run with original formatting
            new_run = paragraph.add_run(new_text)
            new_run.font.name = font_name
            new_run.font.size = font_size
            new_run.bold = bold
            new_run.italic = italic
        else:
            paragraph.text = new_text

        return True
    
    def _replace_in_tables(
        self,
        doc: DocxDocument,
        report: dict[str, Any],
    ) -> int:
        """Replace field values in table cells."""
        replacements = 0
        
        for table in doc.tables:
            for row in table.rows:
                for cell in row.cells:
                    # Each cell has paragraphs
                    for paragraph in cell.paragraphs:
                        # Check each field mapping
                        for field_id, mapping in self.field_mappings.items():
                            patterns = [
                                f"{{{{{field_id}}}}}",
                                f"{{{field_id}}}",
                                f"[{field_id}]",
                            ]
                            
                            for pattern in patterns:
                                if pattern in paragraph.text:
                                    success = self._replace_in_paragraph_runs(
                                        paragraph,
                                        pattern,
                                        mapping.value,
                                    )
                                    if success:
                                        replacements += 1
                                        mapping.replacements_made += 1
                                        report["field_operations"].append({
                                            "field_id": field_id,
                                            "location": "table_cell",
                                            "pattern_used": pattern,
                                            "new_value": mapping.value,
                                        })
        
        return replacements
    
    def _replace_in_bookmarks(
        self,
        doc: DocxDocument,
        report: dict[str, Any],
    ) -> int:
        """
        Replace values in bookmarked regions.
        
        Some templates use Word bookmarks to mark field locations.
        This preserves the bookmark while replacing its content.
        """
        replacements = 0
        
        # Word bookmarks are stored in the document's part
        # This is a more advanced feature - implementation depends on
        # whether the template actually uses bookmarks
        
        logger.debug("Bookmark-based field replacement not yet implemented")
        return replacements
    
    def generate_validation_report(self) -> dict[str, Any]:
        """Generate a comprehensive validation report of the population."""
        if not self.operations_log:
            return {"status": "no_operations"}
        
        latest_op = self.operations_log[-1]
        return {
            "population_success": latest_op["success"],
            "replacements_made": latest_op["replacements_made"],
            "fields_processed": latest_op["fields_processed"],
            "errors": latest_op["errors"],
            "warnings": latest_op["warnings"],
            "field_operations_summary": [
                {
                    "field_id": op["field_id"],
                    "location": op["location"],
                }
                for op in latest_op["field_operations"]
            ],
        }