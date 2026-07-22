import AppKit
import SwiftUI

struct RouterPopoverView: View {
    @ObservedObject var model: RouterViewModel
    let onRouteExpansionChange: (Bool) -> Void

    @State private var expandedRouteName: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 13) {
            header
            Divider()

            RouterStatusCard(
                status: model.status,
                isChanging: model.isChanging,
                onToggle: model.toggleRouter
            )

            RouteProfilesSection(
                routes: model.status?.routes,
                gateway: model.status?.gateway,
                savingRoute: model.savingRoute,
                onExpansionChange: onRouteExpansionChange,
                onSave: model.updateRoute,
                expandedRouteName: $expandedRouteName
            )

            GatewayStatusCard(
                gateway: model.status?.gateway,
                isChanging: model.isChangingGateway,
                isOpeningDashboard: model.isOpeningGatewayDashboard,
                onToggle: model.toggleGateway,
                onOpenDashboard: model.openGatewayDashboard
            )

            if let error = model.operationError {
                Label(error, systemImage: "exclamationmark.triangle.fill")
                    .font(.caption)
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Divider()
            footer
        }
        .padding(16)
        .frame(width: 420)
        .task { model.refresh() }
    }

    private var header: some View {
        HStack(spacing: 10) {
            Image(nsImage: MenuBarIcon.make())
                .resizable()
                .interpolation(.high)
                .frame(width: 21, height: 21)
                .foregroundStyle(.tint)
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 2) {
                Text("Codex Router")
                    .font(.headline)
                Text(connectionLabel)
                    .font(.caption)
                    .foregroundStyle(connectionColor)
            }

            Spacer()

            Button(action: model.refresh) {
                Image(systemName: "arrow.clockwise")
            }
            .buttonStyle(.plain)
            .help("刷新")
        }
    }

    private var footer: some View {
        HStack {
            Label("Fail-open", systemImage: "shield.checkered")
                .font(.caption2)
                .foregroundStyle(.secondary)

            Spacer()

            Button("退出") {
                NSApp.terminate(nil)
            }
            .buttonStyle(.plain)
            .font(.caption)
        }
    }

    private var connectionLabel: String {
        switch model.connection {
        case .connecting:
            return "正在连接"
        case .online:
            return "控制服务在线"
        case .offline:
            return "控制服务离线"
        }
    }

    private var connectionColor: Color {
        switch model.connection {
        case .connecting:
            return .secondary
        case .online:
            return .green
        case .offline:
            return .red
        }
    }
}
