#if DEBUG
import Foundation
import SwiftUI

/// Canned content for `--mock-conversation` launches (no backend or token involved).
enum DebugFixtures {
    /// `--mock-search`: canned results, for accounts whose search returns nothing.
    static var searchResults: [SearchResultItem]? {
        guard CommandLine.arguments.contains("--mock-search") else { return nil }
        return [
            SearchResultItem(type: "conversation", key: "mock-1", title: "Extract PDF Text and Image Count", snippet: "Here is the text extracted from the PDF, with 4 images found on pages 2 and 3."),
            SearchResultItem(type: "conversation", key: "mock-2", title: nil, snippet: "A second match with no title, whose snippet is long enough to run past the edge of the row")
        ]
    }

    static var conversation: [ConversationBlock] {
        [
            ConversationBlock(
                conversationBlockId: "mock-1",
                prompt: "explain **quicksort** vs merge sort, with a Python example.",
                responseMessages: [
                    Message(
                        aiVendor: .openai,
                        text: """
                        ## Comparison

                        Quicksort partitions in place while merge sort splits and merges. Both run in `O(n log n)` on average, per [1].

                        - **Quicksort** is usually faster
                        - **Merge sort** is stable
                          - nested point

                        1. First item
                        2. Second item

                        > A quoted remark about sorting.

                        ```python
                        # Quicksort: average O(n log n)
                        def quicksort(items: list[int]) -> list[int]:
                            if len(items) < 2:
                                return items
                            pivot = items[len(items) // 2]
                            return quicksort([x for x in items if x < pivot]) + [pivot]
                        ```

                        | Algorithm | Stable | Worst case |
                        |---|---|---|
                        | Quicksort | No | O(n²) |
                        | Merge sort | Yes | O(n log n) |

                        | Metric | Purpose |
                        |---|---|
                        | Accuracy | Overall performance |
                        | Recall | Rare classes |

                        Euler: $$e^{i\\pi} + 1 = 0$$ inline.

                        $$
                        \\int_0^1 x^2 dx = \\frac{1}{3}
                        $$

                        ---

                        Done.
                        """,
                        messageId: "m1",
                        activity: DebugFixtures.sortingActivity,
                        webSources: [WebSource(index: 1, title: "Sorting algorithms overview", url: "https://example.com/sort")],
                        generatedAttachments: [AttachmentRef(attachmentId: "a1", s3Key: nil, mediaType: "application/pdf", filename: "report.pdf", sizeBytes: 15417)],
                        inputTokens: 4819, outputTokens: 326, totalTokens: 5145, tokensReadFromCache: 2099, costUsd: 0.0205,
                        model: "gpt-5.6-sol",
                        learnedFacts: .known([])
                    ),
                    Message(
                        aiVendor: .claude,
                        text: "Merge sort is stable; quicksort usually isn't but has better constants.",
                        messageId: "m2",
                        inputTokens: 1180, outputTokens: 210, totalTokens: 1390,
                        model: "claude-fable-5",
                        learnedFacts: .known([])
                    )
                ],
                isLoading: false,
                status: .resolved,
                sentAt: Date(timeIntervalSince1970: 1793500000)
            )
        ]
    }

    /// `--mock-short-conversation`: one turn whose only response is a line long.
    static var shortConversation: [ConversationBlock] {
        conversation.map { block in
            var block = block
            block.responseMessages = Array(block.responseMessages.suffix(1))
            return block
        }
    }

    /// `--mock-two-turns`: the turn asked again, its responses several screens long and the
    /// second half as long as the first, for swipes from deep inside a response.
    static var twoTurnConversation: [ConversationBlock] {
        conversation + conversation.map { block in
            var block = block
            let text = block.responseMessages.first?.text ?? ""
            block.conversationBlockId += "-again"
            block.responseMessages = block.responseMessages.enumerated().map { index, message in
                var message = message
                message.messageId += "-again"
                message.text = Array(repeating: text, count: index == 0 ? 4 : 2).joined(separator: "\n\n")
                return message
            }
            return block
        }
    }
}
/// Headless capture: lands the conversation at `-debugScrollY <n>` once it has rendered and logs
/// the content height, so a long response can be compared against the web at the same offset.
struct DebugConversationScroll: ViewModifier {
    @State private var position = ScrollPosition()

    func body(content: Content) -> some View {
        let target = UserDefaults.standard.double(forKey: "debugScrollY")
        if UserDefaults.standard.object(forKey: "debugScrollY") == nil {
            content
        } else {
            content
                .scrollPosition($position)
                .onScrollGeometryChange(for: CGFloat.self) { $0.contentSize.height } action: { _, height in
                    print("DEBUG content height", height)
                }
                .task {
                    for _ in 0..<4 {
                        try? await Task.sleep(nanoseconds: 2_500_000_000)
                        position.scrollTo(y: target)
                    }
                }
        }
    }
}

extension DebugFixtures {
    /// A one-response turn from a shared activity fixture: its log, live state,
    /// stop reason and cited sources, with a short placeholder answer.
    static func activityFixtureBlock(_ fixture: JSONValue) -> ConversationBlock {
        let live = fixture["live"]?.boolean ?? false
        let stopped = fixture["stop_reason"]?.string
        var message = Message(
            aiVendor: .openai,
            text: live || stopped != nil ? "" : "Two of the three had no buyer data. CCM billing is used by under 5% of eligible practices [1].",
            messageId: "fixture-1",
            isLoading: live
        )
        message.activity = fixture["events"]?.array?.compactMap(ActivityEvent.init(json:)) ?? []
        message.webSources = fixture["web_sources"]?.array?.compactMap(WebSource.init(json:)) ?? []
        message.stopReason = stopped
        message.model = "gpt-5.4-nano"
        return ConversationBlock(
            conversationBlockId: "fixture-block",
            prompt: "Those three wedges were guesses. Which of them actually have buyer data?",
            responseMessages: [message],
            isLoading: live,
            status: live ? .draft : .resolved
        )
    }

    /// Streams a shared activity fixture into a one-response turn: each event at its `at`, the
    /// answer's text from its `step.writing` on, then the turn ends.
    @MainActor static func replayActivity(_ fixture: JSONValue, into conversation: ConversationStore) {
        let events = fixture["events"]?.array?.compactMap(ActivityEvent.init(json:)) ?? []
        let answer = Array(repeating: "Two of the three had no buyer data. CCM billing is used by under 5% of eligible practices [1], and the funded vendors sell to larger groups.", count: 12).joined(separator: "\n\n")
        var block = activityFixtureBlock(fixture)
        block.isLoading = true
        block.status = .draft
        block.responseMessages[0].isLoading = true
        block.responseMessages[0].text = ""
        block.responseMessages[0].activity = []
        conversation.blocks = [block]
        Task { @MainActor in
            var last = 0
            var writing = false
            for event in events {
                let at = event.at ?? last
                try? await Task.sleep(for: .milliseconds(max(0, at - last)))
                last = at
                writing = writing || event.type == .stepWriting
                conversation.blocks[0].responseMessages[0].activity.append(event)
                if writing { conversation.blocks[0].responseMessages[0].text = String(answer.prefix(400)) }
            }
            try? await Task.sleep(for: .milliseconds(500))
            conversation.blocks[0].responseMessages[0].text = answer
            conversation.blocks[0].responseMessages[0].isLoading = false
            conversation.blocks[0].isLoading = false
            conversation.blocks[0].status = .resolved
        }
    }

    /// A short activity log for the fixture conversation: memory, one search, the answer.
    static let sortingActivity: [ActivityEvent] = [
        #"{"v":2,"at":0,"type":"turn.start"}"#,
        #"{"v":2,"at":0,"type":"step.start","id":"m:1","kind":"memory","node":"m","name":"Memory"}"#,
        #"{"v":2,"at":300,"type":"step.end","id":"m:1","kind":"memory","node":"m","name":"Memory","duration_ms":300,"counts":{"core":2,"recalled":0},"memories":{"core":["Prefers short answers.","Writes Swift and TypeScript."],"recalled":[]}}"#,
        #"{"v":2,"at":300,"type":"step.start","id":"g:1","kind":"llm","node":"g","name":"Agent"}"#,
        #"{"v":2,"at":1500,"type":"step.end","id":"g:1","kind":"llm","node":"g","name":"Agent","duration_ms":1200,"outcome":"tool_calls","reasoning":"I'll check a current overview before comparing.","tool_calls":[{"id":"c1","name":"web_search","args":{"purpose":"Find a current overview of sorting algorithms.","query":"sorting algorithms overview"}}]}"#,
        #"{"v":2,"at":1500,"type":"step.start","id":"t:1","kind":"tools","node":"t","name":"Tools"}"#,
        #"{"v":2,"at":2900,"type":"step.end","id":"t:1","kind":"tools","node":"t","name":"Tools","duration_ms":1400,"calls":[{"id":"c1","seq":1,"name":"web_search","args":{"purpose":"Find a current overview of sorting algorithms.","query":"sorting algorithms overview"},"mode":"run","duration_ms":1300,"result_count":1,"sources":[{"index":1,"title":"Sorting algorithms overview","url":"https://example.com/sort"}]}],"budget":{"used":1,"max":5}}"#,
        #"{"v":2,"at":2900,"type":"step.start","id":"g:2","kind":"llm","node":"g","name":"Agent"}"#,
        #"{"v":2,"at":3600,"type":"step.progress","id":"g:2","first_token_ms":700}"#,
        #"{"v":2,"at":5174,"type":"step.end","id":"g:2","kind":"llm","node":"g","name":"Agent","duration_ms":2274,"outcome":"answer","first_token_ms":700}"#,
        #"{"v":2,"at":5174,"type":"turn.end","duration_ms":5174,"outcome":"completed","cited":[1]}"#,
    ].compactMap { JSONValue.parse($0).flatMap(ActivityEvent.init(json:)) }
}

#endif
