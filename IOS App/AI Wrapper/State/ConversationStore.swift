import Foundation
import SwiftUI
import Combine

/// Mirrors src/context/ConversationContext.tsx — the block list, streaming generation
/// with per-vendor cancellation, durable-run reattach and human-in-the-loop, background
/// recovery, conversation load/reset, fork and titles.
@MainActor
final class ConversationStore: ObservableObject {
    @Published var conversationId: String = ""
    @Published var conversationTitle: String?
    @Published var conversationRole: ConversationRole = .owner
    @Published var blocks: [ConversationBlock] = [ConversationStore.defaultBlock()]
    @Published var selectedResponseByBlock: [String: String] = [:]
    @Published var vendorSelectionByBlock: [String: [String]] = [:]
    /// Active draft text (web: ConversationUIContext.editorPrompt) — feeds the TokenCounter.
    @Published var editorPrompt: String = ""
    /// Project the NEXT brand-new conversation is created into (history's per-project
    /// "new conversation"); cleared by resetConversation.
    @Published var pendingProjectId: String?
    /// messageId → the durable run's pending input request (RunHitlBanner).
    @Published var awaitingInputs: [String: AwaitingInput] = [:]
    /// Ask-from-selection: quotes waiting for the draft editor (AskSelectionContext).
    @Published var pendingAsks: [String] = []
    /// Bumped to hand keyboard focus to the trailing draft editor (follow-up flow).
    @Published var focusDraftRequest = 0
    /// Last request a composer acted on. Following up creates the composer that must take focus,
    /// and a view created after the change never sees it through `onChange`.
    var handledFocusDraftRequest = 0
    /// Bumped when the conversation is dragged back up: a draft editor in use is put away.
    @Published var putAwayDraftRequest = 0

    var streamTasks: [String: Task<Void, Error>] = [:]
    /// Client-minted generation ids per stream key, so Stop can cancel server-side work
    /// even before the response headers arrive.
    var generationIds: [String: String] = [:]
    /// Streams Stop was pressed for, and streams whose response headers have arrived. A stream
    /// stopped before its headers keeps its request open until they come: they carry the
    /// conversation id a new chat's other vendors join, and without it the next vendor starts a
    /// conversation of its own. A vendor stopped before it launched still sends its request, so
    /// the server records it as stopped.
    private var stopRequested: Set<String> = []
    var headersReceived: Set<String> = []
    /// Changes when the user leaves the conversation. A stream from an earlier session belongs
    /// to a conversation no longer on screen: it must not write into this one.
    private var streamSession = UUID()
    /// How long a reply stopped before its headers waits for them before giving up on them.
    private static let stopHeadersTimeoutNanoseconds: UInt64 = 30_000_000_000
    private var askSourceMessageId: String?

    private weak var auth: AuthStore?
    private weak var ai: AIStore?
    private weak var toasts: ToastCenter?
    private weak var history: HistoryStore?

    func configure(auth: AuthStore, ai: AIStore, toasts: ToastCenter, history: HistoryStore? = nil) {
        self.auth = auth
        self.ai = ai
        self.toasts = toasts
        self.history = history
    }

    static func defaultBlock() -> ConversationBlock {
        ConversationBlock(conversationBlockId: "conv-default", prompt: "", responseMessages: [], isLoading: false, status: .draft)
    }

    // MARK: - Block helpers

    func updateBlock(_ id: String, _ transform: (inout ConversationBlock) -> Void) {
        guard let index = blocks.firstIndex(where: { $0.conversationBlockId == id }) else { return }
        transform(&blocks[index])
    }

    func updateMessage(blockId: String, matching ids: Set<String>, _ transform: (inout Message) -> Void) {
        guard let blockIndex = blocks.firstIndex(where: { $0.conversationBlockId == blockId }) else { return }
        for messageIndex in blocks[blockIndex].responseMessages.indices
        where ids.contains(blocks[blockIndex].responseMessages[messageIndex].messageId) {
            transform(&blocks[blockIndex].responseMessages[messageIndex])
        }
    }

    @discardableResult
    func addNewBlock() -> String {
        let id = "conv-\(Int(Date().timeIntervalSince1970 * 1000))"
        blocks.append(ConversationBlock(conversationBlockId: id, prompt: "", responseMessages: [], isLoading: false, status: .draft))
        return id
    }

    func getSelectedResponse(for blockId: String) -> String? {
        let value = selectedResponseByBlock[blockId]
        return (value?.isEmpty ?? true) ? nil : value
    }

    func setSelectedResponse(for blockId: String, responseId: String) {
        selectedResponseByBlock[blockId] = responseId
    }

    func getVendorSelection(for blockId: String) -> [String] {
        vendorSelectionByBlock[blockId] ?? []
    }

    func setVendorSelection(for blockId: String, vendors: [String]) {
        vendorSelectionByBlock[blockId] = vendors
    }

    /// The last block that has responses — only it offers Regenerate / Follow up.
    var lastResponseBlockId: String? {
        blocks.last { !$0.responseMessages.isEmpty }?.conversationBlockId
    }

    // MARK: - Drafts

    private func draftKey(_ blockId: String) -> String? {
        auth?.customerId.map { StorageSuffix.customerKey($0, StorageSuffix.promptEditorContentPrefix + "conv-\(blockId)") }
    }

    func savedDraft(for blockId: String) -> String? {
        draftKey(blockId).flatMap { CacheStore.shared.readString($0) }
    }

    func persistDraft(_ text: String, for blockId: String) {
        guard let key = draftKey(blockId) else { return }
        CacheStore.shared.writeString(text.isEmpty ? nil : text, key: key)
    }

    /// The empty last block waiting for input. A block mid-generation is also still `draft`, but isn't one.
    var trailingDraft: ConversationBlock? {
        guard let last = blocks.last, last.status == .draft, last.responseMessages.isEmpty, !last.isLoading else { return nil }
        return last
    }

    /// An empty editor follows a sent last turn as soon as it starts generating, so the editor stays
    /// on the bottom of the page and a follow-up is always one tap away (ConversationWidget). A
    /// viewer who can only read gets none.
    func ensureTrailingDraft() {
        guard conversationRole != .view, let last = blocks.last, last.status == .resolved || last.isLoading else { return }
        addNewBlock()
    }

    // MARK: - Follow up (ConversationBlock.handleFollowUp + Response.handleFollowUp)

    func followUp(fromBlock blockId: String, messageId: String) {
        setSelectedResponse(for: blockId, responseId: messageId)
        if let draft = trailingDraft {
            setSelectedResponse(for: draft.conversationBlockId, responseId: messageId)
        } else {
            let id = addNewBlock()
            setSelectedResponse(for: id, responseId: messageId)
        }
        focusDraftRequest += 1
    }

    // MARK: - Ask from selection (AskSelectionContext)

    /// "foo\nbar" → "> foo\n> bar" (blank selected lines become bare ">").
    static func markdownQuote(_ text: String) -> String {
        text.trimmingCharacters(in: .whitespacesAndNewlines)
            .components(separatedBy: "\n")
            .map { line -> String in
                var quoted = "> \(line)"
                while quoted.last?.isWhitespace == true { quoted.removeLast() }
                return quoted
            }
            .joined(separator: "\n")
    }

    /// Queues selected response text as a quote for the draft; all asks of one draft come
    /// from one response, so quoting another one switches the chain and tells the user.
    func ask(selectedText: String, fromBlock blockId: String, message: Message) {
        let hadAsks = askSourceMessageId != nil
        let switched = hadAsks && askSourceMessageId != message.messageId
        askSourceMessageId = message.messageId
        pendingAsks.append(Self.markdownQuote(selectedText))
        followUp(fromBlock: blockId, messageId: message.messageId)
        if switched {
            toasts?.showToast(L("conversation.response.askSourceSwitched", ["vendor": message.aiVendor.displayName]))
        }
    }

    func resetAskSession() {
        askSourceMessageId = nil
        pendingAsks = []
    }

    // MARK: - Stop

    /// Freezes the stopped replies and cancels their server work (the Stop button). Without a
    /// block it stops every reply in progress and drops their requests at once.
    func stopGenerating(blockId: String? = nil, vendor: AIVendor? = nil) {
        let keys = generationIds.keys.filter { key in
            guard !stopRequested.contains(key) else { return false }
            guard let blockId else { return true }
            if let vendor { return key == "\(blockId)-\(vendor.rawValue)" }
            return key.hasPrefix("\(blockId)-")
        }
        guard !keys.isEmpty else { return }
        var idsToCancel: [String] = []
        for key in keys {
            stopRequested.insert(key)
            guard let generationId = generationIds[key] else { continue }
            idsToCancel.append(generationId)
            if blockId == nil || headersReceived.contains(key) {
                streamTasks[key]?.cancel()
            } else {
                Task { [weak self] in
                    try? await Task.sleep(nanoseconds: Self.stopHeadersTimeoutNanoseconds)
                    guard let self, self.generationIds[key] == generationId else { return }
                    self.streamTasks[key]?.cancel()
                }
            }
        }
        if let blockId {
            let vendors = Set(keys.map { String($0.dropFirst(blockId.count + 1)) })
            updateBlock(blockId) { block in
                for index in block.responseMessages.indices
                where block.responseMessages[index].isLoading && vendors.contains(block.responseMessages[index].aiVendor.rawValue) {
                    Self.markStopped(&block.responseMessages[index])
                }
            }
        }
        guard !idsToCancel.isEmpty else { return }
        // Cancelling the request only detaches this client — generation survives
        // disconnects by design and keeps billing, so a true Stop also cancels server-side.
        let cancel = cancelOnServer
        Task { await cancel(idsToCancel) }
    }

    /// Cancels generations on the server by client generation id. Replaced in tests.
    lazy var cancelOnServer: ([String]) async -> Void = { [weak self] ids in
        guard let token = try? await self?.auth?.getAccessTokenSilently() else { return }
        for id in ids {
            await StreamRecoveryService.cancelGeneration(token: token, id: id)
        }
    }

    // MARK: - Fork

    /// Fork at [messageId]: the backend copies every message up to it into a new
    /// conversation; history nests it under its parent, and we open it.
    func forkFromMessage(_ messageId: String) async {
        guard let auth, !conversationId.isEmpty, let token = try? await auth.getAccessTokenSilently() else { return }
        do {
            let fork = try await ConversationHistoryService.forkConversation(token: token, conversationId: conversationId, messageId: messageId)
            history?.didFork(fork)
            toasts?.showToast(L("conversation.conversationHistory.forkedToast"))
            await loadConversation(fork.conversationId)
        } catch {
            toasts?.showToast(L("conversation.conversationHistory.forkFailed"))
        }
    }

    // MARK: - Load / reset

    func loadConversation(_ id: String) async {
        guard let auth else { return }
        if id != conversationId {
            detachStreams()
        } else if !streamTasks.isEmpty {
            return   // already on screen and streaming live
        }
        resetAskSession()
        do {
            var token = ""
            if auth.isAuth0Authenticated {
                token = (try? await auth.getAccessTokenSilently()) ?? ""
            }
            let data = try await ConversationService.getConversation(token: token, conversationId: id)
            conversationId = data.conversationId
            blocks = data.blocks.isEmpty ? [Self.defaultBlock()] : data.blocks
            conversationRole = data.role
            conversationTitle = data.title
            ai?.selectedInstructionId = data.instructionId

            // Durable runs still generating the latest reply: reattach to each so the
            // responses continue live. A multi-vendor turn has one run per vendor.
            guard let lastBlock = data.blocks.last, !data.pendingRuns.isEmpty || data.pendingRunId != nil else { return }
            let blockId = lastBlock.conversationBlockId
            if !data.pendingRuns.isEmpty {
                for run in data.pendingRuns {
                    reattach(blockId: blockId, messageId: run.messageId, runId: run.runId, synthetic: false, token: token, conversationId: data.conversationId)
                }
            } else if let runId = data.pendingRunId {
                // Legacy single-run proxy without placeholders: synthesize a card to
                // receive the stream (no server record, so the usage fetch is skipped).
                let existing = lastBlock.responseMessages.last
                let targetId = existing?.messageId ?? "reattach-\(runId)"
                if existing == nil {
                    let prior = data.blocks.reversed().flatMap(\.responseMessages).first
                    let placeholder = Message(aiVendor: prior?.aiVendor ?? .openai, text: "", messageId: targetId, isLoading: true, model: prior?.model)
                    updateBlock(blockId) { $0.isLoading = true; $0.responseMessages.append(placeholder) }
                }
                reattach(blockId: blockId, messageId: targetId, runId: runId, synthetic: existing == nil, token: token, conversationId: data.conversationId)
            }
        } catch let error as APIError where error.status == 403 {
            toasts?.showToast(L("toasts.conversation.noAccess"))
            resetConversation()
        } catch {
            AppObservability.capture(error, context: ["where": "loadConversation"])
        }
    }

    /// Reattach one response to its durable run: reset text, stream the replay in, then
    /// fetch usage. A dropped stream picks up where it stopped; a run already over has saved
    /// its reply, which is fetched once. Stop and leaving the chat work as on a live reply.
    private func reattach(blockId: String, messageId: String, runId: String, synthetic: Bool, token: String, conversationId: String) {
        let ids: Set<String> = [messageId]
        let vendor = blocks.first { $0.conversationBlockId == blockId }?
            .responseMessages.first { $0.messageId == messageId }?.aiVendor
        let key = "\(blockId)-\(vendor?.rawValue ?? messageId)"
        let session = streamSession
        let cursor = ReplyCursor(runId: runId)
        updateMessage(blockId: blockId, matching: ids) { $0.isLoading = true; $0.text = "" }
        var accumulated = ""
        var gotContent = false
        let callbacks = StreamCallbacks(
            onDelta: { [weak self] chunk in
                accumulated += chunk
                gotContent = true
                let text = accumulated
                self?.updateMessage(blockId: blockId, matching: ids) { $0.text = text }
            },
            onContentReset: { [weak self] in
                accumulated = ""
                self?.updateMessage(blockId: blockId, matching: ids) { $0.text = "" }
            },
            onStopReason: { [weak self] reason in self?.updateMessage(blockId: blockId, matching: ids) { $0.stopReason = reason } },
            onActivity: { [weak self] event in
                gotContent = true
                self?.updateMessage(blockId: blockId, matching: ids) { $0.activity.append(event) }
            },
            onWebSources: { [weak self] sources in self?.updateMessage(blockId: blockId, matching: ids) { $0.webSources = sources } },
            onGeneratedAttachments: { [weak self] refs in
                self?.updateMessage(blockId: blockId, matching: ids) { $0.generatedAttachments = ($0.generatedAttachments ?? []) + refs }
            },
            onAwaitingInput: { [weak self] payload in
                var input = payload
                input.runId = runId
                self?.awaitingInputs[messageId] = input
            },
            onRun: { [weak self] _, elapsedMs in
                guard let elapsedMs else { return }
                self?.updateMessage(blockId: blockId, matching: ids) { $0.runClock = RunClock(at: elapsedMs, receivedAt: Date()) }
            },
            onSeq: { cursor.lastSeq = $0 }
        )
        let task = Task<Void, Error> { [weak self] in
            guard let self else { return }
            let background = BackgroundTime("reply")
            defer { background.end() }
            var runFailure: String?
            var stopped = false
            do {
                try await self.follow(cursor, conversationId: conversationId, callbacks: callbacks)
            } catch is CancellationError {
                stopped = true
            } catch {
                AppObservability.capture(error, context: ["where": "replyRecoveryFailed"])
                runFailure = (error as? StreamGenerationError)?.message ?? L("errors.ai.generateTextStreamFailed")
            }
            if self.generationIds[key] == messageId {
                self.streamTasks.removeValue(forKey: key)
                self.generationIds.removeValue(forKey: key)
                self.headersReceived.remove(key)
            }
            // A chat no longer on screen isn't written into. Stop froze the card already;
            // it only has to stop loading.
            guard self.streamSession == session else { return }
            if let runFailure {
                self.updateMessage(blockId: blockId, matching: ids) { $0.error = runFailure }
            }
            if !synthetic, !stopped {
                // A run already over saved its reply before it left the pending set. One that
                // ended with nothing streamed saves it just after its stream closes.
                let saved: Message?
                if runFailure != nil {
                    saved = nil
                } else if !cursor.active {
                    saved = await self.fetchPersistedResponse(token: token, conversationId: conversationId, messageId: messageId)
                } else if !gotContent {
                    saved = await self.recoverPersistedResponse(token: token, conversationId: conversationId, messageId: messageId, maxAttempts: 3)
                } else {
                    saved = nil
                }
                if let saved {
                    self.updateMessage(blockId: blockId, matching: ids) {
                        $0.text = saved.text
                        $0.webSources = saved.webSources ?? $0.webSources
                        $0.generatedAttachments = saved.generatedAttachments ?? $0.generatedAttachments
                        $0.stopReason = saved.stopReason ?? $0.stopReason
                    }
                }
                if let metrics = await AIUsageService.getAIUsageActivity(token: token, conversationId: conversationId, messageId: messageId) {
                    self.updateMessage(blockId: blockId, matching: ids) { self.apply(metrics, to: &$0) }
                }
            }
            self.updateBlock(blockId) { block in
                for index in block.responseMessages.indices where block.responseMessages[index].messageId == messageId {
                    block.responseMessages[index].isLoading = false
                }
                block.isLoading = block.responseMessages.contains { $0.isLoading }
            }
        }
        // Stop cancels the run by its reply id; the server answered long ago.
        generationIds[key] = messageId
        headersReceived.insert(key)
        streamTasks[key] = task
    }

    /// Follows a reply's durable run from the last event this client applied until the run
    /// ends, reconnecting whenever the stream drops. Waits while the app is away or offline,
    /// and gives up after five failed attempts in the foreground. Leaves `cursor.active` false
    /// when the run is already over, so its reply is saved.
    private func follow(_ cursor: ReplyCursor, conversationId: String, callbacks: StreamCallbacks) async throws {
        guard let runId = cursor.runId else { return }
        var failures = 0
        while true {
            await ReconnectGate.shared.waitUntilOpen()
            try Task.checkCancellation()
            let token = (try? await auth?.getAccessTokenSilently()) ?? ""
            do {
                cursor.active = try await StreamRecoveryService.reattachRun(
                    token: token, runId: runId, conversationId: conversationId, fromSeq: cursor.lastSeq, callbacks: callbacks
                )
                return
            } catch let error as URLError where error.code == .cancelled {
                throw CancellationError()
            } catch is CancellationError {
                throw CancellationError()
            } catch let error as StreamGenerationError {
                throw error
            } catch let error as APIError where (400..<500).contains(error.status) {
                throw error
            } catch {
                if ReconnectGate.shared.isOpen { failures += 1 }
                if failures >= 5 { throw ReplyRecoveryFailed(underlying: error) }
                try await Task.sleep(nanoseconds: UInt64(1 << min(failures, 3)) * 1_000_000_000)
            }
        }
    }

    /// Delivers a reply to the durable run generating [messageId]; the run resumes from
    /// its checkpoint and the still-open stream delivers what follows.
    func submitRunReply(messageId: String, reply: String) async {
        guard let pending = awaitingInputs[messageId], let runId = pending.runId else { return }
        let token = (try? await auth?.getAccessTokenSilently()) ?? ""
        awaitingInputs.removeValue(forKey: messageId)
        let ok = await StreamRecoveryService.resumeRun(token: token, runId: runId, conversationId: conversationId, reply: ["reply": reply])
        if !ok { toasts?.showToast(L("conversation.runHitl.replyFailed")) }
    }

    /// Leaving the conversation stops this client listening, never the replies: they keep
    /// generating on the server, and only Stop cancels them. A request still waiting for its
    /// headers stays open until they arrive, so the server has taken the turn.
    private func detachStreams() {
        streamSession = UUID()
        for (key, task) in streamTasks where headersReceived.contains(key) { task.cancel() }
    }

    func resetConversation() {
        detachStreams()
        if let customerId = auth?.customerId {
            CacheStore.shared.removeAll(withPrefix: StorageSuffix.customerKey(customerId, StorageSuffix.promptEditorContentPrefix))
        }
        conversationId = ""
        blocks = [Self.defaultBlock()]
        selectedResponseByBlock = [:]
        vendorSelectionByBlock = [:]
        conversationTitle = nil
        conversationRole = .owner
        editorPrompt = ""
        awaitingInputs = [:]
        pendingProjectId = nil
        resetAskSession()
    }

    /// A fresh conversation that will be created inside [projectId] on its first message.
    func startConversationInProject(_ projectId: String) {
        resetConversation()
        pendingProjectId = projectId
    }

    /// The name of the project a new chat will start in (opened from a project's plus), until its
    /// first message creates the conversation.
    func pendingProjectName(in projects: [Project]) -> String? {
        guard conversationId.isEmpty, let id = pendingProjectId else { return nil }
        return projects.first { $0.projectId == id }?.name
    }

    // MARK: - Generation

    private struct GenerationPrep {
        var aiConfigs: [AIConfig]
        var selectedResponseId: String
        var prompt: String
        var block: ConversationBlock
    }

    private func validateAndPrepare(_ id: String, overridePrompt: String?, selectedMessageId: String?) -> GenerationPrep? {
        guard let auth, let ai, let block = blocks.first(where: { $0.conversationBlockId == id }) else { return nil }
        guard auth.isAuthenticated else {
            toasts?.showToast(L("toasts.auth.loginFirst"))
            return nil
        }
        let aiConfigs = ai.selectedConfigs
        guard !aiConfigs.isEmpty else {
            toasts?.showToast(L("toasts.ai.selectVendorAndModel"))
            return nil
        }

        // Parent response: the selection on this block (follow-up), else the previous
        // block's selection, else its first response.
        var parentResponseId = ""
        if let index = blocks.firstIndex(where: { $0.conversationBlockId == id }), index > 0 {
            let previous = blocks[index - 1]
            if let current = getSelectedResponse(for: id) {
                parentResponseId = current
            } else if let selected = getSelectedResponse(for: previous.conversationBlockId) {
                parentResponseId = selected
            } else if let first = previous.responseMessages.first {
                parentResponseId = first.messageId
            }
        }

        return GenerationPrep(
            aiConfigs: aiConfigs,
            selectedResponseId: selectedMessageId ?? parentResponseId,
            prompt: overridePrompt ?? block.prompt,
            block: block
        )
    }

    func generateResponsesStream(
        blockId id: String,
        overridePrompt: String? = nil,
        selectedMessageId: String? = nil,
        vendorToRegenerate: AIVendor? = nil,
        attachments: [AttachmentRef]? = nil
    ) async {
        guard let auth, let prep0 = validateAndPrepare(id, overridePrompt: overridePrompt, selectedMessageId: selectedMessageId) else { return }
        var prep = prep0

        // Regeneration resends the turn's original attachments as part of the input.
        let attachmentsToUse = attachments ?? prep.block.attachments
        // Regenerate reuses the turn's user message (its id travels on every response).
        let regenerateMessageId = vendorToRegenerate != nil
            ? prep.block.responseMessages.first { $0.previousMessageId != nil }?.previousMessageId
            : nil

        if let vendor = vendorToRegenerate {
            prep.aiConfigs = prep.aiConfigs.filter { $0.aiVendor == vendor }
            guard !prep.aiConfigs.isEmpty else {
                toasts?.showToast(L("toasts.ai.selectValidModelForVendor", ["vendor": vendor.rawValue]))
                return
            }
            // A stopped reply's request can stay open until its headers arrive;
            // regenerating it before then would race that stream.
            guard generationIds["\(id)-\(vendor.rawValue)"] == nil else { return }
        }

        var turnGenerationIds: [String: String] = [:]
        for config in prep.aiConfigs {
            let key = "\(id)-\(config.aiVendor.rawValue)"
            let generationId = UUID().uuidString
            turnGenerationIds[key] = generationId
            generationIds[key] = generationId
            stopRequested.remove(key)
            headersReceived.remove(key)
        }

        let timestamp = Int(Date().timeIntervalSince1970 * 1000)
        var initialMessages: [Message] = []

        updateBlock(id) { block in
            if let vendor = vendorToRegenerate {
                let newMessage = Message(aiVendor: vendor, text: "", messageId: "resp-\(timestamp)-regen", isLoading: true, model: prep.aiConfigs.first?.model)
                if let existing = block.responseMessages.firstIndex(where: { $0.aiVendor == vendor }) {
                    block.responseMessages[existing] = newMessage
                } else {
                    block.responseMessages.append(newMessage)
                }
                initialMessages = [newMessage]
            } else {
                let newMessages = prep.aiConfigs.enumerated().map { index, config in
                    Message(aiVendor: config.aiVendor, text: "", messageId: "resp-\(timestamp)-\(index)", isLoading: true, model: config.model)
                }
                block.responseMessages = newMessages
                initialMessages = newMessages
                block.sentAt = Date(timeIntervalSince1970: TimeInterval(timestamp) / 1000)
            }
            block.isLoading = true
            block.prompt = prep.prompt
            block.attachments = attachmentsToUse
        }

        var repliedId: String?
        do {
            let token = try await auth.getAccessTokenSilently()
            let instruction = latestInstruction()
            let instructionId = ai?.selectedInstructionId ?? ""
            let instructionVersion = instruction.map { String($0.version) } ?? ""

            func run(_ index: Int, explicitId: String?, onIdResolved: ((String) -> Void)?) async throws {
                try await runStream(
                    token: token, config: prep.aiConfigs[index], blockId: id,
                    placeholderMessageId: initialMessages[index].messageId,
                    prompt: prep.prompt, selectedResponseId: prep.selectedResponseId,
                    instructionId: instructionId, instructionVersion: instructionVersion,
                    attachments: attachmentsToUse, regenerateMessageId: regenerateMessageId,
                    explicitConversationId: explicitId, turnResponseCount: prep.aiConfigs.count,
                    onIdResolved: onIdResolved
                )
            }

            if !conversationId.isEmpty {
                // Existing conversation: all vendors stream in parallel.
                let currentId = conversationId
                repliedId = currentId
                try await withThrowingTaskGroup(of: Void.self) { group in
                    for index in prep.aiConfigs.indices {
                        group.addTask { try await run(index, explicitId: currentId, onIdResolved: nil) }
                    }
                    try await group.waitForAll()
                }
            } else {
                // New conversation: try each vendor as the "starter" until one yields a
                // conversation id. A failed starter marks only its own message as errored
                // and the next vendor takes over, so the rest still run.
                var pending: [Task<Void, Error>] = []
                var starterIndex = 0
                var establishedId: String?

                while starterIndex < prep.aiConfigs.count, establishedId == nil {
                    let index = starterIndex
                    let outcome = AsyncStream<String?> { continuation in
                        let task = Task {
                            do {
                                try await run(index, explicitId: nil) { continuation.yield($0) }
                                continuation.yield(nil)
                                continuation.finish()
                            } catch {
                                continuation.yield(nil)
                                continuation.finish()
                                throw error
                            }
                        }
                        pending.append(task)
                    }
                    for await value in outcome {
                        if let value, !value.isEmpty { establishedId = value }
                        break
                    }
                    if establishedId == nil {
                        // Stopped before the server answered: the stopped request may already
                        // have opened the conversation, so another starter would open a second one.
                        if stopRequested.contains("\(id)-\(prep.aiConfigs[index].aiVendor.rawValue)") { break }
                        starterIndex += 1
                    }
                }

                if establishedId == nil, starterIndex + 1 < prep.aiConfigs.count {
                    // Vendors that never launched: the turn was stopped.
                    let unlaunched = Set(prep.aiConfigs[(starterIndex + 1)...].map(\.aiVendor.rawValue))
                    updateBlock(id) { block in
                        for index in block.responseMessages.indices
                        where block.responseMessages[index].isLoading && unlaunched.contains(block.responseMessages[index].aiVendor.rawValue) {
                            Self.markStopped(&block.responseMessages[index])
                        }
                    }
                }

                if let newId = establishedId {
                    repliedId = newId
                    let titlePrompt = prep.prompt
                    let titleVendors = prep.aiConfigs.map(\.aiVendor)
                    let instructionName = instruction?.name
                    let session = streamSession
                    Task { [weak self] in
                        if let response = try? await CreateConversationTitleService.createConversationTitle(
                            token: token,
                            request: CreateConversationTitleRequest(conversationId: newId, prompt: titlePrompt, instructionName: instructionName)
                        ), let title = response.title {
                            if self?.streamSession == session { self?.conversationTitle = title }
                            self?.history?.didTitleConversation(id: newId, title: title, vendors: titleVendors, pendingProjectId: self?.pendingProjectId)
                        }
                    }

                    if starterIndex + 1 < prep.aiConfigs.count {
                        // Small delay to let the initial write settle on the backend.
                        try? await Task.sleep(nanoseconds: 200_000_000)
                        for index in (starterIndex + 1)..<prep.aiConfigs.count {
                            pending.append(Task { try await run(index, explicitId: newId, onIdResolved: nil) })
                        }
                    }
                }
                for task in pending { try await task.value }
            }

            updateBlock(id) { block in
                block.isLoading = false
                block.status = .resolved
                block.prompt = prep.prompt
            }
            selectedResponseByBlock[id] = ""
        } catch is CancellationError {
            updateBlock(id) { block in
                block.isLoading = false
                block.status = .resolved
            }
        } catch Auth0Service.AuthError.loginRequired {
            // Session expired mid-use: the draft is already persisted by the editor.
            updateBlock(id) { block in
                block.isLoading = false
                block.status = .draft
            }
            toasts?.showToast(L("toasts.auth.sessionExpiredDraftSaved"))
            auth.logout()
        } catch {
            // Per-vendor failures are handled inside runStream; this only fires for errors
            // outside the streams (e.g. token fetch). Never wipe text that already streamed.
            let reason = error.localizedDescription
            updateBlock(id) { block in
                for index in block.responseMessages.indices where block.responseMessages[index].isLoading {
                    block.responseMessages[index].isLoading = false
                    block.responseMessages[index].error = reason
                }
                block.isLoading = false
                block.status = .resolved
            }
        }

        if let repliedId, auth.isAuthenticated {
            history?.didReply(id: repliedId, vendors: prep.aiConfigs.map(\.aiVendor))
        }
        // A regenerate that already took a key over keeps it.
        for (key, generationId) in turnGenerationIds where generationIds[key] == nil || generationIds[key] == generationId {
            streamTasks.removeValue(forKey: key)
            generationIds.removeValue(forKey: key)
        }
    }

    /// A reply frozen by Stop: no longer loading, marked stopped. The activity panel
    /// reads its open steps as stopped from that alone.
    private static func markStopped(_ message: inout Message) {
        message.isLoading = false
        message.stopReason = StopReasonNote.cancelled
    }

    private func latestInstruction() -> InstructionResponse? {
        guard let id = ai?.selectedInstructionId else { return nil }
        return auth?.customerInstructions.filter { $0.id == id }.max { $0.version < $1.version }
    }

    private func apply(_ metrics: AIUsageMetrics, to message: inout Message) {
        message.inputTokens = metrics.inputTokens
        message.outputTokens = metrics.outputTokens
        message.totalTokens = metrics.totalTokens
        message.tokensReadFromCache = metrics.tokensReadFromCache ?? 0
        message.costUsd = metrics.costUsd
    }

    private func runStream(
        token: String,
        config: AIConfig,
        blockId: String,
        placeholderMessageId: String,
        prompt: String,
        selectedResponseId: String,
        instructionId: String,
        instructionVersion: String,
        attachments: [AttachmentRef],
        regenerateMessageId: String?,
        explicitConversationId: String?,
        turnResponseCount: Int? = nil,
        onIdResolved: ((String) -> Void)?
    ) async throws {
        let key = "\(blockId)-\(config.aiVendor.rawValue)"
        let session = streamSession
        let cursor = ReplyCursor()
        let background = BackgroundTime("reply")
        defer { background.end() }
        var accumulatedText = ""
        var currentMessageId = placeholderMessageId
        var lastFlush = Date.distantPast
        let idToUse = explicitConversationId ?? conversationId

        let request = GenerateTextStreamRequest(
            aiConfig: config,
            prompt: Prompt(instructionId: instructionId, instructionVersion: instructionVersion, prompt: prompt, attachments: attachments),
            selectedResponseId: selectedResponseId,
            conversationId: idToUse,
            client: ClientID.app,
            agentId: ai?.effectiveAgentId,
            // Starting fresh inside a project: the new conversation is born in it.
            projectId: idToUse.isEmpty ? pendingProjectId : nil,
            regenerateMessageId: regenerateMessageId,
            generationId: generationIds[key],
            turnResponseCount: turnResponseCount
        )

        func update(_ transform: (inout Message) -> Void) {
            updateMessage(blockId: blockId, matching: [currentMessageId, placeholderMessageId], transform)
        }

        func flushText() {
            let text = accumulatedText
            update { $0.text = text }
            lastFlush = Date()
        }

        /// Finish THIS vendor's message only — on failure the streamed text is kept and
        /// the reason attached; other vendors' streams are untouched.
        func finish(error reason: String?, stopReason: String? = nil) {
            awaitingInputs.removeValue(forKey: currentMessageId)
            awaitingInputs.removeValue(forKey: placeholderMessageId)
            flushText()
            update {
                $0.isLoading = false
                if let reason { $0.error = reason }
                if let stopReason { $0.stopReason = stopReason }
            }
        }

        let callbacks = StreamCallbacks(
            onDelta: { chunk in
                accumulatedText += chunk
                // Coalesce token bursts: the markdown re-parse is per flush, not per token.
                if Date().timeIntervalSince(lastFlush) >= 0.04 { flushText() }
            },
            onContentReset: {
                // Streamed text was a tool-call preamble — it stays visible in the activity
                // log as the llm step's `reasoning`; clear and restart.
                accumulatedText = ""
                flushText()
            },
            onStopReason: { reason in update { $0.stopReason = reason } },
            onActivity: { event in update { $0.activity.append(event) } },
            onWebSources: { sources in update { $0.webSources = sources } },
            onGeneratedAttachments: { refs in
                update { message in
                    // Multiple "ga" events per turn are possible — merge by id.
                    let existing = message.generatedAttachments ?? []
                    message.generatedAttachments = existing + refs.filter { ref in !existing.contains { $0.attachmentId == ref.attachmentId } }
                }
            },
            onAwaitingInput: { [weak self] payload in self?.awaitingInputs[currentMessageId] = payload },
            onRun: { runId, elapsedMs in
                cursor.runId = runId
                if let elapsedMs { update { $0.runClock = RunClock(at: elapsedMs, receivedAt: Date()) } }
            },
            onSeq: { cursor.lastSeq = $0 }
        )

        let task = Task { [weak self] in
            try await GenerateTextStreamService.generateTextStream(
                token: token,
                request: request,
                onMetadata: { metadata in
                    guard let self else { return }
                    let sanitizedId = metadata.conversationId?.split(separator: ",").first.map { $0.trimmingCharacters(in: .whitespaces) }
                    guard self.streamSession == session else {
                        // Left before the server answered: the turn is taken, so the turn's other
                        // vendors still start in its conversation, and this client is done.
                        if let sanitizedId, !sanitizedId.isEmpty { onIdResolved?(sanitizedId) }
                        self.headersReceived.insert(key)
                        self.streamTasks[key]?.cancel()
                        return
                    }
                    if let sanitizedId, !sanitizedId.isEmpty, sanitizedId != self.conversationId {
                        self.conversationId = sanitizedId
                    }
                    // The server may have applied the customer's default instruction to a
                    // request that sent none — reflect it so the header shows it.
                    if let applied = metadata.instructionId, !applied.isEmpty, applied != self.ai?.selectedInstructionId {
                        self.ai?.selectedInstructionId = applied
                        if let instruction = self.auth?.customerInstructions.first(where: { $0.id == applied }) {
                            self.ai?.systemPrompt = instruction.instruction
                        }
                    }
                    self.updateMessage(blockId: blockId, matching: [currentMessageId]) { message in
                        if let previous = metadata.messageId { message.previousMessageId = previous }
                        if let response = metadata.responseMessageId { message.messageId = response }
                    }
                    if let response = metadata.responseMessageId { currentMessageId = response }
                    if let sanitizedId, !sanitizedId.isEmpty { onIdResolved?(sanitizedId) }

                    self.headersReceived.insert(key)
                    // Stopped before the headers: the request stayed open only for the ids above.
                    if self.stopRequested.contains(key) { self.streamTasks[key]?.cancel() }
                },
                callbacks: callbacks
            )
        }
        streamTasks[key] = task
        defer { generationIds.removeValue(forKey: key) }

        do {
            try await task.value
        } catch is CancellationError {
            // User stopped this vendor — keep whatever streamed, no error. The stop
            // reason keeps the card on screen even when nothing streamed yet.
            guard streamSession == session else { return }
            finish(error: nil, stopReason: StopReasonNote.cancelled)
            return
        } catch let error as URLError where error.code == .cancelled {
            guard streamSession == session else { return }
            finish(error: nil, stopReason: StopReasonNote.cancelled)
            return
        } catch Auth0Service.AuthError.loginRequired {
            throw Auth0Service.AuthError.loginRequired
        } catch where cursor.runId != nil && !(error is StreamGenerationError) {
            // The run keeps generating without this client (the app was suspended, the
            // network dropped): pick its stream up after the last event applied.
            flushText()
            let targetConversation = explicitConversationId ?? conversationId
            let resume = Task<Void, Error> { [weak self] in
                try await self?.follow(cursor, conversationId: targetConversation, callbacks: callbacks)
            }
            streamTasks[key] = resume
            do {
                try await resume.value
            } catch is CancellationError {
                guard streamSession == session else { return }
                finish(error: nil, stopReason: StopReasonNote.cancelled)
                return
            } catch {
                AppObservability.capture(error, context: ["where": "replyRecoveryFailed"])
                finish(error: (error as? StreamGenerationError)?.message ?? L("errors.ai.generateTextStreamFailed"))
                return
            }
            guard streamSession == session else { return }
            if !cursor.active, let saved = await fetchPersistedResponse(token: token, conversationId: targetConversation, messageId: currentMessageId) {
                accumulatedText = saved.text
                update { message in
                    message.webSources = saved.webSources ?? message.webSources
                    message.generatedAttachments = saved.generatedAttachments ?? message.generatedAttachments
                    message.stopReason = saved.stopReason ?? message.stopReason
                }
            }
        } catch {
            flushText()
            // No durable run to reattach to (the server fell back to a direct stream): it
            // still saves the reply, so poll for it once its response id is known.
            if currentMessageId != placeholderMessageId {
                let targetConversation = explicitConversationId ?? conversationId
                let attempts = Self.recoveryAttempts(after: error, streamedText: !accumulatedText.isEmpty)
                if let recovered = await recoverPersistedResponse(token: token, conversationId: targetConversation, messageId: currentMessageId, maxAttempts: attempts) {
                    accumulatedText = recovered.text
                    update { message in
                        message.webSources = recovered.webSources ?? message.webSources
                        message.generatedAttachments = recovered.generatedAttachments ?? message.generatedAttachments
                        message.inputTokens = recovered.inputTokens ?? message.inputTokens
                        message.outputTokens = recovered.outputTokens ?? message.outputTokens
                        message.totalTokens = recovered.totalTokens ?? message.totalTokens
                        message.costUsd = recovered.costUsd ?? message.costUsd
                    }
                    // A StreamGenerationError is the server saying generation failed: the
                    // text is whatever was salvaged, so still flag it. Anything else (a
                    // dropped connection while the run kept going) recovered a real answer.
                    finish(error: (error as? StreamGenerationError)?.message)
                    return
                }
            }
            let reason = (error as? StreamGenerationError)?.message ?? (error is StreamTruncatedError ? L("errors.ai.generateTextStreamFailed") : error.localizedDescription)
            finish(error: reason)
            return
        }

        flushText()

        // Post-stream: fetch final token usage + cost (not embedded in the stream).
        let finalConversationId = explicitConversationId ?? conversationId
        if !currentMessageId.isEmpty, !finalConversationId.isEmpty,
           let metrics = await AIUsageService.getAIUsageActivity(token: token, conversationId: finalConversationId, messageId: currentMessageId) {
            update { apply(metrics, to: &$0) }
        }
        update { $0.isLoading = false }
    }

    /// A `StreamGenerationError` is the server's final word, so nothing more is coming: it saves
    /// a response only when text streamed, and one look is enough to pick up that copy's usage
    /// and sources. A cut stream may still be generating.
    nonisolated static func recoveryAttempts(after error: Error, streamedText: Bool) -> Int {
        guard error is StreamGenerationError else { return 36 }
        return streamedText ? 1 : 0
    }

    /// Background recovery: the server keeps generating after a cut stream and persists
    /// the response under its deterministic id. Polls every 5s for up to 3 minutes.
    private func recoverPersistedResponse(token: String, conversationId: String, messageId: String, maxAttempts: Int = 36) async -> Message? {
        guard !conversationId.isEmpty else { return nil }
        for _ in 0..<maxAttempts {
            try? await Task.sleep(nanoseconds: 5_000_000_000)
            if let found = await fetchPersistedResponse(token: token, conversationId: conversationId, messageId: messageId) {
                return found
            }
        }
        return nil
    }

    /// The saved copy of a reply, if it has text yet.
    private func fetchPersistedResponse(token: String, conversationId: String, messageId: String) async -> Message? {
        guard !conversationId.isEmpty,
              let data = try? await ConversationService.getConversation(token: token, conversationId: conversationId) else { return nil }
        return data.blocks.flatMap(\.responseMessages).first { $0.messageId == messageId && !$0.text.isEmpty }
    }
}
