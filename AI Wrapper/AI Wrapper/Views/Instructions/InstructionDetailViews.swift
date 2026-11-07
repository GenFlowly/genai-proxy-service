import SwiftUI

// MARK: - Shared (instructionDetail.tsx)

enum InstructionLabels {
    static func role(_ role: String) -> String {
        switch role {
        case "OWNER": return L("instructionDetail.page.roleOwner")
        case "EDIT": return L("instructionDetail.page.roleEdit")
        default: return L("instructionDetail.page.roleView")
        }
    }

    static func usageSummary(_ usage: InstructionUsageResponse?) -> String {
        guard let usage, usage.usageCount > 0, let last = usage.lastUsedAt else { return L("instructionDetail.page.usageNever") }
        return L("instructionDetail.page.usageSummary", ["count": usage.usageCount, "date": MemoryLabels.dateOnly(last)])
    }

    private static func excerpt(_ text: String, max: Int = 240) -> String {
        text.count > max ? String(text.prefix(max - 1)).trimmingCharacters(in: .whitespaces) + "…" : text
    }

    /// One entry per version, newest first, each with what changed since the one before.
    static func history(_ versions: [InstructionResponse], onView: @escaping (Int) -> Void) -> [TimelineEntryItem] {
        let latest = versions.first?.version
        return versions.enumerated().map { index, version in
            let previous = index + 1 < versions.count ? versions[index + 1] : nil
            var facts: [TimelineFact] = []
            if let previous, previous.name != version.name {
                facts.append(TimelineFact(label: L("instructionDetail.page.name"), value: .diff(before: previous.name, after: version.name, short: false)))
            }
            if let previous {
                if previous.instruction != version.instruction {
                    facts.append(TimelineFact(label: L("instructionDetail.page.change"), value: .diff(before: previous.instruction, after: version.instruction, short: true)))
                }
            } else {
                facts.append(TimelineFact(label: L("instructionDetail.page.text"), value: .text(excerpt(version.instruction))))
            }
            let current = version.version == latest
            var entry = TimelineEntryItem(
                id: "v\(version.version)",
                title: L(previous == nil ? "instructionDetail.page.created" : "instructionDetail.page.edited"),
                badge: "v\(version.version)",
                current: current,
                date: MemoryLabels.date(version.createdAt),
                facts: facts
            )
            if !current {
                entry.view = (label: L("instructionDetail.page.viewVersion", ["version": version.version]), action: { onView(version.version) })
            }
            return entry
        }
    }
}

private extension AuthStore {
    /// The instruction's versions, newest first.
    func versions(of instructionId: String) -> [InstructionResponse] {
        customerInstructions.filter { $0.id == instructionId }.sorted { $0.version > $1.version }
    }
}

/// The emoji tile and name at the top of an instruction's card.
private struct InstructionCardHead: View {
    let instruction: InstructionResponse

    var body: some View {
        HStack(spacing: 12) {
            if let icon = instruction.icon, !icon.isEmpty {
                EmojiIcon(text: icon)
                    .frame(width: 44, height: 44)
                    .background(instruction.color.flatMap { $0.isEmpty ? nil : Color(hex: $0) } ?? AppTheme.backgroundTertiary)
                    .clipShape(RoundedRectangle(cornerRadius: 12))
            }
            Text(instruction.name)
                .webText(20, 600, lineHeight: 26)
                .foregroundStyle(AppTheme.textPrimary)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

private struct InstructionChips: View {
    let instruction: InstructionResponse

    var body: some View {
        if instruction.category?.isEmpty == false || instruction.tags?.isEmpty == false {
            FlowLayout(spacing: 6) {
                if let category = instruction.category, !category.isEmpty { DetailChip(text: category, accent: true) }
                ForEach(instruction.tags ?? [], id: \.self) { DetailChip(text: "#\($0)") }
            }
        }
    }
}

private struct InstructionStateView: View {
    let text: String
    var onBack: (() -> Void)?

    var body: some View {
        VStack(spacing: 12) {
            Text(text).webText(16, 600).foregroundStyle(AppTheme.textPrimary).multilineTextAlignment(.center)
            if let onBack { PillButton(label: L("instructionDetail.page.backToList"), style: .secondary, action: onBack) }
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 64)
    }
}

// Longer instructions are clipped, with a button to show the rest.
private let clipChars = 600

// MARK: - Detail (InstructionDetailPage.tsx)

/// One instruction: its name, tags and text with one Edit action, then rows for who it is
/// shared with, how you used it and its versions. `version` shows an older version to
/// restore.
struct InstructionDetailView: View {
    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var router: AppRouter
    @EnvironmentObject var toasts: ToastCenter
    let instructionId: String
    var version: Int?

    @State private var usage: InstructionUsageResponse?
    @State private var usageLoading = true
    @State private var people: [SearchUserResponse]?
    @State private var showShare = false
    @State private var confirmDelete = false
    @State private var showFull = false

    private var versions: [InstructionResponse] { auth.versions(of: instructionId) }
    private var latest: InstructionResponse? { versions.first }
    private var shown: InstructionResponse? { versions.first { $0.version == version && version != latest?.version } ?? latest }
    private var older: Bool { shown != nil && shown?.version != latest?.version }
    private var role: String { latest?.role ?? "VIEW" }
    private var canEdit: Bool { role != "VIEW" }
    private var canShare: Bool { canEdit && auth.canShare }

    private var sharingSummary: String {
        guard canEdit else { return L("instructionDetail.page.sharedWithYouView") }
        let others = (people ?? []).filter { $0.customerId != "PUBLIC" }
        if (people ?? []).contains(where: { $0.customerId == "PUBLIC" }) { return L("instructionDetail.page.everyone") }
        return others.isEmpty ? L("instructionDetail.page.onlyYou") : L("instructionDetail.page.youAndOthers", ["count": others.count])
    }

    var body: some View {
        DetailScaffold(
            title: L("instructionDetail.page.title"),
            subtitle: latest.map { _ in InstructionLabels.role(role) },
            menuItems: menuItems,
            onLeading: router.openPageMenu
        ) {
            if let latest, let shown {
                if older {
                    DetailBanner(
                        text: L("instructionDetail.page.olderBanner", ["version": shown.version, "latest": latest.version]),
                        linkLabel: L("instructionDetail.page.backToLatest"),
                        onLink: { router.navigate(.instructionDetail(instructionId)) }
                    )
                }
                DetailCard {
                    InstructionCardHead(instruction: shown)
                    InstructionChips(instruction: shown)
                    let long = shown.instruction.count > clipChars
                    MarkdownView(text: shown.instruction, options: MarkdownParser.Options(listIndent: 24))
                        .frame(maxHeight: long && !showFull ? 288 : nil, alignment: .top)
                        .clipped()
                        .mask(alignment: .top) {
                            LinearGradient(
                                stops: long && !showFull
                                    ? [.init(color: .black, location: 0.7), .init(color: .clear, location: 1)]
                                    : [.init(color: .black, location: 0), .init(color: .black, location: 1)],
                                startPoint: .top, endPoint: .bottom
                            )
                        }
                        .accessibilityIdentifier("instruction-text")
                    if long {
                        Button { showFull.toggle() } label: {
                            Text(L(showFull ? "instructionDetail.page.showLess" : "instructionDetail.page.showFull"))
                                .webText(14.5, 500)
                                .foregroundStyle(AppTheme.textSecondary)
                                .frame(minHeight: 40)
                        }
                        .buttonStyle(WebPressStyle())
                    }
                    DetailCardFoot(
                        note: L("instructionDetail.page.version", ["version": shown.version])
                            + (shown.createdAt.map { " · " + MemoryLabels.dateOnly($0) } ?? ""),
                        actionLabel: canEdit ? (older ? L("instructionDetail.page.restore", ["next": latest.version + 1]) : L("instructionDetail.page.edit")) : nil,
                        primary: older,
                        actionId: "instruction-edit"
                    ) {
                        router.navigate(.instructionEdit(instructionId, version: older ? shown.version : nil))
                    }
                }
                DetailRowsView(rows: [
                    DetailRowItem(
                        id: "sharing",
                        icon: "share-icon",
                        accent: true,
                        title: L("instructionDetail.page.sharing"),
                        summary: sharingSummary,
                        action: canShare ? { showShare = true } : nil
                    ),
                    DetailRowItem(
                        id: "usage",
                        icon: "chat-bubble",
                        title: L("instructionDetail.page.usage"),
                        summary: usageLoading ? L("instructionDetail.page.loading") : InstructionLabels.usageSummary(usage),
                        action: { router.navigate(.instructionUsage(instructionId)) }
                    ),
                    DetailRowItem(
                        id: "versions",
                        icon: "history",
                        title: L("instructionDetail.page.versions"),
                        summary: latest.createdAt.map { L("instructionDetail.page.versionsSummary", ["version": latest.version, "date": MemoryLabels.dateOnly($0)]) }
                            ?? L("instructionDetail.page.version", ["version": latest.version]),
                        action: { router.navigate(.instructionHistory(instructionId)) }
                    ),
                ])
            } else if auth.isInstructionsLoaded {
                InstructionStateView(text: L("instructionDetail.page.notFound")) { router.navigate(.instructions) }
            } else {
                ProgressView().frame(maxWidth: .infinity).padding(.top, 64)
            }
        }
        .task(id: auth.customerId) {
            await auth.refreshInstructions()
            await load()
        }
        .webModal(isPresented: $showShare, title: L("common.shareModal.title")) {
            ShareModal(target: .instruction(instructionId), onClose: {
                showShare = false
                Task { await loadPeople() }
            })
        }
        .webConfirm(L("instructionDetail.instructionDetailPage.deleteConfirm"), isPresented: $confirmDelete) {
            Task { await delete() }
        }
    }

    private var menuItems: [MobileHeaderMenuItem] {
        guard latest != nil else { return [] }
        var items: [MobileHeaderMenuItem] = []
        if canShare { items.append(MobileHeaderMenuItem(label: L("instructionDetail.instructionDetailPage.share")) { showShare = true }) }
        if role == "OWNER" { items.append(MobileHeaderMenuItem(label: L("instructionDetail.instructionDetailPage.delete")) { confirmDelete = true }) }
        return items
    }

    private func load() async {
        guard let token = try? await auth.getAccessTokenSilently() else { return }
        usageLoading = true
        usage = try? await InstructionService.usage(token: token, instructionId: instructionId)
        usageLoading = false
        await loadPeople()
    }

    private func loadPeople() async {
        guard canEdit, let token = try? await auth.getAccessTokenSilently() else { return }
        people = try? await InstructionService.getInstructionSharedUsers(token: token, instructionId: instructionId)
    }

    private func delete() async {
        do {
            let token = try await auth.getAccessTokenSilently()
            try await InstructionService.deleteInstruction(token: token, instructionId: instructionId)
            await auth.refreshInstructions()
            router.navigate(.instructions)
        } catch {
            toasts.showToast(L("instructionDetail.instructionDetailPage.deleteFailedAlert"))
        }
    }
}

// MARK: - Edit (InstructionEditPage.tsx)

/// Writing an instruction: a new one (`instructionId` nil) or the next version of one
/// (`version` to start from an older one).
struct InstructionEditView: View {
    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var router: AppRouter
    @EnvironmentObject var toasts: ToastCenter
    let instructionId: String?
    var version: Int?

    @State private var name: String?
    @State private var text: String?
    @State private var focused = false
    @State private var saving = false

    private var isNew: Bool { instructionId == nil }
    private var versions: [InstructionResponse] { instructionId.map { auth.versions(of: $0) } ?? [] }
    private var latest: InstructionResponse? { versions.first }
    private var from: InstructionResponse? { versions.first { $0.version == version && version != latest?.version } }
    private var start: InstructionResponse? { from ?? latest }
    private var nextVersion: Int { (latest?.version ?? 0) + 1 }
    private var currentName: String { name ?? (isNew ? "" : start?.name ?? "") }
    private var currentText: String { text ?? (isNew ? "" : start?.instruction ?? "") }

    var body: some View {
        DetailScaffold(
            title: L(isNew ? "instructionDetail.page.newTitle" : "instructionDetail.page.editTitle"),
            subtitle: isNew ? nil : latest?.name,
            backLabel: L(isNew ? "instructionDetail.page.backToList" : "instructionDetail.page.back"),
            onLeading: back,
            actions: isNew || latest != nil ? AnyView(
                HStack(spacing: 12) {
                    PillButton(label: L("instructionDetail.page.cancel"), style: .secondary, disabled: saving, fullWidth: true, action: back)
                    PillButton(
                        label: saving
                            ? L("instructionDetail.instructionDetailPage.savingLabel")
                            : isNew ? L("instructionDetail.page.create") : L("instructionDetail.page.save", ["next": nextVersion]),
                        disabled: saving || currentText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                        fullWidth: true
                    ) { Task { await save() } }
                    .accessibilityIdentifier("instruction-save")
                }
            ) : nil
        ) {
            if isNew || latest != nil {
                if let from {
                    DetailBanner(text: L("memoryPage.page.editingOlder", ["version": from.version, "next": nextVersion]))
                }
                InputTextWithHint(
                    hint: L("instructionDetail.instructionDetailPage.nameHint"),
                    placeholder: L("instructionDetail.instructionDetailPage.namePlaceholder"),
                    text: Binding(get: { currentName }, set: { name = $0 })
                )
                ComposerTextView(
                    text: Binding(get: { currentText }, set: { text = $0 }),
                    isFocused: $focused,
                    focusRequest: 0,
                    focusEndRequest: 0,
                    editorInsets: UIEdgeInsets(top: 2, left: 2, bottom: 2, right: 2),
                    onChange: { _ in },
                    onPasteImages: { _ in }
                )
                .frame(height: 360)
                .background(AppTheme.composerEditorBackground)
                .clipShape(RoundedRectangle(cornerRadius: DSRadius.md))
                .overlay(RoundedRectangle(cornerRadius: DSRadius.md).strokeBorder(focused ? AppTheme.primary : AppTheme.border, lineWidth: 1.5))
                .accessibilityIdentifier("instruction-edit-text")
            } else if auth.isInstructionsLoaded {
                InstructionStateView(text: L("instructionDetail.page.notFound")) { router.navigate(.instructions) }
            } else {
                ProgressView().frame(maxWidth: .infinity).padding(.top, 64)
            }
        }
        .onAppear {
            if let instructionId, latest?.role == "VIEW" { router.navigate(.instructionDetail(instructionId)) }
        }
    }

    private func back() {
        if let instructionId { router.navigate(.instructionDetail(instructionId)) } else { router.navigate(.instructions) }
    }

    private func save() async {
        saving = true
        defer { saving = false }
        do {
            let token = try await auth.getAccessTokenSilently()
            let response = try await InstructionService.createInstruction(
                token: token,
                request: CreateInstructionRequest(
                    instruction: currentText,
                    instructionName: currentName.isEmpty ? nil : currentName,
                    existingInstructionId: instructionId
                )
            )
            auth.updateInstruction(response)
            toasts.showToast(L("instructionDetail.page.saved", ["version": response.version]))
            await auth.refreshInstructions()
            router.navigate(.instructionDetail(response.id))
        } catch {
            toasts.showToast(L("instructionDetail.instructionDetailPage.saveFailedAlert"))
        }
    }
}

// MARK: - Versions (InstructionHistoryPage.tsx)

/// An instruction's versions on their own page, each with what changed.
struct InstructionHistoryView: View {
    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var router: AppRouter
    let instructionId: String

    var body: some View {
        let versions = auth.versions(of: instructionId)
        DetailScaffold(
            title: L("instructionDetail.page.versions"),
            subtitle: versions.first?.name,
            backLabel: L("instructionDetail.page.back"),
            onLeading: { router.navigate(.instructionDetail(instructionId)) }
        ) {
            if !versions.isEmpty {
                DetailIntro(text: L("instructionDetail.page.historyIntro"))
                TimelineView(
                    entries: InstructionLabels.history(versions) { version in
                        router.navigate(.instructionDetail(instructionId, version: version))
                    },
                    untitled: "",
                    deleted: "",
                    onOpenConversation: { _ in }
                )
            } else {
                ProgressView().frame(maxWidth: .infinity).padding(.top, 64)
            }
        }
        // /onboard carries only each instruction's latest version.
        .task(id: auth.customerId) { await auth.refreshInstructions() }
    }
}

// MARK: - Used in (InstructionUsedInPage.tsx)

/// Your conversations that used an instruction, newest first.
struct InstructionUsedInView: View {
    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var router: AppRouter
    @EnvironmentObject var conversation: ConversationStore
    let instructionId: String

    @State private var usage: InstructionUsageResponse?
    @State private var failed = false

    var body: some View {
        let omitted = usage?.omitted ?? 0
        let deleted = usage.map { omitted == 0 ? max(0, $0.usageCount - $0.conversations.count) : 0 } ?? 0
        DetailScaffold(
            title: L("instructionDetail.page.usedIn"),
            subtitle: usage.map { InstructionLabels.usageSummary($0) },
            backLabel: L("instructionDetail.page.back"),
            onLeading: { router.navigate(.instructionDetail(instructionId)) }
        ) {
            DetailIntro(text: L("instructionDetail.page.usedInIntro"))
            if let usage {
                if usage.conversations.isEmpty {
                    Text(L("instructionDetail.page.usageNever")).webText(14).foregroundStyle(AppTheme.textMuted).frame(maxWidth: .infinity).padding(.top, 40)
                } else {
                    ConversationListView(
                        items: usage.conversations.map { item in
                            ConversationItem(
                                id: item.conversationId,
                                title: item.title,
                                meta: item.firstUsedAt.map { L("instructionDetail.page.firstUsed", ["date": MemoryLabels.dateOnly($0)]) }
                            )
                        },
                        untitled: L("memoryPage.changes.untitledConversation"),
                        deleted: L("memoryPage.changes.deletedConversation"),
                        onOpen: { id in
                            router.navigate(.chat)
                            Task { await conversation.loadConversation(id) }
                        }
                    )
                }
                if omitted > 0 { DetailIntro(text: L("instructionDetail.page.showingNewest", ["count": usage.conversations.count])) }
                if deleted > 0 { DetailIntro(text: L("instructionDetail.page.deletedMore", ["count": deleted])) }
            } else {
                Text(L(failed ? "instructionDetail.page.usageFailed" : "instructionDetail.page.loading"))
                    .webText(14).foregroundStyle(AppTheme.textMuted).frame(maxWidth: .infinity).padding(.top, 40)
            }
        }
        .task(id: instructionId) {
            guard let token = try? await auth.getAccessTokenSilently() else { return }
            do {
                usage = try await InstructionService.usage(token: token, instructionId: instructionId)
            } catch {
                failed = true
            }
        }
    }
}
