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
        return TemplateStructureValidator.get_structure_signature(template.schema)

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
        template.structure_locked = True

    @staticmethod
    def unlock_template_structure(template: Template) -> None:
        """Mark a template's structure as unlocked (mutable)."""
        template.structure_locked = False
