import SwiftUI
import CoreText

/// Design tokens — the native counterpart of the component-library's Storybook
/// "Design Tokens". Colors live in `AppTheme`; spacing / radius / typography here.
enum DSSpacing {
    static let xs: CGFloat = 4
    static let sm: CGFloat = 8
    static let md: CGFloat = 12
    static let lg: CGFloat = 16
    static let xl: CGFloat = 24
    static let xxl: CGFloat = 32
}

enum DSRadius {
    static let sm: CGFloat = 4
    static let md: CGFloat = 6
    static let lg: CGFloat = 10
    static let xl: CGFloat = 14
}

/// Typography. The web bundles the Roboto variable font (`body { font-family:
/// 'Roboto' }`); the same two TTFs ship here so sizes, weights and line wraps match.
/// Weights are CSS weights (400, 450, 500, 600, 700) applied on the font's `wght` axis.
/// Text is measured off the main thread too, so the font cache is behind a lock.
nonisolated enum DSFont {
    private nonisolated struct Key: Hashable {
        let family: String
        let size: CGFloat
        let weight: CGFloat
        let italic: Bool
    }

    private nonisolated(unsafe) static var cache: [Key: UIFont] = [:]
    private static let lock = NSLock()

    private static func cached(_ key: Key, make: () -> UIFont) -> UIFont {
        lock.withLock {
            if let font = cache[key] { return font }
            let font = make()
            cache[key] = font
            return font
        }
    }

    static func ui(_ size: CGFloat, weight: CGFloat = 400, italic: Bool = false) -> UIFont {
        let scaled = scaledSize(size)
        return cached(Key(family: "roboto", size: scaled, weight: weight, italic: italic)) {
            let name = italic ? "Roboto-Italic" : "Roboto-Regular"
            let base = UIFontDescriptor(name: name, size: scaled) as CTFontDescriptor
            let wght = 0x77676874 as CFNumber
            let varied = CTFontDescriptorCreateCopyWithVariation(base, wght, weight) as UIFontDescriptor
            return UIFont(descriptor: varied, size: scaled)
        }
    }

    /// `font-family: monospace` — Menlo, the face Chrome and Safari resolve it to here.
    static func uiMono(_ size: CGFloat, weight: UIFont.Weight = .regular) -> UIFont {
        let scaled = scaledSize(size)
        return cached(Key(family: "mono", size: scaled, weight: weight.rawValue, italic: false)) {
            let name = weight == .bold ? "Menlo-Bold" : "Menlo-Regular"
            return UIFont(name: name, size: scaled) ?? .monospacedSystemFont(ofSize: scaled, weight: weight)
        }
    }

    /// `'SF Mono'` in a font stack. iOS only offers it as the system's monospaced face, spaced wider
    /// than the font's own 0.6em, which `sfMonoKerning` takes back out.
    static func uiSFMono(_ size: CGFloat) -> UIFont {
        .monospacedSystemFont(ofSize: scaledSize(size), weight: .regular)
    }

    static func sfMonoKerning(_ size: CGFloat) -> CGFloat {
        let font = uiSFMono(size)
        return font.pointSize * 0.6 - ("0" as NSString).size(withAttributes: [.font: font]).width
    }

    /// Browser default for `<button>` with no font-family set (the web's Rectangle
    /// buttons, vendor toggle and thinking toggle compute to Arial).
    static func uiArial(_ size: CGFloat, bold: Bool = false) -> UIFont {
        let scaled = scaledSize(size)
        return cached(Key(family: "arial", size: scaled, weight: bold ? 700 : 400, italic: false)) {
            UIFont(name: bold ? "Arial-BoldMT" : "ArialMT", size: scaled) ?? .systemFont(ofSize: scaled)
        }
    }

    /// Dynamic Type scale applied by hand: `UIFontMetrics` rounds what it returns (to whole
    /// points for fonts, whole pixels for values), and CSS sizes like 14.4 must survive.
    static func scaledSize(_ size: CGFloat) -> CGFloat {
        size * UIFontMetrics.default.scaledValue(for: 1_000) / 1_000
    }

    static func roboto(_ size: CGFloat, _ weight: CGFloat = 400, italic: Bool = false) -> Font {
        Font(ui(size, weight: weight, italic: italic) as CTFont)
    }

    static func mono(_ size: CGFloat) -> Font { Font(uiMono(size) as CTFont) }

    static func arial(_ size: CGFloat, bold: Bool = false) -> Font { Font(uiArial(size, bold: bold) as CTFont) }
}

extension View {
    /// Applies a Roboto text style with a CSS line box: `line-height` is honored
    /// exactly, the extra leading split evenly above and below like a browser does.
    /// `lineHeight == nil` is CSS `normal`.
    func webText(_ size: CGFloat, _ weight: CGFloat = 400, lineHeight: CGFloat? = nil, italic: Bool = false) -> some View {
        modifier(WebFontModifier(uiFont: DSFont.ui(size, weight: weight, italic: italic), lineHeight: lineHeight))
    }

    func webText(mono size: CGFloat, lineHeight: CGFloat? = nil) -> some View {
        modifier(WebFontModifier(uiFont: DSFont.uiMono(size), lineHeight: lineHeight))
    }

    func webText(sfMono size: CGFloat, lineHeight: CGFloat? = nil) -> some View {
        modifier(WebFontModifier(uiFont: DSFont.uiSFMono(size), lineHeight: lineHeight))
            .kerning(DSFont.sfMonoKerning(size))
    }

    func webText(arial size: CGFloat, bold: Bool = false, lineHeight: CGFloat? = nil) -> some View {
        modifier(WebFontModifier(uiFont: DSFont.uiArial(size, bold: bold), lineHeight: lineHeight))
    }
}

/// CSS corners are circular arcs, and SwiftUI's default is the continuous curve. These stand in for
/// the shapes' initializers so that every box in the app gets the web's corners.
func RoundedRectangle(cornerRadius: CGFloat) -> SwiftUI.RoundedRectangle {
    SwiftUI.RoundedRectangle(cornerRadius: cornerRadius, style: .circular)
}

func Capsule() -> SwiftUI.Capsule {
    SwiftUI.Capsule(style: .circular)
}

/// Chrome lays out in fixed point at 1/64 of a pixel. The differences are tiny per line but
/// add up over a long response.
enum LayoutUnit {
    /// What a CSS length becomes.
    static func truncating(_ value: CGFloat) -> CGFloat { (value * 64 + 0.000_001).rounded(.down) / 64 }
    static func rounding(_ value: CGFloat) -> CGFloat { (value * 64).rounded() / 64 }
    /// What an intrinsic text width becomes.
    static func ceiling(_ value: CGFloat) -> CGFloat { (value * 64 - 0.000_001).rounded(.up) / 64 }
}

/// Chrome's inline box: ascent, descent and gap are each rounded to whole points, and the
/// half-leading above the text is floored.
struct WebLineBox {
    let height: CGFloat
    /// The first baseline, down from the top of the line.
    let baseline: CGFloat
    /// Distance to move the glyphs from where an exact line height leaves them (SwiftUI puts
    /// the first baseline one point size below the line's top) to the baseline Chrome paints.
    let glyphOffset: CGFloat

    init(font: UIFont, lineHeight: CGFloat?) {
        let ascent = font.ascender.rounded()
        let descent = (-font.descender).rounded()
        height = lineHeight.map { Self.usedLineHeight($0, fontSize: font.pointSize) } ?? ascent + descent + font.leading.rounded()
        baseline = ((height - ascent - descent) / 2).rounded(.down) + ascent
        glyphOffset = baseline - font.pointSize
    }

    /// `ComputedLineHeightAsFixed`: a unitless line height multiplies the font size rounded to
    /// a layout unit, and the product truncates to one. A whole value is a `px` length.
    static func usedLineHeight(_ lineHeight: CGFloat, fontSize: CGFloat) -> CGFloat {
        guard lineHeight != lineHeight.rounded(), fontSize > 0 else { return lineHeight }
        return LayoutUnit.truncating(LayoutUnit.rounding(fontSize) * lineHeight / fontSize)
    }
}

/// `webText` for a font already resolved to a `UIFont`.
struct WebFontModifier: ViewModifier {
    let uiFont: UIFont
    var lineHeight: CGFloat?

    func body(content: Content) -> some View {
        let box = WebLineBox(font: uiFont, lineHeight: lineHeight.map(DSFont.scaledSize))
        WebLineBoxLayout(lineHeight: box.height) {
            content
                .font(Font(uiFont as CTFont))
                .environment(\.webUIFont, uiFont)
                .lineHeight(.exact(points: box.height))
                .textRenderer(WebTextRenderer(glyphOffset: box.glyphOffset, overflow: uiFont.pointSize))
        }
    }
}

/// A CSS text block is as tall as its lines, whatever its container offers. `Text` instead drops
/// lines to fit a height proposal, and stacks propose less than a child's natural height whenever
/// they share space out, so here it's only ever asked for its natural height.
///
/// `Text` also rounds that height up to whole pixels and CSS doesn't, which adds up over a long
/// list, so this reports the exact multiple of the line height the rounding came from.
private struct WebLineBoxLayout: Layout {
    let lineHeight: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        guard let child = subviews.first else { return .zero }
        let size = child.sizeThatFits(ProposedViewSize(width: proposal.width, height: nil))
        let exact = (size.height / lineHeight).rounded() * lineHeight
        return CGSize(width: size.width, height: abs(size.height - exact) < 0.5 ? exact : size.height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        subviews.first?.place(at: bounds.origin, proposal: ProposedViewSize(width: bounds.width, height: nil))
    }

    func explicitAlignment(of guide: VerticalAlignment, in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGFloat? {
        subviews.first?.dimensions(in: proposal)[explicit: guide].map { $0 + bounds.minY }
    }
}

/// Clears an enclosing `webText`'s renderer for text that sets its own line.
struct PlainTextRenderer: TextRenderer {
    func draw(layout: Text.Layout, in context: inout GraphicsContext) {
        for line in layout { context.draw(line) }
    }
}

/// Paints at Chrome's baseline. Without a renderer that declares `displayPadding`, an exact
/// line height clips whatever passes the text's frame, which is most descenders.
private struct WebTextRenderer: TextRenderer {
    let glyphOffset: CGFloat
    let overflow: CGFloat

    var displayPadding: EdgeInsets {
        EdgeInsets(top: overflow, leading: 0, bottom: overflow, trailing: 0)
    }

    func draw(layout: Text.Layout, in context: inout GraphicsContext) {
        context.translateBy(x: 0, y: glyphOffset)
        for line in layout { context.draw(line) }
    }
}

/// Chrome's line breaking, read off `min-content` for every punctuation mark and context.
enum WebLineBreak {
    /// CoreText also breaks after these; Chrome keeps them with what follows.
    static func keepsWithNext(_ unit: unichar) -> Bool {
        switch unit {
        case 0x21, 0x2F, 0x7C, 0x7D, 0x201D: return true
        default: return false
        }
    }

    private static func breaksAfter(_ scalar: Unicode.Scalar) -> Bool {
        switch scalar.value {
        case 0x2D, 0x3F, 0xAD, 0x2010, 0x2012, 0x2013, 0x2026, 0x3001, 0x3002, 0xFF0C: return true
        default: return false
        }
    }

    /// Stands alone on a line: the em dash, and scripts that break between any two characters.
    private static func breaksAround(_ scalar: Unicode.Scalar) -> Bool {
        switch scalar.value {
        case 0x2014, 0x1100...0x11FF, 0x3040...0x30FF, 0x3400...0x4DBF, 0x4E00...0x9FFF,
             0xAC00...0xD7AF, 0xF900...0xFAFF, 0x20000...0x2FFFF:
            return true
        default:
            return scalar.properties.isEmojiPresentation
        }
    }

    /// The runs a line never breaks inside. `min-content` is the widest of them.
    static func unbreakableRanges(in text: NSString) -> [NSRange] {
        var pieces: [NSRange] = []
        var start: Int?
        func close(at end: Int) {
            if let start, end > start { pieces.append(NSRange(location: start, length: end - start)) }
            start = nil
        }
        text.enumerateSubstrings(in: NSRange(location: 0, length: text.length), options: .byComposedCharacterSequences) { substring, range, _, _ in
            guard let character = substring?.first, let scalar = character.unicodeScalars.first else { return }
            if scalar.value == 0x200B || (character.isWhitespace && scalar.value != 0xA0) {
                close(at: range.location)
            } else if breaksAround(scalar) {
                close(at: range.location)
                pieces.append(range)
            } else {
                if start == nil { start = range.location }
                if breaksAfter(scalar) { close(at: range.upperBound) }
            }
        }
        close(at: text.length)
        return pieces
    }
}

extension String {
    /// `text-overflow: ellipsis`: the whole characters that fit beside the primary font's ellipsis.
    /// CoreText takes its ellipsis from the font of whatever it cut, which for CJK is a centered one.
    func webTruncated(toFit width: CGFloat, font: UIFont) -> (text: String, isTruncated: Bool) {
        let attributes: [NSAttributedString.Key: Any] = [.font: font]
        guard (self as NSString).size(withAttributes: attributes).width > width else { return (self, false) }
        let room = width - "\u{2026}".size(withAttributes: attributes).width
        let characters = Array(self)
        var fits = 0
        var tooMany = characters.count
        while tooMany - fits > 1 {
            let middle = (fits + tooMany) / 2
            if String(characters[..<middle]).size(withAttributes: attributes).width <= room {
                fits = middle
            } else {
                tooMany = middle
            }
        }
        return (String(characters[..<fits]), true)
    }

    /// Chrome breaks after any hyphen; CoreText keeps a hyphen with a following digit. The
    /// zero-width space adds that opportunity, so strip it from anything copied.
    var webHyphenBreakable: String {
        guard contains("-") else { return self }
        var result = ""
        var previous: Character?
        for character in self {
            if previous == "-", character.isNumber { result.append("\u{200B}") }
            result.append(character)
            previous = character
        }
        return result
    }

    /// `webHyphenBreakable` for `Text`, which has no way to refuse the breaks CoreText takes and
    /// Chrome doesn't, so a word joiner refuses them. `Text` also moves words down when the last line
    /// has under 11 characters, and Chrome doesn't; invisible characters keep it over that.
    var webBreakable: String {
        guard !isEmpty else { return self }
        var result = ""
        for character in webHyphenBreakable {
            result.append(character)
            if character.utf16.count == 1, let unit = character.utf16.first, WebLineBreak.keepsWithNext(unit) {
                result.append("\u{2060}")
            }
        }
        return result + String(repeating: "\u{200B}\u{2060}", count: 6)
    }
}

extension EnvironmentValues {
    /// The window's height, set at the root. What the web's `vh` units map to.
    @Entry var windowHeight: CGFloat = 0
    /// The window's width, set at the root. What the web's `vw` units map to.
    @Entry var windowWidth: CGFloat = 0
    /// The font `webText` set, for views that have to measure with it.
    @Entry var webUIFont: UIFont? = nil
}

/// One line of text someone wrote, cut off like `text-overflow: ellipsis`. CoreText takes its
/// ellipsis from the font of what it cut, which for CJK is a centered one, and Chrome's always
/// comes from the primary font. Text the primary font covers is left to `Text`, which matches.
struct WebTruncatedLine: View {
    private let text: String
    @Environment(\.webUIFont) private var font

    init(_ text: String) {
        self.text = text
    }

    var body: some View {
        if let font, !font.coversAllCharacters(in: text) {
            Text(text)
                .lineLimit(1)
                .hidden()
                .overlay(alignment: .leading) {
                    GeometryReader { proxy in
                        let fitted = text.webTruncated(toFit: proxy.size.width, font: font)
                        Text(verbatim: fitted.isTruncated ? fitted.text + "\u{2026}" : text)
                            .lineLimit(1)
                            .fixedSize()
                            .accessibilityLabel(text)
                    }
                }
        } else {
            Text(text).lineLimit(1)
        }
    }
}

extension UIFont {
    func coversAllCharacters(in text: String) -> Bool {
        let characters = Array(text.utf16)
        var glyphs = [CGGlyph](repeating: 0, count: characters.count)
        return CTFontGetGlyphsForCharacters(self as CTFont, characters, &glyphs, characters.count)
    }
}

extension Text {
    /// Apple's replacement for `Text + Text`. The key type is spelled out because the `String`
    /// overload below would otherwise take the literal and print each `Text`'s description.
    init(joining first: Text, _ second: Text) {
        self.init("\(first)\(second)" as LocalizedStringKey)
    }

    /// Every plain string wraps the way Chrome wraps it. The breaks are characters in the string,
    /// so anything that can be selected and copied uses `verbatim:`, as does each piece of a
    /// concatenation but the last. VoiceOver and UI tests get the string without them.
    init(_ content: String) {
        self = Text(verbatim: content.webBreakable).accessibilityLabel(Text(verbatim: content))
    }
}

// MARK: - Preview-as-Storybook

#Preview("Design Tokens") {
    ScrollView {
        VStack(alignment: .leading, spacing: DSSpacing.lg) {
            Text("Colors").webText(20, 600)
            let swatches: [(String, Color)] = [
                ("primary", AppTheme.primary), ("buttonPrimary", AppTheme.buttonPrimary),
                ("success", AppTheme.success), ("error", AppTheme.error),
                ("background", AppTheme.background), ("backgroundSecondary", AppTheme.backgroundSecondary),
                ("backgroundTertiary", AppTheme.backgroundTertiary),
                ("textPrimary", AppTheme.textPrimary), ("textMuted", AppTheme.textMuted),
                ("border", AppTheme.border)
            ]
            ForEach(swatches, id: \.0) { name, color in
                HStack(spacing: DSSpacing.md) {
                    RoundedRectangle(cornerRadius: DSRadius.md)
                        .fill(color).frame(width: 44, height: 28)
                        .overlay(RoundedRectangle(cornerRadius: DSRadius.md).strokeBorder(AppTheme.border))
                    Text(name).webText(15)
                }
            }
        }
        .padding(DSSpacing.lg)
    }
}
