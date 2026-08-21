FROM python:3.12-slim

WORKDIR /app

# numpy만 필수, ortools는 선택 (VCG에 불필요)
RUN pip install --no-cache-dir fastapi uvicorn numpy

COPY talkfile_engine/ ./talkfile_engine/
COPY api/ ./api/

EXPOSE 8100

CMD ["uvicorn", "api.main:app", "--host", "0.0.0.0", "--port", "8100"]
