"""Download and verify the Piper Huayan model used for local narration."""
import argparse
from hashlib import file_digest
from pathlib import Path
from shutil import copyfileobj, which
import subprocess
from urllib.error import URLError
from urllib.request import urlopen

SOURCE = "https://huggingface.co/rhasspy/piper-voices/resolve/2f8dbe0/zh/zh_CN/huayan/medium/"
FILES = {
    "zh_CN-huayan-medium.onnx": "9929917bf8cabb26fd528ea44d3a6699c11e87317a14765312420be230be0f3d",
    "zh_CN-huayan-medium.onnx.json": "d521dc45504a8ccc99e325822b35946dd701840bfb07e3dbb31a40929ed6a82b",
}


def verified(path, expected):
    if not path.is_file():
        return False
    with path.open("rb") as file:
        return file_digest(file, "sha256").hexdigest() == expected


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default=SOURCE, help="同一版本模型的 HTTPS 下载目录")
    args = parser.parse_args()
    if not args.base_url.startswith("https://"):
        parser.error("--base-url 必须使用 HTTPS。")
    folder = Path(__file__).resolve().parent / "models"
    folder.mkdir(exist_ok=True)
    curl = which("curl.exe")
    for name, expected in FILES.items():
        target = folder / name
        if verified(target, expected):
            print(f"已验证 {name}", flush=True)
            continue
        partial = target.with_suffix(target.suffix + ".part")
        url = args.base_url.rstrip("/") + "/" + name
        print(f"下载 {name}", flush=True)
        try:
            if curl:
                subprocess.run([curl, "--fail", "--location", "--silent", "--show-error",
                                "--proto", "=https", "--proto-redir", "=https", "--connect-timeout", "20",
                                "--output", str(partial), url], check=True, timeout=600)
            else:
                with urlopen(url, timeout=30) as response, partial.open("wb") as file:
                    copyfileobj(response, file)
            if not verified(partial, expected):
                raise ValueError(f"{name} 的 SHA-256 与预期不符")
            partial.replace(target)
        except (URLError, OSError, ValueError, subprocess.SubprocessError) as exc:
            raise SystemExit(f"语音下载失败：{exc}\n可在 README 找到手动下载或更换下载源的说明。") from exc
        finally:
            partial.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
