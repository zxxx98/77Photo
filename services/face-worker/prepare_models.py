"""Download pinned OpenCV Zoo weights and their licenses; inference stays offline."""
import argparse
import hashlib
import json
from pathlib import Path
import urllib.request

COMMIT = "47534e27c9851bb1128ccc0102f1145e27f23f98"
MODELS = {
    "detector": ("face_detection_yunet", "face_detection_yunet_2023mar.onnx", "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4", "yunet.onnx"),
    "recognizer": ("face_recognition_sface", "face_recognition_sface_2021dec.onnx", "0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79", "sface.onnx"),
}


def prepare(root):
    root = Path(root)
    root.mkdir(parents=True, exist_ok=True)
    manifest = {"license": "YuNet: MIT; SFace: Apache-2.0 (see bundled LICENSE files)",
                "source": f"https://github.com/opencv/opencv_zoo/tree/{COMMIT}/models",
                "embedding_model_id": "opencv-sface-2021dec-rgb-v1", "embedding_dim": 128,
                "input_mean": 0, "input_std": 1}
    for key, (folder, name, checksum, local_name) in MODELS.items():
        target = root / local_name
        if not target.exists() or hashlib.sha256(target.read_bytes()).hexdigest() != checksum:
            url = f"https://media.githubusercontent.com/media/opencv/opencv_zoo/{COMMIT}/models/{folder}/{name}"
            with urllib.request.urlopen(url, timeout=120) as response:
                raw = response.read(64 * 1024 * 1024)
            if hashlib.sha256(raw).hexdigest() != checksum:
                raise RuntimeError(f"Checksum mismatch for {name}")
            temporary = root / (local_name + ".tmp")
            temporary.write_bytes(raw)
            temporary.replace(target)
        license_url = f"https://raw.githubusercontent.com/opencv/opencv_zoo/{COMMIT}/models/{folder}/LICENSE"
        with urllib.request.urlopen(license_url, timeout=30) as response:
            (root / (folder + "-LICENSE.txt")).write_bytes(response.read())
        manifest[key] = {"file": local_name, "sha256": checksum}
    (root / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"Verified models and licenses are ready in {root}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", default=str(Path(__file__).parent / "models"))
    prepare(parser.parse_args().output)
