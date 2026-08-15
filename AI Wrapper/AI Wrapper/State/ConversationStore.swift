import Foundation
import SwiftUI
import Combine

/// Mirrors src/context/ConversationContext.tsx — the block list, streaming
/// generation with per-vendor cancellation, conversation load/reset, titles.
@MainActor
final class ConversationStore: ObservableObject {
    @Published var conversationId: String = ""
    @Published var conversationTitle: String?
    @Published var conversationRole: ConversationRole = .owner
    @Published var blocks: [ConversationBlock] = [ConversationStore.defaultBlock()]
    @Published var selectedResponseByBlock: [String: String] = [:]
    /// Active draft text (web: ConversationContext.editorPrompt) — feeds the TokenCounter.
    @Published var editorPrompt: String = ""
    /// Per-block vendor visibility (web: vendorSelectionByBlock; mobile shows one at a time).
    @Published var vendorSelectionByBlock: [String: [String]] = [:]

    func getVendorSelection(for blockId: String) -> [String] {
        vendorSelectionByBlock[blockId] ?? []
    }

    func setVendorSelection(for blockId: String, vendors: [String]) {
        vendorSelectionByBlock[blockId] = vendors
    }

    private var streamTasks: [String: Task<Void, Error>] = [:]

    private weak var auth: AuthStore?
    private weak var ai: AIStore?
    private weak var toasts: ToastCenter?

    func configure(auth: AuthStore, ai: AIStore, toasts: ToastCenter) {
        self.auth = auth
        self.ai = ai
        self.toasts = toasts
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

    // MARK: - Stop

    func stopGenerating(blockId: String? = nil, vendor: AIVendor? = nil) {
        let targets = streamTasks.filter { key, _ in
            guard let blockId else { return true }
            if let vendor { return key == "\(blockId)-\(vendor.rawValue)" }
            return key.hasPrefix("\(blockId)-")
        }
        for (key, task) in targets {
            task.cancel()
            streamTasks.removeValue(forKey: key)
        }
    }

    // MARK: - Load / reset

    func loadConversation(_ id: String) async {
        guard let auth else { return }
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
            ai?.selectedInstructionId = data.instructionId?.isEmpty == false ? data.instructionId : nil
        } catch let error as APIError where error.status == 403 {
            toasts?.showToast("You do not have access to this conversation")
            resetConversation()
        } catch {
            // Failed to load conversation — keep current state
        }
    }

    func resetConversation() {
        stopGenerating()
        if let customerId = auth?.customerId {
            let defaults = UserDefaults.standard
            for key in defaults.dictionaryRepresentation().keys
            where key.hasPrefix("\(customerId)_prompt_editor_content_") {
                defaults.removeObject(forKey: key)
            }
        }
        conversationId = ""
        blocks = [Self.defaultBlock()]
        selectedResponseByBlock = [:]
        conversationTitle = nil
        conversationRole = .owner
    }

    // MARK: - Generation

    private struct GenerationPrep {
        var aiConfigs: [AIConfig]
        var selectedResponseId: String
        var prompt: String
    }

    private func validateAndPrepare(_ id: String, overridePrompt: String?, selectedMessageId: String?) -> GenerationPrep? {
        guard let auth, let ai, let block = blocks.first(where: { $0.conversationBlockId == id }) else { return nil }
        guard auth.isAuthenticated else {
            toasts?.showToast("Please log in first.")
            return nil
        }
        let aiConfigs = ai.selectedConfigs
        guard !aiConfigs.isEmpty else {
            toasts?.showToast("Select at least one vendor and model.")
            return nil
        }

        // Parent response: selection stored on this block (follow-up), else the
        // previous block's selection, else its first response.
        var parentResponseId = ""
        if let index = blocks.firstIndex(where: { $0.conversationBlockId == id }), index > 0 {
            let prevBlock = blocks[index - 1]
            if let currentSelected = getSelectedResponse(for: id) {
                parentResponseId = currentSelected
            } else if let prevSelected = getSelectedResponse(for: prevBlock.conversationBlockId) {
                parentResponseId = prevSelected
            } else if let first = prevBlock.responseMessages.first {
                parentResponseId = first.messageId
            }
        }

        let finalSelectedResponseId = selectedMessageId ?? parentResponseId
        return GenerationPrep(
            aiConfigs: aiConfigs,
            selectedResponseId: finalSelectedResponseId,
            prompt: overridePrompt ?? block.prompt
        )
    }

    func generateResponsesStream(
        blockId id: String,
        overridePrompt: String? = nil,
        selectedMessageId: String? = nil,
        vendorToRegenerate: AIVendor? = nil
    ) async {
        guard let auth, let ai, let prep0 = validateAndPrepare(id, overridePrompt: overridePrompt, selectedMessageId: selectedMessageId) else { return }
        var prep = prep0

        if let vendor = vendorToRegenerate {
            prep.aiConfigs = prep.aiConfigs.filter { $0.aiVendor == vendor }
            guard !prep.aiConfigs.isEmpty else {
                toasts?.showToast("Please select a valid model for \(vendor.rawValue) first.")
                return
            }
        }

        let timestamp = Int(Date().timeIntervalSince1970 * 1000)
        var initialMessages: [Message] = []

        updateBlock(id) { block in
            if let vendor = vendorToRegenerate {
                let newMessage = Message(aiVendor: vendor, text: "", messageId: "resp-\(timestamp)-regen", isLoading: true)
                if let existing = block.responseMessages.firstIndex(where: { $0.aiVendor == vendor }) {
                    block.responseMessages[existing] = newMessage
                } else {
                    block.responseMessages.append(newMessage)
                }
                initialMessages = [newMessage]
            } else {
                let newMessages = prep.aiConfigs.enumerated().map { index, config in
                    Message(aiVendor: config.aiVendor, text: "", messageId: "resp-\(timestamp)-\(index)", isLoading: true)
                }
                block.responseMessages = newMessages
                initialMessages = newMessages
            }
            block.isLoading = true
            block.prompt = prep.prompt
        }

        do {
            let token = try await auth.getAccessTokenSilently()
            let instruction = auth.customerInstructions.first { $0.id == ai.selectedInstructionId }
            let instructionId = ai.selectedInstructionId ?? ""
            let instructionVersion = instruction.map { String($0.version) } ?? ""

            let currentConversationId = conversationId

            if !currentConversationId.isEmpty {
                // Existing conversation: all vendors stream in parallel.
                try await withThrowingTaskGroup(of: Void.self) { group in
                    for (index, config) in prep.aiConfigs.enumerated() {
                        group.addTask { @MainActor [weak self] in
                            try await self?.runStream(
                                token: token, config: config, blockId: id,
                                placeholderMessageId: initialMessages[index].messageId,
                                prompt: prep.prompt, selectedResponseId: prep.selectedResponseId,
                                instructionId: instructionId, instructionVersion: instructionVersion,
                                explicitConversationId: currentConversationId, onIdResolved: nil
                            )
                        }
                    }
                    try await group.waitForAll()
                }
            } else {
                // New conversation: sequential smart start — first stream resolves
                // the conversation id, then the title fires and the rest launch.
                var resolvedIdHandler: ((String) -> Void)?
                var resolvedId: String?

                let idStream = AsyncStream<String?> { continuation in
                    resolvedIdHandler = { continuation.yield($0); continuation.finish() }
                }

                let firstConfig = prep.aiConfigs[0]
                let firstTask = Task { @MainActor [weak self] in
                    defer { resolvedIdHandler?("") }
                    try await self?.runStream(
                        token: token, config: firstConfig, blockId: id,
                        placeholderMessageId: initialMessages[0].messageId,
                        prompt: prep.prompt, selectedResponseId: prep.selectedResponseId,
                        instructionId: instructionId, instructionVersion: instructionVersion,
                        explicitConversationId: nil,
                        onIdResolved: { resolvedIdHandler?($0) }
                    )
                }

                for await value in idStream {
                    resolvedId = value
                    break
                }

                if let newId = resolvedId, !newId.isEmpty {
                    // Fire-and-forget title generation
                    let titlePrompt = prep.prompt
                    let instructionName = instruction?.name
                    Task { @MainActor [weak self] in
                        if let response = try? await CreateConversationTitleService.createConversationTitle(
                            token: token,
                            request: CreateConversationTitleRequest(conversationId: newId, prompt: titlePrompt, instructionName: instructionName)
                        ), let title = response.title {
                            self?.conversationTitle = title
                        }
                    }

                    if prep.aiConfigs.count > 1 {
                        try? await Task.sleep(nanoseconds: 200_000_000)
                        try await withThrowingTaskGroup(of: Void.self) { group in
                            for index in 1..<prep.aiConfigs.count {
                                let config = prep.aiConfigs[index]
                                let messageId = initialMessages[index].messageId
                                group.addTask { @MainActor [weak self] in
                                    try await self?.runStream(
                                        token: token, config: config, blockId: id,
                                        placeholderMessageId: messageId,
                                        prompt: prep.prompt, selectedResponseId: prep.selectedResponseId,
                                        instructionId: instructionId, instructionVersion: instructionVersion,
                                        explicitConversationId: newId, onIdResolved: nil
                                    )
                                }
                            }
                            try await group.waitForAll()
                        }
                    }
                }
                try await firstTask.value
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
            updateBlock(id) { block in
                block.isLoading = false
                block.status = .draft
            }
            toasts?.showToast("Session expired. Your draft is saved — log in to continue.")
            auth.logout()
        } catch {
            updateBlock(id) { block in
                block.responseMessages = [Message(aiVendor: .openai, text: "Error generating text stream.", messageId: "error")]
                block.isLoading = false
                block.status = .resolved
            }
        }

        for config in prep.aiConfigs {
            streamTasks.removeValue(forKey: "\(id)-\(config.aiVendor.rawValue)")
        }
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
        explicitConversationId: String?,
        onIdResolved: ((String) -> Void)?
    ) async throws {
        let key = "\(blockId)-\(config.aiVendor.rawValue)"
        var accumulatedText = ""
        var currentMessageId = placeholderMessageId

        let request = GenerateTextStreamRequest(
            aiConfig: config,
            prompt: Prompt(instructionId: instructionId, instructionVersion: instructionVersion, prompt: prompt),
            selectedResponseId: selectedResponseId,
            conversationId: explicitConversationId ?? conversationId,
            client: ClientID.app
        )

        let task = Task { @MainActor [weak self] in
            try await GenerateTextStreamService.generateTextStream(
                token: token,
                request: request,
                onDelta: { chunk in
                    accumulatedText += chunk
                    let text = accumulatedText
                    let ids: Set<String> = [currentMessageId, placeholderMessageId]
                    Task { @MainActor in
                        self?.updateMessage(blockId: blockId, matching: ids) { $0.text = text }
                    }
                },
                onMetadata: { metadata in
                    Task { @MainActor in
                        guard let self else { return }
                        if let newConversationId = metadata.conversationId?.split(separator: ",").first.map({ $0.trimmingCharacters(in: .whitespaces) }),
                           !newConversationId.isEmpty, newConversationId != self.conversationId {
                            self.conversationId = newConversationId
                        }
                        let targetIds: Set<String> = [currentMessageId, placeholderMessageId]
                        self.updateMessage(blockId: blockId, matching: targetIds) { message in
                            if let previousId = metadata.messageId { message.previousMessageId = previousId }
                            if let responseId = metadata.responseMessageId { message.messageId = responseId }
                        }
                        if let responseId = metadata.responseMessageId {
                            currentMessageId = responseId
                        }
                        if let newConversationId = metadata.conversationId, !newConversationId.isEmpty {
                            onIdResolved?(newConversationId)
                        }
                    }
                },
                onThinking: { step in
                    let ids: Set<String> = [currentMessageId, placeholderMessageId]
                    Task { @MainActor in
                        self?.updateMessage(blockId: blockId, matching: ids) { $0.thinkingSteps.append(step) }
                    }
                }
            )
        }
        streamTasks[key] = task

        do {
            try await task.value
        } catch is CancellationError {
            // Stopped by the user — fall through to finalize the message
        }

        // Post-stream: fetch final token usage (tokens are not embedded in the stream)
        let finalConversationId = explicitConversationId ?? conversationId
        if !currentMessageId.isEmpty, !finalConversationId.isEmpty {
            if let metrics = await AIUsageService.getAIUsageActivity(token: token, conversationId: finalConversationId, messageId: currentMessageId) {
                updateMessage(blockId: blockId, matching: [currentMessageId, placeholderMessageId]) { message in
                    message.inputTokens = metrics.inputTokens
                    message.outputTokens = metrics.outputTokens
                    message.totalTokens = metrics.totalTokens
                    message.tokensReadFromCache = metrics.tokensReadFromCache ?? 0
                }
            }
        }

        updateMessage(blockId: blockId, matching: [currentMessageId, placeholderMessageId]) { $0.isLoading = false }
    }
}
