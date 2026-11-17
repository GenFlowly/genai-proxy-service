import SwiftUI
import UIKit
import UIKit.UIGestureRecognizerSubclass

/// A swipe in from the left edge of the screen (EdgeSwipeContext.tsx). It stands in for the
/// top-left button: on a page it opens the page's menu or goes back, on the L2 Menu it opens
/// the L1 Menu. Scroll views and swipe rows near the edge wait for it to fail.
struct EdgeSwipeGesture: UIGestureRecognizerRepresentable {
    var isEnabled = true
    /// The shell's swipe lets a page's own (Back) go first.
    var yieldsToPageSwipe = false
    var onBegan: () -> Void = {}
    var onChanged: (CGFloat) -> Void = { _ in }
    let onEnded: (_ commits: Bool) -> Void

    /// Where a swipe has to start: the strip along the left edge of the screen.
    static let edgeZone: CGFloat = 24
    /// Released past this share of the screen, or flicked, the swipe goes through.
    static let commitFraction: CGFloat = 0.3
    static let commitVelocity: CGFloat = 500 // pt per second

    static func commits(translation: CGFloat, velocity: CGFloat, width: CGFloat) -> Bool {
        translation > width * commitFraction || velocity > commitVelocity
    }

    func makeCoordinator(converter: CoordinateSpaceConverter) -> Coordinator { Coordinator() }

    func makeUIGestureRecognizer(context: Context) -> Recognizer {
        let recognizer = Recognizer()
        recognizer.maximumNumberOfTouches = 1
        recognizer.delegate = context.coordinator
        return recognizer
    }

    func updateUIGestureRecognizer(_ recognizer: Recognizer, context: Context) {
        recognizer.isEnabled = isEnabled
        context.coordinator.yieldsToPageSwipe = yieldsToPageSwipe
    }

    func handleUIGestureRecognizerAction(_ recognizer: Recognizer, context: Context) {
        let view = recognizer.view
        let translation = max(0, recognizer.translation(in: view).x)
        switch recognizer.state {
        case .began:
            onBegan()
            onChanged(translation)
        case .changed:
            onChanged(translation)
        case .ended:
            let width = view?.bounds.width ?? .infinity
            onEnded(Self.commits(translation: translation, velocity: recognizer.velocity(in: view).x, width: width))
        case .cancelled, .failed:
            onEnded(false)
        default:
            break
        }
    }

    /// A pan that only starts from the left edge. Not UIScreenEdgePanGestureRecognizer, which
    /// needs edge information that only real touch hardware attaches to a touch. Its own type
    /// also lets the shell's swipe wait on a page's and not on anything else.
    final class Recognizer: UIPanGestureRecognizer {
        override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
            super.touchesBegan(touches, with: event)
            // Fails at once away from the edge, so nothing else waits on it there
            guard let touch = touches.first, touch.location(in: nil).x <= EdgeSwipeGesture.edgeZone else {
                state = .failed
                return
            }
        }
    }

    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        var yieldsToPageSwipe = false

        func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
            guard let pan = gestureRecognizer as? UIPanGestureRecognizer else { return true }
            let velocity = pan.velocity(in: pan.view)
            return velocity.x > abs(velocity.y)
        }

        func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldBeRequiredToFailBy other: UIGestureRecognizer) -> Bool {
            other is UIPanGestureRecognizer && !(other is Recognizer)
        }

        func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRequireFailureOf other: UIGestureRecognizer) -> Bool {
            yieldsToPageSwipe && other is Recognizer && other !== gestureRecognizer
        }
    }
}

extension View {
    /// The shadow along a menu's right edge, seen while it slides over the page (SlidePanel.module.scss).
    func menuEdgeShadow() -> some View {
        background(alignment: .trailing) {
            LinearGradient(colors: [.black.opacity(0.14), .clear], startPoint: .leading, endPoint: .trailing)
                .frame(width: 24)
                .offset(x: 24)
                .ignoresSafeArea()
                .allowsHitTesting(false)
                .accessibilityHidden(true)
        }
    }

    /// A page's Back, taken by a swipe from the left edge as well as its top-left button.
    func edgeSwipeBack(_ back: (() -> Void)?) -> some View {
        modifier(EdgeSwipeBack(back: back))
    }
}

private struct EdgeSwipeBack: ViewModifier {
    @Environment(\.allowsEdgeSwipe) private var allowsEdgeSwipe
    let back: (() -> Void)?

    func body(content: Content) -> some View {
        if let back {
            content.gesture(EdgeSwipeGesture(isEnabled: allowsEdgeSwipe) { commits in
                if commits { back() }
            })
        } else {
            content
        }
    }
}

extension EnvironmentValues {
    /// False while a dialog is up over the page: it keeps its touches.
    @Entry var allowsEdgeSwipe = true
}

/// True while a dialog is up, which the edge swipe must leave alone.
struct DialogShownKey: PreferenceKey {
    static var defaultValue: Bool { false }
    static func reduce(value: inout Bool, nextValue: () -> Bool) { value = value || nextValue() }
}

/// A swipe in from the right edge of the screen (EdgeSwipeContext.tsx `useRightEdgeSwipe`): a
/// settings page opens its info drawer with it. It travels leftwards and commits like the
/// left-edge swipe: past 30% of the screen, or on a flick.
struct RightEdgeSwipeGesture: UIGestureRecognizerRepresentable {
    var isEnabled = true
    let onCommit: () -> Void

    func makeCoordinator(converter: CoordinateSpaceConverter) -> Coordinator { Coordinator() }

    func makeUIGestureRecognizer(context: Context) -> Recognizer {
        let recognizer = Recognizer()
        recognizer.maximumNumberOfTouches = 1
        recognizer.delegate = context.coordinator
        return recognizer
    }

    func updateUIGestureRecognizer(_ recognizer: Recognizer, context: Context) {
        recognizer.isEnabled = isEnabled
    }

    func handleUIGestureRecognizerAction(_ recognizer: Recognizer, context: Context) {
        guard recognizer.state == .ended else { return }
        let view = recognizer.view
        let travel = max(0, -recognizer.translation(in: view).x)
        let velocity = -recognizer.velocity(in: view).x
        if EdgeSwipeGesture.commits(translation: travel, velocity: velocity, width: view?.bounds.width ?? .infinity) {
            onCommit()
        }
    }

    /// A pan that only starts from the right edge of the window.
    final class Recognizer: UIPanGestureRecognizer {
        override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
            super.touchesBegan(touches, with: event)
            let width = touches.first?.window?.bounds.width ?? view?.window?.bounds.width ?? .infinity
            guard let touch = touches.first, touch.location(in: nil).x >= width - EdgeSwipeGesture.edgeZone else {
                state = .failed
                return
            }
        }
    }

    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
            guard let pan = gestureRecognizer as? UIPanGestureRecognizer else { return true }
            let velocity = pan.velocity(in: pan.view)
            return -velocity.x > abs(velocity.y)
        }

        func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldBeRequiredToFailBy other: UIGestureRecognizer) -> Bool {
            other is UIPanGestureRecognizer && !(other is Recognizer) && !(other is EdgeSwipeGesture.Recognizer)
        }
    }
}

extension View {
    /// Runs `action` on a swipe in from the right edge; nil leaves that edge alone.
    func rightEdgeSwipe(_ action: (() -> Void)?) -> some View {
        modifier(RightEdgeSwipe(action: action))
    }
}

private struct RightEdgeSwipe: ViewModifier {
    @Environment(\.allowsEdgeSwipe) private var allowsEdgeSwipe
    let action: (() -> Void)?

    func body(content: Content) -> some View {
        if let action {
            content.gesture(RightEdgeSwipeGesture(isEnabled: allowsEdgeSwipe, onCommit: action))
        } else {
            content
        }
    }
}
