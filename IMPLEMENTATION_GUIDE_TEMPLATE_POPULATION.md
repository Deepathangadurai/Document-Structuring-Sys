# Template Population System - Implementation Guide

## Overview

This document describes the implemented template population system that ensures extracted documents are 100% structurally identical to master templates, with only dynamic field values changed.

## Core Principle

```
MASTER TEMPLATE (IMMUTABLE)
    ↓
    ├─ Read from disk
    ├─ Identify dynamic field locations
    └─ Extract structure signature
    ↓
EXTRACT VALUES FROM SOURCE DOCUMENT
    ↓
    ├─ Qwen2.5-VL extracts field values only
    └─ Store as field_id → value mapping
    ↓
POPULATE TEMPLATE (Deterministic, Direct)
    ↓
    ├─ Replace only registered dynamic fields
    ├─ Preserve all formatting and layout
    └─ DO NOT regenerate document
    ↓
VALIDATE STRUCTURE UNCHANGED
    ↓
    ├─ Compare signatures (master vs output)
    ├─ Verify page count, tables, paragraphs
    └─ Ensure layout/formatting preserved
    ↓
OUTPUT DOCUMENT
    ↓
    = 100% Identical to Master Template (except field values)
```

## Key Components

### 1. TemplateStructureAnalyzer (`template_structure_analyzer.py`)

**Purpose**: Analyze and fingerprint master template structure

**Classes**:
- `DocumentStructureSignature`: Captures page count, table count, paragraph structure, headers, footers
- `TableStructureInfo`: Details of individual table structure (rows, columns, cell layout)
- `ParagraphInfo`: Paragraph structural info (style, level, alignment, not content)
- `TemplateStructureAnalyzer`: Main analyzer

**Key Methods**:
- `analyze_docx_structure(path)` → DocumentStructureSignature
- `analyze_pdf_structure(path)` → DocumentStructureSignature  
- `compare_signatures(master, generated)` → (identical: bool, differences: list)

**Usage**:
```python
from app.services.template_structure_analyzer import TemplateStructureAnalyzer

# Analyze master template
sig = TemplateStructureAnalyzer.analyze_docx_structure(Path("template.docx"))
print(f"Pages: {sig.page_count}, Tables: {sig.table_count}")

# Validate output matches master
identical, diffs = TemplateStructureAnalyzer.compare_signatures(master_sig, output_sig)
if not identical:
    print("Structure changed!", diffs)
```

### 2. TemplatePopulationEngine (`template_population_engine.py`)

**Purpose**: Deterministic template value replacement

**Classes**:
- `DynamicFieldMapping`: Represents a single field replacement
- `TemplatePopulationEngine`: Main replacement engine

**Key Methods**:
- `populate(extracted_values, output_path)` → (success: bool, report: dict)
- `_extract_dynamic_fields()`: Get fields marked `is_dynamic=true` from schema
- `_replace_in_paragraphs()`: Replace values in paragraph text
- `_replace_in_tables()`: Replace values in table cells
- `generate_validation_report()`: Summary of replacements performed

**Field Placeholder Patterns** (detected automatically):
- `{{{field_id}}}` (triple braces)
- `{{field_id}}` (double braces)
- `[field_id]` (square brackets)
- `___` (underscores for manual fields)

**Usage**:
```python
from pathlib import Path
from app.services.template_population_engine import TemplatePopulationEngine

# Extracted values from document analysis
values = {
    "project_id": "PRJ-001",
    "project_name": "ABC Solar Project",
    "capacity_mw": "500 MW",
}

# Populate template
engine = TemplatePopulationEngine(
    template_path=Path("master_template.docx"),
    schema=template_schema,
)

success, report = engine.populate(
    extracted_values=values,
    output_path=Path("output.docx"),
)

print(f"Success: {success}")
print(f"Replacements: {report['replacements_made']}")
print(f"Fields processed: {report['fields_processed']}")
if report['errors']:
    print(f"Errors: {report['errors']}")
```

### 3. DocumentIntegrityValidator (`document_integrity_validator.py`)

**Purpose**: Validate output document maintains master template structure

**Classes**:
- `IntegrityValidationResult`: Detailed validation results
- `DocumentIntegrityValidator`: Main validator
- `TemplateIntegrityReport`: Complete validation report

**Key Methods**:
- `validate_document_integrity(master, generated, schema)` → IntegrityValidationResult
- `validate_field_replacement_only(master, generated, schema)` → IntegrityValidationResult
- `_validate_table_structure()`: Check table structure preservation
- `_validate_font_consistency()`: Check font preservation

**Validation Checks**:
1. ✅ Files exist and can be opened
2. ✅ Document structure analyzed successfully
3. ✅ Structure signatures compared
4. ✅ Page count identical
5. ✅ Table count and structure identical
6. ✅ Font/style preservation
7. ✅ Paragraph count within acceptable variance
8. ✅ Headers/footers unchanged

**Usage**:
```python
from pathlib import Path
from app.services.document_integrity_validator import DocumentIntegrityValidator

# Validate output matches master
result = DocumentIntegrityValidator.validate_document_integrity(
    master_template_path=Path("master.docx"),
    generated_document_path=Path("output.docx"),
    schema=template_schema,
)

if result.is_valid:
    print("✅ Integrity validation PASSED")
else:
    print("❌ Integrity validation FAILED")
    for error in result.errors:
        print(f"  Error: {error}")
    for check in result.checks_performed:
        status = "✓" if check["passed"] else "✗"
        print(f"  {status} {check['name']}: {check['details']}")
```

## Integration with Extraction Service

### Updated `export_as_docx()` Workflow

```python
def export_as_docx(self, job: ExtractionJob, output_path: str) -> None:
    1. Load template from /templates/{template_id}/
    2. Collect extracted field values from database
    3. Create TemplatePopulationEngine with master template
    4. Call engine.populate(values, output_path)
    5. Validate output with DocumentIntegrityValidator
    6. On success: Return populated document
    7. On failure: Fall back to simple table export (with warning)
```

### API Response (with validation metadata)

When `/extraction/{job_id}/export?format=docx` is called:
- Returns the populated document
- Includes validation report in response headers/metadata
- If validation fails, includes error details

## Schema Changes Required

### Dynamic Field Registration

Template schema.json must include `is_dynamic` flag for each field:

```json
{
  "sections": [
    {
      "section_id": "project_info",
      "section_name": "Project Information",
      "fields": [
        {
          "field_id": "project_id",
          "field_label": "Project ID",
          "data_type": "text",
          "is_dynamic": true,
          "required": true,
          "page_number": 1
        },
        {
          "field_id": "project_name",
          "field_label": "Project Name",
          "data_type": "text",
          "is_dynamic": true,
          "required": true,
          "page_number": 1
        },
        {
          "field_id": "static_note",
          "field_label": "This is a static section",
          "data_type": "text",
          "is_dynamic": false,
          "required": false,
          "page_number": 1
        }
      ]
    }
  ]
}
```

**Migration Strategy**:
1. Add `is_dynamic` to existing templates (default: `true` for all fields)
2. Manually review and mark truly static fields as `false`
3. Test population with small subset of templates
4. Gradually roll out to production templates

## Database Changes

### New Column: `structure_signature`

**File**: `backend/app/db/models.py`

Added to `Template` model:
```python
# Structure signature: JSON containing page count, table structure, etc.
# Used to validate that generated documents maintain the same layout
structure_signature = Column(JSON, nullable=True)
```

**Purpose**: Cache the structure signature for faster comparison

**Usage**:
```python
from app.services.template_structure_analyzer import TemplateStructureAnalyzer

template = db.query(Template).filter_by(template_id="spec_01").first()

# On template upload/update
sig = TemplateStructureAnalyzer.analyze_docx_structure(template_path)
template.structure_signature = sig.to_dict()
db.commit()

# For validation
if template.structure_signature:
    cached_sig = DocumentStructureSignature.from_dict(template.structure_signature)
```

## Error Handling & Fallback Strategy

### Normal Flow
```
Master Template + Extracted Values
    ↓
Template Population Engine
    ↓
    ├─ Success? 
    │  ├─ Structure validation Pass?
    │  │  ├─ Yes → Return populated document ✅
    │  │  └─ No → Fall back to table export
    │  └─ Fail → Fall back to table export
    └─ Error → Fall back to table export
```

### Fallback: Simple Table Export

If template population fails:
1. Generate simple DOCX with extracted fields in table format
2. Include warning: "⚠️ This is a fallback export. For the proper populated template, ensure the master template file is available."
3. Log error details for debugging

## Testing Strategy

### Unit Tests

**File**: `backend/tests/test_template_population.py` (create)

```python
def test_structure_analyzer_page_count():
    """Verify page count detection"""
    sig = TemplateStructureAnalyzer.analyze_docx_structure(test_template)
    assert sig.page_count == 12

def test_structure_analyzer_table_structure():
    """Verify table structure capture"""
    sig = TemplateStructureAnalyzer.analyze_docx_structure(test_template)
    assert sig.table_count == 3
    # Compare table structure

def test_population_engine_placeholder_replacement():
    """Verify field replacement works"""
    engine = TemplatePopulationEngine(template, schema)
    success, report = engine.populate(values, output)
    assert success
    assert report['replacements_made'] == expected_count

def test_integrity_validator_structure_match():
    """Verify structure validation passes for identical docs"""
    result = DocumentIntegrityValidator.validate_document_integrity(
        master, output, schema
    )
    assert result.is_valid
    assert result.structure_preserved

def test_integrity_validator_detects_changes():
    """Verify validator detects structural changes"""
    # Modify output (remove table, change page count, etc.)
    result = DocumentIntegrityValidator.validate_document_integrity(
        master, modified_output, schema
    )
    assert not result.is_valid
    assert len(result.errors) > 0
```

### Integration Tests

**Flow**:
1. Upload template
2. Extract values from source document
3. Export populated document
4. Validate structure matches master
5. Verify only field values changed

## Best Practices

### For Template Designers
1. **Use consistent placeholders**: Use `{{{field_id}}}` format in all fields
2. **Register all fields**: Ensure schema includes all fields with `field_id` and `is_dynamic` flag
3. **Avoid generated content**: Master template should be hand-authored, not AI-generated
4. **Test before deployment**: Validate with sample extraction before using in production

### For Developers
1. **Always check validation results**: Don't ignore validation failures
2. **Use structure signatures**: Cache signatures for faster comparison
3. **Log operations**: All replacements and errors should be logged
4. **Implement retry logic**: If population fails, try fallback export
5. **Monitor performance**: Profile template population for large documents

### For Users
1. **Preserve master template**: Never modify the template used for extraction
2. **Verify output**: Review populated documents before distribution
3. **Report issues**: If output doesn't match template structure, report immediately
4. **Update templates**: When template format changes, update master template, not extraction logic

## Troubleshooting

### Issue: "Structure changed detected"

**Causes**:
- Placeholder patterns not recognized (e.g., `[field_name]` but only `{{}}` in template)
- Template file corruption
- Font/formatting changes during replacement

**Solution**:
1. Verify placeholder patterns in template match engine patterns
2. Check template file integrity
3. Review error logs for specific changes detected
4. Regenerate template if corrupted

### Issue: "Master template file not found"

**Causes**:
- Template directory missing or misconfigured
- Template file not in expected location

**Solution**:
1. Verify `TEMPLATE_PATH` configuration
2. Check template directory structure: `/templates/{template_id}/schema.json`
3. Ensure master DOCX file is present in template directory
4. Review deployment/volume mount configuration

### Issue: "No fields replaced"

**Causes**:
- No fields marked as `is_dynamic=true`
- Placeholder patterns don't match schema
- Extracted values dict missing expected field IDs

**Solution**:
1. Verify schema has `is_dynamic: true` for fields to be replaced
2. Verify placeholder pattern matches (e.g., `{{{project_id}}}` in template matches `project_id` in schema)
3. Check extraction logs to verify field_id values extracted correctly
4. Debug replacement logic with test values

## Future Enhancements

1. **Bookmarks Support**: Handle Word bookmarks for field locations
2. **Form Fields Support**: Populate form fields (radio buttons, checkboxes)
3. **Conditional Content**: Show/hide sections based on extracted values
4. **Multi-page Templates**: Better handling of large documents
5. **Template Versioning**: Support multiple template versions
6. **Audit Trail**: Track all replacements with timestamps and user info
