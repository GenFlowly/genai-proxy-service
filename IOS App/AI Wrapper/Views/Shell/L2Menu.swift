import SwiftUI
import UIKit

// MARK: - Card chrome (sidebar-card.scss)

extension View {
    /// The floating sidebar card shared by VerticalSplit's panes and single cards.
    func sidebarCard() -> some View {
        self
            .frame(maxWidth: .infinity)
            .background(AppTheme.sidebarBackground)
            .padding(1)
            .background(AppTheme.sidebarMaterial)
            .clipShape(RoundedRectangle(cornerRadius: DSRadius.lg))
            .overlay(RoundedRectangle(cornerRadius: DSRadius.lg).strokeBorder(AppTheme.sidebarHairline, lineWidth: 1))
            .shadow(color: AppTheme.sidebarShadow, radius: 8, y: 4)
    }
}

/// A scroll view as tall as its content until the surrounding column runs out of room, so a
/// single card hugs its rows.
struct HuggingScrollView<Content: View>: View {
    @ViewBuilder var content: Content
    @State private var contentHeight: CGFloat = 0

    var body: some View {
        ScrollView {
            content.onGeometryChange(for: CGFloat.self) { $0.size.height } action: { contentHeight = $0 }
        }
        .scrollBounceBehavior(.basedOnSize)
        .frame(maxHeight: contentHeight)
    }
}

// MARK: - Search field (MenuSearchField.tsx)

/// The search pill at the bottom of the menu, within thumb reach.
struct MenuSearchField: View {
    @Binding var text: String
    let placeholder: String
    @FocusState private var isFocused: Bool

    var body: some View {
        HStack(spacing: 8) {
            WebIcon(name: "search", size: 18, color: AppTheme.textMuted)
            TextField(text: $text) {
                Text(placeholder).foregroundStyle(AppTheme.textMuted)
            }
            .webText(arial: 16)
            .foregroundStyle(AppTheme.textPrimary)
            .tint(AppTheme.primary)
            .focused($isFocused)
            .autocorrectionDisabled()
            .textInputAutocapitalization(.never)
            .submitLabel(.search)
            .onSubmit { isFocused = false }
            .accessibilityIdentifier("mobile-menu-search")
            if !text.isEmpty {
                Button { text = "" } label: {
                    WebIcon(name: "close", size: 16, color: AppTheme.textMuted)
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(WebPressStyle())
                .accessibilityLabel(L("layout.mobileMenu.clearSearch"))
            }
        }
        .padding(.leading, 14)
        .padding(.trailing, text.isEmpty ? 14 : 0)
        .frame(height: 44)
        .background(Color(.sRGB, red: 127 / 255, green: 127 / 255, blue: 127 / 255, opacity: 0.18))
        .clipShape(Capsule())
    }
}

// MARK: - Menu body (MobileMenuBody.tsx)

/// The L2 Menu's content area: the page's cards above the bottom search pill. Results replace
/// the cards while searching; the cards stay mounted so clearing the search returns to the same
/// scroll position and open rows.
struct MobileMenuBody<Cards: View, Results: View>: View {
    @Binding var searchText: String
    let searchPlaceholder: String
    let isShowingResults: Bool
    @ViewBuilder var cards: Cards
    @ViewBuilder var results: Results

    var body: some View {
        VStack(spacing: 12) {
            ZStack(alignment: .top) {
                cards
                    .frame(maxHeight: .infinity, alignment: .top)
                    .opacity(isShowingResults ? 0 : 1)
                    .allowsHitTesting(!isShowingResults)
                    .accessibilityHidden(isShowingResults)
                if isShowingResults {
                    results.frame(maxHeight: .infinity, alignment: .top)
                }
            }
            MenuSearchField(text: $searchText, placeholder: searchPlaceholder)
        }
    }
}

extension MobileMenuBody where Results == EmptyView {
    init(searchText: Binding<String>, searchPlaceholder: String, @ViewBuilder cards: () -> Cards) {
        self._searchText = searchText
        self.searchPlaceholder = searchPlaceholder
        self.isShowingResults = false
        self.cards = cards()
        self.results = EmptyView()
    }
}

// MARK: - Search results (MenuSearchResults.tsx)

/// Results of the unified search API, listed in a card. The request goes out once typing pauses.
struct MenuSearchResults: View {
    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var router: AppRouter
    let query: String
    let types: [String]
    let untitledLabel: String
    let onSelect: (SearchResultItem) -> Void

    private enum Phase: Equatable {
        case loading, failed
        case notSetUp(SearchSetupReason)
        case loaded([SearchResultItem])
    }

    @State private var phase = Phase.loading

    private static let debounce: Duration = .milliseconds(300)

    var body: some View {
        Group {
            switch phase {
            case .loading:
                VStack(spacing: 3) {
                    ForEach(0..<5, id: \.self) { _ in
                        RoundedRectangle(cornerRadius: DSRadius.sm).fill(AppTheme.borderLight).frame(height: 40)
                    }
                }
                .padding(4)
            case .failed:
                message(L("layout.mobileMenu.searchFailed"))
            case .notSetUp(let reason):
                VStack(spacing: 0) {
                    message(reason.message)
                    openSettingsButton(reason)
                }
            case .loaded(let results) where results.isEmpty:
                message(L("layout.mobileMenu.noSearchResults"))
            case .loaded(let results):
                HuggingScrollView {
                    VStack(alignment: .leading, spacing: 2) {
                        MenuCardLabel(title: L("layout.mobileMenu.searchResults"))
                        ForEach(results) { result in
                            row(result)
                        }
                    }
                    .padding(.bottom, 8)
                }
            }
        }
        .sidebarCard()
        .task(id: query) { await search() }
    }

    private func search() async {
        if case .loaded = phase {} else { phase = .loading }
        do {
            try await Task.sleep(for: Self.debounce)
            let token = try await auth.getAccessTokenSilently()
            let results = try await SearchService.search(token: token, query: query, types: types)
            try Task.checkCancellation()
            phase = .loaded(results)
        } catch is CancellationError {
            return
        } catch {
            phase = SearchSetupReason(error).map(Phase.notSetUp) ?? .failed
        }
    }

    private func openSettingsButton(_ reason: SearchSetupReason) -> some View {
        Button { router.navigate(.settings(reason.settingsSection)) } label: {
            Text(L("common.search.openSettings"))
                .webText(arial: 13.6)
                .foregroundStyle(AppTheme.textMuted)
                .frame(maxWidth: .infinity)
                .padding(10.4)
                .overlay(WebDashedBorder(color: AppTheme.border, cornerRadius: DSRadius.sm))
        }
        .buttonStyle(WebPressStyle())
        .accessibilityIdentifier("menu-search-open-settings")
        .padding(.horizontal, 4)
        .padding(.bottom, 8)
    }

    private func message(_ text: String) -> some View {
        Text(text)
            .webText(13.6, lineHeight: 20.4)
            .foregroundStyle(AppTheme.textMuted)
            .multilineTextAlignment(.center)
            .padding(.horizontal, 8)
            .padding(.vertical, 16)
            .frame(maxWidth: .infinity)
    }

    private func row(_ result: SearchResultItem) -> some View {
        Button { onSelect(result) } label: {
            VStack(alignment: .leading, spacing: 4) {
                WebTruncatedLine(displayTitle(result))
                    .webText(arial: 15.2, lineHeight: 19.76)
                    .foregroundStyle(AppTheme.textSecondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                WebTruncatedLine(result.snippet)
                    .webText(arial: 11.52, lineHeight: 13.824)
                    .foregroundStyle(AppTheme.textMuted)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 9.6)
            .frame(minHeight: 48)
            .contentShape(Rectangle())
        }
        .buttonStyle(RowPressStyle())
    }

    private func displayTitle(_ result: SearchResultItem) -> String {
        let title = result.title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return title.isEmpty ? untitledLabel : title
    }
}

/// An uppercase card header that doesn't collapse.
struct MenuCardLabel: View {
    let title: String

    var body: some View {
        Text(title.uppercased())
            .webText(arial: 12, bold: true)
            .kerning(0.6)
            .foregroundStyle(AppTheme.textMuted)
            .padding(.horizontal, 8)
            .frame(minHeight: 42)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// A sublabel inside a card, under its uppercase header (Pinned, Recents, date groups).
struct MenuSubLabel: View {
    let title: String
    var icon: String?

    var body: some View {
        HStack(spacing: 5.6) {
            if let icon {
                WebIcon(name: icon, size: 13, color: AppTheme.textMuted)
            }
            Text(title)
                .webText(arial: 12, bold: true)
                .foregroundStyle(AppTheme.textMuted)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6.4)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - Swipe rows (SwipeableRow.tsx)

struct SwipeAction: Identifiable {
    enum Tone { case neutral, primary, muted }

    let icon: String
    let label: String
    let tone: Tone
    let action: () -> Void
    var id: String { label }
}

/// Slides a row left to reveal its actions. Only one row in a panel stays open, and a tap on any
/// row while one is open closes it instead of selecting. VoiceOver reaches the actions as custom
/// actions, since it has no swipe.
struct SwipeableRow<Content: View>: View {
    let id: String
    @Binding var openRowId: String?
    let actions: [SwipeAction]
    @ViewBuilder var content: Content

    private static var actionWidth: CGFloat { 48 }

    @State private var dragOffset: CGFloat?

    private var trayWidth: CGFloat { CGFloat(actions.count) * Self.actionWidth }
    private var isOpen: Bool { openRowId == id }
    private var offset: CGFloat { dragOffset ?? (isOpen ? -trayWidth : 0) }

    var body: some View {
        ZStack(alignment: .trailing) {
            if offset < 0 {
                tray
            }
            content
                .background(AppTheme.sidebarBackground)
                .overlay {
                    if openRowId != nil {
                        Color.clear
                            .contentShape(Rectangle())
                            .onTapGesture { openRowId = nil }
                    }
                }
                .offset(x: offset)
                .gesture(HorizontalPanGesture(
                    allowsRightPan: isOpen,
                    onBegan: { if !isOpen { openRowId = nil } },
                    onChanged: { translation in
                        let base = isOpen ? -trayWidth : 0
                        dragOffset = max(-trayWidth, min(0, base + translation))
                    },
                    onEnded: { translation in
                        let base = isOpen ? -trayWidth : 0
                        let target = max(-trayWidth, min(0, base + translation))
                        withAnimation(.easeOut(duration: 0.2)) {
                            openRowId = target < -trayWidth / 2 ? id : nil
                            dragOffset = nil
                        }
                    }
                ))
        }
        .clipShape(RoundedRectangle(cornerRadius: DSRadius.sm))
        .animation(.easeOut(duration: 0.2), value: isOpen)
        .accessibilityActions {
            ForEach(actions) { action in
                Button(action.label, action: action.action)
            }
        }
    }

    private var tray: some View {
        HStack(spacing: 0) {
            ForEach(actions) { action in
                Button {
                    action.action()
                    openRowId = nil
                } label: {
                    WebIcon(name: action.icon, size: 16, color: foreground(action.tone))
                        .frame(width: Self.actionWidth)
                        .frame(maxHeight: .infinity)
                        .background(background(action.tone))
                        .contentShape(Rectangle())
                }
                .buttonStyle(WebPressStyle())
                .accessibilityHidden(true)
            }
        }
        .frame(width: trayWidth)
    }

    private func background(_ tone: SwipeAction.Tone) -> Color {
        switch tone {
        case .neutral: return AppTheme.backgroundTertiary
        case .primary: return AppTheme.buttonPrimary
        case .muted: return AppTheme.conversationHeaderBackground
        }
    }

    private func foreground(_ tone: SwipeAction.Tone) -> Color {
        switch tone {
        case .neutral: return AppTheme.textPrimary
        case .primary: return .white
        case .muted: return AppTheme.conversationHeaderText
        }
    }
}

/// A pan that only begins on a mostly horizontal drag, so vertical drags stay with the
/// surrounding scroll view.
private struct HorizontalPanGesture: UIGestureRecognizerRepresentable {
    let allowsRightPan: Bool
    let onBegan: () -> Void
    let onChanged: (CGFloat) -> Void
    let onEnded: (CGFloat) -> Void

    func makeCoordinator(converter: CoordinateSpaceConverter) -> Coordinator { Coordinator() }

    func makeUIGestureRecognizer(context: Context) -> UIPanGestureRecognizer {
        let recognizer = UIPanGestureRecognizer()
        recognizer.delegate = context.coordinator
        return recognizer
    }

    func updateUIGestureRecognizer(_ recognizer: UIPanGestureRecognizer, context: Context) {
        context.coordinator.allowsRightPan = allowsRightPan
    }

    func handleUIGestureRecognizerAction(_ recognizer: UIPanGestureRecognizer, context: Context) {
        let translation = recognizer.translation(in: recognizer.view).x
        switch recognizer.state {
        case .began:
            onBegan()
            onChanged(translation)
        case .changed:
            onChanged(translation)
        case .ended:
            onEnded(translation)
        case .cancelled, .failed:
            onEnded(0)
        default:
            break
        }
    }

    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        var allowsRightPan = false

        func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
            guard let pan = gestureRecognizer as? UIPanGestureRecognizer else { return true }
            let velocity = pan.velocity(in: pan.view)
            guard abs(velocity.x) > abs(velocity.y) else { return false }
            return velocity.x < 0 || allowsRightPan
        }
    }
}
