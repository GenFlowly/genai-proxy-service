import Foundation
import SwiftUI
import Combine

/// Mirrors src/context/AIContext.tsx — vendor/model selection, system prompt, selected
/// instruction — plus the shared queries AIVendorWidget and AgentPickerWidget read.
@MainActor
final class AIStore: ObservableObject {
    @Published var config: [AIConfig] = []
    @Published var systemPrompt: String = ""
    @Published var selectedInstructionId: String?
    @Published var selectedAgentId: String?
    @Published var agents: [Agent] = []
    @Published var agentsLoadFailed = false
    @Published var requestAgents: GetCustomerRequestAgentsResponse?
    @Published var modelsByVendor: [AIVendor: [String]] = [:]
    @Published var isLoadingModels = false

    private var customerId: String?
    private var loadedPreferencesSignature = ""
    /// True once the USER changed a selection this session. Config seeded from
    /// preferences never sets it, so a fresh server value can overwrite a stale cached
    /// seed but never a pick the user made.
    private var userMadeSelection = false

    func attach(customerId: String?) {
        guard self.customerId != customerId else { return }
        self.customerId = customerId
        agents = []
        guard let customerId else {
            requestAgents = nil
            agentsLoadFailed = false
            systemPrompt = ""
            selectedInstructionId = nil
            selectedAgentId = nil
            config = []
            modelsByVendor = [:]
            loadedPreferencesSignature = ""
            userMadeSelection = false
            return
        }
        let cache = CacheStore.shared
        systemPrompt = cache.readString(StorageSuffix.customerKey(customerId, StorageSuffix.systemPrompt)) ?? ""
        selectedInstructionId = cache.readString(StorageSuffix.customerKey(customerId, StorageSuffix.selectedInstructionId))
        selectedAgentId = cache.readString(StorageSuffix.customerKey(customerId, StorageSuffix.selectedAgentId))
        if let cached: [AIVendorModelList] = cache.read(key: StorageSuffix.customerKey(customerId, StorageSuffix.aiVendorModels)) {
            for entry in cached { modelsByVendor[entry.aiVendor] = entry.modelsList }
        }
        if let cached = cache.read(GetCustomerAgentsResponse.self, key: StorageSuffix.customerKey(customerId, StorageSuffix.customerAgents)) {
            agents = cached.agents
        }
    }

    func persistSelections() {
        guard let customerId else { return }
        let cache = CacheStore.shared
        let trimmed = systemPrompt.trimmingCharacters(in: .whitespacesAndNewlines)
        cache.writeString(trimmed.isEmpty ? nil : systemPrompt, key: StorageSuffix.customerKey(customerId, StorageSuffix.systemPrompt))
        cache.writeString(selectedInstructionId, key: StorageSuffix.customerKey(customerId, StorageSuffix.selectedInstructionId))
        cache.writeString(selectedAgentId, key: StorageSuffix.customerKey(customerId, StorageSuffix.selectedAgentId))
    }

    var selectedConfigs: [AIConfig] {
        config.filter { !$0.model.trimmingCharacters(in: .whitespaces).isEmpty }
    }

    func isVendorPopulated(_ vendor: AIVendor) -> Bool {
        config.contains { $0.aiVendor == vendor && !$0.model.isEmpty }
    }

    func selectedModel(for vendor: AIVendor) -> String {
        config.first { $0.aiVendor == vendor }?.model ?? ""
    }

    func thinkingLevel(for vendor: AIVendor) -> String {
        config.first { $0.aiVendor == vendor }?.thinkingLevel ?? ""
    }

    func setSelectedModel(for vendor: AIVendor, model: String) {
        userMadeSelection = true
        if let index = config.firstIndex(where: { $0.aiVendor == vendor }) {
            config[index].model = model
        } else {
            config.append(AIConfig(aiVendor: vendor, model: model))
        }
    }

    /// '' clears back to the vendor default.
    func setThinkingLevel(for vendor: AIVendor, level: String) {
        userMadeSelection = true
        guard let index = config.firstIndex(where: { $0.aiVendor == vendor }) else { return }
        config[index].thinkingLevel = level.isEmpty ? nil : level
    }

    /// Syncs backend model preferences into config as soon as they load, and adopts the
    /// account's agent unless this device has its own pick (the device's pick wins).
    func applyPreferences(_ preferences: AIConfigPreferences?, statuses: [AIVendorAPIKeyStatus]) {
        guard let preferences else { return }
        if customerId != nil, selectedAgentId == nil, let agentId = preferences.preferredAgentId, !agentId.isEmpty {
            selectedAgentId = agentId
        }
        guard let preferred = preferences.preferredModels else { return }
        let signature = (try? JSONEncoder().encode(preferred)).map { String(decoding: $0, as: UTF8.self) } ?? ""
        guard signature != loadedPreferencesSignature else { return }
        if !userMadeSelection {
            var next = config
            for pref in preferred where !pref.aiVendor.rawValue.isEmpty && !pref.model.isEmpty {
                let level = pref.thinkingLevel ?? statuses.first { $0.aiVendor == pref.aiVendor.rawValue }?.thinkingLevel
                if let index = next.firstIndex(where: { $0.aiVendor == pref.aiVendor }) {
                    next[index].model = pref.model
                    if let level, !level.isEmpty { next[index].thinkingLevel = level }
                } else {
                    next.append(AIConfig(aiVendor: pref.aiVendor, model: pref.model, thinkingLevel: (level?.isEmpty ?? true) ? nil : level))
                }
            }
            config = next
        }
        loadedPreferencesSignature = signature
    }

    /// Write-through after `/store-vendor-config` (the server mirrors it into preferredModels).
    func applyVendorConfig(vendor: AIVendor, model: String, thinkingLevel: String?) {
        if userMadeSelection { return }
        if let index = config.firstIndex(where: { $0.aiVendor == vendor }) {
            config[index].model = model
            config[index].thinkingLevel = (thinkingLevel?.isEmpty ?? true) ? nil : thinkingLevel
        } else {
            config.append(AIConfig(aiVendor: vendor, model: model, thinkingLevel: (thinkingLevel?.isEmpty ?? true) ? nil : thinkingLevel))
        }
    }

    // MARK: - Agents (conversation agent picker)

    /// CONVERSATION agents the picker lists (own + System), excluding internal flows.
    var conversationAgents: [Agent] {
        agents.filter { $0.requestType == nil && $0.resolvedCategory == .conversation }
    }

    /// The single effective default agent id (pick → own default → System default).
    var effectiveAgentId: String? {
        Agent.effectiveDefaultId(conversationAgents, selectedAgentId: selectedAgentId)
    }

    /// Version-gated query (`useCustomerAgents` + versionGatedQuery): served straight
    /// from the cached envelope when the /onboard `agents` counter is unchanged,
    /// fetched once otherwise. Same-client mutations pass `force`.
    func fetchAgents(token: String, version: Int?, force: Bool = false) async {
        guard let customerId else { return }
        let key = StorageSuffix.customerKey(customerId, StorageSuffix.customerAgents)
        if !force, let version, let envelope = CacheStore.shared.readEnvelope(GetCustomerAgentsResponse.self, key: key), envelope.version == version {
            agents = envelope.value.agents
            dropStaleAgentPick()
            return
        }
        do {
            let response = try await AgentsService.getCustomerAgents(token: token)
            guard customerId == self.customerId else { return }
            agents = response.agents
            agentsLoadFailed = false
            CacheStore.shared.write(response, key: key, version: version)
            dropStaleAgentPick()
        } catch {
            // Stale-on-error: a failed refresh keeps showing the last known list.
            agentsLoadFailed = agents.isEmpty
        }
    }

    /// Mutations return the full agent, so the list updates locally with no refetch.
    func applyAgent(_ agent: Agent) {
        if let index = agents.firstIndex(where: { $0.graphId == agent.graphId }) {
            agents[index] = agent
        } else {
            agents.append(agent)
        }
        guard let customerId else { return }
        let key = StorageSuffix.customerKey(customerId, StorageSuffix.customerAgents)
        let version = CacheStore.shared.readEnvelope(GetCustomerAgentsResponse.self, key: key)?.version
        CacheStore.shared.write(GetCustomerAgentsResponse(agents: agents), key: key, version: version)
    }

    /// The request-type → agent mapping, gated on the /onboard `requestAgents` counter the
    /// same way the agent list is (useRequestAgents).
    func fetchRequestAgents(token: String, version: Int?, force: Bool = false) async {
        guard let customerId else { return }
        let key = StorageSuffix.customerKey(customerId, StorageSuffix.requestAgents)
        let envelope = CacheStore.shared.readEnvelope(GetCustomerRequestAgentsResponse.self, key: key)
        if !force, let version, let envelope, envelope.version == version {
            requestAgents = envelope.value
            return
        }
        do {
            let response = try await RequestAgentsService.getRequestAgents(token: token)
            requestAgents = response
            CacheStore.shared.write(response, key: key, version: version)
        } catch {
            // Stale-on-error: a failed refresh keeps showing the last known mapping.
            if requestAgents == nil { requestAgents = envelope?.value }
        }
    }

    /// A stale pick (agent deleted since last visit) falls back to the graph defaults
    /// rather than sending a graphId the server will reject.
    private func dropStaleAgentPick() {
        let list = conversationAgents
        guard !list.isEmpty else { return }
        if let selectedAgentId, !list.contains(where: { $0.graphId == selectedAgentId }) {
            self.selectedAgentId = nil
            persistSelections()
        }
    }

    /// Picking an agent makes it the default — stored locally and pushed to the account
    /// preferences so it follows the user across devices.
    func selectAgent(id: String, token: String, onFailure: @escaping () -> Void) {
        selectedAgentId = id
        persistSelections()
        Task {
            do {
                try await SaveAIConfigService.savePreferences(token: token, preferredAgentId: id)
            } catch {
                onFailure()
            }
        }
    }

    // MARK: - Models

    /// Available models per vendor (useTextGenerationModels): the lists live on the
    /// vendors' side so no version counter can gate them — paint from the last copy,
    /// refetch. Skipped without a valid-key vendor.
    /// Forgets every cached list and asks the vendors again. Which model is selected is a
    /// separate thing, and stays as it is.
    func refreshModels(token: String, vendors: [AIVendor]) async {
        modelsByVendor = [:]
        if let customerId {
            CacheStore.shared.remove(StorageSuffix.customerKey(customerId, StorageSuffix.aiVendorModels))
        }
        await fetchModels(token: token, vendors: vendors)
    }

    func fetchModels(token: String, vendors: [AIVendor]) async {
        guard !vendors.isEmpty else { return }
        let session = customerId
        isLoadingModels = true
        defer { isLoadingModels = false }
        guard let response = try? await TextGenerationModelsService.getModels(token: token, vendors: vendors),
              session == customerId else { return }
        for entry in response.aiVendorModelList {
            modelsByVendor[entry.aiVendor] = entry.modelsList
        }
        // Screens ask for different vendor sets, and a narrower answer mustn't erase the rest.
        if let customerId, !response.aiVendorModelList.isEmpty {
            let lists = modelsByVendor.map { AIVendorModelList(aiVendor: $0.key, modelsList: $0.value) }
            CacheStore.shared.write(lists, key: StorageSuffix.customerKey(customerId, StorageSuffix.aiVendorModels))
        }
    }
}
