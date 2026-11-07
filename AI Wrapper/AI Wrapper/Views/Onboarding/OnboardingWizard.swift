import SwiftUI

/// One-time, full-screen setup flow shown in place of the whole app until a brand-new
/// account finishes or skips it. The only way out is "Skip setup" or completing step 4
/// (OnboardingWizard.tsx). Gated on `onboardingCompleted`, whose absence defaults true.
struct OnboardingWizard: View {
    @EnvironmentObject var auth: AuthStore

    private static let totalSteps = 4

    @State private var stepIndex = 0
    @State private var finishing = false
    @State private var error: String?

    private var isLastStep: Bool { stepIndex == Self.totalSteps - 1 }

    var body: some View {
        GeometryReader { proxy in
            ScrollView {
                panel
                    .padding(24)
                    .frame(maxWidth: .infinity)
                    // Centered until the step is taller than the screen, then it scrolls.
                    .frame(minHeight: proxy.size.height)
            }
            .scrollDismissesKeyboard(.interactively)
            .scrollBounceBehavior(.basedOnSize)
        }
        .ignoresSafeArea(.container, edges: .bottom)
        .background(AppTheme.background.ignoresSafeArea())
    }

    private var panel: some View {
        VStack(alignment: .leading, spacing: 24) {
            FlowHeader(spacing: 12) {
                OnboardingProgress(current: stepIndex, total: Self.totalSteps)
                PillButton(label: L("onboarding.skipSetup"), style: .secondary, disabled: finishing) {
                    Task { await finish() }
                }
            }
            Text(L("onboarding.skipHint"))
                .webText(12)
                .foregroundStyle(AppTheme.textMuted)
                .padding(.top, -12)

            step

            if let error {
                Text(error).webText(13).foregroundStyle(AppTheme.error)
            }
        }
        .padding(33)
        .frame(maxWidth: 512, alignment: .leading)
        .background(AppTheme.backgroundSecondary)
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(AppTheme.borderLight, lineWidth: 1))
    }

    @ViewBuilder
    private var step: some View {
        let onBack: (() -> Void)? = stepIndex > 0 ? { stepIndex -= 1 } : nil
        switch stepIndex {
        case 0: StepLlmApiKey(onBack: onBack, onNext: next, isLastStep: isLastStep, finishing: finishing)
        case 1: StepZillizConfig(onBack: onBack, onNext: next, isLastStep: isLastStep, finishing: finishing)
        case 2: StepVoyageApiKey(onBack: onBack, onNext: next, isLastStep: isLastStep, finishing: finishing)
        default: StepTavilyApiKey(onBack: onBack, onNext: next, isLastStep: isLastStep, finishing: finishing)
        }
    }

    private func next() {
        if isLastStep {
            Task { await finish() }
        } else {
            stepIndex += 1
        }
    }

    private func finish() async {
        finishing = true
        error = nil
        defer { finishing = false }
        do {
            let token = try await auth.getAccessTokenSilently()
            try await OnboardingService.completeOnboarding(token: token)
            auth.onboardingCompleted = true
        } catch {
            self.error = L("onboarding.completeError")
        }
    }
}

/// `justify-content: space-between` with wrap: side by side when both fit, else stacked.
private struct FlowHeader<Content: View>: View {
    var spacing: CGFloat
    @ViewBuilder var content: Content

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 16) {
                content
            }
            VStack(alignment: .leading, spacing: spacing) {
                content
            }
        }
    }
}

private struct OnboardingProgress: View {
    let current: Int
    let total: Int

    var body: some View {
        HStack(spacing: 12) {
            HStack(spacing: 6) {
                ForEach(0..<total, id: \.self) { index in
                    RoundedRectangle(cornerRadius: 2)
                        .fill(index <= current ? AppTheme.primary : AppTheme.borderLight)
                        .frame(width: 40, height: 4)
                }
            }
            Text(L("onboarding.stepLabel", ["current": current + 1, "total": total]))
                .webText(13)
                .foregroundStyle(AppTheme.textMuted)
                .fixedSize()
        }
    }
}

/// Title/description/link, the credential input(s), an inline message, and the
/// Back/Skip/Continue row (OnboardingStepShell.tsx).
private struct OnboardingStepShell<Content: View>: View {
    let title: String
    let description: String
    let linkURL: URL?
    let linkLabel: String
    let onBack: (() -> Void)?
    let onSkip: () -> Void
    let onContinue: () -> Void
    let continueLabel: String
    var continueDisabled = false
    let busy: Bool
    var message: String?
    var messageKind: WebMessageKind?
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(title)
                .webText(22, 600)
                .foregroundStyle(AppTheme.textPrimary)
            Text(description)
                .webText(15.2, lineHeight: 22.8)
                .foregroundStyle(AppTheme.textMuted)
            if let linkURL {
                Link(destination: linkURL) {
                    Text(linkLabel)
                        .webText(14)
                        .foregroundStyle(AppTheme.primary)
                }
            }
            VStack(alignment: .leading, spacing: 16) { content }
            if let message, !message.isEmpty {
                Text(message)
                    .webText(13)
                    .foregroundStyle(messageKind == .error ? AppTheme.error : AppTheme.success)
            }
            // The footer's first flex item is an empty span without Back, so its row gap stays.
            VStack(alignment: .leading, spacing: 12) {
                if let onBack {
                    PillButton(label: L("onboarding.back"), icon: "alt-arrow-left", style: .secondary, disabled: busy, action: onBack)
                } else {
                    Color.clear.frame(height: 0)
                }
                FlowLayout(spacing: 12) {
                    PillButton(label: L("onboarding.skipStep"), style: .secondary, disabled: busy, action: onSkip)
                    PillButton(label: continueLabel, icon: "alt-arrow-right", disabled: busy || continueDisabled, action: onContinue)
                }
            }
            .padding(.top, 8)
        }
    }
}

private func continueLabel(isLastStep: Bool) -> String {
    isLastStep ? L("onboarding.finish") : L("onboarding.saveAndContinue")
}

private struct StepLlmApiKey: View {
    @EnvironmentObject var auth: AuthStore
    @ObservedObject private var catalog = ProviderCatalog.shared

    let onBack: (() -> Void)?
    let onNext: () -> Void
    let isLastStep: Bool
    let finishing: Bool

    private static let setupURLs = [
        "openai": "https://platform.openai.com/api-keys",
        "anthropic": "https://console.anthropic.com/settings/keys"
    ]
    private static let defaultSetupURL = "https://platform.openai.com/api-keys"

    @State private var vendor = ""
    @State private var keyInput = ""
    @State private var busy = false
    @State private var message: String?
    @State private var messageKind: WebMessageKind?

    private var alreadyConfigured: Bool { auth.aiVendorAPIKeyStatusList.contains(where: \.isValid) }

    private var vendorOptions: [InputSelectWithHint.Option] {
        catalog.providers.isEmpty
            ? [AIVendor.openai, .claude, .gemini].map { .init(value: $0.rawValue, label: catalog.displayName(for: $0.rawValue)) }
            : catalog.providers.map { .init(value: ProviderCatalog.storedVendorId(catalogId: $0.id), label: $0.displayName) }
    }

    private var setupURL: URL? {
        let id = ProviderCatalog.catalogId(forStored: vendor)
        return URL(string: Self.setupURLs[id] ?? Self.defaultSetupURL)
    }

    private var hasKey: Bool { !keyInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    var body: some View {
        OnboardingStepShell(
            title: L("onboarding.llm.title"),
            description: L("onboarding.llm.description"),
            linkURL: setupURL,
            linkLabel: L("onboarding.llm.linkLabel"),
            onBack: onBack,
            onSkip: onNext,
            onContinue: { Task { await save() } },
            continueLabel: continueLabel(isLastStep: isLastStep),
            continueDisabled: hasKey && vendor.isEmpty,
            busy: busy || finishing,
            message: alreadyConfigured ? L("onboarding.alreadyConfigured") : message,
            messageKind: alreadyConfigured ? .success : messageKind
        ) {
            InputSelectWithHint(hint: L("onboarding.llm.vendorHint"), value: vendor, options: vendorOptions, onChange: { vendor = $0 })
            InputTextWithHint(
                hint: L("onboarding.llm.keyHint"),
                placeholder: alreadyConfigured ? L("settingsPage.aiSettings.overwriteApiKey") : L("onboarding.llm.keyPlaceholder"),
                text: $keyInput,
                isSecure: true,
                disabled: busy
            )
        }
    }

    private func save() async {
        let key = keyInput.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !key.isEmpty else {
            onNext()
            return
        }
        guard !vendor.isEmpty else {
            message = L("onboarding.llm.pickVendorError")
            messageKind = .error
            return
        }
        busy = true
        message = nil
        defer { busy = false }
        do {
            let token = try await auth.getAccessTokenSilently()
            let response = try await StoreConfigService.storeVendorApiKey(token: token, aiVendor: vendor, apiKey: key)
            if response.apiKeyStatus.updateSuccessful == true {
                auth.updateVendorApiKeyStatus(response.apiKeyStatus)
                onNext()
            } else {
                message = response.apiKeyStatus.detail ?? response.apiKeyStatus.status
                messageKind = .error
            }
        } catch {
            message = error.localizedDescription.isEmpty ? L("onboarding.genericSaveError") : error.localizedDescription
            messageKind = .error
        }
    }
}

private struct StepZillizConfig: View {
    @EnvironmentObject var auth: AuthStore

    let onBack: (() -> Void)?
    let onNext: () -> Void
    let isLastStep: Bool
    let finishing: Bool

    @State private var endpoint = ""
    @State private var token = ""
    @State private var busy = false
    @State private var message: String?
    @State private var messageKind: WebMessageKind?

    private var alreadyConfigured: Bool {
        auth.vectorDBConfigStatusList.contains { $0.vendor == "Zilliz" && $0.status == "PRESENT" }
    }

    var body: some View {
        OnboardingStepShell(
            title: L("onboarding.zilliz.title"),
            description: L("onboarding.zilliz.description"),
            linkURL: URL(string: "https://cloud.zilliz.com"),
            linkLabel: L("onboarding.zilliz.linkLabel"),
            onBack: onBack,
            onSkip: onNext,
            onContinue: { Task { await save() } },
            continueLabel: continueLabel(isLastStep: isLastStep),
            busy: busy || finishing,
            message: alreadyConfigured ? L("onboarding.alreadyConfigured") : message,
            messageKind: alreadyConfigured ? .success : messageKind
        ) {
            InputTextWithHint(
                hint: L("dbSettings.databaseConnectionsSettingsWidget.endpointHint"),
                placeholder: L("dbSettings.databaseConnectionsSettingsWidget.zillizEndpointPlaceholder"),
                text: $endpoint,
                disabled: busy
            )
            InputTextWithHint(
                hint: L("dbSettings.databaseConnectionsSettingsWidget.tokenHint"),
                placeholder: L("dbSettings.databaseConnectionsSettingsWidget.zillizTokenPlaceholder"),
                text: $token,
                isSecure: true,
                disabled: busy
            )
        }
    }

    private func save() async {
        let endpointValue = endpoint.trimmingCharacters(in: .whitespacesAndNewlines)
        let tokenValue = token.trimmingCharacters(in: .whitespacesAndNewlines)
        if endpointValue.isEmpty, tokenValue.isEmpty {
            onNext()
            return
        }
        guard ZillizValidation.isValidEndpoint(endpointValue) else {
            message = L("onboarding.zilliz.invalidEndpoint")
            messageKind = .error
            return
        }
        guard ZillizValidation.isValidToken(tokenValue) else {
            message = L("onboarding.zilliz.invalidToken")
            messageKind = .error
            return
        }
        busy = true
        message = nil
        defer { busy = false }
        do {
            let accessToken = try await auth.getAccessTokenSilently()
            let response = try await StoreConfigService.storeVectorDBConfig(
                token: accessToken,
                request: StoreCustomerVectorDBConfigRequest(vendor: "Zilliz", endpoint: endpointValue, token: tokenValue)
            )
            if response.configStatus.updateSuccessful == true {
                auth.updateVectorDBConfigStatus(response.configStatus)
                onNext()
            } else {
                message = L("onboarding.genericSaveError")
                messageKind = .error
            }
        } catch {
            message = error.localizedDescription.isEmpty ? L("onboarding.genericSaveError") : error.localizedDescription
            messageKind = .error
        }
    }
}

private struct StepVoyageApiKey: View {
    @EnvironmentObject var auth: AuthStore

    let onBack: (() -> Void)?
    let onNext: () -> Void
    let isLastStep: Bool
    let finishing: Bool

    @State private var keyInput = ""
    @State private var hfTokenInput = ""
    @State private var alreadyConfigured = false
    @State private var busy = false
    @State private var message: String?
    @State private var messageKind: WebMessageKind?

    var body: some View {
        OnboardingStepShell(
            title: L("onboarding.voyage.title"),
            description: L("onboarding.voyage.description"),
            linkURL: URL(string: "https://dash.voyageai.com/api-keys"),
            linkLabel: L("onboarding.voyage.linkLabel"),
            onBack: onBack,
            onSkip: onNext,
            onContinue: { Task { await save() } },
            continueLabel: continueLabel(isLastStep: isLastStep),
            busy: busy || finishing,
            message: alreadyConfigured ? L("onboarding.alreadyConfigured") : message,
            messageKind: alreadyConfigured ? .success : messageKind
        ) {
            InputTextWithHint(
                hint: L("settingsPage.embeddingKeysSettings.voyageLabel"),
                placeholder: alreadyConfigured ? L("settingsPage.aiSettings.overwriteApiKey") : L("onboarding.voyage.keyPlaceholder"),
                text: $keyInput,
                isSecure: true,
                disabled: busy
            )
            Text(L("onboarding.voyage.hfTokenNote"))
                .webText(15.2, lineHeight: 22.8)
                .foregroundStyle(AppTheme.textMuted)
            InputTextWithHint(
                hint: L("onboarding.voyage.hfTokenHint"),
                placeholder: L("onboarding.voyage.hfTokenPlaceholder"),
                text: $hfTokenInput,
                isSecure: true,
                disabled: busy
            )
        }
        .task {
            guard let token = try? await auth.getAccessTokenSilently(),
                  let statuses = try? await EmbeddingService.getKeys(token: token) else { return }
            alreadyConfigured = statuses.first { $0.vendor == EmbeddingVendor.voyage }?.isSet == true
        }
    }

    private func fail(_ status: EmbeddingKeyStatus) {
        message = status.detail ?? status.status
        messageKind = .error
    }

    private func save() async {
        let key = keyInput.trimmingCharacters(in: .whitespacesAndNewlines)
        let hfToken = hfTokenInput.trimmingCharacters(in: .whitespacesAndNewlines)
        if key.isEmpty, hfToken.isEmpty {
            onNext()
            return
        }
        busy = true
        message = nil
        defer { busy = false }
        do {
            let token = try await auth.getAccessTokenSilently()
            if !key.isEmpty {
                let status = try await EmbeddingService.storeKey(token: token, vendor: EmbeddingVendor.voyage, apiKey: key)
                guard status.updateSuccessful == true else { return fail(status) }
            }
            if !hfToken.isEmpty {
                let status = try await EmbeddingService.storeKey(token: token, vendor: EmbeddingVendor.huggingFace, apiKey: hfToken)
                guard status.updateSuccessful == true else { return fail(status) }
            }
            onNext()
        } catch {
            message = error.localizedDescription.isEmpty ? L("onboarding.genericSaveError") : error.localizedDescription
            messageKind = .error
        }
    }
}

private struct StepTavilyApiKey: View {
    @EnvironmentObject var auth: AuthStore

    let onBack: (() -> Void)?
    let onNext: () -> Void
    let isLastStep: Bool
    let finishing: Bool

    @State private var keyInput = ""
    @State private var alreadyConfigured = false
    @State private var busy = false
    @State private var message: String?
    @State private var messageKind: WebMessageKind?

    var body: some View {
        OnboardingStepShell(
            title: L("onboarding.tavily.title"),
            description: L("onboarding.tavily.description"),
            linkURL: URL(string: "https://app.tavily.com"),
            linkLabel: L("onboarding.tavily.linkLabel"),
            onBack: onBack,
            onSkip: onNext,
            onContinue: { Task { await save() } },
            continueLabel: continueLabel(isLastStep: isLastStep),
            busy: busy || finishing,
            message: alreadyConfigured ? L("onboarding.alreadyConfigured") : message,
            messageKind: alreadyConfigured ? .success : messageKind
        ) {
            InputTextWithHint(
                hint: L("settingsPage.toolsSettings.builtInKeyHint"),
                placeholder: alreadyConfigured ? L("settingsPage.toolsSettings.builtInKeyReplacePlaceholder") : L("settingsPage.toolsSettings.builtInKeyPlaceholder"),
                text: $keyInput,
                isSecure: true,
                disabled: busy
            )
        }
        .task {
            guard let token = try? await auth.getAccessTokenSilently(),
                  let statuses = try? await ToolsService.getCredentialStatuses(token: token) else { return }
            alreadyConfigured = statuses.first { $0.toolType == "WEB_SEARCH" }?.connected == true
        }
    }

    private func save() async {
        let key = keyInput.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !key.isEmpty else {
            onNext()
            return
        }
        busy = true
        message = nil
        defer { busy = false }
        do {
            let token = try await auth.getAccessTokenSilently()
            try await ToolsService.storeCredentials(token: token, request: StoreToolCredentialsRequest(toolType: "WEB_SEARCH", authType: "api_key", credentials: ["api_key": key]))
            onNext()
        } catch {
            message = error.localizedDescription.isEmpty ? L("onboarding.genericSaveError") : error.localizedDescription
            messageKind = .error
        }
    }
}
