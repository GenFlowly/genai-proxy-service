import Foundation

/// Which backend + Auth0 settings the app uses.
/// Debug builds (Run from Xcode, simulator) → development.
/// Release builds (Archive, TestFlight, App Store) → production.
/// To force production in a Debug run: Edit Scheme → Run → Arguments → add `--env-production`.
enum AppEnvironment {
    case development
    case production

    static var current: AppEnvironment {
        if CommandLine.arguments.contains("--env-production") { return .production }
        #if DEBUG
        return .development
        #else
        return .production
        #endif
    }
}

/// Mirrors genai-react-app env files: .env.development / .env.production
enum AppConfig {
    struct Auth0Settings {
        let domain: String
        let clientId: String
        let audience: String
    }

    static let backendBaseURL: URL = {
        switch AppEnvironment.current {
        case .development: return URL(string: "https://api-development.genflowly.com")!
        case .production: return URL(string: "https://genflowly.com")!
        }
    }()

    static let auth0: Auth0Settings = {
        switch AppEnvironment.current {
        case .development:
            return Auth0Settings(
                domain: "auth.genflowly.com",
                clientId: "7uXHWmLk1uPO3u5y98sKsNnYzCxCTTNX",   // "AI Wrapper IOS" Native app (dev)
                audience: "https://api-development.genflowly.com"
            )
        case .production:
            return Auth0Settings(
                domain: "auth.genflowly.com",
                // TODO: create a production Native app in Auth0 (same callback URL,
                // authorized for the production API) and put its client ID here.
                clientId: "REPLACE_WITH_PROD_IOS_CLIENT_ID",
                audience: "https://api.genflowly.com"
            )
        }
    }()

    enum Auth0 {
        static var domain: String { AppConfig.auth0.domain }
        static var clientId: String { AppConfig.auth0.clientId }
        static var audience: String { AppConfig.auth0.audience }
        static let scope = "openid profile email offline_access"

        // Must be registered in the Auth0 application's "Allowed Callback URLs".
        static let bundleId = "nkirit.AI-Wrapper"
        static var callbackURL: String { "\(bundleId)://\(domain)/ios/\(bundleId)/callback" }
        static let callbackScheme = bundleId
    }
}

/// Mirrors genai-react-app/src/config/endpoints.ts
enum Endpoints {
    private static var base: String { AppConfig.backendBaseURL.absoluteString + "/api/v1" }

    static var onboardCustomer: URL { URL(string: "\(base)/onboard")! }
    static var getCustomerProfile: URL { URL(string: "\(base)/customer/profile")! }
    static var storeCustomerVendorApiKey: URL { URL(string: "\(base)/store-api-key")! }
    static var storeCustomerVectorDBConfig: URL { URL(string: "\(base)/store-vector-db-config")! }
    static var storeCustomerSupabaseConfig: URL { URL(string: "\(base)/store-supabase-config")! }
    static var generateText: URL { URL(string: "\(base)/generate-text")! }
    static var generateTextStream: URL { URL(string: "\(base)/generate-text-stream")! }
    static var getTextGenerationModels: URL { URL(string: "\(base)/models")! }
    static var saveAIConfig: URL { URL(string: "\(base)/save-ai-config")! }
    static var createInstruction: URL { URL(string: "\(base)/instruction")! }
    static var getCustomerInstructions: URL { URL(string: "\(base)/instructions")! }
    static var createConversationTitle: URL { URL(string: "\(base)/conversation/title")! }
    static var conversationShare: URL { URL(string: "\(base)/conversation/share")! }
    static func conversationSharedUsers(_ conversationId: String) -> URL { URL(string: "\(base)/conversation/\(conversationId)/shared")! }
    static var getCustomerConversations: URL { URL(string: "\(base)/conversations")! }
    static func conversation(_ conversationId: String) -> URL { URL(string: "\(base)/conversation/\(conversationId)")! }
    static func deleteConversation(_ conversationId: String) -> URL { conversation(conversationId) }
    static func unarchiveConversation(_ conversationId: String) -> URL { URL(string: "\(base)/conversation/\(conversationId)/unarchive")! }
    static var getAIUsage: URL { URL(string: "\(base)/message/usage")! }
    static var searchUsers: URL { URL(string: "\(base)/users/search")! }
    static var getProfile: URL { URL(string: "\(base)/profile")! }
    static var updateUsername: URL { URL(string: "\(base)/profile/username")! }
    static var updateDiscoverability: URL { URL(string: "\(base)/profile/discoverability")! }
    static var getCustomerAgents: URL { URL(string: "\(base)/agents")! }
    static var developerApiKeys: URL { URL(string: "\(base)/developer/api-keys")! }
    static func developerApiKey(_ keyId: String) -> URL { URL(string: "\(base)/developer/api-keys/\(keyId)")! }
}
