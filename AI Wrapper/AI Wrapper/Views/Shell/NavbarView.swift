import SwiftUI

/// Mirrors src/components/navbar/Navbar.tsx — fixed dark bar (#252526):
/// [menu icon + logo] | [theme toggle + auth + models toggle on chat pages].
struct NavbarView: View {
    @EnvironmentObject var router: AppRouter
    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var toasts: ToastCenter

    /// Mobile navbar (≤768px): hamburger left, logo centered, models toggle
    /// right — theme toggle and Login are hidden (they live in the menu).
    var body: some View {
        ZStack {
            // 📱 Mobile: center the logo in the navbar
            Button {
                router.navigate(.chat)
            } label: {
                Image("logo")
                    .resizable()
                    .scaledToFit()
                    .frame(height: 22)
            }

            HStack(spacing: 8) {
                Button {
                    router.isMobileMenuOpen = true
                } label: {
                    WebIcon(name: "menu", size: 24, color: AppTheme.navbarText)
                        .padding(8)
                }

                Spacer()

                if router.isChatPage {
                    Button {
                        router.isRightSidebarOpen = true
                    } label: {
                        WebIcon(name: "models", size: 24, color: AppTheme.navbarText)
                            .padding(8)
                    }
                }
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .background(AppTheme.navbarBackground)
    }
}

struct NavbarAvatarView: View {
    @EnvironmentObject var auth: AuthStore

    var body: some View {
        if let picture = auth.customerPicture, let url = URL(string: picture) {
            AsyncImage(url: url) { image in
                image.resizable()
            } placeholder: {
                WebIcon(name: "user-circle", size: 28, color: AppTheme.navbarText)
            }
            .frame(width: 28, height: 28)
            .clipShape(Circle())
        } else {
            WebIcon(name: "user-circle", size: 28, color: AppTheme.navbarText)
        }
    }
}

/// Mirrors ThemeToggle — emoji-only 3-segment slider: ☀️ / 💻 / 🌙.
struct ThemeToggleView: View {
    @AppStorage("theme") private var themeMode: ThemeMode = .system

    var body: some View {
        HStack(spacing: 0) {
            segment("☀️", .light)
            segment("💻", .system)
            segment("🌙", .dark)
        }
        .padding(2)
        .background(Color.black.opacity(0.25))
        .clipShape(Capsule())
    }

    private func segment(_ emoji: String, _ mode: ThemeMode) -> some View {
        Button {
            themeMode = mode
        } label: {
            Text(emoji)
                .font(.caption)
                .padding(.horizontal, 7)
                .padding(.vertical, 4)
                .background(themeMode == mode ? Color.white.opacity(0.25) : .clear)
                .clipShape(Capsule())
        }
    }
}

/// Mirrors MobileMenuContent — dark (#252526) full-screen menu: "Menu" header
/// + ◀ close, bordered full-width history button, full-width text nav links
/// (active = bold), footer with centered theme toggle + full-width auth button.
struct MobileMenuOverlay: View {
    @EnvironmentObject var router: AppRouter
    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var toasts: ToastCenter

    private let navItems: [(label: String, route: AppRouter.Route)] = [
        ("Chat", .chat),
        ("Memory", .memory),
        ("Agents", .agents),
        ("Instructions", .instructions),
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            // Header
            HStack {
                Text("Menu")
                    .font(.title3.weight(.bold))
                    .foregroundStyle(AppTheme.navbarText)
                Spacer()
                Button {
                    router.isMobileMenuOpen = false
                } label: {
                    WebIcon(name: "alt-arrow-left", size: 20, color: AppTheme.navbarText)
                        .padding(8)
                }
            }
            .padding(.bottom, 12)
            .overlay(alignment: .bottom) {
                Rectangle().fill(Color.white.opacity(0.2)).frame(height: 1)
            }

            // Content
            VStack(alignment: .leading, spacing: 20) {
                Button {
                    router.navigate(.history)
                } label: {
                    HStack(spacing: 12) {
                        WebIcon(name: "menu", size: 20, color: AppTheme.navbarText)
                        Text("Conversation History")
                            .font(.body.weight(.medium))
                            .foregroundStyle(AppTheme.navbarText)
                        Spacer()
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
                    .overlay(
                        RoundedRectangle(cornerRadius: 6)
                            .stroke(Color.white.opacity(0.3), lineWidth: 1)
                    )
                }

                // NavbarMenu — full-width text links, active = bold
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(navItems, id: \.label) { item in
                        let active = router.activeNavItem == item.label
                        Button {
                            router.navigate(item.route)
                        } label: {
                            Text(item.label)
                                .font(.body.weight(active ? .bold : .medium))
                                .foregroundStyle(AppTheme.navbarText)
                                .padding(.horizontal, 16)
                                .padding(.vertical, 12)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background(active ? Color.white.opacity(0.15) : .clear)
                                .clipShape(RoundedRectangle(cornerRadius: 6))
                        }
                    }
                }
            }

            Spacer()

            // Footer: centered theme toggle + full-width auth
            VStack(spacing: 16) {
                ThemeToggleView()
                    .frame(maxWidth: .infinity)

                if auth.isOnboarding && !auth.isAuthenticated {
                    Circle()
                        .fill(Color.white.opacity(0.35))
                        .frame(width: 21, height: 21)
                } else if !auth.isAuthenticated {
                    Button {
                        Task {
                            do {
                                try await auth.login()
                                router.isMobileMenuOpen = false
                            } catch Auth0Service.AuthError.cancelled {
                            } catch {
                                toasts.showToast("Login failed: \(error.localizedDescription)", duration: 6)
                            }
                        }
                    } label: {
                        HStack(spacing: 8) {
                            WebIcon(name: "login-icon", size: 20, color: .white)
                            Text("Login")
                        }
                        .font(.body)
                        .foregroundStyle(.white)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 12)
                        .background(AppTheme.primary)
                        .clipShape(RoundedRectangle(cornerRadius: 6))
                    }
                } else {
                    Button {
                        router.navigate(.settingsMenu)
                    } label: {
                        HStack(spacing: 12) {
                            if let picture = auth.customerPicture, let url = URL(string: picture) {
                                AsyncImage(url: url) { image in
                                    image.resizable()
                                } placeholder: {
                                    WebIcon(name: "user-circle", size: 24, color: AppTheme.navbarText)
                                }
                                .frame(width: 24, height: 24)
                                .clipShape(Circle())
                            } else {
                                WebIcon(name: "user-circle", size: 24, color: AppTheme.navbarText)
                            }
                            Text(auth.customerName?.isEmpty == false ? auth.customerName! : "Account")
                                .font(.body.weight(.medium))
                                .lineLimit(1)
                            Spacer()
                        }
                        .foregroundStyle(AppTheme.navbarText)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 12)
                        .overlay(
                            RoundedRectangle(cornerRadius: 6)
                                .stroke(Color.white.opacity(0.3), lineWidth: 1)
                        )
                    }
                }
            }
            .padding(.top, 16)
            .overlay(alignment: .top) {
                Rectangle().fill(Color.white.opacity(0.2)).frame(height: 1)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(AppTheme.navbarBackground.ignoresSafeArea())
    }
}

/// Web PageHeader — h1 title + actions row used across pages.
struct PageHeaderView<Actions: View>: View {
    var title: String
    var subtitle: String?
    @ViewBuilder var actions: Actions

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack {
                Text(title)
                    .font(.title2.weight(.bold))
                    .foregroundStyle(AppTheme.textPrimary)
                Spacer()
                actions
            }
            if let subtitle {
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(AppTheme.textMuted)
            }
        }
        .padding(.horizontal)
        .padding(.vertical, 10)
    }
}
