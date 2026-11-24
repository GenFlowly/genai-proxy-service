import SwiftUI

/// The chat page below isNarrow: full-screen scrolling conversation with the transparent
/// MobileHeader floating above it (LandingPage + CenterSection + ConversationWidget).
struct ChatView: View {
    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var ai: AIStore
    @EnvironmentObject var conversation: ConversationStore
    @EnvironmentObject var toasts: ToastCenter
    @EnvironmentObject var router: AppRouter
    @EnvironmentObject var history: HistoryStore

    @State private var showShare = false
    @State private var showPicker = false
    @State private var showOutline = false
    /// A turn the Outline asked to jump to.
    @State private var outlineTarget: String?
    /// The turn in view: the last one whose top passed 30% of the way down.
    @State private var viewedBlockId: String?
    /// Where each block starts in the scroll content; read while scrolling, so not @State.
    @State private var blockTops = BlockTops()
    /// Where the finger's drag of the conversation started; read while scrolling, so not @State.
    @State private var drag = ConversationDrag()
    @ObservedObject private var catalog = ProviderCatalog.shared
    @State private var scrollViewHeight: CGFloat = 0
    /// Docked "Ask" pill (`.selectionAskDocked`): the selection and where it came from.
    @State private var askSelection: AskSelection?
    /// Blocks whose response already took the initial jump (ConversationBlock.hasScrolledRef).
    @State private var scrolledBlocks: Set<String> = []
    /// The turn sent from this screen: held at the top of the view while its answer generates
    /// below it (ConversationBlock's holdsTop).
    @State private var heldTurnId: String?
    @State private var viewportHeight: CGFloat = 0
    /// The conversation is taller than the screen, so its end can reach the home indicator.
    @State private var contentFillsViewport = false
    /// From the top of the page to the keyboard, or to the bottom edge while it is closed.
    @State private var screenHeight: CGFloat = 0
    /// The trailing editor stuck to the bottom of the page covers this much of it.
    @State private var trailingEditorHeight: CGFloat = 0

    private var outlineItems: [OutlineItem] {
        ChatOutline.items(blocks: conversation.blocks, vendorName: catalog.displayName(for:))
    }

    /// The turn in view, for the header's second line.
    private var headerTurn: HeaderTurn? {
        let items = outlineItems
        guard let currentId = ChatOutline.currentId(items: items, viewedId: viewedBlockId),
              let index = items.firstIndex(where: { $0.id == currentId }) else { return nil }
        return HeaderTurn(number: items[index].number, prompt: items[index].prompt, position: index + 1, count: items.count)
    }

    /// Changes whenever the last block finishes or a conversation loads.
    private var trailingDraftKey: String {
        guard let last = conversation.blocks.last else { return "" }
        return "\(last.conversationBlockId)|\(last.status.rawValue)|\(last.isLoading)|\(conversation.conversationRole.rawValue)"
    }

    /// The last sent turn: the one generating, or the latest answered one.
    private var latestTurn: ConversationBlock? {
        conversation.blocks.last { $0.status == .resolved || $0.isLoading }
    }

    private var isFreshChat: Bool {
        conversation.blocks.count == 1 && conversation.blocks[0].status == .draft && conversation.blocks[0].responseMessages.isEmpty && !conversation.blocks[0].isLoading
    }


    var body: some View {
        ZStack(alignment: .top) {
            if isFreshChat {
                VStack(spacing: 0) {
                    // Above the composer, never over it: the keyboard shrinks the page, not the composer
                    if let projectName = conversation.pendingProjectName(in: history.projects) {
                        NewChatProjectHint(name: projectName, pageHeight: screenHeight)
                    } else {
                        Spacer(minLength: 0)
                    }
                    ComposerView(blockId: conversation.blocks[0].conversationBlockId, isLastBlock: true)
                }
            } else {
                conversationScroll
            }

            ChatHeader(
                showShare: $showShare,
                turn: headerTurn,
                isOutlineOpen: showOutline,
                onOpenOutline: outlineItems.isEmpty ? nil : { showOutline = true }
            )

            if showOutline {
                let items = outlineItems
                OutlineSheet(
                    items: items,
                    currentId: ChatOutline.currentId(items: items, viewedId: viewedBlockId),
                    onSelect: { outlineTarget = $0 },
                    onClose: { showOutline = false }
                )
                .zIndex(2)
            }

            if let selection = askSelection {
                VStack {
                    Spacer()
                    askPill(selection)
                        .padding(.bottom, 148)
                }
            }
        }
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { screenHeight = $0 }
        .environment(\.chatScreenHeight, screenHeight)
        .statusBarBand()
        // Under the keyboard too: the page can be drawn at its keyboard-up size after the keyboard
        // has gone (a screenshot does that), and nothing but the page's color may show there.
        .background { AppTheme.background.ignoresSafeArea() }
        .webModal(isPresented: $showPicker, title: L("conversation.instructionPicker.title"), maxWidth: 768, scrollsContent: false) {
            InstructionPickerModal(onClose: { showPicker = false }) { instruction in
                ai.selectedInstructionId = instruction.id
                ai.systemPrompt = instruction.instruction
                showPicker = false
            }
        }
        .webModal(isPresented: $showShare, title: L("common.shareModal.title")) {
            ShareModal(target: .conversation(conversation.conversationId), onClose: { showShare = false })
        }
        .onChange(of: router.showInstructionPicker) { _, open in
            if open {
                showPicker = true
                router.showInstructionPicker = false
            }
        }
        .animation(.easeOut(duration: 0.2), value: showOutline)
        .task(id: auth.customerId) { await loadSharedQueries() }
        .onChange(of: conversation.conversationId) { _, _ in askSelection = nil }
        .onChange(of: trailingDraftKey, initial: true) { _, _ in conversation.ensureTrailingDraft() }
    }

    /// `useDefaultsPrefetch` + the AI widget's query: warm what the page reads.
    private func loadSharedQueries() async {
        guard auth.isAuthenticated, let token = try? await auth.getAccessTokenSilently() else { return }
        let vendors = auth.aiVendorAPIKeyStatusList.filter(\.isValid).map { AIVendor(rawValue: $0.aiVendor) }
        await ai.fetchModels(token: token, vendors: vendors)
        await ai.fetchAgents(token: token, version: auth.cacheVersions?["agents"])
    }

    /// A browser's viewport ends above the home indicator. Here the conversation's end stops
    /// there, so the response's surface carries on behind the indicator instead of the page's.
    private var homeIndicatorBand: some View {
        let endsInResponse = conversation.blocks.last?.responseMessages.isEmpty == false
        return Color.clear
            .frame(height: 0)
            .background((endsInResponse && contentFillsViewport ? AppTheme.responseContainerBackground : AppTheme.background).ignoresSafeArea(.container, edges: .bottom))
    }

    private var conversationScroll: some View {
        ScrollViewReader { proxy in
            ScrollView {
                // Not a LazyVStack: it estimates the height of rows it hasn't built from the tall
                // responses around them, and the estimate can change by tens of thousands of points
                // on any update. Scrolling to a row could land past the page's end with nothing to
                // draw, and the first drag could swap the screen for a different response.
                VStack(spacing: 0) {
                    ForEach(conversation.blocks) { block in
                        let blockId = block.conversationBlockId
                        ConversationBlockView(block: block, onSelectionChange: { selection in
                            askSelection = selection
                        }, onTrailingEditorHeight: { trailingEditorHeight = $0 })
                        .frame(minHeight: blockId == heldTurnId && blockId == latestTurn?.conversationBlockId ? heldTurnReserve : nil, alignment: .top)
                        .id(blockId)
                        // The web's 5rem scroll margin: an Outline jump lands the turn this far
                        // below the top of the page, clear of the overlay header.
                        .overlay(alignment: .top) {
                            Color.clear.frame(height: 1).offset(y: mobileHeaderHeight - 80).id(Self.turnAnchor(blockId)).allowsHitTesting(false)
                        }
                        .onGeometryChange(for: CGFloat.self) { $0.frame(in: .named(Self.contentSpace)).minY } action: { top in
                            blockTops.values[blockId] = top
                        }
                    }
                    Color.clear.frame(height: 0).id("conversation-end")
                }
                .coordinateSpace(.named(Self.contentSpace))
            }
            .contentMargins(.top, mobileHeaderHeight, for: .scrollContent)
            .scrollDismissesKeyboard(.interactively)
            // Dragging the conversation back up puts the draft editor away, as on the web
            .onScrollPhaseChange { _, phase, context in
                drag.startOffset = phase == .interacting ? context.geometry.contentOffset.y : nil
            }
            .onScrollGeometryChange(for: CGFloat.self) { $0.contentOffset.y } action: { _, offset in
                guard let start = drag.startOffset, start - offset >= Self.scrollBackUpDistance else { return }
                drag.startOffset = nil
                conversation.putAwayDraftRequest += 1
            }
            .background(alignment: .bottom) { homeIndicatorBand }
            .onScrollGeometryChange(for: Bool.self) { geometry in
                geometry.contentSize.height + geometry.contentInsets.top + geometry.contentInsets.bottom >= geometry.containerSize.height
            } action: { _, fills in
                contentFillsViewport = fills
            }
            #if DEBUG
            .modifier(DebugConversationScroll())
            #endif
            .onScrollGeometryChange(for: CGFloat.self) { $0.containerSize.height } action: { _, height in
                viewportHeight = height
            }
            .onScrollGeometryChange(for: String?.self) { geometry in
                ChatOutline.viewedBlockId(
                    blockTops: blockTops.values.map { (id: $0.key, top: $0.value) },
                    scrollOffset: geometry.contentOffset.y,
                    viewportHeight: geometry.containerSize.height
                )
            } action: { _, id in
                viewedBlockId = id
            }
            .onChange(of: outlineTarget) { _, target in
                guard let target else { return }
                outlineTarget = nil
                withAnimation(.easeOut(duration: 0.3)) { proxy.scrollTo(Self.turnAnchor(target), anchor: .top) }
            }
            .onChange(of: conversation.responseTopRequest) { _, target in
                guard let target else { return }
                conversation.responseTopRequest = nil
                // After the new response has laid out, or the scroll aims at the old one's height.
                DispatchQueue.main.async {
                    withAnimation(.easeOut(duration: 0.3)) { proxy.scrollTo(ResponseGroupView.topAnchor(target), anchor: .top) }
                }
            }
            .onChange(of: conversation.focusDraftRequest) { _, _ in
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                    withAnimation(.easeOut(duration: 0.3)) { proxy.scrollTo("conversation-end", anchor: .bottom) }
                }
            }
            // A response appearing for the first time takes the view to it once: a finished one
            // (conversation opened) lands straight on the response, a generating one (just sent)
            // puts its prompt at the top of the view. The view doesn't follow the answer as it
            // streams: it grows down from the prompt.
            .onChange(of: conversation.blocks.filter { !$0.responseMessages.isEmpty }.map(\.conversationBlockId), initial: true) { _, ids in
                let fresh = ids.filter { !scrolledBlocks.contains($0) }
                guard let target = fresh.last else { return }
                scrolledBlocks.formUnion(fresh)
                guard latestTurn?.isLoading == true else {
                    let anchor = ConversationBlockView.responseAnchor(target)
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { proxy.scrollTo(anchor, anchor: .top) }
                    return
                }
                heldTurnId = target
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                    withAnimation(.easeOut(duration: 0.3)) { proxy.scrollTo(Self.turnAnchor(target), anchor: .top) }
                }
            }
        }
    }

    /// The held turn keeps a view of height from its top edge (the turn anchor's 80pt margin) to
    /// the trailing editor, so it reaches the top however short its answer is.
    private var heldTurnReserve: CGFloat {
        max(0, viewportHeight - 80 - trailingEditorHeight)
    }

    static let contentSpace = "chat-content"
    /// How far a finger drags the conversation down before it counts as scrolling back up.
    static let scrollBackUpDistance: CGFloat = 24
    static func turnAnchor(_ blockId: String) -> String { "turn-\(blockId)" }

    /// Touch selection: the pill docks above the idle follow-up editor stuck to the bottom of
    /// the page because the OS selection callout draws over the page wherever the selection sits.
    private func askPill(_ selection: AskSelection) -> some View {
        Button {
            conversation.ask(selectedText: selection.text, fromBlock: selection.blockId, message: selection.message)
            askSelection = nil
        } label: {
            HStack(spacing: 8) {
                WebIcon(name: "send-icon", size: 15, color: .white)
                Text(L("common.textContainer.askSelection")).webText(16.8, 600)
            }
            .foregroundStyle(.white)
            .padding(.horizontal, 19.2)
            .padding(.vertical, 9.6)
            .background(AppTheme.buttonPrimary)
            .clipShape(Capsule())
            .shadow(color: .black.opacity(0.3), radius: 6, y: 4)
        }
        .buttonStyle(WebPressStyle())
    }
}

/// Where each block starts in the scroll content, kept out of SwiftUI's change tracking so
/// scrolling doesn't redraw the page.
final class BlockTops {
    var values: [String: CGFloat] = [:]
}

final class ConversationDrag {
    var startOffset: CGFloat?
}

struct AskSelection {
    let text: String
    let blockId: String
    let message: Message
}

/// ConversationHeader below isNarrow: the title over the turn in view (the pill opens the
/// Outline) and the New Chat / Share / AI Settings kebab; the hamburger opens the Chats and
/// Projects menu. The instruction is picked on the editor's chip.
struct ChatHeader: View {
    @EnvironmentObject var router: AppRouter
    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var conversation: ConversationStore
    @EnvironmentObject var history: HistoryStore
    @Binding var showShare: Bool
    /// The turn in view; nil while there are no turns yet.
    var turn: HeaderTurn?
    var isOutlineOpen = false
    /// Opens the Outline; nil while there are no turns yet.
    var onOpenOutline: (() -> Void)?
    @StateObject private var moderation = SharedItemModeration()

    /// The open conversation, when someone else owns it.
    private var sharedItem: SharedItem? {
        guard !conversation.conversationId.isEmpty, conversation.conversationRole != .owner else { return nil }
        return .conversation(conversation.conversationId)
    }

    private var sharedByLabel: String? {
        moderation.owner.map {
            L("moderation.sharedByRole", [
                "name": $0.label,
                "role": L(conversation.conversationRole == .view ? "moderation.roleView" : "moderation.roleEdit"),
            ])
        }
    }

    private var displayTitle: String {
        conversation.conversationId.isEmpty
            ? L("conversation.conversationHeader.newChat")
            : (conversation.conversationTitle ?? L("conversation.conversationHeader.untitledConversation"))
    }

    private var showShareItem: Bool {
        auth.canShare && !conversation.conversationId.isEmpty && conversation.conversationRole != .view
    }

    private var menuItems: [MobileHeaderMenuItem] {
        var items = [MobileHeaderMenuItem(label: L("conversation.conversationHeader.newChat")) { conversation.resetConversation() }]
        if showShareItem {
            items.append(MobileHeaderMenuItem(label: L("conversation.conversationHeader.share")) { showShare = true })
        }
        items.append(MobileHeaderMenuItem(label: L("layout.mobileFullPageModal.aiSettings")) { router.isRightSidebarOpen = true })
        return items + moderation.menuItems
    }

    var body: some View {
        ZStack(alignment: .top) {
            if let sharedByLabel {
                Text(sharedByLabel)
                    .webText(13)
                    .foregroundStyle(AppTheme.textPrimary)
                    .lineLimit(1)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 5)
                    .background(AppTheme.primaryLight)
                    .clipShape(Capsule())
                    .overlay(Capsule().strokeBorder(AppTheme.border, lineWidth: 1))
                    .padding(.top, mobileHeaderHeight + 2)
                    .allowsHitTesting(false)
                    .accessibilityIdentifier("shared-by")
            }
            header
        }
        .task(id: sharedItem) { await moderation.load(item: sharedItem, auth: auth) }
        .sharedItemModerationDialogs(moderation) { conversation.resetConversation() }
    }

    @ViewBuilder
    private var header: some View {
        if let turn {
            MobileHeader(
                title: displayTitle,
                menuItems: menuItems,
                onPillClick: onOpenOutline,
                pillActionLabel: L("conversation.outline.openFor", ["title": displayTitle]),
                pillExpanded: isOutlineOpen,
                onMenuClick: { router.isMobileMenuOpen = true }
            ) {
                TurnCrumb(turn: turn)
            }
        } else if let projectName = conversation.pendingProjectName(in: history.projects) {
            MobileHeader(title: displayTitle, menuItems: menuItems, onMenuClick: { router.isMobileMenuOpen = true }) {
                HStack(spacing: 4) {
                    WebIcon(name: "folder", size: 12, color: AppTheme.textMuted)
                    WebTruncatedLine(L("conversation.conversationHeader.inProject", ["name": projectName]))
                }
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("mobile-header-project")
            }
        } else {
            MobileHeader(title: displayTitle, menuItems: menuItems, onMenuClick: { router.isMobileMenuOpen = true })
        }
    }
}

/// Where the header's turn line is: the turn in view and its place among the turns.
struct HeaderTurn: Equatable {
    let number: Int
    let prompt: String
    let position: Int
    let count: Int
}

/// The header's second line in a conversation, as the desktop sub-bar shows the turn in view:
/// its Q-badge and prompt, then where it is among the turns. The prompt gives way first.
struct TurnCrumb: View {
    let turn: HeaderTurn

    var body: some View {
        HStack(spacing: 5) {
            Text("Q\(turn.number)")
                .webText(10.5, 700)
                .foregroundStyle(.white)
                .padding(.horizontal, 5)
                .frame(height: 16)
                .background(AppTheme.buttonPrimary)
                .clipShape(Capsule())
                .fixedSize()
            WebTruncatedLine(turn.prompt)
                .webText(12)
                .layoutPriority(-1)
            Text("\(turn.position) / \(turn.count)")
                .webText(12)
                .foregroundStyle(AppTheme.textMuted)
                .fixedSize()
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("mobile-header-turn")
    }
}

// MARK: - Conversation block (Request → Response)

struct ConversationBlockView: View {
    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var conversation: ConversationStore
    let block: ConversationBlock
    let onSelectionChange: (AskSelection?) -> Void
    var onTrailingEditorHeight: (CGFloat) -> Void = { _ in }

    static func responseAnchor(_ blockId: String) -> String { "response-start-\(blockId)" }

    var body: some View {
        VStack(spacing: 0) {
            if block.status == .resolved || block.isLoading {
                ResolvedRequestView(block: block)
            } else {
                let isLastBlock = conversation.blocks.last?.conversationBlockId == block.conversationBlockId
                ComposerView(blockId: block.conversationBlockId, isLastBlock: isLastBlock)
                    .modifier(StickyViewportBottom(isActive: isLastBlock))
                    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height in
                        if isLastBlock { onTrailingEditorHeight(height) }
                    }
            }

            if block.status == .resolved || !block.responseMessages.isEmpty {
                ResponseGroupView(block: block, onSelectionChange: onSelectionChange)
                    // `scrollIntoView({ block: 'start' })` lands the response's top edge at
                    // the top of the page, behind the overlay header. Scrolling to an id
                    // stops at the content margin, so the anchor sits that far inside.
                    .overlay(alignment: .top) {
                        VStack(spacing: 0) {
                            Color.clear.frame(height: mobileHeaderHeight)
                            Color.clear.frame(height: 1).id(Self.responseAnchor(block.conversationBlockId))
                        }
                        .allowsHitTesting(false)
                    }
            }

            RunHitlBanner(block: block)
        }
    }
}

/// The trailing editor's `position: sticky; bottom: 0` against the whole conversation: held on
/// the bottom of the viewport, lifted over the turns scrolled behind it while its place at the
/// conversation's end is below the viewport, and lowered when the conversation ends above it (a
/// short conversation, or an offset left past the end when the content shrank). The viewport
/// ends above the home indicator, so the page's color runs on under the indicator.
private struct StickyViewportBottom: ViewModifier {
    let isActive: Bool

    func body(content: Content) -> some View {
        if isActive {
            content
                .background(alignment: .bottom) {
                    AppTheme.background.frame(height: 40).offset(y: 40)
                }
                .visualEffect { view, proxy in
                    let frame = proxy.frame(in: .scrollView(axis: .vertical))
                    guard let viewport = proxy.bounds(of: .scrollView(axis: .vertical))?.height else { return view.offset(y: 0) }
                    return view.offset(y: viewport - frame.maxY)
                }
        } else {
            content
        }
    }
}

// MARK: - Resolved request (Request.module.scss .resolvedRequestContainer)

struct ResolvedRequestView: View {
    @EnvironmentObject var auth: AuthStore
    let block: ConversationBlock

    /// A shared conversation shows who sent each message, never the viewer's identity.
    private var displayName: String {
        if let sender = block.sender { return sender.name ?? "" }
        return auth.customerName ?? ""
    }

    private var displayPicture: String? {
        if let sender = block.sender { return sender.picture }
        return auth.customerPicture
    }

    /// The phone boards' prompt: on the page, 8pt in from the screen's edges and 16pt below the
    /// header or the turn above, one header row with the copy icon on the right.
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ZStack(alignment: .trailing) {
                UserBrandName(name: displayName, picture: displayPicture)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.trailing, 40)
                CopyToClipboardButton(content: block.prompt, accessibilityLabel: L("common.textContainer.copyPrompt"), style: .turn)
            }
            .frame(height: 32)
            .padding(.bottom, 8)

            ReaderFriendlyMarkdownView(text: block.prompt, options: .init(capitalizeFirstLetter: true, tightFirstHeading: false, turnTextSize: 17))

            if !block.attachments.isEmpty {
                ResolvedAttachmentThumbnails(attachments: block.attachments)
            }

            if let sentAt = block.sentAt {
                Text(ServerDate.dateTime(sentAt))
                    .webText(12, lineHeight: 16.8)
                    .foregroundStyle(AppTheme.textMuted)
                    .frame(maxWidth: .infinity, alignment: .trailing)
                    .padding(.top, 6)
            }
        }
        .padding(.top, 16)
        .padding(.horizontal, ReaderFriendlyMarkdownView.readingInset)
        .frame(maxWidth: .infinity)
    }
}

// MARK: - Human in the loop (RunHitlBanner.tsx)

struct RunHitlBanner: View {
    @EnvironmentObject var conversation: ConversationStore
    let block: ConversationBlock
    @State private var drafts: [String: String] = [:]

    private var entries: [(String, AwaitingInput)] {
        block.responseMessages.compactMap { message in
            conversation.awaitingInputs[message.messageId].map { (message.messageId, $0) }
        }
    }

    var body: some View {
        if !entries.isEmpty {
            VStack(spacing: 8) {
                ForEach(entries, id: \.0) { messageId, payload in
                    VStack(alignment: .leading, spacing: 8) {
                        Text(payload.prompt ?? L("conversation.runHitl.defaultPrompt"))
                            .webText(16, 500)
                            .foregroundStyle(AppTheme.textPrimary)
                        HStack(spacing: 8) {
                            TextField("", text: binding(messageId), prompt: Text(L("conversation.runHitl.replyPlaceholder")).foregroundStyle(AppTheme.textMuted))
                                .webText(13.33)
                                .foregroundStyle(AppTheme.textPrimary)
                                .padding(.horizontal, 8)
                                .padding(.vertical, 6)
                                .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(AppTheme.border, lineWidth: 1))
                                .onSubmit { send(messageId) }
                            Button(L("conversation.runHitl.send")) { send(messageId) }
                                .disabled((drafts[messageId] ?? "").trimmingCharacters(in: .whitespaces).isEmpty)
                                .webText(arial: 13.33)
                                .padding(.horizontal, 14)
                                .padding(.vertical, 6)
                                .background(AppTheme.backgroundTertiary)
                                .clipShape(RoundedRectangle(cornerRadius: 6))
                        }
                    }
                    .padding(12)
                    .background(AppTheme.backgroundSecondary)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                    .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(AppTheme.border, lineWidth: 1))
                    .accessibilityLabel(L("conversation.runHitl.ariaLabel"))
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
        }
    }

    private func binding(_ id: String) -> Binding<String> {
        Binding(get: { drafts[id] ?? "" }, set: { drafts[id] = $0 })
    }

    private func send(_ id: String) {
        let text = (drafts[id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        drafts[id] = ""
        Task { await conversation.submitRunReply(messageId: id, reply: text) }
    }
}

extension EnvironmentValues {
    /// The chat page's height down to the keyboard, or to the bottom edge while it is closed: the
    /// room the composer grows into.
    @Entry var chatScreenHeight: CGFloat = 0
}

/// NewChatProjectHint.tsx: what happens to the first message of a chat opened from a project's
/// plus, in the room between the header and the composer. Too little room hides it.
struct NewChatProjectHint: View {
    let name: String
    /// The whole page's height, down to the keyboard while it is open.
    let pageHeight: CGFloat

    var body: some View {
        NewChatHintLayout(pageHeight: pageHeight) {
            ViewThatFits(in: .vertical) {
                Text(L("conversation.conversationHeader.newChatInProjectHint", ["name": name]))
                    .webText(15, lineHeight: 22.5)
                    .foregroundStyle(AppTheme.textMuted)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 24)
                    .accessibilityIdentifier("new-chat-project-hint")
                Color.clear.frame(width: 0, height: 0)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .allowsHitTesting(false)
    }
}

/// Fills the room above the composer, which starts at the top of the page. The hint sits where
/// the web's `top: 50%; translateY(-60%)` puts it, a little above the page's middle; when that
/// would reach under the header or into the composer, it centres in the room below the header.
struct NewChatHintLayout: Layout {
    var pageHeight: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        proposal.replacingUnspecifiedDimensions()
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        guard let hint = subviews.first else { return }
        let room = ProposedViewSize(width: bounds.width, height: max(0, bounds.height - mobileHeaderHeight))
        let height = hint.sizeThatFits(room).height
        let midY = Self.midY(
            pageMiddle: bounds.minY + pageHeight / 2,
            top: bounds.minY + mobileHeaderHeight,
            bottom: bounds.maxY,
            hintHeight: height
        )
        hint.place(at: CGPoint(x: bounds.midX, y: midY), anchor: .center, proposal: room)
    }

    static func midY(pageMiddle: CGFloat, top: CGFloat, bottom: CGFloat, hintHeight: CGFloat) -> CGFloat {
        let webMidY = pageMiddle - hintHeight * 0.1
        if webMidY - hintHeight / 2 >= top, webMidY + hintHeight / 2 <= bottom { return webMidY }
        return (top + bottom) / 2
    }
}


