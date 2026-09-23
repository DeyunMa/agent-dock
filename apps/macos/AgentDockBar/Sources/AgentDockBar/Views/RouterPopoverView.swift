import AppKit
import SwiftUI

struct RouterPopoverView: View {
    @ObservedObject var model: RouterViewModel
    let onRouteExpansionChange: (Bool) -> Void

    @State private var expandedRouteName: String?
    @State private var showingJev = false

    var body: some View {
        VStack(alignment: .leading, spacing: 13) {
            header
            Divider()

            Button(model.status?.jev.configured == true ? "Jev 服务设置…" : "配置 Jev Key，启用首轮分类…") {
                showingJev = true
            }

            RouterStatusCard(
                status: model.status,
                isChanging: model.isChanging,
                onToggle: model.toggleRouter
            )

            RouteProfilesSection(
                routes: model.status?.routes,
                catalog: model.status?.catalog,
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
        .sheet(isPresented: $showingJev) { JevSettingsView(onChange: model.refresh) }
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
                Text("Agent Dock")
                    .font(.headline)
                Text(connectionLabel)
                    .font(.caption)
                    .foregroundStyle(connectionColor)
            }

            Spacer()

            Button(action: model.refreshModels) {
                Image(systemName: "arrow.clockwise")
            }
            .buttonStyle(.plain)
            .help("同步 Codex 模型列表，不重启会话")
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
            if let version = model.status?.control.version {
                return "控制服务在线 · v\(version)"
            }
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
