FROM python:3.11-slim

WORKDIR /app
COPY pyproject.toml ./
COPY app ./app
COPY export_openapi.py smoke_loop.py ./

RUN pip install --no-cache-dir -e .

EXPOSE 8000
ENV BOLTZ_MOCK=1
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
