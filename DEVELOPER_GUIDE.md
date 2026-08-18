# Developer Guide: Page-by-Page Template Analysis System

## Quick Start for Developers

### 1. Understanding the System

The system is organized into three main layers:

**Frontend (React/TypeScript)**
- `TemplatePageReview.tsx`: Main page-by-page review interface
- `TemplatePending.tsx`: Lists pending templates with Review Pages button
- API service layer in `src/services/api.ts`

**Backend API (FastAPI/Python)**
- `app/api/templates.py`: HTTP endpoints for template operations
- `app/services/page_analysis_service.py`: Business logic for page analysis

**Services & Models**
- `app/services/schema_inference.py`: Auto-detect template structure
- `app/services/model/qwen_vl.py`: Ollama model integration
- Database models in `app/db/models.py`

### 2. Setting Up Your Development Environment

```bash
# Backend setup
cd backend
python -m venv venv
source venv/bin/activate  # or `venv\Scripts\activate` on Windows
pip install -r requirements.txt

# Frontend setup
cd frontend
npm install

# Ensure Ollama is running
ollama serve  # in another terminal
```

### 3. Key Files to Understand

| File | Purpose | Changes |
|------|---------|---------|
| `backend/app/services/page_analysis_service.py` | Page analysis orchestration | NEW |
| `backend/app/api/templates.py` | Template API endpoints | UPDATED (5 new endpoints) |
| `backend/app/services/model/base.py` | Model provider interface | UPDATED (new abstract method) |
| `backend/app/services/model/qwen_vl.py` | Ollama implementation | UPDATED (validation methods) |
| `frontend/src/components/TemplatePageReview.tsx` | Page review UI | NEW |
| `frontend/src/components/TemplatePending.tsx` | Pending list | UPDATED |
| `frontend/src/App.tsx` | Routes | UPDATED |

## Architecture Deep Dive

### Backend Request/Response Flow

#### 1. Get Page Preview
```python
# Frontend request
GET /templates/pending/{pending_id}/pages/{page_number}/preview

# Backend (templates.py)
def get_page_preview(pending_id: int, page_number: int):
    service = PageAnalysisService(db)
    return service.get_page_preview(pending_id, page_number)

# Service (page_analysis_service.py)
def get_page_preview(self, template_id: int, page_number: int):
    # 1. Fetch template from DB
    template = db.query(Template).filter_by(id=template_id).first()
    
    # 2. Extract page images and fields
    page_images = template.schema.get("page_images", [])
    page_image_url = page_images[page_number - 1]
    
    # 3. Get fields for this page
    page_fields = self._get_fields_for_page(template.schema, page_number)
    
    # 4. Return response
    return {
        "page_number": page_number,
        "total_pages": len(page_images),
        "page_image_url": page_image_url,
        "fields_on_page": page_fields
    }

# Frontend receives and displays
setPageAnalysis(result)
```

#### 2. Validate with Ollama
```python
# Frontend request
POST /templates/pending/{pending_id}/pages/{page_number}/validate
{
    "page_number": 1,
    "page_text": "extracted document text...",
    "extracted_fields": [...]
}

# Backend (templates.py)
def validate_page_with_model(pending_id: int, page_number: int, payload):
    service = PageAnalysisService(db)
    return service.validate_page_with_ollama(
        pending_id,
        page_number,
        payload.page_text,
        payload.extracted_fields
    )

# Service (page_analysis_service.py)
def validate_page_with_ollama(self, template_id, page_number, page_text, fields):
    # 1. Build validation prompt
    prompt = self._build_validation_prompt(fields, page_text, schema, page_number)
    
    # 2. Call Ollama model
    response = self.model_service.validate_and_extract(prompt)
    
    # 3. Parse response
    validated_fields = self._parse_validation_response(response, fields)
    
    # 4. Extract suggestions and confidence scores
    return {
        "validated_fields": validated_fields,
        "suggestions": self._extract_suggestions(response),
        "needs_user_review": self._assess_confidence(validated_fields)
    }

# Model service (qwen_vl.py)
def validate_and_extract(self, prompt: str) -> dict:
    # 1. Call Ollama API
    response = client.post(
        f"{self.base_url}/api/generate",
        json={
            "model": self.model_name,
            "prompt": prompt,
            "temperature": 0.3
        }
    )
    
    # 2. Parse response
    raw_text = response.json().get("response", "")
    
    # 3. Extract structured data
    return {
        "reasoning": raw_text,
        "confidence_scores": self._parse_confidence_scores(raw_text),
        "suggestions": self._parse_suggestions(raw_text)
    }

# Frontend receives validation results
setValidationResult(result)
```

### Frontend Component Structure

```tsx
// TemplatePageReview.tsx
export default function TemplatePageReview() {
  // State management
  const [template, setTemplate] = useState()
  const [currentPage, setCurrentPage] = useState(1)
  const [pageAnalysis, setPageAnalysis] = useState()
  const [validationResult, setValidationResult] = useState()
  const [pageFeedback, setPageFeedback] = useState()

  // Load template on mount
  useEffect(() => {
    loadTemplate()
  }, [templateId])

  // Load/analyze page when current page changes
  useEffect(() => {
    analyzePage()
  }, [currentPage])

  // Event handlers
  const handleValidatePage = async () => {
    // POST to /validate endpoint
    // Set validationResult from response
  }

  const handleSubmitPageFeedback = async () => {
    // POST to /feedback endpoint
    // Mark page approved
    // Move to next page
  }

  const handleFinalizeMasterTemplate = async () => {
    // POST to /finalize endpoint
    // Redirect on success
  }

  return (
    <div>
      {/* Page image preview */}
      {/* Field list with corrections */}
      {/* Validation results display */}
      {/* Action buttons */}
    </div>
  )
}
```

## Adding New Features

### Example 1: Adding Automatic OCR

```python
# In page_analysis_service.py

def analyze_page_structure(self, template_id, page_number, page_image_url, extracted_fields):
    # Add OCR extraction
    ocr_text = self._extract_text_from_image(page_image_url)
    
    # Enhance field detection with OCR
    enhanced_fields = self._match_fields_to_ocr_text(extracted_fields, ocr_text)
    
    return {
        "page_number": page_number,
        "fields": enhanced_fields,
        "ocr_text": ocr_text,  # NEW
        "structure_summary": structure
    }

def _extract_text_from_image(self, image_path: str) -> str:
    """Extract text from page image using OCR."""
    import pytesseract
    from PIL import Image
    
    image = Image.open(image_path)
    text = pytesseract.image_to_string(image)
    return text

def _match_fields_to_ocr_text(self, fields, ocr_text):
    """Match detected fields to OCR text for validation."""
    for field in fields:
        label = field.get("field_label", "")
        # Search for label in OCR text
        if label in ocr_text:
            field["found_in_ocr"] = True
            field["ocr_confidence"] = 0.9
    return fields
```

### Example 2: Extending Ollama Validation

```python
# In model/qwen_vl.py

def validate_and_extract(self, prompt: str) -> dict:
    """Enhanced with caching and retry logic."""
    
    # Check cache first
    cache_key = hashlib.md5(prompt.encode()).hexdigest()
    if cache_key in self._validation_cache:
        return self._validation_cache[cache_key]
    
    # Retry logic for network errors
    max_retries = 3
    for attempt in range(max_retries):
        try:
            response = client.post(
                f"{self.base_url}/api/generate",
                json={...}
            )
            
            result = {...}
            
            # Cache result
            self._validation_cache[cache_key] = result
            return result
            
        except Exception as e:
            if attempt == max_retries - 1:
                raise
            time.sleep(2 ** attempt)  # Exponential backoff
```

### Example 3: Custom Field Extraction Rules

```python
# In page_analysis_service.py

def validate_page_with_ollama(self, template_id, page_number, page_text, fields):
    # Apply custom extraction rules first
    for field in fields:
        field = self._apply_custom_extraction_rule(field, page_text)
    
    # Then validate with Ollama
    return self.model_service.validate_and_extract(prompt)

def _apply_custom_extraction_rule(self, field, page_text):
    """Apply custom extraction rules if configured."""
    extraction_hint = field.get("extraction_hint", "")
    
    # Date field pattern
    if "date" in extraction_hint.lower():
        import re
        date_pattern = r'\d{1,2}/\d{1,2}/\d{2,4}'
        matches = re.findall(date_pattern, page_text)
        if matches:
            field["custom_extracted_value"] = matches[0]
            field["confidence"] = 0.95
    
    # Email pattern
    if "email" in extraction_hint.lower():
        import re
        email_pattern = r'\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b'
        matches = re.findall(email_pattern, page_text)
        if matches:
            field["custom_extracted_value"] = matches[0]
            field["confidence"] = 0.98
    
    return field
```

## Testing

### Unit Tests

```python
# backend/tests/test_page_analysis.py

import pytest
from app.services.page_analysis_service import PageAnalysisService
from app.db.models import Template

@pytest.fixture
def page_analysis_service(db):
    return PageAnalysisService(db)

def test_analyze_page_structure(page_analysis_service):
    result = page_analysis_service.analyze_page_structure(
        template_id=1,
        page_number=1,
        page_image_url="/static/pages/page_1.png",
        extracted_fields=[
            {"field_label": "Name", "data_type": "text"}
        ]
    )
    
    assert result["page_number"] == 1
    assert result["structure_summary"] is not None
    assert len(result["fields"]) > 0

def test_validate_page_with_ollama(page_analysis_service, mocker):
    # Mock Ollama response
    mock_response = {
        "reasoning": "Found field 'Name' with value 'John Doe'",
        "suggestions": [],
        "confidence_scores": {"Name": 0.95}
    }
    mocker.patch.object(
        page_analysis_service.model_service,
        'validate_and_extract',
        return_value=mock_response
    )
    
    result = page_analysis_service.validate_page_with_ollama(
        template_id=1,
        page_number=1,
        page_text="Name: John Doe",
        extracted_fields=[...]
    )
    
    assert result["needs_user_review"] == False
    assert "Name" in result["validated_fields"][0]
```

### Integration Tests

```python
# backend/tests/test_template_review_workflow.py

def test_complete_page_review_workflow(client, db, auth_headers):
    # 1. Upload template
    response = client.post(
        "/api/templates/upload",
        files={"file": ("template.docx", docx_bytes)},
        headers=auth_headers
    )
    template_id = response.json()["id"]
    
    # 2. Get page preview
    response = client.get(
        f"/api/templates/pending/{template_id}/pages/1/preview",
        headers=auth_headers
    )
    assert response.status_code == 200
    assert "page_image_url" in response.json()
    
    # 3. Validate page
    response = client.post(
        f"/api/templates/pending/{template_id}/pages/1/validate",
        json={
            "page_number": 1,
            "page_text": "Sample document text...",
            "extracted_fields": [...]
        },
        headers=auth_headers
    )
    assert response.status_code == 200
    
    # 4. Submit feedback
    response = client.post(
        f"/api/templates/pending/{template_id}/pages/1/feedback",
        json={
            "page_number": 1,
            "corrections": {},
            "approved_fields": ["field_1"]
        },
        headers=auth_headers
    )
    assert response.status_code == 200
    
    # 5. Finalize template
    response = client.post(
        f"/api/templates/pending/{template_id}/finalize",
        json={
            "final_schema": {...},
            "validation_summary": {...}
        },
        headers=auth_headers
    )
    assert response.status_code == 200
```

### Frontend Tests

```typescript
// frontend/src/components/__tests__/TemplatePageReview.test.tsx

import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { BrowserRouter } from 'react-router-dom'
import TemplatePageReview from '../TemplatePageReview'

describe('TemplatePageReview', () => {
  it('loads and displays template preview', async () => {
    render(
      <BrowserRouter>
        <TemplatePageReview />
      </BrowserRouter>
    )
    
    await waitFor(() => {
      expect(screen.getByText(/Page 1 Preview/i)).toBeInTheDocument()
    })
  })
  
  it('calls Ollama validation when button clicked', async () => {
    // Mock fetch
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          page_number: 1,
          validated_fields: [],
          needs_user_review: false
        })
      })
    )
    
    render(
      <BrowserRouter>
        <TemplatePageReview />
      </BrowserRouter>
    )
    
    const validateButton = await screen.findByText(/Validate with Ollama/i)
    fireEvent.click(validateButton)
    
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/validate'),
        expect.any(Object)
      )
    })
  })
})
```

## Debugging Tips

### 1. Check Ollama Connection
```bash
# Test Ollama API
curl http://localhost:11434/api/tags

# Should return list of available models
# If connection refused, start Ollama:
ollama serve
```

### 2. View Validation Prompt
```python
# In page_analysis_service.py, add logging
def _build_validation_prompt(self, fields, page_text, schema, page_number):
    prompt = "..."
    print(f"[DEBUG] Validation prompt for page {page_number}:")
    print(prompt[:500])  # Print first 500 chars
    return prompt
```

### 3. Check Page Images
```bash
# Verify page images exist
ls -la storage/pending_templates/{template_id}/pages/

# Open in browser
open http://localhost:8000/static/pending_templates/{template_id}/pages/page_1.png
```

### 4. Monitor Database
```python
# Check template schema structure
from app.db.models import Template

template = db.query(Template).filter_by(id=1).first()
import json
print(json.dumps(template.schema, indent=2))
```

### 5. Enable Debug Logging
```python
# In app/core/config.py or main.py
import logging
logging.basicConfig(level=logging.DEBUG)

# In services, use logger
logger = logging.getLogger(__name__)
logger.debug(f"Page validation starting for page {page_number}")
```

## Performance Optimization

### 1. Caching Page Data
```python
# Add Redis caching for page previews
from functools import lru_cache

@lru_cache(maxsize=128)
def get_page_preview(template_id: int, page_number: int):
    # Cache page preview for 5 minutes
    ...
```

### 2. Async Processing
```python
# Make Ollama calls async
async def validate_page_with_ollama_async(self, template_id, page_number, ...):
    # Use async httpx client
    async with httpx.AsyncClient() as client:
        response = await client.post(url, json=payload)
        return await process_response_async(response)
```

### 3. Batch Operations
```python
# Validate multiple pages in parallel
from concurrent.futures import ThreadPoolExecutor

def validate_all_pages(template_id):
    with ThreadPoolExecutor(max_workers=4) as executor:
        futures = [
            executor.submit(self.validate_page_with_ollama, template_id, n)
            for n in range(1, total_pages + 1)
        ]
        results = [f.result() for f in futures]
    return results
```

## Common Issues & Solutions

| Issue | Solution |
|-------|----------|
| "Model not available" | Check Ollama running: `ollama serve` |
| Page images not showing | Verify image files exist in storage |
| Confidence scores parsing fails | Check model response format |
| Frontend shows blank page | Check browser console for API errors |
| Database connection error | Verify DATABASE_URL in config |
| DOCX conversion fails | Install LibreOffice: `apt-get install libreoffice` |

---

**Document Version**: 1.0  
**Last Updated**: August 2026  
**For Questions**: See ARCHITECTURE.md and TEMPLATE_CREATION_GUIDE.md
