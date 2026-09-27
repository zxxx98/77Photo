"""Local-only YuNet detection and CUDA ONNX feature extraction.

Weights are supplied by the operator with a hash-checked manifest. No model
registry downloads, cloud inference, or persistent image storage are used.
"""
import base64
import hashlib
import json
from pathlib import Path

import cv2
import numpy as np
import onnxruntime as ort


class Engine:
    def __init__(self, model_dir: str):
        root = Path(model_dir).resolve()
        self.manifest = m = json.loads((root / "manifest.json").read_text())
        for field in ("license", "source", "embedding_model_id"):
            if not isinstance(m.get(field), str) or not m[field].strip():
                raise ValueError(f"manifest requires {field}")
        if len(m["embedding_model_id"]) > 100:
            raise ValueError("embedding model ID too long")
        paths = {}
        for key in ("detector", "recognizer"):
            item = m[key]
            path = (root / item["file"]).resolve()
            if root not in path.parents or not path.is_file():
                raise ValueError("model must be a file within model directory")
            if hashlib.sha256(path.read_bytes()).hexdigest() != item["sha256"]:
                raise ValueError(f"{key} checksum mismatch")
            paths[key] = str(path)
        if "CUDAExecutionProvider" not in ort.get_available_providers():
            raise RuntimeError("CUDA provider unavailable")
        self.dimension = int(m["embedding_dim"])
        if not 16 <= self.dimension <= 4096:
            raise ValueError("invalid embedding dimension")
        self.mean = float(m.get("input_mean", 0))
        self.std = float(m.get("input_std", 1))
        if not np.isfinite(self.mean) or not np.isfinite(self.std) or self.std <= 0:
            raise ValueError("invalid input normalization")
        self.aligner = cv2.FaceRecognizerSF.create(paths["recognizer"], "")
        self.detector = cv2.FaceDetectorYN.create(paths["detector"], "", (320, 320), 0.85, 0.3, 5000)
        options = ort.SessionOptions()
        options.intra_op_num_threads = 2
        options.log_severity_level = 3
        self.session = ort.InferenceSession(paths["recognizer"], sess_options=options,
                                           providers=[("CUDAExecutionProvider", {"gpu_mem_limit": 4 * 1024**3})])
        if "CUDAExecutionProvider" not in self.session.get_providers():
            raise RuntimeError("CUDA initialization failed; CPU fallback refused")
        self.session.disable_fallback()
        inputs = self.session.get_inputs()
        if len(inputs) != 1 or inputs[0].shape[1:] != [3, 112, 112]:
            raise ValueError("recognizer must take NCHW 112x112 float input")
        self.input_name = inputs[0].name
        # Weight hashes, preprocessing and implementation version determine compatibility.
        digest = hashlib.sha256(json.dumps(m, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        self.profile = {"api_version": "1", "pipeline_id": f"yunet-sface-v1-{digest}",
                        "embedding_model_id": f"{m['embedding_model_id']}-{digest}",
                        "embedding_dim": self.dimension, "device": "cuda"}
        self._embedding(np.zeros((112, 112, 3), dtype=np.uint8))

    def _embedding(self, crop):
        rgb = cv2.cvtColor(crop, cv2.COLOR_BGR2RGB)
        tensor = ((rgb.astype(np.float32) - self.mean) / self.std).transpose(2, 0, 1)[None]
        vector = self.session.run(None, {self.input_name: tensor})[0].reshape(-1).astype(np.float32)
        norm = np.linalg.norm(vector)
        if vector.size != self.dimension or not np.isfinite(vector).all() or norm < 1e-8:
            raise ValueError("invalid model output")
        return vector / norm

    def analyze(self, raw: bytes):
        img = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)
        if img is None:
            raise ValueError("invalid image")
        height, width = img.shape[:2]
        if width > 1280 or height > 1280 or min(width, height) < 1:
            raise ValueError("expected a preview no larger than 1280 pixels")
        # The Go service has already corrected EXIF; inputs here must be stripped JPEG.
        self.detector.setInputSize((width, height))
        _, detections = self.detector.detect(img)
        detections = [] if detections is None else detections
        if len(detections) > 100:
            raise ValueError("too many faces")
        faces = []
        for row in detections:
            x, y, w, h = [float(v) for v in row[:4]]
            x1, y1, x2, y2 = max(0., x), max(0., y), min(float(width), x+w), min(float(height), y+h)
            if x2 <= x1 or y2 <= y1:
                continue
            usable = bool(min(w, h) >= 32 and np.isfinite(row).all())
            encoded = ""
            if usable:
                crop = self.aligner.alignCrop(img, row)
                encoded = base64.b64encode(self._embedding(crop).astype("<f4").tobytes()).decode()
            faces.append({"index": len(faces), "bbox": [x1/width, y1/height, (x2-x1)/width, (y2-y1)/height],
                          "detection_score": float(row[-1]), "quality": {"usable": usable, "reasons": [] if usable else ["SMALL_OR_UNALIGNED"]},
                          "embedding_encoding": "float32-le-base64", "embedding": encoded})
        return {**self.profile, "image": {"width": width, "height": height}, "faces": faces}
