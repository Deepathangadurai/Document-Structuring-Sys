from pathlib import Path
from pydantic_settings import BaseSettings, SettingsConfigDict

# Get the directory where config.py lives (.../backend/app/core).
# parents[2] would be "backend" itself, but templates/ and storage/ live one
# level above that -- at the repo root locally, and at the container root
# in Docker (docker-compose mounts ./templates -> /templates and
# ./storage -> /storage, which sit next to /app, not inside it).
# parents[3] resolves correctly in both cases.
BASE_DIR = Path(__file__).resolve().parents[3]
STORAGE_BASE = BASE_DIR / "storage"

class Settings(BaseSettings):
    # SQLite for now (file lives under storage/, gitignored, zero setup).
    # SQLAlchemy's Session/Query API is identical across backends, so
    # switching to Postgres later is a one-line change to this URL (and
    # `pip install psycopg2-binary`) - nothing in app code references
    # sqlite-specific syntax except the check_same_thread flag in database.py.
    DATABASE_URL: str = f"sqlite:///{STORAGE_BASE / 'app.db'}"
    QDRANT_URL: str = "http://localhost:6333"
    QDRANT_COLLECTION: str = "documents"
    
    # Store files inside the project folder
    STORAGE_PATH: str = str(STORAGE_BASE)
    TEMPLATE_PATH: str = str(BASE_DIR / "templates")
    STORAGE_ORIGINALS_PATH: str = str(STORAGE_BASE / "originals")
    STORAGE_PROCESSED_PATH: str = str(STORAGE_BASE / "processed")
    STORAGE_PAGES_PATH: str = str(STORAGE_BASE / "pages")
    
    MAX_UPLOAD_SIZE: int = 524288000
    # Only the real Qwen2.5-VL-via-Ollama provider is supported. This field
    # is kept (rather than hardcoded) so it shows up in /api/model/health,
    # but ModelService no longer branches on it to select a mock provider --
    # there is no mock provider in this codebase anymore.
    MODEL_PROVIDER: str = "qwen2.5-vl"
    MODEL_URL: str = "http://localhost:11434"
    MODEL_NAME: str = "qwen2.5vl:7b"
    MODEL_DEVICE: str = "auto"
    MODEL_TIMEOUT_SECONDS: int = 120
    # A single local Ollama process handling one model instance can refuse
    # connections outright (errno 111) under too many simultaneous requests.
    # Raise this only if Ollama is running with multiple parallel model
    # slots (OLLAMA_NUM_PARALLEL) or on a beefier machine.
    MODEL_MAX_CONCURRENT_REQUESTS: int = 2
    DOCUMENT_CHUNK_SIZE: int = 10
    LIBREOFFICE_PATH: str | None = None
    # Gotenberg (https://gotenberg.dev) runs LibreOffice and exposes it as
    # an HTTP conversion service. No-Docker setup: run `gotenberg` as a
    # local binary/service on localhost, or leave unset to disable and use
    # the direct soffice/Word path only.
    GOTENBERG_URL: str | None = "http://localhost:3000"
    GOTENBERG_TIMEOUT_SECONDS: int = 60
    JWT_SECRET: str = "change-me"

    # Resolve the .env file deterministically from this file's location
    # rather than from the process's current working directory. The old
    # value ("../.env", resolved relative to cwd at process start) meant
    # the *same* code loaded a different file -- or no file at all --
    # depending on whether uvicorn was launched from the repo root,
    # from backend/, or from inside the Docker image (WORKDIR /app has no
    # parent .env). That silently dropped MODEL_PROVIDER/MODEL_URL in some
    # startup paths, which is what made the app fall back to defaults.
    model_config = SettingsConfigDict(env_file=str(BASE_DIR / ".env"), extra="ignore")

settings = Settings()