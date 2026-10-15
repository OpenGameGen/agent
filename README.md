# OpenGameGen

English | [中文](README.zh.md)

OpenGameGen is a desktop AI assistant for creating and editing games, built on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). Describe your game, work with the agent on code and assets, and preview supported games in the desktop workspace.

## Capabilities

- **General and Godot agents:** General is the default entry for existing projects and multiple engines, including Three.js and Unity guidance. Godot provides dedicated project, scene, resource, run, and export tools. Unity compilation and execution require a local Unity Editor.
- **Game previews:** Preview Godot Web exports and browser games, send input, inspect errors, and capture screenshots with the game tools.
- **Models and images:** Use automatic free-model selection (`free-auto`), configure a model provider, and generate images through Perchance or AI Horde. Free services depend on network access, availability, and queues.
- **Development environments:** Manage Node.js, Python, Blender, and Godot on demand from settings, with support for reusing compatible local installations.
- **Desktop workspace:** Enter without an account login, keep project conversations, and use product data directories isolated from the official Harness application.

See the [Godot guide](PRODUCT_GODOT.zh.md) for engine usage.

## Installation

The product targets macOS Apple Silicon, macOS Intel, and Windows x64. The [Product installers workflow](.github/workflows/product-installers.yml) builds DMG and EXE packages on pushes to the remote `main` branch and on manual runs.

Open [GitHub Actions](https://github.com/OpenGameGen/agent/actions/workflows/product-installers.yml), select a successful run, and download the package from **Artifacts**. Artifacts are retained for 14 days and require GitHub access. This workflow produces macOS ad-hoc signed packages without Developer ID signing or notarization, and unsigned Windows packages; automatic updates are disabled for these builds.

The project is a developer preview. The [three-platform packaging run](https://github.com/OpenGameGen/agent/actions/runs/38539083865) passed native packaging, packaged-runtime smoke checks, and artifact upload for all three targets. Actual installation and interactive desktop acceptance of those artifacts remain unverified. The current General-agent consolidation also needs behavior verification.

<a id="run"></a>

<a id="run-from-source"></a>

## Source development

The repository requires Node.js `^22.19.0 || >=24.0.0` and the pnpm version declared in [package.json](package.json). The desktop development entry is `pnpm run dev:desktop`; it prepares the development application and launches the supported desktop runtime. `pnpm run start:desktop` uses existing build artifacts.

Clone the product repository from [OpenGameGen/agent](https://github.com/OpenGameGen/agent) and use the remote `main` branch as the product baseline. The public repository contains product snapshot history. Upstream integration stays in a separate local development repository with the full upstream history; publish committed source snapshots without merging upstream Git history. Read the [development guide](docs/development.md) and [desktop build guide](apps/desktop/README.md) for setup and packaging. The official `@deepseek-ai/dsh` npm package distributes upstream Harness; use this fork's source or product artifacts for OpenGameGen.

## Architecture and contributions

OpenGameGen retains the Cordis plugin architecture and supported `dsh` profile launch path. Product capabilities use independent plugins, providers, and configuration where available, with focused desktop integration changes. Start with the [architecture](docs/architecture.md) and [Cordis primer](docs/cordis-primer.md).

Report product issues in [OpenGameGen/agent](https://github.com/OpenGameGen/agent/issues). Review the [safety notice](SAFETY.md) before running agents and the [contribution guide](CONTRIBUTING.md) before contributing.

## License and acknowledgements

[MIT](LICENSE). OpenGameGen builds on DeepSeek AI's DeepSeek Harness and Cordis. Third-party dependencies and licenses are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
