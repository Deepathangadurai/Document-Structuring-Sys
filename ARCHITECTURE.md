# System Architecture: Page-by-Page Template Analysis

## High-Level Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                        USER INTERFACE                            │
├─────────────────────────────────────────────────────────────────┤
│  Templates Page  →  Upload Template  →  Pending Review          │
│                         ↓                      ↓                 │
│                    Auto-Infer Schema      Review Pages (NEW)    │
│                    Generate Page Images        ↓                 │
│                                          ┌─────────────────────┐ │
│                                          │ Page-by-Page Review │ │
│                                          │ Interface           │ │
│                                          │ - Page Image View   │ │
│                                          │ - Field List        │ │
│                                          │ - Correction Input  │ │
│                                          │ - Ollama Validation │ │
│                                          │ - Feedback Submit   │ │
│                                          └──────────┬──────────┘ │
│                                                     ↓             │
│                                          Finalize Master Template │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                        BACKEND API                               │
├─────────────────────────────────────────────────────────────────┤
│  TemplateService                                                 │
│  ├─ upload_template()                                           │
│  ├─ list_pending_templates()                                    │
│  ├─ approve_pending_template()                                  │
│  └─ sync_templates_if_needed()                                  │
│                                                                  │
│  PageAnalysisService (NEW)                                       │
│  ├─ analyze_page_structure()                                    │
│  ├─ validate_page_with_ollama()                                │
│  ├─ collect_user_validation()                                   │
│  ├─ finalize_master_template()                                  │
│  └─ get_page_preview()                                          │
│                                                                  │
│  API Routes (templates.py)                                       │
│  ├─ POST /templates/upload                                      │
│  ├─ POST /templates/pending/{id}/approve                       │
│  ├─ GET  /templates/pending/{id}/pages/{n}/preview (NEW)       │
│  ├─ POST /templates/pending/{id}/pages/{n}/analyze (NEW)       │
│  ├─ POST /templates/pending/{id}/pages/{n}/validate (NEW)      │
│  ├─ POST /templates/pending/{id}/pages/{n}/feedback (NEW)      │
│  └─ POST /templates/pending/{id}/finalize (NEW)                │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                        SERVICES LAYER                            │
├─────────────────────────────────────────────────────────────────┤
│  SchemaInference Service                                         │
│  ├─ infer_schema_sections_with_page_count()                    │
│  ├─ _docx_to_page_images()                                      │
│  ├─ _docx_to_pdf()                                              │
│  └─ _candidate_field_from_line()                                │
│                                                                  │
│  ModelService                                                    │
│  ├─ QwenVLProvider                                               │
│  │  ├─ extract()                                                │
│  │  ├─ validate_and_extract() (NEW)                            │
│  │  ├─ _parse_validation_response() (NEW)                      │
│  │  ├─ _parse_confidence_scores() (NEW)                        │
│  │  └─ _parse_suggestions() (NEW)                              │
│  └─ [is_available, health]                                      │
│                                                                  │
│  DocumentService                                                 │
│  └─ [document processing]                                       │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                    EXTERNAL SERVICES                             │
├─────────────────────────────────────────────────────────────────┤
│  Ollama AI Model                                                 │
│  ├─ Model: qwen2.5-vl:7b                                        │
│  ├─ API: http://127.0.0.1:11434                                 │
│  ├─ Endpoints:                                                   │
│  │  ├─ /api/generate (field extraction)                         │
│  │  ├─ /api/tags (model availability)                          │
│  │  └─ Format: JSON                                             │
│  └─ Temperature: 0.3 (for consistency)                           │
│                                                                  │
│  LibreOffice / Microsoft Word                                    │
│  └─ DOCX/DOC to PDF/PNG conversion                              │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                        DATABASE                                  │
├─────────────────────────────────────────────────────────────────┤
│  Template Model                                                  │
│  ├─ id, template_id, template_name, version                     │
│  ├─ schema (JSON) - stores full schema with page_images         │
│  ├─ is_active, status (pending/approved)                        │
│  ├─ validation_log (JSON) - NEW - per-page feedback             │
│  ├─ structure_locked (bool)                                     │
│  └─ created_at, updated_at                                      │
│                                                                  │
│  Storage (File System)                                           │
│  ├─ /storage/pending_templates/{template_id}/                  │
│  │  └─ pages/                                                   │
│  │     ├─ page_1.png                                            │
│  │     ├─ page_2.png                                            │
│  │     └─ ...                                                   │
│  └─ /templates/{template_id}/                                   │
│     └─ schema.json (finalized)                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Data Flow Diagram

```
UPLOAD WORKFLOW:
═══════════════

┌─────────────┐
│Upload DOCX  │
└──────┬──────┘
       │
       ├─→ Convert .doc to .docx (if needed)
       │
       ├─→ Convert .docx to PDF
       │
       ├─→ Generate Page Images (PNG @ 150 DPI)
       │   └─→ Store in /storage/pending_templates/{id}/pages/
       │
       ├─→ Infer Schema (detect fields, sections)
       │
       ├─→ Create Draft Template (status=DRAFT)
       │
       └─→ Save to Database
           └─→ template.schema includes:
               ├─ sections: []
               ├─ fields: []
               └─ page_images: [URLs]


PAGE REVIEW WORKFLOW:
════════════════════

Frontend: /templates/pending/{id}/review
│
├─→ Load Template Metadata
│   ├─ Page count
│   ├─ Field list
│   └─ Page images
│
├─→ For Each Page (currentPage):
│   │
│   ├─→ GET /templates/pending/{id}/pages/{n}/preview
│   │   └─→ PageAnalysisService.get_page_preview()
│   │       └─→ Returns:
│   │           ├─ page_image_url
│   │           ├─ fields_on_page
│   │           ├─ sections_on_page
│   │           └─ page_number, total_pages
│   │
│   ├─→ Display Page:
│   │   ├─ Render page image
│   │   ├─ Show field list
│   │   ├─ Input correction fields
│   │   └─ Show progress
│   │
│   ├─→ [Optional] Validate with Ollama
│   │   │
│   │   ├─→ POST /templates/pending/{id}/pages/{n}/validate
│   │   │   └─→ PageAnalysisService.validate_page_with_ollama()
│   │   │       │
│   │   │       ├─→ Build validation prompt:
│   │   │       │   ├─ Field names & types
│   │   │       │   ├─ Field extraction hints
│   │   │       │   └─ Page text
│   │   │       │
│   │   │       ├─→ Call ModelService.validate_and_extract()
│   │   │       │   │
│   │   │       │   ├─→ POST http://ollama:11434/api/generate
│   │   │       │   │   ├─ model: qwen2.5-vl:7b
│   │   │       │   │   ├─ prompt: <validation_prompt>
│   │   │       │   │   ├─ temperature: 0.3
│   │   │       │   │   └─ format: json
│   │   │       │   │
│   │   │       │   ├─→ Parse response:
│   │   │       │   │   ├─ Extract field values
│   │   │       │   │   ├─ Parse confidence scores
│   │   │       │   │   ├─ Extract suggestions
│   │   │       │   │   └─ Flag for review
│   │   │       │   │
│   │   │       │   └─→ Return validation result
│   │   │       │
│   │   │       └─→ Returns:
│   │   │           ├─ validated_fields: [{field, value, confidence}]
│   │   │           ├─ suggestions: ["alt_field_name", ...]
│   │   │           ├─ needs_user_review: bool
│   │   │           └─ model_response: "reasoning"
│   │   │
│   │   └─→ Display validation results:
│   │       ├─ Show confidence scores
│   │       ├─ Highlight low-confidence fields
│   │       ├─ Display suggestions
│   │       └─ Flag for manual review if needed
│   │
│   ├─→ User Corrects & Approves
│   │   ├─ Edit field values
│   │   ├─ Mark fields as approved
│   │   ├─ Add page notes
│   │   │
│   │   ├─→ POST /templates/pending/{id}/pages/{n}/feedback
│   │   │   └─→ PageAnalysisService.collect_user_validation()
│   │   │       │
│   │   │       ├─→ Store feedback in:
│   │   │       │   template.validation_log[pages][page_n] = {
│   │   │       │     timestamp,
│   │   │       │     corrections: {field → corrected_value},
│   │   │       │     approved_fields: [field_ids],
│   │   │       │     notes: "user notes"
│   │   │       │   }
│   │   │       │
│   │   │       └─→ Return: { status: "validated" }
│   │   │
│   │   └─→ Mark page as approved ✓
│   │
│   └─→ Move to Next Page (or complete)
│
├─→ After Last Page Reviewed:
│   │
│   ├─→ Click "Finalize Master Template"
│   │   │
│   │   ├─→ POST /templates/pending/{id}/finalize
│   │   │   └─→ PageAnalysisService.finalize_master_template()
│   │   │       │
│   │   │       ├─→ Merge all page feedback into final schema
│   │   │       ├─→ Apply user corrections to final schema
│   │   │       ├─→ Update template:
│   │   │       │   ├─ schema: final_schema (with all corrections)
│   │   │       │   ├─ status: "ready_for_approval"
│   │   │       │   ├─ validation_log: complete
│   │   │       │   ├─ validation_complete: true
│   │   │       │   └─ validated_at: timestamp
│   │   │       │
│   │   │       └─→ Return: {
│   │   │           template_id,
│   │   │           status: "ready_for_approval",
│   │   │           pages_validated,
│   │   │           fields_extracted,
│   │   │           average_confidence
│   │   │         }
│   │   │
│   │   └─→ Redirect to Success Screen
│   │       └─ Template ready for approval by admin
│   │
│   └─→ [Optional] Admin Approves Final Template
│       ├─→ POST /templates/pending/{id}/approve
│       │   └─→ TemplateService.approve_pending_template()
│       │       ├─ Mark is_active: true
│       │ ├─ Move to /templates/{template_id}/ (master)
│       │       └─ Template now available for projects


PROJECT USAGE:
══════════════

User creates new project:
│
├─→ Select finalized master template
│
├─→ Upload document for processing
│
├─→ System uses template schema to:
│   ├─ Extract field values with Qwen VL
│   ├─ Apply extraction hints from validation
│   ├─ Use confidence thresholds for validation
│   └─ Present structured document to user
│
└─→ User validates extracted data with confidence scores
```

## Component Interaction Diagram

```
┌──────────────────┐
│  TemplatePending │  React Component
│   Component      │
└────────┬─────────┘
         │ uses
         ↓
    API Layer
  ┌──────────────────────────────────────────┐
  │ POST /templates/pending/{id}/upload       │
  │ GET  /templates/pending                   │
  │ POST /templates/pending/{id}/approve      │
  └────────────────────┬─────────────────────┘
                       │
         ┌─────────────┴──────────────┐
         ↓                            ↓
  ┌──────────────┐           ┌──────────────────┐
  │ Templates.py │           │ PageAnalysis.py  │
  │  (API route)  │           │  (NEW API route)  │
  └────────┬──────┘           └────────┬─────────┘
           │                           │
           ├─ TemplateService ◄────────┤
           │  └ sync_templates()         │
           │  └ approve_template()       │
           │                            │
           └───────────────┬────────────┘
                           │
                ┌──────────┴──────────┐
                ↓                     ↓
         ┌──────────────┐      ┌──────────────────┐
         │   Database   │      │  PageAnalysis     │
         │  (Template)  │      │  Service          │
         └──────────────┘      │                   │
                               │ analyze_page()    │
                               │ validate_page()   │
                               │ collect_feedback()│
                               │ finalize()        │
                               └────────┬──────────┘
                                        │
                           ┌────────────┴────────────┐
                           ↓                         ↓
                     ┌──────────────┐         ┌─────────────┐
                     │SchemaInference│         │ ModelService│
                     │  Service     │         │   (Ollama)  │
                     │              │         │             │
                     │_docx_to_pdf()│         │extract()    │
                     │_pdf_to_images│         │validate()   │
                     │_infer_schema()         │health()     │
                     └──────────────┘         └─────────────┘
                           │                         │
              ┌────────────┘                         │
              ↓                                      ↓
         ┌──────────────┐                   ┌──────────────────┐
         │  File System │                   │  Ollama Server   │
         │              │                   │  (Port 11434)    │
         │/storage/     │                   │                  │
         │/templates/   │                   │ qwen2.5-vl:7b    │
         │/page images/ │                   │                  │
         └──────────────┘                   └──────────────────┘
```

## State Machine: Template Lifecycle

```
              ┌─────────────────┐
              │  Document       │
              │  Uploaded       │
              └────────┬────────┘
                       │
                       ├─→ Convert DOCX/DOC to PDF
                       ├─→ Generate page images
                       ├─→ Infer initial schema
                       │
                       ↓
         ┌─────────────────────────┐
         │  DRAFT Template          │
         │  (Pending Review)        │
         │  status: "pending"       │
         └────────────┬────────────┘
                      │
              [User clicks "Review Pages"]
                      │
                      ├─→ Enter page-by-page review
                      ├─→ For each page:
                      │   ├─ Analyze structure
                      │   ├─ Validate with Ollama
                      │   ├─ Collect user feedback
                      │   └─ Mark page complete
                      │
                      ↓
    ┌──────────────────────────────────┐
    │  VALIDATION IN PROGRESS           │
    │  validation_complete: false       │
    │  validation_log: { pages: {...} } │
    └──────────────────┬───────────────┘
                       │
          [After all pages reviewed]
                       │
                       ├─→ Merge page feedback
                       ├─→ Apply user corrections
                       ├─→ Calculate confidence
                       │
                       ↓
      ┌────────────────────────────────┐
      │  READY FOR APPROVAL            │
      │  status: "ready_for_approval"  │
      │  validation_complete: true     │
      └──────────────┬─────────────────┘
                     │
         [Admin approves template]
                     │
                     ├─→ Copy to /templates/
                     ├─→ Set is_active: true
                     │
                     ↓
         ┌────────────────────────┐
         │  APPROVED Template      │
         │  is_active: true        │
         │  status: "active"       │
         │  structure_locked: true │
         └──────────┬─────────────┘
                    │
      [Ready for use in projects]
                    │
                    ├─→ Select in "Create Project"
                    ├─→ Upload documents
                    ├─→ Auto-extract with template
                    │
                    ↓
         ┌────────────────────────┐
         │  IN USE                 │
         │  Active in projects     │
         │  Extraction running     │
         └────────────────────────┘
```

## File Organization

```
project/
├── backend/
│   └── app/
│       ├── api/
│       │   ├── templates.py (UPDATED - added 5 new endpoints)
│       │   ├── documents.py
│       │   ├── extraction.py
│       │   ├── projects.py
│       │   └── ...
│       │
│       ├── services/
│       │   ├── page_analysis_service.py (NEW)
│       │   ├── template_service.py
│       │   ├── schema_inference.py
│       │   ├── extraction_service.py
│       │   ├── model/
│       │   │   ├── base.py (UPDATED - added abstract method)
│       │   │   ├── qwen_vl.py (UPDATED - implemented validate_and_extract)
│       │   │   └── __init__.py
│       │   └── ...
│       │
│       ├── db/
│       │   ├── models.py
│       │   ├── schemas.py
│       │   └── database.py
│       │
│       └── core/
│           └── config.py
│
├── frontend/
│   └── src/
│       ├── components/
│       │   ├── TemplatePageReview.tsx (NEW)
│       │   ├── TemplatePending.tsx (UPDATED)
│       │   ├── Templates.tsx
│       │   ├── TemplateReview.tsx
│       │   ├── Dashboard.tsx
│       │   └── ...
│       │
│       ├── services/
│       │   ├── api.ts
│       │   └── ...
│       │
│       ├── App.tsx (UPDATED - added route)
│       └── ...
│
├── storage/
│   └── pending_templates/
│       └── {template_id}/
│           └── pages/
│               ├── page_1.png
│               ├── page_2.png
│               └── ...
│
├── templates/
│   └── {template_id}/
│       └── schema.json
│
└── TEMPLATE_CREATION_GUIDE.md (NEW)
```

## Performance Considerations

### Memory & Storage
- Page images @ 150 DPI: ~200-500 KB per page
- 100-page document: ~20-50 MB storage
- Temporary PDF conversion: cleaned up after images generated

### Processing Time
- DOCX to PDF conversion: 5-30 seconds
- PDF to page images: 2-5 seconds per page
- Schema inference: 5-10 seconds for 100 pages
- Ollama validation per page: 10-30 seconds (network-dependent)

### Optimization Tips
1. Enable GPU on Ollama server (10x faster)
2. Batch multiple documents
3. Cache page images in browser
4. Lazy-load images in page list

---

**Diagram Format**: ASCII flowcharts  
**Last Updated**: August 2026  
**Document Version**: 1.0
