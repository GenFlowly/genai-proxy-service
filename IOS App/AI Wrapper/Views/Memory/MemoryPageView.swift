import SwiftUI

// MARK: - Labels (pages/MemoryPage/memoryLabels.ts)

@MainActor
enum MemoryLabels {
    static func scopeTitle(_ scope: MemoryScope, store: MemoriesStore) -> String {
        switch scope {
        case .profile(let kind): return L(kind == .core ? "memoryPage.scopes.coreTitle" : "memoryPage.scopes.episodicTitle")
        case .project(let id): return store.projectName(id)
        }
    }

    static func scopeSubtitle(_ scope: MemoryScope) -> String {
        switch scope {
        case .profile(let kind): return L(kind == .core ? "memoryPage.scopes.coreSubtitle" : "memoryPage.scopes.episodicSubtitle")
        case .project: return L("memoryPage.scopes.projectSubtitle")
        }
    }

    /// "Profile · Core", "Market research · Episodic".
    static func placement(_ placement: MemoryPlacement, store: MemoriesStore) -> String {
        let place = placement.projectId.map { store.projectName($0) } ?? L("memoryPage.scopes.profile")
        return "\(place) · \(placement.kind.label)"
    }

    static func placements(_ placements: [MemoryPlacement]?, store: MemoriesStore) -> String {
        guard let placements, !placements.isEmpty else { return L("memoryPage.changes.nowhere") }
        return placements.map { placement($0, store: store) }.joined(separator: ", ")
    }

    static func kindHelp(_ kind: MemoryKind, inProject: Bool) -> String {
        switch (kind, inProject) {
        case (.core, true): return L("memoryPage.move.coreHelpProject")
        case (.core, false): return L("memoryPage.move.coreHelpProfile")
        case (.episodic, true): return L("memoryPage.move.episodicHelpProject")
        case (.episodic, false): return L("memoryPage.move.episodicHelpProfile")
        }
    }

    static func changeTitle(_ change: MemoryChange) -> String {
        let fromNote = change.sourceType == "NOTE"
        switch change.type {
        case "LEARNED": return L(fromNote ? "memoryPage.changes.learnedNote" : "memoryPage.changes.learned")
        case "UPDATED": return L(fromNote ? "memoryPage.changes.updatedNote" : "memoryPage.changes.updated")
        case "ADDED_BY_YOU": return L("memoryPage.changes.addedByYou")
        case "EDITED_BY_YOU": return L("memoryPage.changes.editedByYou")
        case "MOVED": return L("memoryPage.changes.moved")
        case "COPIED": return L("memoryPage.changes.copied")
        case "REMOVED_FROM_PROJECT":
            return L(change.conversationId == nil ? "memoryPage.changes.removedFromProject" : "memoryPage.changes.removedInConversation")
        case "LEGACY": return L("memoryPage.changes.legacy")
        default: return change.type
        }
    }

    static func date(_ raw: String?) -> String {
        ServerDate.parse(raw).map(ServerDate.dateTime) ?? ""
    }

    /// "Nov 6, 2026" (formatServerDateOnly).
    static func dateOnly(_ raw: String?) -> String {
        ServerDate.parse(raw).map(ServerDate.dateOnly) ?? ""
    }
}

// MARK: - Shared bits

/// The card's "…" button: MemoryCard.tsx's KebabIcon, three dots on a 24-unit box drawn
/// at `size`.
struct MemoryKebabIcon: View {
    var size: CGFloat = 18
    var color: Color = AppTheme.textMuted

    var body: some View {
        Canvas { context, canvas in
            let unit = canvas.width / 24
            for x in [5.0, 12.0, 19.0] {
                let radius = 1.7 * unit
                let center = CGPoint(x: x * unit, y: 12 * unit)
                context.fill(
                    Path(ellipseIn: CGRect(x: center.x - radius, y: center.y - radius, width: radius * 2, height: radius * 2)),
                    with: .color(color)
                )
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

/// A small pill: a memory's category, or where it applies (`selected`).
struct MemoryTag: View {
    let text: String
    var selected = false

    var body: some View {
        Text(text)
            .webText(arial: 12, bold: selected, lineHeight: 12)
            .foregroundStyle(selected ? AppTheme.primary : AppTheme.textMuted)
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(selected ? AppTheme.backgroundSelected : AppTheme.backgroundTertiary)
            .clipShape(Capsule())
            .overlay(Capsule().strokeBorder(selected ? AppTheme.primary : AppTheme.borderLight, lineWidth: 1))
            .lineLimit(1)
    }
}

struct MemoryVersionBadge: View {
    let text: String

    var body: some View {
        Text(text)
            .webText(arial: 11.5, bold: true)
            .foregroundStyle(AppTheme.textSecondary)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(AppTheme.backgroundTertiary)
            .clipShape(RoundedRectangle(cornerRadius: DSRadius.sm))
    }
}

/// Core or Episodic, as a two-part switch (KindToggle.tsx).
struct MemoryKindToggle: View {
    @Binding var kind: MemoryKind

    var body: some View {
        HStack(spacing: 4) {
            ForEach(MemoryKind.allCases, id: \.self) { option in
                Button { kind = option } label: {
                    Text(option.label)
                        .webText(arial: 15, bold: kind == option)
                        .foregroundStyle(kind == option ? AppTheme.primary : AppTheme.textSecondary)
                        .frame(maxWidth: .infinity, minHeight: 44)
                        .background(kind == option ? AppTheme.backgroundSelected : Color.clear)
                        .clipShape(Capsule())
                        .contentShape(Capsule())
                }
                .buttonStyle(WebPressStyle())
                .accessibilityAddTraits(kind == option ? .isSelected : [])
                .accessibilityIdentifier("memory-kind-\(option.rawValue.lowercased())")
            }
        }
        .padding(3)
        .overlay(Capsule().strokeBorder(AppTheme.border, lineWidth: 1))
    }
}

/// What a memory offers in a list. Copy is only for project memories.
struct MemoryActionItem: Identifiable {
    enum Kind: String { case edit, move, copy, delete }
    let kind: Kind
    let label: String
    let icon: String
    var id: String { kind.rawValue }

    static func list(for placement: MemoryPlacement) -> [MemoryActionItem] {
        var items = [
            MemoryActionItem(kind: .edit, label: L("memoryPage.list.edit"), icon: "edit"),
            MemoryActionItem(kind: .move, label: L("memoryPage.list.moveTo"), icon: "alt-arrow-right"),
        ]
        if placement.projectId != nil {
            items.append(MemoryActionItem(kind: .copy, label: L("memoryPage.list.copyToProject"), icon: "copy-icon"))
        }
        items.append(MemoryActionItem(kind: .delete, label: L("memoryPage.list.delete"), icon: "trash"))
        return items
    }
}

/// The Memory page's dialogs, shared by the list and the detail screen.
enum MemoryDialog: Identifiable {
    case actions(CustomerMemory, MemoryPlacement)
    case move(CustomerMemory, MemoryPlacement, copy: Bool)
    case delete(CustomerMemory, MemoryPlacement)

    var id: String {
        switch self {
        case .actions(let m, _): return "actions-\(m.memoryId)"
        case .move(let m, _, let copy): return "\(copy ? "copy" : "move")-\(m.memoryId)"
        case .delete(let m, _): return "delete-\(m.memoryId)"
        }
    }
}

// MARK: - List (MemoryPage.tsx)

/// The Memory page: one list at a time — Profile Core, Profile Episodic or a project —
/// picked in the L2 Menu.
struct MemoryPageView: View {
    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var router: AppRouter
    @EnvironmentObject var memories: MemoriesStore

    @State private var dialog: MemoryDialog?

    private var scope: MemoryScope { router.memoryScope }
    private var list: [CustomerMemory] { scope.memories(in: memories.memories) }

    var body: some View {
        ZStack(alignment: .top) {
            if auth.isAuthenticated {
                ScrollView {
                    content
                        .padding(.horizontal, 8)
                        .padding(.top, mobileHeaderHeight + 8)
                        .padding(.bottom, 24)
                }
                .refreshable { await memories.load() }
            } else {
                LoginRequiredView()
            }

            MobileHeader(
                title: MemoryLabels.scopeTitle(scope, store: memories),
                menuItems: [MobileHeaderMenuItem(label: L("memoryPage.list.addMemory")) { router.navigate(.newMemory) }],
                onMenuClick: router.openPageMenu
            ) {
                Text(MemoryLabels.scopeSubtitle(scope))
            }
        }
        .statusBarBand()
        .background(AppTheme.background)
        .task(id: auth.customerId) { await memories.load() }
        .memoryDialogs($dialog, onDeleted: { _ in })
    }

    @ViewBuilder
    private var content: some View {
        if memories.memories.isEmpty && memories.isLoading {
            ProgressView().frame(maxWidth: .infinity).padding(.top, 64)
        } else if memories.memories.isEmpty && memories.loadFailed {
            VStack(spacing: 12) {
                Text(L("memoryPage.list.loadFailed")).webText(16, 600).foregroundStyle(AppTheme.textPrimary)
                PillButton(label: L("memoryPage.list.retry"), style: .secondary) { Task { await memories.load() } }
            }
            .frame(maxWidth: .infinity)
            .padding(.top, 64)
        } else if list.isEmpty {
            VStack(spacing: 10) {
                Text(L(scope.projectId == nil ? "memoryPage.list.emptyProfileTitle" : "memoryPage.list.emptyProjectTitle"))
                    .webText(16, 600)
                    .foregroundStyle(AppTheme.textPrimary)
                Text(L(scope.projectId == nil ? "memoryPage.list.emptyProfileText" : "memoryPage.list.emptyProjectText"))
                    .webText(14, lineHeight: 21)
                    .foregroundStyle(AppTheme.textMuted)
                    .multilineTextAlignment(.center)
            }
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 16)
            .padding(.top, 64)
            .accessibilityIdentifier("memory-list-empty")
        } else {
            LazyVStack(spacing: 10) {
                ForEach(list) { memory in
                    if let placement = scope.placement(of: memory) {
                        MemoryCardView(
                            memory: memory,
                            placement: placement,
                            onOpen: { router.navigate(.memoryDetail(memory.memoryId)) },
                            onActions: { dialog = .actions(memory, placement) }
                        )
                    }
                }
            }
        }
    }
}

/// One memory in a list: tag, text, how often it was used, version and date.
struct MemoryCardView: View {
    let memory: CustomerMemory
    let placement: MemoryPlacement
    let onOpen: () -> Void
    let onActions: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                if let category = memory.category { MemoryTag(text: category) }
                if placement.projectId != nil { MemoryTag(text: placement.kind.label, selected: true) }
                Spacer(minLength: 0)
                Button(action: onActions) {
                    MemoryKebabIcon()
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(WebPressStyle())
                .accessibilityLabel(L("memoryPage.list.actions"))
                .accessibilityIdentifier("memory-card-actions-\(memory.memoryId)")
            }
            Button(action: onOpen) {
                Text(memory.text)
                    .webText(15.5, lineHeight: 22.5)
                    .foregroundStyle(AppTheme.textSecondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .multilineTextAlignment(.leading)
                    .padding(.trailing, 12)
                    .contentShape(Rectangle())
            }
            .buttonStyle(WebPressStyle())
            .accessibilityIdentifier("memory-card-open-\(memory.memoryId)")
            HStack(spacing: 8) {
                HStack(spacing: 4) {
                    Text(L("memoryPage.list.used")).webText(12.5).foregroundStyle(AppTheme.textMuted)
                    Text(L("memoryPage.list.times", ["count": memory.hitCount])).webText(12.5, 600).foregroundStyle(AppTheme.textSecondary)
                }
                MemoryVersionBadge(text: L("memoryPage.list.version", ["version": memory.version]))
                Spacer(minLength: 0)
                Text(MemoryLabels.dateOnly(memory.updatedAt.isEmpty ? memory.createdAt : memory.updatedAt))
                    .webText(12.5)
                    .foregroundStyle(AppTheme.textMuted)
            }
            .padding(.top, 10)
            .padding(.trailing, 12)
        }
        .padding(.leading, 14)
        .padding(.top, 2)
        .padding(.trailing, 2)
        .padding(.bottom, 14)
        .background(AppTheme.backgroundSecondary)
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(AppTheme.border, lineWidth: 1))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("memory-card-\(memory.memoryId)")
    }
}

// MARK: - L2 Menu (MemoryMenuContent.tsx)

/// The Memory page's L2 Menu: Profile and Projects cards, or memory search results.
struct MemoryMenuContent: View {
    @EnvironmentObject var router: AppRouter
    @EnvironmentObject var memories: MemoriesStore
    let onClose: () -> Void

    @State private var query = ""
    @State private var profileOpen = true
    @State private var projectsOpen = true

    private var trimmedQuery: String { query.trimmingCharacters(in: .whitespacesAndNewlines) }
    /// The list on screen; none while a memory or the new-memory form is open.
    private var activeScope: MemoryScope? { router.route == .memory ? router.memoryScope : nil }

    var body: some View {
        MobileMenuBody(
            searchText: $query,
            searchPlaceholder: L("layout.mobileMenu.searchMemories"),
            isShowingResults: !trimmedQuery.isEmpty,
            cards: {
                VStack(spacing: 12) {
                    card(title: L("memoryPage.menu.profileMemories"), isOpen: $profileOpen) {
                        row(.profile(.core), label: MemoryKind.core.label, icon: "brain")
                        row(.profile(.episodic), label: MemoryKind.episodic.label, icon: "history")
                    }
                    card(title: L("memoryPage.menu.projects"), isOpen: $projectsOpen) {
                        if memories.projects.isEmpty {
                            Text(L("memoryPage.menu.noProjects"))
                                .webText(13.6, lineHeight: 20.4)
                                .foregroundStyle(AppTheme.textMuted)
                                .frame(maxWidth: .infinity, minHeight: 48)
                        }
                        ForEach(memories.projects) { project in
                            row(.project(project.projectId), label: project.name, icon: "folder")
                        }
                    }
                    .frame(maxHeight: .infinity, alignment: .top)
                }
            },
            results: {
                MenuSearchResults(query: trimmedQuery, types: ["memory"], untitledLabel: L("memoryPage.menu.untitled")) { result in
                    router.navigate(.memoryDetail(result.key))
                    onClose()
                }
            }
        )
        .task { await memories.load() }
    }

    private func card<Rows: View>(title: String, isOpen: Binding<Bool>, @ViewBuilder rows: () -> Rows) -> some View {
        VStack(spacing: 0) {
            SectionHeader(title: title, isExpanded: isOpen.wrappedValue, canExpand: true, action: { EmptyView() }) {
                isOpen.wrappedValue.toggle()
            }
            if isOpen.wrappedValue {
                HuggingScrollView {
                    VStack(spacing: 0) { rows() }
                        .padding(.horizontal, 4)
                        .padding(.bottom, 4)
                }
            }
        }
        .sidebarCard()
    }

    private func row(_ scope: MemoryScope, label: String, icon: String) -> some View {
        let active = activeScope == scope
        let count = memories.counts[scope.countKey] ?? 0
        return Button {
            router.memoryScope = scope
            router.navigate(.memory)
            onClose()
        } label: {
            HStack(spacing: 10) {
                WebIcon(name: icon, size: 18, color: AppTheme.textMuted)
                WebTruncatedLine(label)
                    .webText(arial: 15.2, bold: active, lineHeight: 19.76)
                    .foregroundStyle(AppTheme.textSecondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if count > 0 {
                    Text("\(count)")
                        .webText(arial: 12)
                        .foregroundStyle(AppTheme.textMuted)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 1.6)
                        .background(AppTheme.backgroundTertiary)
                        .clipShape(Capsule())
                }
            }
            .padding(.horizontal, 8)
            .frame(minHeight: 48)
            .background(active ? AppTheme.backgroundSelected : Color.clear)
            .clipShape(RoundedRectangle(cornerRadius: DSRadius.md))
            .contentShape(Rectangle())
        }
        .buttonStyle(RowPressStyle())
        .accessibilityAddTraits(active ? .isSelected : [])
        .accessibilityIdentifier("memory-scope-\(scope.countKey)")
    }
}

// MARK: - Dialogs

extension View {
    /// The actions sheet, move/copy and delete dialogs for `dialog`. `onDeleted` gets whether the
    /// memory is gone (false: it only left a project).
    func memoryDialogs(_ dialog: Binding<MemoryDialog?>, onMoved: ((CustomerMemory) -> Void)? = nil, onDeleted: @escaping (Bool) -> Void) -> some View {
        overlay {
            switch dialog.wrappedValue {
            case .actions(let memory, let placement):
                MemoryActionsSheet(memory: memory, placement: placement, dialog: dialog)
            case .move(let memory, let placement, let copy):
                WebModal(title: L(copy ? "memoryPage.move.copyTitle" : "memoryPage.move.moveTitle"), onClose: { dialog.wrappedValue = nil }) {
                    MoveMemoryForm(memory: memory, from: placement, initialCopy: copy, onDone: onMoved) { dialog.wrappedValue = nil }
                }
            case .delete(let memory, let placement):
                WebModal(title: L("memoryPage.delete.title"), maxWidth: 448, onClose: { dialog.wrappedValue = nil }) {
                    DeleteMemoryForm(memory: memory, from: placement, onDone: onDeleted) { dialog.wrappedValue = nil }
                }
            case nil:
                EmptyView()
            }
        }
    }
}

/// Phones: a memory's actions in a sheet from the bottom of the screen.
struct MemoryActionsSheet: View {
    @EnvironmentObject var router: AppRouter
    @EnvironmentObject var memories: MemoriesStore
    let memory: CustomerMemory
    let placement: MemoryPlacement
    @Binding var dialog: MemoryDialog?

    var body: some View {
        ZStack(alignment: .bottom) {
            Color.black.opacity(0.55)
                .ignoresSafeArea()
                .onTapGesture { dialog = nil }
                .accessibilityLabel(L("memoryPage.list.closeActions"))
                .accessibilityAddTraits(.isButton)
            VStack(alignment: .leading, spacing: 0) {
                Capsule().fill(AppTheme.textMuted.opacity(0.6)).frame(width: 40, height: 4)
                    .frame(maxWidth: .infinity)
                    .padding(.top, 8)
                    .padding(.bottom, 12)
                VStack(alignment: .leading, spacing: 6) {
                    Text(memory.text).webText(16, lineHeight: 23).foregroundStyle(AppTheme.textPrimary)
                    Text([
                        MemoryLabels.placement(placement, store: memories),
                        L("memoryPage.list.usedSummary", ["count": memory.hitCount]),
                        L("memoryPage.list.versionSummary", ["version": memory.version]),
                    ].joined(separator: " · "))
                    .webText(12.8)
                    .foregroundStyle(AppTheme.textMuted)
                }
                .padding(.horizontal, 8)
                .padding(.bottom, 14)
                Rectangle().fill(AppTheme.borderLight).frame(height: 1)
                ForEach(MemoryActionItem.list(for: placement)) { item in
                    Button { select(item) } label: {
                        HStack(spacing: 14) {
                            WebIcon(name: item.icon, size: 20, color: item.kind == .delete ? AppTheme.error : AppTheme.textMuted)
                            Text(item.label)
                                .webText(16)
                                .foregroundStyle(item.kind == .delete ? AppTheme.error : AppTheme.textSecondary)
                            Spacer(minLength: 0)
                        }
                        .padding(.horizontal, 8)
                        .frame(minHeight: 52)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(RowPressStyle())
                    .accessibilityIdentifier("memory-sheet-\(item.kind.rawValue)")
                }
            }
            .padding(.horizontal, 12)
            .padding(.bottom, 20)
            .background(AppTheme.backgroundSecondary)
            .clipShape(UnevenRoundedRectangle(topLeadingRadius: 16, topTrailingRadius: 16))
            .overlay(alignment: .top) { Rectangle().fill(AppTheme.border).frame(height: 1) }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("memory-actions-sheet")
        }
        .ignoresSafeArea(.container, edges: .bottom)
        .preference(key: DialogShownKey.self, value: true)
    }

    private func select(_ item: MemoryActionItem) {
        switch item.kind {
        case .edit:
            dialog = nil
            router.navigate(.memoryDetail(memory.memoryId))
        case .move: dialog = .move(memory, placement, copy: false)
        case .copy: dialog = .move(memory, placement, copy: true)
        case .delete: dialog = .delete(memory, placement)
        }
    }
}

/// Move changes where a memory applies; copy (project memories only) adds another project that
/// shares the same memory. Neither touches its versions or change log (MoveMemoryDialog.tsx).
struct MoveMemoryForm: View {
    @EnvironmentObject var memories: MemoriesStore
    @EnvironmentObject var toasts: ToastCenter
    let memory: CustomerMemory
    let from: MemoryPlacement
    let onDone: ((CustomerMemory) -> Void)?
    let onClose: () -> Void

    private static let profileKey = "profile"
    @State private var copy: Bool
    @State private var target: String?
    @State private var kind: MemoryKind
    @State private var saving = false

    init(memory: CustomerMemory, from: MemoryPlacement, initialCopy: Bool, onDone: ((CustomerMemory) -> Void)?, onClose: @escaping () -> Void) {
        self.memory = memory
        self.from = from
        self.onDone = onDone
        self.onClose = onClose
        _copy = State(initialValue: initialCopy && !memory.isProfile)
        _kind = State(initialValue: from.kind)
    }

    private var unchanged: Bool { !copy && target == (from.projectId ?? Self.profileKey) && kind == from.kind }
    private var ready: Bool { target != nil && !unchanged }
    private var projectTargets: [Project] {
        memories.projects.filter { project in !copy || !memory.placements.contains { $0.projectId == project.projectId } }
    }

    private var place: String {
        guard let target else { return "" }
        return target == Self.profileKey ? L("memoryPage.scopes.profile") : memories.projectName(target)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 6) {
                Text(memory.text).webText(14.5, lineHeight: 21).foregroundStyle(AppTheme.textPrimary)
                Text(L("memoryPage.move.appliesIn", ["place": MemoryLabels.placement(from, store: memories)]))
                    .webText(12)
                    .foregroundStyle(AppTheme.textMuted)
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(AppTheme.backgroundTertiary)
            .clipShape(RoundedRectangle(cornerRadius: DSRadius.lg))

            if !memory.isProfile {
                HStack(spacing: 4) {
                    ForEach([false, true], id: \.self) { isCopy in
                        Button {
                            copy = isCopy
                            target = nil
                        } label: {
                            Text(L(isCopy ? "memoryPage.move.copy" : "memoryPage.move.move"))
                                .webText(arial: 15, bold: copy == isCopy)
                                .foregroundStyle(copy == isCopy ? AppTheme.primary : AppTheme.textSecondary)
                                .frame(maxWidth: .infinity, minHeight: 44)
                                .background(copy == isCopy ? AppTheme.backgroundSelected : Color.clear)
                                .clipShape(Capsule())
                                .contentShape(Capsule())
                        }
                        .buttonStyle(WebPressStyle())
                        .accessibilityIdentifier("memory-mode-\(isCopy ? "copy" : "move")")
                    }
                }
                .padding(3)
                .overlay(Capsule().strokeBorder(AppTheme.border, lineWidth: 1))
            }
            Text(explain).webText(13, lineHeight: 19).foregroundStyle(AppTheme.textMuted)

            VStack(alignment: .leading, spacing: 2) {
                Text(L("memoryPage.move.whereItApplies")).webText(13, 600).foregroundStyle(AppTheme.textSecondary)
                    .padding(.bottom, 6)
                if !copy { destination(Self.profileKey, label: L("memoryPage.scopes.profile")) }
                ForEach(projectTargets) { project in destination(project.projectId, label: project.name) }
                if copy && projectTargets.isEmpty {
                    Text(L("memoryPage.move.noOtherProjects")).webText(13).foregroundStyle(AppTheme.textMuted)
                }
            }

            VStack(alignment: .leading, spacing: 8) {
                Text(L("memoryPage.move.kind")).webText(13, 600).foregroundStyle(AppTheme.textSecondary)
                MemoryKindToggle(kind: $kind)
                Text(MemoryLabels.kindHelp(kind, inProject: target != nil && target != Self.profileKey))
                    .webText(13, lineHeight: 19)
                    .foregroundStyle(AppTheme.textMuted)
            }

            HStack(spacing: 12) {
                PillButton(label: L("memoryPage.move.cancel"), style: .secondary, disabled: saving, minWidth: nil, action: onClose)
                PillButton(label: confirmLabel, disabled: !ready || saving, fullWidth: true) { Task { await submit() } }
                    .accessibilityIdentifier("memory-move-confirm")
            }
        }
        .accessibilityIdentifier("move-memory-dialog")
    }

    private var explain: String {
        if copy { return L("memoryPage.move.copyExplain") }
        if target == Self.profileKey && from.projectId != nil { return L("memoryPage.move.moveToProfileExplain") }
        return L("memoryPage.move.moveExplain")
    }

    private var confirmLabel: String {
        if unchanged { return L("memoryPage.move.alreadyHere") }
        guard target != nil else { return L("memoryPage.move.chooseWhere") }
        return L(copy ? "memoryPage.move.confirmCopy" : "memoryPage.move.confirmMove", ["place": place, "kind": kind.label])
    }

    private func destination(_ key: String, label: String) -> some View {
        let here = copy ? nil : memory.placements.first { ($0.projectId ?? Self.profileKey) == key }
        return Button { target = key } label: {
            HStack(spacing: 12) {
                Image(systemName: target == key ? "largecircle.fill.circle" : "circle")
                    .foregroundStyle(target == key ? AppTheme.primary : AppTheme.textMuted)
                    .font(.system(size: 18))
                WebTruncatedLine(label)
                    .webText(16)
                    .foregroundStyle(AppTheme.textPrimary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if let here {
                    Text(L("memoryPage.move.currentlyHere", ["kind": here.kind.label]))
                        .webText(12.5)
                        .foregroundStyle(AppTheme.textMuted)
                }
            }
            .padding(.horizontal, 10)
            .frame(minHeight: 48)
            .background(target == key ? AppTheme.backgroundSelected : Color.clear)
            .clipShape(RoundedRectangle(cornerRadius: DSRadius.lg))
            .contentShape(Rectangle())
        }
        .buttonStyle(WebPressStyle())
        .accessibilityAddTraits(target == key ? .isSelected : [])
        .accessibilityIdentifier("memory-destination-\(key)")
    }

    private func submit() async {
        guard ready, let target else { return }
        saving = true
        defer { saving = false }
        do {
            let updated = copy
                ? try await memories.copy(memory, fromProjectId: from.projectId ?? "", toProjectId: target, kind: kind)
                : try await memories.move(memory, from: from, toProjectId: target == Self.profileKey ? nil : target, kind: kind)
            toasts.showToast(L(copy ? "memoryPage.move.copied" : "memoryPage.move.moved"))
            onDone?(updated)
            onClose()
        } catch let error as APIError where error.status == 409 {
            toasts.showToast(L("memoryPage.detail.conflict"))
        } catch {
            toasts.showToast(L("memoryPage.move.failed"))
        }
    }
}

/// Confirms deleting a memory, or removing it from one of the projects that share it.
struct DeleteMemoryForm: View {
    @EnvironmentObject var memories: MemoriesStore
    @EnvironmentObject var toasts: ToastCenter
    let memory: CustomerMemory
    let from: MemoryPlacement
    let onDone: (Bool) -> Void
    let onClose: () -> Void

    @State private var busy = false

    private var others: Int {
        guard let projectId = from.projectId else { return 0 }
        return memory.placements.filter { $0.projectId != projectId }.count
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(others > 0 ? L("memoryPage.delete.sharedConfirm", ["count": others]) : L("memoryPage.delete.confirm"))
                .webText(14.5, lineHeight: 21)
                .foregroundStyle(AppTheme.textPrimary)
            VStack(spacing: 10) {
                if others > 0 {
                    PillButton(label: L("memoryPage.delete.removeHere"), style: .secondary, disabled: busy, fullWidth: true) {
                        Task { await run(onlyHere: true) }
                    }
                    .accessibilityIdentifier("memory-remove-here")
                }
                PillButton(
                    label: busy ? L("memoryPage.delete.deleting") : L(others > 0 ? "memoryPage.delete.deleteEverywhere" : "memoryPage.delete.delete"),
                    style: .danger, disabled: busy, fullWidth: true
                ) {
                    Task { await run(onlyHere: false) }
                }
                .accessibilityIdentifier("memory-delete-confirm")
                PillButton(label: L("memoryPage.move.cancel"), style: .secondary, disabled: busy, fullWidth: true, action: onClose)
            }
        }
        .accessibilityIdentifier("delete-memory-dialog")
    }

    private func run(onlyHere: Bool) async {
        busy = true
        defer { busy = false }
        do {
            let deleted = try await memories.delete(memory.memoryId, projectId: onlyHere ? from.projectId : nil)
            toasts.showToast(L(deleted ? "memoryPage.delete.deleted" : "memoryPage.delete.removed"))
            onClose()
            onDone(deleted)
        } catch {
            toasts.showToast(L("memoryPage.delete.failed"))
        }
    }
}
