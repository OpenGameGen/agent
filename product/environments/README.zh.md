# 托管开发环境

[English](README.md) | 中文

桌面应用通过独立 `desktop-environments` Cordis 插件、应用资源 CLI 和桌面启动环境模块管理 Node.js、Python、Blender 与 Godot。沿用 `dsh` 的 desktop profile，不修改 Agent 核心、系统 PATH 或 shell 启动文件。Node.js、Python、pnpm 复用桌面 primary-runtime，版本由发行包锁定；Blender 4.5.14 LTS 和 npm 11.6.2 通过管理界面或固定工具按需从应用资源锁文件下载，验证长度与 SHA-256。Godot 4.6 使用现有安装器、模板和 Headless 工具，见 [Godot 说明](../../PRODUCT_GODOT.md)。

## 使用

默认用户终端通过受支持的 `terminal-controller` profile 配置运行不读取启动脚本的 Bash（macOS）或禁用 AutoRun 的 CMD（Windows），保留托管环境的 PATH 顺序；用户仍可选择其他 Shell，其自定义启动脚本可能覆盖 PATH。应用新建的默认本地终端和 Agent Shell 可使用 `agent-env`、`node`、`npm`、`npx`、`pnpm`、`python`、`python3`、`pip`、`pip3`、`blender` 以及原有 Godot 命令。桌面直接打开工作区，不检测或安装引擎。应用菜单提供“创作环境管理”，可按需查询和准备工具。Agent 先查询 status/doctor，再对缺失组件调用固定 ensure 操作，不自行选择下载 URL 或运行系统安装命令。`manage_runtime_environment` 工具支持 `status / doctor / ensure / repair`。`managed-development-environments` 技能说明隔离依赖和工具使用方式。远程 SSH 机器使用自己的环境。

```sh
agent-env prepare-desktop
agent-env status
agent-env doctor all
agent-env ensure blender
agent-env repair blender
agent-env open blender
agent-env project "/path/to/existing/project" --python --node
```

`status` 查询已安装状态；`doctor` 实际执行版本及基础能力检查，不联网下载。Blender 启动命令可打开完整原生界面，自动化建模使用普通 Shell 执行 `blender --background --factory-startup --python script.py`。GUI、GPU 渲染和目标机器兼容性需要分别验证，版本检查不代表这些能力已通过。

## 目录与项目依赖

共享下载、Blender/npm 版本目录、启动器及缓存位于应用 Harness home 下的 `dsh-runtimes/environments/`。解释器来自应用专属 primary-runtime；不复制到每个项目。项目命令要求目录已经存在，创建 `.venv` 和 `.agent-environment.json`，记录当前发行版的 Node/Python 版本，并保留已有环境；已有版本冲突时拒绝覆盖。本版本不提供任意版本下载或自动版本切换。元数据不是通用包管理器的版本约束；在其他工具直接启动项目时不会强制选择版本。

在项目目录内执行 npm/pnpm 安装，依赖留在 `node_modules`。Python 使用项目 `.venv/bin/python -m pip`，Windows 使用 `.venv\Scripts\python.exe -m pip`。托管 `python`、`pip` 启动器优先使用 `VIRTUAL_ENV` 或当前目录的 `.venv`；没有虚拟环境时 pip 拒绝安装。子进程使用私有 npm/pip 缓存，npm 启动器仅给自身的子进程设置私有全局前缀，避免干扰用户 Shell 的 nvm，不更改系统配置。Blender 自带 Python 与项目 Python 分离。没有预编译包的原生依赖仍可能需要额外编译器和系统库。

## 修复与交付

安装使用跨进程锁、验证过的缓存、临时目录和发布前版本检查。下载或解压失败不发布新版本，可再次准备；死进程安装锁由单独恢复锁回收。修复 Blender/npm/Godot 先验证新目录，再替换旧目录，保留 `.previous-*` 目录；不触碰项目和 Godot 导出模板。基础 Node/Python 解释器损坏时提示重装桌面软件。锁文件的手工恢复提示表示恢复状态无法可靠判定。

应用资源位于 `apps/desktop/resources/environments/`，由 electron-builder 交付到 ASAR 外的 `runtime/environments/`，与 Godot 资源相邻。`apps/desktop/src/product/runtime-environment.ts` 建立私有命令和子进程环境；`apps/desktop-host/src/environments.ts` 注册工具与技能；桌面 `main.ts` 和 Host `index.ts` 是集中接入点。macOS 支持 arm64/x64，Windows 发行目标为 x64。官方下载需网络；普通 macOS DMG / Windows NSIS 只安装应用，不检测或准备 Godot、Blender、模板。应用启动只建立私有命令启动器，直接进入主界面。应用菜单“创作环境管理”可手动查询、准备和修复，关闭窗口取消操作但不关闭主界面。Agent 先用 `manage_runtime_environment(action=status/doctor)` 检测，缺失时调用 `action=ensure` 与固定组件名，不自行选择下载 URL 或运行系统安装命令。Godot 4.6.stable 官方版本和 Blender 4.5+ / 5.x 会通过 PATH 与常用安装位置探测实际版本后复用；不同版本保留，所需固定版本安装到产品目录。`runtime=templates` 独立准备 Godot 模板；Node/Python 损坏仍需重装应用。修复仅替换产品管理目录，不修改用户外部工具。

升级时检查 primary-runtime 元数据、Blender/npm 锁文件、Godot 修复接口、资源打包、新终端命令解析、插件加载卸载与项目虚拟环境。实际测试及平台范围记录在 [REQ-005](../requirements/REQ-005-runtime-manager.md)。

普通 macOS DMG / Windows NSIS 仅安装桌面应用。通过 PATH 和常用应用位置检测 Godot 4.6.stable 官方版本与 Blender 4.5+ / 5.x，验证版本后复用；保留其他版本。模板组件可独立准备 Godot 导出模板。关闭管理窗口取消其操作，不关闭工作区。
