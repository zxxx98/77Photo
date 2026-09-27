"""Optional real-weight tests: FACE_TEST_MODELS=/path/to/models pytest tests/.

These compare CPU reference math, not Windows CUDA compatibility.
"""
import json
import os
from pathlib import Path
import sys

import pytest

MODELS = os.environ.get("FACE_TEST_MODELS")
pytestmark = pytest.mark.skipif(not MODELS, reason="set FACE_TEST_MODELS to verified model directory")


def test_sface_matches_opencv_and_serializes():
    import cv2
    import numpy as np
    import onnxruntime as ort
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from engine import Engine
    path = str(Path(MODELS) / "sface.onnx")
    options = ort.SessionOptions()
    options.log_severity_level = 3
    session = ort.InferenceSession(path, sess_options=options, providers=["CPUExecutionProvider"])
    engine = Engine.__new__(Engine)
    engine.session = session
    engine.input_name = session.get_inputs()[0].name
    engine.mean, engine.std, engine.dimension = 0, 1, 128
    engine.aligner = cv2.FaceRecognizerSF.create(path, "")
    engine.profile = {"api_version": "1", "embedding_dim": 128}
    crop = np.random.default_rng(77).integers(0, 255, (112, 112, 3), dtype=np.uint8)
    actual = engine._embedding(crop)
    reference = engine.aligner.feature(crop).reshape(-1)
    reference /= np.linalg.norm(reference)
    assert float(np.dot(actual, reference)) > 0.9999

    class Detector:
        def setInputSize(self, _):
            pass
        def detect(self, _):
            return None, np.array([[0, 0, 112, 112, 38, 52, 73, 52, 56, 72, 42, 92, 71, 92, .99]], dtype=np.float32)

    engine.detector = Detector()
    raw = cv2.imencode(".jpg", crop)[1].tobytes()
    result = engine.analyze(raw)
    json.dumps(result)  # Catch numpy scalars leaking into HTTP responses.
    assert result["faces"][0]["quality"]["usable"] is True
    assert result["faces"][0]["embedding"]


def test_cpu_only_host_refuses_production_engine():
    import onnxruntime as ort
    if "CUDAExecutionProvider" in ort.get_available_providers():
        pytest.skip("this assertion targets a CPU-only test environment")
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from engine import Engine
    with pytest.raises(RuntimeError, match="CUDA provider unavailable"):
        Engine(MODELS)
