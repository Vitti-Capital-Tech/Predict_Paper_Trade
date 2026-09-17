# The worker: a long-lived process that polls Delta every couple of seconds.
# It is not a web service and serves no HTTP — it needs a host that simply
# keeps a process alive.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY predict_paper/ ./predict_paper/
COPY run_live.py verify_setup.py config.yaml ./

# The local JSONL ledger. On most hosts this is ephemeral, which is fine:
# Supabase is the book of record and this is the fallback.
RUN mkdir -p data

CMD ["python", "run_live.py", "--run-name", "cloud"]
