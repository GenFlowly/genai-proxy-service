import Foundation

/// The server's own message when a validation failure came back as `{ error }`.
private func serverMessage(_ error: Error, fallback: String) -> String {
    guard let apiError = error as? APIError else { return fallback }
    if let range = apiError.message.range(of: "{"),
       let data = String(apiError.message[range.lowerBound...]).data(using: .utf8),
       let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
       let message = object["error"] as? String {
        return message
    }
    return apiError.message.isEmpty ? fallback : apiError.message
}

/// Thrown with the message the server (or the web's fallback) gives the user.
struct UserFacingError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

/// Cost & usage summaries over a date range (getUsageService.ts). A 404 means the
/// category's instrumentation hasn't shipped: nil, not an error.
enum UsageService {
    private static func fetch<T: Decodable>(_ url: URL, token: String, as type: T.Type) async throws -> T? {
        do {
            return try await APIClient.requestJSON(url, token: token, as: type)
        } catch let error as APIError where error.status == 404 {
            return nil
        }
    }

    static func getLlmUsage(token: String, from: String, to: String) async throws -> LlmUsageSummary {
        guard let summary = try await fetch(Endpoints.usageLlm(from: from, to: to), token: token, as: LlmUsageSummary.self) else {
            throw UserFacingError(message: "Get LLM usage failed: unexpected 404")
        }
        return summary
    }

    static func getEmbeddingUsage(token: String, from: String, to: String) async throws -> LlmUsageSummary? {
        try await fetch(Endpoints.usageEmbedding(from: from, to: to), token: token, as: LlmUsageSummary.self)
    }

    static func getVectorDbUsage(token: String, from: String, to: String) async throws -> VectorDbUsageSummary? {
        try await fetch(Endpoints.usageVectorDb(from: from, to: to), token: token, as: VectorDbUsageSummary.self)
    }

    static func getWebSearchUsage(token: String, from: String, to: String) async throws -> EstimatedUsageSummary? {
        try await fetch(Endpoints.usageWebSearch(from: from, to: to), token: token, as: EstimatedUsageSummary.self)
    }
}

/// Built-in + custom tools and their stored credentials (customerToolsService.ts).
enum ToolsService {
    static func listTools(token: String) async throws -> [CustomerTool] {
        do {
            return try await APIClient.requestJSON(Endpoints.customerTools, token: token, as: ListCustomerToolsResponse.self).tools
        } catch {
            throw UserFacingError(message: serverMessage(error, fallback: L("settingsPage.toolsSettings.loadErrorToast")))
        }
    }

    static func getTool(token: String, name: String) async throws -> CustomerTool {
        try await APIClient.requestJSON(Endpoints.customerTool(name), token: token, as: CustomerTool.self)
    }

    /// Create or replace a tool. The server bumps `version` and refuses `active` until a
    /// dry run has recorded a `lastDryRunAt`.
    static func saveTool(token: String, request: UpsertCustomerToolRequest) async throws -> CustomerTool {
        do {
            return try await APIClient.requestJSON(Endpoints.customerTools, method: .post, token: token, body: request, as: CustomerTool.self)
        } catch {
            throw UserFacingError(message: serverMessage(error, fallback: L("settingsPage.toolsSettings.saveErrorToast")))
        }
    }

    static func deleteTool(token: String, name: String) async throws {
        do {
            _ = try await APIClient.request(Endpoints.customerTool(name), method: .delete, token: token)
        } catch {
            throw UserFacingError(message: serverMessage(error, fallback: L("settingsPage.toolsSettings.deleteErrorToast")))
        }
    }

    /// One real call with sample arguments, so a retry would repeat it.
    static func dryRun(token: String, name: String, tool: UpsertCustomerToolRequest, args: [String: JSONEncodableValue]) async throws -> DryRunResult {
        struct Body: Encodable {
            let tool: UpsertCustomerToolRequest
            let args: [String: JSONEncodableValue]
        }
        do {
            let (data, _) = try await APIClient.request(Endpoints.customerToolDryRun(name), method: .post, token: token, body: Body(tool: tool, args: args), retries: 0)
            guard let json = JSONValue.parse(data) else { throw UserFacingError(message: L("settingsPage.toolsSettings.dryRunErrorToast")) }
            return DryRunResult(json: json)
        } catch {
            throw UserFacingError(message: serverMessage(error, fallback: L("settingsPage.toolsSettings.dryRunErrorToast")))
        }
    }

    static func getCredentialStatuses(token: String) async throws -> [ToolCredentialStatus] {
        try await APIClient.requestJSON(Endpoints.toolCredentials, token: token, as: GetToolCredentialStatusListResponse.self).toolCredentialStatuses
    }

    @discardableResult
    static func storeCredentials(token: String, request: StoreToolCredentialsRequest) async throws -> ToolCredentialStatus {
        do {
            return try await APIClient.requestJSON(Endpoints.toolCredentials, method: .post, token: token, body: request, as: StoreToolCredentialsResponse.self).toolCredentialStatus
        } catch {
            throw UserFacingError(message: serverMessage(error, fallback: L("settingsPage.toolsSettings.credentialErrorToast")))
        }
    }

    static func deleteCredentials(token: String, toolType: String) async throws {
        do {
            _ = try await APIClient.request(Endpoints.toolCredential(toolType), method: .delete, token: token)
        } catch {
            throw UserFacingError(message: serverMessage(error, fallback: L("settingsPage.toolsSettings.builtInGenericError")))
        }
    }
}

/// A value of a type the model would supply for a tool argument (string, number, bool).
enum JSONEncodableValue: Encodable {
    case string(String)
    case number(Double)
    case bool(Bool)

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .bool(let value): try container.encode(value)
        }
    }
}

/// OpenAPI / MCP connectors (connectorsService.ts). Previews and discovery reach someone
/// else's server, so they never retry. Operations and tools are kept as the server's own
/// JSON and sent back untouched.
enum ConnectorsService {
    static func listConnectors(token: String) async throws -> [Connector] {
        do {
            return try await APIClient.requestJSON(Endpoints.connectors, token: token, as: ListConnectorsResponse.self).connectors
        } catch {
            throw UserFacingError(message: serverMessage(error, fallback: L("settingsPage.connectorsSettings.loadErrorToast")))
        }
    }

    static func disconnect(token: String, id: String) async throws {
        do {
            _ = try await APIClient.request(Endpoints.connector(id), method: .delete, token: token)
        } catch {
            throw UserFacingError(message: serverMessage(error, fallback: L("settingsPage.connectorsSettings.disconnectErrorToast")))
        }
    }

    static func previewSpec(token: String, specUrl: String, credentialRef: String) async throws -> JSONValue {
        struct Body: Encodable { let specUrl: String; let credentialRef: String }
        do {
            let (data, _) = try await APIClient.request(Endpoints.connectorOpenApiPreview, method: .post, token: token, body: Body(specUrl: specUrl, credentialRef: credentialRef), retries: 0)
            guard let json = JSONValue.parse(data) else { throw UserFacingError(message: L("settingsPage.connectorsSettings.previewErrorToast")) }
            return json
        } catch {
            throw UserFacingError(message: serverMessage(error, fallback: L("settingsPage.connectorsSettings.previewErrorToast")))
        }
    }

    static func importSpec(token: String, specUrl: String, credentialRef: String, operations: [JSONValue]) async throws -> Int {
        struct Body: Encodable { let specUrl: String; let credentialRef: String; let operations: [JSONValue] }
        do {
            let (data, _) = try await APIClient.request(Endpoints.connectorOpenApiImport, method: .post, token: token, body: Body(specUrl: specUrl, credentialRef: credentialRef, operations: operations))
            return JSONValue.parse(data)?["tools"]?.array?.count ?? 0
        } catch {
            throw UserFacingError(message: serverMessage(error, fallback: L("settingsPage.connectorsSettings.importErrorToast")))
        }
    }

    static func discoverMcp(token: String, serverUrl: String, credentialRef: String, headers: [String: String]) async throws -> JSONValue {
        struct Body: Encodable { let serverUrl: String; let credentialRef: String; let headers: [String: String] }
        do {
            let (data, _) = try await APIClient.request(Endpoints.connectorMcpDiscover, method: .post, token: token, body: Body(serverUrl: serverUrl, credentialRef: credentialRef, headers: headers), retries: 0)
            guard let json = JSONValue.parse(data) else { throw UserFacingError(message: L("settingsPage.connectorsSettings.discoverErrorToast")) }
            return json
        } catch {
            throw UserFacingError(message: serverMessage(error, fallback: L("settingsPage.connectorsSettings.discoverErrorToast")))
        }
    }

    static func connectMcp(token: String, serverUrl: String, credentialRef: String, label: String, headers: [String: String], tools: [JSONValue]) async throws {
        struct Body: Encodable { let serverUrl: String; let credentialRef: String; let label: String; let headers: [String: String]; let tools: [JSONValue] }
        do {
            _ = try await APIClient.request(Endpoints.connectorMcpConnect, method: .post, token: token, body: Body(serverUrl: serverUrl, credentialRef: credentialRef, label: label, headers: headers, tools: tools))
        } catch {
            throw UserFacingError(message: serverMessage(error, fallback: L("settingsPage.connectorsSettings.connectErrorToast")))
        }
    }
}

/// Embedding keys + models (embeddingKeysService.ts).
enum EmbeddingService {
    static func getKeys(token: String) async throws -> [EmbeddingKeyStatus] {
        try await APIClient.requestJSON(Endpoints.getEmbeddingKeys, token: token, as: GetEmbeddingKeysResponse.self).statuses
    }

    static func storeKey(token: String, vendor: String, apiKey: String) async throws -> EmbeddingKeyStatus {
        do {
            return try await APIClient.requestJSON(Endpoints.storeEmbeddingKey, method: .post, token: token, body: StoreEmbeddingKeyRequest(vendor: vendor, apiKey: apiKey), as: StoreEmbeddingKeyResponse.self).keyStatus
        } catch let error as APIError {
            throw APIError(status: error.status, message: L("settingsPage.embeddingKeysSettings.storeKeyFailed", ["status": error.status, "reason": error.statusText]))
        }
    }

    /// The backend only allows HUGGINGFACE; the OpenAI and Voyage keys aren't deletable.
    static func deleteKey(token: String, vendor: String) async throws {
        do {
            _ = try await APIClient.request(Endpoints.deleteEmbeddingKey(vendor), method: .delete, token: token)
        } catch let error as APIError {
            throw APIError(status: error.status, message: L("settingsPage.embeddingKeysSettings.deleteKeyFailed", ["status": error.status, "reason": error.statusText]))
        }
    }

    static func getModels(token: String) async throws -> [EmbeddingVendorModels] {
        try await APIClient.requestJSON(Endpoints.getEmbeddingModels, token: token, as: GetEmbeddingModelsResponse.self).vendorModels
    }
}

/// Which agent powers each built-in action (requestAgentsService.ts).
enum RequestAgentsService {
    static func getRequestAgents(token: String) async throws -> GetCustomerRequestAgentsResponse {
        try await APIClient.requestJSON(Endpoints.getRequestAgents, token: token, as: GetCustomerRequestAgentsResponse.self)
    }

    static func putMapping(token: String, requestType: String, graphId: String) async throws {
        struct Body: Encodable { let graphId: String }
        do {
            _ = try await APIClient.request(Endpoints.requestAgentMapping(requestType), method: .put, token: token, body: Body(graphId: graphId))
        } catch {
            throw UserFacingError(message: serverMessage(error, fallback: L("settingsPage.defaultAgents.saveErrorToast")))
        }
    }

    static func deleteMapping(token: String, requestType: String) async throws {
        do {
            _ = try await APIClient.request(Endpoints.requestAgentMapping(requestType), method: .delete, token: token)
        } catch let error as APIError where error.status == 404 {
            return
        }
    }
}

/// First-run onboarding completion flag.
enum OnboardingService {
    static func completeOnboarding(token: String) async throws {
        _ = try await APIClient.request(Endpoints.completeOnboarding, method: .post, token: token)
    }
}
