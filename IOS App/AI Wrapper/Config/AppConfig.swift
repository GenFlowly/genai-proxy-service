import Foundation

/// Which environment this build targets. Sourced from the build-config-selected
/// Info.plist (`APP_ENV`) rather than `#if DEBUG`, so it is explicit and testable.
enum AppEnvironment: String {
    case development
    case production

    static var current: AppEnvironment {
        let raw = (try? AppConfig.reader.requiredString("APP_ENV")) ?? "development"
        return AppEnvironment(rawValue: raw) ?? .development
    }
}

/// App configuration — read from Info.plist, which takes each value from the stage file in
/// `BuildSettings/Environments/` that the build selects (see the README there).
///
/// NOTHING is hardcoded here: URLs / Auth0 IDs / audience come from the stage, so a Release
/// build always targets production (mirrors the web app's `.env.development` /
/// `.env.production`). A missing/blank required key fails fast,
/// so a misconfigured build can never silently talk to the wrong host.
enum AppConfig {

    struct Auth0Settings {
        let domain: String
        let clientId: String
        let audience: String
    }

    /// Shared reader over the main bundle's Info.plist.
    static let reader = ConfigReader(bundle: .main)

    private static func require(_ key: String) -> String { failFast { try reader.requiredString(key) } }
    private static func requireURL(_ key: String) -> URL { failFast { try reader.requiredURL(key) } }

    // MARK: - Environment

    static let environment: AppEnvironment = .current
    /// `APP_DISPLAY_NAME` from the stage xcconfig: the product name in UI text.
    static let appName: String = reader.optionalString("CFBundleDisplayName") ?? ""

    // MARK: - Endpoints base + related hosts

    static let backendBaseURL: URL = requireURL("API_BASE_URL")
    /// Web app origin — used to build shareable conversation links (`/chat/:id`) and universal links.
    static let webAppURL: URL = requireURL("WEB_APP_URL")
    static let encodeAPIURL: URL = requireURL("ENCODE_API_URL")
    /// `POST /support`: the stage's SupportStack, the `SupportRequestUrl` output the web reads at deploy.
    static let supportRequestURL: URL = requireURL("SUPPORT_API_URL")

    // MARK: - Observability

    /// Sentry DSN; `nil` until provisioned (Sentry init is skipped when absent).
    static let sentryDSN: String? = reader.optionalString("SENTRY_DSN")

    // MARK: - Auth0

    static let auth0 = Auth0Settings(
        domain: require("AUTH0_DOMAIN"),
        clientId: require("AUTH0_CLIENT_ID"),
        audience: require("AUTH0_AUDIENCE")
    )

    enum Auth0 {
        static var domain: String { AppConfig.auth0.domain }
        static var clientId: String { AppConfig.auth0.clientId }
        static var audience: String { AppConfig.auth0.audience }
        static let scope = "openid profile email offline_access"

        /// Derived from the app's bundle id (not hardcoded).
        static var bundleId: String { Bundle.main.bundleIdentifier ?? "com.unbiase.ai" }
        /// Must be registered in the Auth0 application's "Allowed Callback URLs".
        static var callbackURL: String { "\(bundleId)://\(domain)/ios/\(bundleId)/callback" }
        static var callbackScheme: String { bundleId }
    }
}

/// Turns a throwing config read into a fail-fast crash with a clear message. A
/// misconfigured build is a developer error that must surface immediately, never
/// fall back to a wrong default.
private func failFast<T>(_ body: () throws -> T) -> T {
    do { return try body() }
    catch { fatalError("AppConfig: \(error)") }
}

/// Mirrors genai-react-app/src/config/endpoints.ts. Base host is configurable (above).
enum Endpoints {
    private static var base: String { AppConfig.backendBaseURL.absoluteString + "/api/v1" }

    static var onboardCustomer: URL { URL(string: "\(base)/onboard")! }
    static var getCustomerProfile: URL { URL(string: "\(base)/customer/profile")! }
    static var storeCustomerVendorApiKey: URL { URL(string: "\(base)/store-api-key")! }
    static var storeCustomerVendorConfig: URL { URL(string: "\(base)/store-vendor-config")! }
    static var storeCustomerVectorDBConfig: URL { URL(string: "\(base)/store-vector-db-config")! }
    static var generateText: URL { URL(string: "\(base)/generate-text")! }
    static var generateTextStream: URL { URL(string: "\(base)/generate-text-stream")! }
    /// True cancel for an in-flight generation (works with a client generationId
    /// or the server responseMessageId) — aborting the socket no longer stops the model.
    static func cancelGeneration(_ id: String) -> URL {
        URL(string: "\(base)/generations/cancel?responseMessageId=\(id.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? id)")!
    }
    /// Reattach to an in-flight durable run's event stream (reload/background recovery).
    static func reattachRun(_ runId: String, conversationId: String, fromSeq: Int = 0) -> URL {
        let r = runId.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? runId
        let c = conversationId.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? conversationId
        return URL(string: "\(base)/runs/\(r)/stream?conversationId=\(c)&fromSeq=\(fromSeq)")!
    }
    /// Deliver a human reply to a durable run paused on an in-graph interrupt().
    static func resumeRun(_ runId: String, conversationId: String) -> URL {
        let r = runId.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? runId
        let c = conversationId.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? conversationId
        return URL(string: "\(base)/runs/\(r)/resume?conversationId=\(c)")!
    }
    static var getTextGenerationModels: URL { URL(string: "\(base)/models")! }
    static var saveAIConfig: URL { URL(string: "\(base)/save-ai-config")! }
    static var deleteAccount: URL { URL(string: "\(base)/account")! }
    static var deleteAllCredentials: URL { URL(string: "\(base)/credentials")! }
    static var createInstruction: URL { URL(string: "\(base)/instruction")! }
    static var getCustomerInstructions: URL { URL(string: "\(base)/instructions")! }
    static func searchInstructions(_ q: String) -> URL { URL(string: "\(base)/instructions/search?q=\(enc(q))")! }
    static func search(_ q: String, types: [String]) -> URL { URL(string: "\(base)/search?q=\(enc(q))&types=\(types.joined(separator: ","))")! }
    static func recentInstructions(limit: Int = 3) -> URL { URL(string: "\(base)/instructions/recent?limit=\(limit)")! }
    static var createConversationTitle: URL { URL(string: "\(base)/conversation/title")! }
    static var conversationShare: URL { URL(string: "\(base)/conversation/share")! }
    static func conversationSharedUsers(_ conversationId: String) -> URL { URL(string: "\(base)/conversation/shared?conversationId=\(enc(conversationId))")! }
    static var getCustomerConversations: URL { URL(string: "\(base)/conversations")! }
    // Projects / pin / fork (history sections)
    static var getPinnedConversations: URL { URL(string: "\(base)/conversations/pinned")! }
    static func pinConversation(_ id: String) -> URL { URL(string: "\(base)/conversation/pin?conversationId=\(enc(id))")! }
    static func unpinConversation(_ id: String) -> URL { URL(string: "\(base)/conversation/unpin?conversationId=\(enc(id))")! }
    static func forkConversation(_ id: String, messageId: String) -> URL { URL(string: "\(base)/conversation/fork?conversationId=\(enc(id))&messageId=\(enc(messageId))")! }
    static var getProjects: URL { URL(string: "\(base)/projects")! }
    static var getProjectConversations: URL { URL(string: "\(base)/projects/conversations")! }
    static var createProject: URL { URL(string: "\(base)/project")! }
    static func renameProject(_ projectId: String) -> URL { URL(string: "\(base)/project/rename?projectId=\(enc(projectId))")! }
    static func deleteProject(_ projectId: String) -> URL { URL(string: "\(base)/project?projectId=\(enc(projectId))")! }
    static func assignConversationProject(_ id: String, projectId: String) -> URL { URL(string: "\(base)/conversation/assign-project?conversationId=\(enc(id))&projectId=\(enc(projectId))")! }
    static func unassignConversationProject(_ id: String) -> URL { URL(string: "\(base)/conversation/unassign-project?conversationId=\(enc(id))")! }
    private static func enc(_ s: String) -> String { s.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-._~"))) ?? s }
    static func conversation(_ conversationId: String) -> URL { URL(string: "\(base)/conversation/\(conversationId)")! }
    static func deleteConversation(_ conversationId: String) -> URL { conversation(conversationId) }
    static var getAIUsage: URL { URL(string: "\(base)/message/usage")! }
    static var searchUsers: URL { URL(string: "\(base)/users/search")! }
    static var reports: URL { URL(string: "\(base)/reports")! }
    static var sharedItemOwner: URL { URL(string: "\(base)/shared-item/owner")! }
    static var blocks: URL { URL(string: "\(base)/blocks")! }
    static var getProfile: URL { URL(string: "\(base)/profile")! }
    static var updateUsername: URL { URL(string: "\(base)/profile/username")! }
    static var updateDiscoverability: URL { URL(string: "\(base)/profile/discoverability")! }
    static var attachments: URL { URL(string: "\(base)/attachments")! }
    static func attachmentUrl(_ attachmentId: String) -> URL { URL(string: "\(base)/attachments/url?attachmentId=\(enc(attachmentId))")! }
    static func learnedFacts(conversationId: String, messageId: String) -> URL { URL(string: "\(base)/conversation/learned-facts?conversationId=\(enc(conversationId))&messageId=\(enc(messageId))")! }
    static var getCustomerAgents: URL { URL(string: "\(base)/agents")! }
    static func forkAgent(_ graphId: String) -> URL { URL(string: "\(base)/agents/\(graphId)/fork")! }
    static var getProviders: URL { URL(string: "\(base)/providers")! }
    static var getRequestAgents: URL { URL(string: "\(base)/request-agents")! }
    static func requestAgentMapping(_ requestType: String) -> URL { URL(string: "\(base)/request-agents/\(enc(requestType))")! }
    static func agent(_ graphId: String) -> URL { URL(string: "\(base)/agents/\(enc(graphId))")! }
    // Embedding keys / models + vector-db
    static var getEmbeddingKeys: URL { URL(string: "\(base)/embedding-keys")! }
    static var storeEmbeddingKey: URL { URL(string: "\(base)/store-embedding-key")! }
    static var getEmbeddingModels: URL { URL(string: "\(base)/embedding-models")! }
    static func deleteEmbeddingKey(_ vendor: String) -> URL { URL(string: "\(base)/embedding-keys/\(enc(vendor))")! }
    static var storeVectorDBConfig: URL { URL(string: "\(base)/store-vector-db-config")! }
    // Usage / cost (from/to ISO dates). vector-db + web-search 404 → treat as "not tracked".
    static func usageLlm(from: String, to: String) -> URL { URL(string: "\(base)/usage/llm?from=\(enc(from))&to=\(enc(to))")! }
    static func usageEmbedding(from: String, to: String) -> URL { URL(string: "\(base)/usage/embedding?from=\(enc(from))&to=\(enc(to))")! }
    static func usageVectorDb(from: String, to: String) -> URL { URL(string: "\(base)/usage/vector-db?from=\(enc(from))&to=\(enc(to))")! }
    static func usageWebSearch(from: String, to: String) -> URL { URL(string: "\(base)/usage/web-search?from=\(enc(from))&to=\(enc(to))")! }
    // Onboarding FTUE
    static var completeOnboarding: URL { URL(string: "\(base)/profile/onboarding-completed")! }
    static var aiDataConsent: URL { URL(string: "\(base)/profile/ai-data-consent")! }
    // Tools + tool credentials (built-in web search, custom tools)
    static var customerTools: URL { URL(string: "\(base)/tools")! }
    static func customerTool(_ name: String) -> URL { URL(string: "\(base)/tools/\(enc(name))")! }
    static func customerToolDryRun(_ name: String) -> URL { URL(string: "\(base)/tools/\(enc(name))/dry-run")! }
    static var toolCredentials: URL { URL(string: "\(base)/tool-credentials")! }
    static func toolCredential(_ toolType: String) -> URL { URL(string: "\(base)/tool-credentials/\(enc(toolType))")! }
    // Connectors (OpenAPI / MCP)
    static var connectors: URL { URL(string: "\(base)/connectors")! }
    static func connector(_ id: String) -> URL { URL(string: "\(base)/connectors/\(enc(id))")! }
    static var connectorOpenApiPreview: URL { URL(string: "\(base)/connectors/openapi/preview")! }
    static var connectorOpenApiImport: URL { URL(string: "\(base)/connectors/openapi/import")! }
    static var connectorMcpDiscover: URL { URL(string: "\(base)/connectors/mcp/discover")! }
    static var connectorMcpConnect: URL { URL(string: "\(base)/connectors/mcp/connect")! }
    static var developerApiKeys: URL { URL(string: "\(base)/developer/api-keys")! }
    static func developerApiKey(_ keyId: String) -> URL { URL(string: "\(base)/developer/api-keys/\(keyId)")! }
}
