import Testing
import Foundation
import SwiftUI
@testable import AI_Wrapper

// MARK: - Project rename and delete (conversationHistoryService.test.ts, historyCache)

@Suite("History projects")
@MainActor
struct HistoryProjectTests {
    private func store() -> HistoryStore {
        let history = HistoryStore()
        history.projects = [Project(projectId: "PRJa", name: "Startup"), Project(projectId: "PRJb", name: "Bugs")]
        history.items = [
            ConversationSummary(conversationId: "c1", title: "Investor update", projectId: "PRJa", projectName: "Startup"),
            ConversationSummary(conversationId: "c2", title: "Loose chat"),
        ]
        history.pinned = [ConversationSummary(conversationId: "c3", title: "Pinned in project", pinnedAt: "2026-11-01T00:00:00Z", projectId: "PRJa", projectName: "Startup")]
        history.projectItems = ["PRJa": [history.items[0], history.pinned[0]], "PRJb": []]
        history.projectCursors = ["PRJa": "next"]
        history.expandedProjects = ["PRJa": true]
        return history
    }

    @Test func renameReachesEveryListThatShowsTheName() {
        let history = store()
        history.applyProjectRename("PRJa", name: "Launch")
        #expect(history.projects.map(\.name) == ["Launch", "Bugs"])
        #expect(history.items[0].projectName == "Launch")
        #expect(history.items[1].projectName == nil)
        #expect(history.pinned[0].projectName == "Launch")
        #expect(history.projectItems["PRJa"]?.allSatisfy { $0.projectName == "Launch" } == true)
    }

    @Test func deletingAProjectSendsItsChatsBackToPinnedAndRecents() {
        let history = store()
        #expect(history.globalRecent.map(\.conversationId) == ["c2"])
        #expect(history.globalPinned.isEmpty)
        history.applyProjectDeletion("PRJa")
        #expect(history.projects.map(\.projectId) == ["PRJb"])
        #expect(history.items[0].projectId == nil && history.items[0].projectName == nil)
        #expect(history.pinned[0].projectId == nil)
        #expect(history.projectItems["PRJa"] == nil)
        #expect(history.projectCursors["PRJa"] == nil)
        #expect(history.expandedProjects["PRJa"] == nil)
        #expect(history.globalRecent.map(\.conversationId) == ["c1", "c2"])
        #expect(history.globalPinned.map(\.conversationId) == ["c3"])
    }

    @Test func aChatStartedInAProjectShowsItsVendorsAndTime() {
        let history = store()
        history.didTitleConversation(id: "c9", title: "Growth plan", vendors: [.openai, AIVendor("claude")], pendingProjectId: "PRJa")
        let row = history.projectItems["PRJa"]?.first
        #expect(row?.conversationId == "c9")
        #expect(row?.vendors == ["OPENAI", "CLAUDE"])
        #expect(ServerDate.parse(row?.updatedAt) != nil)
        #expect(history.items[0].vendors == ["OPENAI", "CLAUDE"])
    }

    @Test func aReplyRefreshesTheRowEverywhereItShows() {
        let history = store()
        history.projectItems["PRJa"] = [
            ConversationSummary(conversationId: "c4", title: "Older", updatedAt: "2026-11-02T00:00:00Z", projectId: "PRJa"),
            ConversationSummary(conversationId: "c3", title: "Pinned in project", pinnedAt: "2026-11-01T00:00:00Z", vendors: ["OPENAI"], projectId: "PRJa"),
            ConversationSummary(conversationId: "c1", title: "Investor update", projectId: "PRJa"),
        ]
        history.didReply(id: "c1", vendors: [.openai])
        history.didReply(id: "c3", vendors: [AIVendor("openai"), .gemini])
        #expect(history.projectItems["PRJa"]?.map(\.conversationId) == ["c3", "c1", "c4"])
        #expect(history.projectItems["PRJa"]?[1].vendors == ["OPENAI"])
        #expect(ServerDate.parse(history.projectItems["PRJa"]?[1].updatedAt) != nil)
        #expect(history.projectItems["PRJa"]?[0].vendors == ["OPENAI", "GEMINI"])
        #expect(history.items[0].conversationId == "c1" && history.items[0].vendors == ["OPENAI"])
        #expect(history.pinned[0].vendors == ["OPENAI", "GEMINI"])
    }
}

@Suite("Memories after a project change")
@MainActor
struct MemoriesProjectTests {
    @Test func renameUpdatesTheMemoryPagesProjectList() {
        let memories = MemoriesStore()
        memories.projects = [Project(projectId: "PRJa", name: "Startup")]
        memories.projectRenamed("PRJa", to: "Launch")
        #expect(memories.projects.map(\.name) == ["Launch"])
    }

    /// MemoryService.removeProject: the project leaves every memory, and a memory left in no
    /// project is gone.
    @Test func deleteDropsMemoriesThatLivedOnlyInTheProject() {
        let memories = MemoriesStore()
        memories.projects = [Project(projectId: "PRJa", name: "Startup"), Project(projectId: "PRJb", name: "Bugs")]
        memories.memories = [
            CustomerMemory(memoryId: "MEM#only", text: "only here", kind: .core, placements: [MemoryPlacement(projectId: "PRJa", kind: .core)]),
            CustomerMemory(memoryId: "MEM#both", text: "also elsewhere", kind: .core, placements: [MemoryPlacement(projectId: "PRJa", kind: .core), MemoryPlacement(projectId: "PRJb", kind: .episodic)]),
            CustomerMemory(memoryId: "MEM#profile", text: "profile", kind: .core),
        ]
        memories.projectDeleted("PRJa")
        #expect(memories.projects.map(\.projectId) == ["PRJb"])
        #expect(memories.memories.map(\.memoryId) == ["MEM#both", "MEM#profile"])
        #expect(memories.memories[0].placements.map(\.projectId) == ["PRJb"])
    }
}

@Suite("Project endpoints")
struct ProjectEndpointTests {
    @Test func idsAreEncodedIntoTheQuery() {
        #expect(Endpoints.renameProject("PRJ#1").absoluteString.hasSuffix("/project/rename?projectId=PRJ%231"))
        #expect(Endpoints.deleteProject("PRJ#1").absoluteString.hasSuffix("/project?projectId=PRJ%231"))
    }

    @Test func confirmNamesTheProjectAndTheMemoryDeletion() {
        let message = L("conversation.conversationHistory.deleteProjectConfirm", ["name": "Startup"])
        #expect(message.contains("“Startup”"))
        #expect(message.contains("Memories that belong only to this project are deleted"))
    }
}

// MARK: - New chat in a project (usePendingProjectName, NewChatProjectHint)

@Suite("Pending project")
@MainActor
struct PendingProjectTests {
    @Test func nameShowsOnlyBeforeTheChatExists() {
        let conversation = ConversationStore()
        let projects = [Project(projectId: "PRJa", name: "Startup")]
        #expect(conversation.pendingProjectName(in: projects) == nil)
        conversation.pendingProjectId = "PRJa"
        #expect(conversation.pendingProjectName(in: projects) == "Startup")
        #expect(conversation.pendingProjectName(in: []) == nil)
        conversation.conversationId = "c1"
        #expect(conversation.pendingProjectName(in: projects) == nil)
    }

    @Test func instructionGivesWayBeforeTheProject() {
        // Everything fits: ideal widths
        #expect(ProjectSubtitleLayout.widths(available: 300, ideal: [80, 4, 120], spacing: 4.8) == [80, 4, 120])
        // A short project keeps its width; the instruction takes what is left
        let short = ProjectSubtitleLayout.widths(available: 200, ideal: [80, 4, 200], spacing: 4.8)
        #expect(short[0] == 80)
        #expect(abs(short[2] - (200 - 4 - 9.6 - 80)) < 0.001)
        // A long project stops at 60% of the room
        let long = ProjectSubtitleLayout.widths(available: 200, ideal: [400, 4, 50], spacing: 4.8)
        #expect(abs(long[0] - (200 - 4 - 9.6) * 0.6) < 0.001)
        #expect(long[2] <= 50)
    }

    @Test func hintStaysAboveTheComposer() {
        // Keyboard closed: a little above the page's middle, as on the web
        #expect(NewChatHintLayout.midY(pageMiddle: 418, top: 56, bottom: 516, hintHeight: 45) == 418 - 4.5)
        // Keyboard open: the page's middle is inside the composer, so it centres below the header
        #expect(NewChatHintLayout.midY(pageMiddle: 275, top: 56, bottom: 230, hintHeight: 45) == 143)
    }
}

// MARK: - Swipe rows (SwipeableRow.test.tsx)

@Suite("Swipe rows")
@MainActor
struct SwipeRowTests {
    private typealias Row = SwipeableRow<EmptyView>

    @Test func aTrayOpensPastHalfItsWidth() {
        #expect(Row.actionWidth == 56)
        #expect(Row.side(forOffset: 29, leadingWidth: 56, trailingWidth: 112) == .leading)
        #expect(Row.side(forOffset: 27, leadingWidth: 56, trailingWidth: 112) == nil)
        #expect(Row.side(forOffset: -57, leadingWidth: 56, trailingWidth: 112) == .trailing)
        #expect(Row.side(forOffset: -55, leadingWidth: 56, trailingWidth: 112) == nil)
    }

    @Test func aSideWithoutActionsNeverOpens() {
        #expect(Row.side(forOffset: 40, leadingWidth: 0, trailingWidth: 112) == nil)
        #expect(Row.side(forOffset: -80, leadingWidth: 56, trailingWidth: 0) == nil)
    }

    @Test func leadingSwipesLeaveTheScreenEdgeToTheMenu() {
        #expect(Row.edgeGuard == 24)
    }
}

// MARK: - Variants and row tokens (SidebarWidget.tsx, sidebar-row.scss)

@Suite("Sidebar widget variants")
@MainActor
struct SidebarWidgetVariantTests {
    private func widget(_ variant: SidebarWidgetVariant, surface: SidebarWidgetSurface? = nil) -> SidebarWidget<EmptyView, EmptyView> {
        SidebarWidget(variant: variant, surface: surface) { EmptyView() }
    }

    @Test func listsAndMenusPaintTheSidebarBackgroundAndTheRestShowTheMaterial() {
        #expect(widget(.history).resolvedSurface == .material)
        #expect(widget(.custom).resolvedSurface == .material)
        #expect(widget(.directory).resolvedSurface == .sidebar)
        #expect(widget(.menu).resolvedSurface == .sidebar)
        #expect(widget(.custom, surface: .sidebar).resolvedSurface == .sidebar)
    }

    @Test func historyRowsAreSquareAndTheOthersRounded() {
        #expect(SidebarRowTokens.history.radius == 0)
        #expect(SidebarRowTokens.history.pressedRadius == 0)
        #expect(SidebarRowTokens.directory.radius == DSRadius.sm)
        #expect(SidebarRowTokens.menu.radius == DSRadius.md)
    }

    @Test func memoryRowsDifferFromTheOtherDirectoryRowsOnlyInCornersAndSelectedLabel() {
        let memory = SidebarRowTokens.directoryMemory
        let directory = SidebarRowTokens.directory
        #expect(memory.radius == DSRadius.md)
        #expect(memory.minHeight == directory.minHeight)
        #expect(memory.fontSize == directory.fontSize)
        #expect(memory.pressedRadius == directory.pressedRadius)
    }
}
