# OpenGameGen

[English](README.md) | 中文

OpenGameGen 是基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 开发的桌面 AI 游戏开发助手。描述你的游戏，与 Agent 一起编写代码和制作素材，并在桌面工作区中预览支持的游戏。

## 功能

- **通用与 Godot Agent：** 默认使用通用入口，支持已有项目及多引擎开发，包括 Three.js 和 Unity 使用指南。Godot 提供专用项目、场景、资源、运行和导出工具。Unity 编译与运行需要本机安装 Unity Editor。
- **游戏预览：** 预览 Godot Web 导出与网页游戏，通过游戏工具发送操作、检查错误和获取截图。
- **模型与图片：** 使用“免费模型-自动”（`free-auto`）、配置模型提供商，并通过 Perchance 或 AI Horde 生成图片。免费服务受网络、服务可用性和排队情况影响。
- **开发环境：** 从设置中按需管理 Node.js、Python、Blender 和 Godot，并支持复用兼容的本机安装。
- **桌面工作区：** 无需账号登录即可进入，保存项目对话，产品数据目录与官方 Harness 应用隔离。

引擎使用说明见 [Godot 指南](PRODUCT_GODOT.zh.md)。

## 安装

产品面向 macOS Apple Silicon、macOS Intel 和 Windows x64。[Product installers 工作流](.github/workflows/product-installers.yml) 在推送远端 `main` 或手动运行时构建 DMG 和 EXE 安装包。

打开 [GitHub Actions](https://github.com/OpenGameGen/agent/actions/workflows/product-installers.yml)，选择成功的运行，从 **Artifacts** 下载对应安装包。产物保留 14 天，下载需要 GitHub 访问权限。该工作流生成的 macOS 安装包采用 ad-hoc 签名，未做 Developer ID 签名或公证；Windows 安装包未签名；这些构建关闭自动更新。

项目处于开发者预览阶段。[三平台打包运行](https://github.com/OpenGameGen/agent/actions/runs/38539083865)已通过三个原生目标的打包、包内运行时检查和产物上传；这些产物的实际安装与桌面交互验收仍待完成。当前通用 Agent 合并版本也仍需行为验证。

<a id="run"></a>

<a id="run-from-source"></a>

## 源码开发

仓库要求 Node.js `^22.19.0 || >=24.0.0`，pnpm 版本以 [package.json](package.json) 为准。桌面开发入口为 `pnpm run dev:desktop`，会准备开发应用并启动受支持的桌面运行时。`pnpm run start:desktop` 使用已有构建产物。

从 [OpenGameGen/agent](https://github.com/OpenGameGen/agent) 克隆产品仓库，以远端 `main` 为产品基线。公开仓库仅保留产品快照的提交历史。上游同步在保留完整历史的独立本地开发仓库中进行；将已提交源码快照发布到此仓库，不合并上游 Git 历史。环境准备和打包请阅读[开发指南](docs/development.zh.md)与[桌面构建指南](apps/desktop/README.zh.md)。官方 `@deepseek-ai/dsh` npm 包分发上游 Harness；OpenGameGen 使用本 fork 的源码或产品构建产物。

## 架构与贡献

OpenGameGen 保留 Cordis 插件架构和受支持的 `dsh` profile 启动路径。产品功能优先采用独立插件、provider 与配置，并集中维护必要的桌面集成改动。可从[架构文档](docs/architecture.zh.md)和 [Cordis 入门](docs/cordis-primer.zh.md)开始了解。

产品问题请提交至 [OpenGameGen/agent](https://github.com/OpenGameGen/agent/issues)。运行 Agent 前阅读[安全说明](SAFETY.zh.md)，参与开发前阅读[贡献指南](CONTRIBUTING.zh.md)。

## 许可证与致谢

[MIT](LICENSE)。OpenGameGen 基于 DeepSeek AI 的 DeepSeek Harness 与 Cordis 开发。第三方依赖及许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
