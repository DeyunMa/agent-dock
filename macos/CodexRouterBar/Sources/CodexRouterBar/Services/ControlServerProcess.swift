import Foundation

@MainActor
final class ControlServerProcess {
    private let expectedHealthSchema = 2
    private let minimumControlSchema = 6
    private var process: Process?
    private var isEnsuring = false

    func ensureRunning() {
        guard !isEnsuring else { return }
        isEnsuring = true
        Task {
            defer { isEnsuring = false }
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
        let executable = home.appending(path: ".local/bin/codex-router")
        guard FileManager.default.isExecutableFile(atPath: executable.path) else { return false }

        let child = Process()
        child.executableURL = executable
        child.arguments = ["control-server", "--port", "47831"]
        var environment = ProcessInfo.processInfo.environment
        let preferredPaths = [
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
        environment["CODEX_ROUTER_CONTROL_PARENT_PID"] = String(ProcessInfo.processInfo.processIdentifier)
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
