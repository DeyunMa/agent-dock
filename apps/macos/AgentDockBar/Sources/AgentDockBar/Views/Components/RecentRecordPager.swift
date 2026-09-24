import SwiftUI

struct RecentRecordPager: View {
    let title: String
    let count: Int
    @Binding var index: Int

    var body: some View {
        HStack(spacing: 6) {
            Text(title)
                .font(.caption2.weight(.semibold))
                .foregroundStyle(DockPalette.muted)

            Spacer()

            if count > 0 {
                Text("\(min(index + 1, count)) / \(count)")
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(DockPalette.muted)

                Button {
                    index = min(index + 1, count - 1)
                } label: {
                    Image(systemName: "chevron.left")
                }
                .disabled(index >= count - 1)
                .help("更早一条")

                Button {
                    index = max(index - 1, 0)
                } label: {
                    Image(systemName: "chevron.right")
                }
                .disabled(index == 0)
                .help("更新一条")
            }
        }
        .buttonStyle(.plain)
        .font(.caption)
        .tint(DockPalette.blue)
    }
}
