import Foundation
import Combine

/// The Memory page's data (src/hooks/queries/useMemories.ts + memoriesService.ts): every
/// memory and the projects they can apply in. The last known list paints first and a fresh
/// fetch replaces it on every visit, since the assistant keeps learning in the background;
/// each mutation writes its result into the list and the cache itself.
@MainActor
final class MemoriesStore: ObservableObject {
    @Published var memories: [CustomerMemory] = []
    @Published var projects: [Project] = []
    @Published var isLoading = false
    @Published var loadFailed = false

    private weak var auth: AuthStore?
    private weak var history: HistoryStore?

    func configure(auth: AuthStore, history: HistoryStore) {
        self.auth = auth
        self.history = history
    }

    /// Logout wipe.
    func clear() {
        memories = []
        projects = []
        loadFailed = false
        isLoading = false
    }

    private var cacheKey: String? {
        auth?.customerId.map { StorageSuffix.customerKey($0, StorageSuffix.memories) }
    }

    var counts: [String: Int] { memoryCounts(memories) }

    func projectName(_ id: String) -> String {
        projects.first { $0.projectId == id }?.name
            ?? history?.projects.first { $0.projectId == id }?.name
            ?? L("memoryPage.scopes.unknownProject")
    }

    func load() async {
        if memories.isEmpty, let key = cacheKey, let cached = CacheStore.shared.read([CustomerMemory].self, key: key) {
            memories = cached
        }
        if projects.isEmpty, let known = history?.projects, !known.isEmpty {
            projects = known
        }
        guard let auth, auth.isAuthenticated else { return }
        let session = auth.customerId
        guard let token = try? await auth.getAccessTokenSilently() else { return }
        isLoading = true
        defer { isLoading = false }
        async let fetchedProjects = try? ConversationHistoryService.getProjects(token: token)
        do {
            let loaded = try await MemoriesService.list(token: token)
            guard session == auth.customerId else { return }
            memories = loaded
            loadFailed = false
            persist()
        } catch is CancellationError {
            return
        } catch {
            loadFailed = true
        }
        if let fresh = await fetchedProjects, session == auth.customerId { projects = fresh }
    }

    private func token() async throws -> String {
        guard let auth else { throw APIError(status: 401, message: "Not signed in") }
        return try await auth.getAccessTokenSilently()
    }

    private func persist() {
        if let key = cacheKey { CacheStore.shared.write(memories, key: key) }
    }

    private func apply(_ memory: CustomerMemory) {
        memories.removeAll { $0.memoryId == memory.memoryId }
        memories.insert(memory, at: 0)
        persist()
    }

    func create(text: String, kind: MemoryKind, projectId: String?) async throws -> CustomerMemory {
        let memory = try await MemoriesService.create(token: try await token(), text: text, kind: kind, projectId: projectId)
        apply(memory)
        return memory
    }

    func edit(_ memory: CustomerMemory, text: String) async throws -> CustomerMemory {
        let updated = try await MemoriesService.edit(token: try await token(), memoryId: memory.memoryId, text: text, baseVersion: memory.version)
        apply(updated)
        return updated
    }

    func move(_ memory: CustomerMemory, from: MemoryPlacement, toProjectId: String?, kind: MemoryKind) async throws -> CustomerMemory {
        let updated = try await MemoriesService.move(
            token: try await token(), memoryId: memory.memoryId,
            fromProjectId: from.projectId, toProjectId: toProjectId, kind: kind
        )
        apply(updated)
        return updated
    }

    func copy(_ memory: CustomerMemory, fromProjectId: String, toProjectId: String, kind: MemoryKind) async throws -> CustomerMemory {
        let updated = try await MemoriesService.copy(
            token: try await token(), memoryId: memory.memoryId,
            fromProjectId: fromProjectId, toProjectId: toProjectId, kind: kind
        )
        apply(updated)
        return updated
    }

    /// True when the memory is gone; false when it only left `projectId`.
    func delete(_ memoryId: String, projectId: String? = nil) async throws -> Bool {
        let deleted = try await MemoriesService.delete(token: try await token(), memoryId: memoryId, projectId: projectId)
        if deleted {
            memories.removeAll { $0.memoryId == memoryId }
        } else if let index = memories.firstIndex(where: { $0.memoryId == memoryId }) {
            memories[index].placements.removeAll { $0.projectId == projectId }
        }
        persist()
        return deleted
    }
}
