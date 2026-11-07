import Foundation

enum ClientID {
    /// The same as the web's. iOS shares the web account, and the backend also keys server-side
    /// titles and its math formatting instruction on this value.
    static let app = "REACT_APP"
}

// MARK: - Onboarding (src/services/onboardUserService.ts)

enum OnboardUserService {
    static func onboardCustomer(user: Auth0Service.AuthUser, token: String) async throws -> OnboardCustomerResponse {
        let body = request(for: user)
        let (data, _) = try await APIClient.request(Endpoints.onboardCustomer, method: .post, token: token, body: body, retries: 1)
        return try JSONDecoder().decode(OnboardCustomerResponse.self, from: data)
    }

    static func request(for user: Auth0Service.AuthUser) -> OnboardCustomerRequest {
        OnboardCustomerRequest(sub: user.sub, email: user.email, name: user.name, picture: user.picture, client: ClientID.app)
    }
}

// MARK: - Generate text (src/services/generateTextService.ts)

enum GenerateTextService {
    static func generateText(token: String, request: GenerateTextRequest) async throws -> GenerateTextResponse {
        try await APIClient.requestJSON(Endpoints.generateText, method: .post, token: token, body: request, as: GenerateTextResponse.self)
    }
}

// MARK: - Conversations (src/services/conversationService.ts)

enum ConversationService {
    /// GET /api/v1/chat?conversationId={id} — the conversation fetch (query param, not a path segment).
    static func getConversation(token: String, conversationId: String) async throws -> GetConversationResult {
        var components = URLComponents(url: AppConfig.backendBaseURL.appendingPathComponent("api/v1/chat"), resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "conversationId", value: conversationId)]
        let (data, _) = try await APIClient.request(components.url!, method: .get, token: token.isEmpty ? nil : token)
        guard let json = JSONValue.parse(data), let backend = BackendGetConversationResponse(json: json) else {
            throw APIError(status: -1, message: "Invalid conversation response")
        }

        var pendingRuns: [PendingRunRef] = []
        let blocks: [ConversationBlock] = backend.items.enumerated().map { index, item in
            var responses: [Message] = []
            for (respIndex, resp) in item.responses.enumerated() {
                // Responses with text, plus an in-flight placeholder (empty text) for a
                // durable run still generating, so the client can reattach to it.
                guard !(resp.text ?? "").isEmpty || resp.inFlight else { continue }
                let vendorRaw = resp.aiVendor ?? ""
                responses.append(Message(
                    aiVendor: vendorRaw.isEmpty ? AIVendor.openai : AIVendor(rawValue: vendorRaw),
                    text: resp.text ?? "",
                    messageId: resp.messageId ?? "msg-\(index)-\(respIndex)",
                    previousMessageId: item.promptMessageId,
                    isLoading: resp.inFlight,
                    // Persisted raw running/done events fold into the same per-node list
                    // the live stream builds; a step that never finished must not pulse
                    // forever in a historical view.
                    thinkingStepList: resp.thinkingSteps
                        .reduce([ThinkingStep]()) { applyThinkingStep($0, $1) }
                        .map { step in
                            var done = step
                            if done.status == "running" { done.status = "done" }
                            return done
                        },
                    thinkingDurationMs: resp.thinkingDurationMs,
                    stopReason: resp.stopReason,
                    webSources: resp.webSources,
                    generatedAttachments: resp.generatedAttachments,
                    inputTokens: resp.inputTokens,
                    outputTokens: resp.outputTokens,
                    totalTokens: resp.totalTokens,
                    tokensReadFromCache: resp.tokensReadFromCache,
                    costUsd: resp.costUsd,
                    model: resp.model,
                    learnedFacts: resp.learnedFacts.map { .known($0) } ?? .unknown
                ))
                if resp.inFlight, let runId = resp.runId, let messageId = resp.messageId {
                    pendingRuns.append(PendingRunRef(messageId: messageId, runId: runId))
                }
            }
            let blockId = item.responses.first?.messageId.map { "block-\($0)" } ?? "block-\(index)-\(UUID().uuidString)"
            return ConversationBlock(
                conversationBlockId: blockId,
                prompt: item.promptText,
                attachments: item.attachments,
                responseMessages: responses,
                isLoading: responses.contains { $0.isLoading },
                status: .resolved,
                sentAt: ServerDate.parse(item.promptCreatedAt),
                sender: item.sender
            )
        }

        // The instruction can change mid-conversation (a default applied after some
        // messages existed), so surface the most recent prompt that carries one.
        let instructionId = backend.items.reversed().first { !($0.instructionId ?? "").isEmpty }?.instructionId

        return GetConversationResult(
            conversationId: conversationId,
            blocks: blocks,
            title: backend.title,
            instructionId: instructionId,
            role: backend.role ?? .owner,
            pendingRunId: backend.pendingRunId,
            pendingRuns: pendingRuns
        )
    }

    static func shareConversation(token: String, conversationId: String, targetCustomerId: String, role: String = "VIEW") async throws {
        let body = ShareRequest(conversationId: conversationId, instructionId: nil, targetCustomerId: targetCustomerId, role: role)
        _ = try await APIClient.request(Endpoints.conversationShare, method: .post, token: token, body: body)
    }

    static func unshareConversation(token: String, conversationId: String, targetCustomerId: String) async throws {
        var components = URLComponents(url: Endpoints.conversationShare, resolvingAgainstBaseURL: false)!
        components.queryItems = [
            URLQueryItem(name: "conversationId", value: conversationId),
            URLQueryItem(name: "targetCustomerId", value: targetCustomerId),
        ]
        _ = try await APIClient.request(components.url!, method: .delete, token: token)
    }

    static func getSharedUsers(token: String, conversationId: String) async throws -> [SearchUserResponse] {
        try await APIClient.requestJSON(Endpoints.conversationSharedUsers(conversationId), token: token, as: [SearchUserResponse].self)
    }
}

// MARK: - Conversation history (src/services/conversationHistoryService.ts)

enum ConversationHistoryService {
    static func getCustomerConversations(token: String, pageSize: Int = 10, lastEvaluatedKey: String? = nil) async throws -> GetCustomerConversationsResponse {
        var components = URLComponents(url: Endpoints.getCustomerConversations, resolvingAgainstBaseURL: false)!
        var items = [URLQueryItem(name: "pageSize", value: String(pageSize))]
        if let lastEvaluatedKey {
            items.append(URLQueryItem(name: "lastEvaluatedKey", value: lastEvaluatedKey))
        }
        components.queryItems = items
        return try await APIClient.requestJSON(components.url!, token: token, as: GetCustomerConversationsResponse.self)
    }

    /// Permanently deletes the conversation, everywhere it is stored.
    static func deleteConversation(token: String, conversationId: String) async throws {
        _ = try await APIClient.request(Endpoints.deleteConversation(conversationId), method: .delete, token: token)
    }

    // MARK: - Pinned

    static func getPinnedConversations(token: String) async throws -> [ConversationSummary] {
        try await APIClient.requestJSON(Endpoints.getPinnedConversations, token: token, as: GetPinnedConversationsResponse.self).conversations
    }

    static func pinConversation(token: String, conversationId: String) async throws {
        _ = try await APIClient.request(Endpoints.pinConversation(conversationId), method: .post, token: token)
    }

    static func unpinConversation(token: String, conversationId: String) async throws {
        _ = try await APIClient.request(Endpoints.unpinConversation(conversationId), method: .post, token: token)
    }

    // MARK: - Fork

    static func forkConversation(token: String, conversationId: String, messageId: String) async throws -> ForkConversationResponse {
        try await APIClient.requestJSON(Endpoints.forkConversation(conversationId, messageId: messageId), method: .post, token: token, as: ForkConversationResponse.self)
    }

    // MARK: - Projects

    static func getProjects(token: String) async throws -> [Project] {
        try await APIClient.requestJSON(Endpoints.getProjects, token: token, as: GetProjectsResponse.self).projects
    }

    /// One page of a project's conversations, most recently updated first. A page can
    /// come back shorter than pageSize; follow lastEvaluatedKey, not the page length.
    static func getProjectConversations(token: String, projectId: String, pageSize: Int = 50, lastEvaluatedKey: String? = nil) async throws -> GetCustomerConversationsResponse {
        var components = URLComponents(url: Endpoints.getProjectConversations, resolvingAgainstBaseURL: false)!
        var items = [URLQueryItem(name: "projectId", value: projectId), URLQueryItem(name: "pageSize", value: String(pageSize))]
        if let lastEvaluatedKey { items.append(URLQueryItem(name: "lastEvaluatedKey", value: lastEvaluatedKey)) }
        components.queryItems = items
        return try await APIClient.requestJSON(components.url!, token: token, as: GetCustomerConversationsResponse.self)
    }

    static func createProject(token: String, name: String) async throws -> Project {
        try await APIClient.requestJSON(Endpoints.createProject, method: .post, token: token, body: CreateProjectRequest(name: name), as: Project.self)
    }

    static func assignProject(token: String, conversationId: String, projectId: String) async throws {
        _ = try await APIClient.request(Endpoints.assignConversationProject(conversationId, projectId: projectId), method: .post, token: token)
    }

    static func unassignProject(token: String, conversationId: String) async throws {
        _ = try await APIClient.request(Endpoints.unassignConversationProject(conversationId), method: .post, token: token)
    }
}

// MARK: - Conversation title (src/services/createConversationTitleService.ts)

enum CreateConversationTitleService {
    static func createConversationTitle(token: String, request: CreateConversationTitleRequest) async throws -> CreateConversationTitleResponse {
        try await APIClient.requestJSON(Endpoints.createConversationTitle, method: .post, token: token, body: request, as: CreateConversationTitleResponse.self)
    }
}

// MARK: - Agents (src/services/agentsService.ts)

enum AgentsService {
    static func getCustomerAgents(token: String) async throws -> GetCustomerAgentsResponse {
        try await APIClient.requestJSON(Endpoints.getCustomerAgents, token: token, as: GetCustomerAgentsResponse.self)
    }

    static func getAgent(token: String, graphId: String) async throws -> Agent {
        try await APIClient.requestJSON(Endpoints.agent(graphId), token: token, as: Agent.self)
    }

    static func updateAgent(token: String, graphId: String, request: UpdateAgentRequest) async throws -> Agent {
        let url = AppConfig.backendBaseURL.appendingPathComponent("api/v1/agents/\(graphId)")
        return try await APIClient.requestJSON(url, method: .put, token: token, body: request, as: Agent.self)
    }

    /// Fork a System agent into an editable customer-owned copy (POST .../fork).
    static func forkAgent(token: String, graphId: String) async throws -> Agent {
        let url = AppConfig.backendBaseURL.appendingPathComponent("api/v1/agents/\(graphId)/fork")
        return try await APIClient.requestJSON(url, method: .post, token: token, as: Agent.self)
    }
}

// MARK: - Instructions (src/services/instructionService.ts)

enum InstructionService {
    static func getCustomerInstructions(token: String) async throws -> GetCustomerInstructionListResponse {
        try await APIClient.requestJSON(Endpoints.getCustomerInstructions, token: token.isEmpty ? nil : token, as: GetCustomerInstructionListResponse.self)
    }

    static func createInstruction(token: String, request: CreateInstructionRequest) async throws -> InstructionResponse {
        try await APIClient.requestJSON(Endpoints.createInstruction, method: .post, token: token, body: request, as: InstructionResponse.self)
    }

    /// Semantic (vector) search over the customer's instructions.
    /// Signed-in only: the API refuses signed-out searches.
    static func searchInstructions(token: String, query: String) async throws -> [InstructionResponse] {
        guard !token.isEmpty else { throw APIError(status: 401, message: "Sign in to search instructions") }
        return try await APIClient.requestJSON(Endpoints.searchInstructions(query), token: token, as: GetCustomerInstructionListResponse.self).instructions
    }

    /// Recently used instructions (for the chat instruction picker).
    static func recentInstructions(token: String, limit: Int = 3) async throws -> [InstructionResponse] {
        try await APIClient.requestJSON(Endpoints.recentInstructions(limit: limit), token: token.isEmpty ? nil : token, as: GetCustomerInstructionListResponse.self).instructions
    }

    static func getInstructionVersion(token: String, instructionId: String, version: Int) async throws -> InstructionResponse {
        let url = AppConfig.backendBaseURL.appendingPathComponent("api/v1/instruction/\(instructionId)/\(version)")
        return try await APIClient.requestJSON(url, token: token.isEmpty ? nil : token, as: InstructionResponse.self)
    }

    static func deleteInstruction(token: String, instructionId: String) async throws {
        let url = AppConfig.backendBaseURL.appendingPathComponent("api/v1/instruction/\(instructionId)")
        _ = try await APIClient.request(url, method: .delete, token: token)
    }

    static func shareInstruction(token: String, instructionId: String, targetCustomerId: String, role: String = "VIEW") async throws {
        let url = AppConfig.backendBaseURL.appendingPathComponent("api/v1/instruction/share")
        struct Body: Codable { var instructionId: String; var targetCustomerId: String; var role: String }
        _ = try await APIClient.request(url, method: .post, token: token, body: Body(instructionId: instructionId, targetCustomerId: targetCustomerId, role: role))
    }

    static func unshareInstruction(token: String, instructionId: String, targetCustomerId: String) async throws {
        var components = URLComponents(url: AppConfig.backendBaseURL.appendingPathComponent("api/v1/instruction/share"), resolvingAgainstBaseURL: false)!
        components.queryItems = [
            URLQueryItem(name: "instructionId", value: instructionId),
            URLQueryItem(name: "targetCustomerId", value: targetCustomerId),
        ]
        _ = try await APIClient.request(components.url!, method: .delete, token: token)
    }

    /// DP-002: the route takes the id as a query parameter (`/instruction/shared?instructionId=`).
    static func getInstructionSharedUsers(token: String, instructionId: String) async throws -> [SearchUserResponse] {
        var components = URLComponents(url: AppConfig.backendBaseURL.appendingPathComponent("api/v1/instruction/shared"), resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "instructionId", value: instructionId)]
        return try await APIClient.requestJSON(components.url!, token: token, as: [SearchUserResponse].self)
    }

    /// In how many of the caller's conversations the instruction was used, when last, and which.
    static func usage(token: String, instructionId: String) async throws -> InstructionUsageResponse {
        let url = AppConfig.backendBaseURL.appendingPathComponent("api/v1/instruction/\(instructionId)/usage")
        return try await APIClient.requestJSON(url, token: token, as: InstructionUsageResponse.self)
    }
}

// MARK: - Models list (src/services/getTextGenerationModelsService.ts)

enum TextGenerationModelsService {
    /// Pure read: vendors travel as a query param (the POST-with-body variant is deprecated).
    static func getModels(token: String, vendors: [AIVendor]) async throws -> GetTextGenerationModelsResponse {
        var components = URLComponents(url: Endpoints.getTextGenerationModels, resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "vendors", value: vendors.map(\.rawValue).joined(separator: ","))]
        return try await APIClient.requestJSON(components.url!, token: token, as: GetTextGenerationModelsResponse.self)
    }
}

// MARK: - AI usage (src/services/getAIUsageService.ts)

enum AIUsageService {
    static func getAIUsageActivity(token: String, conversationId: String, messageId: String) async -> AIUsageMetrics? {
        var components = URLComponents(url: Endpoints.getAIUsage, resolvingAgainstBaseURL: false)!
        components.queryItems = [
            URLQueryItem(name: "conversationId", value: conversationId),
            URLQueryItem(name: "messageId", value: messageId),
        ]
        do {
            return try await APIClient.requestJSON(components.url!, token: token, as: AIUsageMetrics.self)
        } catch {
            return nil
        }
    }
}

// MARK: - Attachments (src/services/attachmentService.ts)

enum AttachmentService {
    /// Asks the proxy for a presigned PUT, declaring the file's media type, then PUTs
    /// the raw bytes straight to S3. The signature binds the server's *effective*
    /// media type, so the PUT must use that one rather than the declared type.
    static func upload(token: String, data: Data, fileName: String, mediaType: String) async throws -> AttachmentRef {
        struct Body: Codable { var fileName: String; var mediaType: String; var sizeBytes: Int }
        let presign = try await APIClient.requestJSON(
            Endpoints.attachments, method: .post, token: token,
            body: Body(fileName: fileName, mediaType: mediaType, sizeBytes: data.count),
            as: CreateAttachmentUploadResponse.self
        )
        guard let url = URL(string: presign.uploadUrl) else { throw APIError(status: -1, message: "Invalid upload URL") }
        var request = URLRequest(url: url)
        request.httpMethod = "PUT"
        request.setValue(presign.mediaType, forHTTPHeaderField: "Content-Type")
        let (_, response) = try await APIClient.session.upload(for: request, from: data)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw APIError(status: (response as? HTTPURLResponse)?.statusCode ?? -1, message: "Attachment upload to S3 failed")
        }
        return AttachmentRef(attachmentId: presign.attachmentId, s3Key: presign.s3Key, mediaType: presign.mediaType, filename: fileName)
    }

    /// Short-lived presigned GET for an attachment the customer owns.
    static func viewURL(token: String, attachmentId: String) async throws -> URL {
        let response = try await APIClient.requestJSON(Endpoints.attachmentUrl(attachmentId), token: token, as: GetAttachmentUrlResponse.self)
        guard let url = URL(string: response.url) else { throw APIError(status: -1, message: "Invalid attachment URL") }
        return url
    }
}

// MARK: - Learned facts (src/services/learnedFactsService.ts)

enum LearnedFactsService {
    struct Result: Decodable {
        var status: String?
        var facts: [LearnedFact]?
        var isPending: Bool { status == "pending" }
    }

    static func get(token: String, conversationId: String, messageId: String) async throws -> Result {
        try await APIClient.requestJSON(Endpoints.learnedFacts(conversationId: conversationId, messageId: messageId), token: token, as: Result.self)
    }

    /// A memory already deleted elsewhere counts as success.
    static func delete(token: String, memoryId: String) async throws {
        _ = try await MemoriesService.delete(token: token, memoryId: memoryId)
    }

    /// Deletes every fact learned about the user; returns how many were deleted.
    static func deleteAll(token: String) async throws -> Int {
        try await MemoriesService.deleteAll(token: token)
    }
}

// MARK: - Developer API keys (src/services/developerApiKeysService.ts)

enum DeveloperApiKeysService {
    static func createKey(token: String, name: String) async throws -> DeveloperApiKeyCreatedResponse {
        try await APIClient.requestJSON(Endpoints.developerApiKeys, method: .post, token: token, body: CreateDeveloperApiKeyRequest(name: name), as: DeveloperApiKeyCreatedResponse.self)
    }

    static func listKeys(token: String) async throws -> ListDeveloperApiKeysResponse {
        try await APIClient.requestJSON(Endpoints.developerApiKeys, token: token, as: ListDeveloperApiKeysResponse.self)
    }

    static func revokeKey(token: String, keyId: String) async throws {
        _ = try await APIClient.request(Endpoints.developerApiKey(keyId), method: .delete, token: token)
    }
}

// MARK: - AI config preferences (src/services/saveAIConfigService.ts)

enum SaveAIConfigService {
    static func savePreferences(
        token: String,
        preferredModels: [AIConfig]? = nil,
        preferredAgentId: String? = nil,
        embeddingModelConversations: String? = nil,
        embeddingModelNotes: String? = nil,
        memoryLearnFromChats: Bool? = nil,
        memoryUseInReplies: Bool? = nil
    ) async throws {
        let body = SaveAIConfigPreferencesRequest(
            aiConfigPreferences: .init(
                preferredModels: preferredModels,
                preferredAgentId: preferredAgentId,
                embeddingModelConversations: embeddingModelConversations,
                embeddingModelNotes: embeddingModelNotes,
                memoryLearnFromChats: memoryLearnFromChats,
                memoryUseInReplies: memoryUseInReplies
            )
        )
        do {
            _ = try await APIClient.request(Endpoints.saveAIConfig, method: .post, token: token, body: body)
        } catch let error as APIError {
            // The server's validation message (e.g. an unsupported embedding model), else the
            // status line, as the web shows it.
            let serverError = error.body
                .flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }?["error"] as? String
            throw UserFacingError(message: serverError?.isEmpty == false ? serverError! : "Failed to save AI config preferences: \(error.statusText)")
        }
    }
}

// MARK: - Vendor API key / config storage

enum StoreConfigService {
    static func storeVendorApiKey(token: String, aiVendor: String, apiKey: String) async throws -> StoreCustomerVendorApiKeyResponse {
        do {
            return try await APIClient.requestJSON(Endpoints.storeCustomerVendorApiKey, method: .post, token: token, body: StoreCustomerVendorApiKeyRequest(aiVendor: aiVendor, apiKey: apiKey), as: StoreCustomerVendorApiKeyResponse.self)
        } catch let error as APIError {
            throw APIError(status: error.status, message: L("settingsPage.aiSettings.saveKeyFailed", ["vendor": aiVendor, "reason": error.statusText]))
        }
    }

    static func storeVectorDBConfig(token: String, request: StoreCustomerVectorDBConfigRequest) async throws -> StoreCustomerVectorDBConfigResponse {
        try await APIClient.requestJSON(Endpoints.storeCustomerVectorDBConfig, method: .post, token: token, body: request, as: StoreCustomerVectorDBConfigResponse.self)
    }

    /// Model + failover priority (1 = primary) internal generations use for a vendor.
    static func storeVendorConfig(token: String, request: StoreCustomerVendorConfigRequest) async throws {
        do {
            _ = try await APIClient.request(Endpoints.storeCustomerVendorConfig, method: .post, token: token, body: request)
        } catch let error as APIError {
            throw APIError(status: error.status, message: L("settingsPage.aiSettings.saveConfigFailed", ["vendor": request.aiVendor, "reason": error.statusText]))
        }
    }
}

// MARK: - Users / profile (src/services/userService.ts)

enum UserService {
    static func searchUserByUsername(token: String, username: String) async -> [SearchUserResponse] {
        var components = URLComponents(url: Endpoints.searchUsers, resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "username", value: username)]
        do {
            return try await APIClient.requestJSON(components.url!, token: token, as: [SearchUserResponse].self)
        } catch {
            return []
        }
    }

    static func getUserProfile(token: String) async -> CustomerProfileResponse? {
        try? await APIClient.requestJSON(Endpoints.getProfile, token: token, as: CustomerProfileResponse.self)
    }

    static func updateUsername(token: String, username: String) async throws {
        do {
            _ = try await APIClient.request(Endpoints.updateUsername, method: .post, token: token, body: UpdateUsernameRequest(username: username))
        } catch let error as APIError where error.status == 409 {
            throw APIError(status: 409, message: L("errors.user.usernameTaken"))
        }
    }

    static func updateDiscoverability(token: String, isDiscoverable: Bool) async throws {
        _ = try await APIClient.request(Endpoints.updateDiscoverability, method: .post, token: token, body: UpdateDiscoverabilityRequest(isDiscoverable: isDiscoverable))
    }
}

// MARK: - Account (src/services/accountService.ts)

enum AccountService {
    /// Starts deleting the account. The server cuts the login off before it answers, so the
    /// caller signs out right after.
    static func deleteAccount(token: String) async throws {
        _ = try await APIClient.request(Endpoints.deleteAccount, method: .delete, token: token, body: DeleteAccountRequest())
    }

    /// Removes every key and credential the user stored; returns how many. The model lists
    /// those keys reached go with them.
    static func deleteAllCredentials(token: String, customerId: String?) async throws -> Int {
        let (data, _) = try await APIClient.request(Endpoints.deleteAllCredentials, method: .delete, token: token)
        if let customerId {
            CacheStore.shared.remove(StorageSuffix.customerKey(customerId, StorageSuffix.embeddingModels))
            CacheStore.shared.remove(StorageSuffix.customerKey(customerId, StorageSuffix.aiVendorModels))
        }
        return (try? JSONDecoder().decode(DeleteCredentialsResponse.self, from: data))?.deleted ?? 0
    }
}

// MARK: - Unified search (src/services/searchService.ts)

struct SearchResultItem: Codable, Identifiable, Equatable {
    let type: String
    let key: String
    let title: String?
    let snippet: String
    var id: String { key }
}

private struct SearchResponse: Codable {
    let results: [SearchResultItem]
}

/// The setting a search needs but the customer hasn't added (src/services/searchError.ts).
enum SearchSetupReason: String {
    case vectorDb = "VECTOR_DB_NOT_CONFIGURED"
    case embeddingKey = "EMBEDDING_KEY_MISSING"

    var settingsSection: AppRouter.SettingsSection { self == .embeddingKey ? .embeddingKeys : .vectorDb }

    var message: String {
        self == .embeddingKey ? L("common.search.notSetUpEmbeddingKey") : L("common.search.notSetUpVectorDb")
    }

    /// The missing setting when the API answered SEARCH_NOT_CONFIGURED; nil for any other failure.
    init?(_ error: Error) {
        struct Body: Decodable { let code: String?; let reason: String? }
        guard let apiError = error as? APIError, apiError.status == 409, let data = apiError.body,
              let body = try? JSONDecoder().decode(Body.self, from: data),
              body.code == "SEARCH_NOT_CONFIGURED" else { return nil }
        self = body.reason.flatMap(SearchSetupReason.init(rawValue:)) ?? .vectorDb
    }
}

enum SearchService {
    static func search(token: String, query: String, types: [String]) async throws -> [SearchResultItem] {
        #if DEBUG
        if let fixture = DebugFixtures.searchResults { return fixture }
        #endif
        return try await APIClient.requestJSON(Endpoints.search(query, types: types), token: token, as: SearchResponse.self).results
    }
}
