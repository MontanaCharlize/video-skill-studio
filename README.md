# 片语 · 知识视频制作台

打开片语首页可观看样片。点击**开始项目**，在右侧对话描述主题、观众和风格，左侧显示第一版分镜。选中一幕后，可继续通过对话改镜，或编辑下方的镜头详情。在「个人风格」可以调整并保存 Skill。逐镜确认素材后，在「交付」合成旁白、配乐、字幕和成片。

| 环节 | 负责的 Skill | 输入与产出 |
|---|---|---|
| 风格对话 | `video-style-interview` | 把个人偏好保存为 `SKILL.md` 与 `profile.json` |
| 分镜和提示词 | `video-production` | 读取已保存风格，与本次主题、资料和导演要求合成全片提示词和逐镜指令 |
| 镜头与剪辑 | `video-production` | 逐镜生成或导入视频，审核后和程序图解、旁白、音乐及字幕合成 |

## 启动网站

Windows 使用带 Python Launcher 的官方 Python 3.11+，建议 3.12 或 3.13。在项目目录运行：

```powershell
.\start.ps1
```

脚本通过 `py -3` 建立虚拟环境，并使用 `.venv\Scripts\python.exe` 安装依赖，适用于 PATH 上的 `python` 指向 MSYS2 的情况。首次启动会从 `.env.example` 创建 `.env`。已有虚拟环境时，也可直接运行：

```powershell
& '.\.venv\Scripts\python.exe' -m pip install -r requirements.txt
& '.\.venv\Scripts\python.exe' -m uvicorn studio.app:app --host 127.0.0.1 --port 8787
```

Linux/macOS 可运行：

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
test -e .env || cp .env.example .env
.venv/bin/python -m uvicorn studio.app:app --host 127.0.0.1 --port 8787
```

打开 [片语工作台](http://127.0.0.1:8787/)，在「控制台」展开「模型配置」查看当前配置。支持本机账号注册，也可以访客身份制作。最近工程和项目对话保存在当前浏览器，风格、素材和缓存默认保存到 `data/`。迁移工程 JSON 时同时复制 `data/assets/`，也可重新导入素材。

### 准备本地合成

- 安装 [FFmpeg](https://ffmpeg.org/download.html)，确保同一目录包含 `ffmpeg` 和 `ffprobe`，并支持 H.264/AAC。可把该目录加入 PATH，或在 `.env` 填 `VIDEO_FFMPEG_DIR=C:/Tools/ffmpeg/bin`。
- Windows 默认尝试微软雅黑。Linux 可安装 `fonts-noto-cjk`，其他字体可通过 `VIDEO_FONT` 和 `VIDEO_FONT_BOLD` 指定。
- 在 Windows 运行 `& '.\.venv\Scripts\python.exe' setup_voice.py`，在 Linux/macOS 运行 `.venv/bin/python setup_voice.py`。脚本下载并校验 Piper Huayan 中文语音，Windows 使用系统 curl 保留 HTTPS 验证。若网络无法下载，可将 [模型和同名配置文件](https://huggingface.co/rhasspy/piper-voices/tree/2f8dbe0/zh/zh_CN/huayan/medium) 放进 `models/`，再次运行脚本校验。已有语音模型可在 `.env` 设置 `VIDEO_TTS_MODEL`，同目录须有对应的 `.onnx.json`。

## API Key 填在哪里

在项目根目录的 `.env` 填入两枚 Key，然后重启网站。各项示例见 `.env.example`。网页只显示配置状态，真实 Key 由后端读取。

| 用途 | 配置 |
|---|---|
| DeepSeek 风格对话、自动分镜、按意见改镜 | 填 `DEEPSEEK_API_KEY`。默认 `deepseek-flash`，使用 `https://api.deepseek.com` 的 Chat Completions JSON 模式。 [DeepSeek Key](https://platform.deepseek.com/api_keys) · [JSON 模式](https://api-docs.deepseek.com/zh-cn/guides/json_mode/) |
| MiniMax H3 文生视频、首帧生视频 | 填 `MINIMAX_API_KEY`，使用支持 H3 视频的 Key。默认中国站 `https://api.minimax.cn`。国际站 Key 将 `MINIMAX_BASE_URL` 改成 `https://api.minimax.io`。素材默认 768P，可将 `MINIMAX_VIDEO_RESOLUTION` 改为 `2K`。 [中国站 Key](https://platform.minimax.cn/console/keys) · [H3 接入](https://platform.minimax.cn/docs/guides/video-generation) |
| 离线分镜与程序图解 | Key 可留空。选择示例或粘贴 2–6 段资料即可分镜，预览和导出需要 FFmpeg、Piper 语音和中文字体。 |

视频素材也可以通过导出提示词、在外部生成并导入 MP4 获得。配置页显示服务器是否读到 Key。权限和额度由供应商在调用时校验。

## 三种出片方式

- **混合制作**。已确认的模型镜头或导入素材负责真实场景、氛围和动作。文本模型会为每幕建议程序图解或视频素材，工作台可以修改。标为图解的镜头走图解，视频素材未确认时使用图解占位。
- **全视频素材**。每幕都须先预览并确认对应素材。修改影响画面的提示词、首帧、时长或风格后，相应素材需要重新验收。
- **程序图解**。模型只输出受约束的分镜 JSON，固定组件渲染标题、重点、对比、步骤与时间线。构图使用统一字体、留白与字幕区，每幕突出当前讲到的要点。渲染器只执行项目自带代码。

把数字、公式、对比关系和步骤标签交给程序，把实验动作、人物、材质与自然光交给视频模型。一幕只表达一个知识点。验收视频素材时先看主体、动作和与相邻镜头的衔接，验收图解时核对术语、字幕和旁白。工作台的「查看程序图解的画面规范」可以用于指导分镜模型，制作 Skill 也可用于 Codex。

选中镜头后可编辑画面指令，上传参考首帧，调用 MiniMax H3 或导入其他模型的成片片段。软件检查解码、长度、画幅、黑屏和静止区间，最终由用户确认动作、主体和教学准确性。已经提交的同版本镜头可以查进度或复用，需主动选择重新生成才会再次提交。合成时关闭原素材声音，统一用中文旁白和所选配乐。模型镜头时长和实际旁白时长有差异时，合成会裁剪、轻微减速或保留尾帧。较长旁白建议拆成多个镜头。

## 赛场演示

1. 在对话页说「纪实电影感，深蓝配色，温暖钢琴，讲给初中生，画面要求：自然侧光、镜头慢推」。
2. 保存 `quiet-film`，点「用这套风格制作」，换一个题目。展示全片提示词包含风格、受众、声音指导和本次导演要求。
3. 选「金属为什么摸起来更冷」示例。使用 `examples/metal-reference.jpg` 作为首帧，画面提示可以写「实验桌上并排放置金属和木头，手从画面上方伸入，缓慢触摸两件材料，固定机位」。
4. 先播放并验收一幕，再用混合方式导出。展示准确的知识字幕叠在画面上，以及更新第二幕时其他镜头可以复用。
5. 用三项数据做对照。记录生成镜头数、最终采纳数和单幕返工耗时，采纳率用实际演示结果填写。

`examples/outputs/` 里的样片标明了视觉来源。生成参考图制作的镜头用局部动画做预演，可直接导入工作台。现场可替换为 MiniMax H3 成片。

## Skill 与命令行

项目 Skill 在 `.agents/skills/`。在 Codex 打开项目时可以按名称调用。个人 Skill 可从风格对话页下载，也可把解压的文件夹放入 `.agents/skills/`。

```bash
python -m studio.cli interview draft.json "纪实电影感，深蓝配色，温暖钢琴"
python -m studio.cli save-style draft.json quiet-film profiles
python -m studio.cli plan examples/brief.json project.json --style profiles/quiet-film/profile.json
python -m studio.cli prompts project.json video-prompts.json
python -m studio.cli render project.json output --engine hybrid
```

官方接口资料：[创建 H3 视频任务](https://platform.minimax.cn/docs/api-reference/video-generation-v2-create) · [查询任务](https://platform.minimax.cn/docs/api-reference/video-generation-v2-query)

## 前端动效

首页用 Three.js 绘制玻璃折射和粒子换场。视频工作台用 GSAP 做面板入场，Anime.js 更新进度环并在最近工程首次显示或新增时做轻量错峰。动效响应系统「减少动态效果」设置。最近工程保存到当前浏览器，工程 JSON 可通过「保存工程」下载，引用的素材保存在本地服务。前端 bundle 已编译到 studio/web/effects。修改 frontend 下的动效源码后运行 npm ci 和 npm run build。

动效来源：[GSAP](https://gsap.com/) · [Anime.js](https://animejs.com/) · [Three.js](https://threejs.org/)
