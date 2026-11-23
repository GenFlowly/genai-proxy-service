import SwiftUI

// MARK: - How a memory was inferred (MemoryInference.tsx, MemoryInferencePage.tsx)

/// The extraction run that learned or changed a memory, told as a story (what triggered
/// it, what the agent read, what it decided and why, what was saved) beside the run's facts.
struct MemoryInferenceView: View {
    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var router: AppRouter
    @EnvironmentObject var conversation: ConversationStore
    let memoryId: String
    let runId: String

    @State private var inference: MemoryInference?
    @State private var failed: Bool = false
    @State private var dialog: MemoryDialog?

    var body: some View {
        DetailScaffold(
            title: L("memoryInference.title"),
            subtitle: inference?.memory.text,
            backLabel: L("memoryInference.backToMemory"),
            onLeading: { router.navigate(.memoryDetail(memoryId)) }
        ) {
            if let inference {
                MemoryInferenceContent(
                    inference: inference,
                    onOpenConversation: { id in
                        router.navigate(.chat)
                        Task { await conversation.loadConversation(id) }
                    },
                    onOpenMemory: { id in router.navigate(.memoryDetail(id)) },
                    onDelete: {
                        if let placement = inference.memory.placements.first {
                            dialog = .delete(inference.memory, placement)
                        }
                    }
                )
            } else if failed {
                Text(L("memoryInference.notFound"))
                    .webText(14.5, lineHeight: 21)
                    .foregroundStyle(AppTheme.textMuted)
                    .frame(maxWidth: .infinity)
                    .padding(.top, 48)
                    .accessibilityIdentifier("memory-inference-failed")
            } else {
                ProgressView().frame(maxWidth: .infinity).padding(.top, 64)
            }
        }
        .memoryDialogs($dialog) { _ in router.navigate(.memory) }
        .task(id: "\(memoryId)#\(runId)") { await load() }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("memory-inference-page")
    }

    private func load() async {
        do {
            let token = try await auth.getAccessTokenSilently()
            inference = try await MemoriesService.inference(token: token, memoryId: memoryId, runId: runId)
            failed = false
        } catch {
            failed = true
        }
    }
}

/// The page's content, separate from loading so previews and tests can hand it a fixture.
struct MemoryInferenceContent: View {
    let inference: MemoryInference
    var onOpenConversation: ((String) -> Void)?
    var onOpenMemory: ((String) -> Void)?
    var onDelete: (() -> Void)?

    private var run: MemoryRun { inference.run }
    private var isNote: Bool { run.source == "note" }
    private var vendors: [String] { run.responsesRead.map { AIVendor(rawValue: $0.vendor).displayName } }
    private var taken: MemoryInferenceExcerpt? { inference.excerpts.first(where: \.taken) }
    private var turnResponses: [MemoryInferenceExcerpt] {
        let ids = Set(run.responsesRead.map(\.messageId))
        return inference.excerpts.filter { ids.contains($0.messageId) }
    }
    private var userLines: Int { inference.excerpts.filter { $0.role == "user" }.count }
    private var kind: String { inference.memory.kind.label }
    private var whereLabel: String {
        inference.memory.placements.first?.projectId == nil ? L("memoryPage.scopes.profile") : L("memoryPage.scopes.unknownProject")
    }
    private var title: String {
        if inference.conversationDeleted { return L("memoryPage.changes.deletedConversation") }
        return inference.conversationTitle?.isEmpty == false ? inference.conversationTitle! : L("memoryPage.changes.untitledConversation")
    }
    private var version: Int { inference.change?.version ?? inference.memory.version }
    private var seconds: String { String(format: "%.1f", Double(run.durationMs) / 1000) }

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            DetailCard {
                HStack(spacing: 6) {
                    MemoryTag(text: kind, selected: true)
                    if let category = inference.memory.category { MemoryTag(text: category) }
                }
                Text(inference.memory.text)
                    .webText(20, lineHeight: 28)
                    .foregroundStyle(AppTheme.textPrimary)
                    .accessibilityIdentifier("memory-inference-text")
                HStack(spacing: 6) {
                    Text(L("memoryInference.version", ["version": version])).webText(13, 600).foregroundStyle(AppTheme.textSecondary)
                    Text("· " + MemoryLabels.dateOnly(inference.change?.createdAt ?? inference.memory.createdAt))
                        .webText(13)
                        .foregroundStyle(AppTheme.textMuted)
                }
            }

            VStack(alignment: .leading, spacing: 14) {
                Text(L("memoryInference.title"))
                    .webText(17, 600)
                    .foregroundStyle(AppTheme.textPrimary)
                    .accessibilityAddTraits(.isHeader)
                story
            }

            if !isNote { sourceCard }
            runCard
            sideCard(icon: "info", title: L("memoryInference.privacyTitle")) {
                Text(L("memoryInference.privacyText"))
                    .webText(12.5, lineHeight: 18.75)
                    .foregroundStyle(AppTheme.textSecondary)
            }
            if let onDelete {
                PillButton(label: L("memoryInference.deleteMemory"), icon: "trash", style: .secondary, minWidth: nil, action: onDelete)
                    .accessibilityIdentifier("memory-inference-delete")
            }
        }
    }

    // MARK: Story

    private var story: some View {
        VStack(alignment: .leading, spacing: 0) {
            beat(.plan, title: isNote ? L("memoryInference.triggeredByNote") : L("memoryInference.triggeredTitle"),
                 meta: MemoryLabels.date(run.startedAt)) {
                beatText(isNote
                         ? L("memoryInference.triggeredNoteText")
                         : vendors.isEmpty
                            ? L("memoryInference.triggeredTextSingle", ["title": title])
                            : L("memoryInference.triggeredText", ["count": vendors.count, "title": title, "vendors": vendors.joined(separator: ", ")]))
            }
            beat(.search, title: L("memoryInference.readTitle"),
                 meta: L("memoryInference.readMeta", ["lines": run.messageIds.count, "memories": run.existingShown])) {
                beatText(isNote ? L("memoryInference.readNoteText") : L("memoryInference.readText", ["userLines": userLines]))
                if inference.conversationDeleted {
                    Text(L("memoryInference.conversationGone")).webText(12).foregroundStyle(AppTheme.textMuted)
                }
                if let taken {
                    quote(taken.text, meta: L("memoryInference.takenFrom", ["index": taken.index]), highlighted: true)
                        .accessibilityIdentifier("memory-inference-taken")
                }
                ForEach(turnResponses) { excerpt in
                    quote(excerpt.text, meta: L("memoryInference.responseLine", [
                        "vendor": excerpt.vendor.map { AIVendor(rawValue: $0).displayName } ?? L("memoryInference.assistant"),
                        "index": excerpt.index,
                    ]), highlighted: false)
                }
            }
            beat(.reason, title: L("memoryInference.decidedTitle"), meta: L("memoryInference.seconds", ["value": seconds])) {
                beatText(run.operations.isEmpty
                         ? L("memoryInference.decidedNone")
                         : L("memoryInference.decidedText", ["count": run.operations.count]))
                ForEach(Array(run.operations.enumerated()), id: \.offset) { _, op in
                    operation(op)
                }
                if run.truncated == true {
                    Text(L("memoryInference.truncated")).webText(12).foregroundStyle(AppTheme.textMuted)
                }
            }
            beat(.memory, title: L("memoryInference.savedTitle"), meta: L("memoryPage.list.version", ["version": version]), last: true) {
                beatText(L("memoryInference.savedText", ["where": whereLabel, "kind": kind]))
            }
        }
    }

    private func beat<Content: View>(_ phase: ActivityPhaseID, title: String, meta: String, last: Bool = false, @ViewBuilder content: () -> Content) -> some View {
        HStack(alignment: .top, spacing: 10) {
            VStack(spacing: 3) {
                Circle()
                    .fill(AppTheme.backgroundSelected)
                    .frame(width: 18, height: 18)
                    .overlay(Circle().fill(AppTheme.activityPhase(phase)).frame(width: 8, height: 8))
                if !last {
                    Rectangle().fill(AppTheme.border).frame(width: 2).frame(maxHeight: .infinity)
                }
            }
            .frame(width: 20)
            VStack(alignment: .leading, spacing: 6) {
                ViewThatFits(in: .horizontal) {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(title).webText(15, 600).foregroundStyle(AppTheme.textPrimary)
                        Spacer(minLength: 0)
                        Text(meta).webText(11).foregroundStyle(AppTheme.textMuted).monospacedDigit()
                    }
                    VStack(alignment: .leading, spacing: 2) {
                        Text(title).webText(15, 600).foregroundStyle(AppTheme.textPrimary)
                        Text(meta).webText(11).foregroundStyle(AppTheme.textMuted).monospacedDigit()
                    }
                }
                content()
            }
            .padding(.bottom, 14)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .fixedSize(horizontal: false, vertical: true)
    }

    private func beatText(_ text: String) -> some View {
        Text(text).webText(14, lineHeight: 21).foregroundStyle(AppTheme.textSecondary)
    }

    private func quote(_ text: String, meta: String, highlighted: Bool) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("“\(text)”").webText(14, lineHeight: 21).foregroundStyle(AppTheme.textSecondary)
            Text(meta).webText(11).foregroundStyle(AppTheme.textMuted)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(highlighted ? AppTheme.backgroundSelected : AppTheme.backgroundSecondary)
        .overlay(alignment: .leading) {
            Rectangle().fill(highlighted ? AppTheme.primary : AppTheme.border).frame(width: 3)
        }
        .clipShape(UnevenRoundedRectangle(bottomTrailingRadius: 6, topTrailingRadius: 6))
    }

    private func operation(_ op: MemoryRunOperation) -> some View {
        let isThis = op.memoryId == inference.memory.memoryId
        let color: Color = op.op == "ADD" ? AppTheme.activityPhase(.reason) : op.op == "UPDATE" ? AppTheme.activityPhase(.plan) : op.op == "DELETE" ? AppTheme.error : AppTheme.textMuted
        let label = op.op == "ADD" ? L("memoryInference.opAdd") : op.op == "UPDATE" ? L("memoryInference.opUpdate") : op.op == "DELETE" ? L("memoryInference.opDelete") : op.op
        let deleted = op.memoryDeleted == true
        let canOpen = !isThis && !deleted && op.outcome == "applied" && op.op != "DELETE" && op.memoryId != nil && onOpenMemory != nil
        return HStack(alignment: .top, spacing: 10) {
            Text(label)
                .webText(11, 600, lineHeight: 11)
                .foregroundStyle(color)
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .overlay(Capsule().strokeBorder(color, lineWidth: 1))
            VStack(alignment: .leading, spacing: 3) {
                if let text = op.text { Text(text).webText(14, lineHeight: 20).foregroundStyle(AppTheme.textPrimary) }
                if let reason = op.reason {
                    Text(L("memoryInference.why", ["reason": reason])).webText(12.5, lineHeight: 18).foregroundStyle(AppTheme.textMuted)
                }
                HStack(spacing: 10) {
                    if isThis { Text(L("memoryInference.thisMemory")).webText(12, 600).foregroundStyle(AppTheme.primary) }
                    if op.outcome == "noop" { Text(L("memoryInference.notApplied")).webText(12).foregroundStyle(AppTheme.textMuted) }
                    if op.outcome == "error" { Text(L("memoryInference.failed")).webText(12).foregroundStyle(AppTheme.error) }
                    if deleted { Text(L("memoryInference.memoryDeleted")).webText(12).foregroundStyle(AppTheme.textMuted) }
                    if canOpen, let id = op.memoryId {
                        Button(L("memoryInference.openMemory")) { onOpenMemory?(id) }
                            .webText(12.5)
                            .foregroundStyle(AppTheme.primary)
                            .frame(minHeight: 32)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(isThis ? AppTheme.backgroundSelected : AppTheme.backgroundSecondary)
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(isThis ? AppTheme.primary : AppTheme.border, lineWidth: 1))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("memory-inference-op")
    }

    // MARK: Side cards

    private var sourceCard: some View {
        sideCard(icon: "info", title: L("memoryInference.sourceTitle")) {
            facts([
                (L("memoryInference.conversation"), title),
            ] + (taken.map { [(L("memoryInference.line"), L("memoryInference.youLine", ["index": $0.index]))] } ?? []))
            if !inference.conversationDeleted, let id = run.conversationId, let onOpenConversation {
                link(L("memoryInference.openConversation"), identifier: "memory-inference-open-conversation") { onOpenConversation(id) }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("memory-inference-source")
    }

    private var runCard: some View {
        var rows: [(String, String)] = [(L("memoryInference.agent"), L("memoryInference.agentName"))]
        if let model = run.model {
            rows.append((L("memoryInference.model"), run.vendor.map { L("memoryInference.modelOn", ["model": model, "vendor": AIVendor(rawValue: $0).displayName]) } ?? model))
        }
        if !vendors.isEmpty { rows.append((L("memoryInference.responsesRead"), vendors.joined(separator: " · "))) }
        rows.append((L("memoryInference.took"), L("memoryInference.seconds", ["value": seconds])))
        if let input = run.inputTokens {
            rows.append((L("memoryInference.tokens"), L("memoryInference.tokensValue", [
                "input": input.formatted(), "output": (run.outputTokens ?? 0).formatted(),
            ])))
        }
        if let cost = run.costUsd { rows.append((L("memoryInference.cost"), String(format: "$%.4f", cost))) }
        rows.append((L("memoryInference.run"), String(run.runId.prefix(8))))
        return sideCard(icon: "brain", title: L("memoryInference.runTitle")) { facts(rows) }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("memory-inference-run")
    }

    private func sideCard<Content: View>(icon: String, title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 6) {
                WebIcon(name: icon, size: 13, color: AppTheme.textMuted)
                Text(title).webText(13, 600).foregroundStyle(AppTheme.textMuted)
            }
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isHeader)
            content()
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(AppTheme.backgroundSecondary)
        .clipShape(RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(AppTheme.borderLight, lineWidth: 1))
    }

    private func facts(_ rows: [(String, String)]) -> some View {
        Grid(alignment: .leading, horizontalSpacing: 14, verticalSpacing: 6) {
            ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                GridRow {
                    Text(row.0).webText(12.5).foregroundStyle(AppTheme.textMuted)
                    Text(row.1).webText(12.5).foregroundStyle(AppTheme.textSecondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .accessibilityElement(children: .combine)
            }
        }
    }

    private func link(_ label: String, identifier: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 2) {
                Text(label).webText(12.5)
                WebIcon(name: "alt-arrow-right", size: 12, color: AppTheme.primary)
            }
            .foregroundStyle(AppTheme.primary)
            .frame(minHeight: 32)
        }
        .buttonStyle(WebPressStyle())
        .accessibilityIdentifier(identifier)
    }
}
