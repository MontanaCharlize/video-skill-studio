"""Render independent scene clips, then assemble the current timeline."""
import hashlib
import json
import math
import os
import wave
from shutil import copyfile, copytree
from functools import lru_cache
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Lock

import numpy as np
from PIL import Image, ImageDraw, ImageFont

from .core import DATA, ROOT, SPEED, VOICE_MODEL, split_sentences, write_json
from .video_models import run_media

FPS = 24
VOICE_LOCK = Lock()
RENDER_VERSION = "3"
SIZE = {"preview": (960, 540), "export": (1280, 720)}

def run(*args):
    result = run_media(args, 180)
    if result.returncode:
        raise ValueError(f"{Path(args[0]).name} 处理失败：{result.stderr.strip()[-600:]}")
    return result.stdout

def duration(path):
    return float(run("ffprobe", "-v", "error", "-show_entries", "format=duration",
                     "-of", "default=noprint_wrappers=1:nokey=1", str(path)).strip())

def key_for(data):
    return hashlib.sha256(json.dumps(data, ensure_ascii=False, sort_keys=True).encode()).hexdigest()[:24]

@lru_cache
def voice():
    try:
        from piper import PiperVoice
        from piper.phonemize_espeak import ESPEAK_DATA_DIR
    except ImportError as exc:
        raise ValueError("缺少 Piper。请先安装 requirements.txt。") from exc
    if not VOICE_MODEL.is_file():
        raise ValueError("找不到中文语音模型。请运行 setup_voice.py，或在 .env 设置 VIDEO_TTS_MODEL。")
    if not VOICE_MODEL.with_suffix(".onnx.json").is_file():
        raise ValueError("中文语音模型缺少同名 .onnx.json 配置文件。")
    if os.name != "nt" or str(ESPEAK_DATA_DIR).isascii():
        return PiperVoice.load(str(VOICE_MODEL), download_dir=VOICE_MODEL.parent), None

    # The Windows eSpeak bridge cannot open its data files from Unicode paths.
    temp = TemporaryDirectory(prefix="pianyu-piper-")
    try:
        if not temp.name.isascii():
            raise ValueError("当前 Windows 临时目录含非 ASCII 字符。请为启动进程设置英文路径的 TEMP。")
        espeak_data = Path(temp.name) / "espeak-ng-data"
        copytree(ESPEAK_DATA_DIR, espeak_data)
        synth = PiperVoice.load(str(VOICE_MODEL), espeak_data_dir=espeak_data, download_dir=VOICE_MODEL.parent)
    except Exception:
        temp.cleanup()
        raise
    return synth, temp

def speech(text, pace, output):
    with VOICE_LOCK:
        synthesizer, _ = voice()
        from piper import SynthesisConfig
        with wave.open(str(output), "wb") as wav:
            synthesizer.synthesize_wav(text, wav, syn_config=SynthesisConfig(length_scale=SPEED[pace], noise_scale=.5))

@lru_cache(maxsize=32)
def font(size, bold=False):
    default = "/usr/share/fonts/opentype/noto/NotoSansCJK-" + ("Bold" if bold else "Regular") + ".ttc"
    bundled = ROOT / "assets/NotoSansSC.ttf"
    windows = Path(os.getenv("WINDIR", "C:/Windows")) / "Fonts" / ("msyhbd.ttc" if bold else "msyh.ttc")
    location = (os.getenv("VIDEO_FONT_BOLD" if bold else "VIDEO_FONT")
                or (os.getenv("VIDEO_FONT") if bold else None)
                or (str(bundled) if bundled.is_file() else str(windows) if windows.is_file() else default))
    try:
        return ImageFont.truetype(location, size, index=int(os.getenv("VIDEO_FONT_INDEX") or "0"))
    except (OSError, ValueError) as exc:
        raise ValueError("缺少中文字体，请设置 VIDEO_FONT 和 VIDEO_FONT_BOLD。") from exc

def wrap(text, face, width, limit):
    lines, line = [], ""
    for char in text:
        if line and face.getlength(line + char) > width:
            lines.append(line)
            line = ""
        line += char
    if line:
        lines.append(line)
    if len(lines) > limit:
        last = lines[limit - 1]
        while last and face.getlength(last + "…") > width:
            last = last[:-1]
        return lines[:limit-1] + [last + "…"]
    return lines

def color_mix(a, b, fraction):
    a = [int(a[i:i+2], 16) for i in (1, 3, 5)]
    b = [int(b[i:i+2], 16) for i in (1, 3, 5)]
    return tuple(round(x * (1 - fraction) + y * fraction) for x, y in zip(a, b))

def draw_card(scene, style, spoken, size, active):
    k = size[0] / 960
    image = Image.new("RGB", size, style.background)
    d = ImageDraw.Draw(image)
    muted = color_mix(style.background, style.text, .66)
    panel = color_mix(style.background, style.text, .065)
    rule = color_mix(style.background, style.text, .23)
    tint = color_mix(style.background, style.accent, .38)

    def pos(*coords):
        return tuple(round(n * k) for n in coords)
    def line(coords, color, width=1):
        d.line(pos(*coords), fill=color, width=max(1, round(width*k)))
    def text(x, y, content, px, fill, bold=False):
        d.text(pos(x, y), content, fill=fill, font=font(round(px*k), bold), anchor="lt")
    def block(x, y, value, px, width, max_lines, fill, bold=False):
        lines = wrap(value, font(round(px*k), bold), width*k, max_lines)
        for i, row in enumerate(lines):
            text(x, y + i*(px+8), row, px, fill, bold)
        return len(lines)

    if scene.kicker and scene.kicker != "知识讲解":
        text(57, 47, scene.kicker, 16, muted)
    line((57, 78, 903, 78), rule)
    line((57, 78, 100, 78), style.accent, 3)
    points = scene.points or [scene.title]
    selected = min(active, len(points)-1)

    if scene.kind == "title":
        for i in range(9):
            radius = 35 + 13*i
            cx, cy = 752 + i*4, 244
            d.ellipse(pos(cx-radius, cy-radius, cx+radius, cy+radius), outline=tint, width=max(1, round(k)))
        d.ellipse(pos(732, 228, 766, 262), fill=style.accent)
        block(55, 142, scene.title, 57, 600, 3, style.text, True)
    elif scene.kind == "compare" and len(points) > 1:
        block(55, 106, scene.title, 39, 850, 2, style.text, True)
        line((57, 211, 903, 211), rule)
        col = 846 / len(points)
        for i, point in enumerate(points):
            x = 57 + i*col
            if i:
                line((x, 220, x, 399), rule)
            focus = i == selected
            if focus:
                d.rectangle(pos(x+1, 220, x+col-2, 399), fill=panel)
            line((x+17, 240, x+55, 240), style.accent if focus else rule, 3)
            block(x+17, 264, point, 26 if len(points)<4 else 21, col-36, 4, style.text if focus else muted, focus)
    elif scene.kind in ("steps", "timeline") and len(points) > 1:
        block(55, 106, scene.title, 39, 850, 2, style.text, True)
        col = 846 / len(points)
        line((75, 267, 75 + col*(len(points)-1), 267), rule, 2)
        for i, point in enumerate(points):
            x = 57 + i*col
            focus = i == selected
            color = style.accent if focus else rule
            d.ellipse(pos(x+10, 259, x+26, 275), fill=color)
            if scene.kind == "steps":
                text(x+9, 230, str(i+1), 17, muted)
            block(x+10, 298, point, 24 if len(points)<4 else 20, col-25, 4, style.text if focus else muted, focus)
    else:
        block(55, 138, scene.title, 46, 410, 3, style.text, True)
        line((478, 126, 478, 394), rule)
        pitch = 66
        for i, point in enumerate(points):
            y = 128 + i*pitch
            focus = i == selected
            if focus:
                d.rounded_rectangle(pos(500, y-8, 903, y+52), radius=round(7*k), fill=panel)
            d.ellipse(pos(514, y+11, 522, y+19), fill=style.accent if focus else rule)
            block(535, y+1, point, 21, 350, 2, style.text if focus else muted, focus)
    line((57, 432, 903, 432), rule)
    block(57, 453, spoken, 23, 845, 2, style.text)
    return image

def subtitle_layer(text, size):
    layer = Image.new("RGBA", size)
    draw = ImageDraw.Draw(layer)
    w, h = size
    face = font(round(w*.025), True)
    lines = wrap(text, face, w*.83, 2)
    pitch = round(w*.033)
    bottom = h - round(h*.064)
    for i, row in enumerate(reversed(lines)):
        cy = bottom - i*pitch
        half = face.getlength(row) / 2 + round(w*.015)
        draw.rounded_rectangle((w/2-half, cy-pitch/2, w/2+half, cy+pitch/2),
                               radius=round(w*.008), fill=(17, 15, 14, 218))
        draw.text((w/2, cy), row, font=face, fill=(255, 251, 245, 255), anchor="mm")
    return layer

def make_track(mood, target, seconds):
    if mood == "none":
        return
    sr = 24000
    length = math.ceil(seconds * sr)
    out = np.zeros(length, dtype=np.float32)
    tempo, pattern = {"ambient": (72, (48, 55, 60, 64, 57, 60, 64, 67)),
                      "piano": (82, (60, 64, 67, 72, 57, 60, 64, 69)),
                      "pulse": (108, (48, 60, 55, 62, 57, 64, 55, 67))}[mood]
    beat = 60 / tempo
    for index, start in enumerate(np.arange(0, seconds, beat / 2)):
        left = round(start * sr)
        count = min(length-left, int(sr * beat * 2))
        if count <= 0:
            continue
        t = np.arange(count) / sr
        f = 440 * 2 ** ((pattern[index % len(pattern)] - 69) / 12)
        decay = {"ambient": 1.7, "piano": 4.0, "pulse": 6.5}[mood]
        attack = .12 if mood == "ambient" else .016
        envelope = np.minimum(t / attack, 1) * np.exp(-t * decay)
        amplitude = np.sin(2*np.pi*f*t) + .20*np.sin(4*np.pi*f*t)
        out[left:left+count] += .24 * amplitude * envelope
    edge = min(length // 2, sr // 3)
    if edge:
        out[:edge] *= np.linspace(0, 1, edge)
        out[-edge:] *= np.linspace(1, 0, edge)
    with wave.open(str(target), "wb") as dst:
        dst.setparams((1, 2, sr, 0, "NONE", "not compressed"))
        dst.writeframes((np.clip(out, -1, 1) * 32767).astype("<i2").tobytes())

def cue_text(text, limit=43):
    return [text[i:i+limit] for i in range(0, len(text), limit)]

def make_clip(scene, style, quality, cache, asset=None):
    render_scene = scene.model_dump(include={"kind", "title", "kicker", "points", "narration"})
    settings = style.model_dump(include={"background", "text", "accent", "pace", "look"})
    fonts = [os.getenv("VIDEO_FONT"), os.getenv("VIDEO_FONT_BOLD"), os.getenv("VIDEO_FONT_INDEX")]
    key = key_for([RENDER_VERSION, render_scene, settings, quality, str(VOICE_MODEL), fonts, asset.name if asset else None])
    output = cache / f"{key}.mp4"
    metadata = cache / f"{key}.json"
    if output.exists() and metadata.exists():
        return output, json.loads(metadata.read_text(encoding="utf-8")), True
    with TemporaryDirectory(dir=cache) as work:
        work = Path(work)
        narration = [part for sentence in split_sentences(scene.narration) for part in cue_text(sentence)]
        if not narration:
            raise ValueError(f"镜头 {scene.title} 需要有效旁白。")
        audio = []
        for i, part in enumerate(narration):
            wav = work / f"{i}.wav"
            speech(part, style.pace, wav)
            seconds = max(FPS//2, math.ceil((duration(wav) + .16) * FPS)) / FPS
            audio.append((wav, seconds))
        source = None
        w, h = SIZE[quality]
        if asset:
            desired = sum(seconds for _, seconds in audio)
            original = duration(asset)
            stretch = min(1.25, max(1, desired/original))
            source = work / "source.mp4"
            filters = (f"setpts={stretch:.6f}*PTS,scale={w}:{h}:force_original_aspect_ratio=increase,"
                       f"crop={w}:{h},setsar=1,fps={FPS},format=yuv420p,tpad=stop_mode=clone:stop_duration={desired}")
            run("ffmpeg", "-y", "-v", "error", "-filter_threads", "1", "-i", str(asset), "-an", "-vf", filters,
                "-t", str(desired), "-c:v", "libx264", "-threads", "2", "-preset", "ultrafast", "-crf", "20", str(source))
        cues, segments, elapsed, position = [], [], 0.0, 0.0
        for i, (part, (wav, seconds)) in enumerate(zip(narration, audio)):
            png, mp4 = work / f"{i}.png", work / f"{i}.mp4"
            if source:
                subtitle_layer(part, SIZE[quality]).save(png)
                inputs = ["-ss", str(position), "-i", str(source), "-i", str(png), "-i", str(wav),
                          "-filter_complex_threads", "1", "-filter_complex", "[0:v][1:v]overlay,format=yuv420p[v]",
                          "-map", "[v]", "-map", "2:a:0"]
            else:
                draw_card(scene, style, part, SIZE[quality], i).save(png)
                filters = "format=yuv420p"
                if i == 0:
                    filters += f",fade=t=in:d=0.16:color=0x{style.background[1:]}"
                inputs = ["-loop", "1", "-framerate", str(FPS), "-i", str(png), "-i", str(wav), "-vf", filters]
            run("ffmpeg", "-y", "-v", "error", "-filter_threads", "1", *inputs,
                "-af", "apad", "-t", str(seconds),
                "-c:v", "libx264", "-threads", "2", "-preset", "ultrafast", "-crf", "21",
                "-c:a", "aac", "-ar", "48000", "-ac", "1", str(mp4))
            measured = duration(mp4)
            cues.append({"at": elapsed, "to": elapsed + min(seconds, measured), "text": part})
            segments.append(mp4)
            elapsed += measured
            position += seconds
        combined = work / "clip.mp4"
        concat(segments, combined)
        elapsed = duration(combined)
        combined.replace(output)
        write_json(metadata, {"duration": elapsed, "cues": cues})
    return output, {"duration": elapsed, "cues": cues}, False

def concat(paths, output):
    with TemporaryDirectory(dir=output.parent) as temp:
        directory = Path(temp)
        for i, path in enumerate(paths):
            link = directory / f"part{i}.mp4"
            try:
                link.hardlink_to(path.resolve())
            except OSError:
                copyfile(path, link)
        listing = directory / "parts.txt"
        listing.write_text("".join(f"file part{i}.mp4\n" for i in range(len(paths))), encoding="ascii")
        run("ffmpeg", "-y", "-v", "error", "-f", "concat", "-safe", "1", "-i", str(listing),
            "-c", "copy", "-movflags", "+faststart", str(output))

def stamp(sec):
    milliseconds = round(sec*1000)
    minutes, remainder = divmod(milliseconds, 60000)
    hours, minutes = divmod(minutes, 60)
    seconds, fraction = divmod(remainder, 1000)
    return f"{hours:02}:{minutes:02}:{seconds:02},{fraction:03}"

def build(scenes, style, quality, target, progress=lambda *_: None, assets=None):
    assets = assets or {}
    target.mkdir(parents=True, exist_ok=True)
    cache = DATA / "cache"
    cache.mkdir(parents=True, exist_ok=True)
    paths, items, timeline = [], [], []
    offset = 0.0
    for i, scene in enumerate(scenes):
        progress(i, len(scenes), scene.title)
        path, meta, cached = make_clip(scene, style, quality, cache, assets.get(scene.id))
        paths.append(path)
        items.append({"id": scene.id, "clip": path.name, "reused": cached,
                      "at": round(offset, 3), "duration": round(meta["duration"], 3),
                      "source": "video" if scene.id in assets else "code"})
        timeline.extend((offset + c["at"], offset + c["to"], c["text"]) for c in meta["cues"])
        offset += meta["duration"]
    progress(len(scenes), len(scenes), "合成视频")
    output = target / "video.mp4"
    with TemporaryDirectory(dir=target) as temp:
        temp = Path(temp)
        dry = temp / "dry.mp4"
        concat(paths, dry)
        final = dry
        if style.music != "none" and style.music_volume > 0:
            music = temp / "music.wav"
            make_track(style.music, music, duration(dry))
            final = temp / "mixed.mp4"
            run("ffmpeg", "-y", "-v", "error", "-i", str(dry), "-i", str(music), "-filter_complex_threads", "1",
                "-filter_complex", f"[0:a]volume=0.88[voice];[1:a]volume={style.music_volume}[bg];[voice][bg]amix=inputs=2:duration=first:normalize=0[a]",
                "-map", "0:v:0", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-ar", "48000",
                "-movflags", "+faststart", str(final))
        final.replace(output)
    (target / "subtitles.srt").write_text("".join(
        f"{i}\n{stamp(at)} --> {stamp(to)}\n{text}\n\n" for i, (at, to, text) in enumerate(timeline, 1)),
        encoding="utf-8")
    write_json(target / "report.json", {"quality": quality, "duration": round(duration(output), 3), "scenes": items})
    return items
