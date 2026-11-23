import Foundation
import SwiftUI
import Combine

enum AgentOwnership { case all, mine }

/// The two full-screen menus on phones: L1 is the app's menu, L2 the page's.
enum MenuLayer { case l1, l2 }

/// Mirrors react-router routes + LayoutContext below isNarrow: navigation happens through
/// the MobileHeader and the full-screen menu overlay.
@MainActor
final class AppRouter: ObservableObject {
    /// A Settings page (settingsNav.ts). Tools and Connectors keep their pages but aren't in the menu.
    enum SettingsSection: Hashable {
        case account, privacy, blocked, deleteData
        case llmKeys, embeddingKeys, vectorDb, webSearchKey
        case agents, memory, searchIndex, embeddingModels
        case usageLlm, usageEmbedding, usageVectorDb, usageWebSearch
        case developer
        case tools, connectors
    }

    enum Route: Equatable {
        case chat                      // "/chat"
        case memory                    // "/memory?scope=" (the list is memoryScope)
        case memoryDetail(String, version: Int? = nil) // "/memory/:memoryId?version="
        case memoryEdit(String, version: Int? = nil)   // "/memory/:memoryId/edit?version="
        case memoryHistory(String)     // "/memory/:memoryId/history"
        case memoryUsage(String)       // "/memory/:memoryId/usage"
        case memoryInference(String, runId: String) // "/memory/:memoryId/inference/:runId"
        case newMemory                 // "/memory/new"
        case agents                    // "/agents"
        case editAgent(Agent)          // "/agents/:graphId"
        case newAgent                  // "/agents/new"
        case instructions              // "/instructions"
        case instructionDetail(String, version: Int? = nil) // "/instructions/:id?version="
        case instructionEdit(String?, version: Int? = nil)  // "/instructions/:id/edit", nil = "/instructions/new"
        case instructionHistory(String) // "/instructions/:id/history"
        case instructionUsage(String)   // "/instructions/:id/usage"
        case settings(SettingsSection) // "/settings/:section"
        case privacyPolicy             // "/privacy-policy"
        case support                   // "/support"
    }

    @Published var route: Route = .chat
    /// The L1 Menu covers the current page; the app launches on it.
    @Published var isAppMenuOpen = true
    /// False until a page has been picked: the L1 Menu has no current page to mark at launch.
    @Published var hasEnteredPage = false
    /// The current page's L2 Menu.
    @Published var isMobileMenuOpen = false {
        didSet { if !isMobileMenuOpen { l2MenuAppearsInPlace = false } }
    }
    /// Picked in the L1 Menu: the L2 Menu is already there as L1 slides away.
    private(set) var l2MenuAppearsInPlace = false
    @Published var isRightSidebarOpen = false
    /// Chat instruction picker (#19).
    @Published var showInstructionPicker = false
    /// Category picked in the Agents page's menu; a fresh visit starts on Conversation.
    @Published var agentsCategory: AgentCategory = .conversation
    /// The Agents page's ownership chips, shared with its menu.
    @Published var agentsOwnership = AgentOwnership.all
    /// Picked in the Agents menu: the page expands this card and scrolls to it.
    @Published var revealAgentId: String?
    /// The Memory page's list, picked in its L2 Menu; a memory opens in this list's context.
    @Published var memoryScope: MemoryScope = .profileCore

    func navigate(_ route: Route) {
        if route == .agents { agentsCategory = .conversation }
        self.route = route
        hasEnteredPage = true
        isAppMenuOpen = false
        isMobileMenuOpen = false
        isRightSidebarOpen = false
    }

    /// An L1 Menu pick: the page's L2 Menu comes next. The page you're already on stays as it was.
    func openWithL2Menu(_ route: Route) {
        let fromL1Menu = isAppMenuOpen
        if route != self.route { navigate(route) }
        l2MenuAppearsInPlace = fromL1Menu
        hasEnteredPage = true
        isAppMenuOpen = false
        isMobileMenuOpen = true
    }

    /// Back to the signed-out landing page.
    func showLanding() {
        navigate(.chat)
        hasEnteredPage = false
        isAppMenuOpen = true
    }

    /// What the hamburger on a page opens: its L2 Menu, or the L1 Menu when it has none.
    var pageMenu: MenuLayer {
        switch route {
        case .chat, .memory, .memoryDetail, .memoryEdit, .memoryHistory, .memoryUsage, .memoryInference, .newMemory, .agents, .settings: return .l2
        case .editAgent, .newAgent, .instructions, .instructionDetail, .instructionEdit, .instructionHistory, .instructionUsage, .privacyPolicy, .support: return .l1
        }
    }

    func openPageMenu() {
        open(pageMenu)
    }

    func open(_ menu: MenuLayer) {
        switch menu {
        case .l1: isAppMenuOpen = true
        case .l2: isMobileMenuOpen = true
        }
    }

    /// The menu's nav items (NavbarMenu NAV_ITEMS): active = bold.
    var activeNavItem: String {
        switch route {
        case .chat: return "Chat"
        case .memory, .memoryDetail, .memoryEdit, .memoryHistory, .memoryUsage, .memoryInference, .newMemory: return "Memory"
        case .agents, .editAgent, .newAgent: return "Agents"
        case .instructions, .instructionDetail, .instructionEdit, .instructionHistory, .instructionUsage: return "Instructions"
        case .settings, .privacyPolicy, .support: return ""
        }
    }
}
