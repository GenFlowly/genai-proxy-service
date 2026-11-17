import SwiftUI

// MARK: - VendorApiKeysManager (component library)

struct VendorKeyRowData: Identifiable, Equatable {
    let vendor: String
    let label: String
    /// Brand names render 18/500, plain labels the card's 18/600.
    var labelWeight: CGFloat = 500
    let keySet: Bool
    var savedThinkingLevel: String = ""
    var savedModel: String?
    var savedPriority: Int?
    var models: [String] = []
    /// More status after the key pill, e.g. "Used by your embedding model".
    var extraPill: String?
    /// A short note at the end of the card header, e.g. "Optional".
    var hint: String?
    /// This vendor's empty-field placeholder (e.g. "pa-…"), in place of the manager's.
    var keyPlaceholder: String?
    var id: String { vendor }
}

struct VendorKeySaveResult {
    let success: Bool
    var message: String?

    init(success: Bool, message: String? = nil) {
        self.success = success
        self.message = message
    }

    /// The provider's own rejection beats the generic status, unless it's empty.
    init(success: Bool, detail: String?, status: String?) {
        self.init(success: success, message: detail?.isEmpty == false ? detail : status)
    }
}

/// Per-vendor key cards: store/replace (optionally remove) a key and, once one is set,
/// pick the model, reasoning effort and failover priority for that vendor.
struct VendorApiKeysManager: View {
    let rows: [VendorKeyRowData]
    let keyPlaceholder: String
    var keyHint = L("settingsPage.aiSettings.apiKeyHint")
    var keyReplacePlaceholder = L("settingsPage.llmKeys.replaceKey")
    /// The pill for a stored priority; the main provider's says so.
    var priorityPill: (Int) -> String = { L("library.vendorApiKeys.priorityPill", ["priority": $0]) }
    var removeKeyLabel: String?
    var keyRemovedMessage: String?
    let onSaveKey: (String, String) async throws -> VendorKeySaveResult
    var onDeleteKey: ((String) async throws -> Void)?
    var onSaveConfig: ((String, String, Int, String) async throws -> Void)?

    private struct RowState {
        var keyInput = ""
        var busy = false
        var message: String?
        var messageKind: WebMessageKind?
        var selectedModel = ""
        var priority = ""
        var thinkingLevel = ""
        var savingConfig = false
    }

    @State private var rowStates: [String: RowState] = [:]

    private func state(_ vendor: String) -> RowState { rowStates[vendor] ?? RowState() }

    private func update(_ vendor: String, _ change: (inout RowState) -> Void) {
        var next = state(vendor)
        change(&next)
        rowStates[vendor] = next
    }

    private func binding<T>(_ vendor: String, _ keyPath: WritableKeyPath<RowState, T>) -> Binding<T> {
        Binding(get: { state(vendor)[keyPath: keyPath] }, set: { value in update(vendor) { $0[keyPath: keyPath] = value } })
    }

    var body: some View {
        VStack(spacing: 14) {
            ForEach(rows) { row in
                card(row)
            }
        }
        .onAppear(perform: seed)
        .onChange(of: rows) { _, _ in seed() }
    }

    /// Seed the dropdowns with the stored config without clobbering edits.
    private func seed() {
        for row in rows {
            update(row.vendor) { current in
                if current.selectedModel.isEmpty { current.selectedModel = row.savedModel ?? "" }
                if current.priority.isEmpty { current.priority = row.savedPriority.map(String.init) ?? "" }
                if current.thinkingLevel.isEmpty { current.thinkingLevel = row.savedThinkingLevel }
            }
        }
    }

    private func card(_ row: VendorKeyRowData) -> some View {
        let current = state(row.vendor)
        return CredentialCard(title: row.label, hint: row.hint, message: current.message, messageKind: current.messageKind) {
            CredentialStatusPill(
                kind: row.keySet ? .ok : .unset,
                text: row.keySet ? L("settingsPage.aiSettings.keySetPill") : L("settingsPage.aiSettings.keyNotSetPill")
            )
            if row.keySet, let priority = row.savedPriority {
                CredentialStatusPill(kind: .neutral, text: priorityPill(priority))
            }
            if let extraPill = row.extraPill {
                CredentialStatusPill(kind: .neutral, text: extraPill)
            }
        } content: {
            VStack(alignment: .leading, spacing: 12) {
                InputTextWithHint(
                    hint: keyHint,
                    placeholder: row.keySet ? keyReplacePlaceholder : (row.keyPlaceholder ?? keyPlaceholder),
                    text: binding(row.vendor, \.keyInput),
                    isSecure: true,
                    disabled: current.busy,
                    stacked: true
                )
                .accessibilityIdentifier("vendor-key-input-\(row.vendor)")
                PillButton(
                    label: current.busy ? L("settingsPage.aiSettings.savingLabel") : L("settingsPage.aiSettings.save"),
                    size: .lg,
                    disabled: current.busy || current.keyInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                    fullWidth: true
                ) {
                    Task { await saveKey(row.vendor) }
                }
                if row.keySet, onDeleteKey != nil {
                    PillButton(label: removeKeyLabel ?? L("library.vendorApiKeys.removeKey"), style: .danger, size: .lg, disabled: current.busy, fullWidth: true) {
                        Task { await deleteKey(row.vendor) }
                    }
                }
            }

            if row.keySet, onSaveConfig != nil {
                configRow(row, current)
            }
        }
        .accessibilityIdentifier("vendor-key-card-\(row.vendor)")
    }

    private func configRow(_ row: VendorKeyRowData, _ current: RowState) -> some View {
        let dirty = current.selectedModel != (row.savedModel ?? "")
            || current.priority != (row.savedPriority.map(String.init) ?? "")
            || current.thinkingLevel != row.savedThinkingLevel
        // A stored model stays visible even if it's missing from the fetched list.
        let modelOptions = (!current.selectedModel.isEmpty && !row.models.contains(current.selectedModel) ? [current.selectedModel] : [])
            + row.models
        return VStack(alignment: .leading, spacing: 12) {
            InputSelectWithHint(
                hint: L("settingsPage.aiSettings.configModelHint"),
                placeholder: L("settingsPage.aiSettings.configModelPlaceholder"),
                value: current.selectedModel,
                options: modelOptions.map { .init(value: $0, label: $0) },
                stacked: true,
                onChange: { value in update(row.vendor) { $0.selectedModel = value } }
            )
            InputSelectWithHint(
                hint: L("library.vendorApiKeys.reasoningHint"),
                placeholder: L("library.vendorApiKeys.reasoningDefault"),
                value: current.thinkingLevel,
                options: [
                    .init(value: "", label: L("library.vendorApiKeys.reasoningDefault")),
                    .init(value: "none", label: L("library.vendorApiKeys.reasoningNone")),
                    .init(value: "low", label: L("library.vendorApiKeys.reasoningLow")),
                    .init(value: "medium", label: L("library.vendorApiKeys.reasoningMedium")),
                    .init(value: "high", label: L("library.vendorApiKeys.reasoningHigh"))
                ],
                stacked: true,
                onChange: { value in update(row.vendor) { $0.thinkingLevel = value } }
            )
            InputSelectWithHint(
                hint: L("settingsPage.llmKeys.priorityHint"),
                placeholder: "—",
                value: current.priority,
                options: rows.indices.map { .init(value: String($0 + 1), label: String($0 + 1)) },
                stacked: true,
                onChange: { value in update(row.vendor) { $0.priority = value } }
            )
            PillButton(
                label: current.savingConfig ? L("settingsPage.aiSettings.savingLabel") : L("settingsPage.llmKeys.savePreference"),
                size: .lg,
                disabled: current.savingConfig || current.selectedModel.isEmpty || current.priority.isEmpty || !dirty,
                fullWidth: true
            ) {
                Task { await saveConfig(row.vendor) }
            }
        }
    }

    private func errorText(_ error: Error) -> String {
        let text = error.localizedDescription
        return text.isEmpty ? L("library.vendorApiKeys.genericError") : text
    }

    private func saveKey(_ vendor: String) async {
        let key = state(vendor).keyInput.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !key.isEmpty else {
            update(vendor) {
                $0.message = L("settingsPage.aiSettings.enterValidApiKeyToast")
                $0.messageKind = .error
            }
            return
        }
        update(vendor) {
            $0.busy = true
            $0.message = nil
            $0.messageKind = nil
        }
        do {
            let result = try await onSaveKey(vendor, key)
            update(vendor) {
                $0.busy = false
                if result.success {
                    $0.keyInput = ""
                    $0.message = result.message ?? L("library.vendorApiKeys.keySaved")
                    $0.messageKind = .success
                } else {
                    $0.message = result.message ?? L("library.vendorApiKeys.keyRejected")
                    $0.messageKind = .error
                }
            }
        } catch {
            update(vendor) {
                $0.busy = false
                $0.message = errorText(error)
                $0.messageKind = .error
            }
        }
    }

    private func deleteKey(_ vendor: String) async {
        guard let onDeleteKey else { return }
        update(vendor) {
            $0.busy = true
            $0.message = nil
            $0.messageKind = nil
        }
        do {
            try await onDeleteKey(vendor)
            update(vendor) {
                $0.busy = false
                $0.message = keyRemovedMessage ?? L("library.vendorApiKeys.keyRemoved")
                $0.messageKind = .success
                $0.selectedModel = ""
                $0.priority = ""
                $0.thinkingLevel = ""
            }
        } catch {
            update(vendor) {
                $0.busy = false
                $0.message = errorText(error)
                $0.messageKind = .error
            }
        }
    }

    private func saveConfig(_ vendor: String) async {
        guard let onSaveConfig else { return }
        let row = state(vendor)
        guard !row.selectedModel.isEmpty, let priority = Int(row.priority) else { return }
        update(vendor) {
            $0.savingConfig = true
            $0.message = nil
            $0.messageKind = nil
        }
        do {
            try await onSaveConfig(vendor, row.selectedModel, priority, row.thinkingLevel)
            update(vendor) {
                $0.savingConfig = false
                $0.message = L("settingsPage.aiSettings.configSavedToast")
                $0.messageKind = .success
            }
        } catch {
            update(vendor) {
                $0.savingConfig = false
                $0.message = errorText(error)
                $0.messageKind = .error
            }
        }
    }
}

// MARK: - LLM API keys (AISettings.tsx)

struct AISettingsView: View {
    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var ai: AIStore
    @ObservedObject private var catalog = ProviderCatalog.shared

    /// Vendors without a key stay hidden until picked from the add-vendor dropdown.
    @State private var revealedVendors: [String] = []

    /// The only vendors this page lists live. `/models` answers for others once AI Config
    /// asks, with image and voice models mixed in, so they keep the catalog's chat models,
    /// as does a live vendor while its list is empty (a key was only just saved).
    private static let liveModelVendors: [AIVendor] = [.openai, .claude, .gemini]

    static func modelOptions(vendor: String, live: [AIVendor: [String]], catalog: ProviderInfo?) -> [String] {
        let id = AIVendor(rawValue: vendor)
        if liveModelVendors.contains(id), let models = live[id], !models.isEmpty { return models }
        return catalog?.models.map(\.name) ?? []
    }

    private var visibleVendors: [String] {
        let withKeys = auth.aiVendorAPIKeyStatusList.filter(\.isValid).map(\.aiVendor)
        return withKeys + revealedVendors.filter { !withKeys.contains($0) }
    }

    private var rows: [VendorKeyRowData] {
        visibleVendors.map { vendor in
            let status = auth.aiVendorAPIKeyStatusList.first { $0.aiVendor == vendor }
            let provider = catalog.providers.first { $0.id == ProviderCatalog.catalogId(forStored: vendor) }
            // preferredModels is the source of truth for the default model; the
            // vendor-config selectedModel is a legacy fallback.
            let preferred = auth.aiConfigPreferences?.preferredModels?.first { $0.aiVendor.rawValue == vendor }
            return VendorKeyRowData(
                vendor: vendor,
                label: catalog.displayName(for: vendor),
                keySet: status?.isValid == true,
                savedThinkingLevel: preferred?.thinkingLevel ?? status?.thinkingLevel ?? "",
                savedModel: preferred?.model ?? status?.selectedModel,
                savedPriority: status?.priority,
                models: Self.modelOptions(vendor: vendor, live: ai.modelsByVendor, catalog: provider)
            )
        }
    }

    private var addableOptions: [InputSelectWithHint.Option] {
        // Catalog still loading/failed: at least the legacy three are addable.
        let source: [InputSelectWithHint.Option] = catalog.providers.isEmpty
            ? [AIVendor.openai, .claude, .gemini].map { .init(value: $0.rawValue, label: catalog.displayName(for: $0.rawValue)) }
            : catalog.providers.map { .init(value: ProviderCatalog.storedVendorId(catalogId: $0.id), label: $0.displayName) }
        return source.filter { !visibleVendors.contains($0.value) }
    }

    var body: some View {
        let setCount = rows.filter(\.keySet).count
        VStack(alignment: .leading, spacing: 12) {
            VendorApiKeysManager(
                rows: rows,
                keyPlaceholder: L("settingsPage.llmKeys.enterKey"),
                priorityPill: { $0 == 1 ? L("settingsPage.llmKeys.priorityPrimary") : L("settingsPage.llmKeys.priorityPill", ["priority": $0]) },
                onSaveKey: saveKey,
                onSaveConfig: saveConfig
            )

            if !addableOptions.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    Text(L("settingsPage.aiSettings.addVendorLabel"))
                        .webText(13, 500)
                        .foregroundStyle(AppTheme.textSecondary)
                    InputSelectWithHint(
                        hint: L("settingsPage.aiSettings.addVendorHint"),
                        placeholder: L("settingsPage.aiSettings.addVendorPlaceholder"),
                        value: "",
                        options: addableOptions,
                        stacked: true,
                        onChange: { revealedVendors.append($0) }
                    )
                }
                .accessibilityIdentifier("add-vendor-select")
            }
        }
        .settingsPage(
            status: L("settingsPage.llmKeys.setCount", ["count": setCount]),
            knowledge: [
                KnowledgeItem(title: L("settingsPage.llmKeys.whichTitle"), text: L("settingsPage.llmKeys.whichText")),
                KnowledgeItem(title: L("settingsPage.llmKeys.priorityTitle"), text: L("settingsPage.llmKeys.priorityText")),
                KnowledgeItem(title: L("settingsPage.llmKeys.whereTitle"), text: L("settingsPage.llmKeys.whereText"))
            ]
        )
        .task {
            guard let token = try? await auth.getAccessTokenSilently() else { return }
            await catalog.load(token: token)
            await ai.fetchModels(token: token, vendors: Self.liveModelVendors)
        }
    }

    private func saveKey(_ vendor: String, _ apiKey: String) async throws -> VendorKeySaveResult {
        let token = try await auth.getAccessTokenSilently()
        let response = try await StoreConfigService.storeVendorApiKey(token: token, aiVendor: vendor, apiKey: apiKey)
        let success = response.apiKeyStatus.updateSuccessful == true
        if success {
            auth.updateVendorApiKeyStatus(response.apiKeyStatus)
            // The live lists are key-scoped, so a new key makes them stale.
            Task { await ai.fetchModels(token: token, vendors: Self.liveModelVendors) }
        }
        return VendorKeySaveResult(success: success, detail: response.apiKeyStatus.detail, status: response.apiKeyStatus.status)
    }

    private func saveConfig(_ vendor: String, _ model: String, _ priority: Int, _ thinkingLevel: String) async throws {
        let token = try await auth.getAccessTokenSilently()
        let level = thinkingLevel.isEmpty ? nil : thinkingLevel
        try await StoreConfigService.storeVendorConfig(
            token: token,
            request: StoreCustomerVendorConfigRequest(aiVendor: vendor, model: model, priority: priority, thinkingLevel: thinkingLevel)
        )
        // The server mirrors this into preferredModels; every surface reflects it now
        // rather than at the next /onboard sync.
        var preferred = auth.aiConfigPreferences?.preferredModels ?? []
        var entry = preferred.first { $0.aiVendor.rawValue == vendor } ?? AIConfig(aiVendor: AIVendor(rawValue: vendor), model: model)
        entry.model = model
        entry.thinkingLevel = level
        preferred.removeAll { $0.aiVendor.rawValue == vendor }
        preferred.append(entry)
        auth.mergePreferences(preferredModels: preferred)
        ai.applyVendorConfig(vendor: AIVendor(rawValue: vendor), model: model, thinkingLevel: level)
        if var status = auth.aiVendorAPIKeyStatusList.first(where: { $0.aiVendor == vendor }) {
            status.selectedModel = model
            status.priority = priority
            status.thinkingLevel = level
            auth.updateVendorApiKeyStatus(status)
        }
    }
}

// MARK: - Embedding model API keys (EmbeddingKeysSettings.tsx)

/// OpenAI shares its key with the LLM page; Voyage is embedding-only. The optional
/// Hugging Face token renders in its own manager: it's the only removable credential.
struct EmbeddingKeysSettingsView: View {
    @EnvironmentObject var auth: AuthStore
    @ObservedObject private var catalog = ProviderCatalog.shared

    @State private var statuses: [EmbeddingKeyStatus] = []

    private func isSet(_ vendor: String) -> Bool {
        statuses.first { $0.vendor == vendor }?.isSet == true
    }

    private func setStatus(_ status: EmbeddingKeyStatus) {
        statuses = statuses.filter { $0.vendor != status.vendor } + [status]
    }

    private func vendorLabel(_ vendor: String) -> String {
        switch vendor {
        case EmbeddingVendor.voyage: return L("settingsPage.embeddingKeysSettings.voyageLabel")
        case EmbeddingVendor.huggingFace: return L("settingsPage.embeddingKeysSettings.huggingFaceLabel")
        default: return "OpenAI"
        }
    }

    var body: some View {
        let chosenVendor = EmbeddingModelChoice.vendor(EmbeddingModelChoice.chosen(auth.aiConfigPreferences))
        let usedPill = { (vendor: String) in chosenVendor == vendor ? L("settingsPage.embeddingKeys.usedPill") : nil }
        let rows = [
            VendorKeyRowData(vendor: EmbeddingVendor.openAI, label: catalog.displayName(for: EmbeddingVendor.openAI), keySet: isSet(EmbeddingVendor.openAI), extraPill: usedPill(EmbeddingVendor.openAI), hint: L("settingsPage.embeddingKeys.sharedHint")),
            VendorKeyRowData(vendor: EmbeddingVendor.voyage, label: L("settingsPage.embeddingKeysSettings.voyageLabel"), keySet: isSet(EmbeddingVendor.voyage), extraPill: usedPill(EmbeddingVendor.voyage), keyPlaceholder: "pa-…")
        ]
        let setCount = rows.filter(\.keySet).count
        VStack(alignment: .leading, spacing: 12) {
            VendorApiKeysManager(rows: rows, keyPlaceholder: L("settingsPage.llmKeys.enterKey"), onSaveKey: saveKey)

            VendorApiKeysManager(
                rows: [
                    VendorKeyRowData(vendor: EmbeddingVendor.huggingFace, label: L("settingsPage.embeddingKeysSettings.huggingFaceLabel"), keySet: isSet(EmbeddingVendor.huggingFace), hint: L("settingsPage.embeddingKeys.optionalHint"))
                ],
                keyPlaceholder: "hf_…",
                keyHint: L("settingsPage.embeddingKeys.tokenHint"),
                removeKeyLabel: L("settingsPage.embeddingKeysSettings.removeKey"),
                keyRemovedMessage: L("settingsPage.embeddingKeysSettings.keyRemoved"),
                onSaveKey: saveKey,
                onDeleteKey: deleteKey
            )

            ForEach(statuses.filter { $0.detail?.isEmpty == false }) { status in
                Text("\(vendorLabel(status.vendor)): \(status.detail ?? "")")
                    .webText(13)
                    .foregroundStyle(AppTheme.textMuted)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityIdentifier("embedding-key-problem-\(status.vendor)")
            }
        }
        .settingsPage(
            status: L("settingsPage.llmKeys.setCount", ["count": setCount]),
            knowledge: [
                KnowledgeItem(title: L("settingsPage.embeddingKeys.whatTitle"), text: L("settingsPage.embeddingKeys.whatText")),
                KnowledgeItem(title: L("settingsPage.embeddingKeys.hfTitle"), text: L("settingsPage.embeddingKeys.hfText"))
            ]
        )
        .task {
            guard let token = try? await auth.getAccessTokenSilently() else { return }
            if let loaded = try? await EmbeddingService.getKeys(token: token) { statuses = loaded }
        }
    }

    private func saveKey(_ vendor: String, _ apiKey: String) async throws -> VendorKeySaveResult {
        let token = try await auth.getAccessTokenSilently()
        if vendor == EmbeddingVendor.openAI {
            // One OpenAI key for both pages. The embedding verdict lands asynchronously
            // (the server probes on save), so reflect the save result optimistically.
            let response = try await StoreConfigService.storeVendorApiKey(token: token, aiVendor: vendor, apiKey: apiKey)
            let success = response.apiKeyStatus.updateSuccessful == true
            if success {
                auth.updateVendorApiKeyStatus(response.apiKeyStatus)
                setStatus(EmbeddingKeyStatus(vendor: vendor, isAPIKeyValid: true, status: APIKeyStatus.valid))
            }
            return VendorKeySaveResult(success: success, detail: response.apiKeyStatus.detail, status: response.apiKeyStatus.status)
        }
        let status = try await EmbeddingService.storeKey(token: token, vendor: vendor, apiKey: apiKey)
        let success = status.updateSuccessful == true
        if success { setStatus(status) }
        return VendorKeySaveResult(success: success, detail: status.detail, status: status.status)
    }

    private func deleteKey(_ vendor: String) async throws {
        let token = try await auth.getAccessTokenSilently()
        try await EmbeddingService.deleteKey(token: token, vendor: vendor)
        setStatus(EmbeddingKeyStatus(vendor: vendor, isAPIKeyValid: false, status: APIKeyStatus.notSet))
    }
}

// MARK: - Vector DB connection (VectorDBSettings.tsx + DatabaseConnectionsSettingsWidget.tsx)

struct VectorDBSettingsView: View {
    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var toasts: ToastCenter

    @State private var endpoint = ""
    @State private var token = ""
    @State private var isSaving = false

    private var connected: Bool {
        auth.vectorDBConfigStatusList.contains { $0.vendor.lowercased() == "zilliz" && $0.status == "PRESENT" }
    }

    var body: some View {
        let statusText = connected ? L("settingsPage.vectorDb.connected") : L("settingsPage.vectorDb.notConnected")
        VStack(alignment: .leading, spacing: 12) {
            if connected {
                SettingsCard(title: L("dbSettings.databaseConnectionsSettingsWidget.milvusCloud")) {
                    StatusPill(kind: .ok, text: statusText)
                } content: {
                    SettingsRow(label: L("settingsPage.vectorDb.tokenRow"), description: L("settingsPage.vectorDb.tokenSaved"))
                }
                .accessibilityIdentifier("vector-db-connected")
            }
            CredentialCard(title: connected ? L("settingsPage.vectorDb.replaceCard") : L("dbSettings.databaseConnectionsSettingsWidget.milvusCloud")) {
                if !connected { StatusPill(kind: .unset, text: statusText) }
            } content: {
                VStack(spacing: 16) {
                    InputTextWithHint(
                        hint: L("dbSettings.databaseConnectionsSettingsWidget.endpointHint"),
                        placeholder: L("dbSettings.databaseConnectionsSettingsWidget.zillizEndpointPlaceholder"),
                        text: $endpoint,
                        stacked: true
                    )
                    InputTextWithHint(
                        hint: L("dbSettings.databaseConnectionsSettingsWidget.tokenHint"),
                        placeholder: L("dbSettings.databaseConnectionsSettingsWidget.zillizTokenPlaceholder"),
                        text: $token,
                        isSecure: true,
                        stacked: true
                    )
                }
                PillButton(
                    label: isSaving ? L("dbSettings.databaseConnectionsSettingsWidget.saving") : L("dbSettings.databaseConnectionsSettingsWidget.save"),
                    icon: "save-icon",
                    size: .lg,
                    disabled: isSaving || endpoint.trimmingCharacters(in: .whitespaces).isEmpty || token.trimmingCharacters(in: .whitespaces).isEmpty,
                    fullWidth: true
                ) {
                    Task { await save() }
                }
            }
            .accessibilityIdentifier("vector-db-zilliz")
        }
        .settingsPage(
            status: statusText,
            knowledge: [
                KnowledgeItem(title: L("settingsPage.vectorDb.storesTitle"), text: L("settingsPage.vectorDb.storesText")),
                KnowledgeItem(title: L("settingsPage.vectorDb.needTitle"), text: L("settingsPage.vectorDb.needText")),
                KnowledgeItem(title: L("settingsPage.vectorDb.changeTitle"), text: L("settingsPage.vectorDb.changeText"))
            ]
        )
    }

    private func save() async {
        let endpointValue = endpoint.trimmingCharacters(in: .whitespaces)
        let tokenValue = token.trimmingCharacters(in: .whitespaces)
        guard !endpointValue.isEmpty, !tokenValue.isEmpty else {
            toasts.showToast(L("dbSettings.databaseConnectionsSettingsWidget.enterEndpointAndToken"))
            return
        }
        guard ZillizValidation.isValidEndpoint(endpointValue) else {
            toasts.showToast(L("dbSettings.databaseConnectionsSettingsWidget.invalidZillizEndpoint"))
            return
        }
        guard ZillizValidation.isValidToken(tokenValue) else {
            toasts.showToast(L("dbSettings.databaseConnectionsSettingsWidget.invalidZillizToken"))
            return
        }
        isSaving = true
        defer { isSaving = false }
        do {
            let accessToken = try await auth.getAccessTokenSilently()
            let response = try await StoreConfigService.storeVectorDBConfig(
                token: accessToken,
                request: StoreCustomerVectorDBConfigRequest(vendor: "Zilliz", endpoint: endpoint, token: token)
            )
            if response.configStatus.updateSuccessful == true {
                auth.updateVectorDBConfigStatus(response.configStatus)
            }
            endpoint = ""
            token = ""
            toasts.showToast(L("dbSettings.databaseConnectionsSettingsWidget.zillizSavedSuccessfully"))
        } catch {
            toasts.showToast((error as? APIError)?.message ?? L("dbSettings.databaseConnectionsSettingsWidget.errorSavingZilliz"))
        }
    }
}

/// Shared between the Settings card and the first-run wizard.
enum ZillizValidation {
    private static let endpoint = /^https:\/\/[a-zA-Z0-9-]+\.(?:serverless|dedicated)\.[a-zA-Z0-9-]+\.cloud\.zilliz\.com\/?$/.ignoresCase()
    private static let token = /^[a-fA-F0-9]{64,}$/

    static func isValidEndpoint(_ value: String) -> Bool { value.wholeMatch(of: endpoint) != nil }
    static func isValidToken(_ value: String) -> Bool { value.wholeMatch(of: token) != nil }
}
