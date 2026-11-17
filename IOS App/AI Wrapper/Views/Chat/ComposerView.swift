import SwiftUI
import PhotosUI
import UniformTypeIdentifiers

/// A file being attached in the composer; uploads to S3 in the background.
struct PendingAttachment: Identifiable {
    let id = UUID()
    let fileName: String
    let mediaType: String
    var preview: UIImage?
    var isUploading = true
    var ref: AttachmentRef?

    var isPDF: Bool { mediaType == AttachmentRef.pdfMediaType }
}

/// The web's docked prompt editor (Request.tsx below isNarrow): a small box glued to the
/// bottom — `clamp(12rem, 32svh, 16rem)` of text plus a 64pt strip for the floating
/// attach/generate buttons — holding a CodeMirror markdown editor. A follow-up editor nobody
/// is using rests at two lines (`.idleFollowUp`).
struct ComposerView: View {
    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var conversation: ConversationStore
    @EnvironmentObject var toasts: ToastCenter
    @Environment(\.windowHeight) private var windowHeight
    @Environment(\.chatScreenHeight) private var chatScreenHeight

    let blockId: String
    /// Selection-asks always land in the trailing draft block.
    let isLastBlock: Bool

    @State private var draft = ""
    @State private var didRestore = false
    @State private var focusRequest = 0
    @State private var focusEndRequest = 0
    @State private var isFocused = false
    @State private var pending: [PendingAttachment] = []
    @State private var photoItems: [PhotosPickerItem] = []
    @State private var showPhotoPicker = false
    @State private var showFilePicker = false
    @State private var showCamera = false
    @State private var saveTask: Task<Void, Never>?
    /// The text's own height, which grows the editor.
    @State private var textHeight: CGFloat = 0

    private var hasAnyValidApiKey: Bool { auth.aiVendorAPIKeyStatusList.contains { $0.isAPIKeyValid == true } }

    /// `--editor-height` without the strip.
    static func textAreaHeight(windowHeight: CGFloat) -> CGFloat {
        min(max(192, windowHeight * 0.32), 256)
    }

    /// `.idleFollowUp`'s 3.75rem of text above the strip.
    static let idleTextAreaHeight: CGFloat = 60

    /// Every block after the first is a follow-up; the first is a new chat's editor.
    private var isFollowUp: Bool { conversation.blocks.first?.conversationBlockId != blockId }

    private var isIdle: Bool { isFollowUp && !isFocused && draft.isEmpty && pending.isEmpty }

    private var totalHeight: CGFloat {
        if isIdle { return Self.idleTextAreaHeight + Self.buttonStripHeight }
        // `--editor-max-height`: from where it rests up to just under the header
        let tallest = chatScreenHeight - mobileHeaderHeight - 8 - (pending.isEmpty ? 0 : Self.stripHeight)
        return Self.grownHeight(
            textHeight: textHeight,
            resting: Self.textAreaHeight(windowHeight: windowHeight) + Self.buttonStripHeight,
            tallest: tallest
        )
    }

    /// `.cm-editor`'s min-height and max-height: its text grows the editor from its resting height
    /// to the tallest it may be, and scrolls after that. A resting height above that limit still wins.
    static func grownHeight(textHeight: CGFloat, resting: CGFloat, tallest: CGFloat) -> CGFloat {
        max(resting, min(textHeight + textFrame, tallest))
    }

    /// Between the editor's edge and its text: the padding above and below the box, and the button strip.
    private static let textFrame: CGFloat = 16 + 8 + buttonStripHeight

    /// The strip of floating buttons below the text, which a completion popup can hang into.
    private static let buttonStripHeight: CGFloat = 64

    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            VStack(spacing: 0) {
                editor
                    .padding(.horizontal, 8)
                    .padding(.top, 16)
                    .padding(.bottom, 8)
                if !pending.isEmpty { previewStrip }
            }

            HStack(spacing: 8) {
                attachButton
                sendButton
            }
            .padding(.trailing, 20)
            .padding(.bottom, 20 + (pending.isEmpty ? 0 : Self.stripHeight))
        }
        .frame(height: totalHeight + (pending.isEmpty ? 0 : Self.stripHeight))
        .background(AppTheme.background)
        .onAppear(perform: restoreDraft)
        .onChange(of: conversation.focusDraftRequest) { _, _ in takeDraftFocus() }
        .onChange(of: isFocused) { _, focused in
            guard isFollowUp else { return }
            conversation.isEditingFollowUp = focused
            if focused { conversation.revealDraftRequest += 1 }
        }
        .onDisappear {
            if isFocused, isFollowUp { conversation.isEditingFollowUp = false }
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardDidShowNotification)) { _ in
            if isFocused, isFollowUp { conversation.revealDraftRequest += 1 }
        }
        .onChange(of: conversation.pendingAsks) { _, asks in absorbAsks(asks) }
        .onChange(of: photoItems) { _, items in handlePhotos(items) }
        .photosPicker(isPresented: $showPhotoPicker, selection: $photoItems, matching: .images)
        .fullScreenCover(isPresented: $showCamera) {
            CameraPicker(onCapture: handleCapturedPhoto).ignoresSafeArea()
        }
        .fileImporter(isPresented: $showFilePicker, allowedContentTypes: [.image, .pdf], allowsMultipleSelection: true) { result in
            if case .success(let urls) = result { handleFiles(urls) }
        }
    }

    private var editor: some View {
        // `.cm-scroller` ends above the button strip so no line sits under the buttons.
        ComposerTextView(
            text: $draft,
            isFocused: $isFocused,
            focusRequest: focusRequest,
            focusEndRequest: focusEndRequest,
            editorInsets: UIEdgeInsets(top: 1, left: 1, bottom: 1 - Self.buttonStripHeight, right: 1),
            showsActiveLine: false,
            onChange: handleChange,
            onPasteImages: handlePastedImages,
            onContentHeightChange: { textHeight = $0 }
        )
        .overlay(alignment: .topLeading) {
            if draft.isEmpty {
                // CodeMirror's placeholder: where the first line's text would start
                Text(L(isFollowUp ? "conversation.request.placeholderFollowUp" : "conversation.request.placeholderNewChat"))
                    .webText(mono: ComposerStyle.size, lineHeight: 33.6)
                    .foregroundStyle(AppTheme.textMuted)
                    .padding(.leading, 6)
                    .padding(.top, 4)
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
            }
        }
        .padding(.bottom, Self.buttonStripHeight)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(AppTheme.composerEditorBackground)
        .clipShape(RoundedRectangle(cornerRadius: DSRadius.md))
        .overlay(
            RoundedRectangle(cornerRadius: DSRadius.md)
                .strokeBorder(isFocused ? Color(hex: "#2563EB") : AppTheme.legacyBorder, lineWidth: 1)
        )
    }

    private var attachButton: some View {
        WebIcon(name: "attachment", size: 22, color: AppTheme.textPrimary)
            .frame(width: 44, height: 44)
            .background(AppTheme.composerAttachButton)
            .clipShape(Circle())
            .overlay(Circle().strokeBorder(AppTheme.border, lineWidth: 1))
            .shadow(color: .black.opacity(0.25), radius: 4, y: 2)
            .overlay {
                AttachMenuButton(
                    onPhotoLibrary: { showPhotoPicker = true },
                    onTakePhoto: CameraPicker.isAvailable ? { showCamera = true } : nil,
                    onChooseFiles: { showFilePicker = true }
                )
            }
    }

    private var sendButton: some View {
        Button(action: generate) {
            WebIcon(name: "send-icon", size: 22, color: .white)
                .frame(width: 44, height: 44)
                .background(hasAnyValidApiKey ? AppTheme.buttonPrimary : AppTheme.disabled)
                .clipShape(Circle())
                .shadow(color: hasAnyValidApiKey ? .black.opacity(0.25) : .clear, radius: 4, y: 2)
                .opacity(hasAnyValidApiKey ? 1 : 0.5)
        }
        .buttonStyle(WebPressStyle())
        .disabled(!hasAnyValidApiKey)
        .accessibilityLabel(L("conversation.request.generate"))
    }

    // MARK: - Attachment strip (AttachmentPreview.module.scss)

    private static let stripHeight: CGFloat = 72

    private var previewStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(pending) { attachment in
                    if attachment.isPDF { docChip(attachment) } else { thumbnail(attachment) }
                }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 8)
        }
        .frame(height: Self.stripHeight)
    }

    private func thumbnail(_ attachment: PendingAttachment) -> some View {
        ZStack(alignment: .topTrailing) {
            Group {
                if let preview = attachment.preview {
                    Image(uiImage: preview).resizable().scaledToFill()
                } else {
                    WebIcon(name: "image-attachment-icon", size: 22, color: AppTheme.textSecondary)
                }
            }
            .frame(width: 56, height: 56)
            .opacity(attachment.isUploading ? 0.4 : 1)
            .overlay { if attachment.isUploading { ProgressView().controlSize(.small) } }
            removeButton(attachment)
        }
        .frame(width: 56, height: 56)
        .background(AppTheme.backgroundSecondary)
        .clipShape(RoundedRectangle(cornerRadius: DSRadius.md))
        .overlay(RoundedRectangle(cornerRadius: DSRadius.md).strokeBorder(AppTheme.border, lineWidth: 1))
    }

    private func docChip(_ attachment: PendingAttachment) -> some View {
        ZStack(alignment: .topTrailing) {
            HStack(spacing: 6.4) {
                WebIcon(name: "document", size: 20, color: AppTheme.textPrimary)
                WebTruncatedLine(attachment.fileName).webText(12.8).foregroundStyle(AppTheme.textPrimary)
                if attachment.isUploading { ProgressView().controlSize(.small) }
            }
            .padding(.leading, 9.6)
            .padding(.trailing, 24)
            .frame(maxWidth: 200, maxHeight: .infinity)
            removeButton(attachment)
        }
        .frame(height: 56)
        .background(AppTheme.backgroundSecondary)
        .clipShape(RoundedRectangle(cornerRadius: DSRadius.md))
        .overlay(RoundedRectangle(cornerRadius: DSRadius.md).strokeBorder(AppTheme.border, lineWidth: 1))
        .opacity(attachment.isUploading ? 0.6 : 1)
    }

    private func removeButton(_ attachment: PendingAttachment) -> some View {
        Button { pending.removeAll { $0.id == attachment.id } } label: {
            Text("×")
                .font(.system(size: 12))
                .foregroundStyle(.white)
                .frame(width: 18, height: 18)
                .background(.black.opacity(0.6))
                .clipShape(Circle())
        }
        .buttonStyle(.plain)
        .padding(2)
        .accessibilityLabel(L("conversation.request.removeAttachment"))
    }

    // MARK: - Draft

    private func restoreDraft() {
        guard !didRestore else { return }
        didRestore = true
        if draft.isEmpty, let saved = conversation.savedDraft(for: blockId) {
            draft = saved
            conversation.editorPrompt = saved
        }
        #if DEBUG
        if draft.isEmpty, !conversation.editorPrompt.isEmpty { draft = conversation.editorPrompt }
        #endif
        absorbAsks(conversation.pendingAsks)
        takeDraftFocus()
    }

    private func takeDraftFocus() {
        guard isLastBlock, conversation.handledFocusDraftRequest != conversation.focusDraftRequest else { return }
        conversation.handledFocusDraftRequest = conversation.focusDraftRequest
        focusRequest += 1
    }

    /// Debounced like the web (storage + token counter, 500ms).
    private func handleChange(_ text: String) {
        saveTask?.cancel()
        saveTask = Task {
            try? await Task.sleep(nanoseconds: 500_000_000)
            guard !Task.isCancelled else { return }
            conversation.persistDraft(text, for: blockId)
            conversation.editorPrompt = text
        }
    }

    /// Appends each queued ask to the end of the draft as a blockquote — AFTER whatever is
    /// typed, so ask → type → ask rounds keep their order.
    private func absorbAsks(_ asks: [String]) {
        guard isLastBlock, !asks.isEmpty else { return }
        let quotes = asks.joined(separator: "\n\n")
        var base = draft
        while base.last?.isWhitespace == true { base.removeLast() }
        draft = base.isEmpty ? "\(quotes)\n\n" : "\(base)\n\n\(quotes)\n\n"
        handleChange(draft)
        conversation.pendingAsks = []
        focusEndRequest += 1
    }

    private func generate() {
        guard hasAnyValidApiKey else { return }
        if pending.contains(where: \.isUploading) {
            toasts.showToast(L("conversation.request.attachmentsUploading"))
            return
        }
        let prompt = draft
        guard !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !pending.isEmpty else { return }
        let refs = pending.compactMap(\.ref)
        saveTask?.cancel()
        conversation.persistDraft("", for: blockId)
        conversation.editorPrompt = ""
        // The sent prompt took the quotes with it — the next draft starts a fresh session.
        conversation.resetAskSession()
        pending = []
        draft = ""
        Task {
            await conversation.generateResponsesStream(
                blockId: blockId,
                overridePrompt: prompt,
                selectedMessageId: conversation.getSelectedResponse(for: blockId),
                attachments: refs
            )
        }
    }

    // MARK: - Attachments

    private func handlePhotos(_ items: [PhotosPickerItem]) {
        guard !items.isEmpty else { return }
        let picked = items
        photoItems = []
        Task {
            var files: [PickedAttachment] = []
            for item in picked {
                guard let data = try? await item.loadTransferable(type: Data.self) else { continue }
                let type = item.supportedContentTypes.first
                let ext = type?.preferredFilenameExtension ?? "jpg"
                files.append(PickedAttachment(data: data, fileName: "image-\(UUID().uuidString.prefix(8)).\(ext)", mediaType: type?.preferredMIMEType ?? AttachmentRef.unknownMediaType))
            }
            addAttachments(files)
        }
    }

    private func handleFiles(_ urls: [URL]) {
        Task {
            var files: [PickedAttachment] = []
            for url in urls {
                guard let data = await Task.detached(operation: { Self.readPickedFile(url) }).value else {
                    toasts.showToast(L("conversation.request.attachmentUploadFailed"))
                    continue
                }
                let type = UTType(filenameExtension: url.pathExtension)
                files.append(PickedAttachment(data: data, fileName: url.lastPathComponent, mediaType: type?.preferredMIMEType ?? AttachmentRef.unknownMediaType))
            }
            addAttachments(files)
        }
    }

    /// Coordinated, because a file from iCloud Drive may still have to download.
    private nonisolated static func readPickedFile(_ url: URL) -> Data? {
        let access = url.startAccessingSecurityScopedResource()
        defer { if access { url.stopAccessingSecurityScopedResource() } }
        var data: Data?
        var error: NSError?
        NSFileCoordinator().coordinate(readingItemAt: url, options: [], error: &error) { data = try? Data(contentsOf: $0) }
        return data
    }

    private func handleCapturedPhoto(_ image: UIImage) {
        guard let data = image.jpegData(compressionQuality: 0.9) else { return }
        addAttachments([PickedAttachment(data: data, fileName: "image.jpg", mediaType: "image/jpeg")])
    }

    private func handlePastedImages(_ images: [UIImage]) {
        addAttachments(images.compactMap { image in
            image.pngData().map { PickedAttachment(data: $0, fileName: "pasted-image.png", mediaType: "image/png") }
        })
    }

    private func addAttachments(_ files: [PickedAttachment]) {
        let intake = AttachmentIntake(files, pendingCount: pending.count, pendingPDFs: pending.filter(\.isPDF).count)
        if !intake.rejectedNames.isEmpty {
            let formats = AttachmentFormat.supportedNames.joined(separator: ", ")
            toasts.showToast(
                intake.rejectedNames.count == 1
                    ? L("conversation.request.attachmentFormatUnsupported", ["name": intake.rejectedNames[0], "formats": formats])
                    : L("conversation.request.attachmentFormatsUnsupported", ["count": intake.rejectedNames.count, "names": intake.rejectedNames.joined(separator: ", "), "formats": formats]),
                duration: 8
            )
        }
        if intake.pdfTooLarge { toasts.showToast(L("conversation.request.attachmentPdfTooLarge")) }
        if intake.pdfLimitReached {
            toasts.showToast(L("conversation.request.attachmentPdfLimitReached", ["max": AttachmentRef.maxPDFsPerMessage]))
        }
        if intake.limitReached {
            toasts.showToast(L("conversation.request.attachmentLimitReached", ["max": AttachmentRef.maxPerMessage]))
        }
        intake.accepted.forEach(upload)
    }

    private func upload(_ file: PickedAttachment) {
        let (data, fileName, mediaType) = (file.data, file.fileName, file.mediaType)
        let entry = PendingAttachment(fileName: fileName, mediaType: mediaType, preview: file.isPDF ? nil : UIImage(data: data))
        pending.append(entry)
        Task {
            do {
                let token = try await auth.getAccessTokenSilently()
                let ref = try await AttachmentService.upload(token: token, data: data, fileName: fileName, mediaType: mediaType)
                if let index = pending.firstIndex(where: { $0.id == entry.id }) {
                    pending[index].isUploading = false
                    pending[index].ref = ref
                }
            } catch {
                toasts.showToast(L("conversation.request.attachmentUploadFailed"))
                pending.removeAll { $0.id == entry.id }
            }
        }
    }
}

// MARK: - Editor

/// CodeMirror look: monospace 24/33.6, GitHub theme colors, 6pt line padding, the active logical
/// line tinted. Coloring and typing behavior come from `ComposerEngine`, the web's own editor code.
struct ComposerTextView: UIViewRepresentable {
    @Binding var text: String
    @Binding var isFocused: Bool
    var focusRequest: Int
    var focusEndRequest: Int
    /// The Memory page's `seamless` editor: grows instead of scrolling internally.
    var growsWithContent = false
    /// Instructions a viewer can read but not change.
    var readOnly = false
    /// From this view's bounds to `.cm-editor`'s: the completion popup hides once its text leaves
    /// that box. Negative where the editor reaches past the text.
    var editorInsets = UIEdgeInsets.zero
    /// `.cm-editor`'s min-height, for a view that only spans its lines.
    var editorMinHeight: CGFloat = 0
    /// The current line's tint; the chat composer draws none, as it read as an empty toolbar.
    var showsActiveLine = true
    var onChange: (String) -> Void
    var onPasteImages: ([UIImage]) -> Void
    /// The text's height, for a host that sizes the editor by it.
    var onContentHeightChange: ((CGFloat) -> Void)? = nil

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> ComposerUITextView {
        let view = ComposerUITextView(usingTextLayoutManager: false)
        view.delegate = context.coordinator
        view.backgroundColor = .clear
        view.textContainerInset = UIEdgeInsets(top: 4, left: 6, bottom: 4, right: 2)
        view.textContainer.lineFragmentPadding = 0
        // Laid out lazily, a restyle measures only the lines around the edit for one pass, and an
        // editor sized by its text drops to that height and springs back.
        view.layoutManager.allowsNonContiguousLayout = onContentHeightChange == nil
        view.tintColor = AppTheme.UI.composerText
        view.autocorrectionType = .no
        view.smartQuotesType = .no
        view.smartDashesType = .no
        view.typingAttributes = ComposerStyle.base
        view.onPasteImages = onPasteImages
        view.onContentHeightChange = onContentHeightChange
        view.alwaysBounceVertical = false
        view.isScrollEnabled = !growsWithContent
        if growsWithContent { view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal) }
        view.accessibilityLabel = L("conversation.request.generate")
        return view
    }

    func updateUIView(_ view: ComposerUITextView, context: Context) {
        let coordinator = context.coordinator
        coordinator.parent = self
        view.isEditable = !readOnly
        view.onPasteImages = onPasteImages
        view.onContentHeightChange = onContentHeightChange
        view.editorInsets = editorInsets
        view.editorMinHeight = editorMinHeight
        view.showsActiveLine = showsActiveLine
        if view.text != text {
            view.text = text
            // A document loaded into an editor nobody is typing in has its caret at the start.
            if !view.isFirstResponder { view.selectedRange = NSRange(location: 0, length: 0) }
            view.resetStyle()
            view.requestHighlight()
            view.updateActiveLine()
        } else if coordinator.lastAppliedEmpty {
            coordinator.lastAppliedEmpty = false
            view.resetStyle()
            view.requestHighlight()
            view.updateActiveLine()
        }
        if coordinator.lastFocusRequest != focusRequest {
            coordinator.lastFocusRequest = focusRequest
            DispatchQueue.main.async { view.becomeFirstResponder() }
        }
        if coordinator.lastFocusEndRequest != focusEndRequest {
            coordinator.lastFocusEndRequest = focusEndRequest
            DispatchQueue.main.async {
                view.becomeFirstResponder()
                let end = view.endOfDocument
                view.selectedTextRange = view.textRange(from: end, to: end)
                view.scrollRangeToVisible(NSRange(location: view.textStorage.length, length: 0))
            }
        }
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView: ComposerUITextView, context: Context) -> CGSize? {
        guard growsWithContent, let width = proposal.width, width > 0, width.isFinite else { return nil }
        let size = uiView.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
        return CGSize(width: width, height: ceil(size.height))
    }

    final class Coordinator: NSObject, UITextViewDelegate {
        var parent: ComposerTextView
        var lastFocusRequest: Int
        var lastFocusEndRequest: Int
        var lastAppliedEmpty = true

        init(_ parent: ComposerTextView) {
            self.parent = parent
            lastFocusRequest = parent.focusRequest
            lastFocusEndRequest = parent.focusEndRequest
        }

        func textView(_ textView: UITextView, shouldChangeTextIn range: NSRange, replacementText text: String) -> Bool {
            guard let view = textView as? ComposerUITextView, !view.isApplyingEngineEdit, view.markedTextRange == nil else { return true }
            if text == "\n", view.acceptCompletion() { return false }
            view.pendingEdit = text.isEmpty ? .deletion : .typing
            guard let edit = ComposerEngine.shared.input(
                id: view.engineId,
                text: view.text,
                selection: view.selectedRange,
                range: range,
                insert: text
            ) else { return true }
            view.apply(edit)
            return false
        }

        func textViewDidChange(_ textView: UITextView) {
            guard let view = textView as? ComposerUITextView else { return }
            view.typingAttributes = ComposerStyle.base
            parent.text = view.text
            parent.onChange(view.text)
            view.requestHighlight()
            view.updateActiveLine()
            view.textDidChangeForCompletion()
        }

        func textViewDidChangeSelection(_ textView: UITextView) {
            guard let view = textView as? ComposerUITextView else { return }
            view.updateActiveLine()
            view.updateDecorations()
            view.selectionDidChangeForCompletion()
        }

        func textViewDidBeginEditing(_ textView: UITextView) {
            parent.isFocused = true
            (textView as? ComposerUITextView)?.updateDecorations()
        }

        func textViewDidEndEditing(_ textView: UITextView) {
            parent.isFocused = false
            guard let view = textView as? ComposerUITextView else { return }
            view.updateDecorations()
            view.closeCompletion()
        }
    }
}

/// Where the keyboard starts on screen. Watched from the first composer on, so one that appears
/// under an already open keyboard still knows.
final class ScreenKeyboard {
    static let shared = ScreenKeyboard()
    private(set) var top = CGFloat.greatestFiniteMagnitude
    private var observer: NSObjectProtocol?

    private init() {
        observer = NotificationCenter.default.addObserver(
            forName: UIResponder.keyboardWillChangeFrameNotification, object: nil, queue: .main
        ) { [weak self] note in
            guard let frame = note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect else { return }
            self?.top = frame.minY
        }
    }
}

final class ComposerUITextView: UITextView {
    enum PendingEdit { case typing, deletion }

    /// `activateOnTypingDelay` and `interactionDelay` from `autocompletion()`.
    private static let completionDelay: TimeInterval = 0.1
    private static let completionInteractionDelay: TimeInterval = 0.075
    /// `highlightSelectionMatches`: a longer selection isn't searched for, and past this many
    /// matches none are shown.
    private static let longestMatchQuery = 200
    private static let mostMatches = 100
    private static let matchingBracket = UIColor(red: 0x32 / 255, green: 0x8C / 255, blue: 0x82 / 255, alpha: 0x52 / 255)
    private static let nonmatchingBracket = UIColor(red: 0xBB / 255, green: 0x55 / 255, blue: 0x55 / 255, alpha: 0x44 / 255)
    private static let selectionMatch = AppTheme.UI.dynamic(light: "#D8DEE4", dark: "#21262D")

    var onPasteImages: (([UIImage]) -> Void)?
    var onContentHeightChange: ((CGFloat) -> Void)?
    let engineId = UUID().uuidString
    var isApplyingEngineEdit = false
    var pendingEdit: PendingEdit?
    private let activeLine = UIView()
    private var appliedRuns: (text: String, runs: [ComposerEngine.Run])?
    private var charactersChangedSinceStyling = false
    private var completionWork: DispatchWorkItem?
    private var completionPopup: ComposerCompletionPopup?
    private var completionTracker: CADisplayLink?
    private var completionAnchor: Int?
    private var completionIsAbove = false
    private var completionShownAt: Date?
    private var completionCaret: Int?
    var editorInsets = UIEdgeInsets.zero
    var editorMinHeight: CGFloat = 0
    var showsActiveLine = true {
        didSet { activeLine.isHidden = !showsActiveLine }
    }
    private var bracketMarks: [ComposerLayoutManager.Mark] = []

    private var decorationLayout: ComposerLayoutManager? { layoutManager as? ComposerLayoutManager }

    deinit {
        ComposerEngine.shared.close(id: engineId)
    }

    convenience init(usingTextLayoutManager: Bool) {
        let storage = NSTextStorage()
        let layout = ComposerLayoutManager()
        storage.addLayoutManager(layout)
        let container = NSTextContainer(size: CGSize(width: 0, height: CGFloat.greatestFiniteMagnitude))
        container.widthTracksTextView = true
        layout.addTextContainer(container)
        self.init(frame: .zero, textContainer: container)
        _ = ScreenKeyboard.shared
        activeLine.backgroundColor = AppTheme.UI.composerActiveLine
        activeLine.isUserInteractionEnabled = false
        insertSubview(activeLine, at: 0)
    }

    override var contentSize: CGSize {
        didSet {
            guard contentSize.height != oldValue.height, let report = onContentHeightChange else { return }
            // Laid out mid-update; the host's state changes after it
            let height = contentSize.height
            DispatchQueue.main.async { report(height) }
        }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        // The line that outgrew the old height scrolled the text; once the host has grown the
        // view to fit, its first line belongs back at the top
        if isScrollEnabled, contentSize.height <= bounds.height, contentOffset.y != 0 {
            contentOffset.y = 0
        }
        updateActiveLine()
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        if window == nil { closeCompletion() }
    }

    /// `.cm-activeLine`: the caret's whole logical line, edge to edge.
    func updateActiveLine() {
        sendSubviewToBack(activeLine)
        let inset = textContainerInset
        let ns = textStorage.string as NSString
        let lineHeight = ComposerStyle.lineHeight
        guard ns.length > 0 else {
            activeLine.frame = CGRect(x: 0, y: inset.top, width: bounds.width, height: lineHeight)
            return
        }
        // A read-only editor's caret never leaves the start of the document.
        let location = isEditable ? min(selectedRange.location, ns.length) : 0
        if location == ns.length, ns.character(at: ns.length - 1) == 10 {
            let extra = layoutManager.extraLineFragmentRect
            let y = extra.height > 0 ? extra.minY : layoutManager.usedRect(for: textContainer).maxY
            activeLine.frame = CGRect(x: 0, y: y + inset.top, width: bounds.width, height: lineHeight)
            return
        }
        let paragraph = ns.paragraphRange(for: NSRange(location: location, length: 0))
        let glyphs = layoutManager.glyphRange(forCharacterRange: paragraph, actualCharacterRange: nil)
        var rect = CGRect.null
        layoutManager.enumerateLineFragments(forGlyphRange: glyphs) { fragment, _, _, _, _ in
            rect = rect.union(fragment)
        }
        guard !rect.isNull else { return }
        activeLine.frame = CGRect(x: 0, y: rect.minY + inset.top, width: bounds.width, height: rect.height)
    }

    /// Paste an image → uploads automatically (GitHub-style, like the web's paste path).
    override func paste(_ sender: Any?) {
        let pasteboard = UIPasteboard.general
        if let images = pasteboard.images, !images.isEmpty, !pasteboard.hasStrings {
            onPasteImages?(images)
            return
        }
        if let pasted = pasteboard.string,
           let edit = ComposerEngine.shared.pasteLink(id: engineId, text: text, selection: selectedRange, pasted: pasted) {
            apply(edit)
            return
        }
        pendingEdit = nil
        super.paste(sender)
    }

    // MARK: Engine

    /// Replacing through the text input keeps the edit on the undo stack.
    func apply(_ edit: ComposerEngine.Edit) {
        isApplyingEngineEdit = true
        defer { isApplyingEngineEdit = false }
        typingAttributes = ComposerStyle.base
        for change in edit.changes.reversed() {
            guard let start = position(from: beginningOfDocument, offset: change.from),
                  let end = position(from: beginningOfDocument, offset: change.to),
                  let range = textRange(from: start, to: end) else { continue }
            replace(range, withText: change.insert)
        }
        selectedRange = NSRange(location: min(edit.anchor, edit.head), length: abs(edit.anchor - edit.head))
    }

    func requestHighlight() {
        charactersChangedSinceStyling = true
        let requested = text ?? ""
        ComposerEngine.shared.highlight(id: engineId, text: requested) { [weak self] runs in
            MainActor.assumeIsolated {
                self?.applyHighlight(runs, to: requested)
            }
        }
    }

    private func applyHighlight(_ runs: [ComposerEngine.Run], to requested: String) {
        // Changing attributes under marked text would end a composition.
        guard text == requested, markedTextRange == nil else { return }
        if !charactersChangedSinceStyling, let appliedRuns, appliedRuns.text == requested, appliedRuns.runs == runs { return }
        // A character replaced by the same character leaves nothing to compare.
        let replaced = charactersChangedSinceStyling && appliedRuns?.text == requested
        ComposerStyle.apply(runs, to: self, replacing: replaced ? nil : appliedRuns)
        appliedRuns = (requested, runs)
        charactersChangedSinceStyling = false
    }

    /// Plain text until the engine's answer for it arrives.
    func resetStyle() {
        appliedRuns = nil
        ComposerStyle.reset(self)
    }

    /// `.cm-focused` scopes the bracket marks, so they only show while editing.
    func updateDecorations() {
        guard isFirstResponder, markedTextRange == nil else {
            bracketMarks = []
            decorationLayout?.marks = []
            return
        }
        let caret = selectedRange
        let requested = text ?? ""
        refreshMarks()
        ComposerEngine.shared.brackets(id: engineId, text: requested, selection: caret) { [weak self] marks in
            MainActor.assumeIsolated {
                guard let self, self.text == requested, self.selectedRange == caret else { return }
                self.bracketMarks = marks.map {
                    ComposerLayoutManager.Mark(
                        range: NSRange(location: $0.from, length: $0.to - $0.from),
                        color: $0.matched ? Self.matchingBracket : Self.nonmatchingBracket
                    )
                }
                self.refreshMarks()
            }
        }
    }

    private func refreshMarks() {
        decorationLayout?.marks = selectedRange.length > 0 ? selectionMatchMarks() : bracketMarks
    }

    private func selectionMatchMarks() -> [ComposerLayoutManager.Mark] {
        let selection = selectedRange
        guard selection.length <= Self.longestMatchQuery else { return [] }
        let document = textStorage.string as NSString
        let query = document.substring(with: selection)
        var marks: [ComposerLayoutManager.Mark] = []
        var cursor = 0
        while cursor < document.length {
            let found = document.range(of: query, options: .literal, range: NSRange(location: cursor, length: document.length - cursor))
            guard found.location != NSNotFound else { break }
            if found.location >= selection.upperBound || found.upperBound <= selection.location {
                marks.append(.init(range: found, color: Self.selectionMatch))
                if marks.count > Self.mostMatches { return [] }
            }
            cursor = found.upperBound
        }
        return marks
    }

    // MARK: Completion

    /// Typing opens the popup; deleting only updates one that's open; anything else closes it.
    func textDidChangeForCompletion() {
        let edit = pendingEdit
        pendingEdit = nil
        guard edit == .typing || (edit == .deletion && completionPopup != nil) else {
            closeCompletion()
            return
        }
        completionWork?.cancel()
        let requested = text ?? ""
        let caret = selectedRange
        guard caret.length == 0 else {
            closeCompletion()
            return
        }
        completionCaret = caret.location
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            ComposerEngine.shared.completions(id: self.engineId, text: requested, position: caret.location) { [weak self] list in
                MainActor.assumeIsolated {
                    guard let self, self.text == requested, self.selectedRange == caret, self.isFirstResponder else { return }
                    self.showCompletion(list)
                }
            }
        }
        completionWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.completionDelay, execute: work)
    }

    private func showCompletion(_ list: ComposerEngine.CompletionList) {
        guard !list.options.isEmpty, let window else {
            closeCompletion()
            return
        }
        let popup = completionPopup ?? ComposerCompletionPopup()
        if completionPopup == nil {
            completionShownAt = Date()
            completionIsAbove = false
            window.addSubview(popup)
            completionPopup = popup
            let tracker = CADisplayLink(target: self, selector: #selector(updateCompletionFrame))
            tracker.add(to: .main, forMode: .common)
            completionTracker = tracker
        }
        popup.show(list.options) { [weak self] index in
            self?.pickCompletion(index)
        }
        completionAnchor = list.from
        updateCompletionFrame()
    }

    /// A CodeMirror tooltip. It follows the glyphs of the text being completed (`coordsAtPos` is
    /// narrower than the line) and hides while they're outside the editor. Nothing clips it: it
    /// opens on the side of the line it fits on, above the keyboard, like `tooltipSpace` on the web.
    @objc private func updateCompletionFrame() {
        guard let popup = completionPopup, let window,
              let completionAnchor, textStorage.length > 0 else { return }
        let glyph = layoutManager.glyphIndexForCharacter(at: min(completionAnchor, textStorage.length - 1))
        let line = layoutManager.lineFragmentRect(forGlyphAt: glyph, effectiveRange: nil)
        let font = DSFont.uiMono(ComposerStyle.size)
        let box = WebLineBox(font: font, lineHeight: ComposerStyle.lineHeight)
        let anchor = CGPoint(
            x: line.minX + layoutManager.location(forGlyphAt: glyph).x + textContainerInset.left,
            y: line.minY + textContainerInset.top + box.baseline
        )
        let baseline = convert(anchor, to: window)
        let top = baseline.y - font.ascender.rounded()
        let bottom = baseline.y + (-font.descender).rounded()

        var editor = bounds.inset(by: editorInsets)
        editor.size.height = max(editor.height, editorMinHeight)
        let editorFrame = convert(editor, to: window)
        var room = window.bounds
        room.size.height = min(room.height, ScreenKeyboard.shared.top - room.minY)
        guard bottom > max(editorFrame.minY, room.minY), top < min(editorFrame.maxY, room.maxY) else {
            popup.isHidden = true
            return
        }

        let size = popup.fittingSize
        let overflows = completionIsAbove ? top - size.height < room.minY : bottom + size.height > room.maxY
        if overflows, completionIsAbove == (room.maxY - bottom > top - room.minY) { completionIsAbove.toggle() }
        let space = completionIsAbove ? top - room.minY : room.maxY - bottom
        guard space >= ComposerStyle.lineHeight else {
            popup.isHidden = true
            return
        }
        let height = min(size.height, space)
        let frame = CGRect(
            x: max(room.minX, min(baseline.x, room.maxX - size.width)),
            y: completionIsAbove ? top - height : bottom,
            width: size.width,
            height: height
        )
        popup.isHidden = false
        popup.frame = frame
    }

    /// Moving the caret away from what's being completed closes the popup. An edit in progress
    /// moves it too, and reports through `textDidChangeForCompletion` instead.
    func selectionDidChangeForCompletion() {
        guard pendingEdit == nil, !isApplyingEngineEdit, let completionCaret, selectedRange != NSRange(location: completionCaret, length: 0) else { return }
        closeCompletion()
    }

    func closeCompletion() {
        completionWork?.cancel()
        completionWork = nil
        completionTracker?.invalidate()
        completionTracker = nil
        completionPopup?.removeFromSuperview()
        completionPopup = nil
        completionAnchor = nil
        completionShownAt = nil
        completionCaret = nil
    }

    private func pickCompletion(_ index: Int) {
        closeCompletion()
        guard let edit = ComposerEngine.shared.applyCompletion(id: engineId, text: text, selection: selectedRange, index: index) else { return }
        pendingEdit = nil
        apply(edit)
    }

    /// `Enter` with the popup open picks its first option, unless the popup only just appeared
    /// and the key was meant for the line.
    func acceptCompletion() -> Bool {
        guard completionPopup != nil, let shownAt = completionShownAt,
              Date().timeIntervalSince(shownAt) >= Self.completionInteractionDelay,
              selectedRange.length == 0, selectedRange.location == completionCaret else { return false }
        pickCompletion(0)
        return true
    }

    override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
        if action == #selector(paste(_:)), UIPasteboard.general.hasImages { return true }
        return super.canPerformAction(action, withSender: sender)
    }
}

enum ComposerStyle {
    static let size: CGFloat = 24
    static var lineHeight: CGFloat { DSFont.scaledSize(33.6) }

    private static let paragraph: NSParagraphStyle = {
        let style = NSMutableParagraphStyle()
        style.minimumLineHeight = lineHeight
        style.maximumLineHeight = lineHeight
        style.lineBreakMode = .byWordWrapping
        return style
    }()

    private static var baselineOffset: CGFloat {
        let font = DSFont.uiMono(size)
        return (lineHeight - font.ascender + font.descender) / 2
    }

    static var base: [NSAttributedString.Key: Any] {
        [
            .font: DSFont.uiMono(size),
            .foregroundColor: AppTheme.UI.composerText,
            .paragraphStyle: paragraph,
            .baselineOffset: baselineOffset
        ]
    }

    static func reset(_ view: UITextView) {
        let storage = view.textStorage
        let selection = view.selectedRange
        storage.setAttributes(base, range: NSRange(location: 0, length: storage.length))
        view.selectedRange = selection
        view.typingAttributes = base
    }

    /// Only touches the stretch where the runs changed: new attributes invalidate layout for
    /// their range, which on a long note would otherwise mean the whole document per keystroke.
    static func apply(_ runs: [ComposerEngine.Run], to view: UITextView, replacing previous: (text: String, runs: [ComposerEngine.Run])?) {
        let storage = view.textStorage
        let selection = view.selectedRange
        let changed = previous.map {
            changedSpan(runs, previous: $0.runs, edited: editedRange(from: $0.text, to: storage.string), length: storage.length, lengthChange: storage.length - ($0.text as NSString).length)
        } ?? (runs: runs.indices, characters: NSRange(location: 0, length: storage.length))
        storage.beginEditing()
        storage.setAttributes(base, range: changed.characters)
        for run in runs[changed.runs] where run.range.upperBound <= storage.length {
            if let color = run.color {
                storage.addAttribute(.foregroundColor, value: color.uiColor, range: run.range)
            }
            if run.bold {
                storage.addAttribute(.font, value: DSFont.uiMono(size, weight: .bold), range: run.range)
            }
            if run.underline {
                storage.addAttribute(.underlineStyle, value: NSUnderlineStyle.single.rawValue, range: run.range)
            }
        }
        storage.endEditing()
        view.selectedRange = selection
        view.typingAttributes = base
    }

    /// The stretch of the new text that isn't in the old, by what the two share at either end.
    static func editedRange(from old: String, to new: String) -> NSRange {
        let before = Array(old.utf16)
        let after = Array(new.utf16)
        var prefix = 0
        while prefix < before.count, prefix < after.count, before[prefix] == after[prefix] { prefix += 1 }
        var suffix = 0
        while suffix < before.count - prefix, suffix < after.count - prefix,
              before[before.count - 1 - suffix] == after[after.count - 1 - suffix] { suffix += 1 }
        return NSRange(location: prefix, length: after.count - prefix - suffix)
    }

    /// The runs that differ from the previous answer once the edit's shift is accounted for, and
    /// the characters they cover, which reach to the unchanged runs on either side. Text inside
    /// the edit takes the typing attributes, so its runs count as changed even if they look equal.
    static func changedSpan(
        _ runs: [ComposerEngine.Run],
        previous: [ComposerEngine.Run],
        edited: NSRange,
        length: Int,
        lengthChange: Int
    ) -> (runs: Range<Int>, characters: NSRange) {
        var prefix = 0
        while prefix < runs.count, prefix < previous.count, runs[prefix] == previous[prefix],
              runs[prefix].range.upperBound <= edited.location { prefix += 1 }
        var suffix = 0
        while suffix < runs.count - prefix, suffix < previous.count - prefix {
            let new = runs[runs.count - 1 - suffix]
            let old = previous[previous.count - 1 - suffix]
            guard new.color == old.color, new.bold == old.bold, new.underline == old.underline,
                  new.range.length == old.range.length,
                  new.range.location == old.range.location + lengthChange,
                  new.range.location >= edited.upperBound else { break }
            suffix += 1
        }
        let start = prefix > 0 ? runs[prefix - 1].range.upperBound : 0
        let end = suffix > 0 ? runs[runs.count - suffix].range.location : length
        return (prefix..<(runs.count - suffix), NSRange(location: start, length: max(end - start, 0)))
    }
}
