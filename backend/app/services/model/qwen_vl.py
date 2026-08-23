import json
import asyncio
import time
import httpx
from app.services.model.base import ModelProvider
from app.core.config import settings

class QwenVLProvider(ModelProvider):
    """
    Talks to a local Qwen2.5-VL model served through Ollama's native API.
    """

    # OPTIMIZATION: Increased batch size from 2 to 8 fields to reduce API round-trips.
    MAX_FIELDS_PER_PROMPT = 12
    MAX_REFERENCE_TEXT_CHARS = 250
    MAX_PAGE_TEXT_CHARS = 2000
    MAX_TOTAL_PROMPT_CHARS = 12000
    # extract_async previously fired one concurrent request per section
    # batch via asyncio.gather with no limit - a template with e.g. 5
    # section batches meant 5 simultaneous POSTs at a single local Ollama
    # process. Ollama runs one model instance and isn't built to accept a
    # burst like that; the extra requests would get an OS-level connection
    # refusal (errno 111) rather than being queued. Capping concurrency
    # keeps requests within what a single local Ollama instance can
    # actually accept at once.
    MAX_CONCURRENT_REQUESTS = 2
    CONNECT_RETRY_ATTEMPTS = 3
    CONNECT_RETRY_DELAY_SECONDS = 1.5

    def __init__(self):
        self.provider = "qwen2.5-vl"
        self.model_name = settings.MODEL_NAME
        self.device = settings.MODEL_DEVICE
        self.base_url = settings.MODEL_URL
        self.timeout = settings.MODEL_TIMEOUT_SECONDS
        self.max_concurrent_requests = getattr(settings, "MODEL_MAX_CONCURRENT_REQUESTS", self.MAX_CONCURRENT_REQUESTS)

    @staticmethod
    def _truncate_text(value: str | None, max_chars: int) -> str:
        if value is None:
            return ""
        text = str(value)
        if len(text) <= max_chars:
            return text
        return text[:max_chars].rstrip() + "\n...[truncated]"

    def _candidate_urls(self) -> list[str]:
        candidates: list[str] = []
        seen: set[str] = set()
        preferred = [
            self.base_url,
            "http://ollama:11434",
            "http://host.docker.internal:11434",
            "http://127.0.0.1:11435",
            "http://localhost:11435",
            "http://host.docker.internal:11435",
            "http://localhost:11434",
            "http://127.0.0.1:11434",
        ]
        for value in preferred:
            if not value:
                continue
            normalized = value.rstrip("/")
            if normalized not in seen:
                seen.add(normalized)
                candidates.append(normalized)
        return candidates

    def is_available(self) -> bool:
        try:
            health = self.health()
            return health.get("available", False)
        except Exception:
            return False

    def health(self) -> dict:
        if not self.base_url:
            return {
                "available": False,
                "model": self.model_name,
                "provider": self.provider,
                "device": self.device,
                "reason": "MODEL_URL not configured",
            }

        last_error = None
        for base_url in self._candidate_urls():
            try:
                url = f"{base_url}/api/tags"
                with httpx.Client(timeout=self.timeout) as client:
                    response = client.get(url)
                    response.raise_for_status()
                    data = response.json()
                    available_models = [m.get("name") for m in data.get("models", [])]
                    if self.model_name not in available_models:
                        last_error = RuntimeError(
                            f"Model '{self.model_name}' not found in Ollama at {url}. "
                            f"Available: {available_models}"
                        )
                        continue
                    self.base_url = base_url
                    return {
                        "available": True,
                        "model": self.model_name,
                        "provider": self.provider,
                        "device": self.device,
                        "reason": None,
                    }
            except Exception as exc:
                last_error = exc
                continue

        return {
            "available": False,
            "model": self.model_name,
            "provider": self.provider,
            "device": self.device,
            "reason": str(last_error) if last_error else "Ollama unavailable",
        }

    def _build_prompt(self, template_schema: dict, pages: list[dict]) -> str:
        prompt_parts = [
            "You are a document extraction engine. Extract values from the document text below using EXACTLY the template schema given.",
            "Rules:",
            "- Do not create, remove, rename, or reorder fields.",
            "- If a value is not present in the document text, set its value to null.",
            "- Preserve the original wording from the document where possible.",
            "- Respond with ONLY valid JSON matching this exact shape:",
            '{"template_id": "...", "template_version": "...", "fields": '
            '[{"field_id": "...", "field_name": "...", "value": "..." or null, '
            '"confidence": 0.0-1.0, "source": {"page_number": int, "source_text": "..."}}]}',
            "",
            f"TEMPLATE_ID: {template_schema.get('template_id')}",
            f"TEMPLATE_VERSION: {template_schema.get('version')}",
            "FIELDS TO EXTRACT:",
        ]

        for section in template_schema.get("sections", []):
            prompt_parts.append(f"SECTION: {section.get('section_name')}")
            for field in section.get("fields", []):
                hint = field.get("extraction_hint") or ""
                prompt_parts.append(f"- field_id={field.get('field_id')} label=\"{field.get('field_label')}\" hint=\"{hint}\"")

        current_len = sum(len(part) for part in prompt_parts)

        ref_text = template_schema.get("reference_document_text")
        if ref_text:
            ref_block = f"\nREFERENCE TEMPLATE:\n{self._truncate_text(ref_text, self.MAX_REFERENCE_TEXT_CHARS)}"
            if current_len + len(ref_block) < self.MAX_TOTAL_PROMPT_CHARS:
                prompt_parts.append(ref_block)
                current_len += len(ref_block)

        prompt_parts.append("\nDOCUMENT TEXT:")
        current_len += len("\nDOCUMENT TEXT:")

        for page in pages:
            page_text = self._truncate_text(page.get("text", ""), self.MAX_PAGE_TEXT_CHARS)
            page_block = f"--- PAGE {page.get('page_number')} ---\n{page_text}"
            if current_len + len(page_block) > self.MAX_TOTAL_PROMPT_CHARS:
                break
            prompt_parts.append(page_block)
            current_len += len(page_block)

        prompt_parts.append("\nReturn only the JSON object described above.")
        prompt = "\n".join(prompt_parts)
        return prompt[: self.MAX_TOTAL_PROMPT_CHARS]

    async def _call_ollama_generate_async(self, client: httpx.AsyncClient, prompt: str) -> dict:
        """Asynchronous API call reusing client session and limiting generation length.

        Local Ollama is a single background process, not a scaled service -
        under concurrent load (see extract_async's semaphore) or right after
        it's just started, it can refuse a connection outright (OS-level
        "Connection refused", errno 111) rather than queue and answer it
        slowly. That's usually transient, so a connection refusal gets a
        couple of short retries before it's treated as a real failure and
        the loop moves on to try any other candidate URL.
        """
        last_error = None
        for base_url in self._candidate_urls():
            url = f"{base_url.rstrip('/')}/api/generate"
            payload = {
                "model": self.model_name,
                "prompt": prompt,
                "format": "json",
                "stream": False,
                "options": {
                    "temperature": 0,
                    "num_predict": 1024,  # Enough for all fields to complete
                },
            }
            for attempt in range(self.CONNECT_RETRY_ATTEMPTS):
                try:
                    response = await client.post(url, json=payload, timeout=self.timeout)
                    response.raise_for_status()
                    data = response.json()
                    self.base_url = base_url
                    return data
                except httpx.ConnectError as exc:
                    last_error = exc
                    if attempt < self.CONNECT_RETRY_ATTEMPTS - 1:
                        await asyncio.sleep(self.CONNECT_RETRY_DELAY_SECONDS * (attempt + 1))
                        continue
                    break
                except Exception as exc:
                    last_error = exc
                    break
        if last_error is not None:
            raise RuntimeError(f"Ollama async request failed: {self._describe_error(last_error)}")
        raise RuntimeError("No Ollama endpoints were reachable")

    def _describe_error(self, exc: Exception) -> str:
        """Turn a raw connection exception (often just "[Errno 111]
        Connection refused") into something a user can act on, instead of
        surfacing the bare OS error in extraction_service's job.error_message."""
        if isinstance(exc, httpx.ConnectError):
            return (
                f"{exc} — Ollama refused the connection at {self.base_url or self._candidate_urls()[0]}. "
                f"This usually means: (1) Ollama isn't running (`ollama serve`), "
                f"(2) the model isn't pulled (`ollama pull {self.model_name}`), or "
                f"(3) Ollama is overloaded by too many concurrent requests and briefly refusing new "
                f"connections — retried automatically, but kept failing after {self.CONNECT_RETRY_ATTEMPTS} attempts."
            )
        return str(exc)

    def _call_ollama_generate(self, prompt: str) -> dict:
        last_error = None
        for base_url in self._candidate_urls():
            url = f"{base_url.rstrip('/')}/api/generate"
            payload = {
                "model": self.model_name,
                "prompt": prompt,
                "format": "json",
                "stream": False,
                "options": {
                    "temperature": 0,
                    "num_predict": 1024,
                },
            }
            for attempt in range(self.CONNECT_RETRY_ATTEMPTS):
                try:
                    with httpx.Client(timeout=self.timeout) as client:
                        response = client.post(url, json=payload)
                        response.raise_for_status()
                        data = response.json()
                    self.base_url = base_url
                    return data
                except httpx.ConnectError as exc:
                    last_error = exc
                    if attempt < self.CONNECT_RETRY_ATTEMPTS - 1:
                        time.sleep(self.CONNECT_RETRY_DELAY_SECONDS * (attempt + 1))
                        continue
                    break
                except Exception as exc:
                    last_error = exc
                    break
        if last_error is not None:
            raise RuntimeError(f"Ollama request failed: {self._describe_error(last_error)}")
        raise RuntimeError("No Ollama endpoints were reachable")

    def _section_batches(self, section: dict, max_fields: int | None = None) -> list[dict]:
        max_fields = max_fields or self.MAX_FIELDS_PER_PROMPT
        fields = section.get("fields", [])
        if not fields or len(fields) <= max_fields:
            return [section]

        batches: list[dict] = []
        for start in range(0, len(fields), max_fields):
            batches.append({
                **section,
                "fields": fields[start:start + max_fields],
            })
        return batches

    def _filter_valid_fields(self, template_schema: dict, parsed: dict) -> dict:
        """Filters out hallucinative fields (like scope_label) not present in schema."""
        valid_field_ids = {
            field.get("field_id")
            for section in template_schema.get("sections", [])
            for field in section.get("fields", [])
            if field.get("field_id")
        }

        filtered_fields = [
            field for field in parsed.get("fields", [])
            if isinstance(field, dict) and field.get("field_id") in valid_field_ids
        ]

        parsed["fields"] = filtered_fields
        return parsed

    async def _extract_single_schema_async(self, client: httpx.AsyncClient, template_schema: dict, pages: list[dict], semaphore: "asyncio.Semaphore") -> dict:
        prompt = self._build_prompt(template_schema, pages)
        async with semaphore:
            data = await self._call_ollama_generate_async(client, prompt)
        raw_text = data.get("response", "")
        try:
            parsed = json.loads(raw_text)
        except (json.JSONDecodeError, TypeError) as exc:
            raise RuntimeError(f"Model response was not valid JSON ({exc}).") from exc

        if not isinstance(parsed, dict) or "fields" not in parsed:
            raise RuntimeError("Model response missing expected 'fields' key.")
        if not isinstance(parsed.get("fields", []), list):
            raise RuntimeError("Model response 'fields' key was not a list.")

        return self._filter_valid_fields(template_schema, parsed)

    def _extract_single_schema(self, template_schema: dict, pages: list[dict]) -> dict:
        prompt = self._build_prompt(template_schema, pages)
        data = self._call_ollama_generate(prompt)
        raw_text = data.get("response", "")
        try:
            parsed = json.loads(raw_text)
        except (json.JSONDecodeError, TypeError) as exc:
            raise RuntimeError(f"Model response was not valid JSON ({exc}).") from exc

        if not isinstance(parsed, dict) or "fields" not in parsed:
            raise RuntimeError("Model response missing expected 'fields' key.")
        if not isinstance(parsed.get("fields", []), list):
            raise RuntimeError("Model response 'fields' key was not a list.")

        return self._filter_valid_fields(template_schema, parsed)

    async def extract_async(self, template_schema: dict, pages: list[dict]) -> dict:
        if not self.base_url:
            raise RuntimeError("MODEL_URL is not configured")

        sections = template_schema.get("sections", [])
        if not sections:
            return {
                "template_id": template_schema.get("template_id"),
                "template_version": template_schema.get("version"),
                "fields": [],
            }

        batch_schemas = []
        for section in sections:
            for section_batch in self._section_batches(section):
                batch_schemas.append({
                    **template_schema,
                    "sections": [section_batch],
                })

        async with httpx.AsyncClient() as client:
            semaphore = asyncio.Semaphore(self.max_concurrent_requests)
            tasks = [self._extract_single_schema_async(client, schema, pages, semaphore) for schema in batch_schemas]
            results = await asyncio.gather(*tasks)

        combined_fields: list[dict] = []
        for section_result in results:
            combined_fields.extend(section_result.get("fields", []))

        return {
            "template_id": template_schema.get("template_id"),
            "template_version": template_schema.get("version"),
            "fields": combined_fields,
        }

    def extract(self, template_schema: dict, pages: list[dict]) -> dict:
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            loop = None

        if loop and loop.is_running():
            import nest_asyncio
            nest_asyncio.apply()
            return loop.run_until_complete(self.extract_async(template_schema, pages))
        else:
            return asyncio.run(self.extract_async(template_schema, pages))

    def extract_batch(self, template_schema: dict, pages: list[dict]) -> dict:
        return self.extract(template_schema, pages)

    def validate_and_extract(self, prompt: str) -> dict:
        if not self.base_url:
            return {"reasoning": "Model not configured", "suggestions": [], "confidence_scores": {}, "needs_review": True}

        last_error = None
        for base_url in self._candidate_urls():
            url = f"{base_url.rstrip('/')}/api/generate"
            payload = {
                "model": self.model_name,
                "prompt": prompt,
                "stream": False,
                "options": {"temperature": 0.3, "num_predict": 512},
            }
            try:
                with httpx.Client(timeout=self.timeout) as client:
                    response = client.post(url, json=payload)
                    response.raise_for_status()
                    data = response.json()
                self.base_url = base_url
                raw_text = data.get("response", "")

                return {
                    "reasoning": raw_text,
                    "suggestions": self._parse_suggestions(raw_text),
                    "confidence_scores": self._parse_confidence_scores(raw_text),
                    "needs_review": "uncertain" in raw_text.lower() or "unclear" in raw_text.lower(),
                }
            except Exception as exc:
                last_error = exc
                continue

        return {"reasoning": f"Error: {self._describe_error(last_error) if last_error else 'unknown'}", "suggestions": [], "confidence_scores": {}, "needs_review": True}

    def _parse_suggestions(self, response: str) -> list[dict]:
        suggestions = []
        for line in response.split("\n"):
            if ":" in line and any(kw in line.lower() for kw in ["extract", "found", "value"]):
                parts = line.split(":", 1)
                if len(parts) == 2:
                    suggestions.append({"field": parts[0].strip(), "value": parts[1].strip()})
        return suggestions

    def _parse_confidence_scores(self, response: str) -> dict:
        scores = {}
        import re
        confidence_pattern = r"(\w+(?:\s+\w+)*?)[\s:]+(\d+(?:\.\d+)?)\s*%?"
        for match in re.finditer(confidence_pattern, response):
            field_name = match.group(1).strip()
            confidence = float(match.group(2))
            if confidence > 1:
                confidence = confidence / 100 
            scores[field_name] = min(confidence, 1.0)
        return scores