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
    var preferredAgentId: String?
    var embeddingModel: String?
    /// Default embedding model for conversation indexing.
    var embeddingModelConversations: String?
    /// Default embedding model for notes.
    var embeddingModelNotes: String?
    /// Memory switches (Settings › Defaults › Learned facts). Unset means on, as on the server.
    var memoryLearnFromChats: Bool?
    var memoryLearnFromNotes: Bool?
    var memoryUseInReplies: Bool?
}

struct AIVendorAPIKeyStatus: Codable, Equatable {
    var aiVendor: String
    var isAPIKeyValid: Bool?
    var status: String?          // "API key is valid" | "API key is not valid" | "API Key is not set"
    var updateSuccessful: Bool?
    /// Model internal generations (titles, personas, memory) use for this vendor.
    var selectedModel: String?
    /// Failover priority for internal generations (1 = primary).
    var priority: Int?
    /// Stored default reasoning effort (none|low|medium|high); nil = vendor default.
    var thinkingLevel: String?
    /// Provider's own rejection message when validation fails.
    var detail: String?

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

struct OnboardCustomerResponse: Codable {
    var customerId: String?
    var aiConfigPreferences: AIConfigPreferences?
    var aiVendorAPIKeyStatusList: [AIVendorAPIKeyStatus]?
    var customerInstructions: [InstructionResponse]?
    var customerName: String?
    var customerPicture: String?
    var vectorDBConfigStatusList: [VectorDBConfigStatus]?
    /// Server-side cache-version counters gating the client SWR caches (agents,
    /// requestAgents, projects). Captured now; the version gate is applied when
    /// those caches are built in later phases.
    var cacheVersions: [String: Int]?
    /// First-run gate for the onboarding wizard (missing → treat as true).
    var onboardingCompleted: Bool?
    /// True until the customer agrees to the AI data consent screen (missing → don't ask).
    var aiDataConsentRequired: Bool?
    /// When the customer last agreed, ISO-8601 UTC.
    var aiDataConsentAt: String?
}

struct AiDataConsentResponse: Codable {
    var aiDataConsentAt: String
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
    /// When this version was saved; nil for versions saved before that was kept.
    var createdAt: String?
}

/// The caller's own use of an instruction (GET /instruction/{id}/usage).
struct InstructionUsageResponse: Codable, Equatable {
    /// Conversations that used it, deleted ones included.
    var usageCount: Int
    var lastUsedAt: String?
    /// The conversations that still exist, newest first.
    var conversations: [InstructionUsageConversation]
    /// Conversations past the listing limit, not looked up.
    var omitted: Int?
}

struct InstructionUsageConversation: Codable, Equatable, Identifiable {
    var conversationId: String
    var title: String?
    var firstUsedAt: String?
    var id: String { conversationId }
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
    var pinnedAt: String?
    var vendors: [String]?
    var projectId: String?
    var projectName: String?
    /// Conversation this one was forked from (nests under its parent in history).
    var parentConversationId: String?

    init(conversationId: String, title: String? = nil, createdAt: String? = nil, updatedAt: String? = nil, pinnedAt: String? = nil, vendors: [String]? = nil, projectId: String? = nil, projectName: String? = nil, parentConversationId: String? = nil) {
        self.conversationId = conversationId
        self.title = title
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.pinnedAt = pinnedAt
        self.vendors = vendors
        self.projectId = projectId
        self.projectName = projectName
        self.parentConversationId = parentConversationId
    }

    var id: String { conversationId }
    var isPinned: Bool { (pinnedAt?.isEmpty == false) }
}

struct GetCustomerConversationsResponse: Codable {
    var conversations: [ConversationSummary]
    var lastEvaluatedKey: String?
}

struct GetPinnedConversationsResponse: Codable {
    var conversations: [ConversationSummary]
}

/// A history Project (folder) grouping conversations.
struct Project: Codable, Identifiable, Equatable {
    var projectId: String
    var name: String
    var createdAt: String?
    var updatedAt: String?
    var id: String { projectId }
}

struct GetProjectsResponse: Codable {
    var projects: [Project]
}

/// POST /conversation/fork — the newly created forked conversation.
struct ForkConversationResponse: Codable {
    var conversationId: String
    var title: String
    var parentConversationId: String?
    var projectId: String?
    var pinnedAt: String?
    var createdAt: String?
    var updatedAt: String?
}

struct CreateProjectRequest: Codable { var name: String }
struct RenameProjectRequest: Codable { var name: String }

// MARK: - Conversation fetch (src/services/conversationService.ts)

struct BackendPrompt: Codable {
    var instructionId: String?
    var instructionVersion: String?
    var prompt: String?
    var attachments: [AttachmentRef]?
}

/// Decoded by hand from `JSONValue` (thinking steps need tool-call argument order).
struct BackendGetConversationResponse {
    struct Item {
        var promptText: String
        var instructionId: String?
        var attachments: [AttachmentRef]
        var promptCreatedAt: String?
        var sender: MessageSender?
        var promptMessageId: String?
        var responses: [Response]
    }

    struct Response {
        var text: String?
        var aiVendor: String?
        var model: String?
        var messageId: String?
        var inFlight: Bool
        var runId: String?
        var inputTokens: Int?
        var outputTokens: Int?
        var totalTokens: Int?
        var tokensReadFromCache: Int?
        var costUsd: Double?
        var thinkingDurationMs: Int?
        var stopReason: String?
        var thinkingSteps: [ThinkingStep]
        var webSources: [WebSource]?
        var generatedAttachments: [AttachmentRef]?
        var learnedFacts: [LearnedFact]?
    }

    var items: [Item]
    var title: String?
    var role: ConversationRole?
    var pendingRunId: String?

    init?(json: JSONValue) {
        guard let list = json["promptAndResponseList"]?.array else { return nil }
        title = json["title"]?.string
        role = json["role"]?.string.flatMap(ConversationRole.init(rawValue:))
        pendingRunId = json["pendingRunId"]?.string
        items = list.map { item in
            let prompt = item["prompt"]
            let attachments: [AttachmentRef] = prompt?["attachments"]?.array?.compactMap(Self.attachment) ?? []
            var sender: MessageSender?
            if let s = item["sender"], let id = s["customerId"]?.string {
                sender = MessageSender(customerId: id, name: s["name"]?.string, picture: s["picture"]?.string)
            }
            return Item(
                promptText: prompt?["prompt"]?.string ?? "",
                instructionId: prompt?["instructionId"]?.string,
                attachments: attachments,
                promptCreatedAt: item["promptCreatedAt"]?.string,
                sender: sender,
                promptMessageId: item["promptMessageId"]?.string,
                responses: (item["responses"]?.array ?? []).map { r in
                    Response(
                        text: r["text"]?.string,
                        aiVendor: r["aiVendor"]?.string,
                        model: r["model"]?.string,
                        messageId: r["messageId"]?.string,
                        inFlight: r["inFlight"]?.boolean ?? false,
                        runId: r["runId"]?.string,
                        inputTokens: r["inputTokens"]?.int,
                        outputTokens: r["outputTokens"]?.int,
                        totalTokens: r["totalTokens"]?.int,
                        tokensReadFromCache: r["tokensReadFromCache"]?.int,
                        costUsd: r["costUsd"]?.double,
                        thinkingDurationMs: r["thinkingDurationMs"]?.int,
                        stopReason: r["stopReason"]?.string,
                        thinkingSteps: r["thinkingSteps"]?.array?.compactMap(ThinkingStep.init(json:)) ?? [],
                        webSources: r["webSources"]?.array?.compactMap(WebSource.init(json:)),
                        generatedAttachments: r["generatedAttachments"]?.array?.compactMap(Self.attachment),
                        learnedFacts: r["learnedFacts"]?.array?.compactMap { fact in
                            guard let id = fact["memoryId"]?.string else { return nil }
                            return LearnedFact(memoryId: id, text: fact["text"]?.string ?? "")
                        }
                    )
                }
            )
        }
    }

    private static func attachment(_ a: JSONValue) -> AttachmentRef? {
        guard let id = a["attachmentId"]?.string else { return nil }
        return AttachmentRef(attachmentId: id, s3Key: a["s3Key"]?.string, mediaType: a["mediaType"]?.string, filename: a["filename"]?.string, sizeBytes: a["sizeBytes"]?.int)
    }
}

/// An in-flight durable run to reattach to on load, and the response message it feeds.
struct PendingRunRef: Equatable {
    var messageId: String
    var runId: String
}

struct GetConversationResult {
    var conversationId: String
    var blocks: [ConversationBlock]
    var title: String?
    var instructionId: String?
    var role: ConversationRole
    var pendingRunId: String?
    var pendingRuns: [PendingRunRef]
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
    /// Server-resolved name of the instruction the config points at.
    var instructionName: String?

    var id: String { nodeId }
}

/// Coarse grouping of agents by what they power (server always resolves one).
enum AgentCategory: String, Codable, CaseIterable {
    case conversation = "CONVERSATION"
    case memory = "MEMORY"
    case titleCreator = "TITLE_CREATOR"
    case instructions = "INSTRUCTIONS"
}

struct Agent: Codable, Identifiable, Equatable {
    var graphId: String
    var name: String
    var isDefault: Bool
    var entryPoint: String
    var maxIterations: Int
    var edges: String
    var nodes: [AgentNode]
    var layout: String?
    /// True for admin-published System-owned agents (shared, read-only). Editing
    /// requires forking first (POST .../fork).
    var isSystem: Bool?
    /// Non-null when the graph backs an internal request flow (CONVERSATION_TITLE,
    /// NOTE_TITLE, …). Conversation agent pickers exclude these.
    var requestType: String?
    var category: String?
    var createdAt: String?
    var updatedAt: String?

    var id: String { graphId }

    /// The category to filter/act on (responses predating categories → CONVERSATION).
    var resolvedCategory: AgentCategory {
        category.flatMap(AgentCategory.init(rawValue:)) ?? .conversation
    }

    /// Empty agent used to open the editor in "create" mode.
    static let blank = Agent(
        graphId: "", name: "", isDefault: false, entryPoint: "",
        maxIterations: 10, edges: "[]", nodes: [], layout: nil, isSystem: nil,
        requestType: nil, category: nil, createdAt: nil, updatedAt: nil
    )
}

extension Agent {
    /// The single agent treated as the default: explicit pick when it still
    /// exists, else own default graph, else the System-published default.
    /// Mirrors effectiveDefaultAgentId in agents.models.ts.
    static func effectiveDefaultId(_ agents: [Agent], selectedAgentId: String?) -> String? {
        if let selectedAgentId, agents.contains(where: { $0.graphId == selectedAgentId }) {
            return selectedAgentId
        }
        let fallback = agents.first { $0.isSystem != true && $0.isDefault }
            ?? agents.first { $0.isSystem == true && $0.isDefault }
        return fallback?.graphId
    }
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
    var category: String?
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

// MARK: - Models list (src/models/getTextGenerationModels.models.ts)

struct AIVendorModelList: Codable, Equatable {
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
    /// Exact USD cost of the message, computed and persisted server-side.
    var costUsd: Double?
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
        var preferredModels: [AIConfig]?
        var preferredAgentId: String?
        var embeddingModel: String?
        var embeddingModelConversations: String?
        var embeddingModelNotes: String?
        var memoryLearnFromChats: Bool?
        var memoryLearnFromNotes: Bool?
        var memoryUseInReplies: Bool?
    }
}

// MARK: - Account (src/services/accountService.ts)

/// `DELETE /account` body; the server refuses any other confirmation.
struct DeleteAccountRequest: Codable, Equatable {
    static let confirmationWord = "DELETE"
    var confirmation = DeleteAccountRequest.confirmationWord
}

struct DeleteCredentialsResponse: Codable {
    var deleted: Int?
}

// MARK: - Vendor API keys / configs storage

struct StoreCustomerVendorApiKeyRequest: Codable {
    var aiVendor: String
    var apiKey: String
}

struct StoreCustomerVendorApiKeyResponse: Codable {
    var apiKeyStatus: AIVendorAPIKeyStatus
}

struct StoreCustomerVendorConfigRequest: Codable {
    var aiVendor: String
    var model: String
    var priority: Int
    /// Default reasoning effort for the vendor (nil = vendor default).
    var thinkingLevel: String?
}

struct StoreCustomerVectorDBConfigRequest: Codable {
    var vendor: String
    var endpoint: String
    var token: String
}

struct StoreCustomerVectorDBConfigResponse: Codable {
    var configStatus: VectorDBConfigStatus
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
