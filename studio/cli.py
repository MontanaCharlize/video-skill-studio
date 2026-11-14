"""Command line entry points for Codex and the browser-independent pipeline."""
import argparse
import json
from pathlib import Path

from .core import Brief, Project, Style, export_style, interview, plan, write_json
from .director import approved_assets, compile_project
from .render import build

def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))

def main():
    parser = argparse.ArgumentParser(description="Generate, edit and export a knowledge video.")
    commands = parser.add_subparsers(dest="operation", required=True)
    p = commands.add_parser("plan")
    p.add_argument("brief", type=Path)
    p.add_argument("project", type=Path)
    p.add_argument("--style", type=Path)
    p.add_argument("--style-name", default="")
    p = commands.add_parser("prompts")
    p.add_argument("project", type=Path)
    p.add_argument("output", type=Path)
    p = commands.add_parser("render")
    p.add_argument("project", type=Path)
    p.add_argument("output", type=Path)
    p.add_argument("--quality", choices=("preview", "export"), default="export")
    p.add_argument("--engine", choices=("code", "hybrid", "model"), default="hybrid")
    p = commands.add_parser("interview")
    p.add_argument("draft", type=Path)
    p.add_argument("message")
    p.add_argument("--history", type=Path, help="Optional JSON array of recent conversation turns")
    p = commands.add_parser("save-style")
    p.add_argument("draft", type=Path)
    p.add_argument("name")
    p.add_argument("output", type=Path)
    args = parser.parse_args()
    if args.operation == "plan":
        payload = read_json(args.brief)
        if args.style:
            payload["style"] = {**read_json(args.style), **payload.get("style", {})}
        brief = Brief.model_validate(payload)
        project = Project(topic=brief.topic, scenes=plan(brief), style=brief.style,
                          style_skill=args.style_name or (args.style.parent.name if args.style else ""),
                          direction=brief.direction)
        write_json(args.project, project.model_dump())
    elif args.operation == "prompts":
        project = Project.model_validate(read_json(args.project))
        write_json(args.output, compile_project(project))
    elif args.operation == "render":
        project = Project.model_validate(read_json(args.project))
        build(project.scenes, project.style, args.quality, args.output,
              lambda i, n, title: print(f"[{i}/{n}] {title}", flush=True), assets=approved_assets(project, args.engine))
    elif args.operation == "interview":
        draft = Style.model_validate(read_json(args.draft)) if args.draft.exists() else Style()
        history = read_json(args.history) if args.history else []
        draft, reply = interview(args.message, draft, history)
        write_json(args.draft, draft.model_dump())
        print(reply)
    else:
        draft = Style.model_validate(read_json(args.draft))
        export_style(args.name, draft, args.output / args.name)
        print(args.output / args.name)

if __name__ == "__main__":
    main()
