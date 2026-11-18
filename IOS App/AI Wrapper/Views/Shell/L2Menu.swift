import SwiftUI
import UIKit

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
        .overlay {
            if isFocused {
                Capsule().strokeBorder(AppTheme.primary, lineWidth: 2)
            }
        }
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

/// Results of the unified search API, listed in a card: a history card with the chat widgets'
/// rows, or a directory card. The request goes out once typing pauses.
struct MenuSearchResults: View {
    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var router: AppRouter
    let query: String
    let types: [String]
    let untitledLabel: String
    var variant = SidebarWidgetVariant.directory
    let onSelect: (SearchResultItem) -> Void

    private enum Phase: Equatable {
        case loading, failed
        case notSetUp(SearchSetupReason)
        case loaded([SearchResultItem])
    }

    @State private var phase = Phase.loading

    private static let debounce: Duration = .milliseconds(300)

    var body: some View {
        SidebarWidget(variant: variant) {
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
            case .loaded(let results) where variant == .history:
                HuggingScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        MenuSectionLabel(title: L("layout.mobileMenu.searchResults"))
                        ForEach(results) { result in
                            menuRow(result)
                        }
                    }
                    .padding(.horizontal, 6)
                    .padding(.bottom, 8)
                }
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
        .task(id: query) { await search() }
    }

    /// A result as the chat widgets' rows look: 62pt, padded 11 by 12, a hairline under it.
    private func menuRow(_ result: SearchResultItem) -> some View {
        Button { onSelect(result) } label: {
            VStack(alignment: .leading, spacing: 4) {
                WebTruncatedLine(displayTitle(result))
                    .sidebarRowText(.history)
                    .frame(maxWidth: .infinity, alignment: .leading)
                WebTruncatedLine(result.snippet)
                    .webText(arial: 11.52, lineHeight: 13.824)
                    .foregroundStyle(AppTheme.textMuted)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 11)
            .frame(maxWidth: .infinity, minHeight: SidebarRowTokens.history.minHeight, alignment: .topLeading)
            .contentShape(Rectangle())
        }
        .buttonStyle(SidebarRowPressStyle(.history))
        .menuRowHairline()
        .accessibilityIdentifier("menu-search-result-\(result.key)")
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
                    .sidebarRowText(.directory)
                    .frame(maxWidth: .infinity, alignment: .leading)
                WebTruncatedLine(result.snippet)
                    .webText(arial: 11.52, lineHeight: 13.824)
                    .foregroundStyle(AppTheme.textMuted)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 9.6)
            .frame(minHeight: SidebarRowTokens.directory.minHeight)
            .contentShape(Rectangle())
        }
        .buttonStyle(SidebarRowPressStyle(.directory))
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

// MARK: - Menu list rows (SidebarListPanel `.menuVariant.surfaceCard`)

/// A section label inside a menu widget (Pinned, Recents, a project's Recent): uppercase
/// 11.52/700, tracked 0.05em, muted, with an optional 13pt glyph.
struct MenuSectionLabel: View {
    let title: String
    var icon: String?

    var body: some View {
        HStack(spacing: 5.6) {
            if let icon {
                WebIcon(name: icon, size: 13, color: AppTheme.textMuted)
            }
            Text(title.uppercased())
                .webText(11.52, 700)
                .kerning(0.576)
                .foregroundStyle(AppTheme.textMuted)
                .lineLimit(1)
        }
        .padding(.top, 10)
        .padding(.leading, 10)
        .padding(.trailing, 12)
        .padding(.bottom, 4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityAddTraits(.isHeader)
    }
}

/// A row's always-visible 44pt button (a project's plus): a 14pt glyph, 8pt corners, and the
/// selected fill with the accent while pressed.
struct MenuRowAction: View {
    let icon: String
    let label: String
    var identifier: String?
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Color.clear
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(MenuRowActionStyle(icon: icon))
        .accessibilityLabel(label)
        .accessibilityIdentifier(identifier ?? "")
    }
}

private struct MenuRowActionStyle: ButtonStyle {
    let icon: String

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .overlay {
                WebIcon(name: icon, size: 14, color: configuration.isPressed ? AppTheme.primary : AppTheme.textMuted)
            }
            .background(configuration.isPressed ? AppTheme.backgroundSelected : Color.clear)
            .clipShape(RoundedRectangle(cornerRadius: 8))
    }
}

extension View {
    /// The 1pt line under a menu row, drawn over its bottom edge so the row keeps its height.
    func menuRowHairline(_ visible: Bool = true) -> some View {
        overlay(alignment: .bottom) {
            if visible {
                Rectangle().fill(AppTheme.sidebarHairline).frame(height: 1).allowsHitTesting(false)
            }
        }
    }

    /// A tree under a row (a project's chats, a chat's forks): 12pt in, a 1pt guide, 8pt more.
    func menuTreeGuide() -> some View {
        self
            .padding(.leading, 9)
            .overlay(alignment: .leading) { Rectangle().fill(AppTheme.borderLight).frame(width: 1) }
            .padding(.leading, 12)
    }
}

// MARK: - Swipe rows (SwipeableRow.tsx)

struct SwipeAction: Identifiable {
    enum Tone { case neutral, primary, muted }

    let icon: String
    let label: String
    let tone: Tone
    var identifier: String?
    let action: () -> Void
    var id: String { label }
}

/// Which tray of which row is open. One row in a panel stays open at a time.
struct SwipeOpenRow: Equatable {
    enum Side { case leading, trailing }

    let id: String
    let side: Side
}

/// SwipeableRow.tsx: swiping a row right opens its leading tray (Pin), left its trailing tray
/// (Move, Delete). The row narrows to make room, so its title stays readable beside the tray.
/// A tap on any row while one is open closes it instead of selecting. A right swipe that starts
/// within 24pt of the screen's left edge belongs to the edge swipe back to the L1 Menu. VoiceOver
/// reaches the actions as custom actions, since it has no swipe.
struct SwipeableRow<Content: View>: View {
    let id: String
    @Binding var openRow: SwipeOpenRow?
    var leading: [SwipeAction] = []
    var trailing: [SwipeAction] = []
    @ViewBuilder var content: Content

    static var actionWidth: CGFloat { 56 }
    static var edgeGuard: CGFloat { 24 }

    @State private var dragOffset: CGFloat?

    private var leadingWidth: CGFloat { CGFloat(leading.count) * Self.actionWidth }
    private var trailingWidth: CGFloat { CGFloat(trailing.count) * Self.actionWidth }

    /// Positive while the leading tray shows, negative while the trailing one does.
    private var restingOffset: CGFloat {
        guard let openRow, openRow.id == id else { return 0 }
        return openRow.side == .leading ? leadingWidth : -trailingWidth
    }

    private var offset: CGFloat { dragOffset ?? restingOffset }

    var body: some View {
        HStack(spacing: 0) {
            if offset > 0 {
                tray(leading, width: offset)
            }
            content
                .frame(maxWidth: .infinity)
                .overlay {
                    if openRow != nil {
                        Color.clear
                            .contentShape(Rectangle())
                            .onTapGesture { openRow = nil }
                    }
                }
            if offset < 0 {
                tray(trailing, width: -offset)
            }
        }
        .clipped()
        .gesture(HorizontalPanGesture(
            canPanLeft: restingOffset > 0 || !trailing.isEmpty,
            canPanRight: restingOffset < 0 || !leading.isEmpty,
            guardsLeftEdge: restingOffset == 0,
            edgeGuard: Self.edgeGuard,
            onBegan: { if openRow?.id != id { openRow = nil } },
            onChanged: { translation in dragOffset = clamped(restingOffset + translation) },
            onEnded: { translation in
                let target = clamped(restingOffset + translation)
                withAnimation(.easeOut(duration: 0.2)) {
                    openRow = Self.side(forOffset: target, leadingWidth: leadingWidth, trailingWidth: trailingWidth).map { SwipeOpenRow(id: id, side: $0) }
                    dragOffset = nil
                }
            }
        ))
        .animation(.easeOut(duration: 0.2), value: openRow)
        .accessibilityActions {
            ForEach(leading + trailing) { action in
                Button(action.label, action: action.action)
            }
        }
    }

    private func clamped(_ value: CGFloat) -> CGFloat {
        max(-trailingWidth, min(leadingWidth, value))
    }

    /// Where a released swipe settles: a tray opens once dragged past half its width.
    static func side(forOffset offset: CGFloat, leadingWidth: CGFloat, trailingWidth: CGFloat) -> SwipeOpenRow.Side? {
        if leadingWidth > 0, offset > leadingWidth / 2 { return .leading }
        if trailingWidth > 0, offset < -trailingWidth / 2 { return .trailing }
        return nil
    }

    private func tray(_ actions: [SwipeAction], width: CGFloat) -> some View {
        HStack(spacing: 0) {
            ForEach(actions) { action in
                Button {
                    action.action()
                    openRow = nil
                } label: {
                    WebIcon(name: action.icon, size: 14, color: foreground(action.tone))
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .background(background(action.tone))
                        .contentShape(Rectangle())
                }
                .buttonStyle(WebPressStyle())
                .accessibilityHidden(true)
                .accessibilityIdentifier(action.identifier ?? "")
            }
        }
        .frame(width: width)
        .clipped()
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

/// A pan that only begins on a mostly horizontal drag toward a side the row can open or close,
/// so vertical drags stay with the surrounding scroll view and edge swipes with the menu.
private struct HorizontalPanGesture: UIGestureRecognizerRepresentable {
    let canPanLeft: Bool
    let canPanRight: Bool
    /// A closed row leaves right swipes that start at the screen's left edge to the edge swipe.
    let guardsLeftEdge: Bool
    let edgeGuard: CGFloat
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
        context.coordinator.canPanLeft = canPanLeft
        context.coordinator.canPanRight = canPanRight
        context.coordinator.guardsLeftEdge = guardsLeftEdge
        context.coordinator.edgeGuard = edgeGuard
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
        var canPanLeft = false
        var canPanRight = false
        var guardsLeftEdge = true
        var edgeGuard: CGFloat = 24

        func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
            guard let pan = gestureRecognizer as? UIPanGestureRecognizer else { return true }
            let velocity = pan.velocity(in: pan.view)
            guard abs(velocity.x) > abs(velocity.y) else { return false }
            if velocity.x < 0 { return canPanLeft }
            guard canPanRight else { return false }
            let startX = pan.location(in: nil).x - pan.translation(in: nil).x
            return !(guardsLeftEdge && startX < edgeGuard)
        }
    }
}
