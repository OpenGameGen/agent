---
kind: package-reference
description: "Product engine selector"
---

# @deepseek-ai/dsh-client-ui-engine-product

English | [中文](README.zh.md)

## Summary

This private desktop plugin occupies `conversation.hero.agentPreset` with General and Godot, mapped to `general` and `godot`. General includes Three.js and engine-specific skills; the legacy `threejs` preset remains loadable.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Use this package

The desktop product bundle mounts this package; its Node entry is inert.

## Understand the implementation

The controller stages choices before a draft exists and uses `remote.agentPresets.select` for blank main-view sessions. Started conversations retain their preset. Missing or broken presets show an error; registrations and subscriptions dispose with their contexts.

## Model Experience

Indirectly, through the selected host preset, whose plugins own model-visible tools and prompts.

#### KV Cache effect

The selected preset owns request construction and cache effects.

## Known Limitations and Deferred Work

- Unity requires a local Unity Editor for builds and play mode. This package selects host presets; it does not install engines or provide dedicated Unity tools.


<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Keep the public slot and desktop product bundle compatible when merging upstream updates.

</details>
