"""Whole-image ONNX embeddings and geometric verification, independent of faces."""
import base64
import hashlib
import json
from pathlib import Path

import cv2
import numpy as np
import onnxruntime as ort


class SimilarityEngine:
    def __init__(self, model_dir):
        root = Path(model_dir).resolve()
        manifest = json.loads((root / "similarity-manifest.json").read_text())
        for key in ("source", "license", "embedding_model_id"):
            if not isinstance(manifest.get(key), str) or not manifest[key].strip():
                raise ValueError(f"similarity manifest requires {key}")
        if manifest.get("preprocessing") != "rgb-entire-frame-area-resize224-imagenet-normalization-v1":
            raise ValueError("unsupported similarity preprocessing")
        path = (root / manifest["file"]).resolve()
        if root not in path.parents or not path.is_file():
            raise ValueError("similarity model must be within model directory")
        if hashlib.sha256(path.read_bytes()).hexdigest() != manifest["sha256"]:
            raise ValueError("similarity model checksum mismatch")
        self.dimension = int(manifest["embedding_dim"])
        if not 16 <= self.dimension <= 4096:
            raise ValueError("invalid similarity dimension")
        self.mean = np.asarray(manifest["mean"], dtype=np.float32).reshape(1, 1, 3)
        self.std = np.asarray(manifest["std"], dtype=np.float32).reshape(1, 1, 3)
        if not np.isfinite(self.mean).all() or not np.isfinite(self.std).all() or (self.std <= 0).any():
            raise ValueError("invalid normalization")
        if "CUDAExecutionProvider" not in ort.get_available_providers():
            raise RuntimeError("CUDA similarity provider unavailable")
        options = ort.SessionOptions()
        options.intra_op_num_threads = 2
        options.log_severity_level = 3
        self.session = ort.InferenceSession(str(path), sess_options=options,
            providers=[("CUDAExecutionProvider", {"gpu_mem_limit": 1024**3})])
        if "CUDAExecutionProvider" not in self.session.get_providers():
            raise RuntimeError("CUDA similarity initialization failed")
        self.session.disable_fallback()
        inputs = self.session.get_inputs()
        if len(inputs) != 1 or inputs[0].shape != [1, 3, 224, 224]:
            raise ValueError("similarity input must be float NCHW 1x3x224x224")
        self.input_name = inputs[0].name
        digest = hashlib.sha256(json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        self.profile = {"api_version": "1", "pipeline_id": f"whole-image-orb-v1-{digest}",
            "embedding_model_id": f"{manifest['embedding_model_id']}-{digest}",
            "embedding_dim": self.dimension, "device": "cuda"}
        self.orb = cv2.ORB_create(nfeatures=600)
        self.embedding(np.zeros((224, 224, 3), dtype=np.uint8))

    def embedding(self, image):
        # Keep the entire frame. The manifest pins this resize and normalization.
        image = cv2.resize(image, (224, 224), interpolation=cv2.INTER_AREA)
        rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB).astype(np.float32) / 255
        tensor = ((rgb - self.mean) / self.std).transpose(2, 0, 1)[None]
        vector = self.session.run(None, {self.input_name: tensor})[0].reshape(-1).astype(np.float32)
        norm = np.linalg.norm(vector)
        if vector.size != self.dimension or not np.isfinite(vector).all() or norm < 1e-8:
            raise ValueError("invalid similarity output")
        return vector / norm

    def analyze(self, raw):
        image = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)
        if image is None or max(image.shape[:2]) > 1280:
            raise ValueError("invalid preview")
        height, width = image.shape[:2]
        points, descriptors = self.orb.detectAndCompute(image, None)
        points = points[:600]
        if descriptors is not None:
            descriptors = descriptors[:600]
        xy = np.asarray([[p.pt[0]/width, p.pt[1]/height] for p in points], dtype="<f4").reshape(-1, 2)
        if descriptors is None:
            descriptors = np.empty((0, 32), dtype=np.uint8)
        vector = self.embedding(image)
        return {**self.profile, "embedding_encoding": "float32-le-base64",
            "embedding": base64.b64encode(vector.astype("<f4").tobytes()).decode(),
            "local_features": {"points": base64.b64encode(xy.tobytes()).decode(),
                "descriptors": base64.b64encode(descriptors.tobytes()).decode()}}


def unpack_local(value):
    if not isinstance(value, dict) or set(value) != {"points", "descriptors"}:
        raise ValueError("invalid local features")
    try:
        raw_xy = base64.b64decode(value["points"], validate=True)
        raw_desc = base64.b64decode(value["descriptors"], validate=True)
        if len(raw_xy) % 8 or len(raw_xy) > 600*8 or len(raw_desc) != len(raw_xy)//8*32:
            raise ValueError("invalid feature lengths")
        xy = np.frombuffer(raw_xy, dtype="<f4").reshape(-1, 2)
        desc = np.frombuffer(raw_desc, dtype=np.uint8).reshape(-1, 32)
        if not np.isfinite(xy).all() or (xy < 0).any() or (xy > 1).any():
            raise ValueError("invalid feature positions")
        return xy, desc
    except (KeyError, TypeError, ValueError) as exc:
        raise ValueError("invalid local features") from exc


def verify_local(left, right):
    a, da = unpack_local(left)
    b, db = unpack_local(right)
    if min(len(a), len(b)) < 12:
        return False
    matcher = cv2.BFMatcher(cv2.NORM_HAMMING)
    # Mutual ratio matches reduce false positives in repetitive textures.
    def ratios(first, second):
        return {m.queryIdx: m.trainIdx for pair in matcher.knnMatch(first, second, k=2)
                if len(pair) == 2 for m, n in [pair] if m.distance < .75*n.distance}
    forward, backward = ratios(da, db), ratios(db, da)
    matches = [(i, j) for i, j in forward.items() if backward.get(j) == i]
    if len(matches) < 12:
        return False
    src = np.asarray([a[i] for i, _ in matches], dtype=np.float32)
    dst = np.asarray([b[j] for _, j in matches], dtype=np.float32)
    matrix, mask = cv2.findHomography(src, dst, cv2.RANSAC, .012, maxIters=2000, confidence=.995)
    if matrix is None or mask is None or not np.isfinite(matrix).all():
        return False
    inliers = mask.ravel().astype(bool)
    if inliers.sum() < 12 or inliers.mean() < .4:
        return False
    # Correspondences must cover an area in both photos, rather than one logo.
    for points in (src[inliers], dst[inliers]):
        if cv2.contourArea(cv2.convexHull(points)) < .08:
            return False
    return True
