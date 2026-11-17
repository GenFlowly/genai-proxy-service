import Foundation

// MARK: - Usage & Cost (getUsageService.ts)

struct UsageByDim: Codable, Equatable, Identifiable {
    var vendor: String
    var model: String?
    var costUsd: Double
    var totalTokens: Int?
    var inputTokens: Int?
    var outputTokens: Int?
    var cacheReadTokens: Int?
    var cacheWriteTokens: Int?
    var requestCount: Int
    var id: String { vendor + "/" + (model ?? "") }
}

/// One UTC day's totals; days with no usage are left out.
struct UsageByDay: Codable, Equatable {
    var date: String
    var costUsd: Double
    var requestCount: Int
}

/// Totals for the LLM and embedding pages.
struct LlmUsageSummary: Codable, Equatable {
    var totalCostUsd: Double
    var byVendor: [UsageByDim]
    var byModel: [UsageByDim]
    /// Absent from servers older than the per-day series.
    var byDay: [UsageByDay]?
}

/// Web Search totals: priced from an admin rate card, never a real vendor bill.
struct EstimatedUsageSummary: Codable, Equatable {
    struct Row: Codable, Equatable, Identifiable {
        var key: String
        var count: Int
        var costUsd: Double
        var id: String { key }
    }
    var totalCostUsd: Double
    var isEstimate: Bool?
    var breakdown: [Row]
}

/// Vector DB totals: raw operation counts only, no cost field exists.
struct VectorDbUsageSummary: Codable, Equatable {
    struct Row: Codable, Equatable, Identifiable {
        var opType: String
        var count: Int
        var id: String { opType }
    }
    var breakdown: [Row]
}

// MARK: - Tools & credentials (customerToolsService.ts)

enum CustomerToolStatus: String, Codable {
    case draft, active, disabled
}

struct CustomerTool: Codable, Equatable, Identifiable {
    var name: String
    var description: String
    /// JSON strings, exactly as they are stored.
    var parameters: String
    var provider: String?
    var request: String
    var credentialRef: String
    var responseTransform: String
    var status: CustomerToolStatus
    var version: Int?
    var origin: String?
    var originRef: String?
    /// ISO-8601; non-empty is what lets a tool leave `draft`.
    var lastDryRunAt: String?
    var createdAt: String?
    var updatedAt: String?
    var id: String { name }
}

struct UpsertCustomerToolRequest: Codable {
    var name: String
    var description: String
    var parameters: String
    var provider: String
    var request: String
    var credentialRef: String
    var responseTransform: String
    var status: CustomerToolStatus
    var origin: String
    var originRef: String
    var lastDryRunAt: String
}

struct ListCustomerToolsResponse: Codable { var tools: [CustomerTool] }

/// The request the platform resolved and sent, per the dry run.
struct DryRunResolvedRequest: Equatable {
    var method: String
    var url: String
    var headers: [(key: String, value: String)]
    var query: [(key: String, value: String)]
    var body: JSONValue?

    static func == (lhs: DryRunResolvedRequest, rhs: DryRunResolvedRequest) -> Bool {
        lhs.method == rhs.method && lhs.url == rhs.url
    }
}

/// Field names are the runtime's, so the editor reads the runtime's payload.
struct DryRunResult: Equatable {
    var ok: Bool
    var request: DryRunResolvedRequest?
    var statusCode: Int?
    var responseBody: String?
    var truncated: Bool
    var modelSees: String?
    var error: String?

    init(json: JSONValue) {
        ok = json["ok"]?.boolean ?? false
        if let request = json["request"], request.pairs != nil {
            self.request = DryRunResolvedRequest(
                method: request["method"]?.string ?? "",
                url: request["url"]?.string ?? "",
                headers: Self.pairs(request["headers"]),
                query: Self.pairs(request["query"]),
                body: request["body"]
            )
        }
        statusCode = json["response"]?["status_code"]?.int
        responseBody = json["response"]?["body"]?.string
        truncated = json["response"]?["truncated"]?.boolean ?? false
        modelSees = json["model_sees"]?.string
        error = json["error"]?.string
    }

    private static func pairs(_ value: JSONValue?) -> [(key: String, value: String)] {
        (value?.pairs ?? []).map { (key: $0.0, value: $0.1.string ?? $0.1.jsonString) }
    }
}

struct ToolCredentialStatus: Codable, Equatable, Identifiable {
    var toolType: String
    var authType: String?
    var connected: Bool
    var connectedAt: String?
    /// Non-secret per-tool config, e.g. WEB_SEARCH's `max_searches_per_turn`.
    var settings: [String: String]?
    var id: String { toolType }
}

struct GetToolCredentialStatusListResponse: Codable { var toolCredentialStatuses: [ToolCredentialStatus] }

struct StoreToolCredentialsRequest: Codable {
    var toolType: String
    var authType: String
    /// Omit to update settings only; stored credentials are left untouched.
    var credentials: [String: String]?
    /// Omit to update credentials only; stored settings are left untouched.
    var settings: [String: String]?
}

struct StoreToolCredentialsResponse: Codable { var toolCredentialStatus: ToolCredentialStatus }

// MARK: - Connectors (connectorsService.ts)

struct Connector: Codable, Equatable, Identifiable {
    var id: String
    var kind: String            // openapi | mcp
    var label: String
    var ref: String
    var toolCount: Int
    var credentialRef: String?
    var connectedAt: String?
}

struct ListConnectorsResponse: Codable { var connectors: [Connector] }

// MARK: - Embedding keys / models (embeddingKeysService.ts)

enum EmbeddingVendor {
    static let openAI = "OPENAI"
    static let voyage = "VOYAGE"
    static let huggingFace = "HUGGINGFACE"
}

struct EmbeddingKeyStatus: Codable, Equatable, Identifiable {
    var vendor: String
    var isAPIKeyValid: Bool
    var status: String
    var updateSuccessful: Bool?
    /// Provider's own rejection message when validation fails.
    var detail: String?
    var id: String { vendor }
    var isSet: Bool { status == APIKeyStatus.valid || isAPIKeyValid }
}

struct GetEmbeddingKeysResponse: Codable { var statuses: [EmbeddingKeyStatus] }

struct StoreEmbeddingKeyRequest: Codable { var vendor: String; var apiKey: String }
struct StoreEmbeddingKeyResponse: Codable { var keyStatus: EmbeddingKeyStatus }

struct EmbeddingVendorModels: Codable, Equatable { var vendor: String; var models: [String] }
struct GetEmbeddingModelsResponse: Codable { var vendorModels: [EmbeddingVendorModels] }

// MARK: - Request-agent mapping (requestAgentsService.ts)

struct CustomerRequestAgentEntry: Codable, Equatable {
    var scope: String?
    var requestType: String
    var mapKey: String?
    var graphId: String
    var enabled: Bool
    var updatedAt: String?
}

struct CustomerRequestAgentStatus: Codable, Equatable, Identifiable {
    var requestType: String
    /// Human-readable action name from the backend RequestType registry.
    var displayName: String?
    var templateVariables: [String]?
    /// This account's own override, when one is set.
    var entry: CustomerRequestAgentEntry?
    /// Name of the agent serving this action absent an override (nil = built-in prompts).
    var platformAgentName: String?
    var id: String { requestType }
}

struct GetCustomerRequestAgentsResponse: Codable, Equatable { var entries: [CustomerRequestAgentStatus] }
