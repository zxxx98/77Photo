# Candidate CUDA/cuDNN combination; Windows GPU validation is required before release.
FROM nvidia/cuda:12.6.3-cudnn-runtime-ubuntu24.04
ENV DEBIAN_FRONTEND=noninteractive PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 HOME=/tmp
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv libglib2.0-0 libgomp1 \
    && rm -rf /var/lib/apt/lists/* && python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py engine.py similarity.py ./
USER 65532:65532
EXPOSE 8091
CMD ["uvicorn", "app:create_app", "--factory", "--host", "0.0.0.0", "--port", "8091", "--workers", "1", "--no-access-log", "--timeout-keep-alive", "5"]
