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
    @StateObject private var history = HistoryStore()
    @StateObject private var memories = MemoriesStore()
    @AppStorage("theme") private var themeMode: ThemeMode = .system
    @Environment(\.scenePhase) private var scenePhase

    init() {
        LegacyDefaults.removeStaleValues()
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(auth)
                .environmentObject(ai)
                .environmentObject(conversation)
                .environmentObject(toasts)
                .environmentObject(router)
                .environmentObject(history)
                .environmentObject(memories)
                .preferredColorScheme(themeMode.colorScheme)
                .tint(AppTheme.primary)
                .onAppear {
                    AppObservability.start()
                    conversation.configure(auth: auth, ai: ai, toasts: toasts, history: history)
                    history.configure(auth: auth, toasts: toasts)
                    memories.configure(auth: auth, history: history)
                    auth.onLogout = { [ai, conversation, history, memories] in
                        conversation.resetConversation()
                        history.clear()
                        memories.clear()
                        ai.attach(customerId: nil)
                    }
                    ai.attach(customerId: auth.customerId)
                    #if DEBUG
                    applyDebugAgentPick()
                    #endif
                    ai.applyPreferences(auth.aiConfigPreferences, statuses: auth.aiVendorAPIKeyStatusList)
                    #if DEBUG
                    // Headless capture: jump to a route via the `-route <name>` launch arg.
                    if let route = UserDefaults.standard.string(forKey: "route") {
                        switch route {
                        case "history": router.openWithL2Menu(.chat)
                        case "chat": router.navigate(.chat)
                        case "memory": router.navigate(.memory)
                        case "agents": router.navigate(.agents)
                        case "instructions": router.navigate(.instructions)
                        case "settings", "account": router.navigate(.settings(.account))
                        case "privacysettings": router.navigate(.settings(.privacy))
                        case "blocked": router.navigate(.settings(.blocked))
                        case "deletedata": router.navigate(.settings(.deleteData))
                        case "aikeys": router.navigate(.settings(.llmKeys))
                        case "embeddingkeys": router.navigate(.settings(.embeddingKeys))
                        case "vectordb": router.navigate(.settings(.vectorDb))
                        case "websearchkey": router.navigate(.settings(.webSearchKey))
                        case "defaults", "agents-defaults": router.navigate(.settings(.agents))
                        case "memorysettings": router.navigate(.settings(.memory))
                        case "searchindex": router.navigate(.settings(.searchIndex))
                        case "embeddingmodels": router.navigate(.settings(.embeddingModels))
                        case "usage": router.navigate(.settings(.usageLlm))
                        case "usageembedding": router.navigate(.settings(.usageEmbedding))
                        case "usagevectordb": router.navigate(.settings(.usageVectorDb))
                        case "usagewebsearch": router.navigate(.settings(.usageWebSearch))
                        case "tools": router.navigate(.settings(.tools))
                        case "connectors": router.navigate(.settings(.connectors))
                        case "developer": router.navigate(.settings(.developer))
                        case "settingsmenu": router.openWithL2Menu(.settings(.account))
                        case "privacy": router.navigate(.privacyPolicy)
                        case "support": router.navigate(.support)
                        default: break
                        }
                    }
                    // `-detailPage history|usage|edit` opens that child page of the instruction or memory below.
                    let detailPage = UserDefaults.standard.string(forKey: "detailPage")
                    if let insId = UserDefaults.standard.string(forKey: "instructionDetailId"), !insId.isEmpty {
                        switch detailPage {
                        case "history": router.navigate(.instructionHistory(insId))
                        case "usage": router.navigate(.instructionUsage(insId))
                        case "edit": router.navigate(.instructionEdit(insId))
                        default: router.navigate(.instructionDetail(insId))
                        }
                    }
                    if let memId = UserDefaults.standard.string(forKey: "memoryDetailId"), !memId.isEmpty {
                        switch detailPage {
                        case "history": router.navigate(.memoryHistory(memId))
                        case "usage": router.navigate(.memoryUsage(memId))
                        case "edit": router.navigate(.memoryEdit(memId))
                        default: router.navigate(.memoryDetail(memId))
                        }
                    }
                    if CommandLine.arguments.contains("--logout") { auth.logout() }
                    if CommandLine.arguments.contains("--show-onboarding") {
                        Task { @MainActor in
                            // Wait until onboard finishes (it sets onboardingCompleted
                            // from the server), THEN force the wizard open.
                            for _ in 0..<60 {
                                try? await Task.sleep(nanoseconds: 200_000_000)
                                if auth.isAuthenticated && !auth.isOnboarding { break }
                            }
                            try? await Task.sleep(nanoseconds: 400_000_000)
                            auth.onboardingCompleted = false
                        }
                    }
                    if CommandLine.arguments.contains("--show-ai-consent") {
                        Task { @MainActor in
                            for _ in 0..<60 {
                                try? await Task.sleep(nanoseconds: 200_000_000)
                                if auth.isAuthenticated && !auth.isOnboarding { break }
                            }
                            try? await Task.sleep(nanoseconds: 400_000_000)
                            auth.aiDataConsentRequired = true
                        }
                    }
                    if CommandLine.arguments.contains("--edit-first-agent") {
                        Task { @MainActor in
                            for _ in 0..<60 { if auth.isAuthenticated && !auth.isOnboarding { break }; try? await Task.sleep(nanoseconds: 200_000_000) }
                            if let token = try? await auth.getAccessTokenSilently() {
                                await ai.fetchAgents(token: token, version: auth.cacheVersions?["agents"])
                                if let first = ai.conversationAgents.first { router.navigate(.editAgent(first)) }
                            }
                        }
                    }
                    if CommandLine.arguments.contains("--open-instruction-picker") {
                        Task { @MainActor in
                            for _ in 0..<40 { if auth.isAuthenticated { break }; try? await Task.sleep(nanoseconds: 200_000_000) }
                            router.isAppMenuOpen = false
                            router.showInstructionPicker = true
                        }
                    }
                    // Headless capture: load a specific conversation via `-conversationId <id>`.
                    if let cid = UserDefaults.standard.string(forKey: "conversationId"), !cid.isEmpty {
                        router.navigate(.chat)
                        Task { await conversation.loadConversation(cid) }
                    }
                    // Headless capture: pre-fill the composer via `-draftText <string>`.
                    if let draft = UserDefaults.standard.string(forKey: "draftText"), !draft.isEmpty {
                        router.navigate(.chat)
                        conversation.editorPrompt = draft
                    }
                    // Headless capture: auto-send a prompt via `-autoGenerate <string>`
                    // once onboard + preferences settle, to exercise live streaming.
                    if let autoPrompt = UserDefaults.standard.string(forKey: "autoGenerate"), !autoPrompt.isEmpty {
                        router.navigate(.chat)
                        Task { @MainActor in
                            for _ in 0..<50 {
                                if auth.isAuthenticated && !ai.selectedConfigs.isEmpty { break }
                                try? await Task.sleep(nanoseconds: 200_000_000)
                            }
                            guard !ai.selectedConfigs.isEmpty else { return }
                            let blockId = conversation.blocks.last(where: { $0.status == .draft && !$0.isLoading })?.conversationBlockId
                                ?? conversation.addNewBlock()
                            conversation.editorPrompt = ""
                            await conversation.generateResponsesStream(blockId: blockId, overridePrompt: autoPrompt)
                        }
                    }
                    if CommandLine.arguments.contains("--open-menu") {
                        router.openWithL2Menu(router.route)
                    }
                    if CommandLine.arguments.contains("--open-right-sidebar") {
                        router.isAppMenuOpen = false
                        router.isRightSidebarOpen = true
                    }
                    if CommandLine.arguments.contains("--mock-conversation") {
                        router.navigate(.chat)
                        conversation.conversationTitle = "Sorting algorithms compared"
                        conversation.conversationId = "mock"
                        conversation.blocks = DebugFixtures.conversation
                    }
                    // Headless capture: one response card built from a shared activity
                    // fixture file (retrieval-server/tests/fixtures/activity/*.json).
                    if let path = UserDefaults.standard.string(forKey: "mockActivityFile"),
                       let data = FileManager.default.contents(atPath: path),
                       let fixture = JSONValue.parse(data) {
                        router.navigate(.chat)
                        conversation.conversationTitle = "Activity fixture"
                        conversation.conversationId = "mock"
                        conversation.blocks = [DebugFixtures.activityFixtureBlock(fixture)]
                    }
                    if CommandLine.arguments.contains("--mock-short-conversation") {
                        router.navigate(.chat)
                        conversation.conversationTitle = "Sorting algorithms compared"
                        conversation.conversationId = "mock"
                        conversation.blocks = DebugFixtures.shortConversation
                    }
                    if CommandLine.arguments.contains("--mock-two-turns") {
                        router.navigate(.chat)
                        conversation.conversationTitle = "Sorting algorithms compared"
                        conversation.conversationId = "mock"
                        conversation.blocks = DebugFixtures.twoTurnConversation
                    }
                    if CommandLine.arguments.contains("--mock-generating") {
                        conversation.blocks = conversation.blocks.map { block in
                            var block = block
                            block.status = .draft
                            block.isLoading = true
                            block.responseMessages = block.responseMessages.map { message in
                                var message = message
                                message.isLoading = true
                                return message
                            }
                            return block
                        }
                    }
                    if CommandLine.arguments.contains("--mock-project-chat") {
                        router.navigate(.chat)
                        history.projects = [Project(projectId: "mock-project", name: "Startup")]
                        conversation.startConversationInProject("mock-project")
                    }
                    if CommandLine.arguments.contains("--mock-new-chat") {
                        router.navigate(.chat)
                    }
                    // The editor as a signed-in user sees it: an instruction on its chip and a
                    // valid key, so send lights up once there is a draft
                    if CommandLine.arguments.contains("--mock-instruction") {
                        let instruction = InstructionResponse(id: "mock-instruction", version: 1, name: "General Purpose Assistant", instruction: "", icon: "🔍📋")
                        auth.customerInstructions = [instruction]
                        ai.selectedInstructionId = instruction.id
                        auth.aiVendorAPIKeyStatusList = [AIVendorAPIKeyStatus(aiVendor: "OPENAI", isAPIKeyValid: true)]
                    }
                    #endif
                }
                .onChange(of: auth.customerId) { _, newValue in
                    ai.attach(customerId: newValue)
                    #if DEBUG
                    applyDebugAgentPick()
                    #endif
                }
                .onChange(of: auth.aiConfigPreferences?.preferredModels) { _, _ in
                    ai.applyPreferences(auth.aiConfigPreferences, statuses: auth.aiVendorAPIKeyStatusList)
                }
                .onChange(of: auth.customerId) { _, _ in
                    ai.applyPreferences(auth.aiConfigPreferences, statuses: auth.aiVendorAPIKeyStatusList)
                }
                .onChange(of: auth.aiConfigPreferences?.preferredAgentId) { _, _ in
                    ai.applyPreferences(auth.aiConfigPreferences, statuses: auth.aiVendorAPIKeyStatusList)
                }
                .onChange(of: ai.systemPrompt) { _, _ in ai.persistSelections() }
                .onChange(of: ai.selectedInstructionId) { _, _ in ai.persistSelections() }
                .onChange(of: ai.selectedAgentId) { _, _ in ai.persistSelections() }
                .onOpenURL { url in handleDeepLink(url) }
                .onChange(of: scenePhase) { previous, phase in
                    if phase == .active, previous == .background {
                        Task { await auth.checkSessionOnReturn() }
                    }
                }
        }
    }

    #if DEBUG
    /// Headless capture: this device's agent pick, via `-debugSelectedAgentId <id>`.
    private func applyDebugAgentPick() {
        guard auth.customerId != nil,
              let agentId = UserDefaults.standard.string(forKey: "debugSelectedAgentId"),
              !agentId.isEmpty else { return }
        ai.selectedAgentId = agentId
    }
    #endif

    /// Open a shared-conversation deep link: `<web-host>/chat/<id>` (universal
    /// link) or the custom callback scheme. Routes to chat and loads the id.
    private func handleDeepLink(_ url: URL) {
        let parts = url.pathComponents.filter { $0 != "/" }
        // …/chat/<conversationId>
        if let chatIdx = parts.firstIndex(of: "chat"), chatIdx + 1 < parts.count {
            let conversationId = parts[chatIdx + 1]
            router.navigate(.chat)
            Task { await conversation.loadConversation(conversationId) }
        }
    }
}
