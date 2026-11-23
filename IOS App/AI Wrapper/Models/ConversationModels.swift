import Foundation

/// Mirrors component-library ConversationWidget/conversation.models.ts + attachment.models.ts.

/// A web-search source backing an inline `[n]` citation marker in the response.
struct WebSource: Codable, Equatable, Hashable {
    var index: Int
    var title: String
    var url: String
    /// The site's icon URL, when the search provider returned one.
    var favicon: String?
    /// Publish date as the provider sent it; a calendar date.
    var publishedDate: String?

    init(index: Int, title: String, url: String, favicon: String? = nil, publishedDate: String? = nil) {
        self.index = index
        self.title = title
        self.url = url
        self.favicon = favicon
        self.publishedDate = publishedDate
    }

    init?(json: JSONValue) {
        guard let index = json["index"]?.int else { return nil }
        self.index = index
        title = json["title"]?.string ?? ""
        url = json["url"]?.string ?? ""
        favicon = json["favicon"]?.string
        publishedDate = json["published_date"]?.string
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
    /// CORE or EPISODIC; absent on facts learned before kinds were sent.
    var kind: String? = nil
    /// The extraction run that learned it, for "How it was inferred".
    var runId: String? = nil
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
    /// The turn's activity log (the `ac` frames, and as persisted), in stream order.
    var activity: [ActivityEvent] = []
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
