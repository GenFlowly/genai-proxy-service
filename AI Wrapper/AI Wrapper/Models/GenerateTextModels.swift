import Foundation

/// Mirrors src/constants/vendors.ts
enum AIVendor: String, Codable, CaseIterable, Identifiable {
    case openai = "OPENAI"
    case claude = "CLAUDE"
    case gemini = "GEMINI"

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .openai: return "OpenAI"
        case .claude: return "Claude"
        case .gemini: return "Gemini"
        }
    }
}

/// Mirrors AIConfig in src/context/AIContext.tsx
struct AIConfig: Codable, Equatable, Hashable {
    var aiVendor: AIVendor
    var model: String
}

/// Mirrors src/models/generateText.models.ts
struct Prompt: Codable {
    var instructionId: String
    var instructionVersion: String
    var prompt: String
}

struct GenerateTextRequest: Codable {
    var aiConfig: [AIConfig]
    var prompt: Prompt
    var selectedResponseId: String
    var conversationId: String
    var client: String
}

struct GenerateTextStreamRequest: Codable {
    var aiConfig: AIConfig
    var prompt: Prompt
    var selectedResponseId: String
    var conversationId: String
    var client: String
}

struct GenerateTextResponse: Codable {
    var text: String?
    var aiVendor: String?
    var messageId: String?
    var conversationId: String?
    var inputTokens: Int?
    var outputTokens: Int?
    var totalTokens: Int?
    var tokensReadFromCache: Int?
    var results: [GenerateTextResponse]?
}
