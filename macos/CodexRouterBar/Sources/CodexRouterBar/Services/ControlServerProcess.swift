import Foundation

final class ControlServerProcess {
    private var process: Process?

    func ensureRunning() {
        Task {
            if await isHealthy() { return }
            start()
        }
    }

    func stop() {
        guard let process, process.isRunning else { return }
        process.terminate()
        self.process = nil
    }

    private func isHealthy() async -> Bool {
        guard let url = URL(string: "http://127.0.0.1:47831/v1/health") else { return false }
        var request = URLRequest(url: url)
        request.timeoutInterval = 0.4
        guard let (_, response) = try? await URLSession.shared.data(for: request),
              let http = response as? HTTPURLResponse else { return false }
        return http.statusCode == 200
    }

    private func start() {
        let home = FileManager.default.homeDirectoryForCurrentUser
        let executable = home.appending(path: ".local/bin/codex-router")
        guard FileManager.default.isExecutableFile(atPath: executable.path) else { return }

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
        do {
            try child.run()
            process = child
        } catch {
            process = nil
        }
    }
}
