import SwiftUI

struct JevSettingsView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var key = ""
    @State private var configured = false
    @State private var environmentKey = false
    @State private var busy = false
    @State private var message = ""
    @State private var confirmDelete = false
    let onChange: () -> Void
    private let client = RouterControlClient()

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Jev 路由服务").font(.title2)
            Text(configured ? "密钥已配置" : "首次使用：请配置 Jev API Key")
                .foregroundStyle(configured ? .green : .secondary)
            Text("选择 Jev Router 后，首次有效输入的文字（超长时截取首尾）和三档模型配置会发送至 Jev，用于选择当前任务的档位。后续固定，除非你明确恢复自动。请只在组织允许发送的内容上使用自动路由。")
                .font(.callout).fixedSize(horizontal: false, vertical: true)
            SecureField("Jev API Key", text: $key)
                .textFieldStyle(.roundedBorder)
                .disabled(environmentKey || busy)
            Text(environmentKey ? "当前使用 TYPESAFE_API_KEY 环境变量，请在启动环境中管理。" : "仅保存在当前用户的专用权限文件中（0600）；不会显示已保存的密钥。")
                .font(.caption).foregroundStyle(.secondary)
            HStack {
                Button("保存密钥") { perform {
                    let status = try await client.saveJevKey(key)
                    configured = status.jev.configured
                    key = ""
                    message = "已保存。点击测试连接验证有效性。"
                } }.disabled(key.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || environmentKey || busy)
                Button("测试连接") { perform {
                    let result = try await client.testJev()
                    message = result.ok ? "连接成功 · \(result.latencyMs) ms" : "连接失败：\(result.status) · \(result.latencyMs) ms"
                } }.disabled(!configured || busy)
                Button("删除密钥", role: .destructive) { confirmDelete = true }
                    .disabled(!configured || environmentKey || busy)
            }
            Text("测试会发送固定模拟请求，可能产生少量 API 费用，不读取你的对话。")
                .font(.caption).foregroundStyle(.secondary)
            if busy { ProgressView().controlSize(.small) }
            if !message.isEmpty { Text(message).font(.callout).textSelection(.enabled) }
            HStack {
                Link("获取 Jev Key", destination: URL(string: "https://console.typesafe.ai/")!)
                Spacer()
                Button("完成") { key = ""; dismiss() }.keyboardShortcut(.defaultAction)
            }
        }
        .padding(24).frame(width: 510)
        .task { perform {
            let status = try await client.fetchStatus()
            configured = status.jev.configured
            environmentKey = status.jev.source == "environment"
        } }
        .confirmationDialog("删除此电脑保存的 Jev Key？自动分类将不可用，手动模型仍可使用。", isPresented: $confirmDelete) {
            Button("删除密钥", role: .destructive) { perform {
                _ = try await client.deleteJevKey()
                configured = false
                key = ""
                message = "密钥已删除。"
            } }
        }
    }

    private func perform(_ operation: @escaping @MainActor () async throws -> Void) {
        guard !busy else { return }
        busy = true
        Task { @MainActor in
            defer { busy = false; onChange() }
            do { try await operation() }
            catch { message = error.localizedDescription }
        }
    }
}
