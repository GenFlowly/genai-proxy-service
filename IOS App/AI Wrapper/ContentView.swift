//
//  ContentView.swift
//  AI Wrapper
//
//  App shell mirroring the web app's mobile layout: routed full-screen pages under a
//  transparent MobileHeader, plus the full-screen menu and AI-config overlays, and the
//  swipe from the left edge that brings a menu in.
//

import SwiftUI

struct ContentView: View {
    @EnvironmentObject var router: AppRouter
    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var conversation: ConversationStore
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// Not the screen's: they differ in iPad split view and Stage Manager. Starts from the
    /// scene so the first layout already has it, and the keyboard's inset cancels out.
    @State private var windowHeight = UIApplication.shared.connectedScenes
        .compactMap { ($0 as? UIWindowScene)?.effectiveGeometry.coordinateSpace.bounds.height }
        .first ?? 0
    @State private var windowWidth = UIApplication.shared.connectedScenes
        .compactMap { ($0 as? UIWindowScene)?.effectiveGeometry.coordinateSpace.bounds.width }
        .first ?? 0
    /// The session restores synchronously from the Keychain, so there's nothing to hold the splash
    /// for (the web waits on Auth0); it only softens the cut from the launch screen.
    @State private var isSplashVisible = true
    /// The menu a finger is dragging in from the left edge, and how far.
    @State private var edgeDrag: (menu: MenuLayer, translation: CGFloat)?
    @State private var isDialogShown = false

    var body: some View {
        // First-run FTUE gate (web AppContent): a brand-new account (onboarding flag
        // false) sees the wizard in place of the app until it finishes/skips.
        Group {
            if auth.isAuthenticated && auth.aiDataConsentRequired {
                // Before the wizard, whose key checks are the first calls to a provider.
                AiDataConsentView()
            } else if auth.isAuthenticated && !auth.onboardingCompleted {
                OnboardingWizard()
            } else {
                mainShell
                    // DSFont scales through UIFontMetrics once per font; rebuild on change.
                    .id(dynamicTypeSize)
            }
        }
        .background(TapOutsideEndsEditing())
        .overlay {
            if isSplashVisible {
                SplashView()
                    .transition(.opacity)
            }
        }
        .onAppear {
            // web: .splash-hidden's 250ms fade
            withAnimation(.easeOut(duration: 0.25)) { isSplashVisible = false }
        }
        // FTUE done: on to the Chat L2 Menu, wherever it started.
        .onChange(of: auth.onboardingCompleted) { previous, completed in
            if !previous, completed, auth.isAuthenticated { router.openWithL2Menu(.chat) }
        }
        .onChange(of: auth.isAuth0Authenticated) { _, signedIn in
            if !signedIn { router.showLanding() }
        }
        .environment(\.windowHeight, windowHeight)
        .environment(\.windowWidth, windowWidth)
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { windowWidth = $0 }
        .onGeometryChange(for: CGFloat.self) { $0.size.height + $0.safeAreaInsets.top + $0.safeAreaInsets.bottom } action: {
            windowHeight = $0
        }
    }

    private var mainShell: some View {
        ZStack {
            pageContent
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(AppTheme.background)
                .environment(\.allowsEdgeSwipe, !isDialogShown)

            if router.isRightSidebarOpen {
                RightSidebarModal()
                    .transition(.opacity)
                    .zIndex(5)
            }

            menus.zIndex(10)
        }
        .gesture(EdgeSwipeGesture(
            isEnabled: !router.isAppMenuOpen && !router.isRightSidebarOpen && !isDialogShown,
            yieldsToPageSwipe: true,
            onBegan: { edgeDrag = (router.isMobileMenuOpen ? .l1 : router.pageMenu, 0) },
            onChanged: { edgeDrag?.translation = $0 },
            onEnded: { commits in
                guard let menu = edgeDrag?.menu else { return }
                withAnimation(menuMotion) {
                    if commits { router.open(menu) }
                    edgeDrag = nil
                }
            }
        ))
        .onPreferenceChange(DialogShownKey.self) { isDialogShown = $0 }
        .overlay(alignment: .topTrailing) { ToastOverlay() }
        // A keyboard left up would cover the menu's rows.
        .onChange(of: router.isMobileMenuOpen) { _, open in
            if open { UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil) }
        }
        .onChange(of: router.isAppMenuOpen) { _, open in
            if open { UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil) }
        }
    }

    /// Matches the web's SlidePanel: 250ms, cubic-bezier(0.2, 0, 0, 1).
    private var menuMotion: Animation? {
        reduceMotion ? nil : .timingCurve(0.2, 0, 0, 1, duration: 0.25)
    }

    /// The full-screen menus (z 100 and 101 on the web). They enter from the left and leave to
    /// the left, and follow the finger while an edge swipe drags one in.
    private var menus: some View {
        ZStack {
            if router.isMobileMenuOpen || edgeDrag?.menu == .l2 {
                menuOverlay
                    .menuEdgeShadow()
                    .offset(x: dragOffset(.l2))
                    .transition(.asymmetric(
                        insertion: router.l2MenuAppearsInPlace ? .identity : .move(edge: .leading),
                        removal: .move(edge: .leading)
                    ))
                    .zIndex(10)
            }

            if router.isAppMenuOpen || edgeDrag?.menu == .l1 {
                L1Menu()
                    .menuEdgeShadow()
                    .offset(x: dragOffset(.l1))
                    .transition(.move(edge: .leading))
                    .zIndex(20)
            }
        }
        .animation(menuMotion, value: router.isMobileMenuOpen)
        .animation(menuMotion, value: router.isAppMenuOpen)
    }

    private func dragOffset(_ menu: MenuLayer) -> CGFloat {
        guard let edgeDrag, edgeDrag.menu == menu else { return 0 }
        return min(0, edgeDrag.translation - windowWidth)
    }

    @ViewBuilder
    private var menuOverlay: some View {
        let close = { router.isMobileMenuOpen = false }
        switch router.route {
        case .chat:
            MobileMenu(
                action: MobileMenuAction(label: L("conversation.conversationHeader.newChat"), icon: "compose") {
                    conversation.resetConversation()
                    close()
                },
                onClose: close
            ) {
                ChatMenuContent(onClose: close)
            }
        case .memory, .memoryDetail, .memoryEdit, .memoryHistory, .memoryUsage, .newMemory:
            MobileMenu(
                action: MobileMenuAction(label: L("memoryPage.list.addMemory"), icon: "add-icon") {
                    router.navigate(.newMemory)
                },
                onClose: close
            ) {
                MemoryMenuContent(onClose: close)
            }
        case .settings:
            MobileMenu(onClose: close) {
                SettingsSidebar(onNavigate: close)
            }
        case .agents:
            MobileMenu(onClose: close) {
                AgentsMenuContent(onClose: close)
            }
        case .editAgent, .newAgent, .instructions, .instructionDetail, .instructionEdit, .instructionHistory, .instructionUsage, .privacyPolicy, .support:
            // These pages have no L2 Menu; their hamburger opens the L1 Menu.
            EmptyView()
        }
    }

    @ViewBuilder
    private var pageContent: some View {
        switch router.route {
        case .chat:
            ChatView()
        case .memory:
            MemoryPageView()
        case .memoryDetail(let id, let version):
            MemoryDetailView(memoryId: id, version: version)
                .id("\(id)#\(version ?? 0)")
        case .memoryEdit(let id, let version):
            MemoryEditView(memoryId: id, version: version)
                .id("\(id)#\(version ?? 0)")
        case .memoryHistory(let id):
            MemoryHistoryView(memoryId: id)
        case .memoryUsage(let id):
            MemoryUsedInView(memoryId: id)
        case .newMemory:
            NewMemoryView(scope: router.memoryScope)
        case .agents:
            AgentsPageView()
        case .editAgent(let agent):
            AgentDesktopNoticeView(graphId: agent.graphId)
        case .newAgent:
            AgentDesktopNoticeView(graphId: nil)
        case .instructions:
            InstructionsPageView()
        case .instructionDetail(let id, let version):
            InstructionDetailView(instructionId: id, version: version)
                .id("\(id)#\(version ?? 0)")
        case .instructionEdit(let id, let version):
            InstructionEditView(instructionId: id, version: version)
                .id("\(id ?? "new")#\(version ?? 0)")
        case .instructionHistory(let id):
            InstructionHistoryView(instructionId: id)
        case .instructionUsage(let id):
            InstructionUsedInView(instructionId: id)
        case .settings(let section):
            SettingsSectionPageView(section: section)
        case .privacyPolicy:
            PrivacyPolicyView()
        case .support:
            SupportView()
        }
    }
}

/// Web equivalent: ProtectedRoute → loginWithRedirect. Shows a login prompt.
struct LoginRequiredView: View {
    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var toasts: ToastCenter
    var message: String = ""

    var body: some View {
        VStack(spacing: 16) {
            if !message.isEmpty {
                Text(message).webText(16, 600).foregroundStyle(AppTheme.textPrimary)
            }
            PillButton(style: .primary, action: {
                Task {
                    do {
                        try await auth.login()
                    } catch Auth0Service.AuthError.cancelled {
                        // User dismissed the login sheet
                    } catch {
                        toasts.showToast(error.localizedDescription, duration: 6)
                    }
                }
            }, label: {
                WebIcon(name: "login", size: 18, color: .white)
                Text(L("layout.mobileMenu.login"))
            })
            if auth.isOnboarding {
                ProgressView()
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(AppTheme.background)
    }
}
