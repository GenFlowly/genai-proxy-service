import Foundation
import SwiftData

/// One cached value (the SwiftData counterpart of a web localStorage key). `key`
/// follows the web's `${customerId}_<suffix>` convention (see `StorageSuffix`);
/// `version` is the server cache-version counter the data was fetched at, when the
/// resource is version-gated (`defaultsCacheService.ts`).
@Model
final class CacheEntry {
    @Attribute(.unique) var key: String
    var data: Data
    var version: Int?
    var updatedAt: Date

    init(key: String, data: Data, version: Int? = nil, updatedAt: Date = Date()) {
        self.key = key
        self.data = data
        self.version = version
        self.updatedAt = updatedAt
    }
}

/// Mirrors `utils/storageKeys.ts`. NEVER cache credentials or credential-adjacent
/// data: vendor API keys, key statuses, vector-DB config, tool credentials,
/// embedding keys. Those stay in memory and repopulate from the server.
enum StorageSuffix {
    static let aiPreferences = "ai_preferences"
    static let instructions = "instructions"
    static let profile = "profile_cache_v1"
    static let systemPrompt = "system_prompt"
    static let selectedInstructionId = "selected_instruction_id"
    static let selectedAgentId = "selected_agent_id"
    static let aiVendorModels = "ai_vendor_models"
    static let promptEditorContentPrefix = "prompt_editor_content_"
    static let conversationHistory = "conversation_history_cache_v1"
    static let memories = "memories_cache_v1"
    static let recentInstructions = "recent_instructions_cache_v1"
    static let requestAgents = "request_agents_cache"
    static let customerAgents = "customer_agents_cache"
    static let embeddingModels = "embedding_models_cache"
    static let cacheVersions = "cache_versions"

    /// Deliberately global keys (no user data), like the web's.
    static let customerIdGlobal = "customerId"
    static let providerCatalogGlobal = "provider_catalog_cache"

    static func customerKey(_ customerId: String, _ suffix: String) -> String {
        "\(customerId)_\(suffix)"
    }
}
