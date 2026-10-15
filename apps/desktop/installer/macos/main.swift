import AppKit
import Darwin

// The worker owns a process group so closing setup also cancels extraction and checks.
if CommandLine.arguments.count > 2 && CommandLine.arguments[1] == "--installer-worker" {
    _ = setpgid(0, 0)
    let arguments = Array(CommandLine.arguments.dropFirst(2))
    let strings = arguments.map { strdup($0) } + [nil]
    strings.withUnsafeBufferPointer { buffer in
        _ = execv(arguments[0], buffer.baseAddress!)
    }
    exit(1)
}

final class Installer: NSObject, NSApplicationDelegate, NSWindowDelegate {
    let chinese = Locale.preferredLanguages.first?.hasPrefix("zh") ?? false
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 600, height: 530), styleMask: [.titled, .closable], backing: .buffered, defer: false)
    let status = NSTextField(wrappingLabelWithString: "")
    let location = NSTextField(wrappingLabelWithString: "")
    let details = NSTextView()
    let action = NSButton()
    let change = NSButton()
    let bar = NSProgressIndicator()
    var rows: [String: NSTextField] = [:]
    var process: Process?
    var reused: Set<String> = []
    var complete = false
    var closing = false
    var pending = ""
    var target: URL = {
        let root = FileManager.default.isWritableFile(atPath: "/Applications") ? URL(fileURLWithPath: "/Applications") : FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Applications")
        return root.appendingPathComponent("OpenGameGen.app")
    }()
    func text(_ zh: String, _ en: String) -> String { chinese ? zh : en }
    func applicationDidFinishLaunching(_ notification: Notification) {
        let menu = NSMenu()
        let root = NSMenuItem(); menu.addItem(root)
        let applicationMenu = NSMenu(); root.submenu = applicationMenu
        applicationMenu.addItem(withTitle: text("退出安装器", "Quit Installer"), action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        NSApp.mainMenu = menu
        window.title = text("安装 OpenGameGen", "Install OpenGameGen")
        window.delegate = self
        let view = window.contentView!
        let title = NSTextField(labelWithString: text("安装后即可开始创作", "Ready to create when installation finishes"))
        title.font = .boldSystemFont(ofSize: 23)
        title.frame = NSRect(x: 30, y: 465, width: 540, height: 34)
        view.addSubview(title)
        status.frame = NSRect(x: 30, y: 400, width: 540, height: 55)
        status.stringValue = text("自动安装桌面应用、游戏引擎、3D 工具和导出支持。已安装的健康组件会被复用。", "Install the desktop app, game engine, 3D tools and export support. Healthy existing components are reused.")
        view.addSubview(status)
        location.frame = NSRect(x: 30, y: 355, width: 440, height: 36)
        view.addSubview(location)
        change.title = text("更改位置", "Change location")
        change.frame = NSRect(x: 465, y: 360, width: 110, height: 30)
        change.target = self; change.action = #selector(chooseLocation)
        view.addSubview(change)
        let names = [("application", text("桌面应用", "Desktop application")), ("node", text("基础运行环境", "Base runtime")), ("python", text("脚本运行环境", "Script runtime")), ("godot", text("游戏引擎", "Game engine")), ("blender", text("3D 创作工具", "3D creation tools")), ("templates", text("游戏运行与导出支持", "Game preview and export support"))]
        for (index, item) in names.enumerated() {
            let label = NSTextField(labelWithString: item.1)
            label.frame = NSRect(x: 35, y: 320 - index * 28, width: 530, height: 24)
            label.identifier = NSUserInterfaceItemIdentifier(item.1)
            rows[item.0] = label; view.addSubview(label)
        }
        bar.frame = NSRect(x: 30, y: 137, width: 540, height: 10)
        bar.style = .bar; bar.isIndeterminate = true; bar.isHidden = true
        view.addSubview(bar)
        let scroll = NSScrollView(frame: NSRect(x: 30, y: 55, width: 540, height: 72))
        details.isEditable = false; details.font = .monospacedSystemFont(ofSize: 10, weight: .regular)
        scroll.documentView = details; scroll.hasVerticalScroller = true; view.addSubview(scroll)
        action.title = text("安装", "Install")
        action.frame = NSRect(x: 440, y: 12, width: 130, height: 32)
        action.bezelStyle = .rounded; action.keyEquivalent = "\r"
        action.target = self; action.action = #selector(install)
        view.addSubview(action)
        updateLocation(); window.center(); window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }
    func updateLocation() { location.stringValue = text("安装位置：", "Install to: ") + target.deletingLastPathComponent().path }
    @objc func chooseLocation() {
        let panel = NSOpenPanel(); panel.canChooseDirectories = true; panel.canChooseFiles = false; panel.canCreateDirectories = true
        panel.directoryURL = target.deletingLastPathComponent()
        if panel.runModal() == .OK, let selected = panel.url { target = selected.appendingPathComponent("OpenGameGen.app"); updateLocation() }
    }
    @objc func install() {
        if complete {
            let configuration = NSWorkspace.OpenConfiguration()
            configuration.environment = ProcessInfo.processInfo.environment.filter { ["OPENGAMEGEN_HOME", "OPENGAMEGEN_USER_DATA"].contains($0.key) }
            NSWorkspace.shared.openApplication(at: target, configuration: configuration) { _, error in
                DispatchQueue.main.async {
                    if let error = error { self.status.stringValue = error.localizedDescription }
                    else { NSApp.terminate(nil) }
                }
            }
            return
        }
        guard process == nil, let resources = Bundle.main.resourceURL, let executable = Bundle.main.executableURL else { return }
        let payload = resources.appendingPathComponent("desktop.app")
        let online = FileManager.default.fileExists(atPath: resources.appendingPathComponent("install-online.mjs").path)
        let node = online ? resources.appendingPathComponent("bootstrap-node") : payload.appendingPathComponent("Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node")
        let worker = Process(); worker.executableURL = executable
        worker.arguments = ["--installer-worker", node.path, "--use-env-proxy", resources.appendingPathComponent("install.mjs").path,
                            "--payload", payload.path, "--destination", target.path, "--manifest", resources.appendingPathComponent("install-manifest.json").path]
        if online { worker.arguments = ["--installer-worker", node.path, "--use-env-proxy", resources.appendingPathComponent("install-online.mjs").path, "--destination", target.path] }
        worker.environment = ProcessInfo.processInfo.environment.filter { key, _ in
            !["KEY", "SECRET", "TOKEN", "PASSWORD"].contains(where: { key.uppercased().contains($0) })
        }
        let output = Pipe(); worker.standardOutput = output; worker.standardError = output
        output.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            guard !data.isEmpty else { return }
            let value = String(decoding: data, as: UTF8.self)
            DispatchQueue.main.async { self.receive(value) }
        }
        worker.terminationHandler = { finished in
            output.fileHandleForReading.readabilityHandler = nil
            DispatchQueue.main.async {
                self.process = nil; self.bar.stopAnimation(nil); self.bar.isHidden = true
                if self.closing { _ = kill(-finished.processIdentifier, SIGKILL); NSApp.terminate(nil); return }
                self.complete = finished.terminationStatus == 0
                self.action.isEnabled = true; self.change.isEnabled = !self.complete
                self.action.title = self.complete ? self.text("立即启动", "Launch now") : self.text("重试安装", "Retry installation")
                self.status.stringValue = self.complete ? self.text("安装完成，全部创作组件已就绪。", "Installation complete. Your creation environment is ready.") : self.text("安装未完成。请检查网络、磁盘空间，或退出正在运行的应用后重试。", "Installation could not finish. Check your connection and disk space, or quit the running app, then retry.")
                if self.complete { for (name, label) in self.rows { label.stringValue = label.identifier!.rawValue + (self.reused.contains(name) ? self.text(" · 已就绪（复用）", " · Ready (reused)") : self.text(" · 已就绪", " · Ready")) } }
            }
        }
        do {
            try worker.run(); process = worker; pending = ""; details.string = ""; reused = []
            action.isEnabled = false; change.isEnabled = false; bar.isHidden = false; bar.startAnimation(nil)
            status.stringValue = text("正在安装，完成后即可启动应用。首次下载可能需要几分钟。", "Installing. You can launch the app when ready. First-time downloads may take several minutes.")
        } catch { output.fileHandleForReading.readabilityHandler = nil; status.stringValue = error.localizedDescription }
    }
    func receive(_ value: String) {
        pending += value
        while let end = pending.firstIndex(of: "\n") {
            let line = String(pending[..<end]); pending = String(pending[pending.index(after: end)...])
            if line.hasPrefix("Installer-stage: "), let data = String(line.dropFirst(17)).data(using: .utf8),
               let stage = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let target = stage["target"] as? String, let phase = stage["phase"] as? String, let label = rows[target] {
                let description: String
                switch phase {
                case "ready":
                    if stage["reused"] as? Bool ?? false { reused.insert(target) }
                    description = (stage["reused"] as? Bool ?? false) ? text("已就绪（复用）", "Ready (reused)") : text("已就绪", "Ready")
                case "reusing": description = text("复用已有安装", "Reusing existing installation")
                case "installing": description = text("正在安装", "Installing")
                default: description = text("正在检查", "Checking")
                }
                label.stringValue = label.identifier!.rawValue + " · " + description
            } else if !line.isEmpty && !line.hasPrefix("{") {
                details.string = String((details.string + line + "\n").suffix(4096)); details.scrollToEndOfDocument(nil)
            }
        }
        pending = String(pending.suffix(8192))
    }
    func windowShouldClose(_ sender: NSWindow) -> Bool { NSApp.terminate(nil); return false }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let worker = process else { return .terminateNow }
        closing = true; status.stringValue = text("正在停止安装…", "Stopping installation…")
        _ = kill(-worker.processIdentifier, SIGTERM)
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { _ = kill(-worker.processIdentifier, SIGKILL) }
        return .terminateCancel
    }
}
let application = NSApplication.shared
let delegate = Installer(); application.delegate = delegate
application.setActivationPolicy(.regular); application.run()
