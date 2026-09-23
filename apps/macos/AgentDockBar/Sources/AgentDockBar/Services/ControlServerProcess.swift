import Foundation
import AppKit

@MainActor
final class ControlServerProcess {
    private let expectedHealthSchema = 2
    private let minimumControlSchema = 8
    private var process: Process?
    private var isEnsuring = false
    private var prepared = false
    private var setupFailed = false

    private func prepareRuntime() async -> Bool {
        if prepared { return true }
        if setupFailed { return false }
        guard let runtime = Bundle.main.resourceURL?.appending(path: "runtime"),
              FileManager.default.fileExists(atPath: runtime.appending(path: "setup.mjs").path) else {
            // swift run is a developer entry point; distributed builds always bundle runtime.
            prepared = true
            return true
        }
        let result: String? = await Task.detached {
            let setup = Process()
            let errors = Pipe()
            setup.executableURL = runtime.appending(path: "node_modules/node/bin/node")
            setup.arguments = [runtime.appending(path: "setup.mjs").path]
            setup.standardOutput = FileHandle.nullDevice
            setup.standardError = errors
            do {
                try setup.run()
                let data = errors.fileHandleForReading.readDataToEndOfFile()
                setup.waitUntilExit()
                return setup.terminationStatus == 0 ? nil : String(data: data, encoding: .utf8) ?? "初始化失败"
            } catch { return error.localizedDescription }
        }.value
        if let result {
            setupFailed = true
            let alert = NSAlert()
            alert.messageText = "Agent Dock 初始化未完成"
            alert.informativeText = result
            alert.addButton(withTitle: "知道了")
            alert.runModal()
            return false
        }
        prepared = true
        return true
    }

    func ensureRunning() {
        guard !isEnsuring else { return }
        isEnsuring = true
        Task {
            defer { isEnsuring = false }
            guard await prepareRuntime() else { return }
            if await isHealthy() { return }

            let stoppedChild = stopManagedProcess()
            if stoppedChild {
                try? await Task.sleep(nanoseconds: 150_000_000)
            }
            guard start() else { return }
            for _ in 0 ..< 8 {
                try? await Task.sleep(nanoseconds: 150_000_000)
                if await isHealthy() { return }
                if process?.isRunning != true { break }
            }
        }
    }

    func stop() {
        _ = stopManagedProcess()
    }

    @discardableResult
    private func stopManagedProcess() -> Bool {
        let child = process
        process = nil
        if child?.isRunning == true {
            child?.terminate()
            return true
        }
        return false
    }

    private func isHealthy() async -> Bool {
        guard let url = URL(string: "http://127.0.0.1:47831/v1/health") else { return false }
        var request = URLRequest(url: url)
        request.timeoutInterval = 0.5
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              let http = response as? HTTPURLResponse,
              http.statusCode == 200,
              let health = try? JSONDecoder().decode(ControlHealth.self, from: data) else {
            return false
        }
        return health.status == "ok"
            && health.schemaVersion == expectedHealthSchema
            && health.controlSchemaVersion >= minimumControlSchema
    }

    @discardableResult
    private func start() -> Bool {
        guard process?.isRunning != true else { return true }
        let home = FileManager.default.homeDirectoryForCurrentUser
        let bundled = Bundle.main.resourceURL?.appending(path: "runtime/agent-dock")
        let executable = bundled.flatMap { FileManager.default.isExecutableFile(atPath: $0.path) ? $0 : nil }
            ?? home.appending(path: ".local/bin/agent-dock")
        guard FileManager.default.isExecutableFile(atPath: executable.path) else { return false }

        let child = Process()
        child.executableURL = executable
        child.arguments = ["control-server", "--port", "47831"]
        var environment = ProcessInfo.processInfo.environment
        let preferredPaths = [
            home.appending(path: ".local/share/mise/shims").path,
            home.appending(path: ".asdf/shims").path,
            home.appending(path: ".local/bin").path,
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/usr/bin",
            "/bin",
        ]
        environment["PATH"] = (preferredPaths + [environment["PATH"] ?? ""])
            .filter { !$0.isEmpty }
            .joined(separator: ":")
        environment["AGENT_DOCK_CONTROL_PARENT_PID"] = String(ProcessInfo.processInfo.processIdentifier)
        child.environment = environment
        child.standardOutput = FileHandle.nullDevice
        child.standardError = FileHandle.nullDevice
        child.terminationHandler = { [weak self] terminated in
            Task { @MainActor in
                if self?.process === terminated {
                    self?.process = nil
                }
            }
        }
        do {
            try child.run()
            process = child
            return true
        } catch {
            process = nil
            return false
        }
    }
}

private struct ControlHealth: Decodable {
    let schemaVersion: Int
    let controlSchemaVersion: Int
    let version: String
    let status: String
}
