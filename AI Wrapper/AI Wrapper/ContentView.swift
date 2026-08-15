//
//  ContentView.swift
//  AI Wrapper
//
//  App shell mirroring the web app's mobile layout: fixed Navbar on top,
//  routed page content below, full-screen menu / right-sidebar overlays.
//

import SwiftUI

struct ContentView: View {
    @EnvironmentObject var router: AppRouter
    @EnvironmentObject var auth: AuthStore

    var body: some View {
        ZStack {
            VStack(spacing: 0) {
                NavbarView()
                // The right-sidebar modal covers everything below the navbar —
                // the navbar itself stays visible (RightSidebarMobileModal).
                ZStack {
                    pageContent
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                    if router.isRightSidebarOpen {
                        RightSidebarModal()
                            .transition(.move(edge: .trailing))
                            .zIndex(5)
                    }
                }
            }
            .background(AppTheme.background)

            // The mobile menu overlay covers the whole screen (z 2000)
            if router.isMobileMenuOpen {
                MobileMenuOverlay()
                    .transition(.move(edge: .leading))
                    .zIndex(10)
            }
        }
        .animation(.easeOut(duration: 0.2), value: router.isMobileMenuOpen)
        .animation(.easeOut(duration: 0.2), value: router.isRightSidebarOpen)
        .overlay(alignment: .top) { ToastOverlay() }
    }

    @ViewBuilder
    private var pageContent: some View {
        switch router.route {
        case .chat:
            ChatView()
        case .history:
            ConversationHistoryPageView()
        case .memory:
            MemoryPageView()
        case .agents:
            AgentsPageView()
        case .editAgent(let agent):
            EditAgentView(agent: agent)
        case .instructions:
            InstructionsPageView()
        case .instructionDetail(let id):
            InstructionDetailView(instructionId: id)
        case .settingsMenu:
            SettingsMenuPageView()
        case .settings(let section):
            SettingsSectionPageView(section: section)
        }
    }
}

/// Web equivalent: ProtectedRoute → loginWithRedirect. Shows a login prompt.
struct LoginRequiredView: View {
    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var toasts: ToastCenter
    var message: String = "Log in to continue"

    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "person.crop.circle.badge.questionmark")
                .font(.system(size: 44))
                .foregroundStyle(AppTheme.textMuted)
            Text(message)
                .font(.headline)
                .foregroundStyle(AppTheme.textPrimary)
            PillButton {
                Task {
                    do {
                        try await auth.login()
                    } catch Auth0Service.AuthError.cancelled {
                        // User dismissed the login sheet
                    } catch {
                        toasts.showToast("Login failed: \(error.localizedDescription)", duration: 6)
                    }
                }
            } label: {
                WebIcon(name: "login-icon", size: 18, color: .white)
                Text("Login")
            }
            if auth.isOnboarding {
                ProgressView("Syncing account…")
                    .font(.caption)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(AppTheme.background)
    }
}
