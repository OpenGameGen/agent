---
kind: upgrade-guide
description: "自有桌面产品改用 OpenGameGen 身份、命令、链接和数据目录，替代官方 Harness 默认值。"
---

# 使用独立的 OpenGameGen 安装

[English](guide.md) | 中文

## 变更

本指南适用于本仓库的自有桌面产品。应用名为 OpenGameGen（`com.opengamegen.desktop`），公开命令为 `opengamegen`（Windows 为 `opengamegen.cmd`），外部链接使用 `opengamegen://open`。官方 `dsh` 命令和 `dsh://` 处理程序独立保留。

业务数据位于 `~/.opengamegen`，包含 `profiles/desktop`、凭据、会话、身份和托管运行环境；Agent 配置位于 `~/.opengamegen/agents`。Electron 数据在 macOS 为 `~/Library/Application Support/OpenGameGen`，Windows 为 `%APPDATA%\OpenGameGen`。环境中已有的 `DSH_HOME`、`DSH_AGENTS_HOME` 不再选择产品数据目录。既有 `~/.dsh` 和官方 Electron 数据保留，不自动迁移。

## 迁移

1. 将 `OpenGameGen.app` 或 OpenGameGen Windows 安装包与官方应用并列安装。发布构建在 `apps/desktop/.env.macos`、`.env.windows` 中设置 `DSH_DESKTOP_APP_ID=com.opengamegen.desktop`。发布消费方改用 `opengamegen-` 产物前缀。产品更新仍按已有产品发布策略默认关闭，启用需显式配置。
2. 产品快捷方式中的 `dsh://open` 改为 `opengamegen://open`，通过产品命令菜单安装 `opengamegen` 终端命令。官方链接和命令继续使用 `dsh`。Windows 修改 PATH 后需新建终端。
3. 启动 OpenGameGen 创建新的产品数据，重新配置模型凭据。自定义位置在启动前设置 `OPENGAMEGEN_HOME`，可选设置 `OPENGAMEGEN_USER_DATA`，均使用独立绝对路径。与默认官方根重叠的路径及符号链接别名会被拒绝，业务数据与 Electron 数据根也必须分开。自定义的官方数据位置同样需保持独立。
4. 在任何手动迁移获得独立验证之前保留旧数据。本次变更不复制或删除旧会话及凭据。先启动两款应用，检查目录和命令解析分别独立，再移除曾使用官方名称的旧产品构建。
