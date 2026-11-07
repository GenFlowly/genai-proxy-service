import SwiftUI
import Combine

private let maxMemoryChars = 500

// MARK: - Shared (memoryDetail.tsx)

extension MemoryLabels {
    /// "Every conversation · Core", "When relevant · Episodic", "Market research · Episodic".
    static func applies(_ placement: MemoryPlacement, store: MemoriesStore) -> String {
        let place = placement.projectId.map { store.projectName($0) }
            ?? L(placement.kind == .core ? "memoryPage.page.everywhere" : "memoryPage.page.whenRelevant")
        return "\(place) · \(placement.kind.label)"
    }

    /// Replies counted before the usage log existed: the hit counter has them, the log doesn't.
    static func unlistedReplies(_ memory: CustomerMemory, listed: Int, complete: Bool) -> Int {
        complete ? max(0, memory.hitCount - listed) : 0
    }

    static func usageSummary(_ memory: CustomerMemory) -> String {
        guard memory.hitCount > 0 else { return L("memoryPage.page.usageNever") }
        guard let last = memory.lastUsedAt else { return L("memoryPage.page.usageCount", ["count": memory.hitCount]) }
        return L("memoryPage.page.usageSummary", ["count": memory.hitCount, "date": dateOnly(last)])
    }

    /// A memory's changes as a timeline, newest first.
    static func history(_ changes: [MemoryChange], memory: CustomerMemory, store: MemoriesStore, onView: @escaping (Int) -> Void) -> [TimelineEntryItem] {
        changes.map { change in
            var facts: [TimelineFact] = []
            if change.type == "LEGACY" {
                facts.append(TimelineFact(label: L("memoryPage.changes.note"), value: .text(L("memoryPage.changes.legacyNote", ["date": dateOnly(change.createdAt)]))))
            }
            if change.noteKey != nil { facts.append(TimelineFact(label: L("memoryPage.changes.note"), value: .text(L("memoryPage.changes.fromNote")))) }
            if let youSaid = change.youSaid { facts.append(TimelineFact(label: L("memoryPage.changes.youSaid"), value: .text("“\(youSaid)”"))) }
            if let reason = change.reason { facts.append(TimelineFact(label: L("memoryPage.page.why"), value: .text(reason))) }
            if let previous = change.previousText, let text = change.text {
                facts.append(TimelineFact(label: L("memoryPage.page.change"), value: .diff(before: previous, after: text, short: false)))
            } else if let text = change.text, change.type != "LEGACY" {
                facts.append(TimelineFact(label: L("memoryPage.page.savedAs"), value: .text(text)))
            }
            let current = change.version != nil && change.version == memory.version
            var entry = TimelineEntryItem(
                id: change.changeId,
                title: changeTitle(change),
                badge: change.version.map { "v\($0)" } ?? (change.type == "LEGACY" ? nil : L("memoryPage.changes.noVersion")),
                current: current,
                date: date(change.createdAt),
                facts: facts
            )
            if let id = change.conversationId {
                entry.conversation = (id: id, title: change.conversationTitle, available: change.conversationAvailable != false)
            }
            if change.version == nil, change.from != nil || change.to != nil {
                entry.move = (from: placements(change.from, store: store), to: placements(change.to, store: store))
            }
            if let version = change.version, !current {
                entry.view = (label: L("memoryPage.page.viewVersion", ["version": version]), action: { onView(version) })
            }
            return entry
        }
    }

    /// The replies a memory was used in, one item per conversation, newest first.
    static func usageByConversation(_ items: [MemoryUsage]) -> [ConversationItem] {
        var order: [String] = []
        var groups: [String: (usage: MemoryUsage, count: Int)] = [:]
        for usage in items {
            if let group = groups[usage.conversationId] {
                groups[usage.conversationId] = (group.usage, group.count + 1)
            } else {
                order.append(usage.conversationId)
                groups[usage.conversationId] = (usage, 1)
            }
        }
        return order.compactMap { id in
            guard let group = groups[id] else { return nil }
            return ConversationItem(
                id: id,
                title: group.usage.conversationTitle,
                available: group.usage.conversationAvailable != false,
                meta: L("memoryPage.page.conversationUses", ["count": group.count, "date": date(group.usage.usedAt)])
            )
        }
    }
}

/// Loads a memory's detail for the memory pages.
@MainActor
final class MemoryDetailLoader: ObservableObject {
    @Published var detail: MemoryDetail?
    @Published var loadError: Int?

    func load(_ memoryId: String, auth: AuthStore, memories: MemoriesStore) async {
        guard let token = try? await auth.getAccessTokenSilently() else { return }
        do {
            detail = try await MemoriesService.detail(token: token, memoryId: memoryId)
            loadError = nil
            if memories.projects.isEmpty { await memories.load() }
        } catch let error as APIError {
            loadError = error.status
        } catch is CancellationError {
            return
        } catch {
            loadError = -1
        }
    }
}

private struct DetailStateView: View {
    let text: String
    var actionLabel: String?
    var action: (() -> Void)?

    var body: some View {
        VStack(spacing: 12) {
            Text(text).webText(16, 600).foregroundStyle(AppTheme.textPrimary).multilineTextAlignment(.center)
            if let actionLabel, let action { PillButton(label: actionLabel, style: .secondary, action: action) }
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 64)
    }
}

// MARK: - Detail (MemoryDetailPage.tsx)

/// One memory: its text with one Edit action, then rows for where it applies, how it
/// was used and its history, each opening its own page. `version` shows an older version,
/// which Restore saves as a new one.
struct MemoryDetailView: View {
    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var router: AppRouter
    @EnvironmentObject var memories: MemoriesStore
    @EnvironmentObject var conversation: ConversationStore
    let memoryId: String
    var version: Int?

    @StateObject private var loader = MemoryDetailLoader()
    @State private var dialog: MemoryDialog?

    private var memory: CustomerMemory? { loader.detail?.memory }
    private var from: MemoryPlacement? {
        guard let memory else { return nil }
        return router.memoryScope.placement(of: memory) ?? memory.placements.first
    }
    private var latest: Int { memory?.version ?? 1 }
    private var shownChange: MemoryChange? {
        let versions = loader.detail?.versions ?? []
        return versions.first { $0.version == version && version != latest } ?? versions.first { $0.version == latest }
    }
    private var shownVersion: Int { shownChange?.version ?? latest }
    private var older: Bool { shownVersion != latest }
    private var shownText: String { older ? shownChange?.text ?? "" : memory?.text ?? "" }

    var body: some View {
        DetailScaffold(
            title: L("memoryPage.page.title"),
            subtitle: MemoryLabels.scopeTitle(router.memoryScope, store: memories),
            menuItems: menuItems,
            onLeading: router.openPageMenu
        ) {
            if let memory, let from, let detail = loader.detail {
                if older {
                    DetailBanner(
                        text: L("memoryPage.page.olderBanner", ["version": shownVersion, "latest": latest]),
                        linkLabel: L("memoryPage.page.backToLatest"),
                        onLink: { router.navigate(.memoryDetail(memoryId)) }
                    )
                }
                DetailCard {
                    if let category = memory.category { DetailChip(text: category) }
                    Text(shownText)
                        .webText(20, lineHeight: 29)
                        .foregroundStyle(AppTheme.textPrimary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .accessibilityIdentifier("memory-text-shown")
                    DetailCardFoot(
                        note: L("memoryPage.versions.version", ["version": shownVersion])
                            + (shownChange.map { " · " + MemoryLabels.dateOnly($0.createdAt) } ?? ""),
                        actionLabel: older ? L("memoryPage.page.restore", ["next": latest + 1]) : L("memoryPage.page.edit"),
                        primary: older,
                        actionId: "memory-edit"
                    ) {
                        router.navigate(.memoryEdit(memoryId, version: older ? shownVersion : nil))
                    }
                }
                DetailRowsView(rows: [
                    DetailRowItem(
                        id: "applies",
                        icon: from.projectId != nil ? "folder" : "brain",
                        accent: true,
                        title: L("memoryPage.page.appliesTo"),
                        summary: memory.placements.map { MemoryLabels.applies($0, store: memories) }.joined(separator: ", "),
                        action: { dialog = .move(memory, from, copy: false) }
                    ),
                    DetailRowItem(
                        id: "usage",
                        icon: "chat-bubble",
                        title: L("memoryPage.page.usage"),
                        summary: MemoryLabels.usageSummary(memory),
                        action: { router.navigate(.memoryUsage(memoryId)) }
                    ),
                    DetailRowItem(
                        id: "history",
                        icon: "history",
                        title: L("memoryPage.page.history"),
                        summary: L("memoryPage.page.historySummary", ["version": latest, "count": detail.changes.count]),
                        action: { router.navigate(.memoryHistory(memoryId)) }
                    ),
                ])
            } else if let error = loader.loadError {
                DetailStateView(
                    text: L(error == 404 ? "memoryPage.detail.notFound" : "memoryPage.detail.loadFailed"),
                    actionLabel: L("memoryPage.detail.backToList"),
                    action: { router.navigate(.memory) }
                )
            } else {
                ProgressView().frame(maxWidth: .infinity).padding(.top, 64)
            }
        }
        .task(id: memoryId) {
            await loader.load(memoryId, auth: auth, memories: memories)
            if let memory = loader.detail?.memory, router.memoryScope.placement(of: memory) == nil { router.memoryScope = .of(memory) }
        }
        .memoryDialogs($dialog, onMoved: { updated in
            if router.memoryScope.placement(of: updated) == nil { router.memoryScope = .of(updated) }
            loader.detail?.memory = updated
            Task { await loader.load(memoryId, auth: auth, memories: memories) }
        }, onDeleted: { _ in router.navigate(.memory) })
    }

    private var menuItems: [MobileHeaderMenuItem] {
        guard let memory, let from else { return [] }
        var items = [MobileHeaderMenuItem(label: L("memoryPage.list.moveTo")) { dialog = .move(memory, from, copy: false) }]
        if from.projectId != nil {
            items.append(MobileHeaderMenuItem(label: L("memoryPage.list.copyToProject")) { dialog = .move(memory, from, copy: true) })
        }
        items.append(MobileHeaderMenuItem(label: L("memoryPage.list.delete")) { dialog = .delete(memory, from) })
        return items
    }
}

// MARK: - Edit (MemoryEditPage.tsx)

/// A memory's editor on its own page. `version` starts from an older version, so saving
/// restores it. Every save is a new version.
struct MemoryEditView: View {
    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var router: AppRouter
    @EnvironmentObject var memories: MemoriesStore
    @EnvironmentObject var toasts: ToastCenter
    let memoryId: String
    var version: Int?

    @StateObject private var loader = MemoryDetailLoader()
    @State private var draft: String?
    @State private var saving = false

    private var memory: CustomerMemory? { loader.detail?.memory }
    private var latest: Int { memory?.version ?? 1 }
    private var from: MemoryChange? { loader.detail?.versions.first { $0.version == version && version != latest } }
    private var text: String { draft ?? from?.text ?? memory?.text ?? "" }
    private var trimmed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var canSave: Bool {
        guard let memory else { return false }
        return !trimmed.isEmpty && trimmed.count <= maxMemoryChars && trimmed != memory.text
    }

    var body: some View {
        DetailScaffold(
            title: L("memoryPage.page.editTitle"),
            subtitle: MemoryLabels.scopeTitle(router.memoryScope, store: memories),
            backLabel: L("memoryPage.page.back"),
            onLeading: { router.navigate(.memoryDetail(memoryId)) },
            actions: memory == nil ? nil : AnyView(
                HStack(spacing: 12) {
                    PillButton(label: L("memoryPage.page.cancel"), style: .secondary, disabled: saving, fullWidth: true) {
                        router.navigate(.memoryDetail(memoryId))
                    }
                    PillButton(
                        label: saving ? L("memoryPage.detail.saving") : L("memoryPage.detail.save", ["next": latest + 1]),
                        disabled: !canSave || saving,
                        fullWidth: true
                    ) { Task { await save() } }
                    .accessibilityIdentifier("memory-save")
                }
            )
        ) {
            if let memory {
                if let from, let fromVersion = from.version {
                    DetailBanner(text: L("memoryPage.page.editingOlder", ["version": fromVersion, "next": latest + 1]))
                }
                VStack(alignment: .leading, spacing: 6) {
                    WebFieldLabel(L("memoryPage.detail.textLabel"), color: AppTheme.textMuted, weight: 600)
                    DetailTextField(text: Binding(get: { text }, set: { draft = String($0.prefix(maxMemoryChars)) }))
                        .accessibilityIdentifier("memory-text")
                    HStack {
                        Text(L("memoryPage.page.kept"))
                        Spacer()
                        Text("\(text.count) / \(maxMemoryChars)").monospacedDigit()
                    }
                    .webText(12.5)
                    .foregroundStyle(AppTheme.textMuted)
                    .padding(.horizontal, 4)
                }
                if canSave {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(L("memoryPage.page.yourChange")).webText(13, 600).foregroundStyle(AppTheme.textMuted)
                        DiffText(before: memory.text, after: trimmed, size: 15)
                    }
                    .padding(14)
                    .background(AppTheme.backgroundSecondary)
                    .clipShape(RoundedRectangle(cornerRadius: 14))
                    .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(AppTheme.borderLight, lineWidth: 1))
                    .accessibilityIdentifier("memory-change-preview")
                }
            } else if loader.loadError != nil {
                DetailStateView(text: L("memoryPage.detail.loadFailed"))
            } else {
                ProgressView().frame(maxWidth: .infinity).padding(.top, 64)
            }
        }
        .task(id: memoryId) {
            await loader.load(memoryId, auth: auth, memories: memories)
            if let memory = loader.detail?.memory, router.memoryScope.placement(of: memory) == nil { router.memoryScope = .of(memory) }
        }
    }

    private func save() async {
        guard let memory, canSave else { return }
        saving = true
        defer { saving = false }
        do {
            let updated = try await memories.edit(memory, text: trimmed)
            toasts.showToast(L("memoryPage.detail.saved", ["version": updated.version]))
            router.navigate(.memoryDetail(memoryId))
        } catch let error as APIError where error.status == 409 {
            toasts.showToast(L("memoryPage.detail.conflict"))
            await loader.load(memoryId, auth: auth, memories: memories)
        } catch {
            toasts.showToast(L("memoryPage.detail.saveFailed"))
        }
    }
}

// MARK: - History (MemoryHistoryPage.tsx)

/// A memory's history on its own page: every change, with what caused it.
struct MemoryHistoryView: View {
    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var router: AppRouter
    @EnvironmentObject var memories: MemoriesStore
    @EnvironmentObject var conversation: ConversationStore
    let memoryId: String

    @StateObject private var loader = MemoryDetailLoader()

    var body: some View {
        DetailScaffold(
            title: L("memoryPage.page.history"),
            subtitle: loader.detail?.memory.text,
            backLabel: L("memoryPage.page.back"),
            onLeading: { router.navigate(.memoryDetail(memoryId)) }
        ) {
            if let detail = loader.detail {
                DetailIntro(text: L("memoryPage.page.historyIntro"))
                TimelineView(
                    entries: MemoryLabels.history(detail.changes, memory: detail.memory, store: memories) { version in
                        router.navigate(.memoryDetail(memoryId, version: version))
                    },
                    untitled: L("memoryPage.changes.untitledConversation"),
                    deleted: L("memoryPage.changes.deletedConversation"),
                    onOpenConversation: { id in
                        router.navigate(.chat)
                        Task { await conversation.loadConversation(id) }
                    }
                )
            } else if loader.loadError != nil {
                DetailStateView(text: L("memoryPage.detail.loadFailed"))
            } else {
                ProgressView().frame(maxWidth: .infinity).padding(.top, 64)
            }
        }
        .task(id: memoryId) { await loader.load(memoryId, auth: auth, memories: memories) }
    }
}

// MARK: - Used in (MemoryUsedInPage.tsx)

/// The conversations a memory was used in, one row each, newest first.
struct MemoryUsedInView: View {
    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var router: AppRouter
    @EnvironmentObject var memories: MemoriesStore
    @EnvironmentObject var conversation: ConversationStore
    let memoryId: String

    @StateObject private var loader = MemoryDetailLoader()
    @State private var pages: [MemoryUsagePage] = []
    @State private var loading = true
    @State private var failed = false

    private var items: [ConversationItem] { MemoryLabels.usageByConversation(pages.flatMap(\.items)) }
    private var unlisted: Int {
        guard let memory = loader.detail?.memory else { return 0 }
        return MemoryLabels.unlistedReplies(memory, listed: pages.reduce(0) { $0 + $1.items.count }, complete: !loading && !failed && !pages.isEmpty && pages.last?.nextCursor == nil)
    }

    var body: some View {
        DetailScaffold(
            title: L("memoryPage.page.usedIn"),
            subtitle: loader.detail.map { MemoryLabels.usageSummary($0.memory) },
            backLabel: L("memoryPage.page.back"),
            onLeading: { router.navigate(.memoryDetail(memoryId)) }
        ) {
            DetailIntro(text: L("memoryPage.page.usedInIntro"))
            if !items.isEmpty {
                ConversationListView(
                    items: items,
                    untitled: L("memoryPage.changes.untitledConversation"),
                    deleted: L("memoryPage.changes.deletedConversation"),
                    onOpen: { id in
                        router.navigate(.chat)
                        Task { await conversation.loadConversation(id) }
                    }
                )
                if pages.last?.nextCursor != nil {
                    PillButton(label: L(loading ? "memoryPage.usage.loading" : "memoryPage.usage.loadMore"), style: .secondary, disabled: loading, fullWidth: true) {
                        Task { await loadUsage(more: true) }
                    }
                    .accessibilityIdentifier("memory-usage-load-more")
                }
                if unlisted > 0 {
                    DetailIntro(text: L("memoryPage.page.unlistedMore", ["count": unlisted]))
                }
            } else {
                Text(L(loading ? "memoryPage.usage.loading" : failed ? "memoryPage.usage.loadFailed"
                    : unlisted > 0 ? "memoryPage.page.unlisted" : "memoryPage.usage.empty", ["count": unlisted]))
                    .webText(14)
                    .foregroundStyle(AppTheme.textMuted)
                    .frame(maxWidth: .infinity)
                    .padding(.top, 40)
            }
        }
        .task(id: memoryId) {
            await loader.load(memoryId, auth: auth, memories: memories)
            await loadUsage(more: false)
        }
    }

    private func loadUsage(more: Bool) async {
        guard let token = try? await auth.getAccessTokenSilently() else { return }
        loading = true
        defer { loading = false }
        do {
            let page = try await MemoriesService.usage(token: token, memoryId: memoryId, cursor: more ? pages.last?.nextCursor : nil)
            pages = more ? pages + [page] : [page]
            failed = false
        } catch {
            failed = true
        }
    }
}

/// The edit pages' text box: plain text at a readable size, Save stays reachable below.
struct DetailTextField: View {
    @Binding var text: String
    var minHeight: CGFloat = 150
    @FocusState private var focused: Bool

    var body: some View {
        TextEditor(text: $text)
            .focused($focused)
            .font(Font(DSFont.ui(18) as CTFont))
            .lineSpacing(5)
            .foregroundStyle(AppTheme.textPrimary)
            .scrollContentBackground(.hidden)
            .padding(.horizontal, 11)
            .padding(.vertical, 8)
            .frame(minHeight: minHeight)
            .background(AppTheme.backgroundSecondary)
            .clipShape(RoundedRectangle(cornerRadius: 16))
            .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(focused ? AppTheme.primary : AppTheme.border, lineWidth: 1.5))
    }
}

// MARK: - New memory (NewMemoryPage.tsx)

/// A memory the user writes: where it applies, Core or Episodic, and its text. Saved as
/// version 1.
struct NewMemoryView: View {
    @EnvironmentObject var router: AppRouter
    @EnvironmentObject var memories: MemoriesStore
    @EnvironmentObject var toasts: ToastCenter

    @State private var whereKey: String
    @State private var kind: MemoryKind
    @State private var text = ""
    @State private var saving = false

    private static let profileKey = "profile"
    private static let actionsId = "new-memory-actions"

    init(scope: MemoryScope) {
        switch scope {
        case .profile(let kind):
            _whereKey = State(initialValue: Self.profileKey)
            _kind = State(initialValue: kind)
        case .project(let id):
            _whereKey = State(initialValue: id)
            _kind = State(initialValue: .core)
        }
    }

    private var trimmed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        ZStack(alignment: .top) {
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 20) {
                        VStack(alignment: .leading, spacing: 6) {
                            WebFieldLabel(L("memoryPage.newMemory.appliesIn"), weight: 600)
                            MemoryWhereSelect(
                                value: whereKey,
                                options: [.init(value: Self.profileKey, label: L("memoryPage.newMemory.profileOption"))]
                                    + memories.projects.map { .init(value: $0.projectId, label: L("memoryPage.newMemory.projectOption", ["name": $0.name])) },
                                onChange: { whereKey = $0 }
                            )
                            .accessibilityIdentifier("new-memory-where")
                        }
                        VStack(alignment: .leading, spacing: 6) {
                            WebFieldLabel(L("memoryPage.newMemory.kind"), weight: 600)
                            MemoryKindToggle(kind: $kind)
                        }
                        Text(MemoryLabels.kindHelp(kind, inProject: whereKey != Self.profileKey))
                            .webText(13, lineHeight: 19)
                            .foregroundStyle(AppTheme.textMuted)
                        VStack(alignment: .leading, spacing: 6) {
                            WebFieldLabel(L("memoryPage.newMemory.text"), weight: 600)
                            VStack(alignment: .leading, spacing: 0) {
                                WebFieldTextArea(
                                    text: Binding(get: { text }, set: { text = String($0.prefix(maxMemoryChars)) }),
                                    placeholder: L("memoryPage.newMemory.placeholder"),
                                    rows: 5
                                )
                                .accessibilityIdentifier("new-memory-text")
                                Text(L("memoryPage.newMemory.hint")).webText(13, lineHeight: 19).foregroundStyle(AppTheme.textMuted)
                            }
                        }
                        HStack(spacing: 16) {
                            PillButton(label: L("memoryPage.move.cancel"), style: .secondary, disabled: saving) {
                                router.navigate(.memory)
                            }
                            .accessibilityIdentifier("new-memory-cancel")
                            PillButton(
                                label: saving ? L("memoryPage.newMemory.saving") : L("memoryPage.newMemory.save"),
                                disabled: trimmed.isEmpty || saving
                            ) { Task { await save() } }
                            .accessibilityIdentifier("new-memory-save")
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.bottom, 12)
                        .id(Self.actionsId)
                    }
                    .padding(.horizontal, 12)
                    .padding(.top, mobileHeaderHeight + 16)
                    .padding(.bottom, 28)
                }
                .scrollDismissesKeyboard(.interactively)
                // The text box is the only field that raises the keyboard; keep Save above it.
                .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardDidShowNotification)) { _ in
                    withAnimation(.easeOut(duration: 0.25)) { proxy.scrollTo(Self.actionsId, anchor: .bottom) }
                }
            }

            MobileHeader(title: L("memoryPage.newMemory.title"), onMenuClick: router.openPageMenu)
        }
        .statusBarBand()
        .background(AppTheme.background)
        .task { if memories.projects.isEmpty { await memories.load() } }
    }

    private func save() async {
        guard !trimmed.isEmpty else { return }
        saving = true
        defer { saving = false }
        let projectId = whereKey == Self.profileKey ? nil : whereKey
        do {
            let memory = try await memories.create(text: trimmed, kind: kind, projectId: projectId)
            router.memoryScope = projectId.map { .project($0) } ?? .profile(kind)
            router.navigate(.memoryDetail(memory.memoryId))
        } catch {
            toasts.showToast(L("memoryPage.newMemory.failed"))
        }
    }
}

/// NewMemoryPage.tsx's `<select>` on a phone: 48pt tall, 16pt text, radius 10, the
/// field background and border.
private struct MemoryWhereSelect: View {
    let value: String
    let options: [InputSelectWithHint.Option]
    let onChange: (String) -> Void

    var body: some View {
        Menu {
            ForEach(options) { option in
                Button {
                    onChange(option.value)
                } label: {
                    if option.value == value {
                        Label(option.label, systemImage: "checkmark")
                    } else {
                        Text(option.label)
                    }
                }
            }
        } label: {
            NativeSelectLabel(
                text: options.first { $0.value == value }?.label ?? "",
                font: DSFont.ui(16),
                horizontalPadding: 12
            )
            .padding(.horizontal, 1)
            .frame(height: 48)
            .background(AppTheme.backgroundSecondary)
            .clipShape(RoundedRectangle(cornerRadius: DSRadius.lg))
            .overlay(RoundedRectangle(cornerRadius: DSRadius.lg).strokeBorder(AppTheme.border, lineWidth: 1))
            .contentShape(Rectangle())
        }
    }
}
