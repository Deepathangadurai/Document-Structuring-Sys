FROM python:3.12-slim

# Install system dependencies including LibreOffice, poppler, tesseract, and fonts
RUN apt-get update && apt-get install -y --no-install-recommends \
    poppler-utils \
    tesseract-ocr \
    libreoffice-writer \
    libreoffice-calc \
    fonts-dejavu-core \
    fonts-liberation \
 && rm -rf /var/lib/apt/lists/*

# Set environment variable so Python tools can locate LibreOffice
ENV LIBREOFFICE_PATH=/usr/bin/libreoffice

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY . /app

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]