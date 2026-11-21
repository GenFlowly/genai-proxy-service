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
                        thinkingStepList: [
                            { var s = ThinkingStep(node: "n1", name: "Memory", kind: "MEMORY"); s.detail = "Applied 2 core memori(es)"; s.memoriesCore = ["Lives in Bothell"]; return s }(),
                            { var s = ThinkingStep(node: "n2", name: "Tools", kind: "TOOL"); s.detail = "Executed 1 tool(s)"; s.calls = [ThinkingStepToolCall(name: "web_search", args: [("query", .string("sorting")), ("days", .number("30"))], sources: [WebSource(index: 1, title: "Sorting", url: "https://example.com/sort")])]; return s }()
                        ],
                        thinkingDurationMs: 5174,
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

#endif
