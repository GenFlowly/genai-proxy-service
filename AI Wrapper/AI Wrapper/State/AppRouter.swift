import Foundation
import SwiftUI
import Combine

/// Mirrors react-router routes + LayoutContext (mobile layout at ≤768px):
/// navigation happens through the Navbar and full-screen menu overlay.
@MainActor
final class AppRouter: ObservableObject {
    enum SettingsSection: String, CaseIterable, Identifiable {
        case profile, ai, memory, developer

        var id: String { rawValue }

        var label: String {
            switch self {
            case .profile: return "Profile"
            case .ai: return "AI Settings"
            case .memory: return "Memory Settings"
            case .developer: return "Developer"
            }
        }

        var icon: String {
            switch self {
            case .profile: return "person.circle"
            case .ai: return "square.grid.2x2"
            case .memory: return "internaldrive"
            case .developer: return "pencil"
            }
        }

        var title: String {
            switch self {
            case .profile: return "Profile Settings"
            case .ai: return "AI Models & Providers"
            case .memory: return "Memory Settings"
            case .developer: return "Developer"
            }
        }
    }

    enum Route: Equatable {
        case chat                      // "/chat"
        case history                   // "/history"
        case memory                    // "/memory"
        case agents                    // "/agents"
        case editAgent(Agent)          // "/agents/:graphId"
        case instructions              // "/instructions"
        case instructionDetail(String?) // "/instructions/:id", nil = "new"
        case settingsMenu              // "/settings" (mobile menu page)
        case settings(SettingsSection) // "/settings/:section"
    }

    @Published var route: Route = .chat
    @Published var isMobileMenuOpen = false
    @Published var isRightSidebarOpen = false

    func navigate(_ route: Route) {
        self.route = route
        isMobileMenuOpen = false
        isRightSidebarOpen = false
    }

    /// The navbar's center menu items (NavbarMenu NAV_ITEMS).
    var activeNavItem: String {
        switch route {
        case .chat, .history: return "Chat"
        case .memory: return "Memory"
        case .agents, .editAgent: return "Agents"
        case .instructions, .instructionDetail: return "Instructions"
        case .settingsMenu, .settings: return ""
        }
    }

    var isChatPage: Bool {
        if case .chat = route { return true }
        return false
    }
}
