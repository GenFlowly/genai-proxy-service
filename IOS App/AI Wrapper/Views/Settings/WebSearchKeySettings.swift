import SwiftUI

// MARK: - BYOK › Web Search API Key (WebSearchToolSettings.tsx)

/// The Tavily key the built-in web_search tool runs on, and how many searches it may run per
/// message. The limit's name, bounds and default match the proxy's validation and the
/// retrieval-server's tool executor.
struct WebSearchKeySettingsView: View {
    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var router: AppRouter
    @EnvironmentObject var toasts: ToastCenter

    private static let toolType = "WEB_SEARCH"
    private static let authType = "api_key"
    private static let maxSearchesSetting = "max_searches_per_turn"

    @State private var status: ToolCredentialStatus?
    @State private var loaded = false
    @State private var keyInput = ""
    @State private var limitInput = "5"
    @State private var busy = false
    @State private var confirmRemove = false

    private var connected: Bool { status?.connected == true }
    private var storedLimit: Int { Self.parseLimit(status?.settings?[Self.maxSearchesSetting] ?? "") ?? 5 }
    private var limitValue: Int? { Self.parseLimit(limitInput) }

    static func parseLimit(_ raw: String) -> Int? {
        let trimmed = raw.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty, trimmed.allSatisfy(\.isNumber), let value = Int(trimmed), (1...20).contains(value) else { return nil }
        return value
    }

    var body: some View {
        let pillText = connected ? L("settingsPage.toolsSettings.builtInKeySetPill") : L("settingsPage.toolsSettings.builtInKeyNotSetPill")
        VStack(alignment: .leading, spacing: 12) {
            SettingsCard(title: L("settingsPage.toolsSettings.builtInWebSearchLabel")) {
                if loaded { StatusPill(kind: connected ? .ok : .unset, text: pillText) }
            } content: {
                VStack(spacing: 10) {
                    InputTextWithHint(
                        hint: L("settingsPage.toolsSettings.builtInKeyHint"),
                        placeholder: connected ? L("settingsPage.toolsSettings.builtInKeyReplacePlaceholder") : L("settingsPage.toolsSettings.builtInKeyPlaceholder"),
                        text: $keyInput,
                        isSecure: true,
                        disabled: busy,
                        stacked: true
                    )
                    .accessibilityIdentifier("web-search-credential-key-input")
                    PillButton(
                        label: busy ? L("settingsPage.toolsSettings.savingLabel") : L("settingsPage.toolsSettings.builtInSaveKey"),
                        icon: "save-icon",
                        size: .lg,
                        disabled: busy || keyInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                        fullWidth: true
                    ) { Task { await saveKey() } }
                    .accessibilityIdentifier("web-search-credential-save")
                    if connected {
                        PillButton(label: L("settingsPage.toolsSettings.builtInRemoveKey"), style: .secondary, size: .lg, disabled: busy, fullWidth: true) {
                            confirmRemove = true
                        }
                        .accessibilityIdentifier("web-search-credential-remove")
                    }
                }
            }
            .accessibilityIdentifier("web-search-credential")

            SettingsCard(title: L("settingsPage.toolsSettings.builtInSearchLimitHint"), hint: L("settingsPage.webSearchKey.limitRange")) {
                VStack(spacing: 10) {
                    InputTextWithHint(
                        hint: L("settingsPage.toolsSettings.builtInSearchLimitHint"),
                        text: $limitInput,
                        disabled: busy,
                        keyboard: .numberPad,
                        stacked: true
                    )
                    .accessibilityIdentifier("web-search-limit-input")
                    PillButton(
                        label: busy ? L("settingsPage.toolsSettings.savingLabel") : L("settingsPage.toolsSettings.builtInSearchLimitSave"),
                        icon: "save-icon",
                        size: .lg,
                        disabled: busy || limitValue == nil || limitValue == storedLimit,
                        fullWidth: true
                    ) { Task { await saveLimit() } }
                    .accessibilityIdentifier("web-search-limit-save")
                }
            }

            SettingsCard(title: L("settingsPage.webSearchKey.related")) {
                SettingsRow(label: L("settingsPage.webSearchKey.usageLink"), stack: false) {
                    SettingsLink(text: L("settingsPage.nav.usage")) { router.navigate(.settings(.usageWebSearch)) }
                }
            }
        }
        .settingsPage(
            status: loaded ? pillText : nil,
            knowledge: [
                KnowledgeItem(title: L("settingsPage.webSearchKey.forTitle"), text: L("settingsPage.webSearchKey.forText")),
                KnowledgeItem(title: L("settingsPage.webSearchKey.usageTitle"), text: L("settingsPage.webSearchKey.usageText")),
                KnowledgeItem(title: L("settingsPage.webSearchKey.whereTitle"), text: L("settingsPage.webSearchKey.whereText"))
            ]
        )
        .settingsDialog(isPresented: confirmRemove) {
                SettingsConfirmDialog(
                    title: L("settingsPage.webSearchKey.removeTitle"),
                    confirmLabel: L("settingsPage.toolsSettings.builtInRemoveKey"),
                    busy: busy,
                    identifier: "web-search-credential-remove",
                    onClose: { confirmRemove = false },
                    onConfirm: { Task { await remove() } }
                ) {
                    SettingsDialogText(text: L("settingsPage.toolsSettings.builtInRemoveConfirm"))
                }
        }
        .task { await load() }
        .onChange(of: storedLimit) { _, value in limitInput = String(value) }
    }

    private func errorText(_ error: Error) -> String {
        let text = error.localizedDescription
        return text.isEmpty ? L("settingsPage.toolsSettings.builtInGenericError") : text
    }

    private func load() async {
        defer { loaded = true }
        do {
            let token = try await auth.getAccessTokenSilently()
            status = try await ToolsService.getCredentialStatuses(token: token).first { $0.toolType == Self.toolType }
            limitInput = String(storedLimit)
        } catch {
            toasts.showToast(errorText(error))
        }
    }

    private func store(_ request: StoreToolCredentialsRequest, done: String) async -> Bool {
        busy = true
        defer { busy = false }
        do {
            let token = try await auth.getAccessTokenSilently()
            _ = try await ToolsService.storeCredentials(token: token, request: request)
            toasts.showToast(done)
            await load()
            return true
        } catch {
            toasts.showToast(errorText(error))
            return false
        }
    }

    private func saveKey() async {
        let key = keyInput.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !key.isEmpty else {
            toasts.showToast(L("settingsPage.toolsSettings.builtInKeyEmptyToast"))
            return
        }
        let request = StoreToolCredentialsRequest(toolType: Self.toolType, authType: Self.authType, credentials: ["api_key": key])
        if await store(request, done: L("settingsPage.toolsSettings.builtInKeySavedToast")) { keyInput = "" }
    }

    private func saveLimit() async {
        guard let limitValue else {
            toasts.showToast(L("settingsPage.toolsSettings.builtInSearchLimitInvalidToast"))
            return
        }
        // Settings only: the stored key is left untouched.
        let request = StoreToolCredentialsRequest(toolType: Self.toolType, authType: Self.authType, settings: [Self.maxSearchesSetting: String(limitValue)])
        _ = await store(request, done: L("settingsPage.toolsSettings.builtInSearchLimitSavedToast"))
    }

    private func remove() async {
        busy = true
        defer { busy = false }
        do {
            let token = try await auth.getAccessTokenSilently()
            try await ToolsService.deleteCredentials(token: token, toolType: Self.toolType)
            toasts.showToast(L("settingsPage.toolsSettings.builtInKeyRemovedToast"))
            confirmRemove = false
            await load()
        } catch {
            toasts.showToast(errorText(error))
        }
    }
}
