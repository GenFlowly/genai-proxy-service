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
        let (error, image, _) = math.asImage()
        guard error == nil, let image else { return nil }
        cache.setObject(image, forKey: key)
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
        let descent = max(0, (image.size.height - fontSize) / 2)
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
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        let color = (colorScheme == .dark ? UIColor.white : UIColor(hex: "#2C2C2C"))
        if let image = MathRenderer.image(latex: latex, fontSize: 19.2, display: true, color: color) {
            ScrollView(.horizontal, showsIndicators: false) {
                Image(uiImage: image)
                    .padding(.vertical, 4)
                    .frame(minWidth: 0)
            }
            .frame(maxWidth: .infinity)
            .accessibilityLabel(latex)
        } else {
            Text(latex)
                .webText(mono: 14.4, lineHeight: 24.48)
                .foregroundStyle(AppTheme.error)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}
