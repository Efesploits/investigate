FROM python:3.11-slim

# Torch pulls a lot of CUDA by default; the CPU wheels are a fraction of the
# size and free Space hardware has no GPU to use anyway.
ENV PIP_EXTRA_INDEX_URL=https://download.pytorch.org/whl/cpu \
    HF_HOME=/data/hf \
    PORT=7860

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .
EXPOSE 7860
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "7860"]
