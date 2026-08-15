import Foundation

/// The `client` identifier the web app sends; kept identical so API calls stay the same.
enum ClientID {
    static let app = "REACT_APP"
    static let notes = "genai-react-app"
}

// MARK: - Onboarding (src/services/onboardUserService.ts)

enum OnboardUserService {
    static func onboardCustomer(user: Auth0Service.AuthUser, token: String) async throws -> OnboardCustomerResponse {
        let body = OnboardCustomerRequest(
            sub: user.sub, email: user.email, name: user.name, picture: user.picture, client: ClientID.app
        )
        let (data, _) = try await APIClient.request(Endpoints.onboardCustomer, method: .post, token: token, body: body, retries: 1)
        return try JSONDecoder().decode(OnboardCustomerResponse.self, from: data)
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
    /// GET /api/v1/chat/{conversationId} — note the /chat path, unlike the other conversation endpoints.
    static func getConversation(token: String, conversationId: String) async throws -> GetConversationResult {
        let url = AppConfig.backendBaseURL.appendingPathComponent("api/v1/chat/\(conversationId)")
        let (data, _) = try await APIClient.request(url, method: .get, token: token.isEmpty ? nil : token)
        let backend = try JSONDecoder().decode(BackendGetConversationResponse.self, from: data)

        let blocks: [ConversationBlock] = backend.promptAndResponseList.enumerated().map { index, item in
            let responses: [Message] = (item.responses ?? []).enumerated().compactMap { respIndex, resp in
                guard let text = resp.text, !text.isEmpty else { return nil }
                let vendor = AIVendor(rawValue: resp.aiVendor ?? "") ?? .openai
                return Message(
                    aiVendor: vendor,
                    text: text,
                    messageId: resp.messageId ?? "msg-\(index)-\(respIndex)",
                    inputTokens: resp.inputTokens,
                    outputTokens: resp.outputTokens,
                    totalTokens: resp.totalTokens,
                    tokensReadFromCache: resp.tokensReadFromCache
                )
            }
            let blockId: String
            if let firstMessageId = item.responses?.first?.messageId {
                blockId = "block-\(firstMessageId)"
            } else {
                blockId = "block-\(index)-\(UUID().uuidString)"
            }
            return ConversationBlock(
                conversationBlockId: blockId,
                prompt: item.prompt.prompt ?? "",
                responseMessages: responses,
                isLoading: false,
                status: .resolved
            )
        }

        return GetConversationResult(
            conversationId: conversationId,
            blocks: blocks,
            title: backend.title,
            instructionId: backend.promptAndResponseList.first?.prompt.instructionId,
            role: backend.role ?? .owner
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

    static func archiveConversation(token: String, conversationId: String) async throws {
        _ = try await APIClient.request(Endpoints.deleteConversation(conversationId), method: .delete, token: token)
    }

    static func unarchiveConversation(token: String, conversationId: String) async throws {
        _ = try await APIClient.request(Endpoints.unarchiveConversation(conversationId), method: .post, token: token)
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

    static func updateAgent(token: String, graphId: String, request: UpdateAgentRequest) async throws -> Agent {
        let url = AppConfig.backendBaseURL.appendingPathComponent("api/v1/agents/\(graphId)")
        return try await APIClient.requestJSON(url, method: .put, token: token, body: request, as: Agent.self)
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

    static func getInstructionSharedUsers(token: String, instructionId: String) async throws -> [SearchUserResponse] {
        let url = AppConfig.backendBaseURL.appendingPathComponent("api/v1/instruction/\(instructionId)/shared")
        return try await APIClient.requestJSON(url, token: token, as: [SearchUserResponse].self)
    }
}

// MARK: - Notes (src/services/saveNotesService.ts)

enum NotesService {
    static func getNotes(token: String) async throws -> [SavedNote] {
        let url = AppConfig.backendBaseURL.appendingPathComponent("api/v1/notes")
        let (data, _) = try await APIClient.request(url, method: .get, token: token, retries: 0)
        let response = try JSONDecoder().decode(GetNotesResponse.self, from: data)
        return response.notes ?? []
    }

    static func saveNote(token: String, noteKey: String, noteValue: String, title: String, createdAt: String, encode: Bool = true) async throws -> SaveNoteResult {
        let url = AppConfig.backendBaseURL.appendingPathComponent("api/v1/notes")
        let body = SaveNoteRequest(
            client: ClientID.notes,
            encode: encode,
            data: SaveNoteData(noteKey: noteKey, noteValue: noteValue, title: title, createdAt: createdAt)
        )
        let (data, _) = try await APIClient.request(url, method: .post, token: token, body: body, retries: 0)
        return (try? JSONDecoder().decode(SaveNoteResult.self, from: data)) ?? SaveNoteResult(title: nil)
    }
}

// MARK: - Models list (src/services/getTextGenerationModelsService.ts)

enum TextGenerationModelsService {
    static func getModels(token: String, vendors: [AIVendor]) async throws -> GetTextGenerationModelsResponse {
        try await APIClient.requestJSON(
            Endpoints.getTextGenerationModels, method: .post, token: token,
            body: GetTextGenerationModelsRequest(aiVendor: vendors),
            as: GetTextGenerationModelsResponse.self
        )
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
    static func savePreferences(token: String, preferredModels: [AIConfig], preferredGenerativeMode: String? = nil) async throws {
        let body = SaveAIConfigPreferencesRequest(
            aiConfigPreferences: .init(preferredModels: preferredModels, preferredGenerativeMode: preferredGenerativeMode)
        )
        _ = try await APIClient.request(Endpoints.saveAIConfig, method: .post, token: token, body: body)
    }
}

// MARK: - Vendor API key / config storage

enum StoreConfigService {
    static func storeVendorApiKey(token: String, aiVendor: String, apiKey: String) async throws -> StoreCustomerVendorApiKeyResponse {
        try await APIClient.requestJSON(Endpoints.storeCustomerVendorApiKey, method: .post, token: token, body: StoreCustomerVendorApiKeyRequest(aiVendor: aiVendor, apiKey: apiKey), as: StoreCustomerVendorApiKeyResponse.self)
    }

    static func storeVectorDBConfig(token: String, request: StoreCustomerVectorDBConfigRequest) async throws -> StoreCustomerVectorDBConfigResponse {
        try await APIClient.requestJSON(Endpoints.storeCustomerVectorDBConfig, method: .post, token: token, body: request, as: StoreCustomerVectorDBConfigResponse.self)
    }

    static func storeSupabaseConfig(token: String, request: StoreCustomerSupabaseConfigRequest) async throws -> StoreCustomerSupabaseConfigResponse {
        try await APIClient.requestJSON(Endpoints.storeCustomerSupabaseConfig, method: .post, token: token, body: request, as: StoreCustomerSupabaseConfigResponse.self)
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
            throw APIError(status: 409, message: "Username is already taken")
        }
    }

    static func updateDiscoverability(token: String, isDiscoverable: Bool) async throws {
        _ = try await APIClient.request(Endpoints.updateDiscoverability, method: .post, token: token, body: UpdateDiscoverabilityRequest(isDiscoverable: isDiscoverable))
    }
}
