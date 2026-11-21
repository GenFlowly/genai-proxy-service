import SwiftUI

/// The scroll a SidebarStack gives the cards inside it: what to scroll to, how tall the view is,
/// and how many times the user has grabbed the column (a swipe tray closes then).
struct SidebarStackScroll {
    let proxy: ScrollViewProxy
    let viewportHeight: CGFloat
    let interactions: Int
}

private struct SidebarStackScrollKey: EnvironmentKey {
    static let defaultValue: SidebarStackScroll? = nil
}

extension EnvironmentValues {
    /// Set inside a SidebarStack: its cards take their full height and the stack scrolls.
    var sidebarStack: SidebarStackScroll? {
        get { self[SidebarStackScrollKey.self] }
        set { self[SidebarStackScrollKey.self] = newValue }
    }
}

/// SidebarStack.tsx: the scrolling body of a sidebar. SidebarWidgets stack with the gap between
/// them, each at its full height, in one column that scrolls as a whole; lists inside grow their
/// cards instead of scrolling, and paging follows the column's scroll. A stack inside another
/// stack only stacks its cards; the outer one scrolls.
struct SidebarStack<Content: View>: View {
    /// SidebarStack.module.scss: 12pt between the phone menu's cards.
    var spacing: CGFloat = 12
    /// Pull to refresh on the whole column.
    var refresh: (() async -> Void)?
    @ViewBuilder var content: Content

    @Environment(\.sidebarStack) private var outer
    @State private var viewportHeight: CGFloat = 0
    @State private var interactions = 0

    var body: some View {
        if outer != nil {
            VStack(spacing: spacing) { content }
        } else {
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(spacing: spacing) { content }
                        .environment(\.sidebarStack, SidebarStackScroll(proxy: proxy, viewportHeight: viewportHeight, interactions: interactions))
                }
                .scrollBounceBehavior(.basedOnSize)
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { viewportHeight = $0 }
                .onScrollPhaseChange { _, phase in
                    if phase == .interacting { interactions += 1 }
                }
                .modifier(OptionalRefresh(action: refresh))
            }
        }
    }
}

private struct OptionalRefresh: ViewModifier {
    let action: (() async -> Void)?

    func body(content: Content) -> some View {
        if let action {
            content.refreshable { await action() }
        } else {
            content
        }
    }
}
