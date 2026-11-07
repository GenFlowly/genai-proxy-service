import SwiftUI
import UIKit

/// `placeTooltip` in the library's `tooltipPlacement.ts`: beside the anchor if a side has room,
/// otherwise above or below it, and always inside the viewport. `top` is the box's center for
/// right and left, its top edge for top and bottom. `left` is its center for top and bottom.
struct TooltipLayout: Equatable {
    enum Placement { case right, left, top, bottom }

    var placement: Placement
    var top: CGFloat
    var left: CGFloat
    /// Where the arrow sits along the tooltip's width (top and bottom only).
    var arrowLeft: CGFloat?

    private static let gap: CGFloat = 8

    static func place(anchor: CGRect, tooltip: CGSize, viewport: CGSize) -> TooltipLayout {
        let rightLeft = anchor.maxX + gap
        let leftLeft = anchor.minX - gap - tooltip.width
        let fitsRight = rightLeft + tooltip.width <= viewport.width - gap
        let fitsLeft = leftLeft >= gap

        if fitsRight || fitsLeft {
            let halfHeight = tooltip.height / 2
            let top = max(halfHeight + gap, min(anchor.midY, viewport.height - halfHeight - gap))
            return fitsRight
                ? TooltipLayout(placement: .right, top: top, left: rightLeft)
                : TooltipLayout(placement: .left, top: top, left: leftLeft)
        }

        let halfWidth = tooltip.width / 2
        let left = max(halfWidth + gap, min(anchor.midX, viewport.width - halfWidth - gap))
        let arrowLeft = max(gap, min(anchor.midX - (left - halfWidth), tooltip.width - gap))
        let aboveTop = anchor.minY - gap - tooltip.height
        return aboveTop >= gap
            ? TooltipLayout(placement: .top, top: aboveTop, left: left, arrowLeft: arrowLeft)
            : TooltipLayout(placement: .bottom, top: anchor.maxY + gap, left: left, arrowLeft: arrowLeft)
    }
}

/// `Tooltip` from the library. A phone has no hover, so a tap shows it, as in iOS Safari, and the
/// next touch anywhere closes it.
@MainActor
final class WebTooltipPresenter {
    static let shared = WebTooltipPresenter()

    /// A tap that closes a tooltip must not reopen it when the same metric's gesture ends.
    private static let reopenGuard: TimeInterval = 0.6

    private var layer: TooltipDismissLayer?
    private var shownKey: String?
    private var closedKey: String?
    private var closedAt = Date.distantPast

    func toggle(_ text: String, anchor: CGRect) {
        let key = "\(text)@\(Int(anchor.minX)),\(Int(anchor.minY))"
        if closedKey == key, Date().timeIntervalSince(closedAt) < Self.reopenGuard { return }
        guard let window = UIApplication.shared.connectedScenes
            .compactMap({ $0 as? UIWindowScene })
            .flatMap(\.windows)
            .first(where: \.isKeyWindow) else { return }
        layer?.removeFromSuperview()

        let bubble = WebTooltipBubble(text: text, availableWidth: window.bounds.width)
        let viewport = CGSize(width: window.bounds.width, height: min(window.bounds.height, ScreenKeyboard.shared.top))
        bubble.apply(TooltipLayout.place(anchor: anchor, tooltip: bubble.bounds.size, viewport: viewport))

        let dismissLayer = TooltipDismissLayer(frame: window.bounds)
        dismissLayer.onTouch = { [weak self] in self?.close() }
        dismissLayer.addSubview(bubble)
        window.addSubview(dismissLayer)
        layer = dismissLayer
        shownKey = key
    }

    private func close() {
        closedKey = shownKey
        closedAt = Date()
        shownKey = nil
        let closing = layer
        layer = nil
        // This runs during hit-testing, while the window is walking its subviews.
        DispatchQueue.main.async { closing?.removeFromSuperview() }
    }
}

/// Sees every touch in the window and lets it through.
private final class TooltipDismissLayer: UIView {
    var onTouch: (() -> Void)?

    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        if event?.type == .touches {
            onTouch?()
            onTouch = nil
        }
        return nil
    }
}

/// `.tooltip`: 13.6pt Roboto on the navbar color, padded 8 by 12, at most 300 wide and 8 from each
/// edge, with a 6pt arrow. A line that fits keeps its width; one that wraps takes the full 300.
private final class WebTooltipBubble: UIView {
    private static let padding = UIEdgeInsets(top: 8, left: 12, bottom: 8, right: 12)
    private static let maxWidth: CGFloat = 300
    private static let lineHeight: CGFloat = 16
    private static let arrowSize: CGFloat = 6
    private static let fill = UIColor(hex: "#252526")

    private let label = UILabel()
    private let arrow = CAShapeLayer()

    init(text: String, availableWidth: CGFloat) {
        super.init(frame: .zero)
        let style = NSMutableParagraphStyle()
        style.minimumLineHeight = Self.lineHeight
        style.maximumLineHeight = Self.lineHeight
        label.attributedText = NSAttributedString(string: text, attributes: [
            .font: DSFont.ui(13.6, weight: 400, italic: false),
            .foregroundColor: UIColor.white,
            .paragraphStyle: style
        ])
        label.numberOfLines = 0

        let widest = min(Self.maxWidth, availableWidth - 16)
        let inner = widest - Self.padding.left - Self.padding.right
        let natural = label.sizeThatFits(CGSize(width: CGFloat.greatestFiniteMagnitude, height: .greatestFiniteMagnitude))
        let textWidth = natural.width <= inner ? ceil(natural.width) : inner
        let textHeight = ceil(label.sizeThatFits(CGSize(width: textWidth, height: .greatestFiniteMagnitude)).height)
        label.frame = CGRect(x: Self.padding.left, y: Self.padding.top, width: textWidth, height: textHeight)
        addSubview(label)

        bounds = CGRect(
            x: 0, y: 0,
            width: textWidth + Self.padding.left + Self.padding.right,
            height: textHeight + Self.padding.top + Self.padding.bottom
        )
        backgroundColor = Self.fill
        layer.cornerRadius = 6
        arrow.fillColor = Self.fill.cgColor
        layer.addSublayer(arrow)
        isUserInteractionEnabled = false
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        // `--shadow-lg`: 0 10px 15px -3px, heavier in dark mode.
        layer.shadowColor = UIColor.black.cgColor
        layer.shadowOpacity = traitCollection.userInterfaceStyle == .dark ? 0.5 : 0.1
        layer.shadowOffset = CGSize(width: 0, height: 10)
        layer.shadowRadius = 7.5
        layer.shadowPath = UIBezierPath(rect: bounds.insetBy(dx: 3, dy: 3)).cgPath
    }

    func apply(_ layout: TooltipLayout) {
        let size = bounds.size
        let side = layout.placement == .right || layout.placement == .left
        frame = CGRect(
            x: side ? layout.left : layout.left - size.width / 2,
            y: side ? layout.top - size.height / 2 : layout.top,
            width: size.width,
            height: size.height
        )

        let reach = Self.arrowSize
        let path = UIBezierPath()
        switch layout.placement {
        case .right:
            path.move(to: CGPoint(x: 0, y: size.height / 2 - reach))
            path.addLine(to: CGPoint(x: -reach, y: size.height / 2))
            path.addLine(to: CGPoint(x: 0, y: size.height / 2 + reach))
        case .left:
            path.move(to: CGPoint(x: size.width, y: size.height / 2 - reach))
            path.addLine(to: CGPoint(x: size.width + reach, y: size.height / 2))
            path.addLine(to: CGPoint(x: size.width, y: size.height / 2 + reach))
        case .top:
            let x = layout.arrowLeft ?? size.width / 2
            path.move(to: CGPoint(x: x - reach, y: size.height))
            path.addLine(to: CGPoint(x: x, y: size.height + reach))
            path.addLine(to: CGPoint(x: x + reach, y: size.height))
        case .bottom:
            let x = layout.arrowLeft ?? size.width / 2
            path.move(to: CGPoint(x: x - reach, y: 0))
            path.addLine(to: CGPoint(x: x, y: -reach))
            path.addLine(to: CGPoint(x: x + reach, y: 0))
        }
        path.close()
        arrow.path = path.cgPath
    }
}

extension View {
    /// Shows `text` in a tooltip when this view is tapped. The touch area reaches a little past
    /// the view, because the usage metrics are only about 19pt tall.
    func webTooltip(_ text: String) -> some View {
        overlay {
            GeometryReader { proxy in
                Color.clear
                    .contentShape(Rectangle().inset(by: -6))
                    .onTapGesture {
                        WebTooltipPresenter.shared.toggle(text, anchor: proxy.frame(in: .global))
                    }
            }
        }
    }
}
