// Video Repair — native window wrapper.
// Starts the bundled repair engine (vendor Node + server/index.js) privately on
// 127.0.0.1, shows the interface in its own WebKit window, and stops the engine
// when the app quits. No browser involved; works fully offline.
import Cocoa
import WebKit
import UniformTypeIdentifiers

let kPort = 47821
let kBase = URL(string: "http://127.0.0.1:\(kPort)/")!

func ping(_ path: String, timeout: TimeInterval = 1.5) -> Bool {
    var req = URLRequest(url: kBase.appendingPathComponent(path))
    req.timeoutInterval = timeout
    req.cachePolicy = .reloadIgnoringLocalCacheData
    let sem = DispatchSemaphore(value: 0)
    var ok = false
    let task = URLSession.shared.dataTask(with: req) { _, resp, _ in
        if let h = resp as? HTTPURLResponse, (200..<500).contains(h.statusCode) { ok = true }
        sem.signal()
    }
    task.resume()
    _ = sem.wait(timeout: .now() + timeout + 0.5)
    return ok
}

func statusPage(_ title: String, _ detail: String) -> String {
    return """
    <!doctype html><html><head><meta charset="utf-8"><style>
    html,body{height:100%;margin:0;background:#0b0b12;color:#e8e8f0;font:15px -apple-system,system-ui,sans-serif}
    .c{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;text-align:center;padding:24px;box-sizing:border-box}
    h1{font-size:20px;font-weight:600;margin:0}p{margin:0;color:#9a9ab0;max-width:520px;line-height:1.5}
    </style></head><body><div class="c"><h1>\(title)</h1><p>\(detail)</p></div></body></html>
    """
}

// Owns the private repair engine process. Plain class so it can run off the main thread.
final class Engine {
    let root: URL
    let stateDir: URL
    var logURL: URL { stateDir.appendingPathComponent("server.log") }
    var pidURL: URL { stateDir.appendingPathComponent("server.pid") }
    var process: Process?
    var quitting = false

    init(root: URL) {
        self.root = root
        stateDir = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".video-repair")
        try? FileManager.default.createDirectory(at: stateDir, withIntermediateDirectories: true)
    }

    var vendorDir: URL {
        #if arch(arm64)
        return root.appendingPathComponent("vendor/darwin-arm64")
        #else
        return root.appendingPathComponent("vendor/darwin-x64")
        #endif
    }

    func nodeURL() -> URL? {
        let fm = FileManager.default
        for c in [vendorDir.appendingPathComponent("node").path, "/opt/homebrew/bin/node", "/usr/local/bin/node"]
        where fm.isExecutableFile(atPath: c) { return URL(fileURLWithPath: c) }
        return nil
    }

    // Blocking. Returns nil when ready, or (title, detail) on failure.
    func start(onUnexpectedExit: @escaping () -> Void) -> (String, String)? {
        guard FileManager.default.fileExists(atPath: root.appendingPathComponent("server/index.js").path) else {
            return ("Video Repair can't find its files",
                    "Keep Video Repair.app inside the Video Repair folder, next to the server and vendor folders.")
        }
        guard let node = nodeURL() else {
            return ("The repair engine is missing", "The vendor folder inside Video Repair looks incomplete.")
        }
        // A background copy left over from the old launcher: stop it so this window owns the engine.
        if ping("api/jobs", timeout: 0.8) {
            let stop = Process()
            stop.executableURL = node
            stop.arguments = [root.appendingPathComponent("scripts/launch.js").path, "--stop"]
            stop.currentDirectoryURL = root
            stop.standardOutput = FileHandle.nullDevice
            stop.standardError = FileHandle.nullDevice
            try? stop.run()
            stop.waitUntilExit()
            for _ in 0..<24 { if !ping("api/jobs", timeout: 0.4) { break }; Thread.sleep(forTimeInterval: 0.25) }
        }
        if !ping("api/jobs", timeout: 0.4) {
            let p = Process()
            p.executableURL = node
            p.arguments = [root.appendingPathComponent("server/index.js").path]
            p.currentDirectoryURL = root
            var env = ProcessInfo.processInfo.environment
            env["PATH"] = "\(vendorDir.path):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
            let ff = vendorDir.appendingPathComponent("ffmpeg").path
            if FileManager.default.isExecutableFile(atPath: ff) {
                env["FFMPEG_PATH"] = ff
                env["FFPROBE_PATH"] = vendorDir.appendingPathComponent("ffprobe").path
            }
            env["PORT"] = String(kPort)
            p.environment = env
            if !FileManager.default.fileExists(atPath: logURL.path) {
                FileManager.default.createFile(atPath: logURL.path, contents: nil)
            }
            if let fh = try? FileHandle(forWritingTo: logURL) {
                fh.seekToEndOfFile()
                p.standardOutput = fh
                p.standardError = fh
            }
            p.standardInput = FileHandle.nullDevice
            p.terminationHandler = { [weak self] _ in
                guard let self = self, !self.quitting else { return }
                onUnexpectedExit()
            }
            do { try p.run() } catch {
                return ("Couldn't start the repair engine", error.localizedDescription)
            }
            process = p
            try? String(p.processIdentifier).write(to: pidURL, atomically: true, encoding: .utf8)
        }
        for _ in 0..<240 {
            if ping("api/jobs") { return nil }
            if let p = process, !p.isRunning { break }
            Thread.sleep(forTimeInterval: 0.25)
        }
        return ("Video Repair didn't start", "Details are in \(logURL.path)")
    }

    func stop() {
        quitting = true
        if let p = process, p.isRunning {
            p.terminate()
            let deadline = Date().addingTimeInterval(3)
            while p.isRunning && Date() < deadline { Thread.sleep(forTimeInterval: 0.05) }
            if p.isRunning { kill(p.processIdentifier, SIGKILL) }
        }
        if process != nil { try? FileManager.default.removeItem(at: pidURL) }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate,
                         WKUIDelegate, WKNavigationDelegate, WKDownloadDelegate {
    var window: NSWindow!
    var web: WKWebView!
    var engine: Engine!
    var downloadTargets: [ObjectIdentifier: URL] = [:]
    var finished: [URL] = []
    var revealWork: DispatchWorkItem?

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()
        buildWindow()
        let eng = Engine(root: Bundle.main.bundleURL.deletingLastPathComponent())
        engine = eng
        show("Starting Video Repair…", "Getting the repair engine ready.")
        DispatchQueue.global(qos: .userInitiated).async {
            let failure = eng.start(onUnexpectedExit: {
                DispatchQueue.main.async {
                    self.show("The repair engine stopped",
                              "Quit and reopen Video Repair. Details are in \(eng.logURL.path)")
                }
            })
            DispatchQueue.main.async {
                if let f = failure { self.show(f.0, f.1) } else { self.web.load(URLRequest(url: kBase)) }
            }
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    func applicationWillTerminate(_ notification: Notification) { engine?.stop() }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        window.makeKeyAndOrderFront(nil); return true
    }

    func show(_ title: String, _ detail: String) { web.loadHTMLString(statusPage(title, detail), baseURL: nil) }

    func buildWindow() {
        let cfg = WKWebViewConfiguration()
        web = WKWebView(frame: .zero, configuration: cfg)
        web.uiDelegate = self
        web.navigationDelegate = self
        web.allowsBackForwardNavigationGestures = false
        web.setValue(false, forKey: "drawsBackground")
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1180, height: 860),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = "Video Repair"
        window.minSize = NSSize(width: 760, height: 560)
        window.appearance = NSAppearance(named: .darkAqua)
        window.backgroundColor = NSColor(srgbRed: 0.043, green: 0.043, blue: 0.07, alpha: 1)
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.contentView = web
        window.center()
        _ = window.setFrameAutosaveName("VideoRepairMainWindow")
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func buildMenu() {
        let main = NSMenu()
        func sub(_ title: String) -> NSMenu {
            let item = NSMenuItem(); item.title = title; main.addItem(item)
            let m = NSMenu(title: title); item.submenu = m; return m
        }
        let app = sub("Video Repair")
        app.addItem(withTitle: "About Video Repair", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        app.addItem(.separator())
        app.addItem(withTitle: "Hide Video Repair", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let others = app.addItem(withTitle: "Hide Others", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        others.keyEquivalentModifierMask = [.command, .option]
        app.addItem(withTitle: "Show All", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        app.addItem(.separator())
        app.addItem(withTitle: "Quit Video Repair", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")

        let file = sub("File")
        let dl = file.addItem(withTitle: "Show Downloads Folder", action: #selector(openDownloads), keyEquivalent: "")
        dl.target = self
        file.addItem(.separator())
        file.addItem(withTitle: "Close Window", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")

        let edit = sub("Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        let redo = edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")

        let view = sub("View")
        let reload = view.addItem(withTitle: "Reload", action: #selector(reloadPage), keyEquivalent: "r")
        reload.target = self
        let fs = view.addItem(withTitle: "Enter Full Screen", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
        fs.keyEquivalentModifierMask = [.command, .control]

        let win = sub("Window")
        win.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        win.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")

        NSApp.mainMenu = main
        NSApp.windowsMenu = win
    }

    @objc func reloadPage() {
        if web.url?.host == "127.0.0.1" { web.reload() } else { web.load(URLRequest(url: kBase)) }
    }
    @objc func openDownloads() { NSWorkspace.shared.open(downloadsDir()) }

    // MARK: file pickers and page dialogs
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = false
        panel.canChooseFiles = true
        panel.allowedContentTypes = [.mpeg4Movie, .quickTimeMovie]
        panel.message = "Choose MP4 or MOV videos"
        panel.beginSheetModal(for: window) { resp in completionHandler(resp == .OK ? panel.urls : nil) }
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let a = NSAlert(); a.messageText = "Video Repair"; a.informativeText = message
        a.addButton(withTitle: "OK")
        a.beginSheetModal(for: window) { _ in completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let a = NSAlert(); a.messageText = "Video Repair"; a.informativeText = message
        a.addButton(withTitle: "OK"); a.addButton(withTitle: "Cancel")
        a.beginSheetModal(for: window) { r in completionHandler(r == .alertFirstButtonReturn) }
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let u = navigationAction.request.url {
            if u.host == "127.0.0.1" { webView.startDownload(using: navigationAction.request) { $0.delegate = self } }
            else { NSWorkspace.shared.open(u) }
        }
        return nil
    }

    // MARK: navigation — keep the window on the app, send outside links to the browser, save files
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 preferences: WKWebpagePreferences,
                 decisionHandler: @escaping (WKNavigationActionPolicy, WKWebpagePreferences) -> Void) {
        if navigationAction.shouldPerformDownload { decisionHandler(.download, preferences); return }
        if let u = navigationAction.request.url, let s = u.scheme, s == "http" || s == "https",
           u.host != "127.0.0.1", navigationAction.targetFrame?.isMainFrame ?? true {
            NSWorkspace.shared.open(u); decisionHandler(.cancel, preferences); return
        }
        decisionHandler(.allow, preferences)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        var attach = false
        if let h = navigationResponse.response as? HTTPURLResponse,
           let cd = h.value(forHTTPHeaderField: "Content-Disposition"), cd.lowercased().hasPrefix("attachment") {
            attach = true
        }
        let mime = navigationResponse.response.mimeType ?? ""
        let videoPage = navigationResponse.isForMainFrame && mime.hasPrefix("video/")
        decisionHandler((attach || videoPage || !navigationResponse.canShowMIMEType) ? .download : .allow)
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    // MARK: downloads → ~/Downloads, then reveal in Finder
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse,
                  suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let name = suggestedFilename.isEmpty ? "repaired.mp4" : suggestedFilename
        let dest = uniqueURL(in: downloadsDir(), name: name)
        downloadTargets[ObjectIdentifier(download)] = dest
        completionHandler(dest)
    }

    func downloadDidFinish(_ download: WKDownload) {
        guard let dest = downloadTargets.removeValue(forKey: ObjectIdentifier(download)) else { return }
        finished.append(dest)
        revealWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self = self, !self.finished.isEmpty else { return }
            NSWorkspace.shared.activateFileViewerSelecting(self.finished)
            self.finished.removeAll()
        }
        revealWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2, execute: work)
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        downloadTargets.removeValue(forKey: ObjectIdentifier(download))
        let a = NSAlert(); a.messageText = "Couldn't save the repaired video"
        a.informativeText = error.localizedDescription
        a.beginSheetModal(for: window, completionHandler: nil)
    }

    func downloadsDir() -> URL {
        FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
            ?? FileManager.default.homeDirectoryForCurrentUser
    }

    func uniqueURL(in dir: URL, name: String) -> URL {
        let base = (name as NSString).deletingPathExtension
        let ext = (name as NSString).pathExtension
        var url = dir.appendingPathComponent(name)
        var i = 2
        while FileManager.default.fileExists(atPath: url.path) {
            url = dir.appendingPathComponent(ext.isEmpty ? "\(base) \(i)" : "\(base) \(i).\(ext)")
            i += 1
        }
        return url
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
