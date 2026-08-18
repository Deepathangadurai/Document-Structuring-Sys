from abc import ABC, abstractmethod

class ModelServiceConfigurationError(Exception):
    """Raised when the model service configuration is missing or invalid."""
    pass

class ModelProvider(ABC):
    @abstractmethod
    def is_available(self) -> bool:
        raise NotImplementedError

    @abstractmethod
    def health(self) -> dict:
        raise NotImplementedError

    @abstractmethod
    def extract(self, template_schema: dict, pages: list[dict]) -> dict:
        raise NotImplementedError

    @abstractmethod
    def extract_batch(self, template_schema: dict, pages: list[dict]) -> dict:
        raise NotImplementedError

    @abstractmethod
    def validate_and_extract(self, prompt: str) -> dict:
        """Validate and extract field values using a custom prompt."""
        raise NotImplementedError