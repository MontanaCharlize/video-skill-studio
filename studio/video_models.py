"""Generate a scene with MiniMax H3 and keep the resulting asset."""
import json
import math
import os
import re
import subprocess
from base64 import b64encode
from pathlib import Path
from shutil import which
from time import monotonic, sleep
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlsplit
from urllib.request import Request, urlopen
from uuid import uuid4

from PIL import Image, ImageOps

from .core import DATA, ROOT, write_json

DEFAULT_MODEL = "MiniMax-H3"
CREATE_TASK = "/v2/video_generation"
QUERY_TASK = "/v2/query/video_generation"
ASSET = re.compile(r"^[a-f0-9]{32}$")
MAX_VIDEO_BYTES = 100 * 1024 * 1024

def model_config():
    base = (os.getenv("MINIMAX_BASE_URL") or "https://api.minimax.cn").rstrip("/")
    return base, os.getenv("MINIMAX_API_KEY"), DEFAULT_MODEL

def selectable_models():
    return {DEFAULT_MODEL: "MiniMax H3"}


def video_resolution():
    return (os.getenv("MINIMAX_VIDEO_RESOLUTION") or "768P").upper()

def asset_path(asset_id, kind):
    if not isinstance(asset_id, str) or not ASSET.fullmatch(asset_id):
        raise ValueError("素材编号无效。")
    suffix = {"image": "jpg", "clip": "mp4"}[kind]
    return DATA / "assets" / f"{asset_id}.{suffix}"

def save_reference(stream):
    asset_id = uuid4().hex
    target = asset_path(asset_id, "image")
    target.parent.mkdir(parents=True, exist_ok=True)
    try:
        with Image.open(stream) as source:
            if source.width * source.height > 24_000_000:
                raise ValueError("参考图尺寸太大。")
            source = ImageOps.exif_transpose(source).convert("RGB")
            source.thumbnail((1920, 1080))
            if min(source.size) < 300 or not .4 <= source.width / source.height <= 2.5:
                raise ValueError("参考图短边至少 300 px，宽高比需在 0.4 到 2.5。")
            source.save(target, quality=91)
    except (OSError, Image.DecompressionBombError) as exc:
        raise ValueError("请上传可读取的 PNG、JPEG 或 WebP 图片。") from exc
    return asset_id

def media_executable(name):
    directory = os.getenv("VIDEO_FFMPEG_DIR")
    if directory:
        suffix = ".exe" if os.name == "nt" else ""
        path = (ROOT / directory / (name + suffix)).resolve()
        return str(path) if path.is_file() else None
    local = ROOT / ".tools" / "bin" / (name + (".exe" if os.name == "nt" else ""))
    return which(name) or (str(local) if local.is_file() else None)


def run_media(args, timeout):
    executable = media_executable(args[0])
    if not executable:
        raise ValueError(f"找不到 {args[0]}。请安装 FFmpeg，或在 .env 设置 VIDEO_FFMPEG_DIR 后重启。")
    return subprocess.run([executable, *args[1:]], capture_output=True, text=True,
                          encoding="utf-8", errors="replace", timeout=timeout)


def media_cmd(args, timeout=45):
    result = run_media(args, timeout)
    if result.returncode:
        raise ValueError("视频文件无法完整解码或转换。")
    return result

def inspect_clip(path):
    probe = media_cmd(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                       "stream=width,height:format=duration", "-of", "json", str(path)])
    data = json.loads(probe.stdout)
    streams = data.get("streams", [])
    seconds = float(data.get("format", {}).get("duration", 0))
    if not streams or not math.isfinite(seconds) or not 1 <= seconds <= 35:
        raise ValueError("镜头需包含 1–35 秒的视频画面。")
    width, height = streams[0]["width"], streams[0]["height"]
    if not 240 <= min(width, height) or max(width, height) > 4096:
        raise ValueError("镜头分辨率超出可预览范围。")
    scan = media_cmd(["ffmpeg", "-hide_banner", "-nostdin", "-xerror", "-v", "info", "-threads", "2",
                      "-i", str(path), "-an", "-vf", "blackdetect=d=0.65:pix_th=0.08,freezedetect=n=-55dB:d=1.5",
                      "-f", "null", "-"])
    warnings = []
    black = [float(value) for value in re.findall(r"black_duration:([0-9.]+)", scan.stderr)]
    if black and max(black) >= max(1.2, seconds*.6):
        warnings.append("检测到较长黑屏，请人工检查。")
    if "freeze_start:" in scan.stderr:
        warnings.append("检测到静止区间，请核对它是否符合镜头设计。")
    if abs(width / height - 16 / 9) > .08:
        warnings.append("画幅偏离 16:9，合成时将居中裁切。")
    return {"duration": round(seconds, 2), "width": width, "height": height, "warnings": warnings}

def copy_limited(stream, target):
    length = 0
    with target.open("wb") as output:
        while block := stream.read(1024 * 1024):
            length += len(block)
            if length > MAX_VIDEO_BYTES:
                raise ValueError("单个镜头视频不能超过 100 MB。")
            output.write(block)

def save_clip(stream):
    asset_id = uuid4().hex
    target = asset_path(asset_id, "clip")
    target.parent.mkdir(parents=True, exist_ok=True)
    raw = target.with_suffix(".input")
    try:
        copy_limited(stream, raw)
        info = inspect_clip(raw)
        media_cmd(["ffmpeg", "-nostdin", "-y", "-v", "error", "-xerror", "-threads", "2", "-i", str(raw),
                   "-map", "0:v:0", "-an", "-c:v", "libx264", "-threads", "2", "-preset", "fast", "-crf", "19",
                   "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(target)], timeout=100)
        write_json(target.with_suffix(".json"), info)
    except Exception:
        target.unlink(missing_ok=True)
        raise
    finally:
        raw.unlink(missing_ok=True)
    return {"asset_id": asset_id, "url": f"/api/assets/clip/{asset_id}", **info}

def minimax_json(url, api_key, body=None):
    req = Request(url, data=json.dumps(body, ensure_ascii=False).encode() if body is not None else None,
                  headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"})
    try:
        with urlopen(req, timeout=30) as response:
            result = json.load(response)
    except HTTPError as exc:
        detail = {
            401: "请核对 API Key 和站点区域。",
            403: "请检查该 Key 是否有 H3 调用权限。",
            402: "请检查余额和视频额度。",
            422: "请检查提示词和参考素材。",
            429: "请求达到频率限制，请稍后查询或重试。",
        }.get(exc.code, "请检查模型权限和请求参数。")
        raise ValueError(f"MiniMax 返回 HTTP {exc.code}。{detail}") from exc
    except (URLError, TimeoutError, ValueError) as exc:
        raise ValueError("连接 MiniMax 视频服务失败。请检查网络和服务地址。") from exc
    if not isinstance(result, dict) or result.get("error"):
        raise ValueError("MiniMax 未返回有效任务数据。请检查配置，或在 MiniMax 控制台查看任务。")
    return result

def generate_h3(shot, seconds, reference_id, progress, submit_id, existing_id=None):
    base, api_key, model = model_config()
    if not api_key:
        raise ValueError("请先在 .env 配置 MINIMAX_API_KEY。也可导出提示词，生成后导入 MP4。")
    resolution = video_resolution()
    if resolution not in {"768P", "2K"}:
        raise ValueError("MINIMAX_VIDEO_RESOLUTION 只支持 768P 或 2K。")
    content = [{"type": "text", "text": shot}]
    ratio = "16:9"
    if reference_id:
        image = asset_path(reference_id, "image")
        if not image.is_file():
            raise ValueError("参考首帧已缺失，请重新上传。")
        content.append({"type": "image_url", "image_url": {
            "url": "data:image/jpeg;base64," + b64encode(image.read_bytes()).decode("ascii")
        }, "role": "first_frame"})
        ratio = "adaptive"
    if existing_id is None:
        task = minimax_json(base + CREATE_TASK, api_key, {"model": model, "content": content, "ratio": ratio,
                            "duration": seconds, "resolution": resolution})
        existing_id = task.get("task_id")
        if not isinstance(existing_id, str) or not existing_id:
            raise ValueError("视频服务未返回任务编号，请检查服务端任务列表后再尝试。")
        submit_id(existing_id)
    deadline = monotonic() + 900
    while monotonic() < deadline:
        response = minimax_json(base + QUERY_TASK + "/" + quote(existing_id, safe=""), api_key)
        task = response.get("task", response)
        if not isinstance(task, dict):
            raise ValueError("MiniMax 返回了无效的任务状态。")
        status = task.get("status")
        if status == "succeeded":
            video_url = (task.get("content") or {}).get("url", "")
            if urlsplit(video_url).scheme not in ("https", "http"):
                raise ValueError("视频服务没有返回可下载的视频地址。")
            progress("下载和质检")
            try:
                with urlopen(video_url, timeout=90) as video:
                    return save_clip(video)
            except (URLError, TimeoutError) as exc:
                raise ValueError("下载失败，可以继续查询此任务，无需重新生成。") from exc
        if status in {"failed", "expired", "cancelled", "canceled"}:
            raise ValueError(f"MiniMax 视频任务结束（{status}）。请检查提示词、参考图或在 MiniMax 控制台查看详情。")
        progress("H3 正在生成" if status == "running" else "等待 MiniMax H3")
        sleep(10)
    raise ValueError("等待超时。可继续查询现有模型任务。")
