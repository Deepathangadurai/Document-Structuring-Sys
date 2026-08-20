import sys
from pathlib import Path
from pydantic_settings import BaseSettings, SettingsConfigDict

# Get the directory where config.py lives (.../backend/app/core).
BASE_DIR = Path(__file__).resolve().parents[3]
STORAGE_BASE = BASE_DIR / "storage"

class Settings(BaseSettings):
    DATABASE_URL: str = "postgresql+psycopg2://postgres:postgres@postgres:5432/documentdb"
    QDRANT_URL: str = "http://qdrant:6333"
    QDRANT_COLLECTION: str = "documents"
    
    # Store files inside the project folder
    STORAGE_PATH: str = str(STORAGE_BASE)
    TEMPLATE_PATH: str = str(BASE_DIR / "templates")
    STORAGE_ORIGINALS_PATH: str = str(STORAGE_BASE / "originals")
    STORAGE_PROCESSED_PATH: str = str(STORAGE_BASE / "processed")
    STORAGE_PAGES_PATH: str = str(STORAGE_BASE / "pages")
    
    MAX_UPLOAD_SIZE: int = 524288000
    MODEL_PROVIDER: str = "qwen2.5-vl"
    MODEL_URL: str = "http://localhost:11434"
    MODEL_NAME: str = "qwen2.5vl:7b"
    MODEL_DEVICE: str = "auto"
    MODEL_TIMEOUT_SECONDS: int = 120
    DOCUMENT_CHUNK_SIZE: int = 10

    # Auto-detect LibreOffice binary path based on operating system
    LIBREOFFICE_PATH: str = (
        r"C:\Program Files\LibreOffice\program\soffice.exe"
        if sys.platform == "win32"
        else "/usr/bin/libreoffice"
    )

    GOTENBERG_URL: str | None = "http://gotenberg:3000"
    GOTENBERG_TIMEOUT_SECONDS: int = 60
    JWT_SECRET: str = "change-me"

    model_config = SettingsConfigDict(
        env_file=[
            str(BASE_DIR / ".env"),
            str(BASE_DIR / "backend" / ".env"),
        ],
        extra="ignore",
    )

settings = Settings()


 # Gotenberg (https://gotenberg.dev) runs LibreOffice inside a disposable
    # Docker container and exposes it as an HTTP conversion service. Using
    # it instead of shelling out to a `soffice` binary installed directly on
    # the host avoids host-level LibreOffice install corruption (stale
    # profile locks, a broken bootstrap.ini, etc.) taking down document
    # conversion - every request gets a clean container. Point this at your
    # gotenberg container (docker-compose service name "gotenberg" inside
    # the compose network, "localhost" if running it standalone locally).
    # Leave unset/empty to disable and use the direct soffice/Word path only.
  
    # Resolve the environment files deterministically from this file's location.
    # The repo root .env is the Compose/default configuration, while
    # backend/.env is the local override used when the backend runs outside
    # Docker. Putting the local override last ensures it wins over the compose
    # defaults without requiring shell exports.