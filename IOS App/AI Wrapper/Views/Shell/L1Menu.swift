import SwiftUI

/// The app's root (L1Menu.tsx). Signed out it is the landing page: brand, headline, login and
/// theme. Signed in it lists where to go, and each pick leads to that page's L2 Menu. There is
/// no back or close: leaving means picking a destination.
struct L1Menu: View {
    @EnvironmentObject var router: AppRouter
    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var toasts: ToastCenter

    var body: some View {
        GeometryReader { proxy in
            VStack(alignment: .leading, spacing: 0) {
                header
                Spacer(minLength: 0)
                if auth.isAuthenticated {
                    navigation
                } else {
                    headline
                }
                footer
                    // CSS: max(0.75rem, env(safe-area-inset-bottom))
                    .padding(.bottom, max(0, 12 - proxy.safeAreaInsets.bottom))
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(AppTheme.background.ignoresSafeArea())
        // The page stays mounted underneath; VoiceOver mustn't reach it.
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(.isModal)
    }

    private var header: some View {
        HStack(spacing: 10) {
            Image("logo")
                .resizable()
                .scaledToFit()
                .frame(width: 30, height: 28)
                .accessibilityHidden(true)
            Text(AppConfig.appName)
                .webText(20, 700, lineHeight: 24)
                .tracking(-0.1)
                .foregroundStyle(AppTheme.textPrimary)
        }
        .padding(.horizontal, 24)
        .frame(minHeight: 64)
    }

    private var headline: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(["headlineOne", "headlineTwo", "headlineThree"], id: \.self) { line in
                Text(L("layout.l1Menu.\(line)"))
                    .webText(46, 700, lineHeight: 49.68)
                    .tracking(-1.15)
                    .foregroundStyle(AppTheme.textPrimary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.5)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
        .padding(.horizontal, 24)
        .padding(.bottom, 44)
    }

    private var navItems: [(key: String, label: String, route: AppRouter.Route, hasL2Menu: Bool)] {
        [
            ("Chat", L("layout.navbarMenu.chat"), .chat, true),
            ("Memory", L("layout.navbarMenu.memory"), .memory, true),
            ("Agents", L("layout.navbarMenu.agents"), .agents, true),
            // Instructions has no L2 Menu, so picking it goes straight to the screen.
            ("Instructions", L("layout.navbarMenu.instructions"), .instructions, false)
        ]
    }

    private var navigation: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(navItems, id: \.key) { item in
                let isActive = router.hasEnteredPage && router.activeNavItem == item.key
                Button {
                    if item.hasL2Menu {
                        router.openWithL2Menu(item.route)
                    } else {
                        router.navigate(item.route)
                    }
                } label: {
                    HStack(spacing: 14) {
                        Text(item.label)
                            .webText(38, isActive ? 700 : 500, lineHeight: 38)
                            .tracking(-0.76)
                            .foregroundStyle(isActive ? AppTheme.textPrimary : AppTheme.textMuted)
                            .lineLimit(1)
                            .minimumScaleFactor(0.5)
                        if isActive {
                            Circle()
                                .fill(AppTheme.primary)
                                .frame(width: 10, height: 10)
                                .accessibilityHidden(true)
                        }
                    }
                    .padding(.horizontal, 24)
                    .frame(maxWidth: .infinity, minHeight: 62, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(WebPressStyle())
                .accessibilityAddTraits(isActive ? .isSelected : [])
                .accessibilityIdentifier("l1-menu-item-\(item.key.lowercased())")
            }
        }
        .padding(.bottom, 8)
    }

    private var footer: some View {
        HStack(spacing: 12) {
            if auth.isAuthenticated {
                accountButton
            } else if auth.isOnboarding {
                Capsule()
                    .fill(AppTheme.backgroundTertiary)
                    .frame(maxWidth: .infinity)
                    .frame(height: 52)
                    .accessibilityLabel(L("layout.mobileMenu.signingIn"))
            } else {
                loginButton
            }
            ThemeToggleView()
        }
        .padding(.horizontal, 16)
    }

    private var loginButton: some View {
        Button {
            Task {
                do {
                    try await auth.login()
                    router.openWithL2Menu(.chat)
                } catch Auth0Service.AuthError.cancelled {
                    // User dismissed the login sheet
                } catch {
                    toasts.showToast(error.localizedDescription, duration: 6)
                }
            }
        } label: {
            HStack(spacing: 8) {
                WebIcon(name: "login", size: 20, color: .white)
                Text(L("layout.mobileMenu.login")).webText(16, 600)
            }
            .foregroundStyle(.white)
            .frame(maxWidth: .infinity)
            .frame(height: 52)
            .background(AppTheme.buttonPrimary)
            .clipShape(Capsule())
            .contentShape(Capsule())
        }
        .buttonStyle(WebPressStyle())
        .accessibilityIdentifier("l1-menu-login")
    }

    private var accountButton: some View {
        Button {
            // Keeps the settings section you're on.
            if case .settings = router.route {
                router.openWithL2Menu(router.route)
            } else {
                router.openWithL2Menu(.settings(.profile))
            }
        } label: {
            HStack(spacing: 10) {
                AvatarImage(picture: auth.customerPicture, size: 40)
                WebTruncatedLine(auth.customerName?.isEmpty == false ? auth.customerName! : L("layout.mobileMenu.account"))
                    .webText(15, 500)
                    .foregroundStyle(AppTheme.textPrimary)
                Spacer(minLength: 0)
            }
            .padding(.leading, 6)
            .padding(.trailing, 16)
            .frame(maxWidth: .infinity)
            .frame(height: 52)
            .background(AppTheme.navbarControl)
            .clipShape(Capsule())
            .contentShape(Capsule())
        }
        .buttonStyle(WebPressStyle())
        .accessibilityIdentifier("l1-menu-account")
    }
}

/// ThemeToggle.module.scss `.surface`: 52 tall track, 44pt options, sliding thumb.
struct ThemeToggleView: View {
    @AppStorage("theme") private var themeMode: ThemeMode = .system
    @Namespace private var namespace

    private let options: [(ThemeMode, String, String)] = [
        (.light, "sun", "common.themeToggle.lightTheme"),
        (.system, "laptop", "common.themeToggle.systemTheme"),
        (.dark, "moon", "common.themeToggle.darkTheme")
    ]

    private static let thumb = AppTheme.dynamic(light: "#FFFFFF", dark: "#4F4F50")
    private static let idle = AppTheme.dynamic(light: "#555555", dark: "#C7C7CC")

    var body: some View {
        HStack(spacing: 2) {
            ForEach(options, id: \.0) { mode, icon, label in
                Button { themeMode = mode } label: {
                    WebIcon(name: icon, size: 20, color: themeMode == mode ? AppTheme.textPrimary : Self.idle)
                        .frame(width: 44, height: 44)
                        .background {
                            if themeMode == mode {
                                Circle()
                                    .fill(Self.thumb)
                                    .shadow(color: .black.opacity(0.14), radius: 1, y: 1)
                                    .matchedGeometryEffect(id: "thumb", in: namespace)
                            }
                        }
                        .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(L(label))
                .accessibilityAddTraits(themeMode == mode ? .isSelected : [])
                .accessibilityIdentifier("theme-toggle-\(icon)")
            }
        }
        .padding(4)
        .background(Capsule().fill(AppTheme.navbarControl))
        .animation(.timingCurve(0.4, 0, 0.2, 1, duration: 0.3), value: themeMode)
    }
}
