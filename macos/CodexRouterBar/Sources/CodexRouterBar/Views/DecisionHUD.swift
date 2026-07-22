import SwiftUI

struct DecisionHUD: View {
    let decision: LatestDecision

    var body: some View {
        HStack(spacing: 9) {
            Image(systemName: "arrow.triangle.branch")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(.tint)

            Text("[\(decision.intent)] [\(decision.route)]")
                .font(.system(size: 14, weight: .semibold, design: .monospaced))
                .foregroundStyle(.primary)
                .fixedSize(horizontal: true, vertical: false)
        }
        .padding(.horizontal, 16)
        .frame(width: 220, height: 42)
        .background(.ultraThinMaterial, in: Capsule())
        .overlay {
            Capsule()
                .stroke(Color.accentColor.opacity(0.35), lineWidth: 1)
        }
        .shadow(color: .black.opacity(0.18), radius: 12, y: 5)
        .frame(width: 240, height: 58)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("路由结果：\(decision.intent)，\(decision.route)")
    }
}
