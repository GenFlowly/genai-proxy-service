import Foundation

/// AI vendor identity. Data-driven: accepts ANY vendor string the backend sends
/// (e.g. "xai", "MOONSHOT") rather than a fixed enum, matching the web's dynamic
/// provider catalog — so a new BYOK vendor never breaks decoding. Equality is
/// case-insensitive; the original casing is preserved for round-tripping back to
/// the backend. Mirrors src/constants/vendors.ts (+ BYOK providers).
struct AIVendor: Codable, Hashable, Identifiable {
    let rawValue: String

    init(rawValue: String) { self.rawValue = rawValue }
    init(_ rawValue: String) { self.rawValue = rawValue }

    init(from decoder: Decoder) throws {
        rawValue = try decoder.singleValueContainer().decode(String.self)
    }
    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }

    static func == (lhs: AIVendor, rhs: AIVendor) -> Bool {
        lhs.rawValue.uppercased() == rhs.rawValue.uppercased()
    }
    func hash(into hasher: inout Hasher) { hasher.combine(rawValue.uppercased()) }

    var id: String { rawValue.uppercased() }

    static let openai = AIVendor(rawValue: "OPENAI")
    static let claude = AIVendor(rawValue: "CLAUDE")
    static let gemini = AIVendor(rawValue: "GEMINI")

    /// Name from the backend provider catalog — the single source of truth for
    /// vendor naming; a title-cased id until the catalog has loaded.
    var displayName: String { ProviderCatalog.shared.displayName(for: rawValue) }
}

/// Mirrors AIConfig in src/context/AIContext.tsx
struct AIConfig: Codable, Equatable, Hashable {
    var aiVendor: AIVendor
    var model: String
    /// Selected reasoning/thinking level for this vendor ("none"/"low"/"medium"/
    /// "high"); nil/"" = keep the vendor default.
    var thinkingLevel: String? = nil
}

/// Mirrors src/models/generateText.models.ts
struct Prompt: Codable {
    var instructionId: String
    var instructionVersion: String
    var prompt: String
    var attachments: [AttachmentRef] = []
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
    /// Agent (graph) to run through; nil = server default.
    var agentId: String?
    /// Project a brand-new conversation is created into (read only when conversationId is empty).
    var projectId: String?
    /// Regenerate: the user message id being regenerated, so the backend reuses it.
    var regenerateMessageId: String?
    /// Client-minted id usable with the cancel endpoint from the moment the
    /// request is sent — the server's responseMessageId only arrives in headers.
    var generationId: String?
    /// How many vendor responses the turn has (one stream request each). Memory learns
    /// once per turn, from all of them, after the last one.
    var turnResponseCount: Int?
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
