# 77Photo local GPU face worker

This service implements the private `/v1/health` and `/v1/analyze` protocol used by 77Photo. It performs YuNet face detection on CPU and SFace feature extraction with ONNX Runtime CUDA. It stores no photos or face database. A model manifest and verified weights are required before startup.

For Windows installation and R5S configuration, see [the deployment guide](../../docs/operations/face-recognition.md). Run `py -3 prepare_models.py`, create `.env` from `.env.example`, then `docker compose build && docker compose up -d` from this directory. The model script pins OpenCV Zoo to commit `47534e27c9851bb1128ccc0102f1145e27f23f98` and validates both weight hashes. It also saves the original MIT and Apache-2.0 model licenses. The Dockerfile pins candidate package versions; actual Windows GPU compatibility still needs validation on the target PC.

The service requires a 32-character secret in `FACE_API_KEY`. All requests use `Authorization: Bearer <secret>`. `/v1/health` reports the model profile after CUDA initialization and warmup. `/v1/analyze` accepts one EXIF-free JPEG under 1280px via multipart with `request_id` and `pipeline_id`. It returns normalized face boxes and little-endian float32 embeddings encoded as Base64. A mismatched pipeline returns 409, concurrent inference returns 429, and an unavailable CUDA session fails startup or returns 503.

Run API and optional real-weight CPU reference tests with:

```bash
python -m venv .venv
.venv/bin/pip install -r requirements.txt -r requirements-test.txt
FACE_TEST_MODELS=./models .venv/bin/pytest -q tests
```

On Windows, use the equivalent `.venv\Scripts\pip.exe` and `.venv\Scripts\pytest.exe` paths. CPU reference tests only verify math and response format. The final CUDA test must be run in the GPU container on the Windows PC.
