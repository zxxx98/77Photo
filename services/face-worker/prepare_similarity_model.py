"""Export pinned torchvision ResNet18 whole-image features to offline ONNX.

Run in a separate preparation environment with requirements-prepare.txt.
The serving container continues to use ONNX Runtime, without PyTorch.
"""
import argparse
import hashlib
import json
from pathlib import Path
import urllib.request

import torch
from torchvision.models import ResNet18_Weights, resnet18


def prepare(root):
    root = Path(root)
    root.mkdir(parents=True, exist_ok=True)
    weights = ResNet18_Weights.IMAGENET1K_V1
    # torchvision downloads the versioned official weight URL and checks its
    # published SHA-256 prefix before loading. Inference never downloads it.
    model = resnet18(weights=weights).eval()
    extractor = torch.nn.Sequential(*list(model.children())[:-1], torch.nn.Flatten(1)).eval()
    target = root / "resnet18-image.onnx"
    temporary = root / "resnet18-image.tmp.onnx"
    with torch.inference_mode():
        torch.onnx.export(extractor, torch.zeros(1, 3, 224, 224), str(temporary),
            input_names=["image"], output_names=["embedding"], opset_version=17, dynamo=False)
    temporary.replace(target)
    with urllib.request.urlopen("https://raw.githubusercontent.com/pytorch/vision/v0.22.1/LICENSE", timeout=30) as response:
        (root / "torchvision-LICENSE.txt").write_bytes(response.read(65536))
    manifest = {"file": target.name, "sha256": hashlib.sha256(target.read_bytes()).hexdigest(),
        "embedding_model_id": "resnet18-imagenet1k-v1-global-average", "embedding_dim": 512,
        "source": weights.url, "license": "torchvision BSD-3-Clause; see torchvision-LICENSE.txt",
        "preprocessing": "rgb-entire-frame-area-resize224-imagenet-normalization-v1",
        "mean": [.485, .456, .406], "std": [.229, .224, .225]}
    (root / "similarity-manifest.json").write_text(json.dumps(manifest, indent=2)+"\n", encoding="utf-8")
    print(f"Similarity model and license are ready in {root}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", default=str(Path(__file__).parent / "models"))
    prepare(parser.parse_args().output)
