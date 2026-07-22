import Foundation

enum RouterControlError: LocalizedError {
    case invalidResponse
    case server(String)

    var errorDescription: String? {
        switch self {
        case .invalidResponse:
            return "控制服务返回了无效响应"
        case let .server(message):
            return message
        }
    }
}

struct RouterControlClient {
    let baseURL: URL

    init(baseURL: URL = URL(string: "http://127.0.0.1:47831")!) {
        self.baseURL = baseURL
    }

    func fetchStatus() async throws -> ControlStatus {
        try await requestStatus(path: "v1/status", timeout: 2)
    }

    func setEnabled(_ enabled: Bool) async throws -> ControlStatus {
        try await requestStatus(
            path: "v1/router/enabled",
            method: "PUT",
            body: JSONEncoder().encode(["enabled": enabled])
        )
    }

    func updateRoute(name: String, update: RouteUpdate) async throws -> ControlStatus {
        try await requestStatus(
            path: "v1/routes/\(name)",
            method: "PUT",
            body: JSONEncoder().encode(update)
        )
    }

    func setGatewayRouted(_ routed: Bool) async throws -> ControlStatus {
        try await requestStatus(
            path: "v1/gateway/routed",
            method: "PUT",
            body: JSONEncoder().encode(["routed": routed]),
            timeout: 35
        )
    }

    func openGatewayDashboard() async throws -> ControlStatus {
        try await requestStatus(path: "v1/gateway/dashboard", method: "POST", timeout: 35)
    }

    private func requestStatus(
        path: String,
        method: String = "GET",
        body: Data? = nil,
        timeout: TimeInterval = 5
    ) async throws -> ControlStatus {
        var request = URLRequest(url: baseURL.appending(path: path))
        request.httpMethod = method
        request.httpBody = body
        request.timeoutInterval = timeout
        if body != nil {
            request.setValue("application/json", forHTTPHeaderField: "content-type")
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        return try decodeStatus(data: data, response: response)
    }

    private func decodeStatus(data: Data, response: URLResponse) throws -> ControlStatus {
        guard let http = response as? HTTPURLResponse else {
            throw RouterControlError.invalidResponse
        }
        guard (200 ... 299).contains(http.statusCode) else {
            let message = (try? JSONDecoder().decode(ServerError.self, from: data).error)
                ?? "控制服务错误（HTTP \(http.statusCode)）"
            throw RouterControlError.server(message)
        }
        return try JSONDecoder().decode(ControlStatus.self, from: data)
    }
}

private struct ServerError: Decodable {
    let error: String
}
