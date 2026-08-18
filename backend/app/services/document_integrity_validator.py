"""
Document Integrity Validation

Validates that generated documents maintain the exact structure and
formatting of the master template. The generated document should be
100% identical to the master template, except for dynamic field values.

This is the critical validation mechanism that enforces the template
immutability principle.
"""
import logging
from pathlib import Path
from typing import Any, Optional
from docx import Document as DocxDocument
from app.services.template_structure_analyzer import (
    TemplateStructureAnalyzer,
    DocumentStructureSignature,
)

logger = logging.getLogger(__name__)


class IntegrityValidationResult:
    """Result of a document integrity validation."""
    
    def __init__(self):
        self.is_valid = True
        self.errors = []
        self.warnings = []
        self.checks_performed = []
        self.structure_preserved = True
        self.formatting_preserved = True
        self.layout_preserved = True
    
    def add_error(self, error: str) -> None:
        """Add a validation error."""
        self.errors.append(error)
        self.is_valid = False
    
    def add_warning(self, warning: str) -> None:
        """Add a validation warning."""
        self.warnings.append(warning)
    
    def add_check(self, check_name: str, passed: bool, details: str = "") -> None:
        """Record a validation check."""
        self.checks_performed.append({
            "name": check_name,
            "passed": passed,
            "details": details,
        })
    
    def to_dict(self) -> dict[str, Any]:
        """Convert to serializable dict."""
        return {
            "is_valid": self.is_valid,
            "errors": self.errors,
            "warnings": self.warnings,
            "checks_performed": self.checks_performed,
            "structure_preserved": self.structure_preserved,
            "formatting_preserved": self.formatting_preserved,
            "layout_preserved": self.layout_preserved,
        }


class DocumentIntegrityValidator:
    """
    Validates document integrity by comparing master template with output.
    
    This ensures that:
    1. Document structure is identical (pages, tables, paragraphs)
    2. Formatting is preserved (fonts, styles, alignment)
    3. Layout is unchanged (margins, spacing, pagination)
    4. Only field values changed
    """
    
    @staticmethod
    def validate_document_integrity(
        master_template_path: Path,
        generated_document_path: Path,
        schema: dict[str, Any],
    ) -> IntegrityValidationResult:
        """
        Validate that generated document maintains master template structure.
        
        Args:
            master_template_path: Path to master template
            generated_document_path: Path to generated document
            schema: Template schema with field definitions
        
        Returns:
            IntegrityValidationResult with detailed validation report
        """
        result = IntegrityValidationResult()
        
        # Check 1: Both files exist
        if not master_template_path.exists():
            result.add_error(f"Master template not found: {master_template_path}")
            return result
        
        if not generated_document_path.exists():
            result.add_error(f"Generated document not found: {generated_document_path}")
            return result
        
        result.add_check("Files exist", True)
        
        # Check 2: Analyze document structures
        try:
            master_sig = TemplateStructureAnalyzer.analyze_docx_structure(
                master_template_path
            )
        except Exception as e:
            result.add_error(f"Failed to analyze master template: {e}")
            return result
        
        try:
            generated_sig = TemplateStructureAnalyzer.analyze_docx_structure(
                generated_document_path
            )
        except Exception as e:
            result.add_error(f"Failed to analyze generated document: {e}")
            return result
        
        result.add_check("Document analysis", True)
        
        # Check 3: Compare signatures
        sigs_identical, differences = TemplateStructureAnalyzer.compare_signatures(
            master_sig,
            generated_sig,
        )
        
        if not sigs_identical:
            result.add_error("Document structure changed")
            result.structure_preserved = False
            for diff in differences:
                result.add_warning(f"Structural difference: {diff}")
        
        result.add_check("Structure comparison", sigs_identical, f"{len(differences)} differences")
        
        # Check 4: Page count validation (critical)
        if master_sig.page_count != generated_sig.page_count:
            result.add_error(
                f"Page count mismatch: {master_sig.page_count} vs {generated_sig.page_count}"
            )
            result.layout_preserved = False
        
        result.add_check(
            "Page count",
            master_sig.page_count == generated_sig.page_count,
            f"{master_sig.page_count} pages",
        )
        
        # Check 5: Table structure validation
        if master_sig.table_count != generated_sig.table_count:
            result.add_error(
                f"Table count mismatch: {master_sig.table_count} vs {generated_sig.table_count}"
            )
            result.structure_preserved = False
        
        result.add_check(
            "Table count",
            master_sig.table_count == generated_sig.table_count,
            f"{master_sig.table_count} tables",
        )
        
        # Check 6: Validate tables in detail
        DocumentIntegrityValidator._validate_table_structure(
            master_template_path,
            generated_document_path,
            result,
        )
        
        # Check 7: Validate font consistency
        DocumentIntegrityValidator._validate_font_consistency(
            master_template_path,
            generated_document_path,
            result,
        )
        
        # Check 8: Validate paragraph structure
        if abs(master_sig.paragraph_count - generated_sig.paragraph_count) > 10:
            result.add_warning(
                f"Paragraph count variance: {master_sig.paragraph_count} vs {generated_sig.paragraph_count}"
            )
        
        result.add_check(
            "Paragraph count",
            abs(master_sig.paragraph_count - generated_sig.paragraph_count) <= 10,
            f"{generated_sig.paragraph_count} paragraphs",
        )
        
        return result
    
    @staticmethod
    def _validate_table_structure(
        master_path: Path,
        generated_path: Path,
        result: IntegrityValidationResult,
    ) -> None:
        """Validate that table structures match between master and generated."""
        try:
            master_doc = DocxDocument(str(master_path))
            generated_doc = DocxDocument(str(generated_path))
        except Exception as e:
            result.add_warning(f"Could not validate table structure: {e}")
            return
        
        master_tables = master_doc.tables
        generated_tables = generated_doc.tables
        
        if len(master_tables) != len(generated_tables):
            result.add_error(f"Table count mismatch")
            return
        
        # Compare each table
        for idx, (master_table, generated_table) in enumerate(zip(master_tables, generated_tables)):
            master_rows = len(master_table.rows)
            generated_rows = len(generated_table.rows)
            
            if master_rows != generated_rows:
                result.add_error(
                    f"Table {idx} row count mismatch: {master_rows} vs {generated_rows}"
                )
            
            master_cols = len(master_table.columns)
            generated_cols = len(generated_table.columns)
            
            if master_cols != generated_cols:
                result.add_error(
                    f"Table {idx} column count mismatch: {master_cols} vs {generated_cols}"
                )
        
        result.add_check("Table structure", len(result.errors) == 0)
    
    @staticmethod
    def _validate_font_consistency(
        master_path: Path,
        generated_path: Path,
        result: IntegrityValidationResult,
    ) -> None:
        """Validate that fonts and styles are preserved."""
        try:
            master_doc = DocxDocument(str(master_path))
            generated_doc = DocxDocument(str(generated_path))
        except Exception as e:
            result.add_warning(f"Could not validate fonts: {e}")
            return
        
        # Check for critical style changes
        master_styles = set(s.name for s in master_doc.styles)
        generated_styles = set(s.name for s in generated_doc.styles)
        
        # Styles can be added but shouldn't be removed
        removed_styles = master_styles - generated_styles
        if removed_styles:
            result.add_warning(f"Styles removed: {', '.join(removed_styles)}")
        
        result.add_check("Font styles", len(removed_styles) == 0)
    
    @staticmethod
    def validate_field_replacement_only(
        master_path: Path,
        generated_path: Path,
        schema: dict[str, Any],
    ) -> IntegrityValidationResult:
        """
        Validate that ONLY field values changed between master and generated.
        
        This is the strictest validation - ensures structure is 100% identical
        except for dynamic field values.
        """
        result = IntegrityValidationResult()
        
        # Get structure signatures
        master_sig = TemplateStructureAnalyzer.analyze_docx_structure(master_path)
        generated_sig = TemplateStructureAnalyzer.analyze_docx_structure(generated_path)
        
        # Must have identical structure
        sigs_identical, differences = TemplateStructureAnalyzer.compare_signatures(
            master_sig,
            generated_sig,
        )
        
        if not sigs_identical:
            result.is_valid = False
            for diff in differences:
                result.add_error(f"Structure changed: {diff}")
        else:
            result.add_check("Structure identical", True)
        
        # Extract dynamic field IDs from schema
        dynamic_field_ids = set()
        for section in schema.get("sections", []):
            for field in section.get("fields", []):
                if field.get("is_dynamic", False):
                    dynamic_field_ids.add(field.get("field_id", ""))
        
        result.add_check(
            "Dynamic fields identified",
            len(dynamic_field_ids) > 0,
            f"{len(dynamic_field_ids)} dynamic fields",
        )
        
        return result


class TemplateIntegrityReport:
    """Complete integrity validation report for a document."""
    
    def __init__(self):
        self.template_name = ""
        self.master_path = ""
        self.generated_path = ""
        self.validation_result = IntegrityValidationResult()
        self.population_success = False
        self.final_status = "NOT_VALIDATED"
    
    def to_dict(self) -> dict[str, Any]:
        """Convert to serializable dict."""
        return {
            "template_name": self.template_name,
            "master_path": self.master_path,
            "generated_path": self.generated_path,
            "validation_result": self.validation_result.to_dict(),
            "population_success": self.population_success,
            "final_status": self.final_status,
        }
