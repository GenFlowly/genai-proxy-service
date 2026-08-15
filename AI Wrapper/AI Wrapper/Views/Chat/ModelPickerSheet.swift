import SwiftUI

/// Mirrors RightSidebarMobileModal — the chat right-sidebar widgets:
/// NEW_CHAT, AI_VENDOR (AIVendorWidget), TOKEN_COUNTER.
struct RightSidebarModal: View {
    @EnvironmentObject var router: AppRouter
    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var ai: AIStore
    @EnvironmentObject var conversation: ConversationStore
    @EnvironmentObject var toasts: ToastCenter

    @State private var isRefreshing = false
    @State private var isSaving = false

    /// Modal below the navbar; everything full width; "Close Settings" footer.
    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    // NEW_CHAT widget — full-width PillButton with PLUS icon
                    PillButton(fullWidth: true) {
                        conversation.resetConversation()
                        conversation.editorPrompt = ""
                        router.isRightSidebarOpen = false
                    } label: {
                        WebIcon(name: "add-icon", size: 18, color: .white)
                        Text("New Chat")
                    }

                    // AI_VENDOR widget (AIVendorWidget)
                    modelsWidget

                    // TOKEN_COUNTER widget
                    VStack(alignment: .leading, spacing: 6) {
                        HStack(spacing: 8) {
                            WebIcon(name: "tokens", size: 20)
                            Text("Prompt Tokens")
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(AppTheme.textPrimary)
                        }
                        Text("Estimated: \(TokenEstimator.estimateTokens(conversation.editorPrompt))")
                            .font(.caption)
                            .foregroundStyle(AppTheme.textMuted)
                    }
                }
                .padding()
                .padding(.top, 8)
            }

            // Footer: full-width secondary "Close Settings"
            VStack(spacing: 0) {
                Divider()
                PillButton(style: .secondary, fullWidth: true) {
                    router.isRightSidebarOpen = false
                } label: {
                    Text("Close Settings")
                }
                .padding(.horizontal, 24)
                .padding(.vertical, 16)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(AppTheme.sidebarBackground)
    }

    private var hasAnyValidApiKey: Bool {
        auth.aiVendorAPIKeyStatusList.contains { $0.isValid }
    }

    // MARK: - AIVendorWidget

    private var modelsWidget: some View {
        VStack(alignment: .leading, spacing: 12) {
            // Header: [MODELS icon + "Models"] [refresh] [save]
            HStack(spacing: 8) {
                WebIcon(name: "models", size: 20)
                Text("Models")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(AppTheme.textPrimary)
                Spacer()
                Button {
                    Task { await handleRefresh() }
                } label: {
                    WebIcon(name: "refresh-icon", size: 20, color: AppTheme.textPrimary)
                        .rotationEffect(.degrees(isRefreshing ? 360 : 0))
                        .animation(isRefreshing ? .linear(duration: 1).repeatForever(autoreverses: false) : .default, value: isRefreshing)
                }
                .disabled(isRefreshing || !hasAnyValidApiKey)
                .opacity(hasAnyValidApiKey ? 1 : 0.4)
                .accessibilityLabel("Refresh Models")

                Button {
                    Task { await handleSave() }
                } label: {
                    WebIcon(name: "save-icon", size: 20, color: AppTheme.textPrimary)
                }
                .disabled(isSaving || !hasAnyValidApiKey)
                .opacity(hasAnyValidApiKey ? 1 : 0.4)
                .accessibilityLabel("Set as default")
            }

            ForEach(AIVendor.allCases) { vendor in
                vendorBlock(vendor)
            }
        }
        .task {
            if ai.modelsByVendor.isEmpty { await fetchModels() }
        }
    }

    @ViewBuilder
    private func vendorBlock(_ vendor: AIVendor) -> some View {
        let status = auth.aiVendorAPIKeyStatusList.first { $0.aiVendor == vendor.rawValue }
        let isEnabled = status?.isValid ?? false
        let isActive = ai.isVendorActive(vendor) && !(ai.selectedModel(for: vendor)?.isEmpty ?? true)
        let models = ai.modelsByVendor[vendor] ?? []

        VStack(alignment: .leading, spacing: 6) {
            // Full-width vendor toggle PillButton with brand label
            PillButton(style: isActive ? .primary : .secondary, disabled: !isEnabled, fullWidth: true) {
                if isActive {
                    ai.removeVendor(vendor)
                } else if let firstModel = models.first {
                    ai.setSelectedModel(for: vendor, model: firstModel)
                }
            } label: {
                Image(vendor.iconAsset)
                    .resizable()
                    .scaledToFit()
                    .frame(width: vendor.brandIconSize, height: vendor.brandIconSize)
                Text(vendor.displayName)
            }

            if !isEnabled {
                Text(status?.status ?? APIKeyStatus.notSet)
                    .font(.caption2)
                    .foregroundStyle(AppTheme.error)
            }

            if isActive && isEnabled && !models.isEmpty {
                // Web <select className={styles.modelSelect}>
                Menu {
                    ForEach(models, id: \.self) { model in
                        Button(model) { ai.setSelectedModel(for: vendor, model: model) }
                    }
                } label: {
                    HStack {
                        Text(ai.selectedModel(for: vendor) ?? "")
                            .font(.caption)
                            .foregroundStyle(AppTheme.textPrimary)
                            .lineLimit(1)
                        Spacer()
                        Image(systemName: "chevron.up.chevron.down")
                            .font(.caption2)
                            .foregroundStyle(AppTheme.textMuted)
                    }
                    .padding(.horizontal, 10)
                    .padding(.vertical, 8)
                    .background(AppTheme.backgroundSecondary)
                    .clipShape(RoundedRectangle(cornerRadius: 6))
                    .overlay(RoundedRectangle(cornerRadius: 6).stroke(AppTheme.border, lineWidth: 1))
                }
            }

            if isActive && isEnabled && models.isEmpty {
                Text("No models available")
                    .font(.caption2)
                    .foregroundStyle(AppTheme.error)
            }
        }
    }

    // MARK: - Actions

    private func fetchModels() async {
        guard let token = try? await auth.getAccessTokenSilently() else { return }
        await ai.fetchModels(token: token, vendors: AIVendor.allCases)
    }

    private func handleRefresh() async {
        isRefreshing = true
        defer { isRefreshing = false }
        ai.config = []
        await fetchModels()
    }

    private func handleSave() async {
        guard let token = try? await auth.getAccessTokenSilently() else { return }
        isSaving = true
        defer { isSaving = false }
        do {
            try await SaveAIConfigService.savePreferences(token: token, preferredModels: ai.selectedConfigs)
            toasts.showToast("Preferences saved successfully!")
        } catch {
            toasts.showToast("Failed to save preferences: \(error.localizedDescription)")
        }
    }
}
