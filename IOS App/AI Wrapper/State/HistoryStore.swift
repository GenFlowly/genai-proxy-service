import Foundation
import SwiftUI
import Combine

/// Drives the history menu — a port of ConversationHistoryComponent's data logic:
/// Projects (lazy per-project members), Pinned and Recents (cursor pagination), with
/// a stale-while-revalidate cache and optimistic pin/move/archive.
@MainActor
final class HistoryStore: ObservableObject {
    private static let pageSize = 15
    private static let projectPageSize = 50
    /// A failed older History page retries itself after these delays, then stops. There is no
    /// Load more button: older pages stream in as the end of the list nears.
    private static let pageRetryDelays: [Duration] = [.seconds(2), .seconds(5), .seconds(15), .seconds(30)]

    struct CacheState: Codable {
        var items: [ConversationSummary]
        var pinned: [ConversationSummary]
        var lastKey: String?
        var hasMore: Bool
        var projects: [Project]
        var projectItems: [String: [ConversationSummary]]
    }

    @Published var items: [ConversationSummary] = []
    @Published var pinned: [ConversationSummary] = []
    @Published var projects: [Project] = []
    @Published var projectItems: [String: [ConversationSummary]] = [:]
    @Published var projectCursors: [String: String] = [:]
    @Published var lastKey: String?
    @Published var hasMore = false
    @Published var isLoading = false
    @Published var loadFailed = false
    private var pageRetries = 0
    /// Session-scoped expansion memory (web: deliberately not persisted).
    @Published var expandedSections: [String: Bool] = [:]
    @Published var expandedProjects: [String: Bool] = [:]

    private weak var auth: AuthStore?
    private weak var toasts: ToastCenter?
    private var hasLoaded = false
    private var loadedProjects: Set<String> = []
    /// Conversations assigned to a project this session: a members fetch landing right
    /// after an assignment can predate the projectIndex GSI catching up.
    private var optimisticMembers: [String: [ConversationSummary]] = [:]
    private var attachedCustomerId: String?

    func configure(auth: AuthStore, toasts: ToastCenter) {
        self.auth = auth
        self.toasts = toasts
    }

    // MARK: - Cache

    private var cacheKey: String? {
        auth?.customerId.map { StorageSuffix.customerKey($0, StorageSuffix.conversationHistory) }
    }

    private func paintFromCache() {
        guard attachedCustomerId != auth?.customerId else { return }
        attachedCustomerId = auth?.customerId
        items = []; pinned = []; projects = []; projectItems = [:]; projectCursors = [:]
        lastKey = nil; hasMore = false; hasLoaded = false
        loadedProjects = []; optimisticMembers = [:]
        guard let key = cacheKey, let cached = CacheStore.shared.read(CacheState.self, key: key) else { return }
        items = cached.items
        pinned = cached.pinned
        lastKey = cached.lastKey
        hasMore = cached.hasMore
        projects = cached.projects
        projectItems = cached.projectItems
        hasLoaded = true
    }

    private func persist() {
        guard hasLoaded, let key = cacheKey else { return }
        CacheStore.shared.write(CacheState(items: items, pinned: pinned, lastKey: lastKey, hasMore: hasMore, projects: projects, projectItems: projectItems), key: key)
    }

    // MARK: - Loading

    func load() async {
        paintFromCache()
        async let page: Void = fetchPage(startKey: nil)
        async let pins: Void = fetchPinned()
        async let projs: Void = fetchProjects()
        _ = await (page, pins, projs)
        ensureExpandedProjectsLoaded(activeId: nil)
    }

    /// Everything held for the account, at logout.
    func clear() {
        attachedCustomerId = nil
        items = []; pinned = []; projects = []; projectItems = [:]; projectCursors = [:]
        lastKey = nil; hasMore = false; hasLoaded = false; loadFailed = false
        loadedProjects = []; optimisticMembers = [:]
        expandedSections = [:]; expandedProjects = [:]
    }

    func fetchPage(startKey: String?) async {
        guard let auth, auth.isAuthenticated else { return }
        let session = auth.customerId
        isLoading = true
        loadFailed = false
        defer { isLoading = false }
        guard let token = try? await auth.getAccessTokenSilently() else { return }
        do {
            let response = try await ConversationHistoryService.getCustomerConversations(token: token, pageSize: Self.pageSize, lastEvaluatedKey: startKey)
            guard session == auth.customerId else { return }
            hasLoaded = true
            if startKey != nil {
                let existing = Set(items.map(\.conversationId))
                items += response.conversations.filter { !existing.contains($0.conversationId) }
            } else {
                items = response.conversations
            }
            lastKey = response.lastEvaluatedKey
            hasMore = response.lastEvaluatedKey != nil
            pageRetries = 0
            persist()
            // The server filters archived rows out after reading a page, so a page can come back
            // empty with more behind it. Don't let that read as the end of the list.
            if response.conversations.isEmpty, let next = response.lastEvaluatedKey, next != startKey {
                await fetchPage(startKey: next)
            }
        } catch is CancellationError {
            // Not a failure: SwiftUI cancels a pull-to-refresh's task, for one. Counting it as one
            // paused auto-loading and showed the old Load more button (L2-002).
        } catch {
            loadFailed = true
            if let startKey { scheduleRetry(startKey) }
        }
    }

    private func scheduleRetry(_ startKey: String) {
        guard pageRetries < Self.pageRetryDelays.count else { return }
        let delay = Self.pageRetryDelays[pageRetries]
        pageRetries += 1
        Task { [weak self] in
            try? await Task.sleep(for: delay)
            guard let self, self.loadFailed, self.lastKey == startKey else { return }
            await self.fetchPage(startKey: startKey)
        }
    }

    func loadMore() async {
        guard hasMore, !isLoading, !loadFailed, let lastKey else { return }
        await fetchPage(startKey: lastKey)
    }

    private func fetchPinned() async {
        guard let auth, auth.isAuthenticated else { return }
        let session = auth.customerId
        guard let token = try? await auth.getAccessTokenSilently() else { return }
        // A failed pinned refresh must not take down the history list.
        guard let conversations = try? await ConversationHistoryService.getPinnedConversations(token: token),
              session == auth.customerId else { return }
        pinned = conversations
        persist()
    }

    private func fetchProjects() async {
        guard let auth, auth.isAuthenticated else { return }
        let session = auth.customerId
        guard let token = try? await auth.getAccessTokenSilently() else { return }
        guard let list = try? await ConversationHistoryService.getProjects(token: token),
              session == auth.customerId else { return }
        projects = list
        persist()
    }

    /// A project's members from `startKey` through its last page, so an expanded project always
    /// shows all of them (there is no Load more row).
    func fetchProjectConversations(_ projectId: String, startKey: String? = nil) async {
        var cursor = startKey
        repeat {
            guard let next = await fetchProjectPage(projectId, startKey: cursor), next != cursor else { return }
            cursor = next
        } while cursor != nil
    }

    /// One page of a project's members. Returns the next cursor (`.some(nil)` on the last page),
    /// or nil when the fetch failed.
    private func fetchProjectPage(_ projectId: String, startKey: String?) async -> String?? {
        guard let auth, auth.isAuthenticated else { return nil }
        let session = auth.customerId
        guard let token = try? await auth.getAccessTokenSilently() else { return nil }
        guard let response = try? await ConversationHistoryService.getProjectConversations(token: token, projectId: projectId, pageSize: Self.projectPageSize, lastEvaluatedKey: startKey) else { return nil }
        hasLoaded = true
        let pending = optimisticMembers[projectId] ?? []
        let confirmed = Set(response.conversations.map(\.conversationId))
        let stillPending = pending.filter { !confirmed.contains($0.conversationId) }
        optimisticMembers[projectId] = stillPending
        if startKey != nil {
            let existing = Set((projectItems[projectId] ?? []).map(\.conversationId))
            projectItems[projectId, default: []] += response.conversations.filter { !existing.contains($0.conversationId) }
        } else {
            projectItems[projectId] = stillPending + response.conversations
        }
        projectCursors[projectId] = response.lastEvaluatedKey
        persist()
        return .some(response.lastEvaluatedKey)
    }

    func ensureProjectLoaded(_ projectId: String) {
        guard !loadedProjects.contains(projectId) else { return }
        loadedProjects.insert(projectId)
        Task { await fetchProjectConversations(projectId) }
    }

    /// Projects that render expanded (session memory, or holding the active conversation)
    /// need their members without waiting for a re-toggle; everything else stays lazy.
    func ensureExpandedProjectsLoaded(activeId: String?) {
        let activeProjectId = activeId.flatMap { id in (pinned + items).first { $0.conversationId == id }?.projectId }
        for project in projects {
            let members = projectItems[project.projectId] ?? []
            let containsActive = activeId != nil && (project.projectId == activeProjectId || members.contains { $0.conversationId == activeId })
            let remembered = expandedProjects[project.projectId]
            if remembered ?? containsActive {
                ensureProjectLoaded(project.projectId)
                // The active conversation's project opens on its own; a user's collapse wins.
                if containsActive, remembered == nil { expandedProjects[project.projectId] = true }
            }
        }
    }

    // MARK: - Expansion

    func isSectionExpanded(_ id: String) -> Bool { expandedSections[id] ?? true }

    func toggleSection(_ id: String) { expandedSections[id] = !isSectionExpanded(id) }

    func isProjectExpanded(_ id: String) -> Bool { expandedProjects[id] ?? false }

    func toggleProject(_ id: String) {
        let next = !isProjectExpanded(id)
        expandedProjects[id] = next
        if next { ensureProjectLoaded(id) }
    }

    // MARK: - Derived sections

    private var pinnedIds: Set<String> { Set(pinned.map(\.conversationId)) }
    private var projectIds: Set<String> { Set(projects.map(\.projectId)) }

    private func inProject(_ c: ConversationSummary) -> Bool {
        guard let id = c.projectId else { return false }
        return projectIds.contains(id)
    }

    /// Pinned conversations render only in a Pinned section; assigned conversations are
    /// excluded from the global sections. A dangling projectId falls through to global.
    var globalPinned: [ConversationSummary] { pinned.filter { !inProject($0) } }
    var globalRecent: [ConversationSummary] {
        let pinnedSet = pinnedIds
        return items.filter { !pinnedSet.contains($0.conversationId) && !inProject($0) }
    }

    func projectPinned(_ id: String) -> [ConversationSummary] { (projectItems[id] ?? []).filter(\.isPinned) }
    func projectRecent(_ id: String) -> [ConversationSummary] { (projectItems[id] ?? []).filter { !$0.isPinned } }

    var hasAnyData: Bool { !items.isEmpty || !pinned.isEmpty || !projects.isEmpty }

    // MARK: - Mutations

    /// Deletes the conversation for good. Throws when the delete failed, and the lists keep it.
    func delete(_ conversation: ConversationSummary, activeId: String?, onDeletedActive: () -> Void) async throws {
        guard let token = try await auth?.getAccessTokenSilently() else { return }
        do {
            try await ConversationHistoryService.deleteConversation(token: token, conversationId: conversation.conversationId)
        } catch {
            AppObservability.capture(error, context: ["where": "deleteConversation"])
            throw error
        }
        items.removeAll { $0.conversationId == conversation.conversationId }
        pinned.removeAll { $0.conversationId == conversation.conversationId }
        removeFromProjectItems(conversation.conversationId)
        persist()
        if conversation.conversationId == activeId { onDeletedActive() }
    }

    func pin(_ conversation: ConversationSummary) async {
        let now = ISO8601DateFormatter().string(from: Date())
        var updated = conversation
        updated.pinnedAt = now
        pinned = [updated] + pinned.filter { $0.conversationId != conversation.conversationId }
        patchProjectItems(conversation.conversationId) { $0.pinnedAt = now }
        do {
            guard let token = try await auth?.getAccessTokenSilently() else { return }
            try await ConversationHistoryService.pinConversation(token: token, conversationId: conversation.conversationId)
            toasts?.showToast(L("conversation.conversationHistory.pinnedToast"))
            persist()
        } catch {
            pinned.removeAll { $0.conversationId == conversation.conversationId }
            patchProjectItems(conversation.conversationId) { $0.pinnedAt = nil }
            toasts?.showToast(L("conversation.conversationHistory.pinFailed"))
        }
    }

    func unpin(_ conversation: ConversationSummary) async {
        let previous = pinned
        pinned.removeAll { $0.conversationId == conversation.conversationId }
        // A pinned conversation older than the loaded pages may not be in `items` yet.
        if !items.contains(where: { $0.conversationId == conversation.conversationId }) {
            var restored = conversation
            restored.pinnedAt = nil
            items.append(restored)
            items.sort { ($0.updatedAt ?? $0.createdAt ?? "") > ($1.updatedAt ?? $1.createdAt ?? "") }
        }
        patchProjectItems(conversation.conversationId) { $0.pinnedAt = nil }
        do {
            guard let token = try await auth?.getAccessTokenSilently() else { return }
            try await ConversationHistoryService.unpinConversation(token: token, conversationId: conversation.conversationId)
            toasts?.showToast(L("conversation.conversationHistory.unpinnedToast"))
            persist()
        } catch {
            pinned = previous
            patchProjectItems(conversation.conversationId) { $0.pinnedAt = conversation.pinnedAt }
            toasts?.showToast(L("conversation.conversationHistory.unpinFailed"))
        }
    }

    func createProject(name: String) async -> Bool {
        guard let token = try? await auth?.getAccessTokenSilently() else { return false }
        do {
            let project = try await ConversationHistoryService.createProject(token: token, name: name)
            // The server lists most-recently-updated first, so prepend.
            projects.insert(project, at: 0)
            expandedProjects[project.projectId] = true
            persist()
            toasts?.showToast(L("conversation.conversationHistory.projectCreated"))
            return true
        } catch {
            toasts?.showToast(L("conversation.conversationHistory.createProjectFailed"))
            return false
        }
    }

    /// Renames the project everywhere the menu shows its name. False when the rename failed.
    func renameProject(_ project: Project, to name: String) async -> Bool {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let token = try? await auth?.getAccessTokenSilently() else { return false }
        do {
            try await ConversationHistoryService.renameProject(token: token, projectId: project.projectId, name: trimmed)
        } catch {
            AppObservability.capture(error, context: ["where": "renameProject"])
            toasts?.showToast(L("conversation.conversationHistory.renameProjectFailed"))
            return false
        }
        applyProjectRename(project.projectId, name: trimmed)
        toasts?.showToast(L("conversation.conversationHistory.projectRenamed"))
        return true
    }

    func applyProjectRename(_ projectId: String, name: String) {
        for index in projects.indices where projects[index].projectId == projectId {
            projects[index].name = name
        }
        func rename(_ list: inout [ConversationSummary]) {
            for index in list.indices where list[index].projectId == projectId {
                list[index].projectName = name
            }
        }
        rename(&items)
        rename(&pinned)
        for key in Array(projectItems.keys) {
            guard var list = projectItems[key] else { continue }
            rename(&list)
            projectItems[key] = list
        }
        persist()
    }

    /// Deletes the project; its conversations stay and return to Pinned and Recents. Throws
    /// when the delete failed, and the menu keeps the project.
    func deleteProject(_ project: Project) async throws {
        guard let token = try await auth?.getAccessTokenSilently() else { return }
        do {
            try await ConversationHistoryService.deleteProject(token: token, projectId: project.projectId)
        } catch {
            AppObservability.capture(error, context: ["where": "deleteProject"])
            throw error
        }
        applyProjectDeletion(project.projectId)
        toasts?.showToast(L("conversation.conversationHistory.projectDeleted"))
    }

    func applyProjectDeletion(_ projectId: String) {
        projects.removeAll { $0.projectId == projectId }
        func unassign(_ list: inout [ConversationSummary]) {
            for index in list.indices where list[index].projectId == projectId {
                list[index].projectId = nil
                list[index].projectName = nil
            }
        }
        unassign(&items)
        unassign(&pinned)
        projectItems[projectId] = nil
        projectCursors[projectId] = nil
        expandedProjects[projectId] = nil
        optimisticMembers[projectId] = nil
        loadedProjects.remove(projectId)
        persist()
    }

    func move(_ conversation: ConversationSummary, to project: Project) async {
        let previous = (conversation.projectId, conversation.projectName)
        applyProjectLocally(conversation, projectId: project.projectId, projectName: project.name)
        expandedProjects[project.projectId] = true
        do {
            guard let token = try await auth?.getAccessTokenSilently() else { return }
            try await ConversationHistoryService.assignProject(token: token, conversationId: conversation.conversationId, projectId: project.projectId)
            // No immediate refetch: the GSI may not have caught up and would clobber the
            // optimistic entry. The real membership loads on the next expand.
            toasts?.showToast(L("conversation.conversationHistory.movedToProject", ["name": project.name]))
            persist()
        } catch {
            applyProjectLocally(conversation, projectId: previous.0, projectName: previous.1)
            toasts?.showToast(L("conversation.conversationHistory.moveToProjectFailed"))
        }
    }

    func removeFromProject(_ conversation: ConversationSummary) async {
        let previous = (conversation.projectId, conversation.projectName)
        applyProjectLocally(conversation, projectId: nil, projectName: nil)
        do {
            guard let token = try await auth?.getAccessTokenSilently() else { return }
            try await ConversationHistoryService.unassignProject(token: token, conversationId: conversation.conversationId)
            toasts?.showToast(L("conversation.conversationHistory.removedFromProject"))
            persist()
        } catch {
            applyProjectLocally(conversation, projectId: previous.0, projectName: previous.1)
            toasts?.showToast(L("conversation.conversationHistory.removeFromProjectFailed"))
        }
    }

    private func applyProjectLocally(_ conversation: ConversationSummary, projectId: String?, projectName: String?) {
        func patch(_ list: inout [ConversationSummary]) {
            for index in list.indices where list[index].conversationId == conversation.conversationId {
                list[index].projectId = projectId
                list[index].projectName = projectName
            }
        }
        patch(&items)
        patch(&pinned)
        if let projectId {
            var updated = conversation
            updated.projectId = projectId
            updated.projectName = projectName
            upsertIntoProjectItems(projectId, updated)
        } else {
            removeFromProjectItems(conversation.conversationId)
        }
    }

    private func removeFromProjectItems(_ id: String) {
        for key in optimisticMembers.keys { optimisticMembers[key]?.removeAll { $0.conversationId == id } }
        for key in projectItems.keys { projectItems[key]?.removeAll { $0.conversationId == id } }
    }

    private func upsertIntoProjectItems(_ projectId: String, _ conversation: ConversationSummary) {
        removeFromProjectItems(conversation.conversationId)
        optimisticMembers[projectId, default: []].insert(conversation, at: 0)
        projectItems[projectId, default: []].insert(conversation, at: 0)
    }

    private func patchProjectItems(_ id: String, _ transform: (inout ConversationSummary) -> Void) {
        for key in projectItems.keys {
            guard var list = projectItems[key] else { continue }
            for index in list.indices where list[index].conversationId == id { transform(&list[index]) }
            projectItems[key] = list
        }
    }

    // MARK: - Events from the conversation

    /// Patches the title when the active conversation gets a generated one (prepending a
    /// brand-new conversation; one started inside a project joins that project).
    func didTitleConversation(id: String, title: String, pendingProjectId: String?) {
        if let index = items.firstIndex(where: { $0.conversationId == id }) {
            items[index].title = title
        } else {
            items.insert(ConversationSummary(
                conversationId: id, title: title, projectId: pendingProjectId,
                projectName: pendingProjectId.flatMap { pid in projects.first { $0.projectId == pid }?.name }
            ), at: 0)
        }
        if let index = pinned.firstIndex(where: { $0.conversationId == id }) { pinned[index].title = title }
        patchProjectItems(id) { $0.title = title }
        if let pendingProjectId, !(projectItems[pendingProjectId] ?? []).contains(where: { $0.conversationId == id }) {
            projectItems[pendingProjectId, default: []].insert(ConversationSummary(conversationId: id, title: title, projectId: pendingProjectId), at: 0)
        }
        persist()
    }

    /// A fork appears the moment it's created, nested under its parent.
    func didFork(_ fork: ForkConversationResponse) {
        let now = ISO8601DateFormatter().string(from: Date())
        let summary = ConversationSummary(
            conversationId: fork.conversationId,
            title: fork.title,
            createdAt: fork.createdAt ?? now,
            updatedAt: fork.updatedAt ?? now,
            pinnedAt: fork.pinnedAt,
            projectId: fork.projectId,
            projectName: fork.projectId.flatMap { pid in projects.first { $0.projectId == pid }?.name },
            parentConversationId: fork.parentConversationId
        )
        items = [summary] + items.filter { $0.conversationId != summary.conversationId }
        if summary.pinnedAt != nil {
            pinned = [summary] + pinned.filter { $0.conversationId != summary.conversationId }
        }
        if let projectId = summary.projectId { upsertIntoProjectItems(projectId, summary) }
        persist()
    }
}
