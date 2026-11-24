import CoreGraphics
import Foundation
import Testing
@testable import AI_Wrapper

struct ChatOutlineTests {
    private func block(_ id: String, status: BlockStatus = .resolved, isLoading: Bool = false, vendors: [AIVendor] = [], sentAt: Date? = nil) -> ConversationBlock {
        ConversationBlock(
            conversationBlockId: id,
            prompt: "Prompt \(id)",
            responseMessages: vendors.enumerated().map { index, vendor in
                Message(aiVendor: vendor, text: "answer", messageId: "\(id)-\(index)")
            },
            isLoading: isLoading,
            status: status,
            sentAt: sentAt
        )
    }

    private let names: (String) -> String = { ["OPENAI": "OpenAI", "CLAUDE": "Anthropic"][$0] ?? $0 }

    @Test func aTurnsPromptIsOnePlainLine() {
        #expect(ChatOutline.plainPrompt("explain **quicksort** vs *merge sort* and `heapq` ~~now~~") == "explain quicksort vs merge sort and heapq now")
        #expect(ChatOutline.plainPrompt("__bold__ and _italic_") == "bold and italic")
        // Marks inside words and lone ones stay
        #expect(ChatOutline.plainPrompt("rename my_var_name and compute 2*3*4") == "rename my_var_name and compute 2*3*4")
        #expect(ChatOutline.plainPrompt("a * b") == "a * b")
        #expect(ChatOutline.plainPrompt("# Plan\n> quoted line\n\n```ts\nconst x = 1\n```\nsee [the docs](https://example.com)") == "Plan quoted line const x = 1 see the docs")
        #expect(ChatOutline.plainPrompt("Add a day trip to Nara") == "Add a day trip to Nara")
    }

    @Test func numbersTheSentTurnsAndLeavesOutTheEmptyEditor() {
        let now = Date()
        let items = ChatOutline.items(
            blocks: [
                block("b1", vendors: [.claude], sentAt: now),
                block("b2", vendors: [.claude, .openai]),
                block("b3", status: .draft),
            ],
            vendorName: names,
            now: now
        )
        #expect(items.map(\.id) == ["b1", "b2"])
        #expect(items.map(\.number) == [1, 2])
        #expect(items[0].meta == "1 response · Anthropic · \(ServerDate.time(now))")
        #expect(items[1].meta == "2 responses · Anthropic, OpenAI")
    }

    @Test func aStreamingTurnShowsItsVendorsAndIsMarkedGenerating() {
        let items = ChatOutline.items(blocks: [block("b1", status: .draft, isLoading: true, vendors: [.openai])], vendorName: names)
        #expect(items.first?.isGenerating == true)
        #expect(items.first?.meta == "OpenAI")
    }

    @Test func anOlderTurnShowsItsDate() throws {
        let sent = try #require(ServerDate.parse("2026-09-19T13:58:00Z"))
        let items = ChatOutline.items(blocks: [block("b1", vendors: [.openai], sentAt: sent)], vendorName: names, now: sent.addingTimeInterval(3 * 86_400))
        #expect(items.first?.meta.contains("2026") == true)
    }

    @Test func theTurnInViewIsCurrentElseTheLastTurn() {
        let items = ChatOutline.items(blocks: [block("b1"), block("b2")], vendorName: names)
        #expect(ChatOutline.currentId(items: items, viewedId: "b1") == "b1")
        #expect(ChatOutline.currentId(items: items, viewedId: "draft") == "b2")
        #expect(ChatOutline.currentId(items: items, viewedId: nil) == "b2")
        #expect(ChatOutline.currentId(items: [], viewedId: "b1") == nil)
    }

    @Test func theViewedBlockIsTheLastToPassThirtyPercentDown() {
        let tops: [(id: String, top: CGFloat)] = [("b1", 0), ("b2", 800), ("b3", 1600)]
        #expect(ChatOutline.viewedBlockId(blockTops: tops, scrollOffset: 0, viewportHeight: 1000) == "b1")
        #expect(ChatOutline.viewedBlockId(blockTops: tops, scrollOffset: 600, viewportHeight: 1000) == "b2")
        #expect(ChatOutline.viewedBlockId(blockTops: tops, scrollOffset: 1400, viewportHeight: 1000) == "b3")
        #expect(ChatOutline.viewedBlockId(blockTops: [], scrollOffset: 0, viewportHeight: 1000) == nil)
    }

    @Test func usageIsSummedPerVendorInFirstAnswerOrder() {
        var first = Message(aiVendor: .openai, text: "a", messageId: "m1")
        first.inputTokens = 1200; first.outputTokens = 300; first.totalTokens = 1500; first.tokensReadFromCache = 0; first.costUsd = 0.0012
        var second = Message(aiVendor: .claude, text: "b", messageId: "m2")
        second.inputTokens = 900; second.outputTokens = 200; second.totalTokens = 1100; second.tokensReadFromCache = 512
        var third = Message(aiVendor: .openai, text: "c", messageId: "m3")
        third.inputTokens = 1800; third.outputTokens = 400; third.totalTokens = 2200; third.tokensReadFromCache = 1024; third.costUsd = 0.002
        let streaming = Message(aiVendor: .gemini, text: "", messageId: "m4", isLoading: true)
        let blocks = [
            ConversationBlock(conversationBlockId: "b1", prompt: "Q1", responseMessages: [first, second], isLoading: false, status: .resolved),
            ConversationBlock(conversationBlockId: "b2", prompt: "Q2", responseMessages: [third, streaming], isLoading: false, status: .resolved),
        ]

        let usage = VendorUsage.byVendor(blocks)
        #expect(usage.map(\.vendor) == [.openai, .claude])
        #expect(usage[0].totals.inputTokens == 3000)
        #expect(usage[0].totals.tokensReadFromCache == 1024)
        #expect(usage[0].totals.totalTokens == 3700)
        #expect(abs((usage[0].totals.costUsd ?? 0) - 0.0032) < 0.000_000_1)
        #expect(usage[1].totals.costUsd == nil)
        #expect(VendorUsage.byVendor([]).isEmpty)
    }
}

@MainActor
struct EditorAfterLastTurnTests {
    private func resolved(_ id: String) -> ConversationBlock {
        ConversationBlock(conversationBlockId: id, prompt: "Q", responseMessages: [Message(aiVendor: .openai, text: "a", messageId: "\(id)-m")], isLoading: false, status: .resolved)
    }

    @Test func aFinishedLastTurnGetsOneEmptyEditorAfterIt() {
        let store = ConversationStore()
        store.blocks = [resolved("b1")]
        store.ensureTrailingDraft()
        #expect(store.blocks.count == 2)
        #expect(store.trailingDraft != nil)
        store.ensureTrailingDraft()
        #expect(store.blocks.count == 2)
    }

    @Test func aTurnGetsItsEditorAsSoonAsItStartsGenerating() {
        let store = ConversationStore()
        var streaming = resolved("b1")
        streaming.status = .draft
        streaming.isLoading = true
        store.blocks = [streaming]
        store.ensureTrailingDraft()
        #expect(store.blocks.count == 2)
        #expect(store.trailingDraft != nil)
    }

    @Test func nothingIsAddedForAViewOnlyViewer() {
        let store = ConversationStore()
        store.blocks = [resolved("b1")]
        store.conversationRole = .view
        store.ensureTrailingDraft()
        #expect(store.blocks.count == 1)
    }

    @Test func aNewChatKeepsItsSingleEditor() {
        let store = ConversationStore()
        store.ensureTrailingDraft()
        #expect(store.blocks.count == 1)
    }
}
