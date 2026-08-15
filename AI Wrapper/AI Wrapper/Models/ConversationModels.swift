import Foundation

/// Mirrors src/models/conversation.models.ts

/// Represents a single AI model's response.
struct Message: Identifiable, Equatable {
    var aiVendor: AIVendor
    var text: String
    var messageId: String
    var previousMessageId: String?
    var isLoading: Bool = false
    var thinkingSteps: [String] = []
    var inputTokens: Int?
    var outputTokens: Int?
    var totalTokens: Int?
    var tokensReadFromCache: Int?

    var id: String { messageId }
}

enum BlockStatus: String {
    case draft
    case resolved
}

/// A conversation block: the user's prompt plus the AI-generated responses.
struct ConversationBlock: Identifiable, Equatable {
    var conversationBlockId: String
    var prompt: String
    var responseMessages: [Message]
    var isLoading: Bool
    var status: BlockStatus

    var id: String { conversationBlockId }
}

enum ConversationRole: String, Codable {
    case owner = "OWNER"
    case edit = "EDIT"
    case view = "VIEW"
}
