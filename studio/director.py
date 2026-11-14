"""Compile confirmed style and editable scenes into portable production prompts."""
import hashlib
import json

from .core import CAMERAS, LOOK_NOTES, LOOKS, MUSIC
from .video_models import asset_path

CODE_RULES = (
    "只输出经校验的镜头 JSON。允许的画面类型为 title、cards、steps、timeline、compare。",
    "一幕一个讲解目标。使用对比解释差异、用步骤说明过程、用时间线交代先后、用重点卡片讲结论。",
    "每幕最多四个短要点。标题、要点和旁白沿用资料中的术语，数字和公式交给图解或后期字幕。",
    "统一 16:9、24 fps、字体与三色配色。主体避开底部字幕区，镜头内只高亮正在讲的要点。",
    "需要真实材质、人物动作或场景氛围时，生成视频素材后选混合制作。程序使用已校验的分镜字段渲染图解。",
)

def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True).encode()).hexdigest()

def master_prompt(project):
    style = project.style
    rules = [
        f"制作一条关于「{project.topic}」的中文知识讲解视频。目标受众：{style.audience}。",
        f"讲解口吻：{style.tone}。视觉方向：{LOOKS[style.look]}，{LOOK_NOTES[style.look]}。",
        f"统一视觉：背景 {style.background}，正文 {style.text}，强调 {style.accent}。画幅 16:9。",
        f"声音指导：旁白语速 { {'slow':'慢','normal':'自然','fast':'稍快'}[style.pace] }，配乐 {MUSIC[style.music]}，混音音量系数 {style.music_volume:.2f}。",
        "叙事：用具体场景引出问题，用可见的变化解释原因，收尾回扣问题。相同主体应保持材质、比例与环境连续。",
        "分工：视频模型生成可剪辑的画面，旁白、字幕、公式和数据由后期合成。关键事实以资料为准。",
    ]
    if project.style_skill:
        rules.insert(1, f"调用个人风格 Skill：{project.style_skill}。")
    if style.visual_notes:
        rules.append("个人镜头偏好：" + style.visual_notes)
    if project.direction:
        rules.append("本片要求：" + project.direction)
    return "\n".join(rules)

def shot_prompt(project, scene):
    style = project.style
    if scene.prompt_override:
        return scene.prompt_override
    visual = scene.visual
    if not visual:
        visual = "围绕「" + scene.title + "」呈现一个可以观察的场景或物体变化。"
        if scene.points:
            visual += "表现重点：" + "、".join(scene.points) + "。"
    frame = "按参考首帧保持主体和构图，" if scene.reference_id else ""
    return "\n".join([
        f"{scene.seconds} 秒，16:9 横幅，知识短片的单镜头画面。主题背景：{project.topic}。",
        f"主体、场景与动作：{visual}",
        f"风格：{LOOK_NOTES[style.look]}。背景基调 {style.background}，局部强调 {style.accent}。",
        f"运镜：{frame}{CAMERAS[scene.camera]}。一个主要动作，开场交代主体，结尾保持稳定以便接下一镜。",
        "画面底部保留后期字幕空间。保持物体结构、光线和运动方向稳定，画面无字幕、水印、随机文字、公式和图表。",
        *([f"个人镜头偏好：{style.visual_notes}"] if style.visual_notes else []),
        *([f"本片画面要求：{project.direction}"] if project.direction else []),
    ])

def shot_signature(project, scene):
    return digest([shot_prompt(project, scene), scene.reference_id, scene.seconds, scene.camera,
                   project.style.look, project.style.background, project.style.accent,
                   project.style.visual_notes, project.direction, project.topic])

def compile_project(project):
    shots = []
    for scene in project.scenes:
        checks = []
        if not (scene.prompt_override or scene.visual):
            checks.append("建议补充可见主体和一个具体动作。")
        if not scene.sources or any("待核对" in ref for ref in scene.sources):
            if scene.kind != "title":
                checks.append("生成前核对本镜事实与资料出处。")
        if scene.kind in ("compare", "timeline"):
            checks.append("数字或日期使用确定性图解或后期字幕。")
        signature = shot_signature(project, scene)
        shots.append({"id": scene.id, "title": scene.title, "duration": scene.seconds, "visual_method": scene.visual_method,
                      "prompt": shot_prompt(project, scene), "narration": scene.narration,
                      "sources": scene.sources, "checks": checks, "signature": signature,
                      "approved": bool(scene.clip_id and scene.clip_signature == signature)})
    master = master_prompt(project)
    complete = master + "\n\n" + "\n\n".join(
        f"镜头 {i}｜{shot['title']}\n{shot['prompt']}\n后期旁白：{shot['narration']}"
        for i, shot in enumerate(shots, 1))
    return {"master": master, "complete": complete, "shots": shots, "code_rules": CODE_RULES}


def approved_assets(project, engine):
    if engine == "code":
        return {}
    sources = {}
    for scene in project.scenes:
        if engine == "hybrid" and scene.visual_method == "diagram":
            continue
        if scene.clip_id and scene.clip_signature == shot_signature(project, scene):
            path = asset_path(scene.clip_id, "clip")
            if path.is_file():
                sources[scene.id] = path
        if engine == "model" and scene.id not in sources:
            raise ValueError(f"「{scene.title}」还没有确认当前版本的视频素材。")
    return sources
