---
kind: upgrade-guide
description: "The product desktop uses OpenGameGen identity, commands, links and data roots instead of the official Harness defaults."
---

# Use the separate OpenGameGen installation

English | [中文](guide.zh.md)

## Change

This guide applies to this repository's product desktop. The application is OpenGameGen (`com.opengamegen.desktop`), the public command is `opengamegen` (`opengamegen.cmd` on Windows), and external links use `opengamegen://open`. The official `dsh` command and `dsh://` handler remain separate.

Business data uses `~/.opengamegen`, including `profiles/desktop`, credentials, sessions, identity and managed runtimes. Agent configuration uses `~/.opengamegen/agents`. Electron data uses `~/Library/Application Support/OpenGameGen` on macOS and `%APPDATA%\OpenGameGen` on Windows. Ambient `DSH_HOME` and `DSH_AGENTS_HOME` no longer select the product's storage. Existing `~/.dsh` and official Electron data are retained without automatic migration.

## Migration

1. Install `OpenGameGen.app` or the OpenGameGen Windows installer alongside the official application. Build releases with `DSH_DESKTOP_APP_ID=com.opengamegen.desktop` in `apps/desktop/.env.macos` and `.env.windows`. Update publication consumers to the `opengamegen-` artifact prefix. Product updates remain disabled unless explicitly configured under the existing product release policy.
2. Replace product shortcuts using `dsh://open` with `opengamegen://open`, and install the `opengamegen` terminal command through the product's command menu. Keep official `dsh` links and commands for the official application. Windows users must open a new terminal after PATH changes.
3. Start OpenGameGen to create fresh product data. Reconfigure its model credentials. For a custom location, set `OPENGAMEGEN_HOME` and optionally `OPENGAMEGEN_USER_DATA` to separate absolute paths before launching. Paths overlapping default official roots are rejected, including symbolic aliases. Business and Electron roots must remain separate. Custom official data locations must also be kept separate.
4. Keep old data until any manual migration has been independently verified. This change neither copies nor deletes old sessions or credentials. Launch both applications and check their separate directories and command resolution before removing an older product build that used the official name.
