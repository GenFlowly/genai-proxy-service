import Foundation

// Mirrors src/models/memory.models.ts.

enum MemoryKind: String, Codable, Hashable, CaseIterable {
    case core = "CORE"
    case episodic = "EPISODIC"

    var label: String { L(self == .core ? "memoryPage.kinds.core" : "memoryPage.kinds.episodic") }
}

/// Where a memory applies: a project, or Profile when `projectId` is nil.
struct MemoryPlacement: Codable, Hashable {
    var projectId: String?
    var kind: MemoryKind
}

struct CustomerMemory: Codable, Identifiable, Equatable {
    var memoryId: String
    var text: String
    var kind: MemoryKind
    var category: String?
    var sourceType: String
    var sourceId: String?
    var createdAt: String
    var updatedAt: String
    var placements: [MemoryPlacement]
    var version: Int
    /// False for memories stored before versions were recorded.
    var tracked: Bool
    var hitCount: Int
    var lastUsedAt: String?

    var id: String { memoryId }

    var isProfile: Bool { placements.contains { $0.projectId == nil } }

    init(memoryId: String, text: String, kind: MemoryKind, category: String? = nil, sourceType: String = "USER",
         sourceId: String? = nil, createdAt: String = "", updatedAt: String = "", placements: [MemoryPlacement] = [],
         version: Int = 1, tracked: Bool = true, hitCount: Int = 0, lastUsedAt: String? = nil) {
        self.memoryId = memoryId
        self.text = text
        self.kind = kind
        self.category = category
        self.sourceType = sourceType
        self.sourceId = sourceId
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.placements = placements.isEmpty ? [MemoryPlacement(projectId: nil, kind: kind)] : placements
        self.version = version
        self.tracked = tracked
        self.hitCount = hitCount
        self.lastUsedAt = lastUsedAt
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        memoryId = try c.decode(String.self, forKey: .memoryId)
        text = try c.decode(String.self, forKey: .text)
        kind = (try? c.decode(MemoryKind.self, forKey: .kind)) ?? .episodic
        category = try c.decodeIfPresent(String.self, forKey: .category)
        sourceType = try c.decodeIfPresent(String.self, forKey: .sourceType) ?? "CONVERSATION"
        sourceId = try c.decodeIfPresent(String.self, forKey: .sourceId)
        createdAt = try c.decodeIfPresent(String.self, forKey: .createdAt) ?? ""
        updatedAt = try c.decodeIfPresent(String.self, forKey: .updatedAt) ?? ""
        let decoded = try c.decodeIfPresent([MemoryPlacement].self, forKey: .placements) ?? []
        placements = decoded.isEmpty ? [MemoryPlacement(projectId: nil, kind: kind)] : decoded
        version = try c.decodeIfPresent(Int.self, forKey: .version) ?? 1
        tracked = try c.decodeIfPresent(Bool.self, forKey: .tracked) ?? false
        hitCount = try c.decodeIfPresent(Int.self, forKey: .hitCount) ?? 0
        lastUsedAt = try c.decodeIfPresent(String.self, forKey: .lastUsedAt)
    }
}

/// One immutable change-log entry. The conversation title and the user's own words are read
/// live by the server, so they disappear with the conversation.
struct MemoryChange: Codable, Identifiable, Equatable {
    var changeId: String
    var type: String
    var createdAt: String
    var version: Int?
    var text: String?
    var previousText: String?
    var sourceType: String?
    var conversationId: String?
    var messageId: String?
    var noteKey: String?
    var reason: String?
    var from: [MemoryPlacement]?
    var to: [MemoryPlacement]?
    /// The extraction run behind this change, for "How it was inferred".
    var runId: String?
    var conversationTitle: String?
    var conversationAvailable: Bool?
    var youSaid: String?

    var id: String { changeId }
}

struct MemoryUsage: Codable, Identifiable, Equatable {
    var conversationId: String
    var messageId: String
    var usedAt: String
    var how: String
    var conversationTitle: String?
    var conversationAvailable: Bool?

    var id: String { "\(messageId)-\(usedAt)" }
}

struct MemoryUsagePage: Codable {
    var items: [MemoryUsage]
    var nextCursor: String?
    var total: Int
}

struct MemoryDetail: Codable {
    var memory: CustomerMemory
    var versions: [MemoryChange]
    var changes: [MemoryChange]
}

struct GetMemoriesResponse: Codable { var memories: [CustomerMemory]? }
struct MemoryResponse: Codable { var memory: CustomerMemory }
struct DeleteMemoryResult: Codable { var deleted: Bool? }
struct DeleteAllMemoriesResult: Codable { var deleted: Int? }

/// A Memory page list: Profile Core, Profile Episodic, or one project.
enum MemoryScope: Hashable {
    case profile(MemoryKind)
    case project(String)

    static let profileCore = MemoryScope.profile(.core)

    var projectId: String? {
        if case .project(let id) = self { return id }
        return nil
    }

    /// Key in `memoryCounts`: "core", "episodic" or the project id.
    var countKey: String {
        switch self {
        case .profile(let kind): return kind == .core ? "core" : "episodic"
        case .project(let id): return id
        }
    }

    func placement(of memory: CustomerMemory) -> MemoryPlacement? {
        switch self {
        case .profile(let kind): return memory.placements.first { $0.projectId == nil && $0.kind == kind }
        case .project(let id): return memory.placements.first { $0.projectId == id }
        }
    }

    /// The memories listed here, newest first.
    func memories(in all: [CustomerMemory]) -> [CustomerMemory] {
        all.filter { placement(of: $0) != nil }.sorted { $0.updatedAt > $1.updatedAt }
    }

    /// The list a memory is opened from when no list was given: where it first applies.
    static func of(_ memory: CustomerMemory) -> MemoryScope {
        let first = memory.placements.first
        if let id = first?.projectId { return .project(id) }
        return .profile(first?.kind ?? memory.kind)
    }
}

/// How many memories each list holds, keyed as `MemoryScope.countKey`.
func memoryCounts(_ memories: [CustomerMemory]) -> [String: Int] {
    var counts: [String: Int] = ["core": 0, "episodic": 0]
    for memory in memories {
        for placement in memory.placements {
            let key = placement.projectId ?? (placement.kind == .core ? "core" : "episodic")
            counts[key, default: 0] += 1
        }
    }
    return counts
}

// MARK: - How a memory was inferred (GET /memories/{memoryId}/inference/{runId})

struct MemoryRunResponse: Codable, Equatable {
    var messageId: String
    var vendor: String
    var model: String?
}

struct MemoryRunOperation: Codable, Equatable {
    var op: String
    var memoryId: String?
    var text: String?
    var reason: String?
    var messageIndex: Int?
    /// applied, noop or error
    var outcome: String
    /// The memory this operation made has since been deleted.
    var memoryDeleted: Bool?
}

struct MemoryRun: Codable, Equatable {
    var runId: String
    var source: String
    var conversationId: String?
    var projectId: String?
    var turnMessageId: String?
    var messageIds: [String] = []
    var responsesRead: [MemoryRunResponse] = []
    var existingShown: Int = 0
    var agentId: String?
    var vendor: String?
    var model: String?
    var startedAt: String
    var durationMs: Int
    var inputTokens: Int?
    var outputTokens: Int?
    var costUsd: Double?
    var operations: [MemoryRunOperation] = []
    var truncated: Bool?
}

struct MemoryInferenceExcerpt: Codable, Equatable, Identifiable {
    var messageId: String
    var role: String
    var vendor: String?
    var index: Int
    var text: String
    var taken: Bool
    var id: String { messageId }
}

struct MemoryInferenceChange: Codable, Equatable {
    var changeId: String
    var type: String
    var createdAt: String
    var version: Int?
    var reason: String?
    var messageId: String?
    var runId: String?
}

struct MemoryInference: Codable, Equatable {
    var memory: CustomerMemory
    var change: MemoryInferenceChange?
    var run: MemoryRun
    var excerpts: [MemoryInferenceExcerpt] = []
    var conversationTitle: String?
    var conversationDeleted: Bool
}
