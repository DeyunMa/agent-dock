import Foundation

@MainActor
final class RouterViewModel: ObservableObject {
    enum ConnectionState: Equatable {
        case connecting
        case online
        case offline(String)
    }

    @Published private(set) var connection: ConnectionState = .connecting
    @Published private(set) var status: ControlStatus?
    @Published private(set) var isChanging = false
    @Published private(set) var savingRoute: String?
    @Published private(set) var isChangingGateway = false
    @Published private(set) var isOpeningGatewayDashboard = false
    @Published private(set) var operationError: String?

    private let client: RouterControlClient
    private let onDesktopDecision: (LatestDecision) -> Void
    private var isRefreshing = false
    private var isRefreshingDecision = false
    private var statusRevision = 0
    private var activeMutationID: UUID?
    private let decisionIdentifierKey = "lastDisplayedDecisionID"
    private let timestampFormatter: ISO8601DateFormatter

    init(
        client: RouterControlClient = RouterControlClient(),
        onDesktopDecision: @escaping (LatestDecision) -> Void = { _ in }
    ) {
        self.client = client
        self.onDesktopDecision = onDesktopDecision
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        timestampFormatter = formatter
    }

    func refreshDecisions() {
        guard !isRefreshingDecision else { return }
        isRefreshingDecision = true
        Task {
            defer { isRefreshingDecision = false }
            let cursor = UserDefaults.standard.string(forKey: decisionIdentifierKey)
            guard let response = try? await client.fetchDecisions(after: cursor) else { return }
            var receivedDecision = false
            for decision in response.decisions {
                guard let identifier = decision.id else { continue }
                UserDefaults.standard.set(identifier, forKey: decisionIdentifierKey)
                receivedDecision = true
                guard ["desktop", "terminal"].contains(decision.surface),
                      isRecent(decision.eventTimestamp) else { continue }
                onDesktopDecision(decision)
            }
            if receivedDecision {
                refresh()
            }
        }
    }

    private func isRecent(_ timestamp: String) -> Bool {
        guard let date = timestampFormatter.date(from: timestamp) else { return false }
        return abs(date.timeIntervalSinceNow) <= 15
    }

    func refresh() {
        guard !isRefreshing, activeMutationID == nil else { return }
        isRefreshing = true
        let revision = statusRevision
        Task {
            defer { isRefreshing = false }
            do {
                let refreshedStatus = try await client.fetchStatus()
                guard revision == statusRevision, activeMutationID == nil else { return }
                status = refreshedStatus
                connection = .online
            } catch {
                guard revision == statusRevision, activeMutationID == nil else { return }
                connection = .offline(error.localizedDescription)
            }
        }
    }

    func toggleRouter() {
        guard let status, activeMutationID == nil else { return }
        let operationID = UUID()
        activeMutationID = operationID
        isChanging = true
        statusRevision += 1
        operationError = nil
        Task {
            defer {
                if activeMutationID == operationID {
                    activeMutationID = nil
                    isChanging = false
                }
            }
            do {
                let updated = try await client.setEnabled(!status.router.enabled)
                guard activeMutationID == operationID else { return }
                self.status = updated
                connection = .online
            } catch {
                guard activeMutationID == operationID else { return }
                operationError = error.localizedDescription
            }
        }
    }

    func updateRoute(name: String, model: String, effort: String, fast: Bool) {
        guard activeMutationID == nil else { return }
        let operationID = UUID()
        activeMutationID = operationID
        savingRoute = name
        statusRevision += 1
        operationError = nil
        Task {
            defer {
                if activeMutationID == operationID {
                    activeMutationID = nil
                    savingRoute = nil
                }
            }
            do {
                let updated = try await client.updateRoute(
                    name: name,
                    update: RouteUpdate(model: model, effort: effort, fast: fast)
                )
                guard activeMutationID == operationID else { return }
                status = updated
                connection = .online
            } catch {
                guard activeMutationID == operationID else { return }
                operationError = error.localizedDescription
            }
        }
    }

    func toggleGateway() {
        guard let gateway = status?.gateway, activeMutationID == nil else { return }
        let operationID = UUID()
        activeMutationID = operationID
        isChangingGateway = true
        statusRevision += 1
        operationError = nil
        Task {
            defer {
                if activeMutationID == operationID {
                    activeMutationID = nil
                    isChangingGateway = false
                }
            }
            do {
                let updated = try await client.setGatewayRouted(!gateway.routed)
                guard activeMutationID == operationID else { return }
                status = updated
                connection = .online
            } catch {
                guard activeMutationID == operationID else { return }
                operationError = error.localizedDescription
            }
        }
    }

    func openGatewayDashboard() {
        guard activeMutationID == nil else { return }
        let operationID = UUID()
        activeMutationID = operationID
        isOpeningGatewayDashboard = true
        statusRevision += 1
        operationError = nil
        Task {
            defer {
                if activeMutationID == operationID {
                    activeMutationID = nil
                    isOpeningGatewayDashboard = false
                }
            }
            do {
                let updated = try await client.openGatewayDashboard()
                guard activeMutationID == operationID else { return }
                status = updated
                connection = .online
            } catch {
                guard activeMutationID == operationID else { return }
                operationError = error.localizedDescription
            }
        }
    }
}
