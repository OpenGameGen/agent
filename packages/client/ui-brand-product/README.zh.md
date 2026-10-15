---
kind: package-reference
description: "产品侧栏品牌"
---

# @deepseek-ai/dsh-client-ui-brand-product

[English](README.md) | 中文

## 概述

私有桌面插件使用 `sidebar.brand.mark` 与 `sidebar.brand.name` 槽位，标志留空，名称显示 OpenGameGen。产品默认配置先禁用官方品牌，再加入此插件。

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

注册等待槽位声明，并随插件释放；不修改模型请求或会话日志。

<a id="model-experience"></a>
## 模型体验

无；本包仅提供浏览器界面，不添加模型消息或工具。

#### KV 缓存影响

无；本包不构造 provider 请求。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- 本插件仅修改侧栏品牌；安装包标识和数据目录由桌面壳负责。


<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护背景 — 点击展开</summary>

合并上游更新时检查公开槽位和桌面产品 bundle 的兼容性。

</details>
