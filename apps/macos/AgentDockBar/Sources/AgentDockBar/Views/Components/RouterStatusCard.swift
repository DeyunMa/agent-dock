import SwiftUI

struct RouterStatusCard: View {
    let status: ControlStatus?
    let isChanging: Bool
    let onToggle: () -> Void
    @State private var decisionIndex = 0

    private var recentDecisions: [LatestDecision] { status?.recentDecisions ?? [] }
    private var displayedDecision: LatestDecision? {
        recentDecisions.indices.contains(decisionIndex)
            ? recentDecisions[decisionIndex]
            : recentDecisions.first
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack {
                Label(
                    status?.router.enabled == true ? "自动路由已启用" : "自动路由已暂停",
                    systemImage: status?.router.enabled == true
                        ? "checkmark.circle.fill"
                        : "pause.circle.fill"
                )
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(status?.router.enabled == true ? DockPalette.green : DockPalette.muted)

                if let latestDecision = status?.latestDecision {
                    Text("[\(latestDecision.intent)] [\(latestDecision.route)]")
                        .font(.caption.monospaced().weight(.semibold))
                        .foregroundStyle(DockPalette.blue)
                        .accessibilityLabel("最近路由：\(latestDecision.intent)，\(latestDecision.route)")
                }

                Spacer()

                Button(status?.router.enabled == true ? "暂停" : "启用", action: onToggle)
                    .disabled(status == nil || isChanging)
            }

            Text(status?.activation.message ?? "正在连接本地控制服务…")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            Divider()
            RecentRecordPager(title: "最近路由", count: recentDecisions.count, index: $decisionIndex)

            if let latestDecision = displayedDecision {
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: "bubble.left.and.text.bubble.right")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .frame(width: 14, height: 16)

                    VStack(alignment: .leading, spacing: 2) {
                        Text(latestDecision.displayTitle)
                            .font(.caption.weight(.medium))
                            .lineLimit(1)
                            .truncationMode(.tail)

                        Text("[\(latestDecision.intent)] [\(latestDecision.route)]")
                            .font(.caption2.monospaced().weight(.medium))
                            .foregroundStyle(DockPalette.blue)

                        Text(decisionMetadata(latestDecision))
                            .font(.caption2.monospaced())
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }

                    Spacer(minLength: 4)
                }
                .accessibilityElement(children: .combine)
                .accessibilityLabel("最近触发会话：\(latestDecision.displayTitle)，\(decisionMetadata(latestDecision))")
            } else {
                Text("暂无路由记录")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            if let classifier = status?.router.classifier {
                LabeledContent("本地分类器") {
                    Text(classifier.enabled ? classifier.model : "已关闭")
                        .font(.caption.monospaced())
                }
                .font(.caption)
            }
        }
        .padding(12)
        .background(DockPalette.card, in: RoundedRectangle(cornerRadius: 12))
        .onChange(of: status?.recentDecisions.first?.id) { _, _ in decisionIndex = 0 }
    }

    private func decisionMetadata(_ decision: LatestDecision) -> String {
        var parts = [surfaceLabel(decision.surface), triggerTime(decision.eventTimestamp)]
        if let project = decision.session?.projectName, !project.isEmpty {
            parts.append(project)
        }
        return parts.joined(separator: " · ")
    }

    private func surfaceLabel(_ surface: String?) -> String {
        switch surface {
        case "desktop": "Desktop"
        case "terminal": "Terminal"
        default: "Codex"
        }
    }

    private func triggerTime(_ timestamp: String) -> String {
        let parser = ISO8601DateFormatter()
        parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = parser.date(from: timestamp) else { return "时间未知" }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "zh_CN")
        formatter.dateFormat = Calendar.current.isDateInToday(date) ? "HH:mm:ss" : "MM-dd HH:mm"
        return formatter.string(from: date)
    }
}
