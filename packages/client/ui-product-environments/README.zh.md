---
kind: package-reference
description: "产品环境设置"
---

# @deepseek-ai/dsh-client-ui-product-environments

[English](README.md) | 中文

## 概述

私有桌面插件通过公开的 `settings.general.item` 槽位加入创作环境管理入口，本地化按钮通过 Electron 桥接打开环境管理窗口。

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

Node 入口不执行操作。浏览器激活时注册本地化和槽位效果，由 desktop-host 产品 bundle 交付客户端包。按钮不调用模型，也不写入会话日志。

<a id="model-experience"></a>
## 模型体验

无；本包仅提供浏览器界面，不添加模型消息或工具。

#### KV 缓存影响

无；本包不构造 provider 请求。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- 入口依赖产品桌面桥接；普通 Web 部署不能打开原生管理窗口。工具准备、取消和复用由环境管理器负责。


<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护背景 — 点击展开</summary>

合并上游更新时检查公开槽位和桌面产品 bundle 的兼容性。

</details>
