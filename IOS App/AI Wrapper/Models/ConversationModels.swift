import Foundation

/// Mirrors component-library ConversationWidget/conversation.models.ts + attachment.models.ts.

/// A web-search source backing an inline `[n]` citation marker in the response.
struct WebSource: Codable, Equatable, Hashable {
    var index: Int
    var title: String
    var url: String

    init(index: Int, title: String, url: String) {
        self.index = index
        self.title = title
        self.url = url
    }

    init?(json: JSONValue) {
        guard let index = json["index"]?.int else { return nil }
        self.index = index
        title = json["title"]?.string ?? ""
        url = json["url"]?.string ?? ""
    }
}

/// Reference to a file in the attachments bucket (uploaded image/PDF or generated artifact).
struct AttachmentRef: Codable, Equatable, Hashable {
    var attachmentId: String
    var s3Key: String?
    var mediaType: String?
    var filename: String?
    var sizeBytes: Int?

    var isPDF: Bool { mediaType == AttachmentRef.pdfMediaType }

    static let pdfMediaType = "application/pdf"
    static let unknownMediaType = "application/octet-stream"
    static let maxPerMessage = 10
    static let maxPDFsPerMessage = 5
    static let maxPDFBytes = 10 * 1024 * 1024
}

struct CreateAttachmentUploadResponse: Codable {
    var attachmentId: String
    var s3Key: String
    var mediaType: String
    var uploadUrl: String
}

struct GetAttachmentUrlResponse: Codable {
    var attachmentId: String
    var url: String
}

/// One fact the memory pipeline learned from an exchange.
struct LearnedFact: Codable, Equatable, Hashable, Identifiable {
    var memoryId: String
    var text: String
    var id: String { memoryId }
}

/// What the footer knows about a message's learned facts (web: undefined / null / array).
enum LearnedFactsState: Equatable {
    /// Generated this session — extraction runs async, so the UI polls.
    case fresh
    /// Loaded from history and the outcome isn't known.
    case unknown
    case known([LearnedFact])
}

struct TodoItem: Equatable {
    var content: String
    var status: String   // pending | in_progress | completed
}

struct ThinkingStepToolCall: Equatable {
    var name: String
    var args: [(String, JSONValue)] = []
    var sources: [WebSource] = []
    var error: String?

    static func == (lhs: ThinkingStepToolCall, rhs: ThinkingStepToolCall) -> Bool {
        lhs.signature == rhs.signature && lhs.sources == rhs.sources && lhs.error == rhs.error
    }

    /// `web_search(query="...", topic="news")` — strings quoted raw, everything else
    /// `JSON.stringify`'d; the same format the web prints.
    var signature: String {
        guard !args.isEmpty else { return name }
        let parts = args.map { key, value -> String in
            if case .string(let s) = value { return "\(key)=\"\(s)\"" }
            return "\(key)=\(value.jsonString)"
        }
        return "\(name)(\(parts.joined(separator: ", ")))"
    }

    init(name: String, args: [(String, JSONValue)] = [], sources: [WebSource] = [], error: String? = nil) {
        self.name = name
        self.args = args
        self.sources = sources
        self.error = error
    }

    init?(json: JSONValue) {
        guard let name = json["name"]?.string else { return nil }
        self.name = name
        args = json["args"]?.pairs ?? []
        sources = json["sources"]?.array?.compactMap(WebSource.init(json:)) ?? []
        error = json["error"]?.string
    }
}

/// One structured per-node step of the agent graph's thinking phase (the `ks` frame,
/// also persisted with the message). A node can appear more than once (graph cycles).
struct ThinkingStep: Equatable {
    var node: String
    var name: String
    var kind: String?          // LLM | MEMORY | RETRIEVAL | WEB_SEARCH | REFLECTION | TOOL
    var status: String         // running | done
    var label: String?
    var detail: String?
    var items: [String]?
    var prompt: String?
    var response: String?
    var sources: [WebSource]?
    var memoriesCore: [String]?
    var memoriesRecalled: [String]?
    var calls: [ThinkingStepToolCall]?
    var toolCalls: [ThinkingStepToolCall]?
    var reasoning: String?
    var todos: [TodoItem]?

    init(node: String, name: String, kind: String? = nil, status: String = "done") {
        self.node = node
        self.name = name
        self.kind = kind
        self.status = status
    }

    init?(json: JSONValue) {
        guard let node = json["node"]?.string, !node.isEmpty else { return nil }
        self.node = node
        name = json["name"]?.string ?? node
        kind = json["kind"]?.string
        status = json["status"]?.string ?? "running"
        label = json["label"]?.string
        detail = json["detail"]?.string
        items = json["items"]?.array?.compactMap(\.string)
        prompt = json["prompt"]?.string
        response = json["response"]?.string
        sources = json["sources"]?.array?.compactMap(WebSource.init(json:))
        if let memories = json["memories"] {
            memoriesCore = memories["core"]?.array?.compactMap(\.string) ?? []
            memoriesRecalled = memories["recalled"]?.array?.compactMap(\.string) ?? []
        }
        calls = json["calls"]?.array?.compactMap(ThinkingStepToolCall.init(json:))
        toolCalls = json["tool_calls"]?.array?.compactMap(ThinkingStepToolCall.init(json:))
        reasoning = json["reasoning"]?.string
        todos = json["todos"]?.array?.compactMap { item in
            guard let content = item["content"]?.string else { return nil }
            return TodoItem(content: content, status: item["status"]?.string ?? "pending")
        }
    }

    /// `{ ...existing, ...incoming }` for the fields a later event carries.
    func merging(_ incoming: ThinkingStep) -> ThinkingStep {
        var merged = self
        merged.name = incoming.name
        merged.kind = incoming.kind ?? kind
        merged.status = incoming.status
        merged.label = incoming.label ?? label
        merged.detail = incoming.detail ?? detail
        merged.items = incoming.items ?? items
        merged.prompt = incoming.prompt ?? prompt
        merged.response = incoming.response ?? response
        merged.sources = incoming.sources ?? sources
        merged.memoriesCore = incoming.memoriesCore ?? memoriesCore
        merged.memoriesRecalled = incoming.memoriesRecalled ?? memoriesRecalled
        merged.calls = incoming.calls ?? calls
        merged.toolCalls = incoming.toolCalls ?? toolCalls
        merged.reasoning = incoming.reasoning ?? reasoning
        merged.todos = incoming.todos ?? todos
        return merged
    }
}

/// Fold one `ks` event into the accumulated list (port of applyThinkingStep): an event
/// updates the latest entry for that node while it is still running; otherwise it
/// appends (first appearance, or a new graph cycle).
func applyThinkingStep(_ steps: [ThinkingStep], _ incoming: ThinkingStep) -> [ThinkingStep] {
    if let latest = steps.lastIndex(where: { $0.node == incoming.node }), steps[latest].status == "running" {
        var next = steps
        next[latest] = steps[latest].merging(incoming)
        return next
    }
    return steps + [incoming]
}

/// Display identity of the user who sent a prompt (matters in shared conversations).
struct MessageSender: Codable, Equatable {
    var customerId: String
    var name: String?
    var picture: String?
}

/// Represents a single AI model's response.
struct Message: Identifiable, Equatable {
    var aiVendor: AIVendor
    var text: String
    var messageId: String
    var previousMessageId: String?
    var isLoading: Bool = false
    /// Legacy flat thinking lines (the `k` frame).
    var thinkingSteps: [String] = []
    /// Structured per-node thinking steps (the `ks` frame), in arrival order.
    var thinkingStepList: [ThinkingStep] = []
    var thinkingDurationMs: Int?
    var stopReason: String?
    var webSources: [WebSource]?
    var generatedAttachments: [AttachmentRef]?
    /// Vendor failure for this response (the `err`/`done:error` frame). Not persisted.
    var error: String?
    var inputTokens: Int?
    var outputTokens: Int?
    var totalTokens: Int?
    var tokensReadFromCache: Int?
    var costUsd: Double?
    var model: String?
    var learnedFacts: LearnedFactsState = .fresh

    var id: String { messageId }

    var hasOwnUsage: Bool {
        inputTokens != nil || outputTokens != nil || totalTokens != nil || tokensReadFromCache != nil || costUsd != nil
    }

    /// Placeholder ids assigned client-side before the backend echoes the real one.
    var hasRealId: Bool { !messageId.hasPrefix("resp-") && !messageId.hasPrefix("error-") }
}

enum BlockStatus: String {
    case draft
    case resolved
}

/// A conversation block: the user's prompt plus the AI-generated responses.
struct ConversationBlock: Identifiable, Equatable {
    var conversationBlockId: String
    var prompt: String
    var attachments: [AttachmentRef] = []
    var responseMessages: [Message]
    var isLoading: Bool
    var status: BlockStatus
    /// When the prompt was sent (client on send; server's promptCreatedAt on load).
    var sentAt: Date?
    var sender: MessageSender?

    var id: String { conversationBlockId }
}

enum ConversationRole: String, Codable {
    case owner = "OWNER"
    case edit = "EDIT"
    case view = "VIEW"
}

/// Parses server timestamps: every backend time is UTC, some without a zone suffix
/// (timeUtils.parseServerDate).
enum ServerDate {
    private static let fractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private static let plain = ISO8601DateFormatter()

    static func parse(_ raw: String?) -> Date? {
        guard var s = raw?.trimmingCharacters(in: .whitespaces), !s.isEmpty else { return nil }
        s = s.replacingOccurrences(of: " ", with: "T")
        let hasZone = s.range(of: "(Z|[+-]\\d{2}:?\\d{2})$", options: [.regularExpression, .caseInsensitive]) != nil
        if !hasZone { s += "Z" }
        // Nanosecond timestamps: ISO8601DateFormatter only reads up to milliseconds.
        if let dot = s.firstIndex(of: "."), let end = s[dot...].firstIndex(where: { !$0.isNumber && $0 != "." }) {
            let fraction = s[s.index(after: dot)..<end]
            if fraction.count > 3 { s = String(s[..<s.index(dot, offsetBy: 4)]) + s[end...] }
        }
        return fractional.date(from: s) ?? plain.date(from: s)
    }

    /// "Oct 31, 2026, 08:43 PM" (formatServerDateTime).
    static func dateTime(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US")
        formatter.dateFormat = "MMM d, yyyy, hh:mm a"
        return formatter.string(from: date)
    }

    /// "08:43 PM" (formatServerTime).
    static func time(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US")
        formatter.dateFormat = "hh:mm a"
        return formatter.string(from: date)
    }

    /// "Oct 31, 2026" (formatServerDateOnly).
    static func dateOnly(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US")
        formatter.dateFormat = "MMM d, yyyy"
        return formatter.string(from: date)
    }
}
