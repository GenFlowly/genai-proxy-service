import SwiftUI

/// Settings > Defaults: which agent powers each built-in action, the Conversation Agent
/// for new chats, the memory switches and the per-category embedding models
/// (DefaultsSettings.tsx).
struct DefaultsSettingsView: View {
    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var ai: AIStore
    @EnvironmentObject var toasts: ToastCenter

    /// Non-empty sentinel for "no override, use the platform default".
    private static let platformDefault = "__platform_default__"
    /// The two title flows are served by one agent, so they share one row.
    private static let titleRequestTypes = ["CONVERSATION_TITLE", "NOTE_TITLE"]
    private static let titleRow = "TITLE"
    private static let rowLabelKeys = [
        titleRow: "settingsPage.defaultAgents.titleAgent",
        "MEMORY_EXTRACTION": "settingsPage.defaultAgents.learnAboutMeAgent",
        "INSTRUCTION_PERSONA": "settingsPage.defaultAgents.instructionPersonaAgent"
    ]

    private struct MappingRow: Identifiable {
        let key: String
        let entries: [CustomerRequestAgentStatus]
        var id: String { key }
    }

    @State private var actions: [CustomerRequestAgentStatus] = []
    @State private var selected: [String: String] = [:]
    @State private var conversationAgentId = ""
    @State private var savedConversationAgentId = ""
    @State private var isSaving = false
    @State private var isLoading = true
    @State private var appliedSignature = ""

    /// Only the user's own agents are candidates for action rows.
    private var ownAgents: [Agent] { ai.agents.filter { $0.isSystem != true } }

    private var conversationAgents: [Agent] {
        ai.agents.filter { $0.requestType == nil && $0.resolvedCategory == .conversation }
    }

    private var rows: [MappingRow] { Self.buildRows(actions) }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            if isLoading {
                hint(L("settingsPage.defaultAgents.loading"))
            } else {
                form
            }
            LearnedFactsSettingsView()
                .padding(.top, 32)
            EmbeddingModelDefaultsView()
                .padding(.top, 32)
        }
        .task { await load() }
        .onChange(of: ai.agents) { _, _ in apply() }
    }

    private var form: some View {
        VStack(alignment: .leading, spacing: 16) {
            ForEach(rows) { row in
                field(label: rowLabel(row)) {
                    InputSelectWithHint(
                        hint: L("settingsPage.defaultAgents.agentHint"),
                        value: selected[row.key] ?? Self.platformDefault,
                        options: options(for: row),
                        onChange: { selected[row.key] = $0 }
                    )
                }
            }
            field(label: L("settingsPage.defaultAgents.conversationAgent")) {
                InputSelectWithHint(
                    hint: L("settingsPage.defaultAgents.agentHint"),
                    placeholder: L("settingsPage.defaultAgents.conversationPlaceholder"),
                    value: conversationAgentId,
                    options: conversationAgents.map { agent in
                        .init(
                            value: agent.graphId,
                            label: agent.isSystem == true ? "\(agent.name) (\(L("settingsPage.defaultAgents.systemBadge")))" : agent.name
                        )
                    },
                    onChange: { conversationAgentId = $0 }
                )
            }
            if ownAgents.isEmpty {
                hint(L("settingsPage.defaultAgents.noAgents")).padding(.top, 4)
            }
            PillButton(
                label: isSaving ? L("settingsPage.defaultAgents.saving") : L("settingsPage.defaultAgents.save"),
                icon: "save-icon",
                disabled: isSaving
            ) {
                Task { await save() }
            }
            .padding(.top, 4)
        }
    }

    private func field<Content: View>(label: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            WebFieldLabel(label, color: Color(hex: "#6B7280"))
            content()
        }
    }

    private func hint(_ text: String) -> some View {
        Text(text)
            .webText(13)
            .foregroundStyle(Color(hex: "#6B7280"))
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// One row per backend action, except the two title flows which merge into one whose
    /// selection writes both mappings. Known rows keep a fixed order; anything the
    /// registry adds later follows in server order.
    private static func buildRows(_ entries: [CustomerRequestAgentStatus]) -> [MappingRow] {
        let titleEntries = entries.filter { titleRequestTypes.contains($0.requestType) }
        let rest = entries.filter { !titleRequestTypes.contains($0.requestType) }
        func rank(_ type: String) -> Int {
            ["MEMORY_EXTRACTION", "INSTRUCTION_PERSONA"].firstIndex(of: type) ?? 2
        }
        let ordered = rest.enumerated()
            .sorted { (rank($0.element.requestType), $0.offset) < (rank($1.element.requestType), $1.offset) }
            .map(\.element)
        return (titleEntries.isEmpty ? [] : [MappingRow(key: titleRow, entries: titleEntries)])
            + ordered.map { MappingRow(key: $0.requestType, entries: [$0]) }
    }

    private func rowLabel(_ row: MappingRow) -> String {
        if let key = Self.rowLabelKeys[row.key] { return L(key) }
        return row.entries.first?.displayName ?? row.key
    }

    /// The platform default plus the user's agents. Agents already serving a request type
    /// are hidden except those mapped or selected here, so the existing choice can show.
    private func options(for row: MappingRow) -> [InputSelectWithHint.Option] {
        let mapped = row.entries.compactMap { $0.entry?.graphId }
        let current = selected[row.key]
        let platformLabel: String
        if let name = row.entries.first?.platformAgentName {
            platformLabel = L("settingsPage.defaultAgents.platformDefaultNamed", ["agent": name])
        } else {
            platformLabel = L("settingsPage.defaultAgents.platformDefault")
        }
        return [.init(value: Self.platformDefault, label: platformLabel)]
            + ownAgents
                .filter { $0.requestType == nil || mapped.contains($0.graphId) || $0.graphId == current }
                .map { .init(value: $0.graphId, label: $0.name) }
    }

    private func load() async {
        guard let token = try? await auth.getAccessTokenSilently() else { return }
        await ai.fetchAgents(token: token, version: auth.cacheVersions?["agents"])
        await ai.fetchRequestAgents(token: token, version: auth.cacheVersions?["requestAgents"])
        apply()
        isLoading = ai.requestAgents == nil
        if isLoading {
            isLoading = false
            toasts.showToast(L("settingsPage.defaultAgents.loadErrorToast"))
        }
    }

    /// An unchanged refresh is not re-applied: it would discard an in-progress edit.
    private func apply() {
        guard let response = ai.requestAgents else { return }
        let signature = response.entries.map { "\($0.requestType)=\($0.entry?.graphId ?? "")\($0.entry?.enabled == true)" }.joined(separator: ",")
            + "|" + ai.agents.map(\.graphId).joined(separator: ",")
        if signature != appliedSignature {
            appliedSignature = signature
            actions = response.entries
            selected = Dictionary(uniqueKeysWithValues: Self.buildRows(response.entries).map { row in
                (row.key, row.entries.first { $0.entry?.enabled == true }?.entry?.graphId ?? Self.platformDefault)
            })
        }
        // The user's pick when set, else their own default graph, else the System default.
        if savedConversationAgentId.isEmpty,
           let effective = Agent.effectiveDefaultId(conversationAgents, selectedAgentId: ai.selectedAgentId) {
            conversationAgentId = effective
            savedConversationAgentId = effective
        }
    }

    private func save() async {
        isSaving = true
        defer { isSaving = false }
        do {
            let token = try await auth.getAccessTokenSilently()
            var changedMapping = false
            for row in rows {
                let after = selected[row.key] ?? Self.platformDefault
                for entry in row.entries {
                    let before = entry.entry?.enabled == true ? (entry.entry?.graphId ?? Self.platformDefault) : Self.platformDefault
                    guard after != before else { continue }
                    changedMapping = true
                    if after == Self.platformDefault {
                        try await RequestAgentsService.deleteMapping(token: token, requestType: entry.requestType)
                    } else {
                        try await RequestAgentsService.putMapping(token: token, requestType: entry.requestType, graphId: after)
                    }
                }
            }
            if changedMapping {
                // Mapping writes also retag agents server-side, so both caches refresh now.
                await ai.fetchRequestAgents(token: token, version: auth.cacheVersions?["requestAgents"], force: true)
                await ai.fetchAgents(token: token, version: auth.cacheVersions?["agents"], force: true)
                apply()
            }
            if !conversationAgentId.isEmpty, conversationAgentId != savedConversationAgentId {
                try await SaveAIConfigService.savePreferences(token: token, preferredAgentId: conversationAgentId)
                auth.mergePreferences(preferredAgentId: conversationAgentId)
                ai.selectedAgentId = conversationAgentId
                ai.persistSelections()
                savedConversationAgentId = conversationAgentId
            }
            toasts.showToast(L("settingsPage.defaultAgents.savedToast"))
        } catch {
            toasts.showToast(error.localizedDescription.isEmpty ? L("settingsPage.defaultAgents.saveErrorToast") : error.localizedDescription)
        }
    }
}

/// Per-category default embedding models, picked vendor-first then model. Only vendors
/// with a stored embedding key offer models (EmbeddingModelDefaults.tsx).
private struct EmbeddingModelDefaultsView: View {
    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var toasts: ToastCenter
    @ObservedObject private var catalog = ProviderCatalog.shared

    private struct Selection: Equatable {
        var vendor = ""
        var model = ""
    }

    /// No app saves notes any more, so only conversations are offered; a stored notes
    /// default is left as it is.
    private static let categories = ["conversations"]

    @State private var selections: [String: Selection] = [:]
    @State private var vendorModels: [EmbeddingVendorModels] = []
    @State private var isSaving = false

    private static func vendor(forModel model: String) -> String {
        if model.hasPrefix("voyage") { return EmbeddingVendor.voyage }
        if model.hasPrefix("text-embedding") { return EmbeddingVendor.openAI }
        return ""
    }

    private var vendorOptions: [InputSelectWithHint.Option] {
        vendorModels.map {
            .init(
                value: $0.vendor,
                label: $0.vendor == EmbeddingVendor.voyage ? L("settingsPage.embeddingDefaults.voyageLabel") : catalog.displayName(for: $0.vendor)
            )
        }
    }

    private func modelOptions(_ vendor: String) -> [InputSelectWithHint.Option] {
        (vendorModels.first { $0.vendor == vendor }?.models ?? []).map { .init(value: $0, label: $0) }
    }

    private var cacheKey: String? {
        auth.customerId.map { StorageSuffix.customerKey($0, StorageSuffix.embeddingModels) }
    }

    private var hasSelection: Bool {
        selections.values.contains { !$0.model.isEmpty }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 4) {
                SettingsSectionTitle(L("settingsPage.embeddingDefaults.title"))
                Text(L("settingsPage.embeddingDefaults.subtitle"))
                    .webText(14)
                    .foregroundStyle(Color(hex: "#6B7280"))
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if vendorOptions.isEmpty {
                Text(L("settingsPage.embeddingDefaults.noModels"))
                    .webText(13)
                    .foregroundStyle(Color(hex: "#6B7280"))
                    .padding(.top, 4)
            }
            ForEach(Self.categories, id: \.self) { category in
                VStack(alignment: .leading, spacing: 6) {
                    WebFieldLabel(L("settingsPage.embeddingDefaults.category_\(category)"), color: Color(hex: "#6B7280"))
                    VStack(spacing: 12) {
                        InputSelectWithHint(
                            hint: L("settingsPage.embeddingDefaults.vendorHint"),
                            placeholder: L("settingsPage.embeddingDefaults.vendorPlaceholder"),
                            value: selections[category]?.vendor ?? "",
                            options: vendorOptions,
                            // A new vendor invalidates the previous model choice.
                            onChange: { selections[category] = Selection(vendor: $0) }
                        )
                        InputSelectWithHint(
                            hint: L("settingsPage.embeddingDefaults.modelHint"),
                            placeholder: L("settingsPage.embeddingDefaults.modelPlaceholder"),
                            value: selections[category]?.model ?? "",
                            options: modelOptions(selections[category]?.vendor ?? ""),
                            onChange: { selections[category, default: Selection()].model = $0 }
                        )
                    }
                }
            }
            PillButton(
                label: isSaving ? L("settingsPage.embeddingDefaults.saving") : L("settingsPage.embeddingDefaults.save"),
                icon: "save-icon",
                disabled: isSaving || !hasSelection
            ) {
                Task { await save() }
            }
            .padding(.top, 4)
        }
        .padding(.top, 33)
        .overlay(alignment: .top) { Rectangle().fill(Color(hex: "#E5E7EB")).frame(height: 1) }
        .task { await load() }
        .onChange(of: auth.aiConfigPreferences?.embeddingModelConversations) { _, _ in prefill() }
    }

    /// The per-category preference wins; the legacy single embeddingModel is the fallback.
    private func prefill() {
        let preferences = auth.aiConfigPreferences
        let conversations = preferences?.embeddingModelConversations ?? preferences?.embeddingModel ?? ""
        selections = [
            "conversations": Selection(vendor: Self.vendor(forModel: conversations), model: conversations)
        ]
    }

    /// The last known list renders immediately; the fetch (which can wait on a server-side
    /// probe) revalidates it. A failed refresh keeps showing what's cached.
    private func load() async {
        prefill()
        if let cacheKey, let cached = CacheStore.shared.read([EmbeddingVendorModels].self, key: cacheKey) {
            vendorModels = cached
        }
        guard let token = try? await auth.getAccessTokenSilently(),
              let fresh = try? await EmbeddingService.getModels(token: token) else { return }
        vendorModels = fresh
        if let cacheKey { CacheStore.shared.write(fresh, key: cacheKey) }
    }

    private func save() async {
        let conversations = selections["conversations"]?.model ?? ""
        guard !conversations.isEmpty else { return }
        isSaving = true
        defer { isSaving = false }
        do {
            let token = try await auth.getAccessTokenSilently()
            try await SaveAIConfigService.savePreferences(token: token, embeddingModelConversations: conversations)
            auth.mergePreferences(embeddingModelConversations: conversations)
            toasts.showToast(L("settingsPage.embeddingDefaults.savedToast"))
        } catch {
            toasts.showToast(error.localizedDescription.isEmpty ? L("settingsPage.embeddingDefaults.saveErrorToast") : error.localizedDescription)
        }
    }
}
