//
//  AI_WrapperApp.swift
//  AI Wrapper
//

import SwiftUI

@main
struct AI_WrapperApp: App {
    @StateObject private var auth = AuthStore()
    @StateObject private var ai = AIStore()
    @StateObject private var conversation = ConversationStore()
    @StateObject private var toasts = ToastCenter()
    @StateObject private var router = AppRouter()
    @AppStorage("theme") private var themeMode: ThemeMode = .system

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(auth)
                .environmentObject(ai)
                .environmentObject(conversation)
                .environmentObject(toasts)
                .environmentObject(router)
                .preferredColorScheme(themeMode.colorScheme)
                .tint(AppTheme.primary)
                .onAppear {
                    conversation.configure(auth: auth, ai: ai, toasts: toasts)
                    ai.attach(customerId: auth.customerId)
                    ai.applyPreferences(auth.aiConfigPreferences)
                    // Testability hooks (simctl launch arguments)
                    if CommandLine.arguments.contains("--open-menu") {
                        router.isMobileMenuOpen = true
                    }
                    if CommandLine.arguments.contains("--open-right-sidebar") {
                        router.isRightSidebarOpen = true
                    }
                    if CommandLine.arguments.contains("--mock-conversation") {
                        conversation.conversationTitle = "Sorting algorithms compared"
                        conversation.conversationId = "mock"
                        conversation.blocks = [
                            ConversationBlock(
                                conversationBlockId: "mock-1",
                                prompt: "Explain **quicksort** vs merge sort, with a Python example.",
                                responseMessages: [
                                    Message(
                                        aiVendor: .openai,
                                        text: "Quicksort partitions in place while merge sort splits and merges.\n\n```python\ndef quicksort(a):\n    if len(a) < 2:\n        return a\n```\n\nBoth run in `O(n log n)` on average.",
                                        messageId: "m1",
                                        thinkingSteps: ["Comparing time complexity", "Writing example"],
                                        inputTokens: 1204, outputTokens: 342, totalTokens: 1546, tokensReadFromCache: 512
                                    ),
                                    Message(
                                        aiVendor: .claude,
                                        text: "Merge sort is stable; quicksort usually isn't but has better constants.",
                                        messageId: "m2",
                                        inputTokens: 1180, outputTokens: 210, totalTokens: 1390
                                    ),
                                ],
                                isLoading: false,
                                status: .resolved
                            )
                        ]
                    }
                }
                .onChange(of: auth.customerId) { _, newValue in
                    ai.attach(customerId: newValue)
                }
                .onChange(of: auth.aiConfigPreferences?.preferredModels) { _, _ in
                    ai.applyPreferences(auth.aiConfigPreferences)
                }
                .onChange(of: ai.systemPrompt) { _, _ in ai.persistSelections() }
                .onChange(of: ai.selectedInstructionId) { _, _ in ai.persistSelections() }
        }
    }
}
