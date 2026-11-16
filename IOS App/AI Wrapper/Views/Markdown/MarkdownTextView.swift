import SwiftUI
import UIKit

/// Draws what CSS paints but NSAttributedString can't: inline-code chips (rounded
/// background with padding), blockquote bars, `hr` lines and hanging list markers.
final class MarkdownLayoutManager: NSLayoutManager, NSLayoutManagerDelegate {
    override init() {
        super.init()
        delegate = self
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        delegate = self
    }

    func layoutManager(_ layoutManager: NSLayoutManager, shouldBreakLineByWordBeforeCharacterAt charIndex: Int) -> Bool {
        guard charIndex > 0, let storage = textStorage else { return true }
        return !WebLineBreak.keepsWithNext((storage.string as NSString).character(at: charIndex - 1))
    }

    /// An inline `code` is its own inline box with its own line height, and a line grows to
    /// hold the tallest box on it.
    func layoutManager(
        _ layoutManager: NSLayoutManager,
        shouldSetLineFragmentRect lineFragmentRect: UnsafeMutablePointer<CGRect>,
        lineFragmentUsedRect: UnsafeMutablePointer<CGRect>,
        baselineOffset: UnsafeMutablePointer<CGFloat>,
        in textContainer: NSTextContainer,
        forGlyphRange glyphRange: NSRange
    ) -> Bool {
        guard let storage = textStorage else { return false }
        var above: CGFloat = 0
        var below: CGFloat = 0
        storage.enumerateAttribute(.mdInlineCode, in: characterRange(forGlyphRange: glyphRange, actualGlyphRange: nil)) { value, _, _ in
            guard let box = value as? InlineCodeBox else { return }
            above = max(above, box.growsLineAbove)
            below = max(below, box.growsLineBelow)
        }
        guard above > 0 || below > 0 else { return false }
        lineFragmentRect.pointee.size.height += above + below
        lineFragmentUsedRect.pointee.size.height += above + below
        baselineOffset.pointee += above
        return true
    }

    override func drawBackground(forGlyphRange glyphsToShow: NSRange, at origin: CGPoint) {
        super.drawBackground(forGlyphRange: glyphsToShow, at: origin)
        guard let storage = textStorage, let context = UIGraphicsGetCurrentContext(), let container = textContainers.first else { return }
        let chars = characterRange(forGlyphRange: glyphsToShow, actualGlyphRange: nil)
        context.saveGState()
        defer { context.restoreGState() }

        storage.enumerateAttribute(.mdInlineCode, in: chars) { value, range, _ in
            guard let box = value as? InlineCodeBox else { return }
            let glyphs = self.glyphRange(forCharacterRange: range, actualCharacterRange: nil)
            self.enumerateLineFragments(forGlyphRange: glyphs) { rect, _, _, lineGlyphs, _ in
                let inLine = NSIntersectionRange(glyphs, lineGlyphs)
                guard inLine.length > 0 else { return }
                let bounds = self.boundingRect(forGlyphRange: inLine, in: container)
                let ascent = box.font.ascender.rounded()
                let chip = CGRect(
                    x: bounds.minX + origin.x,
                    y: rect.minY + box.growsLineAbove + box.baselineFromTop - ascent - InlineCodeBox.paddingY + origin.y,
                    width: bounds.width,
                    height: ascent + (-box.font.descender).rounded() + InlineCodeBox.paddingY * 2
                )
                AppTheme.UI.codeSurface.setFill()
                UIBezierPath(roundedRect: chip, cornerRadius: 4).fill()
            }
        }

        storage.enumerateAttribute(.mdQuoteBars, in: chars) { value, range, _ in
            guard let depth = value as? Int else { return }
            let glyphs = self.glyphRange(forCharacterRange: range, actualCharacterRange: nil)
            self.enumerateLineFragments(forGlyphRange: glyphs) { rect, _, _, _, _ in
                AppTheme.UI.border.setFill()
                for level in 0..<depth {
                    let x = MarkdownParser.hangingInset + CGFloat(level) * 16 + origin.x
                    context.fill(CGRect(x: x, y: rect.minY + origin.y, width: 4, height: rect.height))
                }
            }
        }

        storage.enumerateAttribute(.mdRule, in: chars) { value, range, _ in
            guard value != nil else { return }
            let glyphs = self.glyphRange(forCharacterRange: range, actualCharacterRange: nil)
            self.enumerateLineFragments(forGlyphRange: glyphs) { rect, _, _, _, _ in
                AppTheme.UI.rule.setFill()
                let inset = MarkdownParser.hangingInset
                context.fill(CGRect(x: inset + origin.x, y: rect.minY + origin.y, width: rect.width - inset * 2, height: 2))
            }
        }

        storage.enumerateAttribute(.mdMarker, in: chars) { value, range, _ in
            guard let marker = value as? MarkdownMarker else { return }
            let glyph = self.glyphIndexForCharacter(at: range.location)
            let rect = self.lineFragmentRect(forGlyphAt: glyph, effectiveRange: nil)
            let headIndent = (storage.attribute(.paragraphStyle, at: range.location, effectiveRange: nil) as? NSParagraphStyle)?.headIndent ?? MarkdownParser.hangingInset
            let baseline = rect.minY + origin.y + marker.baselineFromTop
            let right = headIndent + origin.x
            switch marker.kind {
            case .disc, .circle, .square:
                // Chrome's list marker, all integer math on the rounded ascent.
                let ascent = Int(marker.font.ascender.rounded())
                let offset = ascent * 2 / 3
                let size = CGFloat((offset + 1) / 2)
                let top = baseline - CGFloat(ascent) + CGFloat(3 * (ascent - offset) / 2)
                let dot = CGRect(x: right - CGFloat(offset) - 7, y: top, width: size, height: size)
                marker.color.setFill()
                marker.color.setStroke()
                switch marker.kind {
                case .disc: context.fillEllipse(in: dot)
                case .circle:
                    context.setLineWidth(1)
                    context.strokeEllipse(in: dot.insetBy(dx: 0.5, dy: 0.5))
                default: context.fill(dot)
                }
            case .ordinal(let text):
                let attributes: [NSAttributedString.Key: Any] = [.font: marker.font, .foregroundColor: marker.color]
                let string = text + " "
                let width = (string as NSString).size(withAttributes: attributes).width
                (string as NSString).draw(at: CGPoint(x: right - width, y: baseline - marker.font.ascender), withAttributes: attributes)
            }
        }
    }
}

/// With scrolling off, `UITextView` limits its container to its own frame. SwiftUI rounds that
/// frame to pixels, and TextKit drops a last line that is a fraction too tall for the container.
private final class UnlimitedHeightTextContainer: NSTextContainer {
    override var size: CGSize {
        get { super.size }
        set { super.size = CGSize(width: newValue.width, height: CGFloat.greatestFiniteMagnitude) }
    }
}

/// Selection-aware read-only text. Long-press selects any part of the prose (the
/// web's text selection), links open externally, and a selection can be sent to the
/// "Ask" pill through `onSelectionChange`.
final class MarkdownUITextView: UITextView {
    var onSelectionChange: ((String?) -> Void)?

    override func copy(_ sender: Any?) {
        guard let range = selectedTextRange, let text = text(in: range) else { return }
        UIPasteboard.general.string = Self.withoutLayoutCharacters(text)
    }

    /// Attachments, the zero-width spaces that add Chrome's line breaks, and code's padding.
    static func withoutLayoutCharacters(_ text: String) -> String {
        text.replacingOccurrences(of: "\u{FFFC}", with: "")
            .replacingOccurrences(of: "\u{200B}", with: "")
            .replacingOccurrences(of: "\u{2060}", with: "")
    }
}

/// Multi-line plain text that can be selected and copied, at a CSS font and line height.
struct WebSelectableText: View {
    let text: String
    let font: UIFont
    let lineHeight: CGFloat
    let color: UIColor

    private var attributed: NSAttributedString {
        let box = WebLineBox(font: font, lineHeight: DSFont.scaledSize(lineHeight))
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineBreakMode = .byWordWrapping
        paragraph.minimumLineHeight = box.height
        paragraph.maximumLineHeight = box.height
        return NSAttributedString(string: text.webHyphenBreakable, attributes: [
            .font: font,
            .foregroundColor: color,
            .paragraphStyle: paragraph,
            .baselineOffset: box.height + font.descender - box.baseline
        ])
    }

    var body: some View {
        MarkdownTextView(attributedText: attributed)
    }
}

struct MarkdownTextView: UIViewRepresentable {
    let attributedText: NSAttributedString
    var onSelectionChange: ((String?) -> Void)?

    static func height(of text: NSAttributedString, width: CGFloat) -> CGFloat {
        guard text.length > 0 else { return 0 }
        let storage = NSTextStorage(attributedString: text)
        let layout = MarkdownLayoutManager()
        storage.addLayoutManager(layout)
        let container = NSTextContainer(size: CGSize(width: width, height: CGFloat.greatestFiniteMagnitude))
        container.lineFragmentPadding = 0
        layout.addTextContainer(container)
        layout.ensureLayout(for: container)
        return layout.usedRect(for: container).height
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> MarkdownUITextView {
        let storage = NSTextStorage()
        let layout = MarkdownLayoutManager()
        storage.addLayoutManager(layout)
        let container = UnlimitedHeightTextContainer(size: CGSize(width: 0, height: CGFloat.greatestFiniteMagnitude))
        container.widthTracksTextView = true
        container.lineFragmentPadding = 0
        layout.addTextContainer(container)

        let view = MarkdownUITextView(frame: .zero, textContainer: container)
        view.isEditable = false
        view.isSelectable = true
        view.isScrollEnabled = false
        view.backgroundColor = .clear
        view.textContainerInset = .zero
        view.clipsToBounds = false
        view.delegate = context.coordinator
        view.linkTextAttributes = [
            .foregroundColor: AppTheme.UI.textPrimary,
            .underlineStyle: NSUnderlineStyle.single.rawValue,
            .underlineColor: AppTheme.UI.textPrimary
        ]
        view.textDragInteraction?.isEnabled = false
        view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        view.tintColor = AppTheme.UI.primary
        return view
    }

    func updateUIView(_ view: MarkdownUITextView, context: Context) {
        context.coordinator.onSelectionChange = onSelectionChange
        if context.coordinator.current !== attributedText {
            context.coordinator.current = attributedText
            view.attributedText = attributedText
        }
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView: MarkdownUITextView, context: Context) -> CGSize? {
        guard let width = proposal.width, width > 0, width.isFinite else { return nil }
        return CGSize(width: width, height: context.coordinator.height(of: attributedText, width: width))
    }

    final class Coordinator: NSObject, UITextViewDelegate {
        var current: NSAttributedString?
        var onSelectionChange: ((String?) -> Void)?
        private var measured: (text: NSAttributedString, width: CGFloat, height: CGFloat)?

        /// `UITextView.sizeThatFits` rounds up to whole points, and CSS block heights don't.
        func height(of text: NSAttributedString, width: CGFloat) -> CGFloat {
            if let measured, measured.text === text, measured.width == width { return measured.height }
            let height = MarkdownTextView.height(of: text, width: width)
            measured = (text, width, height)
            return height
        }

        func textViewDidChangeSelection(_ textView: UITextView) {
            guard let onSelectionChange else { return }
            guard let range = textView.selectedTextRange, !range.isEmpty,
                  let text = textView.text(in: range).map(MarkdownUITextView.withoutLayoutCharacters),
                  !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                onSelectionChange(nil)
                return
            }
            onSelectionChange(text)
        }

        func textView(_ textView: UITextView, primaryActionFor textItem: UITextItem, defaultAction: UIAction) -> UIAction? {
            guard case .link(let url) = textItem.content else { return defaultAction }
            return UIAction { _ in UIApplication.shared.open(url) }
        }
    }
}
