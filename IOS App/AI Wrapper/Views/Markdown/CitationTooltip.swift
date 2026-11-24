import SwiftUI
import UIKit

extension ActivitySource {
    init(_ source: WebSource) {
        index = source.index
        title = source.title
        url = source.url
        favicon = source.favicon
        publishedDate = source.publishedDate
    }
}

/// The web's CitationTooltip, the library Tooltip's card variant opened from a citation chip:
/// each source as the thinking panel lists it (site icon, title, then domain · date · how often
/// the answer cites it), above the chip when there is room. Its title opens the page. Any other
/// touch closes it, a scroll included; a second tap on the same chip closes it and opens the
/// page, as a second click does on the web.
@MainActor
final class CitationTooltipPresenter {
    static let shared = CitationTooltipPresenter()

    /// The touch that closes a card must not reopen it when the same chip's tap ends.
    private static let reopenGuard: TimeInterval = 0.6

    private var layer: CitationCardLayer?
    private weak var openTextView: MarkdownUITextView?
    private var openRange: NSRange?
    private var openKey: String?
    private var closedKey: String?
    private var closedURL: URL?
    private var closedAt = Date.distantPast

    func toggle(url: URL, range: NSRange, in textView: MarkdownUITextView, lookup: CitationLookup) {
        let key = "\(ObjectIdentifier(textView).hashValue)@\(range.location)"
        if closedKey == key, Date().timeIntervalSince(closedAt) < Self.reopenGuard {
            if let page = closedURL { UIApplication.shared.open(page) }
            closedKey = nil
            return
        }
        guard let indexes = CitationText.indexes(of: url) else { return }
        let sources = indexes.compactMap { lookup.sources[$0] }
        guard let first = sources.first, let window = textView.window else { return }
        close()

        let width = min(320, window.bounds.width - 32)
        let card = CitationCard(sources: sources, counts: lookup.counts) { [weak self] in self?.close() }
        let bubble = CitationCardBubble(content: AnyView(card), width: width)
        let viewport = CGSize(width: window.bounds.width, height: min(window.bounds.height, ScreenKeyboard.shared.top))
        bubble.apply(TooltipLayout.place(anchor: chipRect(range, in: textView, window: window), tooltip: bubble.bounds.size, viewport: viewport, prefer: .vertical))

        let cardLayer = CitationCardLayer(frame: window.bounds, bubble: bubble)
        cardLayer.onOutsideTouch = { [weak self] in self?.close() }
        window.addSubview(cardLayer)
        layer = cardLayer
        openKey = key
        closedURL = URL(string: first.url)
        setOpen(true, range: range, in: textView)
    }

    func close() {
        guard let closing = layer else { return }
        closedKey = openKey
        closedAt = Date()
        openKey = nil
        layer = nil
        if let textView = openTextView, let range = openRange { setOpen(false, range: range, in: textView) }
        // This can run during hit-testing, while the window is walking its subviews.
        DispatchQueue.main.async { closing.removeFromSuperview() }
    }

    /// The chip's own box in the window, not its line's.
    private func chipRect(_ range: NSRange, in textView: MarkdownUITextView, window: UIWindow) -> CGRect {
        let layout = textView.layoutManager
        let glyphs = layout.glyphRange(forCharacterRange: range, actualCharacterRange: nil)
        var rect = layout.boundingRect(forGlyphRange: glyphs, in: textView.textContainer)
        if let box = textView.textStorage.attribute(.mdCitation, at: range.location, effectiveRange: nil) as? CitationChipBox {
            let line = layout.lineFragmentRect(forGlyphAt: glyphs.location, effectiveRange: nil)
            rect.origin.y = line.minY + box.baselineFromTop - box.raise - box.topAboveBaseline
            rect.size.height = CitationChipBox.height
            rect.size.width = box.width
        }
        rect = rect.offsetBy(dx: textView.textContainerInset.left, dy: textView.textContainerInset.top)
        return textView.convert(rect, to: window)
    }

    private func setOpen(_ open: Bool, range: NSRange, in textView: MarkdownUITextView) {
        guard range.upperBound <= textView.textStorage.length else { return }
        (textView.layoutManager as? MarkdownLayoutManager)?.openCitation = open ? range : nil
        textView.textStorage.addAttribute(.foregroundColor, value: open ? CitationChipBox.openDigits : CitationChipBox.digits, range: range)
        textView.layoutManager.invalidateDisplay(forCharacterRange: range)
        openTextView = open ? textView : nil
        openRange = open ? range : nil
    }
}

/// The sources a chip stands for, as the thinking panel's evidence list draws them.
private struct CitationCard: View {
    let sources: [WebSource]
    let counts: [Int: Int]
    let onOpen: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(sources.enumerated()), id: \.element.index) { offset, source in
                if offset > 0 {
                    Rectangle().fill(AppTheme.borderLight).frame(height: 1)
                }
                SourceRow(
                    source: ActivitySourceView(
                        source: ActivitySource(source),
                        domain: activityDomain(source.url),
                        cited: nil,
                        stepId: "",
                        callSeq: 0
                    ),
                    variant: .ledger,
                    meta: counts[source.index].map { L("common.citation.citedTimes", ["count": $0]) },
                    plain: true
                )
                .padding(.top, offset == 0 ? 0 : 8)
                .padding(.bottom, offset == sources.count - 1 ? 0 : 8)
            }
        }
        .environment(\.openURL, OpenURLAction { _ in
            onOpen()
            return .systemAction
        })
    }
}

/// Sees every touch in the window: one on the card goes to the card, any other closes it and
/// goes through to what is under it.
private final class CitationCardLayer: UIView {
    var onOutsideTouch: (() -> Void)?
    private let bubble: CitationCardBubble

    init(frame: CGRect, bubble: CitationCardBubble) {
        self.bubble = bubble
        super.init(frame: frame)
        backgroundColor = .clear
        addSubview(bubble)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        if bubble.frame.contains(point) {
            return bubble.hitTest(convert(point, to: bubble), with: event)
        }
        if event?.type == .touches {
            onOutsideTouch?()
            onOutsideTouch = nil
        }
        return nil
    }
}

/// The library Tooltip's `card` variant: the secondary surface, a 1pt border, 8pt corners,
/// padded 10 by 12, with a 7pt arrow outlined like the box.
private final class CitationCardBubble: UIView {
    private static let padding = UIEdgeInsets(top: 10, left: 12, bottom: 10, right: 12)
    private static let arrowSize: CGFloat = 7

    private let host: UIHostingController<AnyView>
    /// The box's border as its own layer: a layer's `border` draws above its sublayers, and the
    /// arrow's surface has to cover the border where the two meet.
    private let outline = CAShapeLayer()
    private let arrowBorder = CAShapeLayer()
    private let arrowFill = CAShapeLayer()

    init(content: AnyView, width: CGFloat) {
        host = UIHostingController(rootView: content)
        super.init(frame: .zero)
        host.view.backgroundColor = .clear
        let inner = width - Self.padding.left - Self.padding.right - 2
        let fitted = host.sizeThatFits(in: CGSize(width: inner, height: .greatestFiniteMagnitude))
        let height = ceil(fitted.height)
        host.view.frame = CGRect(x: Self.padding.left + 1, y: Self.padding.top + 1, width: inner, height: height)
        addSubview(host.view)
        bounds = CGRect(x: 0, y: 0, width: width, height: height + Self.padding.top + Self.padding.bottom + 2)

        backgroundColor = AppTheme.UI.backgroundSecondary
        layer.cornerRadius = 8
        outline.path = UIBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5), cornerRadius: 7.5).cgPath
        outline.fillColor = UIColor.clear.cgColor
        outline.lineWidth = 1
        layer.addSublayer(outline)
        layer.addSublayer(arrowBorder)
        layer.addSublayer(arrowFill)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        outline.strokeColor = AppTheme.UI.border.resolvedColor(with: traitCollection).cgColor
        arrowBorder.fillColor = AppTheme.UI.border.resolvedColor(with: traitCollection).cgColor
        arrowFill.fillColor = AppTheme.UI.backgroundSecondary.resolvedColor(with: traitCollection).cgColor
        // `--shadow-lg`: 0 10px 15px -3px, heavier in dark mode.
        layer.shadowColor = UIColor.black.cgColor
        layer.shadowOpacity = traitCollection.userInterfaceStyle == .dark ? 0.5 : 0.1
        layer.shadowOffset = CGSize(width: 0, height: 10)
        layer.shadowRadius = 7.5
        layer.shadowPath = UIBezierPath(roundedRect: bounds.insetBy(dx: 3, dy: 3), cornerRadius: 8).cgPath
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
        // ::before (the border's triangle) one point larger than ::after (the surface's)
        arrowBorder.path = arrow(layout, reach: Self.arrowSize).cgPath
        arrowFill.path = arrow(layout, reach: Self.arrowSize - 1).cgPath
    }

    /// A triangle on the edge facing the anchor, its base along the inner edge of the border.
    private func arrow(_ layout: TooltipLayout, reach: CGFloat) -> UIBezierPath {
        let size = bounds.size
        let path = UIBezierPath()
        switch layout.placement {
        case .top:
            let x = layout.arrowLeft ?? size.width / 2
            path.move(to: CGPoint(x: x - reach, y: size.height - 1))
            path.addLine(to: CGPoint(x: x, y: size.height - 1 + reach))
            path.addLine(to: CGPoint(x: x + reach, y: size.height - 1))
        case .bottom:
            let x = layout.arrowLeft ?? size.width / 2
            path.move(to: CGPoint(x: x - reach, y: 1))
            path.addLine(to: CGPoint(x: x, y: 1 - reach))
            path.addLine(to: CGPoint(x: x + reach, y: 1))
        case .right:
            path.move(to: CGPoint(x: 1, y: size.height / 2 - reach))
            path.addLine(to: CGPoint(x: 1 - reach, y: size.height / 2))
            path.addLine(to: CGPoint(x: 1, y: size.height / 2 + reach))
        case .left:
            path.move(to: CGPoint(x: size.width - 1, y: size.height / 2 - reach))
            path.addLine(to: CGPoint(x: size.width - 1 + reach, y: size.height / 2))
            path.addLine(to: CGPoint(x: size.width - 1, y: size.height / 2 + reach))
        }
        path.close()
        return path
    }
}
