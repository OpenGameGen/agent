---
kind: upgrade-guide
description: OpenGameGen 新会话默认使用通用，并移除独立的 Three.js 选择项。
---

# 使用通用开发多引擎游戏

[English](guide.md) | 中文

## 变更

OpenGameGen 产品选择器现在显示通用、Godot，新会话默认 `general`。通用包含 Three.js 创建、网页预览、Godot 工具及按需加载的引擎技能。Unity 开发使用普通编程工具，构建和运行需要本机 Unity Editor。旧 `threejs` preset 仍可加载。

## 迁移

1. 无需手动迁移会话。未使用的 Standard/Three.js 草稿遵循产品默认；已经开始的会话保留 preset。
2. 若本地 `cordis.patch.yml` 将 `agent-preset-registry.config.default` 覆盖为 `threejs`，改为 `general` 可采用新默认。旧 preset 继续供历史会话加载。
3. 升级后新建会话，确认选择器提供通用、Godot，旧 Three.js 会话仍可打开。按用户要求，本次变更未测试、未打包。
