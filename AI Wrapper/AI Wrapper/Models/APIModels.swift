import Foundation

// MARK: - Onboarding (src/models/onboardUser.models.ts)

struct OnboardCustomerRequest: Codable {
    var sub: String
    var email: String
    var name: String
    var picture: String?
    var client: String
}

struct AIConfigPreferences: Codable {
    var preferredModels: [AIConfig]?
    var preferredGenerativeMode: String?
}

struct AIVendorAPIKeyStatus: Codable, Equatable {
    var aiVendor: String
    var isAPIKeyValid: Bool?
    var status: String?          // "API key is valid" | "API key is not valid" | "API Key is not set"
    var updateSuccessful: Bool?

    var isValid: Bool { status == APIKeyStatus.valid || isAPIKeyValid == true }
}

enum APIKeyStatus {
    static let valid = "API key is valid"
    static let invalid = "API key is not valid"
    static let notSet = "API Key is not set"
}

struct VectorDBConfigStatus: Codable, Equatable {
    var vendor: String
    var isConfigValid: Bool?
    var status: String?          // PRESENT | NOT_SET
    var updateSuccessful: Bool?
}

struct SupabaseConfigStatus: Codable, Equatable {
    var isConfigValid: Bool?
    var status: String?          // PRESENT | NOT_SET
    var updateSuccessful: Bool?
}

struct OnboardCustomerResponse: Codable {
    var customerId: String?
    var aiConfigPreferences: AIConfigPreferences?
    var aiVendorAPIKeyStatusList: [AIVendorAPIKeyStatus]?
    var customerInstructions: [InstructionResponse]?
    var customerName: String?
    var customerPicture: String?
    var vectorDBConfigStatusList: [VectorDBConfigStatus]?
    var supabaseConfigStatus: SupabaseConfigStatus?
}

// MARK: - Instructions (src/models/instruction.models.ts)

struct InstructionResponse: Codable, Identifiable, Equatable, Hashable {
    var id: String
    var version: Int
    var name: String
    var instruction: String
    var icon: String?
    var color: String?
    var category: String?
    var tags: [String]?
    var role: String?            // OWNER | EDIT | VIEW
}

struct CreateInstructionRequest: Codable {
    var instruction: String
    var instructionName: String?
    var existingInstructionId: String?
}

struct GetCustomerInstructionListResponse: Codable {
    var instructions: [InstructionResponse]
}

// MARK: - Conversation history (src/models/conversationHistory.models.ts)

struct ConversationSummary: Codable, Identifiable, Equatable {
    var conversationId: String
    var title: String?
    var createdAt: String?
    var updatedAt: String?
    var vendors: [String]?

    var id: String { conversationId }
}

struct GetCustomerConversationsResponse: Codable {
    var conversations: [ConversationSummary]
    var lastEvaluatedKey: String?
}

// MARK: - Conversation fetch (src/services/conversationService.ts)

struct BackendPrompt: Codable {
    var instructionId: String?
    var instructionVersion: String?
    var prompt: String?
}

struct BackendResponse: Codable {
    var text: String?
    var aiVendor: String?
    var conversationId: String?
    var messageId: String?
    var inputTokens: Int?
    var outputTokens: Int?
    var totalTokens: Int?
    var tokensReadFromCache: Int?
}

struct BackendPromptAndResponse: Codable {
    var prompt: BackendPrompt
    var responses: [BackendResponse]?
}

struct BackendGetConversationResponse: Codable {
    var promptAndResponseList: [BackendPromptAndResponse]
    var title: String?
    var role: ConversationRole?
}

struct GetConversationResult {
    var conversationId: String
    var blocks: [ConversationBlock]
    var title: String?
    var instructionId: String?
    var role: ConversationRole
}

// MARK: - Conversation title (src/models/createConversationTitle.models.ts)

struct CreateConversationTitleRequest: Codable {
    var conversationId: String
    var prompt: String
    var instructionName: String?
}

struct CreateConversationTitleResponse: Codable {
    var title: String?
}

// MARK: - Agents (src/models/agents.models.ts)

struct AgentNode: Codable, Identifiable, Equatable, Hashable {
    var nodeId: String
    var nodeType: String
    var name: String
    var config: String

    var id: String { nodeId }
}

struct Agent: Codable, Identifiable, Equatable {
    var graphId: String
    var name: String
    var isDefault: Bool
    var entryPoint: String
    var maxIterations: Int
    var edges: String
    var nodes: [AgentNode]
    var createdAt: String?
    var updatedAt: String?

    var id: String { graphId }
}

struct GetCustomerAgentsResponse: Codable {
    var agents: [Agent]
}

struct UpdateAgentNodePatch: Codable {
    var nodeId: String
    var name: String?
    var config: String?
}

struct UpdateAgentRequest: Codable {
    var name: String?
    var isDefault: Bool?
    var maxIterations: Int?
    var entryPoint: String?
    var edges: String?
    var nodes: [UpdateAgentNodePatch]?
}

// MARK: - Users / profile (src/models/user.models.ts)

struct SearchUserResponse: Codable, Identifiable, Equatable {
    var customerId: String
    var name: String?
    var username: String
    var picture: String?
    var role: String?            // VIEW | EDIT

    var id: String { customerId }
}

struct CustomerProfileResponse: Codable, Equatable {
    var customerId: String
    var name: String?
    var email: String?
    var username: String?
    var picture: String?
    var isDiscoverable: Bool
}

// MARK: - Notes (src/models/encoding.models.ts + saveNotesService.ts)

struct SavedNote: Codable, Identifiable, Equatable {
    var noteKey: String
    var noteValue: String
    var title: String
    var createdAt: String
    var updatedAt: String

    var id: String { noteKey }
}

struct GetNotesResponse: Codable {
    var notes: [SavedNote]?
}

struct SaveNoteData: Codable {
    var noteKey: String
    var noteValue: String
    var title: String
    var createdAt: String

    enum CodingKeys: String, CodingKey {
        case noteKey = "note_key"
        case noteValue = "note_value"
        case title
        case createdAt = "created_at"
    }
}

struct SaveNoteRequest: Codable {
    var client: String
    var encode: Bool
    var data: SaveNoteData
}

struct SaveNoteResult: Codable {
    var title: String?
}

// MARK: - Models list (src/models/getTextGenerationModels.models.ts)

struct GetTextGenerationModelsRequest: Codable {
    var aiVendor: [AIVendor]
}

struct AIVendorModelList: Codable {
    var aiVendor: AIVendor
    var modelsList: [String]
}

struct GetTextGenerationModelsResponse: Codable {
    var aiVendorModelList: [AIVendorModelList]
}

// MARK: - Usage (src/services/getAIUsageService.ts)

struct AIUsageMetrics: Codable {
    var inputTokens: Int?
    var outputTokens: Int?
    var totalTokens: Int?
    var tokensReadFromCache: Int?
}

// MARK: - Developer API keys (src/models/developerApiKeys.models.ts)

struct CreateDeveloperApiKeyRequest: Codable {
    var name: String
}

struct DeveloperApiKeyCreatedResponse: Codable {
    var keyId: String
    var name: String
    var apiKey: String
    var prefix: String
    var createdAt: String
}

struct DeveloperApiKeySummary: Codable, Identifiable, Equatable {
    var keyId: String
    var name: String
    var prefix: String
    var createdAt: String?
    var lastUsedAt: String?

    var id: String { keyId }
}

struct ListDeveloperApiKeysResponse: Codable {
    var keys: [DeveloperApiKeySummary]
}

// MARK: - AI config preferences (src/models/*.ts save config)

struct SaveAIConfigPreferencesRequest: Codable {
    var aiConfigPreferences: SavePreferences

    struct SavePreferences: Codable {
        var preferredModels: [AIConfig]
        var preferredGenerativeMode: String?
    }
}

// MARK: - Vendor API keys / configs storage

struct StoreCustomerVendorApiKeyRequest: Codable {
    var aiVendor: String
    var apiKey: String
}

struct StoreCustomerVendorApiKeyResponse: Codable {
    var apiKeyStatus: AIVendorAPIKeyStatus
}

struct StoreCustomerVectorDBConfigRequest: Codable {
    var vendor: String
    var endpoint: String
    var token: String
}

struct StoreCustomerVectorDBConfigResponse: Codable {
    var configStatus: VectorDBConfigStatus
}

struct StoreCustomerSupabaseConfigRequest: Codable {
    var endpoint: String
    var token: String
    var password: String?
}

struct StoreCustomerSupabaseConfigResponse: Codable {
    var configStatus: SupabaseConfigStatus
}

// MARK: - Sharing

struct ShareRequest: Codable {
    var conversationId: String?
    var instructionId: String?
    var targetCustomerId: String
    var role: String             // VIEW | EDIT
}

struct UpdateUsernameRequest: Codable {
    var username: String
}

struct UpdateDiscoverabilityRequest: Codable {
    var isDiscoverable: Bool
}
