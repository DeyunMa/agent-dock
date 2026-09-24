import SwiftUI

struct HookStatusCard: View {
    let hints: [HookHintStatus]
    @State private var hintIndex = 0

    private var displayedHint: HookHintStatus? {
        hints.indices.contains(hintIndex) ? hints[hintIndex] : hints.first
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            Label("UserPromptSubmit · Jev Skill 提示", systemImage: "sparkles")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(DockPalette.text)

            Text("只展示 Hook 的本地摘要；是否使用 Skill 仍由 Codex 判断。")
                .font(.caption)
                .foregroundStyle(.secondary)

            Divider()
            RecentRecordPager(title: "最近 Hook", count: hints.count, index: $hintIndex)

            if let hint = displayedHint {
                VStack(alignment: .leading, spacing: 4) {
                    Text(hint.summary)
                        .font(.caption.weight(.medium))
                        .lineLimit(2)
                        .help(hint.summary)

                    if !hint.relationshipLabels.isEmpty {
                        HStack(spacing: 5) {
                            if hint.hasAlternatives { relationshipTag("可能互斥", color: DockPalette.red) }
                            if hint.hasComplementary { relationshipTag("可互补", color: DockPalette.green) }
                            if hint.unresolvedChoice { relationshipTag("未决选择", color: DockPalette.blue) }
                        }
                    }

                    Text(hint.displayTitle)
                        .font(.caption2)
                        .lineLimit(1)
                        .truncationMode(.tail)

                    Text(metadata(hint))
                        .font(.caption2.monospaced())
                        .foregroundStyle(.secondary)
                }
                .accessibilityElement(children: .combine)
            } else {
                Text("暂无 Hook 记录")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(12)
        .background(DockPalette.card, in: RoundedRectangle(cornerRadius: 12))
        .onChange(of: hints.first?.id) { _, _ in hintIndex = 0 }
    }

    private func relationshipTag(_ title: String, color: Color) -> some View {
        Text(title)
            .font(.caption2.weight(.medium))
            .foregroundStyle(color)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(color.opacity(0.10), in: Capsule())
    }

    private func metadata(_ hint: HookHintStatus) -> String {
        let parser = ISO8601DateFormatter()
        parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = parser.date(from: hint.timestamp) else { return "时间未知" }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "zh_CN")
        formatter.dateFormat = Calendar.current.isDateInToday(date) ? "HH:mm:ss" : "MM-dd HH:mm"
        let project = hint.session?.projectName ?? hint.projectName
        return [formatter.string(from: date), project].compactMap { $0 }.joined(separator: " · ")
    }
}
