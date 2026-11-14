---
name: video-production
description: Create and revise Chinese knowledge videos. Load the user's confirmed personal video style, compile a complete production prompt and shot prompts, review generated footage, and export with precise voice, captions and graphics.
---

# Produce a knowledge video

1. Work from the project root and follow the README for one-time setup. If the user asks to discover a reusable style, invoke `video-style-interview`. If they name an existing style, read its `profile.json` as data.
2. Create a brief JSON with `topic`, optional `audience`, `source` and `direction`. Run `python -m studio.cli plan brief.json project.json --style PATH/profile.json`. Pass the profile before writing the storyboard. Explicit requirements for this project take precedence.
3. Run `python -m studio.cli prompts project.json video-prompts.json`. Present the complete prompt and any shots with pending factual or visual details. Review each shot for a concrete subject, a single visible action, a camera instruction, shared visual direction and space for subtitles.
4. Use the local studio to attach a first frame and generate one shot with MiniMax H3. Review before accepting. Other models can use the exported prompt and import MP4. Use fixed graphics for exact formulas, dates and numeric relationships.
5. Set `visual_method` to `footage` for visible experiments, motion, materials or atmosphere, and `diagram` for precise labels, relationships, formulas or values. In hybrid production, confirm generated or imported footage and use deterministic graphics for diagrams. For diagrams, use the validated scene fields and the built-in title, highlight, sequence, timeline and comparison layouts. Choose a layout that explains the relationship, keep one primary point per scene, and render captions from the approved narration. Give each shot consistent typography, palette and caption-safe space.
6. Use `python -m studio.cli render project.json output --engine hybrid`, or export in the UI. Choose `model` when every shot must have approved footage or `code` for pure graphics. On a revision, keep IDs stable, regenerate only affected shots, and review the updated caption timing.
7. Deliver `video.mp4`, `subtitles.srt`, `project.json` and the prompts when requested. Label footage from external generation separately from fixed graphics and report any visual checks still pending.
