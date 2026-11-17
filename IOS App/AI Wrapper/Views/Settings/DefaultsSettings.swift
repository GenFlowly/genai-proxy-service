import SwiftUI

/// Defaults › Agents (DefaultsSettings.tsx): the Conversation agent for new chats, and which
/// agent does each built-in job, with one Save.
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
    /// One line under each known row's select: what that job does.
    private static let rowHintKeys = [
        titleRow: "settingsPage.agentsDefaults.titleHint",
        "MEMORY_EXTRACTION": "settingsPage.agentsDefaults.memoryHint",
        "INSTRUCTION_PERSONA": "settingsPage.agentsDefaults.personaHint"
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
        VStack(alignment: .leading, spacing: 12) {
            if isLoading {
                hint(L("settingsPage.defaultAgents.loading"))
            } else {
                SettingsCard(title: L("settingsPage.defaultAgents.conversationAgent")) {
                    if conversationAgents.first(where: { $0.graphId == conversationAgentId })?.isSystem == true {
                        StatusPill(text: L("settingsPage.defaultAgents.systemBadge"))
                    }
                } content: {
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
                        stacked: true,
                        onChange: { conversationAgentId = $0 }
                    )
                    .accessibilityIdentifier("default-agent-CONVERSATION")
                }
                SettingsCard(title: L("settingsPage.agentsDefaults.builtInJobs")) {
                    ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                        VStack(alignment: .leading, spacing: 6) {
                            Text(rowLabel(row))
                                .webText(13, 500)
                                .foregroundStyle(AppTheme.textPrimary)
                            InputSelectWithHint(
                                hint: L("settingsPage.defaultAgents.agentHint"),
                                value: selected[row.key] ?? Self.platformDefault,
                                options: options(for: row),
                                stacked: true,
                                onChange: { selected[row.key] = $0 }
                            )
                            .accessibilityIdentifier("default-agent-\(row.key)")
                            if let hintKey = Self.rowHintKeys[row.key] {
                                Text(L(hintKey))
                                    .webText(12)
                                    .foregroundStyle(AppTheme.textMuted)
                            }
                        }
                        .padding(.top, index > 0 ? 10 : 0)
                        .overlay(alignment: .top) {
                            if index > 0 { Rectangle().fill(AppTheme.sidebarHairline).frame(height: 1) }
                        }
                    }
                    if ownAgents.isEmpty {
                        hint(L("settingsPage.defaultAgents.noAgents")).padding(.top, 4)
                    }
                    PillButton(
                        label: isSaving ? L("settingsPage.defaultAgents.saving") : L("settingsPage.defaultAgents.save"),
                        icon: "save-icon",
                        size: .lg,
                        disabled: isSaving,
                        fullWidth: true
                    ) {
                        Task { await save() }
                    }
                    .padding(.top, 4)
                    .accessibilityIdentifier("default-agents-save")
                }
            }
        }
        .settingsPage(knowledge: [
            KnowledgeItem(title: L("settingsPage.agentsDefaults.whatTitle"), text: L("settingsPage.agentsDefaults.whatText")),
            KnowledgeItem(title: L("settingsPage.agentsDefaults.ownTitle"), text: L("settingsPage.agentsDefaults.ownText")),
            KnowledgeItem(title: L("settingsPage.agentsDefaults.conversationTitle"), text: L("settingsPage.agentsDefaults.conversationText"))
        ])
        .task { await load() }
        .onChange(of: ai.agents) { _, _ in apply() }
    }

    private func hint(_ text: String) -> some View {
        Text(text)
            .webText(13)
            .foregroundStyle(AppTheme.textMuted)
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

// MARK: - Defaults › Embedding models (EmbeddingModelDefaults.tsx)

/// The one model that indexes and searches the customer's data: chosen once, confirmed by
/// typing LOCK, read-only after that. A locked model the key can no longer use may be chosen
/// again; the server allows exactly that and answers 409 with the locked model otherwise.
struct EmbeddingModelsSettingsView: View {
    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var toasts: ToastCenter
    @EnvironmentObject var router: AppRouter

    private enum PageState { case notChosen, locked, unavailable }

    private static let lockWord = "LOCK"
    private static let vendors = [EmbeddingVendor.openAI, EmbeddingVendor.voyage]

    @State private var vendorModels: [EmbeddingVendorModels] = []
    @State private var modelsLoaded = false
    @State private var vendor = ""
    @State private var model = ""
    @State private var confirmOpen = false
    @State private var saving = false

    private var chosen: String? { EmbeddingModelChoice.chosen(auth.aiConfigPreferences) }

    private var state: PageState {
        guard let chosen else { return .notChosen }
        return modelsLoaded && EmbeddingModelChoice.isUnusable(chosen, vendorModels: vendorModels) ? .unavailable : .locked
    }

    private var statusText: String {
        switch state {
        case .notChosen: return L("settingsPage.embeddingModels.notChosen")
        case .locked: return L("settingsPage.embeddingModels.locked")
        case .unavailable: return L("settingsPage.embeddingModels.unavailable")
        }
    }

    private var statusKind: StatusPillKind {
        switch state {
        case .notChosen: return .unset
        case .locked: return .locked
        case .unavailable: return .warn
        }
    }

    private var hint: String? {
        switch state {
        case .notChosen: return L("settingsPage.embeddingModels.inUse", ["model": EmbeddingModelChoice.platformDefault])
        case .locked:
            guard let at = auth.aiConfigPreferences?.embeddingModelChosenAt, let date = ServerDate.parse(at) else { return nil }
            return L("settingsPage.embeddingModels.chosenOn", ["date": date.formatted(date: .numeric, time: .omitted)])
        case .unavailable: return L("settingsPage.embeddingModels.unavailableHint", ["model": chosen ?? ""])
        }
    }

    var body: some View {
        SettingsCard(title: L("settingsPage.embeddingModels.card"), hint: hint) {
            StatusPill(kind: statusKind, text: statusText)
        } content: {
            if state == .locked {
                VStack(spacing: 10) {
                    InputTextWithHint(
                        hint: L("settingsPage.embeddingDefaults.vendorHint"),
                        text: .constant(EmbeddingModelChoice.vendor(chosen).map(EmbeddingModelChoice.vendorLabel) ?? ""),
                        stacked: true,
                        readOnly: true
                    )
                    .accessibilityIdentifier("embedding-model-locked-vendor")
                    InputTextWithHint(hint: L("settingsPage.embeddingDefaults.modelHint"), text: .constant(chosen ?? ""), stacked: true, readOnly: true)
                        .accessibilityIdentifier("embedding-model-locked-model")
                }
            } else {
                VStack(spacing: 10) {
                    InputSelectWithHint(
                        hint: L("settingsPage.embeddingDefaults.vendorHint"),
                        placeholder: L("settingsPage.embeddingDefaults.vendorPlaceholder"),
                        value: vendor,
                        options: vendorModels.map { .init(value: $0.vendor, label: EmbeddingModelChoice.vendorLabel($0.vendor)) },
                        stacked: true,
                        onChange: { vendor = $0; model = "" }
                    )
                    .accessibilityIdentifier("embedding-vendor-select-conversations")
                    InputSelectWithHint(
                        hint: L("settingsPage.embeddingDefaults.modelHint"),
                        placeholder: L("settingsPage.embeddingDefaults.modelPlaceholder"),
                        value: model,
                        options: (vendorModels.first { $0.vendor == vendor }?.models ?? []).map { .init(value: $0, label: $0) },
                        stacked: true,
                        onChange: { model = $0 }
                    )
                    .accessibilityIdentifier("embedding-model-select-conversations")
                }
                if modelsLoaded && vendorModels.isEmpty {
                    note(L("settingsPage.embeddingDefaults.noModels"))
                }
                VStack(alignment: .leading, spacing: 12) {
                    PillButton(label: L("settingsPage.embeddingModels.chooseAndLock"), size: .lg, disabled: model.isEmpty || saving, fullWidth: true) {
                        confirmOpen = true
                    }
                    .accessibilityIdentifier("save-default-embedding-model")
                    note(L("settingsPage.embeddingModels.permanent"))
                }
                if auth.hasOwnKeys {
                    SettingsRow(label: L("settingsPage.embeddingModels.ready"), stack: false) {
                        if Self.vendors.contains(where: { vendor in !vendorModels.contains { $0.vendor == vendor } }) {
                            SettingsLink(text: L("settingsPage.searchIndex.setUp")) { router.navigate(.settings(.embeddingKeys)) }
                        }
                    } extra: {
                        WrapRow(spacing: 6, lineSpacing: 6) {
                            ForEach(Self.vendors, id: \.self) { id in
                                let ready = vendorModels.contains { $0.vendor == id }
                                StatusPill(
                                    kind: ready ? .ok : .unset,
                                    text: L(ready ? "settingsPage.embeddingModels.vendorReady" : "settingsPage.embeddingModels.vendorNotSet", ["vendor": EmbeddingModelChoice.vendorLabel(id)])
                                )
                            }
                        }
                        .padding(.top, 4)
                    }
                    .accessibilityIdentifier("embedding-model-readiness")
                }
            }
        }
        .accessibilityIdentifier("embedding-model-card")
        .settingsPage(
            status: statusText,
            knowledge: [
                KnowledgeItem(title: L("settingsPage.embeddingModels.doesTitle"), text: L("settingsPage.embeddingModels.doesText")),
                KnowledgeItem(title: L("settingsPage.embeddingModels.onceTitle"), text: L("settingsPage.embeddingModels.onceText"))
            ]
        )
        .settingsDialog(isPresented: confirmOpen) {
            TypedConfirmDialog(
                title: L("settingsPage.embeddingModels.lockTitle", ["model": model]),
                confirmWord: Self.lockWord,
                inputLabel: L("settingsPage.embeddingModels.lockPrompt", ["word": Self.lockWord]),
                confirmLabel: saving ? L("settingsPage.embeddingDefaults.saving") : L("settingsPage.embeddingModels.lockButton"),
                danger: false,
                busy: saving,
                identifier: "embedding-model-lock-dialog",
                onClose: { confirmOpen = false },
                onConfirm: { Task { await lock() } }
            ) {
                Text(L("settingsPage.embeddingModels.lockText"))
            }
        }
        .task { await loadModels() }
    }

    private func note(_ text: String) -> some View {
        Text(text)
            .webText(12)
            .foregroundStyle(AppTheme.textMuted)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func loadModels() async {
        guard let token = try? await auth.getAccessTokenSilently() else { return }
        if let models = try? await EmbeddingService.getModels(token: token) { vendorModels = models }
        modelsLoaded = true
    }

    private func lock() async {
        guard auth.isAuthenticated else {
            toasts.showToast(L("settingsPage.embeddingDefaults.loginFirstToast"))
            return
        }
        saving = true
        defer { saving = false }
        let picked = model
        do {
            let token = try await auth.getAccessTokenSilently()
            try await SaveAIConfigService.savePreferences(token: token, embeddingModelConversations: picked)
            auth.mergePreferences(embeddingModelConversations: picked, embeddingModelNotes: picked, embeddingModel: picked)
            auth.resyncAccount()
            confirmOpen = false
            toasts.showToast(L("settingsPage.embeddingModels.lockedToast", ["model": picked]))
        } catch let locked as EmbeddingModelLockedError {
            auth.mergePreferences(embeddingModelConversations: locked.lockedModel, embeddingModelNotes: locked.lockedModel, embeddingModel: locked.lockedModel)
            confirmOpen = false
            toasts.showToast(L("settingsPage.embeddingModels.alreadyLockedToast", ["model": locked.lockedModel]))
        } catch {
            let message = error.localizedDescription
            toasts.showToast(message.isEmpty ? L("settingsPage.embeddingDefaults.saveErrorToast") : message)
        }
    }
}
