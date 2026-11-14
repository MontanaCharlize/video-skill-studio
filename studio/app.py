"""Local studio web app. Both skills use the same project contracts."""
from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
import json
import os
from pathlib import Path
import re
from tempfile import TemporaryDirectory
from threading import Lock
from typing import Literal
from uuid import uuid4
from zipfile import ZipFile, ZIP_DEFLATED

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import Field, ValidationError

from .accounts import router as account_router
from .core import (
    DATA, MUSIC, PALETTES, ROOT, VOICE_MODEL, Brief, Project, Scene, StrictModel, Style,
    ask_model, export_style, interview, llm_enabled, plan, safe_style, split_sentences, write_json,
)
from .director import approved_assets, compile_project, digest
from .render import SIZE, build, cue_text, draw_card, font, make_track
from .video_models import asset_path, generate_h3, media_cmd, media_executable, model_config, save_clip, save_reference, selectable_models, video_resolution

app = FastAPI(title="视频制作台")
# 前端托管在别的域（例如 GitHub Pages）时，用 VIDEO_CORS_ORIGINS 逗号分隔列出允许的源。
# 同源部署时保持为空，不注册中间件。
CORS_ORIGINS = [item.strip() for item in os.environ.get("VIDEO_CORS_ORIGINS", "").split(",") if item.strip()]
if CORS_ORIGINS:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=CORS_ORIGINS,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
app.include_router(account_router)
WEB = Path(__file__).parent / "web"
app.mount("/ui", StaticFiles(directory=WEB), name="ui")
POOL = ThreadPoolExecutor(max_workers=1, thread_name_prefix="render")
MODEL_POOL = ThreadPoolExecutor(max_workers=2, thread_name_prefix="video-model")
GUARD = Lock()
JOBS = {}
JOB_ID = re.compile(r"^[0-9a-f]{32}$")
PROFILE = re.compile(r"^[a-z][a-z0-9-]{1,54}[a-z0-9]$")
CLIP = re.compile(r"^[0-9a-f]{24}\.mp4$")

class Turn(StrictModel):
    message: str = Field(min_length=1, max_length=700)
    style: Style
    history: list[dict[str, str]] = Field(default_factory=list, max_length=12)

class StyledBrief(Brief):
    style_skill: str = Field(default="", max_length=56)

class StyleSelection(StrictModel):
    project: Project
    name: str = Field(default="", max_length=56)

class Picture(StrictModel):
    scene: Scene
    style: Style

class Revision(StrictModel):
    scene: Scene
    message: str = Field(min_length=1, max_length=600)


class ChatBrief(StrictModel):
    message: str = Field(min_length=1, max_length=700)
    history: list[str] = Field(default_factory=list, max_length=5)
    topic: str = Field(default="", max_length=70)
    source: str = Field(default="", max_length=11000)
    direction: str = Field(default="", max_length=700)
    style_skill: str = Field(default="", max_length=56)
    style: Style

class RenderRequest(Project):
    quality: Literal["preview", "export"] = "preview"
    engine: Literal["code", "hybrid", "model"] = "code"

class ModelShot(StrictModel):
    project: Project
    scene_id: str
    regenerate: bool = False
    model: str = Field(default="", max_length=100)

class Profile(StrictModel):
    name: str
    style: Style

@app.exception_handler(ValueError)
async def on_value_error(_, exc):
    from fastapi.responses import JSONResponse
    if isinstance(exc, ValidationError):
        return JSONResponse({"detail": "模型结果或项目字段格式不正确，请检查内容后重试。"}, status_code=422)
    return JSONResponse({"detail": str(exc)}, status_code=422)

@app.get("/")
def home():
    return FileResponse(WEB / "index.html")

@app.get("/config-template")
def config_template():
    return FileResponse(ROOT / ".env.example", filename=".env.example", media_type="text/plain; charset=utf-8")

@app.get("/api/options")
def options():
    _, key, model = model_config()
    try:
        font(16)
        font(16, True)
        fonts = True
    except ValueError:
        fonts = False
    return {
        "model_connected": llm_enabled(),
        "video_connected": bool(key),
        "video_model": model,
        "video_resolution": video_resolution(),
        "video_models": selectable_models(),
        "local": {
            "ffmpeg": bool(media_executable("ffmpeg") and media_executable("ffprobe")),
            "voice": VOICE_MODEL.is_file() and VOICE_MODEL.with_suffix(".onnx.json").is_file(),
            "fonts": fonts,
        },
        "palettes": PALETTES,
        "music": MUSIC,
    }

@app.get("/api/examples")
def examples():
    return json.loads((ROOT / "examples/topics.json").read_text(encoding="utf-8"))


@app.get("/api/examples/media/{filename}")
def example_media(filename: Literal["metal-hybrid-demo.mp4", "metal-hybrid-demo.srt",
                                     "metal-reference-motion.mp4", "metal-cover.webp"]):
    return FileResponse(ROOT / "examples/outputs" / filename)

@app.post("/api/project")
def check_project(project: Project):
    return project

@app.post("/api/plan")
def storyboard(brief: StyledBrief):
    if brief.style_skill:
        brief.style = load_profile(brief.style_skill)["style"]
    if brief.audience:
        brief.style = brief.style.model_copy(update={"audience": brief.audience})
    return Project(topic=brief.topic, scenes=plan(brief), style=brief.style,
                   style_skill=brief.style_skill, direction=brief.direction, source=brief.source)


@app.post("/api/project/first-draft")
def first_draft(body: ChatBrief):
    topic, source = body.topic, body.source
    direction = body.direction
    audience = ""
    if llm_enabled():
        info = ask_model(
            "把用户的项目对话转成知识短片简报。优先理解最后一条消息，结合之前用户补充。"
            "只有问候、片型或风格、没有具体讲解对象时，在 question 提一个简短问题并把 topic 留空。"
            "已有明确主题时直接给 topic（70 字内）、audience（40 字内）、direction（350 字内），question 留空。"
            "如用户提供事实或讲解稿，将原意保留在 source，分行。不要自行把常识扩写成用户资料，已有的项目资料无需重复。",
            body.model_dump(exclude={"style"}),
            {"topic": "棱镜为什么能把白光分成彩色？", "audience": "初中生",
             "direction": "先用实验引出问题，再用图解解释色散", "source": "", "question": ""},
        )
        topic = str(info.get("topic") or "").strip()[:70]
        if not topic:
            return {"reply": str(info.get("question") or "你想把哪个问题讲成视频？")[:240]}
        source = source or str(info.get("source") or "")[:11000]
        audience = str(info.get("audience") or "")[:40]
        direction = "\n".join(part for part in (direction, str(info.get("direction") or "")) if part)[:700]
    else:
        if not topic:
            topic = (body.history[0] if body.history else body.message).splitlines()[0][:70]
        if not source:
            lines = body.message.splitlines()
            source = body.message if body.history else "\n".join(lines[1:])
        sections = [line.strip() for line in source.splitlines() if line.strip()]
        if len(sections) < 2:
            sections = split_sentences(source)
        if not 2 <= len(sections) <= 6 or any(len(line) > 210 for line in sections):
            return {"reply": "现在是离线模式。请粘贴两到六段讲解资料，每段另起一行，或在左侧打开一个示例。"}
    brief = StyledBrief(topic=topic, source=source, direction=direction,
                        audience=audience, style=body.style, style_skill=body.style_skill)
    return {"project": storyboard(brief)}


@app.get("/api/examples/metal-project")
def metal_project():
    example = examples()[0]
    brief = Brief.model_validate(example)
    sections = [entry.split("｜", 1) for entry in brief.source.splitlines()]
    scenes = [Scene(id="metal-opening", title=brief.topic, kind="title", visual_method="footage",
                    narration="同一间房里的金属和木头，为什么金属摸起来更冷？",
                    visual="实验桌上并排放着金属片和木块，镜头缓缓推近。", seconds=5)]
    kinds = ("compare", "cards", "compare")
    points = (["金属和木头温度相同", "手感不同"], ["热量从手流向材料", "金属导热更快"],
              ["比手冷：金属摸起来更冷", "比手热：金属摸起来更烫"])
    for i, (title, narration) in enumerate(sections):
        scenes.append(Scene(id=f"metal-{i+1}", title=title, narration=narration, kind=kinds[i],
                            points=points[i], visual_method="diagram", sources=[f"参考资料 · 第 {i+1} 段"]))
    style = Style(background="#101010", text="#F2F2F2", accent="#BDBDBD", music="piano")
    return Project(topic=brief.topic, style=style, scenes=scenes, source=brief.source)

@app.post("/api/prompts")
def prompts(project: Project):
    return compile_project(project)

@app.post("/api/project/style")
def apply_project_style(body: StyleSelection):
    style = load_profile(body.name)["style"] if body.name else Style()
    return body.project.model_copy(update={"style_skill": body.name, "style": style})

@app.post("/api/interview")
def style_turn(turn: Turn):
    style, reply = interview(turn.message, turn.style, turn.history)
    return {"style": style, "reply": reply, "changed": [k for k, v in style.model_dump().items() if getattr(turn.style, k) != v]}

@app.post("/api/frame")
def frame(body: Picture):
    first = split_sentences(body.scene.narration)
    caption = cue_text((first or [body.scene.narration])[0])[0]
    buffer = BytesIO()
    draw_card(body.scene, body.style, caption, SIZE["preview"], 0).save(buffer, format="PNG")
    return Response(content=buffer.getvalue(), media_type="image/png")

@app.get("/api/music/{mood}")
def audition(mood: Literal["ambient", "piano", "pulse"]):
    path = DATA / "music" / f"{mood}.wav"
    with GUARD:
        if not path.exists():
            path.parent.mkdir(parents=True, exist_ok=True)
            make_track(mood, path, 10)
    return FileResponse(path, media_type="audio/wav")

def revise_scene(scene, instruction):
    original = scene.model_dump()
    editable = set(original) - {"id", "clip_id", "clip_signature", "clip_versions", "reference_id", "prompt_override"}
    if llm_enabled():
        patch = ask_model(
            "改一个知识视频镜头，保持原有事实与来源，除非用户明确给出新事实。"
            "输出 patch 对象，只包含需要改的 title、kicker、kind、points、narration、sources、visual、camera、seconds、visual_method 字段。"
            "kind 仅限 title、cards、steps、timeline、compare。旁白中文，标题最多32字，要点最多4条",
            {"scene": {key: value for key, value in original.items() if key in editable}, "instruction": instruction},
            {"patch": {"visual": "俯拍实验桌，手指依次触碰金属片和木块。", "camera": "top"}},
        ).get("patch", {})
        if not isinstance(patch, dict) or set(patch) - editable:
            raise ValueError("修改结果包含未知字段。")
    else:
        patch = {}
        for label, key in (("标题", "title"), ("旁白", "narration"), ("副标题", "kicker"), ("要点", "points"), ("画面", "visual")):
            match = re.search(rf"(?:^|[\n；])\s*{label}\s*[：:]\s*([^\n；]+)", instruction)
            if match:
                value = match[1].strip(" “”。")
                patch[key] = [x.strip() for x in re.split(r"[｜|]", value) if x.strip()] if key == "points" else value
        if not patch:
            raise ValueError("离线对话支持「标题：…」「旁白：…」「要点：第一条｜第二条」。也可在下方直接编辑。")
    if any(key in patch and patch[key] != original[key] for key in ("visual", "camera", "seconds")):
        patch["prompt_override"] = ""
    return Scene.model_validate({**original, **patch, "id": scene.id})

@app.post("/api/revise")
def revise(body: Revision):
    scene = revise_scene(body.scene, body.message)
    return {"scene": scene, "changed": [k for k, v in scene.model_dump().items() if getattr(body.scene, k) != v]}

def profile_dir(name):
    if not PROFILE.fullmatch(name):
        raise ValueError("名称请使用 3–56 位小写英文字母、数字和连字符。")
    return DATA / "profiles" / name

@app.get("/api/profiles")
def profiles():
    return sorted(p.parent.name for p in (DATA / "profiles").glob("*/profile.json") if PROFILE.fullmatch(p.parent.name))

@app.get("/api/profiles/{name}")
def load_profile(name: str):
    path = profile_dir(name) / "profile.json"
    if not path.is_file():
        raise HTTPException(404, "没有找到个人 Skill。")
    return {"name": name, "style": Style.model_validate_json(path.read_text(encoding="utf-8"))}

@app.post("/api/profiles")
def save_profile(body: Profile):
    target = profile_dir(body.name)
    with GUARD:
        export_style(body.name, safe_style({}, body.style), target)
    return load_profile(body.name)

@app.get("/api/profiles/{name}/download")
def download_profile(name: str):
    root = profile_dir(name)
    if not (root / "SKILL.md").is_file():
        raise HTTPException(404, "没有找到个人 Skill。")
    buffer = BytesIO()
    with GUARD, ZipFile(buffer, "w", ZIP_DEFLATED) as archive:
        for file in ("SKILL.md", "profile.json"):
            archive.writestr(f"{name}/{file}", (root / file).read_bytes())
    return Response(buffer.getvalue(), media_type="application/zip",
                    headers={"Content-Disposition": f'attachment; filename="{name}.zip"'})

def update_job(job_id, **changes):
    with GUARD:
        JOBS[job_id].update(changes)

def work(job_id, body):
    target = DATA / "jobs" / job_id
    update_job(job_id, status="running")
    try:
        sources = approved_assets(body, body.engine)
        items = build(body.scenes, body.style, body.quality, target,
                      lambda i, n, title: update_job(job_id, progress=i/n, phase=title,
                                                     completed_scenes=i, total_scenes=n,
                                                     assembling=i == n), assets=sources)
        update_job(job_id, status="done", progress=1, phase="已生成", scenes=items,
                   assembling=False, video=f"/api/media/{job_id}/video.mp4",
                   subtitles=f"/api/media/{job_id}/subtitles.srt")
    except Exception as exc:
        update_job(job_id, status="failed", phase="生成失败", error=str(exc) or type(exc).__name__)

@app.post("/api/render")
def start(body: RenderRequest):
    approved_assets(body, body.engine)
    job_id = uuid4().hex
    update = {"status": "queued", "progress": 0, "phase": "等待渲染",
              "completed_scenes": 0, "total_scenes": len(body.scenes), "assembling": False}
    with GUARD:
        JOBS[job_id] = update
    POOL.submit(work, job_id, body.model_copy(deep=True))
    return {"id": job_id, **update}

@app.get("/api/render/{job_id}")
def status(job_id: str):
    with GUARD:
        result = JOBS.get(job_id)
        if result is None:
            raise HTTPException(404, "没有找到渲染任务。")
        return result.copy()

@app.get("/api/media/{job_id}/{filename}")
def media(job_id: str, filename: Literal["video.mp4", "subtitles.srt", "report.json"]):
    if not JOB_ID.fullmatch(job_id):
        raise HTTPException(404)
    path = DATA / "jobs" / job_id / filename
    if not path.is_file():
        raise HTTPException(404, "还没有生成该文件。")
    return FileResponse(path, media_type="video/mp4" if filename == "video.mp4" else None)

@app.get("/api/clip/{filename}")
def clip(filename: str):
    path = DATA / "cache" / filename
    if not CLIP.fullmatch(filename) or not path.is_file():
        raise HTTPException(404, "还没有生成该镜头。")
    return FileResponse(path, media_type="video/mp4")

@app.post("/api/assets/image")
def upload_reference(file: UploadFile = File(...)):
    if file.size and file.size > 12 * 1024 * 1024:
        raise ValueError("参考图不能超过 12 MB。")
    asset_id = save_reference(file.file)
    return {"asset_id": asset_id, "url": f"/api/assets/image/{asset_id}"}

@app.post("/api/assets/clip")
def upload_clip(file: UploadFile = File(...)):
    return save_clip(file.file)

@app.get("/api/assets/{kind}/{asset_id}")
def get_asset(kind: Literal["image", "clip"], asset_id: str):
    path = asset_path(asset_id, kind)
    if not path.is_file():
        raise HTTPException(404, "没有找到该素材。")
    return FileResponse(path, media_type="image/jpeg" if kind == "image" else "video/mp4")


@app.get("/api/assets/clip/{asset_id}/poster")
def clip_poster(asset_id: str):
    clip = asset_path(asset_id, "clip")
    if not clip.is_file():
        raise HTTPException(404, "没有找到该素材。")
    poster = clip.with_suffix(".webp")
    if not poster.is_file():
        with TemporaryDirectory(dir=clip.parent) as folder:
            temp = Path(folder) / "poster.webp"
            media_cmd(["ffmpeg", "-nostdin", "-v", "error", "-ss", "0.4", "-i", str(clip),
                       "-frames:v", "1", "-vf", "scale=360:-2", "-c:v", "libwebp", str(temp)], timeout=15)
            temp.replace(poster)
    return FileResponse(poster, media_type="image/webp", headers={"Cache-Control": "private, max-age=86400"})

def model_work(job, shot, scene, record_path, saved):
    update_job(job, status="running", phase="连接视频模型")
    try:
        def record_task(task_id):
            write_json(record_path, {"task_id": task_id})
        asset = generate_h3(shot["prompt"], scene.seconds, scene.reference_id,
                            lambda phase: update_job(job, phase=phase), record_task, saved.get("task_id"))
        write_json(record_path, {"asset": asset})
        update_job(job, status="done", phase="等待你确认", asset=asset, signature=shot["signature"])
    except Exception as exc:
        update_job(job, status="failed", phase="生成失败", error=str(exc) or type(exc).__name__)

@app.post("/api/model-shots")
def model_shot(body: ModelShot):
    base, key, default_model = model_config()
    model = body.model or default_model
    if model not in selectable_models():
        raise ValueError("请选择已配置的视频模型。")
    if not key:
        raise ValueError("MiniMax H3 未配置。请在 .env 填写 MINIMAX_API_KEY，或生成后导入视频镜头。")
    if video_resolution() not in {"768P", "2K"}:
        raise ValueError("请在 .env 将 MINIMAX_VIDEO_RESOLUTION 设为 768P 或 2K。")
    if not all(media_executable(executable) for executable in ("ffmpeg", "ffprobe")):
        raise ValueError("请先安装 FFmpeg 和 ffprobe，再提交生成任务。")
    scene = next((s for s in body.project.scenes if s.id == body.scene_id), None)
    if scene is None:
        raise ValueError("找不到要生成的镜头。")
    if not (scene.visual or scene.prompt_override):
        raise ValueError("请先填写可见的主体、场景和一个动作。")
    shot = next(s for s in compile_project(body.project)["shots"] if s["id"] == scene.id)
    fingerprint = digest([base, model, video_resolution(), digest(key), shot["signature"]])
    record = DATA / "model-tasks" / f"{fingerprint}.json"
    with GUARD:
        for existing_id, existing in JOBS.items():
            if existing.get("fingerprint") == fingerprint and existing["status"] in ("running", "queued"):
                return {"id": existing_id, **existing}
        saved = json.loads(record.read_text(encoding="utf-8")) if record.exists() and not body.regenerate else {}
        job = uuid4().hex
        update = {"status": "queued", "phase": "等待模型", "fingerprint": fingerprint}
        asset = saved.get("asset")
        if asset and asset_path(asset["asset_id"], "clip").is_file():
            update.update(status="done", phase="已复用", asset=asset, signature=shot["signature"])
        JOBS[job] = update
        result = {"id": job, **update}
    if update["status"] != "done":
        MODEL_POOL.submit(model_work, job, shot, scene, record, saved)
    return result
