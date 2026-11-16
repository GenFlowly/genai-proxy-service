import SwiftUI

/// MobileFullPageModal + the chat page's right-sidebar widgets (AI_VENDOR, AGENT_PICKER,
/// TOKEN_COUNTER): covers the page, with a full-width outlined "Close Settings" footer.
struct RightSidebarModal: View {
    @EnvironmentObject var router: AppRouter
    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var ai: AIStore
    @EnvironmentObject var conversation: ConversationStore
    @EnvironmentObject var toasts: ToastCenter

    @State private var isRefreshing = false
    @State private var isSaving = false
    @State private var displayedTokens = 0

    /// Only vendors with a working key are offered.
    private var vendors: [AIVendor] {
        auth.aiVendorAPIKeyStatusList
            .filter { $0.status == APIKeyStatus.valid || $0.isAPIKeyValid == true }
            .map { AIVendor(rawValue: $0.aiVendor) }
    }

    private func isEnabled(_ vendor: AIVendor) -> Bool {
        auth.aiVendorAPIKeyStatusList.first { $0.aiVendor == vendor.rawValue }?.status == APIKeyStatus.valid
    }

    private var hasAnyValidApiKey: Bool { vendors.contains(where: isEnabled) }

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    widget(header: modelsHeader) { modelsContent }
                    widget(header: agentsHeader) { agentsContent }
                    widget(header: tokensHeader, isLast: true) { tokensContent }
                }
                .padding(4.8)
            }
            .padding(.top, 16)

            PillButton(label: L("layout.mobileFullPageModal.closeSettings"), style: .secondary, fullWidth: true) {
                router.isRightSidebarOpen = false
            }
            .padding(.horizontal, 24)
            .padding(.vertical, 16)
            .padding(.top, 1)
            .overlay(alignment: .top) { Rectangle().fill(AppTheme.border).frame(height: 1) }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(AppTheme.sidebarBackground)
        .task(id: vendors) { await loadData() }
        .task(id: conversation.editorPrompt) { await updateTokenCount() }
    }

    /// SidebarWidgetContainer: a divider and 16pt either side of it, except after the last.
    private func widget<Header: View, Content: View>(header: Header, isLast: Bool = false, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            header
            content()
        }
        .padding(.bottom, isLast ? 0 : 17)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(alignment: .bottom) {
            if !isLast { Rectangle().fill(AppTheme.border).frame(height: 1) }
        }
        .padding(.bottom, isLast ? 0 : 16)
    }

    private func loadData() async {
        guard auth.isAuthenticated, let token = try? await auth.getAccessTokenSilently() else { return }
        await ai.fetchModels(token: token, vendors: vendors)
        await ai.fetchAgents(token: token, version: auth.cacheVersions?["agents"])
    }

    // MARK: - AIVendorWidget

    private var modelsHeader: some View {
        HStack {
            HStack(spacing: 8) {
                WebIcon(name: "models", size: 20)
                Text(L("sidebar.aiVendorWidget.title")).webText(16, 600).foregroundStyle(AppTheme.textPrimary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            HStack(spacing: 8) {
                iconAction("refresh-icon", label: L("sidebar.aiVendorWidget.refreshModels"), disabled: isRefreshing || !hasAnyValidApiKey, spinning: isRefreshing) {
                    Task { await handleRefresh() }
                }
                iconAction("save-icon", label: L("sidebar.aiVendorWidget.setAsDefault"), disabled: isSaving || !hasAnyValidApiKey) {
                    Task { await handleSave() }
                }
            }
        }
    }

    private func iconAction(_ icon: String, label: String, disabled: Bool, spinning: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            WebIcon(name: icon, size: 20, color: AppTheme.textSecondary)
                .rotationEffect(.degrees(spinning ? 360 : 0))
                .animation(spinning ? .linear(duration: 1).repeatForever(autoreverses: false) : .default, value: spinning)
                .padding(7.4)
        }
        .buttonStyle(WebPressStyle())
        .disabled(disabled)
        .opacity(disabled ? 0.5 : 1)
        .accessibilityLabel(label)
    }

    private var modelsContent: some View {
        VStack(alignment: .leading, spacing: 16) {
            if vendors.isEmpty {
                Text(L("sidebar.aiVendorWidget.noApiKeysSet")).webText(13.6).foregroundStyle(Color(hex: "#D9534F"))
            }
            ForEach(vendors) { vendor in
                vendorBlock(vendor)
            }
        }
    }

    @ViewBuilder
    private func vendorBlock(_ vendor: AIVendor) -> some View {
        let isActive = ai.isVendorPopulated(vendor)
        let enabled = isEnabled(vendor)
        let models = ai.modelsByVendor[vendor] ?? []
        let selectedModel = ai.selectedModel(for: vendor)
        let reasoning = ThinkingLevels.options(for: selectedModel)

        VStack(alignment: .leading, spacing: 8) {
            PillButton(style: isActive ? .primary : .secondary, disabled: !enabled, fullWidth: true, action: {
                guard enabled else { return }
                if isActive {
                    ai.setSelectedModel(for: vendor, model: "")
                } else if let first = models.first {
                    ai.setSelectedModel(for: vendor, model: first)
                }
            }, label: {
                VendorBrandName(vendor: vendor)
            })

            if !enabled {
                Text(auth.aiVendorAPIKeyStatusList.first { $0.aiVendor == vendor.rawValue }?.status ?? APIKeyStatus.notSet)
                    .webText(13.6)
                    .foregroundStyle(Color(hex: "#D9534F"))
            }
            if isActive, enabled, !models.isEmpty {
                WebSelect(value: selectedModel, options: models.map { .init(id: $0, label: $0) }) {
                    ai.setSelectedModel(for: vendor, model: $0)
                }
            }
            // Reasoning effort rides the request's aiConfig and overrides the agent's
            // node-level thinking_level on the response generator.
            if isActive, enabled, !selectedModel.isEmpty, !reasoning.isEmpty {
                WebSelect(
                    value: ai.thinkingLevel(for: vendor),
                    options: [.init(id: "", label: L("sidebar.aiVendorWidget.reasoningDefault"))] + reasoning.map { .init(id: $0.value.rawValue, label: $0.label) }
                ) {
                    ai.setThinkingLevel(for: vendor, level: $0)
                }
                .accessibilityLabel(L("sidebar.aiVendorWidget.reasoning"))
            }
            if isActive, enabled, models.isEmpty, !isRefreshing {
                Text(L("sidebar.aiVendorWidget.noModelsAvailable")).webText(13.6).foregroundStyle(Color(hex: "#D9534F"))
            }
        }
    }

    private func handleRefresh() async {
        guard let token = try? await auth.getAccessTokenSilently() else { return }
        isRefreshing = true
        defer { isRefreshing = false }
        await ai.refreshModels(token: token, vendors: vendors)
    }

    private func handleSave() async {
        guard let token = try? await auth.getAccessTokenSilently() else { return }
        isSaving = true
        defer { isSaving = false }
        do {
            let models = ai.selectedConfigs
            try await SaveAIConfigService.savePreferences(token: token, preferredModels: models)
            auth.mergePreferences(preferredModels: models)
            toasts.showToast(L("sidebar.aiVendorWidget.preferencesSavedSuccessfully"))
        } catch {
            toasts.showToast(L("sidebar.aiVendorWidget.failedToSavePreferences", ["message": error.localizedDescription]))
        }
    }

    // MARK: - AgentPickerWidget

    private var agentsHeader: some View {
        HStack(spacing: 8) {
            WebIcon(name: "user-role", size: 20)
            Text(L("sidebar.agentPickerWidget.title")).webText(16, 600).foregroundStyle(AppTheme.textPrimary)
        }
    }

    @ViewBuilder
    private var agentsContent: some View {
        let agents = ai.conversationAgents
        VStack(alignment: .leading, spacing: 6.4) {
            if ai.agentsLoadFailed {
                Text(L("sidebar.agentPickerWidget.failedToLoad")).webText(12.8).foregroundStyle(AppTheme.textSecondary)
            } else if agents.isEmpty {
                Text(L("sidebar.agentPickerWidget.noAgents")).webText(12.8).foregroundStyle(AppTheme.textSecondary)
            } else {
                WebSelect(value: ai.effectiveAgentId ?? "", options: agents.map { .init(id: $0.graphId, label: optionLabel($0)) }) { id in
                    pickAgent(id)
                }
                .accessibilityLabel(L("sidebar.agentPickerWidget.title"))
            }
        }
    }

    private func optionLabel(_ agent: Agent) -> String {
        var badges: [String] = []
        if agent.isSystem == true { badges.append(L("sidebar.agentPickerWidget.systemBadge")) }
        if agent.graphId == ai.effectiveAgentId { badges.append(L("sidebar.agentPickerWidget.defaultBadge")) }
        return badges.isEmpty ? agent.name : "\(agent.name) (\(badges.joined(separator: ", ")))"
    }

    private func pickAgent(_ id: String) {
        Task {
            guard let token = try? await auth.getAccessTokenSilently() else { return }
            ai.selectAgent(id: id, token: token) { toasts.showToast(L("sidebar.agentPickerWidget.failedToSave")) }
            auth.mergePreferences(preferredAgentId: id)
        }
    }

    // MARK: - TokenCounter

    private var tokensHeader: some View {
        HStack(spacing: 8) {
            WebIcon(name: "tokens", size: 20)
            Text(L("sidebar.tokenCounter.promptTokens")).webText(14.4, 600).foregroundStyle(AppTheme.textSecondary)
        }
        .padding(.horizontal, 4)
        .padding(.vertical, 8)
    }

    private var tokensContent: some View {
        Text(L("sidebar.tokenCounter.estimated", ["tokenCount": displayedTokens]))
            .webText(16)
            .foregroundStyle(AppTheme.textPrimary)
            .padding(.horizontal, 4)
    }

    /// TextEditor is only rendered when the active block isn't resolved yet; the debounce
    /// only throttles re-renders while typing.
    private func updateTokenCount() async {
        try? await Task.sleep(nanoseconds: 500_000_000)
        guard !Task.isCancelled else { return }
        let draftVisible = conversation.blocks.contains { $0.status == .draft && !$0.isLoading }
        let text = draftVisible ? conversation.editorPrompt : ""
        displayedTokens = text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? 0 : TokenEstimator.estimateTokens(text)
    }
}

/// A `<select>` styled like the web's `.modelSelect`: 1pt border, radius 8, 14.4pt, padding
/// 4.8/8, opening the system picker menu.
struct WebSelect: View {
    struct Option: Identifiable {
        let id: String
        let label: String
    }

    let value: String
    let options: [Option]
    let onChange: (String) -> Void

    private var label: String { options.first { $0.id == value }?.label ?? options.first?.label ?? "" }

    var body: some View {
        Menu {
            ForEach(options) { option in
                Button {
                    onChange(option.id)
                } label: {
                    if option.id == value {
                        Label(option.label, systemImage: "checkmark")
                    } else {
                        Text(option.label)
                    }
                }
            }
        } label: {
            NativeSelectLabel(text: label, font: DSFont.uiArial(14.4), horizontalPadding: 8)
                .padding(.horizontal, 1)
                .frame(height: 29.6)
                .background(AppTheme.backgroundSecondary)
                .clipShape(RoundedRectangle(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(AppTheme.border, lineWidth: 1))
        }
    }
}
