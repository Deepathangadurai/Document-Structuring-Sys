import os
import requests

BACKEND = os.getenv('BACKEND_URL', 'http://localhost:8000/api/health')
QDRANT = os.getenv('QDRANT_URL', 'http://localhost:6333')
POSTGRES = os.getenv('POSTGRES_URL', 'http://localhost:5432')


def main():
    results = {}
    try:
        r = requests.get(BACKEND, timeout=3.0)
        results['backend'] = r.status_code
    except Exception as e:
        results['backend'] = str(e)
    try:
        r = requests.get(f"{QDRANT}/api/v1/collections", timeout=3.0)
        results['qdrant'] = r.status_code
    except Exception as e:
        results['qdrant'] = str(e)
    print(results)

if __name__ == '__main__':
    main()
