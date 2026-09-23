import Foundation

struct ControlStatus: Decodable {
    let jev: JevStatus
    let schemaVersion: Int
    let control: ControlServiceStatus
    let router: RouterStatus
    let routes: [RouteSummary]
    let activation: ActivationStatus
    let latestDecision: LatestDecision?
    let gateway: GatewayStatus
    let catalog: CodexModelCatalogStatus
}

struct JevStatus: Decodable {
    let configured: Bool
    let source: String
}

struct JevTestResult: Decodable {
    let ok: Bool
    let status: String
    let latencyMs: Int
}

struct LatestDecision: Decodable, Equatable {
    let id: String?
    let timestamp: String
    let triggeredAt: String?
    let surface: String?
    let threadId: String?
    let intent: String
    let route: String
    let session: CodexThreadSummary?

    var displayTitle: String {
        if let name = session?.name?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty {
            return name
        }
        if let preview = session?.preview?.trimmingCharacters(in: .whitespacesAndNewlines),
           !preview.isEmpty {
            return preview
        }
        if let threadId, !threadId.isEmpty {
            return "会话 \(threadId.prefix(8))"
        }
        return "Codex Exec"
    }

    var eventTimestamp: String { triggeredAt ?? timestamp }
}

struct DecisionFeedStatus: Decodable {
    let schemaVersion: Int
    let decisions: [LatestDecision]
}

struct CodexThreadSummary: Decodable, Equatable {
    let id: String
    let name: String?
    let preview: String?
    let cwd: String?
    let source: String?
    let createdAt: Int?
    let updatedAt: Int?
    let recencyAt: Int?

    var projectName: String? {
        guard let cwd, !cwd.isEmpty else { return nil }
        return URL(fileURLWithPath: cwd).lastPathComponent
    }
}

struct ControlServiceStatus: Decodable {
    let status: String
    let version: String
    let endpoint: String
}

struct RouterStatus: Decodable {
    let enabled: Bool
    let configPath: String
    let classifier: ClassifierStatus
}

struct ClassifierStatus: Decodable {
    let enabled: Bool
    let model: String
}

struct RouteSummary: Decodable, Identifiable {
    let name: String
    let model: String
    let effort: String
    let fast: Bool

    var id: String { name }
    var displayName: String {
        switch name {
        case "quick": "轻量"
        case "balanced": "标准"
        case "deep": "深入"
        default: name
        }
    }
}

struct ActivationStatus: Decodable {
    let requiresCodexRestart: Bool
    let message: String
}

struct GatewayStatus: Decodable {
    let kind: String
    let installed: Bool
    let running: Bool
    let routed: Bool
    let managed: Bool
    let baseUrl: String
    let version: String?
    let message: String
}

struct CodexModelCatalogStatus: Decodable {
    let source: String
    let models: [GatewayModelInfo]
    let updatedAt: String?
    let message: String
}

struct GatewayModelInfo: Decodable, Identifiable {
    let id: String
    let displayName: String
    let provider: String
    let requiresGateway: Bool
    let reasoningEfforts: [String]
    let serviceTiers: [String]
    let capabilitiesKnown: Bool
    let defaultReasoningEffort: String?

    var supportsFast: Bool {
        serviceTiers.contains("priority")
    }

    var providerDisplayName: String {
        switch provider.lowercased() {
        case "openai": "OpenAI"
        case "google": "Google"
        case "deepseek": "DeepSeek"
        default: provider
        }
    }

    static func fallback(id: String) -> GatewayModelInfo {
        let provider = id.split(separator: "/", maxSplits: 1).first.map(String.init) ?? "openai"
        return GatewayModelInfo(
            id: id,
            displayName: id,
            provider: id.contains("/") ? provider : "openai",
            requiresGateway: id.contains("/"),
            reasoningEfforts: [],
            serviceTiers: [],
            capabilitiesKnown: false,
            defaultReasoningEffort: nil
        )
    }
}

struct RouteUpdate: Encodable {
    let model: String
    let effort: String
    let fast: Bool
}
