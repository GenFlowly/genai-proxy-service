import SwiftUI

/// The Navbar as a phone sees it on pages that still render it: a 24pt strip with the
/// menu toggle at the left and the logo centered (Navbar.module.scss).
struct CompactNavbar: View {
    @EnvironmentObject var router: AppRouter

    var body: some View {
        ZStack {
            Image("logo")
                .resizable()
                .scaledToFit()
                .frame(height: 16)
            HStack(spacing: 0) {
                Button { router.isAppMenuOpen = true } label: {
                    WebIcon(name: "menu", size: 18, color: AppTheme.navbarText)
                        .padding(2)
                        .contentShape(Rectangle())
                }
                .buttonStyle(WebPressStyle())
                .accessibilityLabel(L("layout.mobileMenu.menu"))
                Spacer(minLength: 0)
            }
        }
        .frame(height: 24)
        .frame(maxWidth: .infinity)
        .background(AppTheme.navbarBackground.ignoresSafeArea(edges: .top))
        .shadow(color: .black.opacity(0.4), radius: 3, y: 4)
        .zIndex(1)
    }
}

/// A non-chat page's overlay header and the top inset its content rests under; the
/// hamburger opens the page's L2 Menu, or the L1 Menu when the page has none.
struct PageScaffold<Content: View>: View {
    @EnvironmentObject var router: AppRouter
    let title: String
    var menuItems: [MobileHeaderMenuItem] = []
    @ViewBuilder var content: Content

    var body: some View {
        ZStack(alignment: .top) {
            content
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            MobileHeader(title: title, menuItems: menuItems, onMenuClick: router.openPageMenu)
        }
        .statusBarBand()
        .background(AppTheme.background)
    }
}
