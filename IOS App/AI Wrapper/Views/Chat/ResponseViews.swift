import SwiftUI

/// Response.tsx: the vendor toggle plus one card per selected vendor (two side by side
/// when the conversation is ≥900pt wide, one on phones).
struct ResponseGroupView: View {
    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var conversation: ConversationStore
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.conversationScroll) private var conversationScroll
    @Environment(\.trailingEditorHeight) private var trailingEditorHeight
    let block: ConversationBlock
    let onSelectionChange: (AskSelection?) -> Void

    @State private var swipe = ResponseSwipeModel()
    /// In the middle half of the screen: a tall response still counts, and a block at the
    /// far edge doesn't use up the one hint.
    @State private var isInReadingZone = false
    /// The responses' top is above the overlay header's bottom edge.
    @State private var startsAboveView = false
    /// The responses end in the top quarter of the page's visible part, or above it.
    @State private var endsHigh = false
    /// The responses fit in the page between the overlay header and the trailing editor.
    @State private var fitsInView = false
    /// The messages whose agent is thinking.
    @State private var thinkingMessages: Set<String> = []
    @State private var width: CGFloat = 0
    /// Each vendor is auto-selected at most once, or toggles would be undone mid-stream.
    @State private var autoSelected: Set<String> = []
    /// What this turn added to memory: one state for every vendor's card.
    @State private var learnedMemory = TurnLearnedMemory()

    private var maxVendors: Int { width >= 900 ? 2 : 1 }

    /// A refusal has no text and no error but must still render: its stop reason is the
    /// only thing explaining the empty answer.
    private var visibleMessages: [Message] {
        block.responseMessages.filter { !$0.text.isEmpty || $0.isLoading || $0.error != nil || $0.stopReason != nil }
    }

    /// Failover priority (1 = primary) orders responses; unprioritized vendors keep
    /// arrival order after them.
    private func priority(_ vendor: String) -> Int {
        auth.aiVendorAPIKeyStatusList.first { $0.aiVendor == vendor }?.priority ?? Int.max
    }

    private var availableVendors: [String] {
        var seen = Set<String>()
        let vendors = visibleMessages.compactMap { message -> String? in
            seen.insert(message.aiVendor.rawValue).inserted ? message.aiVendor.rawValue : nil
        }
        return vendors.enumerated().sorted { a, b in
            let pa = priority(a.element), pb = priority(b.element)
            return pa == pb ? a.offset < b.offset : pa < pb
        }.map(\.element)
    }

    private var effectiveSelected: [String] {
        let raw = conversation.getVendorSelection(for: block.conversationBlockId)
        let selection = raw.isEmpty ? availableVendors : raw
        let sorted = selection.enumerated().sorted { a, b in
            let pa = priority(a.element), pb = priority(b.element)
            return pa == pb ? a.offset < b.offset : pa < pb
        }.map(\.element)
        return Array(sorted.prefix(maxVendors))
    }

    /// Latest visible message per selected vendor.
    private var filteredMessages: [Message] {
        let selected = effectiveSelected
        var byVendor: [String: Message] = [:]
        for message in visibleMessages where selected.contains(message.aiVendor.rawValue) {
            byVendor[message.aiVendor.rawValue] = message
        }
        return byVendor.values.sorted { priority($0.aiVendor.rawValue) < priority($1.aiVendor.rawValue) }
    }

    private var isLastResponseBlock: Bool {
        conversation.lastResponseBlockId == block.conversationBlockId
    }

    var body: some View {
        VStack(spacing: 0) {
            if visibleMessages.isEmpty {
                Text(L("conversation.response.noResponsesGenerated"))
                    .webText(16)
                    .italic()
                    .foregroundStyle(AppTheme.textSecondary)
                    .padding(16)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                if availableVendors.count > 1 { vendorToggle }
                let layout = isPaged ? AnyLayout(ResponsePagerLayout()) : AnyLayout(HStackLayout(alignment: .top, spacing: 12))
                layout {
                    let vendors = availableVendors
                    ForEach(pagerMessages) { message in
                        let isNeighbor = message.aiVendor.rawValue == swipe.neighbor?.vendor
                        ResponseCardView(
                            block: block,
                            message: message,
                            isLastResponseBlock: isLastResponseBlock,
                            learnedMemory: showsMemory(for: message) ? learnedMemory : nil,
                            onSelectionChange: onSelectionChange,
                            swipe: swipe,
                            isSwipeNeighbor: isNeighbor,
                            onThinkingChange: { thinkingChanged(message.messageId, $0) }
                        )
                        .overlay(alignment: .top) {
                            ResponseSwipeLabel(
                                model: swipe,
                                isNeighbor: isNeighbor,
                                vendor: message.aiVendor,
                                modelName: message.model,
                                position: vendors.firstIndex(of: message.aiVendor.rawValue) ?? 0,
                                total: vendors.count
                            )
                        }
                        .modifier(ResponseSwipeOffset(model: swipe, isNeighbor: isNeighbor))
                        .allowsHitTesting(!isNeighbor)
                        .id(message.messageId)
                    }
                }
                .padding(.top, 18)
                .padding(.horizontal, ReaderFriendlyMarkdownView.readingInset)
                .padding(.bottom, 8)
                // Scrolling to an id stops at the content margin, so this lands the responses
                // just below the overlay header, like the web row's scroll margin.
                .overlay(alignment: .top) {
                    Color.clear.frame(height: 1).id(Self.topAnchor(block.conversationBlockId)).allowsHitTesting(false)
                }
                .overlay(alignment: .bottom) {
                    LiftedBottomAnchor(id: Self.endAnchor(block.conversationBlockId), lift: trailingEditorHeight)
                }
                .background(swipe.isDragging ? Self.dragTint : .clear)
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { swipe.pageHeight = $0 }
                .onGeometryChange(for: Bool.self) { proxy in
                    proxy.frame(in: .scrollView(axis: .vertical)).minY < mobileHeaderHeight - 0.5
                } action: { startsAboveView = $0 }
                .onGeometryChange(for: Bool.self) { proxy in
                    guard let viewport = proxy.bounds(of: .scrollView(axis: .vertical))?.height else { return false }
                    let visible = viewport - mobileHeaderHeight - trailingEditorHeight
                    return proxy.frame(in: .scrollView(axis: .vertical)).maxY < mobileHeaderHeight + visible / 4
                } action: { endsHigh = $0 }
                .onGeometryChange(for: Bool.self) { proxy in
                    guard let viewport = proxy.bounds(of: .scrollView(axis: .vertical))?.height else { return false }
                    return proxy.size.height <= viewport - mobileHeaderHeight - trailingEditorHeight
                } action: { fitsInView = $0 }
                .onGeometryChange(for: Bool.self) { proxy in
                    guard let viewport = proxy.bounds(of: .scrollView(axis: .vertical))?.height else { return false }
                    let frame = proxy.frame(in: .scrollView(axis: .vertical))
                    return frame.maxY > viewport * 0.25 && frame.minY < viewport * 0.75
                } action: { isInReadingZone = $0 }
                .task(id: hintIsDue) {
                    guard hintIsDue else { return }
                    try? await Task.sleep(for: ResponseSwipeRules.hintDelay)
                    guard !Task.isCancelled else { return }
                    startSwipeHint()
                }
                // The blank space beside short lines and narrow tables has to count too.
                .contentShape(.rect)
                .gesture(ResponseSwipeGesture(
                    isEnabled: isPaged,
                    onBegan: beginSwipe,
                    onChanged: moveSwipe,
                    onEnded: endSwipe
                ))
            }
        }
        .frame(maxWidth: .infinity)
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
        .task(id: TurnLearnedMemory.key(for: block.responseMessages)) {
            await learnedMemory.update(conversationId: conversation.conversationId, messages: block.responseMessages, auth: auth)
        }
        .onAppear(perform: autoSelectNewVendors)
        .onChange(of: availableVendors) { _, _ in autoSelectNewVendors() }
    }

    private static let dragTint = Color(uiColor: UIColor {
        UIColor.black.withAlphaComponent($0.userInterfaceStyle == .dark ? 0.16 : 0.06)
    })

    private var isPaged: Bool { maxVendors == 1 }

    /// Paged (phones), every card carries the turn's memory line, so it stays while swiping;
    /// side by side, only the first does.
    private func showsMemory(for message: Message) -> Bool {
        isPaged || message.messageId == filteredMessages.first?.messageId
    }

    /// The current response, then the one a swipe is bringing in.
    private var pagerMessages: [Message] {
        guard let vendor = swipe.neighbor?.vendor,
              let incoming = visibleMessages.last(where: { $0.aiVendor.rawValue == vendor }) else {
            return filteredMessages
        }
        return filteredMessages + [incoming]
    }

    private var hintIsDue: Bool {
        isPaged && isInReadingZone && availableVendors.count > 1
            && !visibleMessages.contains(where: \.isLoading) && !ResponseSwipeHint.wasSeen()
    }

    private func startSwipeHint() {
        guard !swipe.isDragging, !ResponseSwipeHint.wasSeen(),
              let current = effectiveSelected.first,
              let side = ResponseSwipeRules.hintSide(of: current, in: availableVendors),
              let vendor = ResponseSwipeRules.neighbor(of: current, in: availableVendors, side: side) else { return }
        ResponseSwipeHint.markSeen()
        swipe.page = width
        swipe.neighbor = .init(vendor: vendor, side: side)
        swipe.isShowingHint = true
        swipe.showLabel()
        let distance = reduceMotion ? 0 : ResponseSwipeRules.hintDistance
        swipe.runHint(distance: side == .next ? -distance : distance)
    }

    private func beginSwipe() {
        swipe.cancelHint()
        ResponseSwipeHint.markSeen()
        swipe.page = width
        swipe.isDragging = true
        swipe.showLabel()
    }

    private func moveSwipe(_ translation: CGFloat) {
        let side: ResponseSwipeRules.Side = translation < 0 ? .next : .previous
        let vendor = ResponseSwipeRules.neighbor(of: effectiveSelected.first, in: availableVendors, side: side)
        let neighbor = vendor.map { ResponseSwipeModel.Neighbor(vendor: $0, side: side) }
        if swipe.neighbor != neighbor { swipe.neighbor = neighbor }
        swipe.dx = vendor == nil ? ResponseSwipeRules.rubberBand(translation) : max(-width, min(width, translation))
    }

    private func endSwipe(translation: CGFloat, velocity: CGFloat, wasCancelled: Bool) {
        swipe.isDragging = false
        let target = !wasCancelled && ResponseSwipeRules.commits(dx: swipe.dx, velocity: velocity, page: width) ? swipe.neighbor : nil
        let landing = target.map { $0.side == .next ? -width : width } ?? 0
        let finish = {
            var transaction = Transaction()
            transaction.disablesAnimations = true
            withTransaction(transaction) {
                if let target { selectVendors([target.vendor]) }
                swipe.neighbor = nil
                swipe.dx = 0
            }
            swipe.hideLabelAfterLinger()
        }
        if reduceMotion {
            finish()
        } else {
            withAnimation(.spring(duration: 0.26, bounce: 0), completionCriteria: .logicallyComplete) {
                swipe.dx = landing
            } completion: {
                finish()
            }
        }
    }

    private var vendorToggle: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            CheckboxButtonGroup(
                options: availableVendors.map { .init(id: $0, label: AIVendor(rawValue: $0).displayName) },
                selected: effectiveSelected,
                maxSelection: maxVendors,
                onChange: selectVendors
            )
            .padding(.horizontal, 16)
            .frame(minWidth: width)
        }
        .scrollBounceBehavior(.basedOnSize, axes: .horizontal)
        .padding(.top, 12)
    }

    /// Response.tsx handleVendorSelectionChange: the page stays where it is, and the new
    /// response shows from the same point. Only one that would end in the top quarter of the
    /// page or above it moves the page up, as little as shows the most of it, so the page is
    /// never left near blank below its end.
    private func selectVendors(_ vendors: [String]) {
        let wasInside = startsAboveView
        conversation.setVendorSelection(for: block.conversationBlockId, vendors: vendors)
        guard wasInside, let conversationScroll else { return }
        let id = block.conversationBlockId
        // After the new response has laid out, or this reads the old one's frame
        DispatchQueue.main.async {
            guard endsHigh else { return }
            if fitsInView {
                conversationScroll.scrollTo(Self.topAnchor(id), .top, true)
            } else {
                conversationScroll.scrollTo(Self.endAnchor(id), .bottom, true)
            }
        }
    }

    /// ConversationBlock's followLiveActivity: once the agent stops thinking and its panel
    /// folds, a page that had moved past the responses' top goes back to it. A user who scrolled
    /// the panel's end out of view is left where they are, and so is one who switched vendors:
    /// a panel leaving the page is not the agent stopping.
    private func thinkingChanged(_ messageId: String, _ thinking: Bool) {
        if thinking {
            thinkingMessages.insert(messageId)
            return
        }
        guard thinkingMessages.remove(messageId) != nil,
              filteredMessages.contains(where: { $0.messageId == messageId }),
              !filteredMessages.contains(where: { thinkingMessages.contains($0.messageId) }),
              startsAboveView, let conversationScroll, !conversationScroll.isFollowPaused else { return }
        conversationScroll.scrollTo(Self.topAnchor(block.conversationBlockId), .top, true)
    }

    static func topAnchor(_ blockId: String) -> String { "responses-top-\(blockId)" }
    static func endAnchor(_ blockId: String) -> String { "responses-end-\(blockId)" }

    private func autoSelectNewVendors() {
        let current = conversation.getVendorSelection(for: block.conversationBlockId)
        let newVendors = availableVendors.filter { !autoSelected.contains($0) && !current.contains($0) }
        autoSelected.formUnion(availableVendors)
        if !newVendors.isEmpty {
            conversation.setVendorSelection(for: block.conversationBlockId, vendors: current + newVendors)
        }
    }
}

struct UsageTotals: Equatable {
    var inputTokens = 0
    var outputTokens = 0
    var totalTokens = 0
    var tokensReadFromCache = 0
    var costUsd: Double?

    init() {}

    init(_ message: Message) {
        add(message)
    }

    mutating func add(_ message: Message) {
        inputTokens += message.inputTokens ?? 0
        outputTokens += message.outputTokens ?? 0
        totalTokens += message.totalTokens ?? 0
        tokensReadFromCache += message.tokensReadFromCache ?? 0
        if let cost = message.costUsd { costUsd = (costUsd ?? 0) + cost }
    }
}

// MARK: - Response card (TextContainer + Response.tsx)

struct ResponseCardView: View {
    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var conversation: ConversationStore
    @Environment(\.conversationScroll) private var conversationScroll
    @Environment(\.trailingEditorHeight) private var trailingEditorHeight
    let block: ConversationBlock
    let message: Message
    let isLastResponseBlock: Bool
    /// The turn's "added to memory" state, shown above the actions; nil hides it.
    let learnedMemory: TurnLearnedMemory?
    let onSelectionChange: (AskSelection?) -> Void
    let swipe: ResponseSwipeModel
    let isSwipeNeighbor: Bool
    /// Told when this response's agent starts or stops thinking, and false when it leaves the page.
    var onThinkingChange: (Bool) -> Void = { _ in }

    @State private var isThinking = false

    /// Room kept between a followed activity panel's end and the trailing editor.
    static let followGap: CGFloat = 16
    static func activityEndAnchor(_ messageId: String) -> String { "activity-end-\(messageId)" }

    /// Nothing follows, so the bar takes up the group's 8pt below it and its buttons end where
    /// the scrolled page does.
    private var endsConversation: Bool { conversation.blocks.last?.conversationBlockId == block.conversationBlockId }

    private var hasAnyValidApiKey: Bool { auth.aiVendorAPIKeyStatusList.contains { $0.isAPIKeyValid == true } }
    /// The answer area's own placeholder: loading with no text yet. The activity panel
    /// never looks at the text (see ActivityPanel).
    private var isAwaitingText: Bool { message.isLoading && message.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    private var isSelected: Bool { conversation.getSelectedResponse(for: block.conversationBlockId) == message.messageId }

    /// Fork needs a real persisted response; unlike regenerate, it shows on EVERY block.
    private var canFork: Bool {
        !conversation.conversationId.isEmpty && message.error == nil && message.hasRealId
    }

    private var canAsk: Bool {
        isLastResponseBlock && hasAnyValidApiKey && !message.isLoading && !message.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
                .padding(.bottom, 6)

            // Ruled off from the text below it like a byline (`.activityPanel`)
            let showsActivity = !(message.activity.isEmpty && !message.isLoading)
            ActivityPanel(
                events: message.activity,
                isLive: message.isLoading,
                citedSources: message.webSources,
                stopReason: message.stopReason,
                clock: message.runClock,
                onThinkingChange: { thinking in
                    isThinking = thinking
                    onThinkingChange(thinking)
                }
            )
            // While the agent thinks, the page keeps the panel's end in view, above the
            // trailing editor stuck to the bottom of the page (ConversationBlock's follow)
            .overlay(alignment: .bottom) {
                if isThinking, !isSwipeNeighbor, let conversationScroll {
                    let anchor = Self.activityEndAnchor(message.messageId)
                    LiftedBottomAnchor(id: anchor, lift: trailingEditorHeight + Self.followGap) {
                        conversationScroll.follow(anchor, overflow: $0)
                    }
                }
            }
            .onDisappear {
                if isThinking { onThinkingChange(false) }
            }
            .padding(.bottom, showsActivity ? 14 : 0)
            .overlay(alignment: .bottom) {
                if showsActivity {
                    Rectangle().fill(Color(uiColor: AppTheme.UI.textPrimary.withAlphaComponent(0.12))).frame(height: 1)
                }
            }
            .padding(.bottom, showsActivity ? 18 : 0)

            if !isAwaitingText {
                ReaderFriendlyMarkdownView(
                    text: message.text,
                    sources: message.webSources,
                    options: .init(turnTextSize: 16),
                    onSelectionChange: selectionHandler
                )
            }

            if let error = message.error, !error.isEmpty {
                errorBanner(error)
            }
            if !message.isLoading, let sources = message.webSources, !sources.isEmpty {
                SourcesSection(sources: sources)
            }
            if let attachments = message.generatedAttachments, !attachments.isEmpty {
                GeneratedAttachmentsSection(attachments: attachments)
            }
            if !message.isLoading, let stopReason = message.stopReason {
                StopReasonNote(reason: stopReason)
            }
            if let learnedMemory, !isSwipeNeighbor {
                LearnedMemoryLine(memory: learnedMemory)
            }
            if !isSwipeNeighbor, message.isLoading || isLastResponseBlock || canFork {
                actionBar
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var selectionHandler: ((String?) -> Void)? {
        guard canAsk else { return nil }
        let blockId = block.conversationBlockId
        let message = message
        return { text in
            onSelectionChange(text.map { AskSelection(text: $0, blockId: blockId, message: message) })
        }
    }

    /// The vendor with a model tag on the left; the copy icon on the right.
    private var header: some View {
        HStack(spacing: 8) {
            VendorBrandName(vendor: message.aiVendor)
                .webText(16, 500, lineHeight: 24.8)
                .foregroundStyle(AppTheme.textPrimary)
                .lineLimit(1)
                .fixedSize()
            if let model = message.model, !model.isEmpty {
                Text(model)
                    .webText(11, lineHeight: 20)
                    .foregroundStyle(AppTheme.textMuted)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .padding(.horizontal, 8)
                    .frame(height: 20)
                    .background(AppTheme.backgroundTertiary)
                    .clipShape(Capsule())
            }
            Spacer(minLength: 0)
            CopyToClipboardButton(content: message.text, accessibilityLabel: L("common.textContainer.copyResponse"), style: .turn)
        }
        .frame(height: 32)
    }

    private func errorBanner(_ error: String) -> some View {
        Text(message.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
             ? L("conversation.response.generationFailed", ["reason": error])
             : L("conversation.response.streamInterrupted", ["reason": error]))
            .webText(13.6, lineHeight: 19.04)
            .foregroundStyle(AppTheme.error)
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .overlay(RoundedRectangle(cornerRadius: DSRadius.md).strokeBorder(AppTheme.error, lineWidth: 1))
            .padding(.vertical, 8)
    }


    /// `.responseActionButtonsWrapper`: spans the screen edge to edge at the end of the response.
    private var actionBar: some View {
        HStack(spacing: 8) {
            if message.isLoading {
                ActionPill(label: L("conversation.response.stop")) {
                    conversation.stopGenerating(blockId: block.conversationBlockId, vendor: message.aiVendor)
                }
            } else {
                if isLastResponseBlock {
                    ActionPill(label: L("conversation.response.regenerate"), icon: "refresh-icon", disabled: !hasAnyValidApiKey) {
                        Task {
                            await conversation.generateResponsesStream(blockId: block.conversationBlockId, vendorToRegenerate: message.aiVendor)
                        }
                    }
                }
                if isLastResponseBlock, !message.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    ActionPill(
                        label: isSelected ? L("conversation.response.selected") : L("conversation.response.followUp"),
                        icon: isSelected ? nil : "send-icon",
                        disabled: isSelected || !hasAnyValidApiKey
                    ) {
                        conversation.followUp(fromBlock: block.conversationBlockId, messageId: message.messageId)
                    }
                }
                if canFork {
                    ActionPill(label: L("conversation.response.fork"), icon: "git-fork", iconLeads: true, style: .secondary) {
                        Task { await conversation.forkFromMessage(message.messageId) }
                    }
                    .accessibilityHint(L("conversation.response.forkHint"))
                }
            }
        }
        .padding(.top, 16)
        .padding(.bottom, 12)
        .frame(maxWidth: .infinity)
        .modifier(ResponseSwipeOffset(model: swipe, factor: -1))
        .padding(.horizontal, -ReaderFriendlyMarkdownView.readingInset)
        .padding(.bottom, endsConversation ? -8 : 0)
        .zIndex(10)
    }

    /// "$1.23" / "$0.0421" — sub-dollar amounts keep enough decimals for sub-cent turns.
    static func formatUsd(_ cost: Double) -> String {
        cost >= 1 ? String(format: "$%.2f", cost) : String(format: "$%.4f", cost)
    }
}

/// `.responseActionButtonsWrapper button`: the boards' 34pt pills in Roboto 14/500, 14pt in from
/// the 1pt border, the 14pt icon 8pt from the text (Fork's leads it).
private struct ActionPill: View {
    enum Style { case primary, secondary }

    let label: String
    var icon: String?
    var iconLeads = false
    var style: Style = .primary
    var disabled = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                if iconLeads { iconView }
                Text(label).webText(14, 500)
                if !iconLeads { iconView }
            }
            .foregroundStyle(foreground)
            .padding(.horizontal, 15)
            .frame(height: 34)
            .background(background)
            .clipShape(Capsule())
            .overlay {
                if style == .secondary {
                    Capsule().strokeBorder(AppTheme.border, lineWidth: 1)
                }
            }
        }
        .buttonStyle(WebPressStyle())
        .disabled(disabled)
        .opacity(disabled ? 0.5 : 1)
    }

    @ViewBuilder private var iconView: some View {
        if let icon { WebIcon(name: icon, size: 14, color: foreground) }
    }

    private var foreground: Color { style == .primary ? .white : AppTheme.textPrimary }

    private var background: Color {
        guard style == .primary else { return .clear }
        return disabled ? AppTheme.disabled : AppTheme.buttonPrimary
    }
}

// MARK: - Sources (`.sourcesSection`)

struct SourcesSection: View {
    let sources: [WebSource]

    private static let font = DSFont.ui(12)
    private static let indexGap = LayoutUnit.truncating(5.6)

    @State private var width: CGFloat?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(L("conversation.response.sources"))
                .webText(12, 600, lineHeight: 20.4)
                .foregroundStyle(AppTheme.textMuted)
            VStack(alignment: .leading, spacing: LayoutUnit.truncating(3.2)) {
                ForEach(sources, id: \.index) { source in
                    row(source)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
        .padding(.top, 8 + 1)
        .overlay(alignment: .top) { Rectangle().fill(AppTheme.border).frame(height: 1) }
        .padding(.top, 8)
    }

    @ViewBuilder private func row(_ source: WebSource) -> some View {
        let index = "[\(source.index)]"
        if source.isTraining {
            // No page to open, so the reference is the only place it can be read: it wraps
            // whole, and it can be selected and copied like the reply above it.
            HStack(alignment: .top, spacing: Self.indexGap) {
                indexText(index)
                Self.trainingReference(source)
                    .accessibilityIdentifier("sources-section-training")
            }
        } else {
            linkRow(source, index: index)
        }
    }

    static func trainingReference(_ source: WebSource) -> WebSelectableText {
        WebSelectableText(text: source.title, font: font, lineHeight: 20.4, color: AppTheme.UI.textPrimary,
                          trailing: (L("conversation.response.fromTraining"), AppTheme.UI.textMuted))
    }

    private func indexText(_ index: String) -> some View {
        Text(index)
            .webText(12, lineHeight: 20.4)
            .monospacedDigit()
            .foregroundStyle(AppTheme.textMuted)
    }

    private func linkRow(_ source: WebSource, index: String) -> some View {
        let indexWidth = LayoutUnit.ceiling(index.size(withAttributes: [.font: Self.font]).width)
        let title = source.title.isEmpty ? source.url : source.title
        let fitted = title.webTruncated(toFit: width.map { $0 - indexWidth - Self.indexGap } ?? .infinity, font: Self.font)
        return HStack(alignment: .firstTextBaseline, spacing: Self.indexGap) {
            indexText(index)
            Link(destination: URL(string: source.url) ?? AppConfig.webAppURL) {
                // Chrome's ellipsis isn't part of the text, so the underline stops before it.
                Text(joining: Text(verbatim: fitted.text).underline(), Text(verbatim: fitted.isTruncated ? "\u{2026}" : ""))
                    .webText(12, lineHeight: 20.4)
                    .foregroundStyle(AppTheme.textPrimary)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
        }
    }
}

// MARK: - Stop reason (StopReasonNote)

/// A note under the answer explaining why generation ended; a normal finish renders nothing.
struct StopReasonNote: View {
    let reason: String

    private static let normal: Set<String> = ["end_turn", "stop", "stop_sequence", "tool_use", "tool_calls"]
    private static let refusal: Set<String> = ["refusal", "content_filter", "safety", "recitation", "blocklist", "prohibited_content", "malformed_function_call"]
    private static let truncation: Set<String> = ["max_tokens", "length", "model_length", "max_output_tokens"]
    /// Not a vendor reason: set on a reply the user stopped mid-generation.
    static let cancelled = "cancelled"
    /// Not a vendor reason: set on a reply the server lost before it finished.
    static let interrupted = "interrupted"

    private var normalized: String { reason.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }

    var body: some View {
        let r = normalized
        if r.isEmpty || Self.normal.contains(r) {
            EmptyView()
        } else if Self.refusal.contains(r) {
            boxed(L("conversation.stopReason.refusal", ["reason": r]), color: AppTheme.error, border: AppTheme.error, size: 13.6)
        } else if Self.truncation.contains(r) {
            boxed(L("conversation.stopReason.truncated", ["reason": r]), color: AppTheme.textMuted, border: AppTheme.borderLight, size: 12.8)
        } else if r == Self.cancelled {
            boxed(L("conversation.stopReason.cancelled"), color: AppTheme.textMuted, border: AppTheme.borderLight, size: 12.8)
        } else if r == Self.interrupted {
            boxed(L("conversation.stopReason.interrupted"), color: AppTheme.textMuted, border: AppTheme.borderLight, size: 12.8)
        } else {
            Text(L("conversation.stopReason.finished", ["reason": r]))
                .font(DSFont.roboto(11.2).smallCaps())
                .kerning(0.224)
                .foregroundStyle(AppTheme.textMuted)
                .opacity(0.7)
                .padding(.top, 5.6)
        }
    }

    private func boxed(_ text: String, color: Color, border: Color, size: CGFloat) -> some View {
        Text(text)
            .webText(size, lineHeight: size * 1.4)
            .foregroundStyle(color)
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .overlay(RoundedRectangle(cornerRadius: DSRadius.md).strokeBorder(border, lineWidth: 1))
            .padding(.vertical, 8)
    }
}

// MARK: - Learned memory lives in LearnedMemoryViews.swift

/// `@keyframes pulse`: scales to 0.75 and fades to 0.35 over 1.2s.
struct PulseDot: View {
    var size: CGFloat = 6
    var color: Color = AppTheme.textMuted
    @State private var low = false

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: size, height: size)
            .scaleEffect(low ? 0.75 : 1)
            .opacity(low ? 0.35 : 1)
            .onAppear {
                withAnimation(.easeInOut(duration: 0.6).repeatForever(autoreverses: true)) { low = true }
            }
    }
}

// MARK: - Attachments

/// Download cards for generated files; short-lived URLs resolve on tap.
struct GeneratedAttachmentsSection: View {
    let attachments: [AttachmentRef]

    var body: some View {
        WebFlowLayout(spacing: 8) {
            ForEach(attachments, id: \.attachmentId) { attachment in
                AttachmentCard(attachment: attachment, fallbackName: "attachment")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, 12)
    }
}

/// AttachmentCard.module.scss: document icon, filename + "PDF · 15 KB", download icon;
/// tapping resolves the URL (spinner while pending); failures show an inline retry.
struct AttachmentCard: View {
    @EnvironmentObject var auth: AuthStore
    let attachment: AttachmentRef
    let fallbackName: String

    @State private var isLoading = false
    @State private var failed = false

    private var filename: String { attachment.filename ?? fallbackName }

    private var typeLabel: String {
        if let subtype = attachment.mediaType?.split(separator: "/").dropFirst().first {
            return subtype.split(separator: "+").first.map { $0.uppercased() } ?? L("common.attachmentCard.fileFallback")
        }
        if filename.contains("."), let ext = filename.split(separator: ".").last { return ext.uppercased() }
        return L("common.attachmentCard.fileFallback")
    }

    private var sizeLabel: String? {
        guard let bytes = attachment.sizeBytes, bytes >= 0 else { return nil }
        if bytes < 1024 { return "\(bytes) B" }
        var value = Double(bytes)
        var unit = -1
        let units = ["KB", "MB", "GB"]
        repeat {
            value /= 1024
            unit += 1
        } while value >= 1024 && unit < units.count - 1
        let number = value >= 10 ? String(Int(value.rounded())) : String(format: "%.1f", value)
        return "\(number) \(units[unit])"
    }

    var body: some View {
        Button(action: open) {
            HStack(spacing: 10.4) {
                WebIcon(name: "document", size: 22, color: AppTheme.primary)
                VStack(alignment: .leading, spacing: 1.6) {
                    WebTruncatedLine(filename)
                        .webText(13.6, 600)
                        .foregroundStyle(AppTheme.textPrimary)
                    Text(failed ? L("common.attachmentCard.error") : [typeLabel, sizeLabel].compactMap { $0 }.joined(separator: " · "))
                        .webText(11.52)
                        .foregroundStyle(failed ? AppTheme.error : AppTheme.textSecondary)
                }
                if isLoading {
                    ProgressView().controlSize(.small).padding(.leading, 4)
                } else {
                    WebIcon(name: "download", size: 18, color: AppTheme.textSecondary).padding(.leading, 4)
                }
            }
            .padding(.horizontal, 13.6)
            .padding(.vertical, 9.6)
            .frame(maxWidth: 320, alignment: .leading)
            .background(AppTheme.backgroundSecondary)
            .clipShape(RoundedRectangle(cornerRadius: DSRadius.md))
            .overlay(RoundedRectangle(cornerRadius: DSRadius.md).strokeBorder(AppTheme.border, lineWidth: 1))
        }
        .buttonStyle(WebPressStyle())
    }

    private func open() {
        guard !isLoading else { return }
        failed = false
        isLoading = true
        Task {
            defer { isLoading = false }
            do {
                let token = try await auth.getAccessTokenSilently()
                let url = try await AttachmentService.viewURL(token: token, attachmentId: attachment.attachmentId)
                await UIApplication.shared.open(url)
            } catch {
                failed = true
            }
        }
    }
}

/// Read-only thumbnails on resolved request cards (`.resolvedStrip`): images via
/// presigned GETs (tap opens), PDFs as download cards on their own row.
struct ResolvedAttachmentThumbnails: View {
    @EnvironmentObject var auth: AuthStore
    let attachments: [AttachmentRef]
    @State private var urls: [String: URL] = [:]

    private var images: [AttachmentRef] { attachments.filter { !$0.isPDF } }
    private var pdfs: [AttachmentRef] { attachments.filter(\.isPDF) }

    var body: some View {
        WebFlowLayout(spacing: 8) {
            ForEach(images.filter { urls[$0.attachmentId] != nil }, id: \.attachmentId) { attachment in
                if let url = urls[attachment.attachmentId] {
                    Button { UIApplication.shared.open(url) } label: {
                        AsyncImage(url: url) { phase in
                            switch phase {
                            case .success(let image): image.resizable().scaledToFill()
                            case .failure:
                                WebIcon(name: "image-attachment-icon", size: 22, color: AppTheme.textSecondary)
                                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                                    .background(AppTheme.backgroundSecondary)
                            default: AppTheme.backgroundSecondary
                            }
                        }
                        .frame(width: 64, height: 64)
                        .clipShape(RoundedRectangle(cornerRadius: DSRadius.md))
                        .overlay(RoundedRectangle(cornerRadius: DSRadius.md).strokeBorder(AppTheme.border, lineWidth: 1))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(attachment.filename ?? L("common.attachmentCard.fileFallback"))
                }
            }
            ForEach(pdfs, id: \.attachmentId) { attachment in
                AttachmentCard(attachment: attachment, fallbackName: "document.pdf")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, 12)
        .task(id: images.map(\.attachmentId).joined(separator: ",")) { await loadURLs() }
    }

    private func loadURLs() async {
        guard auth.isAuthenticated, !images.isEmpty, let token = try? await auth.getAccessTokenSilently() else { return }
        for attachment in images {
            if let url = try? await AttachmentService.viewURL(token: token, attachmentId: attachment.attachmentId) {
                urls[attachment.attachmentId] = url
            }
        }
    }
}

/// `flex-wrap: wrap` — children flow onto new rows.
struct WebFlowLayout: Layout {
    var spacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .greatestFiniteMagnitude
        var x: CGFloat = 0, y: CGFloat = 0, rowHeight: CGFloat = 0, maxX: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.init(width: width, height: nil))
            if x > 0, x + size.width > width {
                x = 0
                y += rowHeight + spacing
                rowHeight = 0
            }
            x += size.width + spacing
            maxX = max(maxX, x - spacing)
            rowHeight = max(rowHeight, size.height)
        }
        return CGSize(width: min(maxX, width), height: y + rowHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, rowHeight: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.init(width: bounds.width, height: nil))
            if x > bounds.minX, x + size.width > bounds.maxX {
                x = bounds.minX
                y += rowHeight + spacing
                rowHeight = 0
            }
            subview.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
    }
}
