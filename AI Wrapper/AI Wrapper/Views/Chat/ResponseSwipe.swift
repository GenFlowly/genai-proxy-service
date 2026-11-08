import SwiftUI
import UIKit

/// The rules of paging between vendors' responses with a sideways drag (useResponseSwipe.ts).
enum ResponseSwipeRules {
    enum Side { case previous, next }

    static let lockRatio: CGFloat = 1.5
    /// A touch held this long before moving is a text selection.
    static let holdLimit: TimeInterval = 0.4
    static let commitFraction: CGFloat = 0.5
    static let commitVelocity: CGFloat = 500 // pt per second
    static let rubberBandFactor: CGFloat = 0.3
    static let rubberBandLimit: CGFloat = 64
    static let labelLinger: Duration = .seconds(1)

    static func neighbor(of current: String?, in vendors: [String], side: Side) -> String? {
        guard let current, let index = vendors.firstIndex(of: current) else { return nil }
        let target = index + (side == .next ? 1 : -1)
        return vendors.indices.contains(target) ? vendors[target] : nil
    }

    static func rubberBand(_ dx: CGFloat) -> CGFloat {
        let resisted = min(abs(dx) * rubberBandFactor, rubberBandLimit)
        return dx < 0 ? -resisted : resisted
    }

    static func commits(dx: CGFloat, velocity: CGFloat, page: CGFloat) -> Bool {
        abs(dx) > page * commitFraction || (abs(velocity) > commitVelocity && velocity * dx > 0)
    }
}

/// Observed field by field, so that only the views reading `dx` follow the finger and the
/// markdown in the cards is left alone.
@Observable
final class ResponseSwipeModel {
    var dx: CGFloat = 0
    var page: CGFloat = 0
    var pageHeight: CGFloat = 0
    var neighbor: Neighbor?
    var isDragging = false
    var isLabelVisible = false

    struct Neighbor: Equatable {
        let vendor: String
        let side: ResponseSwipeRules.Side
    }

    @ObservationIgnored private var hideLabel: Task<Void, Never>?

    func showLabel() {
        hideLabel?.cancel()
        withAnimation(.easeOut(duration: 0.12)) { isLabelVisible = true }
    }

    func hideLabelAfterLinger() {
        hideLabel?.cancel()
        hideLabel = Task { [weak self] in
            try? await Task.sleep(for: ResponseSwipeRules.labelLinger)
            guard !Task.isCancelled else { return }
            withAnimation(.easeOut(duration: 0.2)) { self?.isLabelVisible = false }
        }
    }

    /// Where a card sits while the finger holds the row: the incoming one a page to the side.
    func baseOffset(forNeighbor isNeighbor: Bool) -> CGFloat {
        guard isNeighbor, let neighbor else { return 0 }
        return neighbor.side == .next ? page : -page
    }
}

/// Moves a card with the finger. With `factor: -1` it holds the card's action bar still
/// while the card moves under it: the bar belongs to the turn, not to one response.
struct ResponseSwipeOffset: ViewModifier {
    let model: ResponseSwipeModel
    var isNeighbor = false
    var factor: CGFloat = 1

    func body(content: Content) -> some View {
        content.offset(x: model.dx * factor + model.baseOffset(forNeighbor: isNeighbor))
    }
}

/// One card at a time, sized by the current one. An incoming card overlaps it and stays out
/// of the scroll height, and shares its ForEach identity so a finished swipe keeps its views.
struct ResponsePagerLayout: Layout {
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        subviews.first?.sizeThatFits(ProposedViewSize(width: proposal.width, height: nil)) ?? .zero
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        for subview in subviews {
            subview.place(at: bounds.origin, anchor: .topLeading, proposal: ProposedViewSize(width: bounds.width, height: nil))
        }
    }
}

/// A pan that only begins on a clearly sideways drag. Not a SwiftUI DragGesture, which would
/// take every swipe from the shell's edge gesture and the page's scroll view.
struct ResponseSwipeGesture: UIGestureRecognizerRepresentable {
    var isEnabled: Bool
    let onBegan: () -> Void
    let onChanged: (CGFloat) -> Void
    let onEnded: (_ dx: CGFloat, _ velocity: CGFloat, _ wasCancelled: Bool) -> Void

    func makeCoordinator(converter: CoordinateSpaceConverter) -> Coordinator { Coordinator() }

    func makeUIGestureRecognizer(context: Context) -> UIPanGestureRecognizer {
        let recognizer = UIPanGestureRecognizer()
        recognizer.maximumNumberOfTouches = 1
        recognizer.delegate = context.coordinator
        return recognizer
    }

    func updateUIGestureRecognizer(_ recognizer: UIPanGestureRecognizer, context: Context) {
        recognizer.isEnabled = isEnabled
    }

    func handleUIGestureRecognizerAction(_ recognizer: UIPanGestureRecognizer, context: Context) {
        let view = recognizer.view
        let translation = recognizer.translation(in: view).x
        switch recognizer.state {
        case .began:
            onBegan()
            onChanged(translation)
        case .changed:
            onChanged(translation)
        case .ended:
            onEnded(translation, recognizer.velocity(in: view).x, false)
        case .cancelled, .failed:
            onEnded(translation, 0, true)
        default:
            break
        }
    }

    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        private var touchedView: UIView?
        private var touchTime: TimeInterval = 0

        func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
            touchedView = touch.view
            touchTime = touch.timestamp
            return touch.location(in: nil).x > EdgeSwipeGesture.edgeZone
        }

        func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
            guard let pan = gestureRecognizer as? UIPanGestureRecognizer else { return true }
            let velocity = pan.velocity(in: pan.view)
            guard abs(velocity.x) > abs(velocity.y) * ResponseSwipeRules.lockRatio else { return false }
            guard ProcessInfo.processInfo.systemUptime - touchTime < ResponseSwipeRules.holdLimit else { return false }
            return !touchBelongsToContent(draggingLeft: velocity.x < 0)
        }

        /// A horizontal ScrollView takes any sideways drag, even with nothing left to scroll,
        /// so it has to wait for this pan to decide.
        func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldBeRequiredToFailBy other: UIGestureRecognizer) -> Bool {
            guard other is UIPanGestureRecognizer, let scroller = other.view as? UIScrollView else { return false }
            return scroller.contentSize.height <= scroller.bounds.height + 1
        }

        /// Selected text keeps its handles, and tables and code blocks keep the drag while
        /// they can still scroll that way.
        private func touchBelongsToContent(draggingLeft: Bool) -> Bool {
            var view = touchedView
            while let current = view {
                if let text = current as? UITextView, text.selectedRange.length > 0 { return true }
                if let scroller = current as? UIScrollView, scroller.isScrollEnabled {
                    let maxOffset = scroller.contentSize.width - scroller.bounds.width
                    if maxOffset > 1, draggingLeft ? scroller.contentOffset.x < maxOffset - 1 : scroller.contentOffset.x > 1 {
                        return true
                    }
                }
                view = current.superview
            }
            return false
        }
    }
}

/// Who wrote the response under the finger, shown only during a swipe. It stays at the middle
/// of the part of the response on screen. The header names the vendor for VoiceOver.
struct ResponseSwipeLabel: View {
    let model: ResponseSwipeModel
    let vendor: AIVendor
    let modelName: String?
    let position: Int
    let total: Int

    private static let panel = Color(uiColor: UIColor {
        $0.userInterfaceStyle == .dark
            ? UIColor(red: 28 / 255, green: 28 / 255, blue: 30 / 255, alpha: 0.78)
            : UIColor(white: 1, alpha: 0.92)
    })
    private static let hairline = Color(uiColor: UIColor {
        $0.userInterfaceStyle == .dark ? UIColor.white.withAlphaComponent(0.14) : UIColor.black.withAlphaComponent(0.1)
    })
    private static let shadow = Color(uiColor: UIColor {
        UIColor.black.withAlphaComponent($0.userInterfaceStyle == .dark ? 0.4 : 0.22)
    })

    var body: some View {
        if model.isLabelVisible {
            VStack(spacing: 6) {
                VendorBrandName(vendor: vendor)
                    .webText(16, 600, lineHeight: 20)
                    .foregroundStyle(AppTheme.textPrimary)
                    .lineLimit(1)
                if let modelName, !modelName.isEmpty {
                    Text(modelName)
                        .webText(12, lineHeight: 14)
                        .kerning(0.2)
                        .foregroundStyle(AppTheme.textMuted)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
                if total > 1 {
                    HStack(spacing: 6) {
                        ForEach(0..<total, id: \.self) { index in
                            Circle()
                                .fill(AppTheme.textPrimary.opacity(index == position ? 1 : 0.3))
                                .frame(width: 6, height: 6)
                        }
                    }
                    .padding(.top, 4)
                } else {
                    Text(L("conversation.response.onlyResponse"))
                        .webText(11, lineHeight: 13)
                        .foregroundStyle(AppTheme.textMuted)
                        .padding(.top, 4)
                }
            }
            .padding(EdgeInsets(top: 12, leading: 14, bottom: 10, trailing: 14))
            .frame(minWidth: 156)
            .frame(maxWidth: 288)
            .background(Self.panel)
            .background(BackdropBlur(fraction: 0.16))
            .clipShape(RoundedRectangle(cornerRadius: 16))
            .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Self.hairline, lineWidth: 1))
            .shadow(color: Self.shadow, radius: 14, y: 8)
            .visualEffect { [pageHeight = model.pageHeight] view, proxy in
                let frame = proxy.frame(in: .scrollView(axis: .vertical))
                let viewport = proxy.bounds(of: .scrollView(axis: .vertical))?.height ?? 0
                let visibleTop = max(frame.minY, 0)
                let visibleBottom = min(frame.minY + pageHeight, viewport)
                return view.offset(y: (visibleTop + visibleBottom - frame.height) / 2 - frame.minY)
            }
            .transition(.opacity)
            .allowsHitTesting(false)
            .accessibilityHidden(true)
        }
    }
}
