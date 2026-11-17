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
    @ObservedObject private var catalog = ProviderCatalog.shared
    @State private var scrollViewHeight: CGFloat = 0
    /// Docked "Ask" pill (`.selectionAskDocked`): the selection and where it came from.
    @State private var askSelection: AskSelection?
    /// Blocks whose response already took the initial jump (ConversationBlock.hasScrolledRef).
    @State private var scrolledBlocks: Set<String> = []
    /// The sticky-bottom follow: pauses on touch, resumes when back near the bottom.
    @State private var followPaused = false
    @State private var followArmed = false
    /// The conversation is taller than the screen, so its end can reach the home indicator.
    @State private var contentFillsViewport = false
    /// From the top of the page to the keyboard, or to the bottom edge while it is closed.
    @State private var screenHeight: CGFloat = 0

    private var outlineItems: [OutlineItem] {
        ChatOutline.items(blocks: conversation.blocks, vendorName: catalog.displayName(for:))
    }

    /// Changes whenever the last block finishes or a conversation loads.
    private var trailingDraftKey: String {
        guard let last = conversation.blocks.last else { return "" }
        return "\(last.conversationBlockId)|\(last.status.rawValue)|\(last.isLoading)|\(conversation.conversationRole.rawValue)"
    }

    private var isFreshChat: Bool {
        conversation.blocks.count == 1 && conversation.blocks[0].status == .draft && conversation.blocks[0].responseMessages.isEmpty && !conversation.blocks[0].isLoading
    }


    var body: some View {
        ZStack(alignment: .top) {
            if isFreshChat {
                VStack(spacing: 0) {
                    Spacer(minLength: 0)
                    ComposerView(blockId: conversation.blocks[0].conversationBlockId, isLastBlock: true)
                }
            } else {
                conversationScroll
            }

            if let projectName = conversation.pendingProjectName(in: history.projects),
               !conversation.blocks.contains(where: { $0.status == .resolved || $0.isLoading }) {
                NewChatProjectHint(name: projectName)
            }

            ChatHeader(
                showShare: $showShare,
                showPicker: $showPicker,
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
                        .padding(.bottom, 88)
                }
            }
        }
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { screenHeight = $0 }
        .environment(\.chatScreenHeight, screenHeight)
        .statusBarBand()
        .background(AppTheme.background)
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
                        })
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
            .background(alignment: .bottom) { homeIndicatorBand }
            .onScrollGeometryChange(for: Bool.self) { geometry in
                geometry.contentSize.height + geometry.contentInsets.top + geometry.contentInsets.bottom >= geometry.containerSize.height
            } action: { _, fills in
                contentFillsViewport = fills
            }
            #if DEBUG
            .modifier(DebugConversationScroll())
            #endif
            // A drag gesture here would take every swipe that starts on a message, the one from the
            // left edge that opens the menus included.
            .onScrollPhaseChange { _, phase in
                if phase == .interacting { followPaused = true }
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
            .onScrollGeometryChange(for: Bool.self) { geometry in
                geometry.contentSize.height - geometry.contentOffset.y - geometry.containerSize.height < 50
            } action: { _, nearBottom in
                if nearBottom { followPaused = false }
            }
            .onChange(of: conversation.focusDraftRequest) { _, _ in
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                    withAnimation(.easeOut(duration: 0.3)) { proxy.scrollTo("conversation-end", anchor: .bottom) }
                }
            }
            .onChange(of: conversation.revealDraftRequest) { _, _ in
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                    withAnimation(.easeOut(duration: 0.25)) { proxy.scrollTo("conversation-end", anchor: .bottom) }
                }
            }
            // A response appearing for the first time jumps to its start: animated as it generates,
            // straight there when a conversation opens.
            .onChange(of: conversation.blocks.filter { !$0.responseMessages.isEmpty }.map(\.conversationBlockId), initial: true) { _, ids in
                let fresh = ids.filter { !scrolledBlocks.contains($0) }
                guard let target = fresh.last else { return }
                scrolledBlocks.formUnion(fresh)
                let isGenerating = conversation.blocks.last?.isLoading == true
                let anchor = ConversationBlockView.responseAnchor(target)
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                    if isGenerating {
                        withAnimation(.easeOut(duration: 0.3)) { proxy.scrollTo(anchor, anchor: .top) }
                    } else {
                        proxy.scrollTo(anchor, anchor: .top)
                    }
                }
            }
            // Armed shortly after generation starts: a regenerate's collapse to the short
            // "thinking" placeholder must not snap the viewport up to its end.
            // `initial`: this scroll view can first appear with the block already generating.
            .onChange(of: conversation.blocks.last?.isLoading == true, initial: true) { _, loading in
                followArmed = false
                guard loading else { return }
                followPaused = false
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { followArmed = true }
            }
            .onChange(of: conversation.blocks.last?.responseMessages.map(\.text.count)) { _, _ in
                guard followArmed, !followPaused, conversation.blocks.last?.isLoading == true,
                      let id = conversation.blocks.last?.conversationBlockId else { return }
                proxy.scrollTo(ConversationBlockView.responseEndAnchor(id), anchor: .bottom)
            }
        }
    }

    static let contentSpace = "chat-content"
    static func turnAnchor(_ blockId: String) -> String { "turn-\(blockId)" }

    /// Touch selection: the pill docks above the response action bar because the OS
    /// selection callout draws over the page wherever the selection sits.
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

struct AskSelection {
    let text: String
    let blockId: String
    let message: Message
}

/// ConversationHeader below isNarrow: title (tappable → Outline), loaded instruction
/// (tappable → picker) and the New Chat / Share / AI Settings kebab; the hamburger opens the
/// Chats and Projects menu.
struct ChatHeader: View {
    @EnvironmentObject var router: AppRouter
    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var ai: AIStore
    @EnvironmentObject var conversation: ConversationStore
    @EnvironmentObject var history: HistoryStore
    @Binding var showShare: Bool
    @Binding var showPicker: Bool
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

    /// Latest version of the instruction loaded into this conversation.
    private var loadedInstruction: InstructionResponse? {
        guard let id = ai.selectedInstructionId else { return nil }
        return auth.customerInstructions.filter { $0.id == id }.max { $0.version < $1.version }
    }

    private var menuItems: [MobileHeaderMenuItem] {
        var items = [MobileHeaderMenuItem(label: L("conversation.conversationHeader.newChat")) { conversation.resetConversation() }]
        if showShareItem {
            items.append(MobileHeaderMenuItem(label: L("conversation.conversationHeader.share")) { showShare = true })
        }
        items.append(MobileHeaderMenuItem(label: L("layout.mobileFullPageModal.aiSettings")) { router.isRightSidebarOpen = true })
        return items + moderation.menuItems
    }

    @ViewBuilder
    private var instructionLabel: some View {
        if let instruction = loadedInstruction {
            if let icon = instruction.icon, !icon.isEmpty {
                EmojiIcon(text: icon, size: 12, advance: 15, lineHeight: 20)
            }
            Text(instruction.name)
        } else {
            Text(L("conversation.conversationHeader.chooseInstruction"))
        }
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
            MobileHeader(
                title: displayTitle,
                menuItems: menuItems,
                onSubtitleClick: { showPicker = true },
                onTitleClick: onOpenOutline,
                titleActionLabel: L("conversation.outline.openFor", ["title": displayTitle]),
                titleExpanded: isOutlineOpen,
                onMenuClick: { router.isMobileMenuOpen = true }
            ) {
                if let projectName = conversation.pendingProjectName(in: history.projects) {
                    ProjectSubtitleLayout {
                        HStack(spacing: 4) {
                            WebIcon(name: "folder", size: 12, color: AppTheme.textMuted)
                            Text(L("conversation.conversationHeader.inProject", ["name": projectName]))
                        }
                        .accessibilityElement(children: .combine)
                        .accessibilityIdentifier("mobile-header-project")
                        Text("·").accessibilityHidden(true)
                        HStack(spacing: 4.8) { instructionLabel }
                    }
                } else {
                    instructionLabel
                }
            }
        }
        .task(id: sharedItem) { await moderation.load(item: sharedItem, auth: auth) }
        .sharedItemModerationDialogs(moderation) { conversation.resetConversation() }
    }
}

// MARK: - Conversation block (Request → Response)

struct ConversationBlockView: View {
    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var conversation: ConversationStore
    let block: ConversationBlock
    let onSelectionChange: (AskSelection?) -> Void

    static func responseAnchor(_ blockId: String) -> String { "response-start-\(blockId)" }
    static func responseEndAnchor(_ blockId: String) -> String { "response-end-\(blockId)" }

    var body: some View {
        VStack(spacing: 0) {
            if block.status == .resolved || block.isLoading {
                ResolvedRequestView(block: block)
            } else {
                ComposerView(
                    blockId: block.conversationBlockId,
                    isLastBlock: conversation.blocks.last?.conversationBlockId == block.conversationBlockId
                )
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
                Color.clear.frame(height: 0).id(Self.responseEndAnchor(block.conversationBlockId))
            }

            RunHitlBanner(block: block)
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

            MarkdownView(text: block.prompt, options: .init(capitalizeFirstLetter: true, tightFirstHeading: false, turnTextSize: 17))

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
        .padding(.horizontal, 8)
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
/// plus, on the empty page a little above its middle.
struct NewChatProjectHint: View {
    let name: String

    var body: some View {
        Text(L("conversation.conversationHeader.newChatInProjectHint", ["name": name]))
            .webText(15, lineHeight: 22.5)
            .foregroundStyle(AppTheme.textMuted)
            .multilineTextAlignment(.center)
            .padding(.horizontal, 24)
            .visualEffect { content, proxy in
                content.offset(y: -proxy.size.height * 0.1)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .allowsHitTesting(false)
            .accessibilityIdentifier("new-chat-project-hint")
    }
}

/// The header's subtitle while a new chat waits to start in a project: "in Startup", a dot, then
/// the instruction. The instruction gives way first; the project keeps at most 60% of the line
/// and at least 40pt, as the web's `.projectContext` does.
struct ProjectSubtitleLayout: Layout {
    var spacing: CGFloat = 4.8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let widths = Self.widths(available: proposal.width, ideal: subviews.map { $0.sizeThatFits(.unspecified).width }, spacing: spacing)
        let height = zip(subviews, widths).map { $0.sizeThatFits(ProposedViewSize(width: $1, height: proposal.height)).height }.max() ?? 0
        return CGSize(width: widths.reduce(0, +) + spacing * CGFloat(max(0, subviews.count - 1)), height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let widths = Self.widths(available: bounds.width, ideal: subviews.map { $0.sizeThatFits(.unspecified).width }, spacing: spacing)
        var x = bounds.minX
        for (subview, width) in zip(subviews, widths) {
            subview.place(at: CGPoint(x: x, y: bounds.midY), anchor: .leading, proposal: ProposedViewSize(width: width, height: bounds.height))
            x += width + spacing
        }
    }

    /// Widths for [project, separator, instruction] within `available`.
    static func widths(available: CGFloat?, ideal: [CGFloat], spacing: CGFloat) -> [CGFloat] {
        guard let available, ideal.count == 3 else { return ideal }
        let room = max(0, available - ideal[1] - spacing * 2)
        guard ideal[0] + ideal[2] > room else { return ideal }
        let project = min(ideal[0], max(40, room * 0.6), room)
        return [project, ideal[1], max(0, min(ideal[2], room - project))]
    }
}

