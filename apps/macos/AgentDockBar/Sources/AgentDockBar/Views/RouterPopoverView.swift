import AppKit
import SwiftUI

struct RouterPopoverView: View {
    private enum Module: String, CaseIterable {
        case router = "Router"
        case hook = "Hook"
        case gateway = "Gateway"
    }

    @ObservedObject var model: RouterViewModel
    let onRouteExpansionChange: (Bool) -> Void

    @State private var expandedRouteName: String?
    @State private var selectedModule: Module = .router
    @State private var showingJev = false
    @AppStorage("agentDock.showRouterModule") private var showRouter = true
    @AppStorage("agentDock.showHookModule") private var showHook = true
    @AppStorage("agentDock.showGatewayModule") private var showGateway = true

    private var visibleModules: [Module] {
        Module.allCases.filter(isVisible)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 13) {
            header
                .padding(.horizontal, 16)
            Divider()

            ScrollView {
                VStack(alignment: .leading, spacing: 13) {
                    switch selectedModule {
                    case .router:
                        routerModule
                    case .hook:
                        sectionTitle("Hook")
                        HookStatusCard(hints: model.status?.recentHookHints ?? [])
                    case .gateway:
                        sectionTitle("Gateway")
                        GatewayStatusCard(
                            gateway: model.status?.gateway,
                            isChanging: model.isChangingGateway,
                            isOpeningDashboard: model.isOpeningGatewayDashboard,
                            onToggle: model.toggleGateway,
                            onOpenDashboard: model.openGatewayDashboard
                        )
                    }

                    if let error = model.operationError {
                        Label(error, systemImage: "exclamationmark.triangle.fill")
                            .font(.caption)
                            .foregroundStyle(.red)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(.horizontal, 16)
            }

            Divider()
            footer
                .padding(.horizontal, 16)
        }
        .padding(.vertical, 16)
        .frame(width: 420)
        .background(DockPalette.canvas)
        .preferredColorScheme(.light)
        .tint(DockPalette.blue)
        .task { model.refresh() }
        .onAppear { ensureVisibleSelection() }
        .sheet(isPresented: $showingJev) { JevSettingsView(onChange: model.refresh) }
    }

    private var routerModule: some View {
        Group {
            sectionTitle("Router")
            Button(model.status?.jev.configured == true ? "Jev 服务设置…" : "配置 Jev Key，启用首轮分类…") {
                showingJev = true
            }

            RouterStatusCard(
                status: model.status,
                isChanging: model.isChanging,
                onToggle: model.toggleRouter
            )

            Text("模型档位")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            RouteProfilesSection(
                routes: model.status?.routes,
                catalog: model.status?.catalog,
                gateway: model.status?.gateway,
                savingRoute: model.savingRoute,
                onExpansionChange: onRouteExpansionChange,
                onSave: model.updateRoute,
                expandedRouteName: $expandedRouteName
            )
        }
    }

    private func sectionTitle(_ title: String) -> some View {
        Text(title)
            .font(.headline)
            .foregroundStyle(DockPalette.text)
            .frame(maxWidth: .infinity, alignment: .leading)
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

            HStack(spacing: 7) {
                Button {
                    switchModule(-1)
                } label: {
                    Image(systemName: "chevron.left")
                }
                .foregroundStyle(DockPalette.blue)
                .disabled(visibleModules.count < 2)
                .help("上一个模块")

                Text("\(selectedModule.rawValue) \(modulePosition) / \(visibleModules.count)")
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(DockPalette.text)
                    .frame(minWidth: 78)

                Button {
                    switchModule(1)
                } label: {
                    Image(systemName: "chevron.right")
                }
                .foregroundStyle(DockPalette.blue)
                .disabled(visibleModules.count < 2)
                .help("下一个模块")

                Menu {
                    ForEach(Module.allCases, id: \.self) { module in
                        Toggle(module.rawValue, isOn: visibilityBinding(for: module))
                            .disabled(isVisible(module) && visibleModules.count == 1)
                    }
                } label: {
                    Image(systemName: "gearshape")
                }
                .foregroundStyle(DockPalette.muted)
                .menuStyle(.borderlessButton)
                .help("设置显示的模块")
            }
            .buttonStyle(.plain)
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
            .background(DockPalette.card, in: Capsule())

            Button(action: model.refreshModels) {
                Image(systemName: "arrow.clockwise")
            }
            .buttonStyle(.plain)
            .help("同步 Codex 模型列表，不重启会话")
        }
    }

    private var modulePosition: Int {
        (visibleModules.firstIndex(of: selectedModule) ?? 0) + 1
    }

    private func isVisible(_ module: Module) -> Bool {
        switch module {
        case .router: showRouter
        case .hook: showHook
        case .gateway: showGateway
        }
    }

    private func visibilityBinding(for module: Module) -> Binding<Bool> {
        Binding(
            get: { isVisible(module) },
            set: { visible in
                guard visible || visibleModules.count > 1 else { return }
                switch module {
                case .router: showRouter = visible
                case .hook: showHook = visible
                case .gateway: showGateway = visible
                }
                if module == .router && !visible {
                    expandedRouteName = nil
                    onRouteExpansionChange(false)
                }
                ensureVisibleSelection()
            }
        )
    }

    private func ensureVisibleSelection() {
        if !visibleModules.contains(selectedModule) {
            selectedModule = visibleModules.first ?? .router
        }
    }

    private func switchModule(_ step: Int) {
        let modules = visibleModules
        guard modules.count > 1 else { return }
        let current = modules.firstIndex(of: selectedModule) ?? 0
        selectedModule = modules[(current + step + modules.count) % modules.count]
        expandedRouteName = nil
        onRouteExpansionChange(false)
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
            return DockPalette.green
        case .offline:
            return DockPalette.red
        }
    }
}
