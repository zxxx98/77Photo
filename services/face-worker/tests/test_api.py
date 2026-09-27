import io
import sys
from pathlib import Path

import pytest
from PIL import Image
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import create_app

TOKEN = "t" * 32

class FakeEngine:
    profile = {"api_version": "1", "pipeline_id": "test", "embedding_model_id": "test", "embedding_dim": 512, "device": "cuda"}
    def analyze(self, raw):
        return {**self.profile, "image": {"width": 64, "height": 64}, "faces": []}

@pytest.fixture
def client():
    with TestClient(create_app(FakeEngine, TOKEN)) as c:
        yield c

def jpeg(size=(64, 64)):
    out = io.BytesIO()
    Image.new("RGB", size).save(out, format="JPEG")
    return out.getvalue()

def post(c, raw, pipeline="test"):
    return c.post("/v1/analyze", headers={"Authorization": f"Bearer {TOKEN}"}, files={"image": ("x.jpg", raw)}, data={"pipeline_id": pipeline, "request_id": "one"})

def test_auth_and_health(client):
    assert client.get("/v1/health").status_code == 401
    assert client.get("/v1/health", headers={"Authorization": f"Bearer {TOKEN}"}).json()["device"] == "cuda"

def test_no_faces_success(client):
    response = post(client, jpeg())
    assert response.status_code == 200
    assert response.json()["faces"] == []
    assert response.json()["request_id"] == "one"

def test_mismatch_and_invalid_image(client):
    assert post(client, jpeg(), "old-model").status_code == 409
    assert post(client, b"not an image").status_code == 422
    assert post(client, jpeg((1281, 10))).status_code == 422

def test_body_limit(client):
    assert post(client, b"x" * (8 * 1024 * 1024)).status_code == 413

def test_secret_required():
    with pytest.raises(ValueError):
        create_app(FakeEngine, "short")
