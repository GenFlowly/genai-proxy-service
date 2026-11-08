import SwiftUI

struct MobileHeaderMenuItem: Identifiable {
    let id = UUID()
    let label: String
    var disabled = false
    let action: () -> Void
}

/// MobileHeader.module.scss: a transparent overlay pinned to the top — only the floating
/// controls (circles and the center pill) have a surface and catch taps, so content
/// scrolls underneath. Hamburger left, title + subtitle pill center, kebab right.
struct MobileHeader<Subtitle: View>: View {
    let title: String
    var menuItems: [MobileHeaderMenuItem] = []
    var onSubtitleClick: (() -> Void)?
    /// When set, the left circle goes back instead of opening the menu; this is its label.
    var backLabel: String? = nil
    let onMenuClick: () -> Void
    @ViewBuilder var subtitle: Subtitle

    @State private var isMenuOpen = false

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            circleButton(icon: backLabel == nil ? "menu" : "alt-arrow-left", label: backLabel ?? L("layout.mobileMenu.menu"), action: onMenuClick)

            centerPill
                .frame(maxWidth: .infinity)

            if menuItems.isEmpty {
                Color.clear.frame(width: 40, height: 40).allowsHitTesting(false)
            } else {
                circleButton(icon: "more-vertical", label: L("layout.mobileHeader.moreActions")) { isMenuOpen.toggle() }
                    .overlay(alignment: .topTrailing) {
                        if isMenuOpen { dropdown.offset(y: 45.6) }
                    }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(alignment: .top) {
            // Any tap outside closes the kebab menu.
            if isMenuOpen {
                Color.black.opacity(0.001)
                    .frame(width: 4000, height: 4000)
                    .onTapGesture { isMenuOpen = false }
            }
        }
    }

    private func circleButton(icon: String, label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            WebIcon(name: icon, size: 22, color: AppTheme.textPrimary)
                .frame(width: 40, height: 40)
                .background(AppTheme.navbarControl)
                .background(BackdropBlur())
                .clipShape(Circle())
        }
        .buttonStyle(WebPressStyle())
        .accessibilityLabel(label)
    }

    private var centerPill: some View {
        VStack(spacing: 1.6) {
            WebTruncatedLine(title)
                .webText(15.2, 600)
                .foregroundStyle(AppTheme.textPrimary)
            if Subtitle.self != EmptyView.self {
                Button { onSubtitleClick?() } label: {
                    HStack(spacing: 4.8) { subtitle }
                        .webText(12)
                        .foregroundStyle(AppTheme.textSecondary)
                        .lineLimit(1)
                }
                .buttonStyle(WebPressStyle())
                .disabled(onSubtitleClick == nil)
            }
        }
        .padding(.horizontal, 14.4)
        .padding(.vertical, 4)
        .frame(minHeight: 40)
        .background(AppTheme.navbarControl)
        .background(BackdropBlur())
        .clipShape(RoundedRectangle(cornerRadius: 20))
    }

    private var dropdown: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(menuItems) { item in
                Button {
                    isMenuOpen = false
                    item.action()
                } label: {
                    Text(item.label)
                        .webText(arial: 14.4)
                        .foregroundStyle(AppTheme.textPrimary)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 9.6)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .contentShape(Rectangle())
                }
                .buttonStyle(MenuRowStyle())
                .disabled(item.disabled)
                .opacity(item.disabled ? 0.5 : 1)
            }
        }
        .padding(.vertical, 4)
        .padding(1)
        .frame(width: 160)
        .background(AppTheme.backgroundSecondary)
        .clipShape(RoundedRectangle(cornerRadius: DSRadius.md))
        .overlay(RoundedRectangle(cornerRadius: DSRadius.md).strokeBorder(AppTheme.border, lineWidth: 1))
        .shadow(color: .black.opacity(0.5), radius: 7.5, y: 10)
    }
}

extension MobileHeader where Subtitle == EmptyView {
    init(title: String, menuItems: [MobileHeaderMenuItem] = [], backLabel: String? = nil, onMenuClick: @escaping () -> Void) {
        self.title = title
        self.menuItems = menuItems
        self.onSubtitleClick = nil
        self.backLabel = backLabel
        self.onMenuClick = onMenuClick
        self.subtitle = EmptyView()
    }
}

/// `.dropdownItem:active { background: hover }`.
private struct MenuRowStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.background(configuration.isPressed ? AppTheme.backgroundHover : Color.clear)
    }
}

// MARK: - MobileMenu (the L2 Menu)

/// The page's create action, centered in the bar.
struct MobileMenuAction {
    let label: String
    let icon: String
    let action: () -> Void
}

/// The page's context (history, saved notes) on the standard surface. Its hamburger leads to
/// the L1 Menu, its close button to the page. The bar: 44 tall circle buttons, padding 8, no border.
/// Dialogs its context raises cover the whole menu, as the web's `position: fixed` modals cover
/// the viewport wherever they're raised.
struct MobileMenu<Context: View>: View {
    @EnvironmentObject var router: AppRouter
    var action: MobileMenuAction?
    let onClose: () -> Void
    @ViewBuilder var context: Context

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                circleButton("menu", L("layout.mobileMenu.menu")) { router.isAppMenuOpen = true }
                actionPill.frame(maxWidth: .infinity)
                circleButton("close", L("layout.mobileMenu.close"), action: onClose)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)

            context
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .padding(.horizontal, 12)
                .padding(.bottom, 8)
                .environment(\.modalsCoverMenu, true)
        }
        .background(AppTheme.background.ignoresSafeArea())
        .overlayPreferenceValue(MenuModalKey.self) { modal in
            ZStack {
                if let modal {
                    WebModal(title: modal.title, maxWidth: modal.maxWidth, scrollsContent: modal.scrollsContent, onClose: modal.onClose) {
                        modal.content
                    }
                }
            }
            .animation(.easeOut(duration: 0.3), value: modal?.title)
        }
        // The page stays mounted underneath; VoiceOver mustn't reach it.
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(.isModal)
    }

    @ViewBuilder
    private var actionPill: some View {
        if let action {
            Button(action: action.action) {
                HStack(spacing: 8) {
                    WebIcon(name: action.icon, size: 16, color: .white)
                    Text(action.label)
                        .webText(arial: 15, bold: true)
                        .foregroundStyle(.white)
                        .lineLimit(1)
                }
                .padding(.leading, 18)
                .padding(.trailing, 22)
                .frame(height: 44)
                .background(AppTheme.buttonPrimary)
                .clipShape(Capsule())
                .contentShape(Capsule())
            }
            .buttonStyle(WebPressStyle())
        } else {
            Color.clear.frame(height: 44)
        }
    }

    private func circleButton(_ icon: String, _ label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            WebIcon(name: icon, size: 20, color: AppTheme.textPrimary)
                .frame(width: 44, height: 44)
                .background(Color(.sRGB, red: 127 / 255, green: 127 / 255, blue: 127 / 255, opacity: 0.18))
                .clipShape(Circle())
                .contentShape(Circle())
        }
        .buttonStyle(WebPressStyle())
        .accessibilityLabel(label)
    }
}

// MARK: - Modal (Modal.module.scss)

/// Centered dialog: 90% width (max 500 by default), 1pt border, radius 12, header with a
/// 20/600 title and ×, scrolling content with 24pt padding; dim + light blur behind. It hugs
/// its content up to 90% of the height left above the keyboard.
struct WebModal<Content: View>: View {
    let title: String
    var maxWidth: CGFloat = 500
    /// False for content that scrolls itself and can shrink when space runs out.
    var scrollsContent = true
    let onClose: () -> Void
    @ViewBuilder var content: Content

    @State private var contentHeight: CGFloat = 0

    var body: some View {
        GeometryReader { proxy in
            ZStack {
                Color.black.opacity(0.5)
                    .background(BackdropBlur(fraction: 0.14))
                    .ignoresSafeArea()
                    .onTapGesture(perform: onClose)

                VStack(spacing: 0) {
                    header
                    if scrollsContent {
                        ScrollView {
                            content
                                .padding(24)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { contentHeight = $0 }
                        }
                        .scrollBounceBehavior(.basedOnSize)
                        .frame(maxHeight: contentHeight)
                    } else {
                        content
                            .padding(24)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                .padding(1)
                .background(AppTheme.backgroundSecondary)
                .clipShape(RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(AppTheme.border, lineWidth: 1))
                .shadow(color: .black.opacity(0.2), radius: 12.5, y: 10)
                .frame(width: min(proxy.size.width * 0.9, maxWidth))
                .frame(maxHeight: proxy.size.height * 0.9)
                .transition(.opacity.combined(with: .offset(y: 20)))
            }
            .frame(width: proxy.size.width, height: proxy.size.height)
        }
        .ignoresSafeArea(.container, edges: .bottom)
        .preference(key: DialogShownKey.self, value: true)
    }

    private var header: some View {
        HStack(spacing: 12) {
            WebTruncatedLine(title)
                .webText(20, 600)
                .foregroundStyle(AppTheme.textPrimary)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button(action: onClose) {
                Text("×").webText(arial: 24, lineHeight: 24).foregroundStyle(AppTheme.textSecondary)
            }
            .buttonStyle(WebPressStyle())
            .accessibilityLabel(L("layout.mobileMenu.close"))
        }
        .padding(.horizontal, 24)
        .padding(.vertical, 16)
        .padding(.bottom, 1)
        .overlay(alignment: .bottom) { Rectangle().fill(AppTheme.border).frame(height: 1) }
    }
}

extension EnvironmentValues {
    /// True inside the L2 Menu's context, whose dialogs the menu shows over itself.
    @Entry var modalsCoverMenu = false
}

/// A dialog raised inside the L2 Menu, for `MobileMenu` to show.
struct MenuModal {
    let title: String
    let maxWidth: CGFloat
    let scrollsContent: Bool
    let onClose: () -> Void
    let content: AnyView
}

struct MenuModalKey: PreferenceKey {
    static var defaultValue: MenuModal? { nil }
    static func reduce(value: inout MenuModal?, nextValue: () -> MenuModal?) { value = value ?? nextValue() }
}

private struct WebModalPresenter<ModalContent: View>: ViewModifier {
    @Environment(\.modalsCoverMenu) private var coversMenu
    @Binding var isPresented: Bool
    let title: String
    let maxWidth: CGFloat
    let scrollsContent: Bool
    let modalContent: () -> ModalContent

    func body(content: Content) -> some View {
        if coversMenu {
            // A transform, not `preference(_:value:)`, which would hide the dialogs of the
            // modifiers this one wraps.
            content.transformPreference(MenuModalKey.self) { modal in
                guard isPresented, modal == nil else { return }
                modal = MenuModal(
                    title: title,
                    maxWidth: maxWidth,
                    scrollsContent: scrollsContent,
                    onClose: { isPresented = false },
                    content: AnyView(modalContent())
                )
            }
        } else {
            content
                .overlay {
                    if isPresented {
                        WebModal(title: title, maxWidth: maxWidth, scrollsContent: scrollsContent, onClose: { isPresented = false }, content: modalContent)
                    }
                }
                .animation(.easeOut(duration: 0.3), value: isPresented)
        }
    }
}

extension View {
    /// Presents a `WebModal` above this (full-screen) view, or above the whole L2 Menu when this
    /// view is inside it.
    func webModal<Content: View>(isPresented: Binding<Bool>, title: String, maxWidth: CGFloat = 500, scrollsContent: Bool = true, @ViewBuilder content: @escaping () -> Content) -> some View {
        modifier(WebModalPresenter(isPresented: isPresented, title: title, maxWidth: maxWidth, scrollsContent: scrollsContent, modalContent: content))
    }
}
