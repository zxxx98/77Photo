import base64
import io
import json
import sys
from pathlib import Path

import cv2
import numpy as np
import pytest
from PIL import Image
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import create_app
from similarity import verify_local, unpack_local
from test_api import FakeEngine, TOKEN, jpeg


class FakeSimilarity:
    profile = {"api_version": "1", "pipeline_id": "whole-image", "embedding_model_id": "image", "embedding_dim": 16, "device": "cuda"}
    def analyze(self, raw):
        return {**self.profile, "embedding_encoding": "float32-le-base64", "embedding": "AA==",
                "local_features": {"points": "", "descriptors": ""}}


def test_optional_similarity_and_existing_face_api():
    with TestClient(create_app(FakeEngine, TOKEN)) as c:
        assert c.get("/v1/similarity/health", headers={"Authorization": f"Bearer {TOKEN}"}).status_code == 503
    with TestClient(create_app(FakeEngine, TOKEN, FakeSimilarity)) as c:
        headers = {"Authorization": f"Bearer {TOKEN}"}
        assert c.get("/v1/similarity/health").status_code == 401
        assert c.get("/v1/similarity/health", headers=headers).json()["pipeline_id"] == "whole-image"
        args = dict(headers=headers, files={"image": ("preview.jpg", jpeg())}, data={"request_id": "one", "pipeline_id": "whole-image"})
        result = c.post("/v1/similarity/analyze", **args)
        assert result.status_code == 200 and result.json()["request_id"] == "one"
        assert "faces" not in result.json()
        args["data"]["pipeline_id"] = "test"
        assert c.post("/v1/similarity/analyze", **args).status_code == 409
        assert c.get("/v1/health", headers=headers).json()["pipeline_id"] == "test"
        assert c.post("/v1/similarity/verify", headers=headers, json={"pipeline_id": "whole-image", "left": {}, "right": {}}).status_code == 422
        assert c.post("/v1/similarity/verify", headers=headers, json={"pipeline_id": "old"}).status_code == 409
        assert c.post("/v1/similarity/analyze", headers=headers, files={"image": ("x", b"x"*(8*1024*1024))}, data={"pipeline_id": "whole-image", "request_id": "one"}).status_code == 413


def local(image):
    points, desc = cv2.ORB_create(nfeatures=600).detectAndCompute(image, None)
    points = points[:600]
    if desc is not None:
        desc = desc[:600]
    height, width = image.shape[:2]
    xy = np.array([[p.pt[0]/width, p.pt[1]/height] for p in points], dtype="<f4").reshape(-1, 2)
    if desc is None:
        desc = np.empty((0, 32), dtype=np.uint8)
    return {"points": base64.b64encode(xy.tobytes()).decode(), "descriptors": base64.b64encode(desc.tobytes()).decode()}


def test_geometric_verification_accepts_crop_and_rejects_unrelated_images():
    rng = np.random.default_rng(77)
    image = np.full((800, 1000), 128, dtype=np.uint8)
    for _ in range(250):
        x, y = rng.integers(50, 750, 2)
        cv2.circle(image, (int(x), int(y)), int(rng.integers(4, 15)), int(rng.integers(0, 256)), -1)
    cv2.putText(image, "77Photo / crop test", (100, 400), cv2.FONT_HERSHEY_SIMPLEX, 2, 255, 4)
    crop = image[80:720, 100:900].copy()
    assert verify_local(local(image), local(crop))
    assert not verify_local(local(image), local(rng.integers(0, 256, image.shape, dtype=np.uint8)))
    assert not verify_local(local(image), local(np.zeros(image.shape, dtype=np.uint8)))


def test_local_feature_boundary_rejects_malformed_vectors():
    for bad in ({}, {"points": "!", "descriptors": ""},
                {"points": base64.b64encode(np.array([np.nan, 0], dtype="<f4").tobytes()).decode(), "descriptors": base64.b64encode(bytes(32)).decode()},
                {"points": base64.b64encode(bytes(8*601)).decode(), "descriptors": base64.b64encode(bytes(32*601)).decode()}):
        with pytest.raises(ValueError):
            unpack_local(bad)


def test_exported_model_cpu_reference_when_supplied():
    import os
    root = os.environ.get("SIMILARITY_TEST_MODELS")
    if not root:
        pytest.skip("optional exported model not supplied")
    import onnxruntime as ort
    m = json.loads((Path(root)/"similarity-manifest.json").read_text())
    session = ort.InferenceSession(str(Path(root)/m["file"]), providers=["CPUExecutionProvider"])
    assert session.get_inputs()[0].shape == [1, 3, 224, 224]
    tensor = np.zeros((1, 3, 224, 224), dtype=np.float32)
    output = session.run(None, {session.get_inputs()[0].name: tensor})[0].reshape(-1)
    assert output.size == m["embedding_dim"] and np.isfinite(output).all() and np.linalg.norm(output) > 0
