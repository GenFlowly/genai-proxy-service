import SwiftUI
import UIKit

/// The web's `citations.ts`: a response's `[n]` markers, linked to their sources as `cite://n`
/// links that the reading setting draws as chips.
enum CitationText {
    static let scheme = "cite"
    /// More chips than this in one run show as this many less one, then "+N".
    static let maxChipsInRun = 4

    /// A marker may come with its brackets escaped, `\[6\]` (markdown for a literal "[6]").
    private static let marker = try! NSRegularExpression(pattern: "\\\\?\\[(\\d{1,3})\\\\?\\](?!\\()")
    /// A run of markers, spaces allowed between them.
    private static let run = try! NSRegularExpression(pattern: "\\\\?\\[\\d{1,3}\\\\?\\](?:[ \\t]*\\\\?\\[\\d{1,3}\\\\?\\])*(?!\\()")

    /// Each marker with a source becomes `[[n]](cite://n)`; one without stays text. A run longer
    /// than `maxChipsInRun` keeps its first markers and folds the rest into one
    /// `[[19][20][21]](cite://more/19,20,21)` link.
    static func linkify(_ text: String, sources: [WebSource]?) -> String {
        guard !text.isEmpty, let sources, !sources.isEmpty else { return text }
        let known = Set(sources.map(\.index))
        let ns = text as NSString
        var out = ""
        var cursor = 0
        for match in run.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
            out += ns.substring(with: NSRange(location: cursor, length: match.range.location - cursor))
            let markers = marker.matches(in: text, range: match.range).map { result in
                (text: ns.substring(with: result.range), index: Int(ns.substring(with: result.range(at: 1))) ?? -1)
            }
            let linked = markers.filter { known.contains($0.index) }
            if linked.count == markers.count, markers.count > maxChipsInRun {
                let keep = maxChipsInRun - 1
                out += markers.prefix(keep).map { "[[\($0.index)]](\(scheme)://\($0.index))" }.joined()
                let folded = markers.dropFirst(keep)
                out += "[\(folded.map { "[\($0.index)]" }.joined())](\(scheme)://more/\(folded.map { String($0.index) }.joined(separator: ",")))"
            } else {
                out += markers.map { known.contains($0.index) ? "[[\($0.index)]](\(scheme)://\($0.index))" : $0.text }.joined()
            }
            cursor = match.range.location + match.range.length
        }
        out += ns.substring(from: cursor)
        return out
    }

    /// How many times each source index is cited in the text.
    static func counts(_ text: String) -> [Int: Int] {
        let ns = text as NSString
        var counts: [Int: Int] = [:]
        for match in marker.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
            if let index = Int(ns.substring(with: match.range(at: 1))) { counts[index, default: 0] += 1 }
        }
        return counts
    }

    /// The source numbers a `cite://` link stands for: `cite://16`, or `cite://more/19,20,21`.
    static func indexes(of url: URL) -> [Int]? {
        guard url.scheme == scheme else { return nil }
        if url.host == "more" {
            let indexes = url.lastPathComponent.split(separator: ",").compactMap { Int($0) }
            return indexes.isEmpty ? nil : indexes
        }
        return url.host.flatMap { Int($0) }.map { [$0] }
    }
}

/// The sources behind a text's citation chips, for the tooltip a chip opens.
struct CitationLookup: Equatable {
    var sources: [Int: WebSource] = [:]
    var counts: [Int: Int] = [:]
}

private struct CitationLookupKey: EnvironmentKey {
    static let defaultValue = CitationLookup()
}

extension EnvironmentValues {
    var citationLookup: CitationLookup {
        get { self[CitationLookupKey.self] }
        set { self[CitationLookupKey.self] = newValue }
    }
}

/// Attribute value for a citation chip (the web's CitationChip): the layout manager draws its
/// 16pt box with 3pt corners behind the source number, 4pt from the word before it, the digits
/// raised 0.15em off the baseline.
final class CitationChipBox: NSObject {
    static let height: CGFloat = 16
    static let minWidth: CGFloat = 16
    static let gap: CGFloat = 4
    static let fontSize: CGFloat = 10.5
    static let cornerRadius: CGFloat = 3

    static var font: UIFont { DSFont.ui(fontSize, weight: 500) }

    /// Rest: the text color at 10% under it at 72%, so the chip shows on any surface.
    static let fill = AppTheme.UI.textPrimary.withAlphaComponent(0.10)
    static let digits = AppTheme.UI.textPrimary.withAlphaComponent(0.72)
    /// Open (its tooltip showing).
    static let openFill = AppTheme.UI.dynamic(light: "#E6F3FF", dark: "#1C2A3A")
    static let openBorder = AppTheme.UI.primary
    static let openDigits = AppTheme.UI.dynamic(light: "#005BC5", dark: "#FFFFFF")

    let url: URL
    /// The markers the chip replaces ("[16]"): what a copy or a selection gives back.
    let markers: String
    let indexes: [Int]
    /// The text's baseline from the top of its line box.
    let baselineFromTop: CGFloat
    /// From the chip's top edge down to its digits' baseline (1pt border + the 14pt line box).
    let topAboveBaseline: CGFloat
    let raise: CGFloat
    /// The box's width: the label plus 4pt padding and a 1pt border each side, at least 16pt.
    let width: CGFloat

    private init(url: URL, markers: String, indexes: [Int], baselineFromTop: CGFloat, width: CGFloat) {
        self.url = url
        self.width = width
        self.markers = markers
        self.indexes = indexes
        self.baselineFromTop = baselineFromTop
        let font = Self.font
        topAboveBaseline = 1 + WebLineBox(font: font, lineHeight: DSFont.scaledSize(14)).baseline
        raise = DSFont.scaledSize(Self.fontSize) * 0.15
    }

    /// The chip's characters for a `cite://` link, or nil for any other link: a word joiner
    /// carrying the gap (it keeps the chip on the line of the word before it), then the box's
    /// own word joiner and label, padded by kerning to the chip's width.
    static func chip(for url: URL, markers: String, baselineFromTop: CGFloat) -> NSAttributedString? {
        guard let indexes = CitationText.indexes(of: url) else { return nil }
        let label = url.host == "more" ? L("common.citation.more", ["count": indexes.count]) : String(indexes[0])
        let font = Self.font
        let textWidth = (label as NSString).size(withAttributes: [.font: font]).width
        // `min-width: 16px; padding: 0 4px; border: 1px`
        let width = max(minWidth, textWidth + 10)
        let pad = (width - textWidth) / 2
        let box = CitationChipBox(url: url, markers: markers, indexes: indexes, baselineFromTop: baselineFromTop, width: width)

        let out = NSMutableAttributedString(string: "\u{2060}", attributes: [.font: font, .kern: gap])
        let piece = NSMutableAttributedString(string: "\u{2060}" + label, attributes: [
            .font: font,
            .foregroundColor: digits,
            .link: url,
            .mdCitation: box
        ])
        piece.addAttribute(.kern, value: pad, range: NSRange(location: 0, length: 1))
        piece.addAttribute(.kern, value: pad, range: NSRange(location: piece.length - 1, length: 1))
        out.append(piece)
        return out
    }

    /// After a block's `baselineOffset` is set, a chip's digits sit `raise` above it.
    static func raiseChips(in text: NSMutableAttributedString, baselineOffset: CGFloat) {
        text.enumerateAttribute(.mdCitation, in: NSRange(location: 0, length: text.length)) { value, range, _ in
            guard let box = value as? CitationChipBox else { return }
            text.addAttribute(.baselineOffset, value: baselineOffset + box.raise, range: range)
        }
    }

    /// String drawing (`size()`, `boundingRect`) leaves out the padding kerned onto a chip's
    /// characters, which TextKit lays out: a width to size a box by has to come from TextKit.
    static func layoutWidth(of text: NSAttributedString) -> CGFloat? {
        var hasChip = false
        text.enumerateAttribute(.mdCitation, in: NSRange(location: 0, length: text.length)) { value, _, stop in
            if value != nil { hasChip = true; stop.pointee = true }
        }
        guard hasChip else { return nil }
        let storage = NSTextStorage(attributedString: text)
        let layout = NSLayoutManager()
        storage.addLayoutManager(layout)
        let container = NSTextContainer(size: CGSize(width: 1_000_000, height: 1_000_000))
        container.lineFragmentPadding = 0
        layout.addTextContainer(container)
        layout.ensureLayout(for: container)
        var widest: CGFloat = 0
        layout.enumerateLineFragments(forGlyphRange: NSRange(location: 0, length: layout.numberOfGlyphs)) { _, used, _, _, _ in
            widest = max(widest, used.width)
        }
        return widest
    }

    /// The text with each chip's characters swapped for its markers, for copy and selection.
    static func plainText(of text: NSAttributedString, in range: NSRange) -> String {
        var out = ""
        text.enumerateAttribute(.mdCitation, in: range) { value, run, _ in
            if let box = value as? CitationChipBox {
                // A chip's characters are one run per chip; a run that is only part of a chip
                // still stands for the whole marker
                out += box.markers
            } else {
                out += (text.string as NSString).substring(with: run)
            }
        }
        return MarkdownUITextView.withoutLayoutCharacters(out)
    }
}
