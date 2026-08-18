from typing import Tuple
import httpx
import os
from app.core.config import settings

class QdrantService:
    def __init__(self, base_url: str = None):
        self.base_url = base_url or os.getenv("QDRANT_URL") or settings.QDRANT_URL
        if self.base_url.endswith('/'):
            self.base_url = self.base_url[:-1]

    async def health_check(self) -> Tuple[bool, str]:
        # Check collections endpoint
        url = f"{self.base_url}/collections"
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                r = await client.get(url)
                if r.status_code == 200:
                    return True, "ok"
                return False, f"unexpected_status:{r.status_code}"
        except Exception as e:
            return False, str(e)

    def collections(self):
        url = f"{self.base_url}/collections"
        with httpx.Client(timeout=5.0) as client:
            r = client.get(url)
            r.raise_for_status()
            return r.json()
