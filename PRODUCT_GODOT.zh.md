# 托管 Godot 4.6

[English](PRODUCT_GODOT.md) | 中文

## 摘要

此产品桌面版在新建的本地终端和 Agent Shell 的 PATH 中提供 `godot`、`godot4` 和 `godot-project`。用户无需自行安装 Godot 或修改 Shell 配置。首次打开桌面应用时自动准备固定版本的标准引擎、Blender 和导出模板，成功后才启动创作工作区；再次启动或重装应用检查版本并复用健康安装。已安装且完整的同版本模板会被复用。下载需要联网；安装完成的资源可离线使用。

## 命令

打开右侧边栏，选择**新建终端**，然后运行：

```sh
godot --version
godot --help
godot-project status
godot-project install
godot-project install --templates
godot-project check "/path/to/project"
godot-project run "/path/to/project" --rendering-method gl_compatibility
godot-project editor "/path/to/project"
godot-project export "/path/to/project" "Windows Desktop" "build/game.exe"
godot-project export "/path/to/project" "macOS" "build/game.zip" --debug
godot-project export "/path/to/project" "Windows Desktop" "build/game.pck" --pack
```

项目必须包含 `project.godot`；导出必须使用 `export_presets.cfg` 中真实存在的预设名称。相对输出路径以项目目录为基准。Mac 通用架构或 ARM64 预设可能需要在项目设置中启用 ETC2/ASTC 纹理导入。游戏和编辑器进程保持连接终端；关闭对应窗口或中断命令即可停止。标准 `godot` 参数原样传给引擎。

`check` 导入资源并解析项目内的 GDScript，排除符号链接和缓存。导入、脚本、超时或引擎错误会返回非零状态，包括 Godot 退出码为零但日志包含错误的情况。它不证明运行时正确性。应实际运行游戏，或用 `godot-project run "/path/to/project" --headless --quit-after 60` 做有限帧运行检查。`godot-project run` 会将引擎日志中的运行错误转为非零状态；普通 `godot` 保留原生退出码。无错误的短运行不证明脚本已挂载或玩法可用。`--pack` 生成资源包，不是独立可执行文件。

## AI 工作流程

桌面插件注册 `godot-game-development` 技能和 `load_godot_runtime` 工具。后者只准备固定的官方运行资源，只接受可选的 `export_templates` 布尔参数，不执行项目代码。受限 Shell 操作前先调用它，避免为了安装引擎而扩大项目权限。项目执行继续使用原有 Shell 和终端工具，工作区权限检查仍然有效。

## 首次生成的最短交付流程

1. 先实现一个小型可玩循环：可见角色、一个操作、目标、反馈和重新开始。未指定维度时默认简单 2D；明确要求 3D 时先做最小 3D 原型。先验证玩法，再增加装饰和系统，脚本保持短小。
2. 准备引擎，创建 `project.godot`、主场景和目录。用原生工具小步创建节点/资源，普通文件工具写脚本再绑定。1–16 步相关创建/添加/赋值/引用可用 `godot_edit_batch`；其他编辑可 `godot_edit_transaction(begin)` → 小调用 → `commit`。
3. `godot-project check` → 有限帧 Headless 检查。先修复首个解析或运行错误，再继续加功能。
4. 准备模板后 `game_start(project)` → `game_tree()` 获取真实运行节点路径 → 读取初始状态 → 输入 → `game_assert` 检查变化 → `game_errors` → `game_screenshot`。Web 预设由工具在副本中生成，无需在源项目猜测一个预设。代码变更后再调用 `game_start`。
5. 交付时停止编辑 Worker，保留最终侧边栏预览，并说明操作、目标和重新开始方式。`game_stop` 会关闭用户体验页面，只用于废弃实例或结束预览。模型不支持图像时应说明未完成视觉检查，不能仅凭截图文件存在宣称画面正确。

| 参数 | 正确用法 |
|---|---|
| 原生编辑 `project`、`game_start.project` | 含 `project.godot` 的绝对目录 |
| 原生编辑 `node` | `root` 或 `Player/Camera2D` |
| 运行工具 `node_path` | 从 `game_tree` 获取，例如 `/root/Main/Player` |
| 原生 `value` | 单个 Godot 字面量，向量元素为数字 |
| `game_assert.expected` | 字符串内放一个 JSON 字面量；数字为 `3`、布尔为 `true`、字符串保留 JSON 双引号 |

`godot_edit_transaction` 的 `rollback` 恢复未提交组，`undo` 恢复当前 Worker 内最近提交组；常规原生失败尝试回滚并报告结果。它只跟踪原生目标文件，原文件数据限 16 MiB，普通文件工具修改不在组内，外部修改或符号链接变化不会被覆盖。组应在检查、长时间思考或停止 Worker 前尽快完成；60 秒闲置、回合结束或停止后历史失效。取消、超时、崩溃、插件卸载不是持久事务，需先检查磁盘再重试。

## 存储与故障恢复

启动脚本和引擎位于 `$DSH_HOME/dsh-runtimes/godot-4.6`；开发版使用独立的 Harness 数据目录。Node 和 Python 来自内置主运行环境。签名的桌面安装包将 CLI 资源放在 ASAR 外，下载的可执行文件放在签名应用之外。不修改全局 PATH 或系统 Godot 安装。导出模板使用 Godot 官方规定的用户数据目录，位于 `export_templates/4.6.stable` 下。官方模板压缩包约 1.2 GiB，解压后占用数 GiB；只在导出可执行游戏或显式准备模板时下载。

新压缩包先以流式方式下载到临时文件，校验固定的 SHA-256 和字节数，再安全解压并检查版本，成功后才发布。失败下载可以重试，不会把未完成的安装报告为就绪。并发安装使用共享锁。被终止的安装进程留下的锁会在确认进程已退出后回收；损坏的锁或中断的锁恢复会报告应删除的确切锁文件。桌面准备流程会暂存校验通过的新模板后修复不完整或版本不匹配的安装，并保留旧目录。直接 CLI 调用在未显式请求修复时仍报告模板损坏。下载超时由 `GODOT_DOWNLOAD_TIMEOUT_MS` 控制，默认 30 分钟。

## 支持范围与维护

桌面目标包括通过通用引擎支持的 macOS ARM64/x64，以及通过控制台可执行文件支持的 Windows x64。桌面打包暂不支持 Windows ARM64。标准版支持 GDScript；C# 需要 .NET 引擎和 SDK。Android 和 iOS 导出需要对应的平台 SDK 和签名。SSH 终端运行在其他机器上，需要该机器自己的 Godot 环境。主动替换 PATH 或定义同名 Shell 别名会改变正常命令解析。

独立的产品文件位于 `apps/desktop/resources/godot/`、`apps/desktop/src/product/godot-environment.ts` 和 `apps/desktop-host/src/godot.ts`。与上游的接入点仅包含桌面 Host 环境准备、插件挂载、依赖声明和资源复制项。升级引擎时，需要依据官方发行包摘要，同时更新 `lock.json`、带版本的运行目录、可执行文件名称、工具输出、技能说明和相关测试。合并前验证原生游戏启动、错误检测、导出以及新建终端的 PATH。

## 来源

[Godot 4.6 发行版](https://godotengine.org/download/archive/4.6-stable/)、[CLI 参考](https://docs.godotengine.org/en/4.6/tutorials/editor/command_line_tutorial.html)和[数据目录](https://docs.godotengine.org/en/4.6/tutorials/io/data_paths.html)。内置 `LICENSE.txt` 包含 Godot 的 MIT 许可证；官方二进制压缩包保留上游资源。

## 内置 Headless 游戏生成工具

桌面 Agent 默认按 Godot 4.6 GDScript 游戏生成流程工作。通过现有 Cordis 注册表直接提供内置工具，不使用 Godot MCP 或项目编辑器插件，不自动打开 GUI 编辑器或游戏窗口。普通文件工具负责 `project.godot`、`.gd`；`.tscn` 可用原生场景/节点工具或普通文件工具编辑，原生资源工具处理 `.tres` 复杂资源，输入为一次一个属性、点、轨道、关键帧、Theme 项或 Tile，不能提交整份资源批量 JSON。

先执行 `load_godot_runtime`，使用 `godot_resource_create/inspect/set/reference` 创建、检查、设置属性及资源引用；使用 `godot_curve_point`、`godot_gradient_point`、`godot_animation_track/key`、`godot_theme_item`、`godot_tile_atlas/create` 完成领域操作。属性值使用 Godot 字面量，如 `Vector2(1, 2)`、`Color(1, 0, 0, 1)`，不是代码。引擎检查类型、引用类、索引、范围和保存结果。路径限于项目内资源，父目录需已存在；导入纹理前运行 Headless 的 `godot-project check`。外部引用资源通过其自身文件路径修改，`subresource` 用冒号分隔属性链，用于检查引用或编辑内嵌资源。节点的 `godot_node_reference(property="script")` 可绑定已写好的兼容 `.gd`，错误基类或语法错误拒绝保存。向量分量先检查有限数字，整型向量拒绝小数；结构化错误保留 Worker，便于模型纠正参数。

首次资源操作启动应用资源目录的 `resource-worker.gd`，使用 `--headless --script`，不使用 `--editor`。桌面 Host 同时保留一个 Worker；同一任务/项目连续调用复用，切换项目、任务或沙箱策略时先退出旧进程。每次调用以 `CACHE_MODE_IGNORE_DEEP` 从磁盘重新加载根资源和依赖，Worker 不保留跨调用资源对象。调用 `godot_worker_stop` 主动完成；任务结束、取消、超时、卸载及空闲期限也清理进程。崩溃不会自动重放编辑，后续调用重新启动；未知结果的写入需先检查文件。

Worker 通过现有 subprocess 和每会话 sandbox 服务启动，保留工作区限制与凭据环境清理。Godot 日志放项目内随机私有临时目录，兼容各平台的工作区沙箱，退出时清理；工具脚本不写用户项目。原生工具需要 `workspace-write`，只读权限下使用普通文件读取。桌面配置明确设定空闲 60 秒、单次请求 30 秒及请求/响应 64 KiB 上限。脚本通过桌面资源复制规则交付，启动检查缺失文件。本编辑模块提供小步原生场景、节点及资源操作，支持短生命周期的原生编辑分组，不提供截图、游戏输入、编辑器桥接或任意 GDScript 执行工具；其他产品模块另行说明。

实现位于 `apps/desktop-host/src/godot-tools.ts`、`godot-worker.ts` 与应用 Godot 资源目录；不改上游 Agent 循环。`vollkorn-edit.gd` 直接迁入并适配了 [Vollkorn 固定版本的 Headless 编辑源码](https://github.com/Vollkorn-Games/godot-mcp/blob/632530638448ea3e79394fbf74e9a5c92c4b67e5/src/scripts/godot_operations.gd)，没有引入其 MCP Server、CLI dispatcher 或编辑器桥接。源码映射、适配及 MIT 归属说明见下节。

## 编辑实现的 Vollkorn 源码对齐

导入版本固定为 `632530638448ea3e79394fbf74e9a5c92c4b67e5`；`apps/desktop/resources/godot/vollkorn-source.json` 记录源文件摘要、所选函数的行号/摘要、适配及产品扩展。运行资源中的 `vollkorn-edit.gd` 包含 28 个编辑及辅助函数，`VOLLKORN_LICENSE.txt` 保留原 MIT 声明。五个类型转换、序列化及所有权辅助函数保持原始字节，并以导入时的摘要验证。

| 内置编辑接口 | 迁入的源函数 |
|---|---|
| `godot_resource_create` | `create_resource` |
| `godot_scene_create`、`godot_scene_inspect` | `create_scene`、`get_scene_tree`、`get_node_properties`、`get_tile_data` |
| `godot_scene_instance` | `instantiate_scene`、`_set_owner_recursive` |
| `godot_node_add`、`godot_node_set/reference` | `add_node`、`set_node_properties`、`_convert_property_value` |
| `godot_node_edit` | `remove_node`、`rename_node`、`reparent_node`、`duplicate_node_op`、`add_to_group`、`remove_from_group`、`connect_signal_op` |
| `godot_animation_bind` | `add_animation`，支持绑定单独编辑的 Animation 资源 |
| `godot_tileset_create`、`godot_tile_cell` | `create_tileset`、`set_cells`，按单格调用 |

直接适配源编辑函数为操作模块，不复制 MCP Server。打印及一次性退出改成结构化结果和提前返回；每次操作释放创建的节点，加载时忽略根资源及依赖缓存。核对保存结果、节点属性回读，拒绝将失败或被引擎调整的赋值报告为成功。场景根不设自身为 owner，信号连接增加 `CONNECT_PERSIST`，绑定动画前检查默认库是否存在。与源实现一致，SceneTree 操作延迟到首次 process frame，等待 autoload 初始化；修改项目设置或 autoload 配置后先调用 `godot_worker_stop`。

模型仍只创建一个根、添加一个节点、设置一个属性、绑定一个资源、编辑一个节点或写入一个 TileMap 单格。源函数的数组参数由适配层构造单项，单步工具不接收整份资源 JSON；`godot_edit_batch` 可显式组合下述受限操作。节点路径使用 `root` 或相对后代路径；编辑前检查引擎类型、名称冲突、循环父子关系、项目路径及创建覆盖。`godot_scene_inspect` 的 `view=properties/cells` 需要指定节点。绑定动画保留单独编辑后的时长和轨道；TileSet 创建工具按源实现自动铺满一个 atlas 的完整瓦片。

Theme、Curve、Gradient、类型化资源检查、内嵌资源修改、手动 atlas/单 Tile 编辑仍是产品扩展；此固定源码中不存在对应的 Theme/Curve/Gradient 专用编辑函数。不重复已有脚本、设置及通用文件编辑工具。本编辑模块未迁入资产安装、MeshLibrary 导出、自定义脚本类创建、场景分析、游戏测试、截图、游戏输入和编辑器桥接。

升级时获取明确的新源码提交，逐项比较所映射的 28 个函数，复查并应用记录的适配，更新源文件摘要/行号/函数摘要，保留原许可证。运行真实引擎场景/资源测试及原样函数摘要检查，再仅刷新并回放 Godot 会话夹具，检查桌面资源复制规则。不静默替换固定版本，也不把 macOS 测试当作 Windows 安装证据。

## 右侧浏览器运行与测试

`desktop-game-validation` 是独立 Cordis 插件，直接注册内置工具，不启动 MCP Server。先执行 `load_godot_runtime(export_templates=true)`，再执行 `game_start(project, scene?)`。项目必须是 Godot 4.6 GDScript 项目；工具在私有测试副本中配置 Compatibility、单线程 Web Debug 导出、HTML shell 和测试 Autoload，不修改源项目配置，不安装 Godot 编辑器插件。导入和导出使用 Headless 进程，右侧现有 Electron webview 运行导出游戏。当前需选择该任务再启动；后续操作自动重新显示同一游戏标签页，任务切换、页面关闭或跳转会明确拒绝观察和输入；关闭游戏页后可用 `game_start` 重新打开。

`game_screenshot` 保存 PNG；当前实际模型明确支持图片输入时返回持久图片附件，否则仅返回路径和视觉未验证说明，可切换视觉模型后用 `read_image` 读取；`game_key(key, duration_ms?)`、`game_click(x,y)` 和 `game_click_ui(node_path)` 发送浏览器输入，取消长按会释放按键。key 使用 ArrowRight、w、Space、Enter 等物理键名，不接收 ui_right 等 InputMap 动作名；动作名用于 game_reproduce 的 actions_down/actions_up。`game_keys(keys, duration_ms?)` 同时按住1–8个物理键后释放，例如 `["w", "Space"]` 用于前进加跳跃；重复键或别名冲突在输入前拒绝，取消和失败会尝试释放本次已按下的键。YAML 用 `keys: [w, Space]` 配合 `duration_ms`，录制和回放保留组合。坐标点击使用浏览器 CSS 像素；UI 工具读取 Godot Control 并转换中心坐标，SubViewport 内 UI 定位明确不支持。`game_tree(node_path?, depth?, limit?)` 返回包含非 UI 节点、脚本和场景路径的运行时树，默认从 `/root` 查 8 层、最多 200 节点；截断时按子树继续查询。`game_ui`、`game_state(node_path, property?)`、`game_logs`、`game_errors` 和 `game_metrics` 返回有限观察；日志与错误分开读取。重复 `game_start` 按源文件内容哈希检查变化；未变化时直接在原页面切换或重启指定场景，不启动 Godot 进程，Autoload 状态保留。不传 scene 则重启首次入口场景。文件变化时重新导出 PCK，复用 Web 引擎文件，启动新页面以清除资源和脚本缓存；构建失败保留旧实例。引擎或测试脚本变化时完整导出。缓存保留到停止或空闲清理。`game_stop` 关闭页面和本地服务、删除测试副本；30 分钟无工具操作时检查页面生命周期：仍打开的游戏保留，已关闭、跳转或崩溃的实例回收；无法确认时保留并重试。插件卸载也会回收。截图和报告保留在项目 `.opengame-test-results/<run-id>/` 中。

`game_assert(node_path, property, operator, expected)` 返回实际值和断言结果，expected 是一个 JSON 字面量。可选 `timeout_ms` 为 0..10000 的整数，默认 0 即时检查；正值只每 100ms 读取状态，不重复输入，YAML 写在 `assert` 同级。结果区分 immediate/eventual，保留首末实际值、次数、耗时和观测时间；等待窗口内成立不代表输入结束时立即成立、持续成立或事件发生延迟。路径/连接错误和取消不会转为成功。`game_watch_signal(node_path, signal)` 在输入前订阅并返回 cursor；`game_wait_signal(node_path, signal, after)` 从该 cursor 查询事件，最长等候 10 秒，只采集信号发生，不返回参数。`game_test(test_file)` 执行项目内 YAML 的 `name` 和最多 100 个 `steps`：支持 `key` 加 `duration_ms`、`click`、`click_ui`、`assert`、`wait_node`、`watch_signal` 后接 `wait_signal`、`screenshot`、`wait_ms`、`freeze`、`thaw`、`step`。报告区分 passed、failed、incomplete；输入已送达或截图生成不等于通过。`game_freeze/thaw/step` 仅控制可暂停 SceneTree 节点，`game_step(frames, clock)` 默认保留 process 帧；显式 `clock="physics"` 在物理边界推进精确 N 次可暂停物理 tick（含求解），完成后保持暂停，YAML 写 `step: N` 配合 `clock: physics`。期间 process 回调也可能运行，ALWAYS 节点仍活动；不保证全局或跨平台确定性。取消尝试独立请求暂停，bridge 另有 10 秒 watchdog；页面崩溃无法确认暂停，不能声称取消恢复已成功。

`game_record(action="start"/"stop")` 记录成功的工具操作为可审阅 YAML；停止录制后才能重启或停止游戏。`game_replay(test_file)` 按当前游戏状态执行，重放前须恢复初始状态；场景重启会保留 Autoload，不等于完整快照复原。录制不包含用户手动输入和模型调用间延迟，无断言或观察条件的重放标记 `unverified`。连续输入可用 `game_test`/`game_replay` 的有序步骤，无需独立序列工具。

`game_reproduce(test_file)` 比较当前已构建游戏的两个隔离冷启动实例。先完成源文件和清单，再调用 `game_start`；源文件或运行资源改变后必须重新构建，录制期间不可运行。每轮使用独立内存浏览器分区，项目需在 `reset_node` 实现同步 `_opengame_reset(seed)` 并返回 `true`，自行恢复节点、Autoload、计时器和随机数状态。清单是项目内不超过64 KiB的YAML/JSON，例如：

```yaml
version: 1
seed: 123
reset_node: /root/Main
observations:
  - node: /root/Main/Player
    property: position
steps:
  - actions_down: [ui_right]
    physics_ticks: 60
  - actions_up: [ui_right]
    physics_ticks: 1
```

动作名必须已在 InputMap 注册；支持1–32个观察项、1–100步，每步1–120个物理tick，总计不超过1200。初始状态及每步结束后采样，以完整浮点精度比较有限JSON值；过大数据拒绝执行，不截断为通过。结果包含 `reproducibility_verified`、首个差异和完整报告路径，仅证明本构建、此seed、这些已声明属性在两轮观测中相同，不证明整个游戏或跨平台确定性。原预览保留；测试实例结束后关闭并清理专属存储，若页面已导航到其他内容则延迟至关闭时清理，不清除普通工作区浏览器数据。

实现入口为 `apps/desktop-host/src/game-validation.ts`、`game-build.ts`、`game-tests.ts`、`game-transport.ts`，桌面控制为 `apps/desktop/src/product/game-browser.ts`，浏览器接入为现有 Sidebar Browser 可选的 `onGameOpen` 回调。协议通过 Desktop 私有 IPC 传递固定操作，不向模型暴露任意 JavaScript。应用脚本及 HTML 随安装包的 Godot 资源交付。来源版本和改造范围见 `apps/desktop/resources/godot/game-sources.json`，实际移植的 Runtime Control 遍历保留 MIT 许可；Vollkorn 提供先订阅再输入的执行设计。

自动测试 YAML 在任何浏览器交互前预检：等待信号必须已有对应节点与信号的订阅；有序比较的期望值必须为有限数字；duration_ms 仅用于按键，timeout_ms 仅用于等待与断言。无效测试不会先发送点击或按键。

## 游戏生成提示词

`apps/desktop-host/src/godot.ts` 通过公开 system prompt section 常驻注入游戏生成流程：先实现最小可玩循环，小脚本、小步原生编辑与短事务，区分编辑/运行路径，复用 Headless Worker，未知写入结果先检查再重试，完成编辑主动停止 Worker 并保留最终浏览器预览。检查流程区分导入/解析、Headless 运行、浏览器行为与目标平台执行；浏览器预览遵循游戏验证模块规则。保留上游权限、取消与工作区指导，不替换整个系统提示词。Loader 测试对实际组装的 section 保存快照，会话回放检查模型可见提示词；这些不等同真实模型自主完成游戏。

`godot_edit_batch(project, operations)` 接受 1–16 个有序操作对象，输入上限 32 KiB；支持 `scene_create`、`node_add`、`node_set`、`node_reference`、`resource_create`、`resource_set`、`resource_reference`。每步使用对应单步工具的字段但省略 project；不接受脚本、文件、shell 或嵌套事务操作。参数与路径全部预验证，普通编辑失败恢复本批目标文件，返回从 0 开始的 failed_index、各步结果与未执行标记，必须检查 rollback 是否 completed。成功提交替换 Worker 最近 undo 组，undo 恢复整个批次；失败保留先前 undo 组。已有打开的事务会拒绝批次且保持原事务。沿用 16 MiB 原数据、外部修改冲突和非持久事务边界。场景树每个节点的 script 字段为脚本资源路径；null 明确表示未挂脚本。

场景树根结果的 `saved_connections` 列出当前场景文件保存的信号连接（source/signal/target/method，`.` 为根），最多64条，超过时 `saved_connections_truncated=true`；脚本运行时动态连接不在这份磁盘摘要内。原生 connect 验证发射参数数量与方法必需/默认/可变参数范围，不自动 bind/unbind；回调逻辑与动态类型仍需实际运行验证。

### 全局 Autoload 与检查边界

若脚本直接使用 `GameManager` 全局名称，在 `project.godot` 写 `[autoload]` 节及 `GameManager="*res://scripts/GameManager.gd"`。开头 `*` 启用全局单例；无 `*` 仍是合法非全局自动加载节点，应通过 `/root/GameManager` 访问，而不是直接用全局名称。同名单例脚本不要再声明 `class_name GameManager`。

`godot-project check` 导入资源后在正常 SceneTree 初始化完成时加载全部项目脚本，包含未被场景引用的 `.gd`；会初始化 Autoload，但不会自行实例化主场景或普通脚本。它不是纯静态、无副作用检查，仍须运行于正常项目权限内；检查阶段限时 30 秒。使用完整原始输出，不要通过 `head/grep` 截掉首个错误或让管道掩盖退出码。缺少全局 `*` 且引擎实际报告对应 Identifier 未声明时，CLI 保留原错并追加具体配置提示，不会自动改文件，也不拒绝合法非全局 Autoload。

Headless `-s/--script` 仅用于继承 `MainLoop`/`SceneTree` 的启动脚本，不用于单独运行 `Node`/`Node2D` 玩法脚本。受管 raw `godot` 与 `godot-project run` 对脚本头部明确直接声明的常见非 MainLoop 内置基类进行静态拒绝，缺参数也返回具体诊断，避免已知 Godot 4.6 macOS headless 原生警告阻塞。它不启动额外引擎或重复初始化 Autoload；遇自定义继承、未知头部或封装项目时原样转交引擎，不声称检查任意继承链或阻止全部模态框。`--check-only` 不受此限制，`--`/`++` 后游戏参数原样保留。

### 中文 Web 字体

`load_godot_runtime` 返回随包原样 Noto Sans SC Variable 字体、OFL 许可证和来源/hash 元数据的绝对路径。已有项目需将字体及许可证复制到项目中，使用仅负责字体的 Node Autoload，在 `_enter_tree` 内 `load` 字体并赋给 `ThemeDB.get_default_theme().default_font`。不要顶层 preload，也不要用启动前加载的 `[gui] theme/custom` 引用尚未导入的字体；Web 构建副本和干净 checkout 都会重新冷导入。不要依赖浏览器或宿主系统字体回退。字体覆盖不等于所有 Unicode 都可显示；实际检查所用文本字形和字号。

`godot_project_create` 的 `opengame:blank-project@2` 默认包含字体、许可证、DefaultTheme.tres 和仅负责字体初始化的 OpenGameUIFont Autoload；导入后运行时应用默认字体，避免首次编辑器导入前加载尚未导入的字体。编辑项目设置时保留此 Autoload。字体和许可证计入真实字节 SHA-256 manifest；资产损坏在创建目录前拒绝。仍采用逐文件独占写入，失败保留部分文件供检查，不保证崩溃原子性。没有加入玩法。
