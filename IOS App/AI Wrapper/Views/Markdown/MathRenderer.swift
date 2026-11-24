import SwiftUI
import UIKit
import SwiftMath

/// Renders LaTeX (the web uses KaTeX via remark-math) with SwiftMath.
enum MathRenderer {
    private static let cache = NSCache<NSString, UIImage>()

    static func clearCache() { cache.removeAllObjects() }

    static func image(latex: String, fontSize: CGFloat, display: Bool, color: UIColor) -> UIImage? {
        let key = "\(display ? "D" : "I")\(fontSize)\(color.hexKey)|\(latex)" as NSString
        if let hit = cache.object(forKey: key) { return hit }
        var math = MathImage(
            latex: latex,
            fontSize: fontSize,
            textColor: color,
            labelMode: display ? .display : .text,
            textAlignment: .left
        )
        let (error, parsed, _) = math.asImage()
        guard let image = error == nil ? parsed : stackedImage(latex: latex, fontSize: fontSize, display: display, color: color) else { return nil }
        cache.setObject(image, forKey: key)
        return image
    }

    /// LaTeX that only parses once `MathStacking` has rewritten it. MTMathUILabel is
    /// the one SwiftMath entry point that typesets a list built in code, so it lays
    /// the list out and this draws it the way `MathImage` does. When the labels sit
    /// on one side only, the image carries the formula row's baseline so inline math
    /// stays on the text's baseline instead of being centred with its labels.
    private static func stackedImage(latex: String, fontSize: CGFloat, display: Bool, color: UIColor) -> UIImage? {
        guard let prepared = MathStacking.prepare(latex) else { return nil }
        var error: NSError?
        guard let list = MTMathListBuilder.build(fromString: prepared, error: &error), error == nil else { return nil }
        let font = MathFont.latinModernFont.mtfont(size: fontSize)
        let ruler = MTMathUILabel()
        ruler.font = font
        let outcome = MathStacking.restructure(list, style: display ? .display : .text) { measured in
            ruler.mathList = measured
            return ruler.intrinsicContentSize.width
        }
        guard let outcome else { return nil }
        let label = MTMathUILabel()
        label.font = font
        label.labelMode = display ? .display : .text
        label.textAlignment = .left
        label.textColor = color
        label.mathList = list
        let fitted = label.intrinsicContentSize
        let size = CGSize(width: ceil(fitted.width), height: ceil(fitted.height))
        guard size.width > 0, size.height > 0 else { return nil }
        label.frame = CGRect(origin: .zero, size: size)
        label.layoutSubviews()
        guard let displayList = label.displayList else { return nil }
        let image = UIGraphicsImageRenderer(size: size).image { context in
            context.cgContext.concatenate(CGAffineTransform(a: 1, b: 0, c: 0, d: -1, tx: 0, ty: size.height))
            displayList.draw(context.cgContext)
        }
        // The line's baseline sits where MTMathUILabel centres it; its one display is
        // the table, whose first or last row is the formula when labels are one-sided.
        let rows = (displayList.subDisplays.first as? MTMathListDisplay)?.subDisplays ?? []
        let lineBaseline = (size.height - max(displayList.ascent + displayList.descent, fontSize / 2)) / 2 + displayList.descent
        if outcome.rowsAbove == 0, outcome.rowsBelow > 0, let first = rows.first {
            return image.withBaselineOffset(fromBottom: lineBaseline + displayList.ascent - first.ascent)
        }
        if outcome.rowsBelow == 0, outcome.rowsAbove > 0, let last = rows.last {
            return image.withBaselineOffset(fromBottom: lineBaseline - displayList.descent + last.descent)
        }
        return image
    }

    /// Inline `$$x$$`: the rendered formula as a text attachment sitting on the
    /// baseline; falls back to the LaTeX source in monospace if it can't be parsed.
    static func inlineAttachment(latex: String, fontSize: CGFloat) -> NSAttributedString {
        let color = AppTheme.UI.textPrimary.resolvedColor(with: UITraitCollection.current)
        guard let image = image(latex: latex, fontSize: fontSize, display: false, color: color) else {
            return NSAttributedString(string: latex, attributes: [.font: DSFont.uiMono(fontSize * 0.9), .foregroundColor: AppTheme.UI.textPrimary])
        }
        let attachment = NSTextAttachment()
        attachment.image = image
        let descent = image.baselineOffsetFromBottom ?? max(0, (image.size.height - fontSize) / 2)
        attachment.bounds = CGRect(x: 0, y: -descent, width: image.size.width, height: image.size.height)
        return NSAttributedString(attachment: attachment)
    }
}

private extension UIColor {
    var hexKey: String {
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        getRed(&r, green: &g, blue: &b, alpha: &a)
        return "\(Int(r * 255))-\(Int(g * 255))-\(Int(b * 255))"
    }
}

/// Display math: `.katex-display` — scrolls in its own strip when wider than the
/// card, otherwise centered, with 0.25rem vertical padding.
struct MathBlockView: View {
    let latex: String
    /// The reading setting: the formula on its own band (`.katex-display`: the hover surface,
    /// 8pt corners, padded 18 by 16), at the text's 17pt × 1.15.
    var onBand = false
    @Environment(\.colorScheme) private var colorScheme
    /// `text-align: center` within the band, while a wider formula still scrolls.
    @State private var bandWidth: CGFloat = 0

    var body: some View {
        let color = (colorScheme == .dark ? UIColor.white : UIColor(hex: "#2C2C2C"))
        if let image = MathRenderer.image(latex: latex, fontSize: onBand ? 19.55 : 19.2, display: true, color: color) {
            ScrollView(.horizontal, showsIndicators: false) {
                Image(uiImage: image)
                    .padding(.vertical, 4)
                    .frame(minWidth: onBand ? bandWidth : 0)
            }
            .frame(maxWidth: .infinity)
            .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { bandWidth = $0 }
            .padding(.vertical, onBand ? 14 : 0)
            .padding(.horizontal, onBand ? 16 : 0)
            .background(onBand ? AppTheme.backgroundHover : Color.clear)
            .clipShape(RoundedRectangle(cornerRadius: onBand ? 8 : 0))
            .accessibilityLabel(latex)
        } else {
            Text(latex)
                .webText(mono: 14.4, lineHeight: 24.48)
                .foregroundStyle(AppTheme.error)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}
