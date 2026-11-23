import SwiftUI

// MARK: - Turn-level state (Response.tsx useLearnedFacts + LearnedMemorySection)

/// What one turn added to memory. Memory learns once per turn from every vendor's
/// response and writes the same list onto each, so the turn polls through one response.
@Observable
@MainActor
final class TurnLearnedMemory {
    enum Status: Equatable { case hidden, pending, done }

    var status: Status = .hidden
    var facts: [LearnedFact] = []
    var deleting: Set<String> = []

    static let pollInterval: Duration = .seconds(4)
    /// Extraction that slow counts as "no new facts" (useLearnedFacts.ts).
    static let pollTimeout: TimeInterval = 60

    /// A string that changes whenever the turn's memory outcome could: `.task(id:)` key.
    static func key(for messages: [Message]) -> String {
        messages.map { message in
            let facts: String
            switch message.learnedFacts {
            case .fresh: facts = "fresh"
            case .unknown: facts = "unknown"
            case .known(let list): facts = list.map(\.memoryId).joined(separator: ",")
            }
            return "\(message.messageId)|\(message.isLoading)|\(message.error != nil)|\(facts)"
        }.joined(separator: ";")
    }

    func update(conversationId: String, messages: [Message], auth: AuthStore) async {
        guard !messages.contains(where: \.isLoading),
              let primary = messages.first(where: { $0.error == nil && $0.hasRealId }),
              messages.contains(where: { $0.hasOwnUsage || $0.learnedFacts != .fresh }) else {
            status = .hidden
            return
        }
        let known = messages.compactMap { message -> [LearnedFact]? in
            if case .known(let list) = message.learnedFacts { return list }
            return nil
        }
        if !known.isEmpty {
            facts = known.first(where: { !$0.isEmpty }) ?? []
            status = .done
            return
        }
        if messages.contains(where: { $0.learnedFacts == .unknown }) {
            facts = []
            status = .done
            return
        }
        guard !conversationId.isEmpty else {
            status = .hidden
            return
        }
        status = .pending
        let started = Date()
        while !Task.isCancelled {
            if let token = try? await auth.getAccessTokenSilently(),
               let result = try? await LearnedFactsService.get(token: token, conversationId: conversationId, messageId: primary.messageId),
               !result.isPending {
                facts = result.facts ?? []
                status = .done
                return
            }
            if Date().timeIntervalSince(started) >= Self.pollTimeout {
                facts = []
                status = .done
                return
            }
            try? await Task.sleep(for: Self.pollInterval)
        }
    }
}

// MARK: - The line under the response (LearnedMemorySection, compact)

/// Learning → one muted line; nothing learned → one muted line; facts → a chip that opens
/// the sheet. It sits where the old brain count did, above the response's actions.
struct LearnedMemoryLine: View {
    @EnvironmentObject var router: AppRouter
    @EnvironmentObject var memories: MemoriesStore
    @EnvironmentObject var toasts: ToastCenter
    let memory: TurnLearnedMemory
    @State private var showSheet = false

    var body: some View {
        Group {
            switch memory.status {
            case .hidden:
                EmptyView()
            case .pending:
                HStack(spacing: 6) {
                    WebIcon(name: "brain", size: 12, color: AppTheme.textMuted)
                    PulseDot(size: 6, color: AppTheme.textMuted)
                    Text(L("conversation.learnedMemory.learning"))
                }
                .lineStyle()
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("learned-memory-pending")
            case .done:
                if memory.facts.isEmpty {
                    HStack(spacing: 6) {
                        WebIcon(name: "brain", size: 12, color: AppTheme.textMuted)
                        Text(L("conversation.learnedMemory.none"))
                    }
                    .lineStyle()
                    .accessibilityElement(children: .combine)
                    .accessibilityIdentifier("learned-memory-none")
                } else {
                    Button { showSheet = true } label: {
                        HStack(spacing: 8) {
                            HStack(spacing: 4) {
                                WebIcon(name: "brain", size: 12, color: AppTheme.primary)
                                Text("\(memory.facts.count)")
                                    .webText(12, 600, lineHeight: 16.8)
                                    .monospacedDigit()
                            }
                            .foregroundStyle(AppTheme.primary)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 2)
                            .background(AppTheme.backgroundSelected)
                            .clipShape(Capsule())
                            Text(L("conversation.learnedMemory.chipText", ["count": memory.facts.count]))
                                .webText(12, lineHeight: 16.8)
                                .foregroundStyle(AppTheme.textMuted)
                                .multilineTextAlignment(.leading)
                        }
                        .frame(minHeight: 44, alignment: .leading)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(WebPressStyle())
                    .accessibilityIdentifier("learned-memory-chip")
                    .sheet(isPresented: $showSheet) {
                        LearnedMemorySheet(memory: memory) { showSheet = false }
                            .environmentObject(router)
                            .environmentObject(memories)
                            .environmentObject(toasts)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, 14)
    }
}

private extension View {
    func lineStyle() -> some View {
        self
            .webText(12, lineHeight: 16.8)
            .foregroundStyle(AppTheme.textMuted)
    }
}

// MARK: - Sheet (LearnedMemorySheet.tsx)

/// The facts a turn added to memory, as the sidebar's swipe rows: tap to see how a fact
/// was inferred, swipe left to delete it (after the Memory page's confirmation).
struct LearnedMemorySheet: View {
    @EnvironmentObject var router: AppRouter
    @EnvironmentObject var memories: MemoriesStore
    @EnvironmentObject var toasts: ToastCenter
    @Environment(\.windowHeight) private var windowHeight
    let memory: TurnLearnedMemory
    let onClose: () -> Void

    @State private var openRow: SwipeOpenRow?
    @State private var confirming: LearnedFact?
    @State private var headerHeight: CGFloat = 0
    @State private var rowsHeight: CGFloat = 0
    @State private var footerHeight: CGFloat = 0
    @State private var confirmHeight: CGFloat = 0

    private static let topPadding: CGFloat = 20

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let fact = confirming {
                confirm(fact)
                    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { confirmHeight = $0 }
            } else {
                list
            }
        }
        .padding(.top, Self.topPadding)
        .frame(maxHeight: .infinity, alignment: .top)
        .background(AppTheme.backgroundSecondary)
        .presentationDetents([detent])
        .presentationDragIndicator(.visible)
        .presentationBackground(AppTheme.backgroundSecondary)
        .presentationCornerRadius(16)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("learned-memory-sheet")
    }

    /// Hugs the content like the web sheet; past 85% of the window (its `max-height: 85vh`) the rows scroll.
    private var detent: PresentationDetent {
        let content = confirming == nil ? headerHeight + rowsHeight + footerHeight : confirmHeight
        guard content > 0 else { return .medium }
        let wanted = Self.topPadding + content
        return .height(windowHeight > 0 ? min(wanted, windowHeight * 0.85) : wanted)
    }

    private var list: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { headerHeight = $0 }
            ScrollView {
                VStack(spacing: 0) {
                    ForEach(Array(memory.facts.enumerated()), id: \.element.memoryId) { index, fact in
                        row(fact, index: index)
                        Rectangle().fill(AppTheme.borderLight).frame(height: 1)
                    }
                }
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { rowsHeight = $0 }
            }
            .scrollBounceBehavior(.basedOnSize)
            .frame(maxHeight: rowsHeight)
            footer
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { footerHeight = $0 }
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                WebIcon(name: "brain", size: 16, color: AppTheme.primary)
                Text(L("conversation.learnedMemory.sheetTitle", ["count": memory.facts.count]))
                    .webText(16, 600)
                    .foregroundStyle(AppTheme.textPrimary)
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 4)
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isHeader)
            Text(L("conversation.learnedMemory.sheetHint"))
                .webText(12)
                .foregroundStyle(AppTheme.textMuted)
                .padding(.horizontal, 16)
                .padding(.bottom, 8)
            Rectangle().fill(AppTheme.borderLight).frame(height: 1)
        }
    }

    private var footer: some View {
        VStack(spacing: 4) {
            Button {
                onClose()
                router.navigate(.memory)
            } label: {
                HStack(spacing: 14) {
                    WebIcon(name: "alt-arrow-right", size: 18, color: AppTheme.textMuted)
                    Text(L("conversation.learnedMemory.manage")).webText(16).foregroundStyle(AppTheme.textSecondary)
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 8)
                .frame(minHeight: 52)
                .contentShape(Rectangle())
            }
            .buttonStyle(RowPressStyle())
            .accessibilityIdentifier("learned-memory-sheet-manage")
            Button(action: onClose) {
                Text(L("conversation.learnedMemory.done"))
                    .webText(16, 500)
                    .foregroundStyle(AppTheme.textSecondary)
                    .frame(maxWidth: .infinity, minHeight: 52)
                    .background(AppTheme.backgroundTertiary)
                    .clipShape(RoundedRectangle(cornerRadius: 10))
            }
            .buttonStyle(WebPressStyle())
            .accessibilityIdentifier("learned-memory-sheet-done")
        }
        .padding(.horizontal, 12)
        .padding(.top, 8)
        .padding(.bottom, 12)
    }

    private func row(_ fact: LearnedFact, index: Int) -> some View {
        SwipeableRow(
            id: fact.memoryId,
            openRow: $openRow,
            trailing: [
                SwipeAction(icon: "trash", label: L("conversation.learnedMemory.delete"), tone: .muted, identifier: "learned-memory-sheet-delete-\(index)") {
                    confirming = fact
                }
            ]
        ) {
            Button { open(fact) } label: {
                HStack(spacing: 10) {
                    Text(fact.text)
                        .webText(15, lineHeight: 21)
                        .foregroundStyle(AppTheme.textSecondary)
                        .multilineTextAlignment(.leading)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    WebIcon(name: "alt-arrow-right", size: 16, color: AppTheme.textMuted)
                }
                .padding(.leading, 16)
                .padding(.trailing, 8)
                .padding(.vertical, 10)
                .frame(minHeight: 56)
                .contentShape(Rectangle())
            }
            .buttonStyle(RowPressStyle())
            .accessibilityIdentifier("learned-memory-sheet-row-\(index)")
        }
        .opacity(memory.deleting.contains(fact.memoryId) ? 0.5 : 1)
        .allowsHitTesting(!memory.deleting.contains(fact.memoryId))
        .background(AppTheme.backgroundSecondary)
    }

    /// DeleteMemoryForm's look and words, for a fact listed in the sheet.
    private func confirm(_ fact: LearnedFact) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(L("memoryPage.delete.title"))
                .webText(16, 600)
                .foregroundStyle(AppTheme.textPrimary)
                .accessibilityAddTraits(.isHeader)
            Text(fact.text)
                .webText(14.5, lineHeight: 21)
                .foregroundStyle(AppTheme.textSecondary)
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(AppTheme.backgroundTertiary)
                .clipShape(RoundedRectangle(cornerRadius: 6))
            Text(L("memoryPage.delete.confirm"))
                .webText(14.5, lineHeight: 21)
                .foregroundStyle(AppTheme.textPrimary)
            VStack(spacing: 10) {
                PillButton(label: L("memoryPage.delete.delete"), style: .danger, fullWidth: true) {
                    confirming = nil
                    Task { await delete(fact) }
                }
                .accessibilityIdentifier("learned-memory-confirm-delete")
                PillButton(label: L("memoryPage.move.cancel"), style: .secondary, fullWidth: true) {
                    confirming = nil
                }
                .accessibilityIdentifier("learned-memory-confirm-cancel")
            }
        }
        .padding(.horizontal, 20)
        .padding(.bottom, 12)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("learned-memory-confirm")
    }

    private func open(_ fact: LearnedFact) {
        onClose()
        if let runId = fact.runId {
            router.navigate(.memoryInference(fact.memoryId, runId: runId))
        } else {
            router.navigate(.memoryDetail(fact.memoryId))
        }
    }

    private func delete(_ fact: LearnedFact) async {
        memory.deleting.insert(fact.memoryId)
        defer { memory.deleting.remove(fact.memoryId) }
        do {
            _ = try await memories.delete(fact.memoryId)
            memory.facts.removeAll { $0.memoryId == fact.memoryId }
            toasts.showToast(L("memoryPage.delete.deleted"))
            if memory.facts.isEmpty { onClose() }
        } catch {
            AppObservability.capture(error, context: ["where": "deleteLearnedMemory"])
            toasts.showToast(L("memoryPage.delete.failed"))
        }
    }
}

