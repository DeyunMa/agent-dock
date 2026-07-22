import Foundation

struct ControlStatus: Decodable {
    let schemaVersion: Int
    let control: ControlServiceStatus
    let router: RouterStatus
    let routes: [RouteSummary]
    let activation: ActivationStatus
    let gateway: GatewayStatus
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
    let models: [String]
    let modelCatalog: [GatewayModelInfo]?
    let message: String

    var availableModels: [GatewayModelInfo] {
        guard let modelCatalog, !modelCatalog.isEmpty else {
            return models.map(GatewayModelInfo.fallback)
        }
        return modelCatalog
    }
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
