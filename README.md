# Document Structuring System

This repository contains a web application backend and frontend for a fixed-template document structuring system.

The backend is a FastAPI application that exposes:
- Template registry APIs
- Project creation APIs
- Document upload APIs
- Extraction job APIs
- Model health checks
- Database health checks
- Qdrant health checks

The frontend is a React + Vite application that implements the user workflow for selecting a template, creating a project, uploading a document, starting extraction, and viewing structured results.

## Prerequisites

- Docker and Docker Compose
- Node.js 18+ / npm
- Python 3.12+ (for local backend development outside Docker)

## Running with Docker Compose

Use Docker Compose to start the full stack with PostgreSQL, Qdrant, backend, and frontend services.

From the repository root:

```bash
docker compose up --build
```

After startup:

- Backend: http://localhost:8000
- Frontend: http://localhost:5173

### Health checks

Verify the backend and services:

```bash
curl http://localhost:8000/health
curl http://localhost:8000/api/health
curl http://localhost:8000/api/health/db
curl http://localhost:8000/api/health/qdrant
curl http://localhost:8000/api/model/health
```

## Backend Local Development

From the `backend` directory:

```bash
cd backend
python -m venv .venv
.venv\Scripts\activate    # Windows
# or
source .venv/bin/activate  # macOS/Linux
pip install -r requirements.txt
```

Run the backend locally:

```bash
uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
or
python -m uvicorn app.main:app --reload --port 8000
```

The backend will be available at http://localhost:8000.

Note about service hosts when running locally:

- The root `.env` (which docker-compose injects into containers) uses the Docker service hostnames `postgres`, `qdrant`, and `ollama` for `DATABASE_URL`, `QDRANT_URL`, and `MODEL_URL`. Those hostnames only resolve inside the Docker Compose network. If you run the backend locally (outside Docker), point these at `localhost` instead — either export the variables in your shell, or edit `backend/.env`, which `config.py` loads automatically as a local-dev override layered on top of the root `.env` (it has no effect inside Docker, since that path doesn't exist in the container).
- For real extraction to work locally you also need Ollama running with the model pulled: `ollama serve` plus `ollama pull qwen2.5vl:7b` (or whatever tag `MODEL_NAME` is set to). Check `curl http://localhost:8000/api/model/health` to confirm the backend can see it.

Examples — PowerShell (Windows):

```powershell
$env:DATABASE_URL = "postgresql+psycopg2://postgres:postgres@localhost:5432/documentdb"
$env:QDRANT_URL = "http://localhost:6333"
$env:MODEL_URL = "http://localhost:11434"
uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

Examples — macOS / Linux:

```bash
export DATABASE_URL="postgresql+psycopg2://postgres:postgres@localhost:5432/documentdb"
export QDRANT_URL="http://localhost:6333"
export MODEL_URL="http://localhost:11434"
uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

Alternatively, just edit `backend/.env` (already set up with `localhost` defaults for these three) instead of exporting shell variables each time.

### Important directories

- `backend/app` - FastAPI application code
- `backend/requirements.txt` - Python dependencies
- `templates/` - Master template files and schema metadata
- `storage/` - Runtime storage for uploaded documents and extracted pages

## Frontend Local Development

From the `frontend` directory:

```bash
cd frontend
npm install
npm run dev
```

The frontend will be available at http://localhost:5173.

### Important files

- `frontend/src/App.tsx` - main frontend application logic
- `frontend/src/services/api.ts` - frontend API service layer
- `frontend/src/types.ts` - shared TypeScript API models

## Environment Configuration

The project uses a root `.env` file for service configuration (this is what `docker-compose.yml` injects into every container, and what `backend/app/core/config.py` loads by default). `backend/.env` is an optional second layer that only applies when the backend is run locally, outside Docker (see "Backend Local Development" above) — it overrides `localhost`-only values like `DATABASE_URL`, `QDRANT_URL`, and `MODEL_URL`.

Key values include:

- `DATABASE_URL` — must point at a real PostgreSQL instance; there is no SQLite fallback
- `QDRANT_URL`
- `MODEL_PROVIDER` / `MODEL_URL` / `MODEL_NAME` — Ollama server root and the exact Qwen2.5-VL model tag (`ollama list`). There is no mock model provider; if these are wrong or Ollama/the model isn't reachable, `/api/model/health` reports it and any extraction job fails with that reason instead of silently producing empty results.
- `STORAGE_PATH` / `TEMPLATE_PATH`
- `BACKEND_PORT`
- `FRONTEND_PORT`

## Notes

- The backend syncs template metadata from `templates/*/schema.json` at startup.
- The frontend and backend are decoupled and can be run independently or via Docker Compose.
- The model layer talks only to a real Qwen2.5-VL model served through Ollama — there is no mock/dummy provider or fallback. If Ollama is unreachable or the model isn't pulled, `/api/model/health` and any extraction job report that clearly instead of returning fabricated data.


##to check ollama

docker exec -it document-structuring-sys-ollama-1 ollama list
docker compose exec ollama ollama pull qwen2.5vl:7b