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

            ChatHeader(showShare: $showShare, showPicker: $showPicker)

            if let selection = askSelection {
                VStack {
                    Spacer()
                    askPill(selection)
                        .padding(.bottom, 88)
                }
            }
        }
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
        .task(id: auth.customerId) { await loadSharedQueries() }
        .onChange(of: conversation.conversationId) { _, _ in askSelection = nil }
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
                        ConversationBlockView(block: block, onSelectionChange: { selection in
                            askSelection = selection
                        })
                        .id(block.conversationBlockId)
                    }
                    Color.clear.frame(height: 0).id("conversation-end")
                }
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

struct AskSelection {
    let text: String
    let blockId: String
    let message: Message
}

/// ConversationHeader below isNarrow: title, loaded instruction (tappable → picker) and
/// the New Chat / Share / AI Config kebab; the hamburger opens the history menu.
struct ChatHeader: View {
    @EnvironmentObject var router: AppRouter
    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var ai: AIStore
    @EnvironmentObject var conversation: ConversationStore
    @Binding var showShare: Bool
    @Binding var showPicker: Bool

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
        items.append(MobileHeaderMenuItem(label: L("conversation.conversationHeader.aiConfig")) { router.isRightSidebarOpen = true })
        return items
    }

    var body: some View {
        MobileHeader(
            title: displayTitle,
            menuItems: menuItems,
            onSubtitleClick: { showPicker = true },
            onMenuClick: { router.isMobileMenuOpen = true }
        ) {
            if let instruction = loadedInstruction {
                if let icon = instruction.icon, !icon.isEmpty {
                    EmojiIcon(text: icon, size: 12, advance: 15, lineHeight: 20)
                }
                Text(instruction.name)
            } else {
                Text(L("conversation.conversationHeader.chooseInstruction"))
            }
        }
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

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ZStack(alignment: .trailing) {
                UserBrandName(name: displayName, picture: displayPicture)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.trailing, 50)
                CopyToClipboardButton(content: block.prompt, accessibilityLabel: L("common.textContainer.copyResponse"))
            }
            .frame(height: 27.2)
            .padding(.bottom, 20)

            MarkdownView(text: block.prompt, options: .init(capitalizeFirstLetter: true, tightFirstHeading: false))

            if !block.attachments.isEmpty {
                ResolvedAttachmentThumbnails(attachments: block.attachments)
            }

            if let sentAt = block.sentAt {
                Text(ServerDate.dateTime(sentAt))
                    .webText(11.2, lineHeight: 19.04)
                    .foregroundStyle(AppTheme.textMuted)
                    .frame(maxWidth: .infinity, alignment: .trailing)
                    .padding(.top, 8)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .background(AppTheme.background)
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .padding(8)
        .frame(maxWidth: .infinity)
        .background(AppTheme.background)
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
