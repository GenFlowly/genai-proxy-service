import SwiftUI

/// The history menu content (ConversationHistoryComponent): the Projects and Chats widgets at
/// their full height in the menu's scrolling column (SidebarStack), with fork trees, per-row
/// swipe actions (Pin to the right; Move and Delete, or Rename and Delete project, to the left),
/// infinite scroll, and the project and delete dialogs.
struct ConversationHistoryPanel: View {
    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var conversation: ConversationStore
    @EnvironmentObject var router: AppRouter
    @EnvironmentObject var history: HistoryStore
    @EnvironmentObject var memories: MemoriesStore

    /// Fires on tap, before the conversation loads, so the menu closes immediately.
    let onSelect: () -> Void

    @State private var isCreateProjectOpen = false
    @State private var newProjectName = ""
    @State private var isCreatingProject = false
    @State private var renameTarget: Project?
    @State private var renameName = ""
    @State private var isRenamingProject = false
    @State private var deleteProjectTarget: Project?
    @State private var isDeletingProject = false
    @State private var deleteProjectError: String?
    @State private var moveTarget: ConversationSummary?
    /// Deleting is permanent, so a row's Delete asks first.
    @State private var deleteTarget: ConversationSummary?
    @State private var isDeleting = false
    @State private var deleteError: String?
    @State private var openRow: SwipeOpenRow?
    /// The project just expanded, until its row has scrolled up with its conversations loaded.
    @State private var revealingProject: String?
    @Environment(\.sidebarStack) private var stack
    /// The web's `scroll-margin-top` on an expanding project: it lands 44pt below the column's top.
    private static let revealMargin: CGFloat = 44

    private var showProjectsPanel: Bool { history.hasAnyData || (!history.isLoading && !history.loadFailed) }

    var body: some View {
        SidebarStack {
            if showProjectsPanel { projectsWidget }
            chatsWidget
        }
        .onChange(of: revealingProject) { _, _ in revealProject() }
        // Conversations load after the first scroll, and only then can the row reach the top.
        .onChange(of: revealingProject.flatMap { history.projectItems[$0]?.count }) { _, _ in revealProject() }
        .onChange(of: stack?.interactions) { _, _ in
            revealingProject = nil
            openRow = nil
        }
        .webModal(isPresented: $isCreateProjectOpen, title: L("conversation.conversationHistory.newProjectTitle"), maxWidth: 416) {
            createProjectForm
        }
        .webModal(isPresented: Binding(get: { renameTarget != nil }, set: { if !$0 { renameTarget = nil } }), title: L("conversation.conversationHistory.renameProjectTitle"), maxWidth: 416) {
            renameProjectForm
        }
        .webModal(isPresented: Binding(get: { moveTarget != nil }, set: { if !$0 { moveTarget = nil } }), title: L("conversation.conversationHistory.moveToProjectTitle"), maxWidth: 416) {
            moveToProjectPicker
        }
        .deleteConfirmModal(
            isPresented: Binding(get: { deleteTarget != nil }, set: { if !$0 { deleteTarget = nil } }),
            title: L("conversation.conversationHistory.deleteConversationTitle"),
            message: L("conversation.conversationHistory.deleteConversationConfirm"),
            isDeleting: isDeleting,
            error: deleteError
        ) {
            Task { await deleteConversation() }
        }
        .deleteConfirmModal(
            isPresented: Binding(get: { deleteProjectTarget != nil }, set: { if !$0 { deleteProjectTarget = nil } }),
            title: L("conversation.conversationHistory.deleteProjectTitle"),
            message: L("conversation.conversationHistory.deleteProjectConfirm", ["name": deleteProjectTarget?.name ?? ""]),
            isDeleting: isDeletingProject,
            error: deleteProjectError
        ) {
            Task { await deleteProject() }
        }
        .task(id: auth.customerId) { await history.load() }
        .onAppear { history.ensureExpandedProjectsLoaded(activeId: activeId) }
        .onChange(of: history.projects.map(\.projectId)) { _, _ in history.ensureExpandedProjectsLoaded(activeId: activeId) }
        .onChange(of: history.projectItems.mapValues { $0.map(\.conversationId) }) { _, _ in history.ensureExpandedProjectsLoaded(activeId: activeId) }
        .onChange(of: activeId) { _, id in history.ensureExpandedProjectsLoaded(activeId: id) }
    }

    private var activeId: String? { conversation.conversationId.isEmpty ? nil : conversation.conversationId }

    private func deleteConversation() async {
        guard let target = deleteTarget else { return }
        isDeleting = true
        deleteError = nil
        defer { isDeleting = false }
        do {
            try await history.delete(target, activeId: activeId) {
                conversation.resetConversation()
            }
            deleteTarget = nil
        } catch {
            deleteError = L("conversation.conversationHistory.deleteFailed")
        }
    }

    private func deleteProject() async {
        guard let target = deleteProjectTarget else { return }
        isDeletingProject = true
        deleteProjectError = nil
        defer { isDeletingProject = false }
        do {
            try await history.deleteProject(target)
            memories.projectDeleted(target.projectId)
            // A new chat waiting to start in the project starts outside it instead
            if conversation.pendingProjectId == target.projectId { conversation.pendingProjectId = nil }
            deleteProjectTarget = nil
        } catch {
            deleteProjectError = L("conversation.conversationHistory.deleteProjectFailed")
        }
    }

    private func renameProject() async {
        guard let target = renameTarget, !isRenamingProject else { return }
        isRenamingProject = true
        defer { isRenamingProject = false }
        let name = renameName.trimmingCharacters(in: .whitespacesAndNewlines)
        if await history.renameProject(target, to: name) {
            memories.projectRenamed(target.projectId, to: name)
            renameTarget = nil
        }
    }

    // MARK: - Projects widget

    private var projectsWidget: some View {
        SidebarWidget(
            variant: .history,
            title: L("conversation.conversationHistory.projects"),
            icon: "folder",
            collapsible: true,
            isExpanded: history.isSectionExpanded("projects"),
            onToggle: { history.toggleSection("projects") },
            bodyInsets: EdgeInsets(),
            toggleIdentifier: "conv-history-projects-heading",
            actions: {
                SidebarHeaderAction(icon: "folder-plus", label: L("conversation.conversationHistory.newProject"), identifier: "conv-history-new-project") {
                    newProjectName = ""
                    isCreateProjectOpen = true
                }
            }
        ) {
            projectsList
        }
    }

    /// SidebarListPanel's `scrollIntoView` on expand: the row goes up to the column's top, 44pt
    /// below it (`scroll-margin-top`). Not on collapse, and not on appear.
    private func revealProject() {
        guard let id = revealingProject, let stack else { return }
        if history.projectItems[id] != nil { revealingProject = nil }
        let anchor = UnitPoint(x: 0, y: Self.revealMargin / max(stack.viewportHeight, Self.revealMargin))
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
            withAnimation(.easeOut(duration: 0.3)) { stack.proxy.scrollTo(Self.projectAnchor(id), anchor: anchor) }
        }
    }

    private static func projectAnchor(_ id: String) -> String { "project-\(id)" }

    private var projectsList: some View {
        LazyVStack(alignment: .leading, spacing: 0) {
            ForEach(history.projects) { project in
                projectRow(project)
            }
            if history.projects.isEmpty {
                Text(L("conversation.conversationHistory.noProjectsYet"))
                    .webText(13.6, lineHeight: 20.4)
                    .foregroundStyle(AppTheme.textMuted)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 16)
                    .frame(maxWidth: .infinity)
            }
        }
        .padding(.horizontal, 6)
        .padding(.bottom, 8)
    }

    private func projectRow(_ project: Project) -> some View {
        let expanded = history.isProjectExpanded(project.projectId)
        let membersKnown = history.projectItems[project.projectId] != nil
        let pinned = history.projectPinned(project.projectId)
        let recent = history.projectRecent(project.projectId)
        let cursor = history.projectCursors[project.projectId]
        let canExpand = !membersKnown || !pinned.isEmpty || !recent.isEmpty || cursor != nil
        let isOpen = expanded && canExpand

        return VStack(alignment: .leading, spacing: 0) {
            Color.clear.frame(height: 0).id(Self.projectAnchor(project.projectId))
            SwipeableRow(id: "project-\(project.projectId)", openRow: $openRow, trailing: [
                SwipeAction(icon: "edit", label: L("conversation.conversationHistory.renameProject"), tone: .neutral, identifier: "conv-history-project-rename-\(project.projectId)") {
                    renameName = project.name
                    renameTarget = project
                },
                SwipeAction(icon: "trash", label: L("conversation.conversationHistory.deleteProject"), tone: .muted, identifier: "conv-history-project-delete-\(project.projectId)") {
                    deleteProjectError = nil
                    deleteProjectTarget = project
                },
            ]) {
                ZStack(alignment: .trailing) {
                    Button {
                        guard canExpand else { return }
                        history.toggleProject(project.projectId)
                        revealingProject = expanded ? nil : project.projectId
                    } label: {
                        HStack(spacing: 8) {
                            if canExpand {
                                Chevron(expanded: expanded)
                            } else {
                                Color.clear.frame(width: 12, height: 12)
                            }
                            WebTruncatedLine(project.name)
                                .sidebarRowText(.history, group: true)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .padding(.leading, 10)
                        .padding(.trailing, 48)
                        .frame(minHeight: SidebarRowTokens.history.groupMinHeight)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(SidebarRowPressStyle(.history))
                    .accessibilityIdentifier("conv-history-project-\(project.projectId)")

                    MenuRowAction(icon: "add-icon", label: L("conversation.conversationHistory.newConversationInProject"), identifier: "conv-history-project-new-conv-\(project.projectId)") {
                        history.expandedProjects[project.projectId] = true
                        history.ensureProjectLoaded(project.projectId)
                        conversation.startConversationInProject(project.projectId)
                        router.navigate(.chat)
                        onSelect()
                    }
                }
            }
            .menuRowHairline(!isOpen)

            if isOpen {
                VStack(alignment: .leading, spacing: 0) {
                    if !pinned.isEmpty {
                        MenuSectionLabel(title: L("conversation.conversationHistory.pinned"))
                        treeRows(pinned, isPinned: true, lastId: recent.isEmpty && membersKnown ? pinned.last?.conversationId : nil)
                    }
                    if !recent.isEmpty || cursor != nil || !membersKnown {
                        MenuSectionLabel(title: L("conversation.conversationHistory.recent"))
                        treeRows(recent, isPinned: false, lastId: membersKnown ? recent.last?.conversationId : nil)
                        if !membersKnown {
                            plainRow(L("conversation.conversationHistory.loading")) { history.ensureProjectLoaded(project.projectId) }
                        }
                    }
                }
                .menuTreeGuide()
            }
        }
    }

    private func plainRow(_ label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(label)
                .sidebarRowText(.history)
                .padding(.horizontal, 12)
                .padding(.vertical, 11)
                .frame(maxWidth: .infinity, minHeight: SidebarRowTokens.history.minHeight, alignment: .topLeading)
                .contentShape(Rectangle())
        }
        .buttonStyle(SidebarRowPressStyle(.history))
    }

    // MARK: - Chats widget

    private var chatsWidget: some View {
        SidebarWidget(
            variant: .history,
            title: L("conversation.conversationHistory.chats"),
            icon: "chat-bubble",
            collapsible: true,
            isExpanded: history.isSectionExpanded("history"),
            onToggle: { history.toggleSection("history") },
            bodyInsets: EdgeInsets(),
            toggleIdentifier: "conv-history-history-heading"
        ) {
            Group {
                if history.isLoading && !history.hasAnyData {
                    skeleton
                } else if history.loadFailed && !history.hasAnyData {
                    centered(L("conversation.conversationHistory.failedToLoad"))
                } else if history.globalPinned.isEmpty && history.globalRecent.isEmpty {
                    centered(L("conversation.conversationHistory.noConversationsYet"))
                } else {
                    chatsList
                }
            }
        }
    }

    /// The rows grow the card; the column around the cards does the scrolling, so the section
    /// headings pin to its top and paging follows its scroll.
    private var chatsList: some View {
        LazyVStack(alignment: .leading, spacing: 0, pinnedViews: [.sectionHeaders]) {
            if !history.globalPinned.isEmpty {
                Section {
                    treeRows(history.globalPinned, isPinned: true)
                } header: {
                    MenuSectionLabel(title: L("conversation.conversationHistory.pinned"), icon: "pin")
                        .background(AppTheme.sidebarSurface)
                }
            }
            if !history.globalRecent.isEmpty {
                Section {
                    treeRows(history.globalRecent, isPinned: false)
                } header: {
                    MenuSectionLabel(title: L("conversation.conversationHistory.recents"))
                        .background(AppTheme.sidebarSurface)
                }
            }
            // Infinite scroll: older pages stream in as the end comes near, paused while a
            // fetch runs and after a failure (a failed page retries itself with backoff;
            // there is no Load more button). Each page re-arms it, so a page too short to
            // fill the list requests the next one. Unstructured because scrolling away must
            // not cancel a request that's already out.
            if history.hasMore {
                Color.clear
                    .frame(height: 1)
                    .task(id: history.lastKey) {
                        Task { await history.loadMore() }
                    }
            }
        }
        .padding(.horizontal, 6)
        .padding(.bottom, 8)
    }

    private func centered(_ text: String) -> some View {
        Text(text)
            .webText(13.6, lineHeight: 20.4)
            .foregroundStyle(AppTheme.textMuted)
            .multilineTextAlignment(.center)
            .padding(.horizontal, 8)
            .padding(.vertical, 16)
            .frame(maxWidth: .infinity)
            .frame(maxHeight: .infinity, alignment: .top)
    }

    private var skeleton: some View {
        VStack(spacing: 3) {
            ForEach(0..<5, id: \.self) { index in
                GeometryReader { proxy in
                    RoundedRectangle(cornerRadius: DSRadius.sm)
                        .fill(AppTheme.borderLight)
                        .frame(width: proxy.size.width * (0.7 + CGFloat(index % 3) * 0.1))
                }
                .frame(height: 40)
            }
            Spacer(minLength: 0)
        }
        .padding(10)
    }

    // MARK: - Rows

    /// Nests forks under their parent when it renders in the same list; otherwise a fork
    /// stays a flat root, so it never disappears just because its parent moved elsewhere.
    /// `lastId` is the row that closes a project's tree, which draws no hairline.
    @ViewBuilder
    private func treeRows(_ list: [ConversationSummary], isPinned: Bool, lastId: String? = nil) -> some View {
        let ids = Set(list.map(\.conversationId))
        let roots = list.filter { c in
            guard let parent = c.parentConversationId, parent != c.conversationId else { return true }
            return !ids.contains(parent)
        }
        // Pinned and Recents share one lazy list, which would otherwise carry a row's old actions
        // over when pinning moves it between the two
        ForEach(roots, id: \.conversationId) { root in
            TreeRow(conversation: root, all: list, isPinned: isPinned, row: { c in
                AnyView(historyRow(c, isPinned: isPinned).menuRowHairline(c.conversationId != lastId))
            })
            .id("\(isPinned)-\(root.conversationId)")
        }
    }

    private func historyRow(_ item: ConversationSummary, isPinned: Bool) -> some View {
        let isActive = item.conversationId == activeId
        return SwipeableRow(
            id: item.conversationId,
            openRow: $openRow,
            leading: [
                SwipeAction(
                    icon: isPinned ? "pin-off" : "pin",
                    label: isPinned ? L("conversation.conversationHistory.unpin") : L("conversation.conversationHistory.pin"),
                    tone: .primary,
                    identifier: "conv-\(isPinned ? "unpin" : "pin")-btn-\(item.conversationId)"
                ) {
                    Task { if isPinned { await history.unpin(item) } else { await history.pin(item) } }
                },
            ],
            trailing: [
                SwipeAction(icon: "folder", label: L("conversation.conversationHistory.moveToProject"), tone: .neutral, identifier: "conv-move-btn-\(item.conversationId)") {
                    moveTarget = item
                },
                SwipeAction(icon: "trash", label: L("conversation.conversationHistory.delete"), tone: .muted, identifier: "conv-delete-btn-\(item.conversationId)") {
                    deleteError = nil
                    deleteTarget = item
                },
            ]
        ) {
            Button {
                router.navigate(.chat)
                Task { await conversation.loadConversation(item.conversationId) }
                onSelect()
            } label: {
                VStack(alignment: .leading, spacing: 4) {
                    let unread = item.unread == true && !isActive
                    HStack(spacing: 6.4) {
                        // Unread is bold like the selected row, in the row's own color (web .unreadTitle).
                        WebTruncatedLine(displayTitle(item))
                            .webText(arial: SidebarRowTokens.history.fontSize, bold: isActive || unread, lineHeight: SidebarRowTokens.history.lineHeight)
                            .foregroundStyle(isActive ? SidebarRowTokens.history.activeColor : SidebarRowTokens.history.color)
                        if unread {
                            // Web's .unreadDot: 0.45rem, the primary color
                            Circle()
                                .fill(AppTheme.primary)
                                .frame(width: 7.2, height: 7.2)
                                .accessibilityLabel(L("conversation.conversationHistory.unreadReply"))
                                .accessibilityIdentifier("conv-history-unread-dot")
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    details(item, isActive: isActive)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 11)
                .frame(maxWidth: .infinity, minHeight: SidebarRowTokens.history.minHeight, alignment: .topLeading)
                .sidebarRowFill(.history, active: isActive)
                .contentShape(Rectangle())
            }
            .buttonStyle(SidebarRowPressStyle(.history))
            .accessibilityIdentifier("conv-history-item-\(item.conversationId)")
        }
    }

    private func displayTitle(_ item: ConversationSummary) -> String {
        let title = item.title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return title.isEmpty ? L("conversation.conversationHistory.untitledConversation") : title
    }

    private func details(_ item: ConversationSummary, isActive: Bool) -> some View {
        HStack(spacing: 4.8) {
            HStack(spacing: 2.4) {
                ForEach(Array((item.vendors ?? []).sorted().enumerated()), id: \.offset) { _, vendor in
                    CollapsedVendorBrandName(vendorId: vendor, size: 11).opacity(0.7)
                }
            }
            if !(item.vendors ?? []).isEmpty, item.updatedAt != nil {
                Text("·").opacity(0.7)
            }
            if let date = ServerDate.parse(item.updatedAt) {
                // Same-day conversations don't need the date — time only.
                Text(Calendar.current.isDateInToday(date) ? ServerDate.time(date) : ServerDate.dateTime(date))
                    .lineLimit(1)
            }
        }
        .webText(arial: 11.52, lineHeight: 13.824)
        .foregroundStyle(AppTheme.textMuted)
    }

    // MARK: - Dialogs

    private var createProjectForm: some View {
        VStack(alignment: .trailing, spacing: 16) {
            InputTextWithHint(placeholder: L("conversation.conversationHistory.projectNamePlaceholder"), text: $newProjectName, autofocus: true)
                .accessibilityIdentifier("new-project-name-input")
            dialogButton(
                label: isCreatingProject ? L("conversation.conversationHistory.creatingProject") : L("conversation.conversationHistory.createProject"),
                disabled: newProjectName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isCreatingProject,
                identifier: "new-project-create-btn"
            ) {
                Task {
                    let name = newProjectName.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !name.isEmpty, !isCreatingProject else { return }
                    isCreatingProject = true
                    defer { isCreatingProject = false }
                    if await history.createProject(name: name) {
                        isCreateProjectOpen = false
                        newProjectName = ""
                    }
                }
            }
        }
    }

    private var renameProjectForm: some View {
        let trimmed = renameName.trimmingCharacters(in: .whitespacesAndNewlines)
        let unchanged = trimmed == renameTarget?.name
        return VStack(alignment: .trailing, spacing: 16) {
            InputTextWithHint(placeholder: L("conversation.conversationHistory.projectNamePlaceholder"), text: $renameName, autofocus: true)
                .accessibilityIdentifier("rename-project-name-input")
            dialogButton(
                label: isRenamingProject ? L("conversation.conversationHistory.savingProjectName") : L("conversation.conversationHistory.saveProjectName"),
                disabled: trimmed.isEmpty || unchanged || isRenamingProject,
                identifier: "rename-project-save-btn"
            ) {
                Task { await renameProject() }
            }
        }
    }

    private func dialogButton(label: String, disabled: Bool, identifier: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(label)
                .webText(arial: 13.6, bold: true)
                .foregroundStyle(.white)
                .padding(.horizontal, 16)
                .padding(.vertical, 7.2)
                .background(AppTheme.primary)
                .clipShape(RoundedRectangle(cornerRadius: DSRadius.md))
        }
        .buttonStyle(WebPressStyle())
        .disabled(disabled)
        .opacity(disabled ? 0.5 : 1)
        .accessibilityIdentifier(identifier)
    }

    @ViewBuilder
    private var moveToProjectPicker: some View {
        if let target = moveTarget {
            VStack(alignment: .leading, spacing: 12) {
                if history.projects.isEmpty {
                    Text(L("conversation.conversationHistory.noProjectsYet")).webText(14.4).foregroundStyle(AppTheme.textMuted)
                } else {
                    VStack(spacing: 2) {
                        ForEach(history.projects) { project in
                            let isCurrent = project.projectId == target.projectId
                            Button {
                                moveTarget = nil
                                Task { await history.move(target, to: project) }
                            } label: {
                                HStack(spacing: 8) {
                                    WebIcon(name: "folder", size: 14, color: AppTheme.textSecondary)
                                    WebTruncatedLine(project.name)
                                        .webText(arial: 14.4)
                                        .foregroundStyle(AppTheme.textSecondary)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                    if isCurrent {
                                        Text(L("conversation.conversationHistory.currentProject").uppercased())
                                            .webText(arial: 11.2)
                                            .kerning(0.448)
                                            .foregroundStyle(AppTheme.textMuted)
                                    }
                                }
                                .padding(.horizontal, 9.6)
                                .padding(.vertical, 8)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(RowPressStyle())
                            .disabled(isCurrent)
                            .opacity(isCurrent ? 0.6 : 1)
                            .accessibilityIdentifier("move-to-project-\(project.projectId)")
                        }
                    }
                }
                if target.projectId != nil {
                    Button {
                        moveTarget = nil
                        Task { await history.removeFromProject(target) }
                    } label: {
                        Text(L("conversation.conversationHistory.removeFromProject"))
                            .webText(arial: 12.8)
                            .foregroundStyle(AppTheme.textSecondary)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 6.4)
                            .overlay(RoundedRectangle(cornerRadius: DSRadius.md).strokeBorder(AppTheme.border, lineWidth: 1))
                    }
                    .buttonStyle(WebPressStyle())
                }
            }
        }
    }
}

/// The Chat page's L2 Menu: Projects and History, or search results.
struct ChatMenuContent: View {
    @EnvironmentObject var conversation: ConversationStore
    @EnvironmentObject var router: AppRouter
    @EnvironmentObject var history: HistoryStore
    let onClose: () -> Void

    @State private var query = ""

    private var trimmedQuery: String { query.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        MobileMenuBody(
            searchText: $query,
            searchPlaceholder: L("layout.mobileMenu.searchChats"),
            isShowingResults: !trimmedQuery.isEmpty,
            refresh: { await history.load() },
            cards: { ConversationHistoryPanel(onSelect: onClose) },
            results: {
                MenuSearchResults(
                    query: trimmedQuery,
                    types: ["conversation"],
                    untitledLabel: L("conversation.conversationHistory.untitledConversation"),
                    variant: .history
                ) { result in
                    router.navigate(.chat)
                    Task { await conversation.loadConversation(result.key) }
                    onClose()
                }
            }
        )
    }
}

/// Renders one conversation and, indented behind a tree guide, the forks of it.
private struct TreeRow: View {
    let conversation: ConversationSummary
    let all: [ConversationSummary]
    let isPinned: Bool
    let row: (ConversationSummary) -> AnyView

    private var children: [ConversationSummary] {
        all.filter { $0.parentConversationId == conversation.conversationId && $0.conversationId != conversation.conversationId }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            row(conversation)
            if !children.isEmpty {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(children) { child in
                        TreeRow(conversation: child, all: all, isPinned: isPinned, row: row)
                    }
                }
                .menuTreeGuide()
            }
        }
    }
}

/// Collapsible card header (`.groupHeader.groupHeaderToggle`): uppercase 12/700, 42 tall.
/// Sticky inside its list.
struct SectionHeader<Action: View>: View {
    let title: String
    let isExpanded: Bool
    let canExpand: Bool
    @ViewBuilder let action: () -> Action
    let onToggle: () -> Void

    var body: some View {
        ZStack(alignment: .trailing) {
            Button(action: onToggle) {
                HStack(spacing: 5.6) {
                    Chevron(expanded: isExpanded)
                    Text(title.uppercased())
                        .webText(arial: 12, bold: true)
                        .kerning(0.6)
                        .foregroundStyle(AppTheme.textMuted)
                        .lineLimit(1)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .padding(.leading, 10)
                .padding(.trailing, 48)
                .frame(minHeight: 42)
                .contentShape(Rectangle())
            }
            .buttonStyle(RowPressStyle())
            action()
        }
        .background(AppTheme.sidebarBackground)
    }
}

struct Chevron: View {
    let expanded: Bool

    var body: some View {
        Path { path in
            path.move(to: CGPoint(x: 4.5, y: 3))
            path.addLine(to: CGPoint(x: 7.5, y: 6))
            path.addLine(to: CGPoint(x: 4.5, y: 9))
        }
        .stroke(AppTheme.textMuted, style: StrokeStyle(lineWidth: 1.125, lineCap: .round, lineJoin: .round))
        .frame(width: 12, height: 12)
        .rotationEffect(.degrees(expanded ? 90 : 0))
        .animation(.easeInOut(duration: 0.2), value: expanded)
    }
}

struct RowPressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(configuration.isPressed ? AppTheme.backgroundHover : Color.clear)
            .clipShape(RoundedRectangle(cornerRadius: DSRadius.sm))
    }
}
