import Foundation

/// The agent activity log (contract v2): the retrieval server's `activity` events for
/// one turn, in stream order. Streamed live as `ac` frames and persisted with the
/// message; everything the activity panel shows comes from it. Mirrors
/// retrieval-server/activity/schema.py and the component library's activity.models.ts;
/// the test bundle's ActivityFixtures are copies of the shared golden logs.
enum ActivityContract {
    static let version = 2
}

enum ActivityEventType: String {
    case turnStart = "turn.start"
    case stepStart = "step.start"
    case stepProgress = "step.progress"
    /// A streaming llm step began writing a tool call: its text so far was a preamble.
    case stepCalling = "step.calling"
    /// A streaming llm step has written more text than a tool-call preamble runs to, and no
    /// tool call: it is writing the answer, unless a `step.calling` still follows.
    case stepWriting = "step.writing"
    case stepCall = "step.call"
    case stepEnd = "step.end"
    case turnEnd = "turn.end"
}

/// A citable source with the site icon and publish date when the tool had them.
struct ActivitySource: Equatable {
    var index: Int
    var title: String
    var url: String
    var favicon: String?
    /// As the provider sent it (RFC 1123 or ISO); a calendar date, shown in UTC.
    var publishedDate: String?

    init?(json: JSONValue) {
        guard let index = json["index"]?.int else { return nil }
        self.index = index
        title = json["title"]?.string ?? ""
        url = json["url"]?.string ?? ""
        favicon = json["favicon"]?.string
        publishedDate = json["published_date"]?.string
    }
}

/// What a tool call is about and why the agent made it, from its arguments.
struct ActivityCallArguments: Equatable {
    var mainArgument: String?
    var purpose: String?

    init(json: JSONValue?) {
        func text(_ key: String) -> String? {
            guard let value = json?[key]?.string?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else { return nil }
            return value
        }
        mainArgument = text("query") ?? text("prompt") ?? text("path") ?? text("title") ?? text("filename")
        purpose = text("purpose")
    }
}

/// A tool call as the model requested it.
struct ActivityToolRequest: Equatable {
    var id: String
    var name: String
    var arguments: ActivityCallArguments

    init?(json: JSONValue) {
        guard let name = json["name"]?.string else { return nil }
        id = json["id"]?.string ?? ""
        self.name = name
        arguments = ActivityCallArguments(json: json["args"])
    }
}

/// One executed tool call: what ran, how the budget treated it, what came back.
struct ActivityToolCall: Equatable {
    var id: String?
    var seq: Int?
    var name: String
    var arguments: ActivityCallArguments
    /// run | note | skip | exhausted
    var mode: String
    var durationMs: Int?
    var resultCount: Int?
    var resultExcerpt: String?
    var sources: [ActivitySource]
    var error: String?
    var hasDetails: Bool

    init?(json: JSONValue) {
        guard let name = json["name"]?.string, let mode = json["mode"]?.string else { return nil }
        id = json["id"]?.string
        seq = json["seq"]?.int
        self.name = name
        arguments = ActivityCallArguments(json: json["args"])
        self.mode = mode
        durationMs = json["duration_ms"]?.int
        resultCount = json["result_count"]?.int
        resultExcerpt = json["result_excerpt"]?.string
        sources = json["sources"]?.array?.compactMap(ActivitySource.init(json:)) ?? []
        error = json["error"]?.string
        hasDetails = !(json["details"]?.pairs ?? []).isEmpty
    }
}

struct ActivityEvent: Equatable {
    var type: ActivityEventType
    /// Milliseconds since the turn started; nil for history converted from the old format.
    var at: Int?
    var id: String?
    var kind: String?
    var node: String?
    var name: String?
    var durationMs: Int?
    var interrupted = false
    /// memory
    var countsCore: Int?
    var countsRecalled: Int?
    /// memory; present only for the turn's author
    var memoriesCore: [String]?
    var memoriesRecalled: [String]?
    /// llm
    var outcome: String?
    var firstTokenMs: Int?
    var reasoning: String?
    var toolCalls: [ActivityToolRequest]?
    var summary: String?
    /// llm; present only for the turn's author
    var developerPrompt: String?
    var developerResponse: String?
    /// tools
    var calls: [ActivityToolCall]?
    var budgetUsed: Int?
    var budgetMax: Int?
    var todos: [TodoItem]?
    /// step.call
    var call: ActivityToolCall?
    /// turn.end: completed | error, and the source indices the answer cites.
    var turnOutcome: String?
    var cited: [Int]?

    /// nil for anything that is not a v2 activity event.
    init?(json: JSONValue) {
        guard json["v"]?.int == ActivityContract.version,
              let rawType = json["type"]?.string,
              let type = ActivityEventType(rawValue: rawType) else { return nil }
        self.type = type
        at = json["at"]?.int
        id = json["id"]?.string
        kind = json["kind"]?.string
        node = json["node"]?.string
        name = json["name"]?.string
        durationMs = json["duration_ms"]?.int
        interrupted = json["interrupted"]?.boolean ?? false
        if let counts = json["counts"] {
            countsCore = counts["core"]?.int ?? 0
            countsRecalled = counts["recalled"]?.int ?? 0
        }
        if let memories = json["memories"] {
            memoriesCore = memories["core"]?.array?.compactMap(\.string) ?? []
            memoriesRecalled = memories["recalled"]?.array?.compactMap(\.string) ?? []
        }
        firstTokenMs = json["first_token_ms"]?.int
        reasoning = json["reasoning"]?.string
        toolCalls = json["tool_calls"]?.array?.compactMap(ActivityToolRequest.init(json:))
        summary = json["summary"]?.string
        developerPrompt = json["developer"]?["prompt_excerpt"]?.string
        developerResponse = json["developer"]?["response_excerpt"]?.string
        calls = json["calls"]?.array?.compactMap(ActivityToolCall.init(json:))
        budgetUsed = json["budget"]?["used"]?.int
        budgetMax = json["budget"]?["max"]?.int
        todos = json["todos"]?.array?.compactMap { item in
            guard let content = item["content"]?.string else { return nil }
            return TodoItem(content: content, status: item["status"]?.string ?? "pending")
        }
        call = json["call"].flatMap(ActivityToolCall.init(json:))
        if type == .turnEnd {
            turnOutcome = json["outcome"]?.string
        } else {
            outcome = json["outcome"]?.string
        }
        cited = json["cited"]?.array?.compactMap(\.int)
    }
}
