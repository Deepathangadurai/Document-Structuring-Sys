from app.services.model.base import ModelServiceConfigurationError
from app.services.model.qwen_vl import QwenVLProvider


class ModelService:
    """
    Thin wrapper around the real Qwen2.5-VL (via Ollama) provider.

    There is intentionally no mock/dummy provider and no fallback path here.
    If Ollama or the Qwen2.5-VL model is unavailable, `is_available()` /
    `health()` report that clearly and callers (see
    ExtractionService.process_job) must fail the extraction job with that
    reason rather than proceeding with fabricated data.
    """

    def __init__(self):
        self.provider = QwenVLProvider()

    def health(self) -> dict:
        return self.provider.health()

    def is_available(self) -> bool:
        return self.provider.is_available()

    def extract(self, template_schema: dict, pages: list[dict]) -> dict:
        return self.provider.extract(template_schema, pages)

    def extract_batch(self, template_schema: dict, pages: list[dict]) -> dict:
        return self.provider.extract_batch(template_schema, pages)

    def validate_and_extract(self, prompt: str) -> dict:
        return self.provider.validate_and_extract(prompt)


__all__ = ["ModelService", "ModelServiceConfigurationError"]