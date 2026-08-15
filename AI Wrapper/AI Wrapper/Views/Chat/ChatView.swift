import SwiftUI

/// Mirrors LandingPage (mobile): ConversationHeader bar + center section with
/// the InstructionWidget, conversation blocks, and the inline draft editor.
struct ChatView: View {
    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var ai: AIStore
    @EnvironmentObject var conversation: ConversationStore
    @EnvironmentObject var toasts: ToastCenter

    @State private var showShare = false

    private var resolvedBlocks: [ConversationBlock] {
        conversation.blocks.filter { $0.status == .resolved || $0.isLoading }
    }

    var body: some View {
        VStack(spacing: 0) {
            ConversationHeaderBar(showShare: $showShare)

            if resolvedBlocks.isEmpty {
                // New chat: the editor fills the viewport below the
                // instruction widget (web: calc(100vh - navbar - 10rem)).
                VStack(alignment: .leading, spacing: 14) {
                    InstructionWidgetView()
                    DraftEditorView(expand: true)
                }
                .padding()
            } else {
                ScrollViewReader { proxy in
                    ScrollView {
                        VStack(alignment: .leading, spacing: 0) {
                            InstructionWidgetView()
                                .padding(.horizontal)
                                .padding(.vertical, 10)

                            // Blocks are full-bleed bands like the web
                            ForEach(resolvedBlocks) { block in
                                ConversationBlockView(
                                    block: block,
                                    isLastResponseBlock: block.conversationBlockId == resolvedBlocks.last?.conversationBlockId
                                )
                                .id(block.conversationBlockId)
                            }

                            if !conversation.blocks.contains(where: { $0.isLoading }) {
                                DraftEditorView(expand: false)
                                    .padding()
                            }
                        }
                    }
                    .onChange(of: lastMessageText) { _, _ in
                        if let last = resolvedBlocks.last, last.isLoading {
                            withAnimation { proxy.scrollTo(last.conversationBlockId, anchor: .bottom) }
                        }
                    }
                }
            }
        }
        .background(AppTheme.background)
        .sheet(isPresented: $showShare) {
            ShareSheetView(target: .conversation(conversation.conversationId))
        }
        .task {
            if auth.isAuthenticated, ai.modelsByVendor.isEmpty, let token = try? await auth.getAccessTokenSilently() {
                await ai.fetchModels(token: token, vendors: AIVendor.allCases)
            }
        }
    }

    private var lastMessageText: String {
        resolvedBlocks.last?.responseMessages.map(\.text).joined() ?? ""
    }
}

/// Mirrors ConversationHeader — #687077 bar, white title, Share pill.
struct ConversationHeaderBar: View {
    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var conversation: ConversationStore
    @Binding var showShare: Bool

    private var title: String {
        if conversation.conversationId.isEmpty { return "New Chat" }
        return conversation.conversationTitle ?? "Untitled conversation"
    }

    private var canShowShare: Bool {
        auth.canShare && (conversation.conversationId.isEmpty || conversation.conversationRole != .view)
    }

    var body: some View {
        HStack {
            Text(title)
                .font(.headline)
                .foregroundStyle(AppTheme.conversationHeaderText)
                .lineLimit(1)
            Spacer()
            if canShowShare {
                Button {
                    showShare = true
                } label: {
                    Text("Share")
                        .font(.subheadline.weight(.medium))
                        .padding(.horizontal, 14)
                        .padding(.vertical, 5)
                        .background(Color.white.opacity(conversation.conversationId.isEmpty ? 0.15 : 0.25))
                        .foregroundStyle(AppTheme.conversationHeaderText)
                        .clipShape(Capsule())
                }
                .disabled(conversation.conversationId.isEmpty)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .background(AppTheme.conversationHeaderBackground)
    }
}

/// Mirrors the collapsed center InstructionWidget — "Persona" select +
/// "[+] Create Instructions" CTA.
struct InstructionWidgetView: View {
    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var ai: AIStore
    @EnvironmentObject var router: AppRouter

    private var latestInstructions: [InstructionResponse] {
        var byId: [String: InstructionResponse] = [:]
        for instruction in auth.customerInstructions where (byId[instruction.id]?.version ?? -1) < instruction.version {
            byId[instruction.id] = instruction
        }
        return byId.values.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    private func displayName(_ instruction: InstructionResponse) -> String {
        if !instruction.name.isEmpty { return instruction.name }
        let text = instruction.instruction
        return text.isEmpty ? "Untitled Instruction" : String(text.prefix(40))
    }

    var body: some View {
        HStack(spacing: 8) {
            WebIcon(name: "user-role", size: 20, color: AppTheme.textMuted)
            Menu {
                Button("No persona") { ai.selectedInstructionId = nil }
                ForEach(latestInstructions) { instruction in
                    Button(displayName(instruction)) {
                        ai.selectedInstructionId = instruction.id
                    }
                }
                Divider()
                Button {
                    router.navigate(.instructionDetail(nil))
                } label: {
                    Label("Create Instructions", systemImage: "plus")
                }
            } label: {
                HStack {
                    Text(selectedLabel)
                        .font(.subheadline)
                        .foregroundStyle(selectedLabel == "Select a persona" ? AppTheme.textMuted : AppTheme.textPrimary)
                        .lineLimit(1)
                    Spacer()
                    Image(systemName: "chevron.down")
                        .font(.caption2)
                        .foregroundStyle(AppTheme.textMuted)
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(AppTheme.backgroundSecondary)
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(AppTheme.border, lineWidth: 1))
    }

    private var selectedLabel: String {
        guard let id = ai.selectedInstructionId,
              let instruction = auth.customerInstructions.first(where: { $0.id == id }) else {
            return "Select a persona"
        }
        return displayName(instruction)
    }
}

/// Mirrors the Request widget in draft mode — the full-height PromptEditor
/// with the Generate button centered BELOW the editor container.
struct DraftEditorView: View {
    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var ai: AIStore
    @EnvironmentObject var conversation: ConversationStore

    /// true = fill the remaining viewport (new chat); false = fixed height in scroll.
    var expand: Bool

    private var hasValidKeys: Bool {
        auth.aiVendorAPIKeyStatusList.contains { $0.isValid }
    }

    private var canGenerate: Bool {
        !conversation.editorPrompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && hasValidKeys && auth.isAuthenticated
    }

    var body: some View {
        VStack(spacing: 12) {
            // Editor card
            ZStack(alignment: .topLeading) {
                TextEditor(text: $conversation.editorPrompt)
                    .font(.body)
                    .scrollContentBackground(.hidden)
                    .padding(8)
                if conversation.editorPrompt.isEmpty {
                    Text("Type your prompt…")
                        .foregroundStyle(AppTheme.textMuted)
                        .padding(.top, 16)
                        .padding(.leading, 13)
                        .allowsHitTesting(false)
                }
            }
            .frame(maxWidth: .infinity)
            .frame(minHeight: expand ? nil : 320)
            .frame(maxHeight: expand ? .infinity : 320)
            .background(AppTheme.backgroundSecondary)
            .clipShape(RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(AppTheme.border, lineWidth: 1))

            // Generate button — centered, outside the editor container
            HStack {
                Spacer()
                MultiPurposeButton(label: "Generate", icon: "send-icon", disabled: !canGenerate) {
                    generate()
                }
                Spacer()
            }
        }
        .onChange(of: conversation.editorPrompt) { _, newValue in
            persistDraft(newValue)
        }
        .onAppear(perform: restoreDraft)
    }

    private var draftKey: String? {
        auth.customerId.map { "\($0)_prompt_editor_content_conv-default" }
    }

    private func persistDraft(_ text: String) {
        guard let draftKey else { return }
        if text.isEmpty {
            UserDefaults.standard.removeObject(forKey: draftKey)
        } else {
            UserDefaults.standard.set(text, forKey: draftKey)
        }
    }

    private func restoreDraft() {
        guard conversation.editorPrompt.isEmpty, let draftKey,
              let saved = UserDefaults.standard.string(forKey: draftKey) else { return }
        conversation.editorPrompt = saved
    }

    private func generate() {
        let prompt = conversation.editorPrompt
        let blockId: String
        if let draft = conversation.blocks.last(where: { $0.status == .draft && !$0.isLoading }) {
            blockId = draft.conversationBlockId
        } else {
            blockId = conversation.addNewBlock()
        }
        conversation.editorPrompt = ""
        persistDraft("")
        Task {
            await conversation.generateResponsesStream(blockId: blockId, overridePrompt: prompt)
        }
    }
}

// MARK: - Message card (web TextContainer / message-card-base)

extension View {
    /// Web TextContainer article: page-background card, borderLight, radius 8.
    func messageCard(selected: Bool = false) -> some View {
        self
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(selected ? AppTheme.backgroundSelected : AppTheme.background)
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(AppTheme.borderLight, lineWidth: 1))
    }
}

/// Web TextContainer header: title centered, trailing accessory absolute right.
struct MessageCardHeader<Title: View, Accessory: View>: View {
    @ViewBuilder var title: Title
    @ViewBuilder var accessory: Accessory

    var body: some View {
        ZStack {
            HStack { Spacer(); title; Spacer() }
            HStack { Spacer(); accessory }
        }
    }
}

// MARK: - Conversation block (web ConversationBlock: Request → Thinking → Response)

struct ConversationBlockView: View {
    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var conversation: ConversationStore
    var block: ConversationBlock
    var isLastResponseBlock: Bool

    /// Web: messages with text or still loading are visible.
    private var visibleMessages: [Message] {
        block.responseMessages.filter { !$0.text.isEmpty || $0.isLoading }
    }

    /// Ordered unique vendors among visible messages.
    private var availableVendors: [AIVendor] {
        var seen = Set<AIVendor>()
        return visibleMessages.compactMap { message in
            seen.insert(message.aiVendor).inserted ? message.aiVendor : nil
        }
    }

    /// Mobile maxVendors = 1: exactly one vendor's column is shown.
    private var selectedVendor: AIVendor? {
        let selection = conversation.getVendorSelection(for: block.conversationBlockId)
        if let chosen = selection.compactMap(AIVendor.init(rawValue:)).first(where: { availableVendors.contains($0) }) {
            return chosen
        }
        return availableVendors.first
    }

    /// Latest visible message per selected vendor (web keeps the latest).
    private var filteredMessages: [Message] {
        guard let selectedVendor else { return [] }
        var latest: Message?
        for message in visibleMessages where message.aiVendor == selectedVendor {
            latest = message
        }
        return latest.map { [$0] } ?? []
    }

    private var thinkingMessages: [Message] {
        filteredMessages.filter { !$0.thinkingSteps.isEmpty || ($0.isLoading && $0.text.trimmingCharacters(in: .whitespaces).isEmpty) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Request band (page background)
            VStack(spacing: 12) {
                RequestCardView(block: block)
                if block.isLoading {
                    MultiPurposeButton(label: "Stop Generating") {
                        conversation.stopGenerating(blockId: block.conversationBlockId)
                    }
                }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 12)
            .frame(maxWidth: .infinity)
            .background(AppTheme.background)

            if visibleMessages.isEmpty {
                if !block.isLoading {
                    Text("No responses were generated")
                        .italic()
                        .foregroundStyle(AppTheme.textMuted)
                        .padding()
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            } else {
                // Thinking + Response band (response container background)
                VStack(spacing: 8) {
                    if availableVendors.count > 1 {
                        VendorToggleGroup(
                            vendors: availableVendors,
                            selected: selectedVendor,
                            onSelect: { vendor in
                                conversation.setVendorSelection(for: block.conversationBlockId, vendors: [vendor.rawValue])
                            }
                        )
                        .padding(.top, 12)
                    }

                    ForEach(thinkingMessages) { message in
                        ThinkingCardView(message: message)
                    }

                    ForEach(filteredMessages) { message in
                        ResponseCardView(
                            block: block,
                            message: message,
                            isLastResponseBlock: isLastResponseBlock
                        )
                    }
                }
                .padding(.horizontal, 8)
                .padding(.vertical, 12)
                .frame(maxWidth: .infinity)
                .background(AppTheme.responseContainerBackground)
            }
        }
        .onChange(of: availableVendors) { _, newVendors in
            // Web: auto-select vendors that appear for the first time
            let selection = conversation.getVendorSelection(for: block.conversationBlockId)
            let newOnes = newVendors.map(\.rawValue).filter { !selection.contains($0) }
            if !newOnes.isEmpty {
                conversation.setVendorSelection(for: block.conversationBlockId, vendors: selection + newOnes)
            }
        }
    }
}

/// Web Request resolved mode — TextContainer with centered UserBrandName title.
struct RequestCardView: View {
    @EnvironmentObject var auth: AuthStore
    var block: ConversationBlock

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            MessageCardHeader {
                HStack(spacing: 6) {
                    if let picture = auth.customerPicture, let url = URL(string: picture) {
                        AsyncImage(url: url) { image in
                            image.resizable()
                        } placeholder: {
                            WebIcon(name: "user-circle", size: 24)
                        }
                        .frame(width: 24, height: 24)
                        .clipShape(Circle())
                    } else {
                        WebIcon(name: "user-circle", size: 24)
                    }
                    Text(auth.customerName?.isEmpty == false ? auth.customerName! : "You")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(AppTheme.textPrimary)
                }
            } accessory: {
                CopyButton(text: block.prompt)
            }
            .padding(.bottom, 14)

            MarkdownView(text: block.prompt)
        }
        .messageCard()
    }
}

/// Web ResponseThinking card — brand header + "Thinking ▼" toggle with pulse,
/// bulleted steps, auto-collapses when the vendor stops thinking.
struct ThinkingCardView: View {
    var message: Message
    @State private var isExpanded = true

    private var isThinkingPhase: Bool {
        message.isLoading && message.text.trimmingCharacters(in: .whitespaces).isEmpty
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            MessageCardHeader {
                BrandNameView(vendor: message.aiVendor)
            } accessory: {
                Button {
                    withAnimation(.easeOut(duration: 0.15)) { isExpanded.toggle() }
                } label: {
                    HStack(spacing: 5) {
                        if isThinkingPhase {
                            Circle()
                                .fill(AppTheme.primary)
                                .frame(width: 7, height: 7)
                        }
                        Text("Thinking")
                        Text(isExpanded ? "▼" : "▶")
                            .font(.system(size: 9))
                    }
                    .font(.caption)
                    .foregroundStyle(AppTheme.textMuted)
                }
            }

            if isExpanded {
                Group {
                    if message.thinkingSteps.isEmpty {
                        HStack(spacing: 6) {
                            WebIcon(name: "think", size: 14, color: AppTheme.textMuted)
                            Text("Thinking...")
                                .font(.caption)
                                .foregroundStyle(AppTheme.textMuted)
                        }
                    } else {
                        VStack(alignment: .leading, spacing: 4) {
                            ForEach(Array(message.thinkingSteps.enumerated()), id: \.offset) { _, step in
                                HStack(alignment: .top, spacing: 6) {
                                    Text("•")
                                    Text(step)
                                }
                                .font(.callout)
                                .foregroundStyle(AppTheme.textPrimary)
                            }
                        }
                    }
                }
                .padding(.top, 14)
            }
        }
        .messageCard()
        .onAppear {
            // Web: collapses on mount when the vendor is no longer thinking
            if !isThinkingPhase { isExpanded = false }
        }
        .onChange(of: isThinkingPhase) { _, stillThinking in
            if !stillThinking { isExpanded = false }
        }
    }
}

/// Web Response card — centered brand header + copy, markdown, token badges,
/// centered Stop / Regenerate / Follow up action bar at the bottom.
struct ResponseCardView: View {
    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var conversation: ConversationStore
    var block: ConversationBlock
    var message: Message
    var isLastResponseBlock: Bool

    private var isSelected: Bool {
        conversation.getSelectedResponse(for: block.conversationBlockId) == message.messageId
    }

    private var hasValidKeys: Bool {
        auth.aiVendorAPIKeyStatusList.contains { $0.isValid }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            MessageCardHeader {
                BrandNameView(vendor: message.aiVendor)
            } accessory: {
                if !message.text.isEmpty {
                    CopyButton(text: message.text)
                }
            }
            .padding(.bottom, 14)

            if !message.text.isEmpty {
                MarkdownView(text: message.text)
            } else if message.isLoading {
                HStack { Spacer(); ProgressView(); Spacer() }
                    .padding(.vertical, 12)
            }

            // Token badges
            if !message.isLoading,
               message.inputTokens != nil || message.outputTokens != nil || message.totalTokens != nil || message.tokensReadFromCache != nil {
                TokenBadges(message: message)
                    .padding(.top, 12)
            }

            // Action bar: centered blue buttons on the card's bottom edge
            if message.isLoading || isLastResponseBlock {
                HStack(spacing: 8) {
                    Spacer()
                    if message.isLoading {
                        MultiPurposeButton(label: "Stop") {
                            conversation.stopGenerating(blockId: block.conversationBlockId, vendor: message.aiVendor)
                        }
                    } else {
                        MultiPurposeButton(label: "Regenerate", icon: "refresh-icon", disabled: !hasValidKeys) {
                            Task {
                                await conversation.generateResponsesStream(
                                    blockId: block.conversationBlockId,
                                    vendorToRegenerate: message.aiVendor
                                )
                            }
                        }
                        if !message.text.trimmingCharacters(in: .whitespaces).isEmpty {
                            MultiPurposeButton(
                                label: isSelected ? "Selected" : "Follow up",
                                icon: isSelected ? nil : "send-icon",
                                disabled: isSelected || !hasValidKeys
                            ) {
                                followUp()
                            }
                        }
                    }
                    Spacer()
                }
                .padding(.top, 14)
            }
        }
        .messageCard(selected: isSelected)
    }

    /// Web handleFollowUp: select this response as the parent for the draft.
    private func followUp() {
        conversation.setSelectedResponse(for: block.conversationBlockId, responseId: message.messageId)
        let draftId: String
        if let draft = conversation.blocks.last(where: { $0.status == .draft && !$0.isLoading }) {
            draftId = draft.conversationBlockId
        } else {
            draftId = conversation.addNewBlock()
        }
        conversation.setSelectedResponse(for: draftId, responseId: message.messageId)
    }
}

/// Web RadioButtonGroup — joined segmented pills with vendor icon + label.
struct VendorToggleGroup: View {
    var vendors: [AIVendor]
    var selected: AIVendor?
    var onSelect: (AIVendor) -> Void

    var body: some View {
        HStack(spacing: 0) {
            ForEach(Array(vendors.enumerated()), id: \.element) { index, vendor in
                let isActive = vendor == selected
                Button {
                    onSelect(vendor)
                } label: {
                    HStack(spacing: 5) {
                        CollapsedBrandIcon(vendor: vendor, size: 18)
                        Text(vendor.displayName)
                            .font(.subheadline)
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 8)
                    .background(isActive ? AppTheme.primary : Color.clear)
                    .foregroundStyle(isActive ? .white : AppTheme.textPrimary)
                }
                .clipShape(segmentShape(index: index))
                .overlay(
                    segmentShape(index: index)
                        .stroke(AppTheme.border, lineWidth: 1)
                )
            }
        }
    }

    private func segmentShape(index: Int) -> UnevenRoundedRectangle {
        let radius: CGFloat = 100
        return UnevenRoundedRectangle(
            topLeadingRadius: index == 0 ? radius : 0,
            bottomLeadingRadius: index == 0 ? radius : 0,
            bottomTrailingRadius: index == vendors.count - 1 ? radius : 0,
            topTrailingRadius: index == vendors.count - 1 ? radius : 0
        )
    }
}

struct CopyButton: View {
    var text: String
    @State private var copied = false

    var body: some View {
        Button {
            UIPasteboard.general.string = text
            copied = true
            Task {
                try? await Task.sleep(nanoseconds: 1_500_000_000)
                copied = false
            }
        } label: {
            if copied {
                WebIcon(name: "valid", size: 16, color: AppTheme.success)
            } else {
                WebIcon(name: "copy-icon", size: 16, color: AppTheme.textMuted)
            }
        }
    }
}
