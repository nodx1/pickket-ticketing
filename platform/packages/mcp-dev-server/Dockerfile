FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 의존성 먼저 설치 (캐시 최적화)
COPY packages/mcp-dev-server/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 소스 복사
COPY packages/mcp-dev-server/ .

EXPOSE 8022

CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8022", "--workers", "1"]
