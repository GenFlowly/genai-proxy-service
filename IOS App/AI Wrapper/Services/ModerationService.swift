import Foundation

// MARK: - Report and Block (src/services/moderationService.ts)

enum ReportReason: String, CaseIterable, Encodable, Identifiable {
    case spam = "SPAM", harassment = "HARASSMENT", hate = "HATE", sexual = "SEXUAL"
    case violence = "VIOLENCE", illegal = "ILLEGAL", other = "OTHER"

    var id: String { rawValue }
    var label: String { L("moderation.report.reasons.\(rawValue)") }
}

/// An item shared with the signed-in user.
enum SharedItem: Equatable, Hashable {
    case conversation(String)
    case instruction(String)

    var entityId: String {
        switch self {
        case .conversation(let id), .instruction(let id): return id
        }
    }

    var entityType: String {
        switch self {
        case .conversation: return "CONVERSATION"
        case .instruction: return "INSTRUCTION"
        }
    }

    var isConversation: Bool {
        if case .conversation = self { return true }
        return false
    }
}

struct SharedItemOwner: Decodable, Equatable {
    let ownerCustomerId: String
    var ownerUsername: String?
    var ownerName: String?
    var canBlock: Bool
    var canRemove: Bool
    var alreadyReported: Bool

    /// How the owner is named in the menu and dialogs.
    var label: String {
        if let ownerUsername, !ownerUsername.isEmpty { return "@\(ownerUsername)" }
        if let ownerName, !ownerName.isEmpty { return ownerName }
        return L("moderation.theOwner")
    }
}

struct BlockedUser: Decodable, Identifiable, Equatable {
    let customerId: String
    var username: String?
    var name: String?
    let blockedAt: String

    var id: String { customerId }

    var label: String {
        if let username, !username.isEmpty { return "@\(username)" }
        if let name, !name.isEmpty { return name }
        return L("moderation.blockedUsers.unknownUser")
    }

    var initials: String {
        let source = name ?? username ?? "?"
        return String(source.split(whereSeparator: \.isWhitespace).compactMap(\.first).prefix(2)).uppercased()
    }
}

/// Why the server refused to let content reach someone else.
enum ModerationRefusal: String, Equatable {
    case contentBlocked = "CONTENT_BLOCKED"
    case blocked = "BLOCKED"

    init?(error: Error) {
        guard let body = (error as? APIError)?.body else { return nil }
        self.init(body: body)
    }

    init?(body: Data) {
        struct Refusal: Decodable { let code: String? }
        guard let code = (try? JSONDecoder().decode(Refusal.self, from: body))?.code else { return nil }
        self.init(rawValue: code)
    }

    var shareMessage: String {
        switch self {
        case .contentBlocked: return L("moderation.shareRefusedByFilter")
        case .blocked: return L("moderation.shareRefusedByBlock")
        }
    }
}

/// The report form's fields and the limit the API enforces.
struct ReportForm: Equatable {
    static let detailsMax = 1000

    var reason: ReportReason?
    var details = ""

    var canSend: Bool { reason != nil }

    var trimmedDetails: String? {
        let trimmed = details.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    static func clip(_ text: String) -> String {
        text.count > detailsMax ? String(text.prefix(detailsMax)) : text
    }
}

enum ModerationService {
    private struct ReportRequest: Encodable {
        let entityType: String
        let entityId: String
        let reason: ReportReason
        let details: String?
    }

    private struct BlockRequest: Encodable { let customerId: String }

    static func owner(token: String, item: SharedItem) async throws -> SharedItemOwner {
        var components = URLComponents(url: Endpoints.sharedItemOwner, resolvingAgainstBaseURL: false)!
        components.queryItems = [
            URLQueryItem(name: "entityType", value: item.entityType),
            URLQueryItem(name: "entityId", value: item.entityId),
        ]
        return try await APIClient.requestJSON(components.url!, token: token, as: SharedItemOwner.self)
    }

    static func report(token: String, item: SharedItem, reason: ReportReason, details: String?) async throws {
        let body = ReportRequest(entityType: item.entityType, entityId: item.entityId, reason: reason, details: details)
        _ = try await APIClient.request(Endpoints.reports, method: .post, token: token, body: body)
    }

    static func blockedUsers(token: String) async throws -> [BlockedUser] {
        try await APIClient.requestJSON(Endpoints.blocks, token: token, as: [BlockedUser].self)
    }

    static func block(token: String, customerId: String) async throws {
        _ = try await APIClient.request(Endpoints.blocks, method: .post, token: token, body: BlockRequest(customerId: customerId))
    }

    static func unblock(token: String, customerId: String) async throws {
        _ = try await APIClient.request(Endpoints.blocks.appendingPathComponent(customerId), method: .delete, token: token)
    }
}
