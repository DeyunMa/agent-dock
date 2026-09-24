import SwiftUI

struct GatewayStatusCard: View {
    let gateway: GatewayStatus?
    let isChanging: Bool
    let isOpeningDashboard: Bool
    let onToggle: () -> Void
    let onOpenDashboard: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text("连接状态")
                            .font(.caption.weight(.semibold))
                        Text(badge)
                            .font(.caption2.weight(.medium))
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(badgeColor.opacity(0.13), in: Capsule())
                            .foregroundStyle(badgeColor)
                    }
                    Text(title)
                        .font(.caption.monospaced())
                }

                Spacer()

                if gateway?.kind == "opencodex" {
                    Button(gateway?.routed == true ? "恢复原生" : "启用 Gateway", action: onToggle)
                        .disabled(toggleDisabled)
                }
            }

            Text(gateway?.message ?? "正在读取 Gateway 状态…")
                .font(.caption2)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            if gateway?.kind == "opencodex" {
                HStack(spacing: 8) {
                    Text("供应商、账号与密钥由 OpenCodex 管理")
                        .font(.caption2)
                        .foregroundStyle(.secondary)

                    Spacer()

                    Button(action: onOpenDashboard) {
                        Label(
                            isOpeningDashboard ? "正在打开…" : "配置供应商…",
                            systemImage: "arrow.up.forward.app"
                        )
                    }
                    .controlSize(.small)
                    .disabled(dashboardDisabled)
                    .help("打开本机 OpenCodex Dashboard")
                }
            }

            if gateway?.routed == true {
                Text("切换只影响新启动的 Codex 会话；当前请求不会被中断。")
                    .font(.caption2)
                    .foregroundStyle(.orange)
            }
        }
        .padding(11)
        .background(DockPalette.card, in: RoundedRectangle(cornerRadius: 12))
    }

    private var toggleDisabled: Bool {
        guard let gateway else { return true }
        return !gateway.installed || !gateway.managed || isChanging
    }

    private var dashboardDisabled: Bool {
        guard let gateway else { return true }
        return !gateway.installed || isOpeningDashboard || isChanging
    }

    private var badge: String {
        guard let gateway else { return "检测中" }
        if gateway.routed && !gateway.running { return "异常" }
        if gateway.routed { return "已接管" }
        if gateway.running { return "待命" }
        return gateway.installed ? "未启动" : "未安装"
    }

    private var badgeColor: Color {
        guard let gateway else { return .secondary }
        if gateway.routed && !gateway.running { return DockPalette.red }
        if gateway.routed { return DockPalette.green }
        return gateway.running ? DockPalette.blue : .secondary
    }

    private var title: String {
        guard let gateway else { return "OpenCodex" }
        let version = gateway.version.map { " · \($0)" } ?? ""
        return gateway.kind == "opencodex" ? "OpenCodex\(version)" : "Native Codex"
    }
}
