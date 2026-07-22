import SwiftUI

struct RouterStatusCard: View {
    let status: ControlStatus?
    let isChanging: Bool
    let onToggle: () -> Void

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
                .foregroundStyle(status?.router.enabled == true ? Color.green : Color.secondary)

                Spacer()

                Button(status?.router.enabled == true ? "暂停" : "启用", action: onToggle)
                    .disabled(status == nil || isChanging)
            }

            Text(status?.activation.message ?? "正在连接本地控制服务…")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            if let classifier = status?.router.classifier {
                LabeledContent("本地分类器") {
                    Text(classifier.enabled ? classifier.model : "已关闭")
                        .font(.caption.monospaced())
                }
                .font(.caption)
            }
        }
        .padding(12)
        .background(.quaternary.opacity(0.55), in: RoundedRectangle(cornerRadius: 12))
    }
}
