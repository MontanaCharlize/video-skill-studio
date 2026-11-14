---
name: video-style-interview
description: Discover a creator's video style through conversation and previews, then save a personal style skill for the video-production workflow.
---

# Interview for a reusable video style

1. Start in the project's chat workspace or from the terminal described in the README. Load an existing profile when the user asks to modify it.
2. Explore one concrete preference at a time. Capture audience, narration, palette, visual direction, camera and lighting preferences, pace, music and volume. Use previews and soundtrack samples to check what the user means.
3. Use `python -m studio.cli interview draft.json "the preference"` for terminal turns. If a request only changes one scene or one video's direction, pass it to video-production.
4. Present the complete style draft. On confirmation, save it using the UI or `python -m studio.cli save-style draft.json STYLE-NAME profiles`. Store preferences in `profile.json` with its accompanying `SKILL.md`.
5. Hand the saved profile to video-production before storyboarding. Use it to guide both the master prompt and the shot prompts and to set final voice and mix defaults.
