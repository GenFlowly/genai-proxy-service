import SwiftUI

/// Response.tsx: the vendor toggle plus one card per selected vendor (two side by side
/// when the conversation is ≥900pt wide, one on phones).
struct ResponseGroupView: View {
    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var conversation: ConversationStore
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let block: ConversationBlock
    let onSelectionChange: (AskSelection?) -> Void

    @State private var swipe = ResponseSwipeModel()
    /// In the middle half of the screen: a tall response still counts, and a block at the
    /// far edge doesn't use up the one hint.
    @State private var isInReadingZone = false
    @State private var width: CGFloat = 0
    /// Each vendor is auto-selected at most once, or toggles would be undone mid-stream.
    @State private var autoSelected: Set<String> = []

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

    /// Running per-vendor totals up to and including each response: the footer shows
    /// conversation-so-far numbers; one turn's usage is the difference between responses.
    private var cumulativeByMessage: [String: UsageTotals] {
        var perVendor: [String: UsageTotals] = [:]
        var byMessage: [String: UsageTotals] = [:]
        for block in conversation.blocks {
            for message in block.responseMessages {
                guard message.inputTokens != nil || message.outputTokens != nil || message.totalTokens != nil || message.costUsd != nil else { continue }
                var totals = perVendor[message.aiVendor.rawValue] ?? UsageTotals()
                totals.add(message)
                perVendor[message.aiVendor.rawValue] = totals
                byMessage[message.messageId] = totals
            }
        }
        return byMessage
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
                    let totals = cumulativeByMessage
                    let vendors = availableVendors
                    ForEach(pagerMessages) { message in
                        let isNeighbor = message.aiVendor.rawValue == swipe.neighbor?.vendor
                        ResponseCardView(
                            block: block,
                            message: message,
                            isLastResponseBlock: isLastResponseBlock,
                            usage: totals[message.messageId] ?? (message.hasOwnUsage ? UsageTotals(message) : nil),
                            onSelectionChange: onSelectionChange,
                            swipe: swipe,
                            isSwipeNeighbor: isNeighbor
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
                .padding(8)
                .background(swipe.isDragging ? Self.dragTint : .clear)
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { swipe.pageHeight = $0 }
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
        .background(AppTheme.responseContainerBackground)
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
        .onAppear(perform: autoSelectNewVendors)
        .onChange(of: availableVendors) { _, _ in autoSelectNewVendors() }
    }

    private static let dragTint = Color(uiColor: UIColor {
        UIColor.black.withAlphaComponent($0.userInterfaceStyle == .dark ? 0.16 : 0.06)
    })

    private var isPaged: Bool { maxVendors == 1 }

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
                if let target {
                    conversation.setVendorSelection(for: block.conversationBlockId, vendors: [target.vendor])
                }
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
                onChange: { conversation.setVendorSelection(for: block.conversationBlockId, vendors: $0) }
            )
            .padding(.horizontal, 16)
            .frame(minWidth: width)
        }
        .scrollBounceBehavior(.basedOnSize, axes: .horizontal)
        .padding(.top, 12)
    }

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
    let block: ConversationBlock
    let message: Message
    let isLastResponseBlock: Bool
    let usage: UsageTotals?
    let onSelectionChange: (AskSelection?) -> Void
    let swipe: ResponseSwipeModel
    let isSwipeNeighbor: Bool

    @State private var cardHeight: CGFloat = 0

    /// Nothing follows, so the bar takes up the padding below it (12 card, 1 card edge, 8 group)
    /// and its buttons end where the scrolled page does, the same place they stick to.
    private var endsConversation: Bool { conversation.blocks.last?.conversationBlockId == block.conversationBlockId }

    private var hasAnyValidApiKey: Bool { auth.aiVendorAPIKeyStatusList.contains { $0.isAPIKeyValid == true } }
    private var isThinkingPhase: Bool { message.isLoading && message.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
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
                .padding(.bottom, 20)

            ThinkingSection(
                steps: message.thinkingSteps,
                stepList: message.thinkingStepList,
                isThinking: isThinkingPhase,
                durationMs: message.thinkingDurationMs,
                text: message.text
            )

            if !isThinkingPhase {
                MarkdownView(
                    text: Self.linkifyCitations(message.text, sources: message.webSources),
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
            if !message.isLoading, let usage {
                tokenBadge(usage)
            }
            if !isSwipeNeighbor, message.isLoading || isLastResponseBlock || canFork {
                actionBar
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 1)
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { cardHeight = $0 }
    }

    private var selectionHandler: ((String?) -> Void)? {
        guard canAsk else { return nil }
        let blockId = block.conversationBlockId
        let message = message
        return { text in
            onSelectionChange(text.map { AskSelection(text: $0, blockId: blockId, message: message) })
        }
    }

    /// Centered vendor name + model chip; the copy button pinned right.
    private var header: some View {
        ZStack(alignment: .trailing) {
            HStack(spacing: 8) {
                VendorBrandName(vendor: message.aiVendor)
                    .webText(16, 500, lineHeight: 27.2)
                    .foregroundStyle(AppTheme.textPrimary)
                    .lineLimit(1)
                    .fixedSize()
                if let model = message.model, !model.isEmpty {
                    Text(model)
                        .webText(11.2, 500, lineHeight: 11.2)
                        .kerning(0.224)
                        .foregroundStyle(AppTheme.textMuted)
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .padding(.horizontal, 10.6)
                        .padding(.vertical, 5)
                        .background(AppTheme.backgroundTertiary)
                        .clipShape(Capsule())
                        .overlay(Capsule().strokeBorder(AppTheme.borderLight, lineWidth: 1))
                }
            }
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 50)

            CopyToClipboardButton(content: message.text, accessibilityLabel: L("common.textContainer.copyResponse"))
        }
        // The button is taller than the row and positioned out of flow: it doesn't push it.
        .frame(height: 27.2)
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

    /// `.tokenBadge`: input, output, cache, total, $cost, learned-facts brain.
    private func tokenBadge(_ usage: UsageTotals) -> some View {
        HStack(spacing: 12) {
            tokenItem("input-tokens", usage.inputTokens, L("conversation.response.totalInputTokens"))
            tokenItem("output-tokens", usage.outputTokens, L("conversation.response.totalOutputTokens"))
            tokenItem("cache-tokens", usage.tokensReadFromCache, L("conversation.response.tokensReadFromCache"))
            tokenItem("total-tokens", usage.totalTokens, L("conversation.response.totalTokens"))
            if let cost = usage.costUsd {
                Text(Self.formatUsd(cost))
                    .lineLimit(1)
                    .fixedSize()
                    .accessibilityLabel(L("conversation.response.conversationCostUsd", ["vendor": message.aiVendor.rawValue]))
                    .webTooltip(L("conversation.response.conversationCostUsd", ["vendor": message.aiVendor.rawValue]))
            }
            LearnedFactsStat(
                conversationId: conversation.conversationId,
                message: message
            )
        }
        .webText(11.2, lineHeight: 19.04)
        .monospacedDigit()
        .kerning(0.112)
        .foregroundStyle(AppTheme.textMuted)
        .opacity(0.8)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func tokenItem(_ icon: String, _ value: Int, _ label: String) -> some View {
        HStack(spacing: 4) {
            WebIcon(name: icon, size: 12, color: AppTheme.textMuted)
            Text(value.formatted(.number.grouping(.automatic).locale(Locale(identifier: "en_US"))))
                .lineLimit(1)
                .fixedSize()
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(label)
        .webTooltip(label)
    }

    /// `.responseActionButtonsWrapper`: spans the card edge to edge, sticks to the bottom
    /// of the viewport while the card is taller than the screen, with a light backdrop.
    private var actionBar: some View {
        HStack(spacing: 8) {
            if message.isLoading {
                RectangleButton(label: L("conversation.response.stop")) {
                    conversation.stopGenerating(blockId: block.conversationBlockId, vendor: message.aiVendor)
                }
            } else {
                if isLastResponseBlock {
                    RectangleButton(label: L("conversation.response.regenerate"), icon: "refresh-icon", disabled: !hasAnyValidApiKey) {
                        Task {
                            await conversation.generateResponsesStream(blockId: block.conversationBlockId, vendorToRegenerate: message.aiVendor)
                        }
                    }
                }
                if isLastResponseBlock, !message.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    RectangleButton(
                        label: isSelected ? L("conversation.response.selected") : L("conversation.response.followUp"),
                        icon: isSelected ? nil : "send-icon",
                        disabled: isSelected || !hasAnyValidApiKey
                    ) {
                        conversation.followUp(fromBlock: block.conversationBlockId, messageId: message.messageId)
                    }
                }
                if canFork {
                    PillButton(label: L("conversation.response.fork"), icon: "git-fork", style: .secondary, minWidth: nil) {
                        Task { await conversation.forkFromMessage(message.messageId) }
                    }
                    .accessibilityHint(L("conversation.response.forkHint"))
                }
            }
        }
        .opacity(0.85)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity)
        .background(ActionBarBackground())
        .modifier(StickyBottom(containerHeight: cardHeight, barHeight: 62, bottomPadding: 12))
        .modifier(ResponseSwipeOffset(model: swipe, factor: -1))
        .padding(.horizontal, -16)
        .padding(.bottom, endsConversation ? -33 : -12)
        .zIndex(10)
    }

    /// `[n]` → a markdown link to its web source; a stray marker stays plain text, and
    /// markers already followed by "(" are part of an existing link.
    static func linkifyCitations(_ text: String, sources: [WebSource]?) -> String {
        guard !text.isEmpty, let sources, !sources.isEmpty else { return text }
        let urls = Dictionary(sources.map { ($0.index, $0.url) }, uniquingKeysWith: { first, _ in first })
        let regex = try! NSRegularExpression(pattern: "\\[(\\d{1,3})\\](?!\\()")
        let ns = text as NSString
        var out = ""
        var cursor = 0
        for match in regex.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
            out += ns.substring(with: NSRange(location: cursor, length: match.range.location - cursor))
            let marker = ns.substring(with: match.range)
            if let index = Int(ns.substring(with: match.range(at: 1))), let url = urls[index] {
                out += "[\(marker)](\(url))"
            } else {
                out += marker
            }
            cursor = match.range.location + match.range.length
        }
        return out + ns.substring(from: cursor)
    }

    /// "$1.23" / "$0.0421" — sub-dollar amounts keep enough decimals for sub-cent turns.
    static func formatUsd(_ cost: Double) -> String {
        cost >= 1 ? String(format: "$%.2f", cost) : String(format: "$%.4f", cost)
    }
}

/// CSS `position: sticky; bottom: 0` inside the card: lifted while the card extends past the
/// viewport, never above the card's own top. The viewport ends above the home indicator, and
/// the bar's bottom padding hangs past it, so the buttons stay clear of the indicator.
private struct StickyBottom: ViewModifier {
    let containerHeight: CGFloat
    let barHeight: CGFloat
    let bottomPadding: CGFloat

    func body(content: Content) -> some View {
        content.visualEffect { [bottomPadding] view, proxy in
            let frame = proxy.frame(in: .scrollView(axis: .vertical))
            let viewport = proxy.bounds(of: .scrollView(axis: .vertical))?.height ?? .greatestFiniteMagnitude
            let overflow = max(0, frame.maxY - (viewport + bottomPadding))
            let limit = max(0, containerHeight - barHeight)
            return view.offset(y: -min(overflow, limit))
        }
    }
}

/// `backdrop-filter: blur(4px)` over `color-mix(page 20%, transparent)`. Past the web's, it
/// reaches both screen edges, and runs under the home indicator to the bottom of the screen.
private struct ActionBarBackground: View {
    /// The group's side padding, on top of the card's that the bar already cancels.
    private static let groupPadding: CGFloat = 8

    var body: some View {
        AppTheme.background.opacity(0.2)
            .background(BackdropBlur(fraction: 0.1))
            .padding(.horizontal, -Self.groupPadding)
            .padding(.bottom, -40)
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

    private func row(_ source: WebSource) -> some View {
        let index = "[\(source.index)]"
        let indexWidth = LayoutUnit.ceiling(index.size(withAttributes: [.font: Self.font]).width)
        let title = source.title.isEmpty ? source.url : source.title
        let fitted = title.webTruncated(toFit: width.map { $0 - indexWidth - Self.indexGap } ?? .infinity, font: Self.font)
        return HStack(alignment: .firstTextBaseline, spacing: Self.indexGap) {
            Text(index)
                .webText(12, lineHeight: 20.4)
                .monospacedDigit()
                .foregroundStyle(AppTheme.textMuted)
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

    private var normalized: String { reason.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }

    var body: some View {
        let r = normalized
        if r.isEmpty || Self.normal.contains(r) {
            EmptyView()
        } else if Self.refusal.contains(r) {
            boxed(L("conversation.stopReason.refusal", ["reason": r]), color: AppTheme.error, border: AppTheme.error, size: 13.6)
        } else if Self.truncation.contains(r) {
            boxed(L("conversation.stopReason.truncated", ["reason": r]), color: AppTheme.textMuted, border: AppTheme.borderLight, size: 12.8)
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

// MARK: - Learned facts (LearnedFactsStat + useLearnedFacts)

struct LearnedFactsStat: View {
    @EnvironmentObject var auth: AuthStore
    let conversationId: String
    let message: Message

    @State private var facts: [LearnedFact] = []
    @State private var isPending = false
    @State private var showList = false
    @State private var pollId = ""

    private static let pollInterval: UInt64 = 4_000_000_000
    private static let pollTimeout: TimeInterval = 60

    /// Only a response generated in THIS session, with a real id and no error, has an
    /// async extraction worth polling for.
    private var isFresh: Bool {
        if case .fresh = message.learnedFacts {
            return message.error == nil && !conversationId.isEmpty && message.hasRealId
        }
        return false
    }

    var body: some View {
        Group {
            if isPending {
                HStack(spacing: 4) {
                    WebIcon(name: "brain", size: 12, color: AppTheme.textMuted)
                    PulseDot(size: 6, color: AppTheme.textMuted)
                }
                .opacity(0.7)
                .accessibilityLabel(L("conversation.response.learningFacts"))
                .webTooltip(L("conversation.response.learningFacts"))
            } else if facts.isEmpty {
                HStack(spacing: 4) {
                    WebIcon(name: "brain", size: 12, color: AppTheme.textMuted)
                    Text("0")
                }
                .opacity(0.7)
                .accessibilityLabel(L("conversation.response.noNewFacts"))
                .webTooltip(L("conversation.response.noNewFacts"))
            } else {
                Button { showList = true } label: {
                    HStack(spacing: 4) {
                        WebIcon(name: "brain", size: 12, color: AppTheme.textMuted)
                        Text("\(facts.count)")
                    }
                }
                .buttonStyle(.plain)
                .accessibilityLabel(L("conversation.response.factsAddedToMemory", ["count": facts.count]))
                .popover(isPresented: $showList) { factsList.presentationCompactAdaptation(.popover) }
            }
        }
        .task(id: message.messageId) { await load() }
    }

    /// Interactive tooltip content: the wording plus a list with ✗ to delete each fact.
    private var factsList: some View {
        VStack(alignment: .leading, spacing: 5.6) {
            Text(L("conversation.response.factsAddedToMemory", ["count": facts.count])).webText(13.6, 600)
            ForEach(facts) { fact in
                HStack(alignment: .top, spacing: 8) {
                    Text(fact.text).webText(13.6).frame(maxWidth: .infinity, alignment: .leading)
                    Button("✗") { Task { await remove(fact) } }
                        .font(DSFont.arial(12.8))
                        .foregroundStyle(AppTheme.error)
                        .opacity(0.75)
                        .accessibilityLabel(L("conversation.response.deleteFact", ["fact": fact.text]))
                }
            }
        }
        .foregroundStyle(AppTheme.navbarText)
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .frame(maxWidth: 300)
        .presentationBackground(AppTheme.navbarBackground)
    }

    private func load() async {
        switch message.learnedFacts {
        case .known(let known):
            facts = known
            isPending = false
        case .unknown:
            isPending = false
        case .fresh:
            guard isFresh else { return }
            isPending = true
            let started = Date()
            while !Task.isCancelled {
                if let token = try? await auth.getAccessTokenSilently(),
                   let result = try? await LearnedFactsService.get(token: token, conversationId: conversationId, messageId: message.messageId),
                   !result.isPending {
                    facts = result.facts ?? []
                    isPending = false
                    return
                }
                // Extraction that slow counts as "no new facts".
                if Date().timeIntervalSince(started) >= Self.pollTimeout {
                    isPending = false
                    return
                }
                try? await Task.sleep(nanoseconds: Self.pollInterval)
            }
        }
    }

    /// A real failure keeps the fact listed so the user can retry.
    private func remove(_ fact: LearnedFact) async {
        guard let token = try? await auth.getAccessTokenSilently() else { return }
        do {
            try await LearnedFactsService.delete(token: token, memoryId: fact.memoryId)
            facts.removeAll { $0.memoryId == fact.memoryId }
            if facts.isEmpty { showList = false }
        } catch {
            AppObservability.capture(error, context: ["where": "deleteMemoryFact"])
        }
    }
}

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
