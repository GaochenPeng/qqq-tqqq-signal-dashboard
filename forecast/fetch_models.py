"""下载固定版本的公开权重，并校验文件。"""
import hashlib
import json
from pathlib import Path

from huggingface_hub import hf_hub_download

here = Path(__file__).resolve().parent
for model in json.loads((here / "models.json").read_text()):
    destination = here / ".models" / model["id"]
    for name in ("config.json", "model.safetensors"):
        filename = hf_hub_download(model["repo"], filename=name, revision=model["revision"], local_dir=destination)
    with Path(filename).open("rb") as handle:
        if hashlib.file_digest(handle, "sha256").hexdigest() != model["sha256"]:
            Path(filename).unlink()
            raise RuntimeError(f"{model['name']} 的公开权重校验失败")
    print(f"{model['name']} 已校验")
