import SwiftUI

/// MobileFullPageModal + the chat page's AI settings cards (Models, Agent, Tokens): covers the
/// page, with a full-width outlined "Close Settings" footer.
struct RightSidebarModal: View {
    @EnvironmentObject var router: AppRouter
    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var ai: AIStore
    @EnvironmentObject var conversation: ConversationStore
    @EnvironmentObject var toasts: ToastCenter
    @ObservedObject private var catalog = ProviderCatalog.shared

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
                VStack(alignment: .leading, spacing: 8) {
                    card(icon: "models", title: L("sidebar.aiVendorWidget.title"), actions: { modelsActions }) { modelsContent }
                    card(icon: "user-role", title: L("sidebar.agentPickerWidget.title")) { agentsContent }
                    card(icon: "tokens", title: L("sidebar.tokenCounter.title")) { tokensContent }
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

    /// SidebarCard with a header: 16pt icon, 12/500 title, actions at the right end, a
    /// hairline under the 34pt header, and the body padded 8 by 10.
    private func card<Content: View>(icon: String, title: String, @ViewBuilder content: () -> Content) -> some View {
        card(icon: icon, title: title, actions: { EmptyView() }, content: content)
    }

    private func card<Actions: View, Content: View>(icon: String, title: String, @ViewBuilder actions: () -> Actions, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                WebIcon(name: icon, size: 16, color: AppTheme.textSecondary)
                Text(title)
                    .webText(12, 500)
                    .foregroundStyle(AppTheme.textSecondary)
                    .lineLimit(1)
                    .accessibilityAddTraits(.isHeader)
                Spacer(minLength: 0)
                actions()
            }
            .padding(.leading, 10)
            .padding(.trailing, 6)
            .frame(height: 34)
            .overlay(alignment: .bottom) { Rectangle().fill(AppTheme.sidebarHairline).frame(height: 1) }

            VStack(alignment: .leading, spacing: 6) {
                content()
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .sidebarCard()
    }

    private func loadData() async {
        guard auth.isAuthenticated, let token = try? await auth.getAccessTokenSilently() else { return }
        await ai.fetchModels(token: token, vendors: vendors)
        await ai.fetchAgents(token: token, version: auth.cacheVersions?["agents"])
    }

    // MARK: - Models card (AIVendorWidget)

    private var modelsActions: some View {
        HStack(spacing: 2) {
            iconAction("refresh-icon", label: hasAnyValidApiKey ? L("sidebar.aiVendorWidget.refreshModels") : L("sidebar.aiVendorWidget.noApiKeysSet"), disabled: isRefreshing || !hasAnyValidApiKey, spinning: isRefreshing) {
                Task { await handleRefresh() }
            }
            iconAction("save-icon", label: hasAnyValidApiKey ? L("sidebar.aiVendorWidget.setAsDefault") : L("sidebar.aiVendorWidget.noApiKeysSet"), disabled: isSaving || !hasAnyValidApiKey) {
                Task { await handleSave() }
            }
        }
    }

    /// IconButton size sm: a 22pt target around a 14pt glyph.
    private func iconAction(_ icon: String, label: String, disabled: Bool, spinning: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            WebIcon(name: icon, size: 14, color: AppTheme.textMuted)
                .rotationEffect(.degrees(spinning ? 360 : 0))
                .animation(spinning ? .linear(duration: 1).repeatForever(autoreverses: false) : .default, value: spinning)
                .frame(width: 22, height: 22)
                .contentShape(Rectangle())
        }
        .buttonStyle(WebPressStyle())
        .disabled(disabled)
        .opacity(disabled ? 0.4 : 1)
        .accessibilityLabel(label)
    }

    private var modelsContent: some View {
        VStack(alignment: .leading, spacing: 6) {
            if vendors.isEmpty {
                Text(L("sidebar.aiVendorWidget.noApiKeysSet")).webText(12).foregroundStyle(Color(hex: "#D9534F"))
            }
            ForEach(vendors) { vendor in
                vendorBlock(vendor)
            }
        }
    }

    private func toggle(_ vendor: AIVendor) {
        guard isEnabled(vendor) else { return }
        if ai.isVendorPopulated(vendor) {
            ai.setSelectedModel(for: vendor, model: "")
        } else if let first = (ai.modelsByVendor[vendor] ?? []).first {
            ai.setSelectedModel(for: vendor, model: first)
        }
    }

    @ViewBuilder
    private func vendorBlock(_ vendor: AIVendor) -> some View {
        let isActive = ai.isVendorPopulated(vendor)
        let enabled = isEnabled(vendor)
        let models = ai.modelsByVendor[vendor] ?? []
        let selectedModel = ai.selectedModel(for: vendor)
        let reasoning = ThinkingLevels.options(for: selectedModel)
        let name = catalog.displayName(for: vendor.rawValue)

        VStack(alignment: .leading, spacing: 6) {
            Button { toggle(vendor) } label: {
                HStack(spacing: 10) {
                    WebSwitch(isOn: isActive && enabled)
                    Text(name)
                        .webText(13, isActive ? 500 : 400)
                        .foregroundStyle(isActive ? AppTheme.textPrimary : AppTheme.textSecondary)
                        .lineLimit(1)
                }
                .padding(.horizontal, 2)
                .frame(minHeight: 28)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(!enabled)
            .opacity(enabled ? 1 : 0.5)
            .accessibilityLabel(name)
            .accessibilityAddTraits(.isToggle)
            .accessibilityValue(isActive && enabled ? "1" : "0")
            .accessibilityIdentifier("vendor-toggle-\(vendor.rawValue)")

            if !enabled {
                Text(auth.aiVendorAPIKeyStatusList.first { $0.aiVendor == vendor.rawValue }?.status ?? APIKeyStatus.notSet)
                    .webText(12)
                    .foregroundStyle(Color(hex: "#D9534F"))
            }
            if isActive, enabled, !models.isEmpty || !reasoning.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    if !models.isEmpty {
                        WebSelect(value: selectedModel, options: models.map { .init(id: $0, label: $0) }, style: .card) {
                            ai.setSelectedModel(for: vendor, model: $0)
                        }
                    }
                    // Reasoning effort rides the request's aiConfig and overrides the agent's
                    // node-level thinking_level on the response generator.
                    if !selectedModel.isEmpty, !reasoning.isEmpty {
                        WebSelect(
                            value: ai.thinkingLevel(for: vendor),
                            options: [.init(id: "", label: L("sidebar.aiVendorWidget.reasoningDefault"))] + reasoning.map { .init(id: $0.value.rawValue, label: $0.label) },
                            style: .card
                        ) {
                            ai.setThinkingLevel(for: vendor, level: $0)
                        }
                        .accessibilityLabel(L("sidebar.aiVendorWidget.reasoning"))
                    }
                }
                .padding(.leading, 42)
            }
            if isActive, enabled, models.isEmpty, !isRefreshing {
                Text(L("sidebar.aiVendorWidget.noModelsAvailable")).webText(12).foregroundStyle(Color(hex: "#D9534F"))
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

    // MARK: - Agent card (AgentPickerWidget)

    @ViewBuilder
    private var agentsContent: some View {
        let agents = ai.conversationAgents
        if ai.agentsLoadFailed {
            Text(L("sidebar.agentPickerWidget.failedToLoad")).webText(12).foregroundStyle(AppTheme.textSecondary)
        } else if agents.isEmpty {
            Text(L("sidebar.agentPickerWidget.noAgents")).webText(12).foregroundStyle(AppTheme.textSecondary)
        } else {
            WebSelect(value: ai.effectiveAgentId ?? "", options: agents.map { .init(id: $0.graphId, label: optionLabel($0)) }, style: .card) { id in
                pickAgent(id)
            }
            .accessibilityLabel(L("sidebar.agentPickerWidget.title"))
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

    // MARK: - Tokens card (TokenCounter)

    private var tokensContent: some View {
        let usage = VendorUsage.byVendor(conversation.blocks)
        return VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(L("sidebar.tokenCounter.promptEstimated")).foregroundStyle(AppTheme.textMuted)
                Spacer(minLength: 8)
                Text(displayedTokens.formatted(.number.grouping(.automatic).locale(Locale(identifier: "en_US"))))
                    .foregroundStyle(AppTheme.textSecondary)
                    .monospacedDigit()
                    .accessibilityIdentifier("token-count-display")
            }
            .webText(12)
            .frame(minHeight: 22)

            Text(L("sidebar.tokenCounter.thisConversation").uppercased())
                .webText(10.5, 500)
                .kerning(0.63)
                .foregroundStyle(AppTheme.textMuted)
                .padding(.top, 8)

            if usage.isEmpty {
                Text(L("sidebar.tokenCounter.noUsageYet"))
                    .webText(12)
                    .foregroundStyle(AppTheme.textMuted)
                    .padding(.top, 4)
            }
            ForEach(usage) { entry in
                vendorUsage(entry)
            }
        }
    }

    private func vendorUsage(_ entry: VendorUsage) -> some View {
        let name = catalog.displayName(for: entry.vendor.rawValue)
        return VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(name).webText(12, 500).foregroundStyle(AppTheme.textSecondary)
                Spacer(minLength: 8)
                if let cost = entry.totals.costUsd {
                    Text(ResponseCardView.formatUsd(cost))
                        .webText(12)
                        .foregroundStyle(AppTheme.textSecondary)
                        .monospacedDigit()
                        .accessibilityLabel(L("conversation.response.conversationCostUsd", ["vendor": name]))
                }
            }
            .frame(minHeight: 22)
            Grid(alignment: .leading, horizontalSpacing: 10, verticalSpacing: 2) {
                GridRow {
                    stat("input-tokens", entry.totals.inputTokens, L("conversation.response.totalInputTokens"))
                    stat("output-tokens", entry.totals.outputTokens, L("conversation.response.totalOutputTokens"))
                }
                GridRow {
                    stat("cache-tokens", entry.totals.tokensReadFromCache, L("conversation.response.tokensReadFromCache"))
                    stat("total-tokens", entry.totals.totalTokens, L("conversation.response.totalTokens"))
                }
            }
            .padding(.top, 2)
            .padding(.bottom, 6)
        }
        .padding(.top, 4)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("token-usage-\(entry.vendor.rawValue)")
    }

    private func stat(_ icon: String, _ value: Int, _ label: String) -> some View {
        HStack(spacing: 4) {
            WebIcon(name: icon, size: 12, color: AppTheme.textMuted)
            Text(value.formatted(.number.grouping(.automatic).locale(Locale(identifier: "en_US"))))
                .webText(11.5)
                .foregroundStyle(AppTheme.textMuted)
                .monospacedDigit()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(label)
    }

    /// The editor only shows while a block is still a draft; the debounce only throttles
    /// re-renders while typing.
    private func updateTokenCount() async {
        try? await Task.sleep(nanoseconds: 500_000_000)
        guard !Task.isCancelled else { return }
        let draftVisible = conversation.blocks.contains { $0.status == .draft && !$0.isLoading }
        let text = draftVisible ? conversation.editorPrompt : ""
        displayedTokens = text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? 0 : TokenEstimator.estimateTokens(text)
    }
}

/// Switch.module.scss: a 32 by 18 track, 14pt thumb; on, the track takes the button colour.
struct WebSwitch: View {
    let isOn: Bool

    var body: some View {
        ZStack(alignment: isOn ? .trailing : .leading) {
            Capsule()
                .fill(isOn ? AppTheme.buttonPrimary : AppTheme.backgroundTertiary)
                .overlay(Capsule().strokeBorder(isOn ? AppTheme.buttonPrimary : AppTheme.border, lineWidth: 1))
            Circle()
                .fill(.white)
                .frame(width: 14, height: 14)
                .shadow(color: .black.opacity(0.25), radius: 1, y: 1)
                .padding(2)
        }
        .frame(width: 32, height: 18)
        .animation(.easeInOut(duration: 0.2), value: isOn)
    }
}

/// A `<select>` opening the system picker menu. `.legacy` is the web's `.modelSelect`: 1pt
/// border, radius 8, 14.4pt, padding 4.8/8; `.card` is the AI settings cards' select: 30pt
/// tall, radius 6, 12pt.
struct WebSelect: View {
    struct Option: Identifiable {
        let id: String
        let label: String
    }

    enum Style {
        case legacy, card
    }

    let value: String
    let options: [Option]
    var style: Style = .legacy
    let onChange: (String) -> Void

    init(value: String, options: [Option], style: Style = .legacy, onChange: @escaping (String) -> Void) {
        self.value = value
        self.options = options
        self.style = style
        self.onChange = onChange
    }

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
            NativeSelectLabel(text: label, font: DSFont.uiArial(style == .card ? 12 : 14.4), horizontalPadding: 8)
                .padding(.horizontal, 1)
                .frame(height: style == .card ? 30 : 29.6)
                .background(AppTheme.backgroundSecondary)
                .clipShape(RoundedRectangle(cornerRadius: style == .card ? 6 : 8))
                .overlay(RoundedRectangle(cornerRadius: style == .card ? 6 : 8).strokeBorder(AppTheme.border, lineWidth: 1))
        }
    }
}
