---
kind: package-reference
description: "产品引擎选择器"
---

# @deepseek-ai/dsh-client-ui-engine-product

[English](README.md) | 中文

## 概述

私有桌面插件使用 `conversation.hero.agentPreset` 槽位显示通用与 Godot，对应 `general` 与 `godot`。通用包含 Three.js 与引擎技能，旧 `threejs` preset 仍可加载。

## 目录

- [使用此包](#use-this-package)
- [实现说明](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## 使用此包

桌面产品 bundle 加载本包；Node 入口不执行操作。

<a id="understand-the-implementation"></a>
## 实现说明

控制器在草稿出现前暂存选择，通过 `remote.agentPresets.select` 应用到主界面空白会话。已开始会话保留 preset。缺失或损坏的 preset 显示错误；注册和订阅随 context 释放。

<a id="model-experience"></a>
## 模型体验

通过所选 Host preset 间接影响模型，其插件负责模型可见工具和提示词。

#### KV 缓存影响

所选 preset 负责请求构造和缓存影响。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- Unity 构建和运行需要本机 Unity Editor。本包仅选择 Host preset，不安装引擎，也不提供专用 Unity 工具。


<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护背景 — 点击展开</summary>

合并上游更新时检查公开槽位和桌面产品 bundle 的兼容性。

</details>
