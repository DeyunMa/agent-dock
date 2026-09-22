import SwiftUI

private enum RouteRowMetrics {
    static let horizontalInset: CGFloat = 10
    static let columnSpacing: CGFloat = 8
    static let disclosureWidth: CGFloat = 10
    static let routeWidth: CGFloat = 62
    static let effortWidth: CGFloat = 46
    static let speedWidth: CGFloat = 42
}

struct RouteProfilesSection: View {
    let routes: [RouteSummary]?
    let gateway: GatewayStatus?
    let savingRoute: String?
    let onExpansionChange: (Bool) -> Void
    let onSave: (String, String, String, Bool) -> Void

    @Binding var expandedRouteName: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            columnHeader

            if let routes {
                VStack(spacing: 6) {
                    ForEach(routes) { route in
                        RouteEditorRow(
                            route: route,
                            modelChoices: gateway?.availableModels ?? [],
                            gateway: gateway,
                            isSaving: savingRoute == route.name,
                            isExpanded: expansionBinding(for: route.name)
                        ) { model, effort, fast in
                            onSave(route.name, model, effort, fast)
                        }
                        .id("\(route.name)|\(route.model)|\(route.effort)|\(route.fast)")
                    }
                }
            } else {
                ProgressView()
                    .controlSize(.small)
            }
        }
    }

    private var columnHeader: some View {
        HStack(spacing: RouteRowMetrics.columnSpacing) {
            Color.clear
                .frame(width: RouteRowMetrics.disclosureWidth)
            Text("档位")
                .frame(width: RouteRowMetrics.routeWidth, alignment: .leading)
            Text("模型")
                .frame(maxWidth: .infinity, alignment: .leading)
            Text("推理")
                .frame(width: RouteRowMetrics.effortWidth, alignment: .center)
            Text("速度")
                .frame(width: RouteRowMetrics.speedWidth, alignment: .center)
        }
        .padding(.horizontal, RouteRowMetrics.horizontalInset)
        .font(.caption2.weight(.medium))
        .foregroundStyle(.tertiary)
    }

    private func expansionBinding(for routeName: String) -> Binding<Bool> {
        Binding(
            get: { expandedRouteName == routeName },
            set: { shouldExpand in
                expandedRouteName = shouldExpand ? routeName : nil
                onExpansionChange(shouldExpand)
            }
        )
    }
}

private struct RouteEditorRow: View {
    let route: RouteSummary
    let modelChoices: [GatewayModelInfo]
    let gateway: GatewayStatus?
    let isSaving: Bool
    let onSave: (String, String, Bool) -> Void

    @Binding private var isExpanded: Bool
    @State private var modelID: String
    @State private var effort: String
    @State private var fast: Bool

    private let standardEfforts = ["low", "medium", "high", "xhigh", "max", "ultra"]

    init(
        route: RouteSummary,
        modelChoices: [GatewayModelInfo],
        gateway: GatewayStatus?,
        isSaving: Bool,
        isExpanded: Binding<Bool>,
        onSave: @escaping (String, String, Bool) -> Void
    ) {
        self.route = route
        self.modelChoices = modelChoices
        self.gateway = gateway
        self.isSaving = isSaving
        self.onSave = onSave
        _isExpanded = isExpanded
        _modelID = State(initialValue: route.model)
        _effort = State(initialValue: route.effort)
        _fast = State(initialValue: route.fast)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            summaryButton

            if isExpanded {
                Divider()
                    .padding(.horizontal, RouteRowMetrics.horizontalInset)
                editor
            }
        }
        .background(
            .quinary.opacity(isExpanded ? 0.82 : 0.58),
            in: RoundedRectangle(cornerRadius: 10)
        )
        .overlay {
            RoundedRectangle(cornerRadius: 10)
                .stroke(isExpanded ? Color.accentColor.opacity(0.18) : Color.clear, lineWidth: 1)
        }
    }

    private var summaryButton: some View {
        Button {
            withAnimation(.easeInOut(duration: 0.16)) {
                isExpanded.toggle()
            }
        } label: {
            HStack(spacing: RouteRowMetrics.columnSpacing) {
                Image(systemName: "chevron.right")
                    .font(.system(size: 8, weight: .semibold))
                    .foregroundStyle(.tertiary)
                    .rotationEffect(.degrees(isExpanded ? 90 : 0))
                    .frame(width: RouteRowMetrics.disclosureWidth)
                    .accessibilityHidden(true)

                Text(route.displayName)
                    .font(.caption.monospaced().weight(.semibold))
                    .frame(width: RouteRowMetrics.routeWidth, alignment: .leading)

                Text(route.model)
                    .font(.caption.monospaced())
                    .foregroundStyle(routeModelAvailable ? Color.primary : Color.orange)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .help(routeModelHelp)

                Text(route.effort)
                    .font(.caption2.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .frame(width: RouteRowMetrics.effortWidth, alignment: .center)

                Text(route.fast ? "Fast" : "标准")
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(routeSpeedColor)
                    .lineLimit(1)
                    .frame(width: RouteRowMetrics.speedWidth, alignment: .center)
            }
            .padding(.horizontal, RouteRowMetrics.horizontalInset)
            .frame(height: 38)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(
            "\(route.displayName) 档位，\(route.model)，推理 \(route.effort)，\(route.fast ? "Fast" : "标准")"
        )
        .accessibilityValue(isExpanded ? "已展开" : "已折叠")
    }

    private var editor: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(spacing: 10) {
                fieldLabel("模型")

                Picker("模型", selection: $modelID) {
                    ForEach(availableModels) { candidate in
                        Text(modelChoiceLabel(candidate))
                            .font(.caption.monospaced())
                            .tag(candidate.id)
                    }
                }
                .labelsHidden()
                .pickerStyle(.menu)
                .controlSize(.small)
                .font(.caption.monospaced())
                .frame(maxWidth: .infinity, alignment: .leading)
                .help("从 OpenCodex 模型列表选择")
            }

            modelStatusLine

            HStack(spacing: 10) {
                fieldLabel("推理强度")

                Picker("推理强度", selection: $effort) {
                    ForEach(effortChoices, id: \.self) { value in
                        Text(value).tag(value)
                    }
                }
                .labelsHidden()
                .pickerStyle(.menu)
                .controlSize(.small)
                .font(.caption)
                .frame(width: 106)

                Spacer()

                FastToggle(isOn: $fast)
                    .frame(width: 78, alignment: .trailing)
                    .disabled(!selectedModelSupportsFast)
                    .opacity(selectedModelSupportsFast ? 1 : 0.55)
                    .help(fastHelp)
            }

            HStack(spacing: 8) {
                Spacer()

                Button("取消") {
                    resetEditor()
                    withAnimation(.easeInOut(duration: 0.16)) {
                        isExpanded = false
                    }
                }
                .buttonStyle(.plain)

                Button(isSaving ? "保存中…" : "保存") {
                    onSave(trimmedModelID, effort, fast)
                    withAnimation(.easeInOut(duration: 0.16)) {
                        isExpanded = false
                    }
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                .disabled(isSaving || trimmedModelID.isEmpty || !selectionValid)
            }
        }
        .padding(.horizontal, RouteRowMetrics.horizontalInset)
        .padding(.top, 9)
        .padding(.bottom, 10)
        .onAppear(perform: normalizeSelection)
        .onChange(of: modelID) { _, _ in
            normalizeSelection()
        }
    }

    private func fieldLabel(_ title: String) -> some View {
        Text(title)
            .font(.caption)
            .foregroundStyle(.secondary)
            .frame(width: 56, alignment: .leading)
    }

    private func resetEditor() {
        modelID = route.model
        effort = route.effort
        fast = route.fast
    }

    private func normalizeSelection() {
        let model = selectedModel
        guard model.capabilitiesKnown else { return }
        if !model.reasoningEfforts.isEmpty && !model.reasoningEfforts.contains(effort) {
            effort = model.defaultReasoningEffort.flatMap { preferred in
                model.reasoningEfforts.contains(preferred) ? preferred : nil
            } ?? model.reasoningEfforts[0]
        }
        if !model.supportsFast {
            fast = false
        }
    }

    private var trimmedModelID: String {
        modelID.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var availableModels: [GatewayModelInfo] {
        var seen = Set<String>()
        return (modelChoices + [GatewayModelInfo.fallback(id: route.model)]).filter { model in
            seen.insert(model.id).inserted
        }
    }

    private var effortChoices: [String] {
        if selectedModel.capabilitiesKnown && !selectedModel.reasoningEfforts.isEmpty {
            return selectedModel.reasoningEfforts
        }
        return Array(Set(standardEfforts + [route.effort])).sorted { lhs, rhs in
            let left = standardEfforts.firstIndex(of: lhs) ?? standardEfforts.count
            let right = standardEfforts.firstIndex(of: rhs) ?? standardEfforts.count
            return left == right ? lhs < rhs : left < right
        }
    }

    private var selectedModel: GatewayModelInfo {
        availableModels.first { $0.id == modelID } ?? GatewayModelInfo.fallback(id: modelID)
    }

    private var routeModel: GatewayModelInfo {
        availableModels.first { $0.id == route.model } ?? GatewayModelInfo.fallback(id: route.model)
    }

    private var selectedModelSupportsFast: Bool {
        !selectedModel.capabilitiesKnown || selectedModel.supportsFast
    }

    private var selectionValid: Bool {
        guard selectedModel.capabilitiesKnown else { return true }
        let effortValid = selectedModel.reasoningEfforts.isEmpty
            || selectedModel.reasoningEfforts.contains(effort)
        return effortValid && (!fast || selectedModel.supportsFast)
    }

    private var routeModelAvailable: Bool {
        isAvailable(routeModel)
    }

    private var routeModelHelp: String {
        if let warning = availabilityWarning(routeModel) {
            return "\(route.model)\n\(warning)"
        }
        return "\(route.model) · \(routeModel.providerDisplayName)"
    }

    private var routeSpeedColor: Color {
        if route.fast && routeModel.capabilitiesKnown && !routeModel.supportsFast {
            return .orange
        }
        return route.fast ? .blue : .secondary
    }

    private var fastHelp: String {
        selectedModelSupportsFast
            ? "使用 priority service tier"
            : "该模型不支持 Fast / priority service tier"
    }

    private var modelStatusLine: some View {
        HStack(spacing: 6) {
            Color.clear
                .frame(width: 56)

            Label(selectedModel.providerDisplayName, systemImage: "building.2")
                .font(.caption2)
                .foregroundStyle(.secondary)

            if let warning = availabilityWarning(selectedModel) {
                Text(warning)
                    .font(.caption2)
                    .foregroundStyle(.orange)
                    .lineLimit(1)
            } else if !selectedModel.capabilitiesKnown {
                Text("能力信息暂不可用")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            } else if !selectedModel.supportsFast {
                Text("不支持 Fast")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }

            Spacer()
        }
    }

    private func modelChoiceLabel(_ model: GatewayModelInfo) -> String {
        let availability = isAvailable(model) ? "" : " · 当前不可用"
        return "\(model.displayName) · \(model.providerDisplayName)\(availability)"
    }

    private func isAvailable(_ model: GatewayModelInfo) -> Bool {
        if gateway?.routed == true && gateway?.running == false {
            return false
        }
        if model.requiresGateway {
            return gateway?.routed == true && gateway?.running == true
        }
        return true
    }

    private func availabilityWarning(_ model: GatewayModelInfo) -> String? {
        if gateway?.routed == true && gateway?.running == false {
            return "Gateway 离线，当前不可用"
        }
        if model.requiresGateway && !isAvailable(model) {
            return "已配置，当前需启用 Gateway"
        }
        return nil
    }
}

private struct FastToggle: View {
    @Binding var isOn: Bool

    var body: some View {
        Button {
            withAnimation(.easeInOut(duration: 0.14)) {
                isOn.toggle()
            }
        } label: {
            HStack(spacing: 7) {
                Text("Fast")
                    .font(.caption)

                ZStack(alignment: isOn ? .trailing : .leading) {
                    Capsule()
                        .fill(isOn ? Color.accentColor : Color.secondary.opacity(0.22))
                        .frame(width: 34, height: 18)
                        .overlay {
                            Capsule()
                                .stroke(Color.primary.opacity(0.08), lineWidth: 0.5)
                        }

                    Circle()
                        .fill(.white)
                        .frame(width: 14, height: 14)
                        .shadow(color: .black.opacity(0.18), radius: 1, y: 0.5)
                        .padding(2)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Fast")
        .accessibilityValue(isOn ? "已开启" : "已关闭")
    }
}
