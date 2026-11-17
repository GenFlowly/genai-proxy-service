import SwiftUI

// MARK: - The one embedding model (utils/embeddingModel.ts)

enum EmbeddingModelChoice {
    /// In use until the customer chooses one. Must match EmbeddingConstants.MODEL_NAME in the proxy server.
    static let platformDefault = "voyage-4-large"

    /// The chosen model, read the way the server locks it: conversations, the single field, then notes.
    static func chosen(_ preferences: AIConfigPreferences?) -> String? {
        [preferences?.embeddingModelConversations, preferences?.embeddingModel, preferences?.embeddingModelNotes]
            .compactMap { $0?.trimmingCharacters(in: .whitespaces) }
            .first { !$0.isEmpty }
    }

    /// voyage-* is Voyage, text-embedding-* OpenAI.
    static func vendor(_ model: String?) -> String? {
        guard let model else { return nil }
        if model.hasPrefix("voyage") { return EmbeddingVendor.voyage }
        if model.hasPrefix("text-embedding") { return EmbeddingVendor.openAI }
        return nil
    }

    /// A locked model the server lets the customer replace: no known vendor owns its name, or its
    /// vendor's working key no longer lists it. A vendor missing from the list keeps the lock.
    static func isUnusable(_ model: String, vendorModels: [EmbeddingVendorModels]) -> Bool {
        guard let vendor = vendor(model) else { return true }
        guard let listed = vendorModels.first(where: { $0.vendor == vendor }) else { return false }
        return !listed.models.contains(model)
    }

    static func vendorLabel(_ vendor: String) -> String {
        vendor == EmbeddingVendor.voyage ? L("settingsPage.embeddingDefaults.voyageLabel") : ProviderCatalog.shared.displayName(for: vendor)
    }
}

// MARK: - Defaults › Memory (LearnedFactsSettings.tsx)

/// Whether the assistant learns facts from chats and uses them in replies. A switch is on until
/// the user turns it off (unset means on, as on the server) and saves as soon as it changes;
/// after a failed save it falls back. Deleting facts lives on Profile › Delete your data.
struct MemorySettingsView: View {
    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var router: AppRouter
    @EnvironmentObject var toasts: ToastCenter

    enum Switch: CaseIterable {
        case learnFromChats, useInReplies

        var label: String {
            switch self {
            case .learnFromChats: return L("settingsPage.learnedFacts.fromChats")
            case .useInReplies: return L("settingsPage.learnedFacts.useInReplies")
            }
        }

        var identifier: String {
            switch self {
            case .learnFromChats: return "learned-facts-memoryLearnFromChats"
            case .useInReplies: return "learned-facts-memoryUseInReplies"
            }
        }

        func stored(in preferences: AIConfigPreferences?) -> Bool? {
            switch self {
            case .learnFromChats: return preferences?.memoryLearnFromChats
            case .useInReplies: return preferences?.memoryUseInReplies
            }
        }
    }

    @State private var pending: [Switch: Bool] = [:]

    static func isOn(_ key: Switch, preferences: AIConfigPreferences?, pending: [Switch: Bool]) -> Bool {
        pending[key] ?? (key.stored(in: preferences) != false)
    }

    var body: some View {
        let learning = Self.isOn(.learnFromChats, preferences: auth.aiConfigPreferences, pending: pending)
        SettingsCard(title: L("settingsPage.deleteData.factsCard"), icon: "brain") {
            ForEach(Array(Switch.allCases.enumerated()), id: \.element) { index, key in
                ToggleRow(
                    label: key.label,
                    isOn: Self.isOn(key, preferences: auth.aiConfigPreferences, pending: pending),
                    disabled: pending[key] != nil,
                    separated: index > 0,
                    identifier: key.identifier
                ) { checked in Task { await toggle(key, checked) } }
            }
            SettingsRow(label: L("settingsPage.memoryDefaults.listedNote"), mutedLabel: true, stack: false, separated: true) {
                SettingsLink(text: L("settingsPage.memoryDefaults.openMemory")) { router.navigate(.memory) }
            }
        }
        .settingsPage(
            status: learning ? L("settingsPage.memoryDefaults.learningOn") : L("settingsPage.memoryDefaults.learningOff"),
            knowledge: [
                KnowledgeItem(title: L("settingsPage.memoryDefaults.learnsTitle"), text: L("settingsPage.memoryDefaults.learnsText")),
                KnowledgeItem(title: L("settingsPage.memoryDefaults.runsTitle"), text: L("settingsPage.memoryDefaults.runsText")),
                KnowledgeItem(title: L("settingsPage.memoryDefaults.goesTitle"), text: L("settingsPage.memoryDefaults.goesText"))
            ]
        )
    }

    private func toggle(_ key: Switch, _ checked: Bool) async {
        guard auth.isAuthenticated else {
            toasts.showToast(L("settingsPage.learnedFacts.loginFirstToast"))
            return
        }
        pending[key] = checked
        defer { pending[key] = nil }
        do {
            let token = try await auth.getAccessTokenSilently()
            switch key {
            case .learnFromChats:
                try await SaveAIConfigService.savePreferences(token: token, memoryLearnFromChats: checked)
                auth.mergePreferences(memoryLearnFromChats: checked)
            case .useInReplies:
                try await SaveAIConfigService.savePreferences(token: token, memoryUseInReplies: checked)
                auth.mergePreferences(memoryUseInReplies: checked)
            }
        } catch {
            let message = error.localizedDescription
            toasts.showToast(message.isEmpty ? L("settingsPage.learnedFacts.saveErrorToast") : message)
        }
    }
}

// MARK: - Defaults › Search index (ChatIndexingSettings.tsx)

/// Whether new chats are saved for search. Off until the user turns it on (unset means off, as on
/// the server). Own-key customers see what indexing needs; deleting lives on Delete your data.
struct SearchIndexSettingsView: View {
    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var router: AppRouter
    @EnvironmentObject var toasts: ToastCenter

    @State private var saving: Bool?
    @State private var keyStatuses: [EmbeddingKeyStatus]?

    private var isOn: Bool { saving ?? (auth.aiConfigPreferences?.indexChats == true) }

    private var databaseReady: Bool {
        auth.vectorDBConfigStatusList.contains { $0.status == "PRESENT" }
    }

    private var searchKeyReady: Bool? {
        keyStatuses.map { statuses in
            [EmbeddingVendor.openAI, EmbeddingVendor.voyage].contains { vendor in
                statuses.first { $0.vendor == vendor }.map { $0.isAPIKeyValid || $0.status == APIKeyStatus.valid } ?? false
            }
        }
    }

    var body: some View {
        let model = EmbeddingModelChoice.chosen(auth.aiConfigPreferences)
        SettingsCard(title: L("settingsPage.searchIndex.card")) {
            ToggleRow(
                label: L("settingsPage.chatIndexing.indexChats"),
                isOn: isOn,
                disabled: saving != nil,
                identifier: "chat-indexing-switch"
            ) { checked in Task { await toggle(checked) } }
            if auth.hasOwnKeys {
                SettingsRow(label: L("settingsPage.searchIndex.needsTitle"), stack: false, separated: true) {
                    if !databaseReady || searchKeyReady == false {
                        SettingsLink(text: L("settingsPage.searchIndex.setUp")) {
                            router.navigate(.settings(databaseReady ? .embeddingKeys : .vectorDb))
                        }
                    }
                } extra: {
                    WrapRow(spacing: 6, lineSpacing: 6) {
                        StatusPill(kind: databaseReady ? .ok : .unset, text: L(databaseReady ? "settingsPage.searchIndex.databaseReady" : "settingsPage.searchIndex.databaseNotSet"))
                        if let searchKeyReady {
                            StatusPill(kind: searchKeyReady ? .ok : .unset, text: L(searchKeyReady ? "settingsPage.searchIndex.keyReady" : "settingsPage.searchIndex.keyNotSet"))
                        }
                    }
                    .padding(.top, 4)
                }
                .accessibilityIdentifier("search-index-requirements")
            }
            SettingsRow(
                label: L("settingsPage.searchIndex.modelRow"),
                description: model ?? L("settingsPage.searchIndex.platformDefault", ["model": EmbeddingModelChoice.platformDefault]),
                stack: false,
                separated: true
            ) {
                SettingsLink(text: model == nil ? L("settingsPage.searchIndex.modelChange") : L("settingsPage.searchIndex.modelDetails")) {
                    router.navigate(.settings(.embeddingModels))
                }
            }
        }
        .settingsPage(
            status: isOn ? L("settingsPage.searchIndex.on") : L("settingsPage.searchIndex.off"),
            knowledge: [KnowledgeItem(title: L("settingsPage.searchIndex.doesTitle"), text: L("settingsPage.searchIndex.doesText"))]
                + (auth.hasOwnKeys ? [KnowledgeItem(title: L("settingsPage.searchIndex.needsTitle"), text: L("settingsPage.searchIndex.needsText"))] : [])
        )
        .task(id: auth.hasOwnKeys) { await loadKeys() }
    }

    private func loadKeys() async {
        guard auth.hasOwnKeys, let token = try? await auth.getAccessTokenSilently() else { return }
        keyStatuses = try? await EmbeddingService.getKeys(token: token)
    }

    private func toggle(_ checked: Bool) async {
        guard auth.isAuthenticated else {
            toasts.showToast(L("settingsPage.chatIndexing.loginFirstToast"))
            return
        }
        saving = checked
        defer { saving = nil }
        do {
            let token = try await auth.getAccessTokenSilently()
            try await SaveAIConfigService.savePreferences(token: token, indexChats: checked)
            auth.mergePreferences(indexChats: checked)
        } catch {
            let message = error.localizedDescription
            toasts.showToast(message.isEmpty ? L("settingsPage.chatIndexing.saveErrorToast") : message)
        }
    }
}
