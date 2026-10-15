---
kind: upgrade-guide
description: OpenGameGen defaults new conversations to General and removes the separate Three.js selector choice.
---

# Use General for multiple game engines

English | [中文](guide.zh.md)

## Change

OpenGameGen now shows General and Godot in its product selector and defaults new conversations to `general`. General includes Three.js creation, web preview, Godot tools and optional engine-specific skills. Unity development uses ordinary coding tools and requires a local Unity Editor for builds or play mode. The legacy `threejs` preset remains loadable.

## Migration

1. No manual session migration is required. Unused Standard/Three.js drafts follow the product default; started conversations keep their preset.
2. If a local `cordis.patch.yml` overrides `agent-preset-registry.config.default` with `threejs`, change it to `general` to adopt the new default. The legacy preset remains available for historical sessions.
3. After upgrading, open a new conversation and check that the selector offers General and Godot. Existing Three.js conversations should remain accessible. This change has not been tested or packaged at the user's request.
