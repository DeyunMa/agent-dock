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
    private var isRefreshing = false
    private var statusRevision = 0

    init(client: RouterControlClient = RouterControlClient()) {
        self.client = client
    }

    func refresh() {
        guard !isRefreshing else { return }
        isRefreshing = true
        let revision = statusRevision
        Task {
            defer { isRefreshing = false }
            do {
                let refreshedStatus = try await client.fetchStatus()
                guard revision == statusRevision else { return }
                status = refreshedStatus
                connection = .online
            } catch {
                guard revision == statusRevision else { return }
                connection = .offline(error.localizedDescription)
            }
        }
    }

    func toggleRouter() {
        guard let status, !isChanging else { return }
        isChanging = true
        statusRevision += 1
        operationError = nil
        Task {
            defer { isChanging = false }
            do {
                self.status = try await client.setEnabled(!status.router.enabled)
                connection = .online
            } catch {
                operationError = error.localizedDescription
            }
        }
    }

    func updateRoute(name: String, model: String, effort: String, fast: Bool) {
        guard savingRoute == nil else { return }
        savingRoute = name
        statusRevision += 1
        operationError = nil
        Task {
            defer { savingRoute = nil }
            do {
                status = try await client.updateRoute(
                    name: name,
                    update: RouteUpdate(model: model, effort: effort, fast: fast)
                )
                connection = .online
            } catch {
                operationError = error.localizedDescription
            }
        }
    }

    func toggleGateway() {
        guard let gateway = status?.gateway, !isChangingGateway else { return }
        isChangingGateway = true
        statusRevision += 1
        operationError = nil
        Task {
            defer { isChangingGateway = false }
            do {
                status = try await client.setGatewayRouted(!gateway.routed)
                connection = .online
            } catch {
                operationError = error.localizedDescription
            }
        }
    }

    func openGatewayDashboard() {
        guard !isOpeningGatewayDashboard else { return }
        isOpeningGatewayDashboard = true
        statusRevision += 1
        operationError = nil
        Task {
            defer { isOpeningGatewayDashboard = false }
            do {
                status = try await client.openGatewayDashboard()
                connection = .online
            } catch {
                operationError = error.localizedDescription
            }
        }
    }
}
