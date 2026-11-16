import UIKit

/// Attributes the markdown text view's layout manager draws itself (the parts of
/// the web's CSS boxes NSAttributedString can't express).
extension NSAttributedString.Key {
    static let mdInlineCode = NSAttributedString.Key("md.inlineCode")
    static let mdQuoteBars = NSAttributedString.Key("md.quoteBars")
    static let mdRule = NSAttributedString.Key("md.rule")
    static let mdMarker = NSAttributedString.Key("md.marker")
}

/// A list marker drawn in the hanging gutter left of the text (CSS
/// `list-style-position: outside`), so it is never part of a text selection.
final class MarkdownMarker: NSObject {
    enum Kind { case disc, circle, square, ordinal(String) }
    let kind: Kind
    let font: UIFont
    let color: UIColor
    let baselineFromTop: CGFloat

    init(kind: Kind, font: UIFont, color: UIColor, baselineFromTop: CGFloat) {
        self.kind = kind
        self.font = font
        self.color = color
        self.baselineFromTop = baselineFromTop
    }
}

/// One renderable piece of a response: contiguous prose collapses into a single
/// selectable text view; code, tables, images and display math are their own views.
enum MarkdownSegment: Identifiable {
    case text(id: Int, NSAttributedString, marginTop: CGFloat, marginBottom: CGFloat)
    case code(id: Int, language: String?, code: String, marginTop: CGFloat, marginBottom: CGFloat)
    case table(id: Int, MarkdownTable, marginTop: CGFloat, marginBottom: CGFloat)
    case math(id: Int, latex: String, marginTop: CGFloat, marginBottom: CGFloat)
    case image(id: Int, url: URL, alt: String, marginTop: CGFloat, marginBottom: CGFloat)

    var id: Int {
        switch self {
        case .text(let id, _, _, _), .code(let id, _, _, _, _), .table(let id, _, _, _),
             .math(let id, _, _, _), .image(let id, _, _, _, _):
            return id
        }
    }
}

struct MarkdownTable {
    enum Alignment { case left, center, right }

    /// `padding: 0.55rem 0.8rem`.
    static let cellPaddingX = LayoutUnit.truncating(12.8)
    static let cellPaddingY = LayoutUnit.truncating(8.8)
    /// A collapsed border: half of it belongs to the cell on each side of a grid line.
    static let collapsedBorder: CGFloat = 1
    /// `min-width: 7rem`, on any cell with a run that can wrap anywhere.
    private static let wrapAnywhereFloor: CGFloat = 112
    private static let floorlessColumnCount = 7

    let alignments: [Alignment]
    let header: [NSAttributedString]
    let rows: [[NSAttributedString]]
    /// `data-label`: each column's header as plain text, beside its value once a row restacks.
    let labels: [NSAttributedString]
    /// `rows` for stacked cards, where a value sits beside its label and always reads from the left.
    let stackedRows: [[NSAttributedString]]
    private let minWidths: [CGFloat]
    private let maxWidths: [CGFloat]

    var columnCount: Int { max(alignments.count, header.count) }

    private static let numericCell = /^[+\-−]?[$€£¥₹]?(?:\d[\d,]*(?:\.\d+)?|\.\d+)(?:%|[kKmMbB])?$/
    private static let emptyCell = /^(?:|-|–|—|n\/a)$/.ignoresCase()

    /// The rule for every table in the product: a column of numbers aligns right. The library's
    /// `isNumericColumn` has to give the same answers.
    /// Foundation reports a column with no alignment as `.left`, so an explicit `:---` can only
    /// be told apart in the source: for each table in order, the columns written that way.
    static func explicitLeftColumns(in markdown: String) -> [Set<Int>] {
        var tables: [Set<Int>] = []
        var inFence = false
        for rawLine in markdown.split(separator: "\n", omittingEmptySubsequences: false) {
            let line = rawLine.trimmingCharacters(in: CharacterSet.whitespaces.union(CharacterSet(charactersIn: ">")))
            if line.hasPrefix("```") || line.hasPrefix("~~~") {
                inFence.toggle()
                continue
            }
            guard !inFence, line.contains("|"), line.wholeMatch(of: delimiterRow) != nil else { continue }
            let cells = line.trimmingCharacters(in: CharacterSet(charactersIn: "|"))
                .split(separator: "|", omittingEmptySubsequences: false)
                .map { $0.trimmingCharacters(in: .whitespaces) }
            tables.append(Set(cells.enumerated().compactMap { $1.hasPrefix(":") && !$1.hasSuffix(":") ? $0 : nil }))
        }
        return tables
    }

    private static let delimiterRow = /\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?/

    static func isNumericColumn(_ values: [String]) -> Bool {
        let filled = values
            .map { MarkdownUITextView.withoutLayoutCharacters($0).trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { $0.wholeMatch(of: emptyCell) == nil }
        return !filled.isEmpty && filled.allSatisfy { $0.wholeMatch(of: numericCell) != nil }
    }

    init(alignments: [Alignment], numericColumns: Set<Int> = [], header: [NSAttributedString], rows: [[NSAttributedString]], labels: [NSAttributedString]) {
        self.alignments = alignments
        self.header = header
        self.rows = rows
        self.labels = labels
        stackedRows = numericColumns.isEmpty ? rows : rows.map { row in
            row.enumerated().map { column, cell in
                guard numericColumns.contains(column) else { return cell }
                let aligned = NSMutableAttributedString(attributedString: cell)
                aligned.enumerateAttribute(.paragraphStyle, in: NSRange(location: 0, length: aligned.length)) { value, range, _ in
                    guard let style = (value as? NSParagraphStyle)?.mutableCopy() as? NSMutableParagraphStyle else { return }
                    style.alignment = .left
                    aligned.addAttribute(.paragraphStyle, value: style, range: range)
                }
                return aligned
            }
        }
        var minWidths = [CGFloat](repeating: 0, count: header.count)
        var maxWidths = minWidths
        let floor = header.count < Self.floorlessColumnCount ? Self.wrapAnywhereFloor : 0
        for row in [header] + rows {
            for (column, cell) in row.enumerated() where column < header.count {
                let widths = Self.intrinsicWidths(of: cell, wrapAnywhereFloor: floor)
                minWidths[column] = max(minWidths[column], widths.min)
                maxWidths[column] = max(maxWidths[column], widths.max)
            }
        }
        self.minWidths = minWidths
        self.maxWidths = maxWidths
    }

    /// CSS `table-layout: auto` under `width: max-content; max-width: 100%`: every column at its
    /// max-content if that fits, otherwise its min-content plus a share of what's left in
    /// proportion to how much it wanted beyond that. A table that can't shrink enough overflows.
    func columnWidths(available: CGFloat) -> [CGFloat] {
        let target = available - Self.collapsedBorder
        let totalMax = maxWidths.reduce(0, +)
        if totalMax <= target { return maxWidths }
        let totalMin = minWidths.reduce(0, +)
        if totalMin >= target { return minWidths }
        return zip(minWidths, maxWidths).map { $0 + (target - totalMin) * ($1 - $0) / (totalMax - totalMin) }
    }

    private static func intrinsicWidths(of cell: NSAttributedString, wrapAnywhereFloor: CGFloat) -> (min: CGFloat, max: CGFloat) {
        let chrome = (cellPaddingX + collapsedBorder / 2) * 2
        guard cell.length > 0 else { return (chrome, chrome) }

        let wrapAnywhere = wrapAnywhereRanges(in: cell)
        let text = cell.string as NSString
        var widest: CGFloat = 0
        func measure(_ range: NSRange) {
            widest = max(widest, LayoutUnit.ceiling(cell.attributedSubstring(from: range).size().width))
        }
        var cursor = 0
        for range in wrapAnywhere.rangeView.map({ NSRange(location: $0.lowerBound, length: $0.count) }) + [NSRange(location: text.length, length: 0)] {
            let before = NSRange(location: cursor, length: range.location - cursor)
            for piece in WebLineBreak.unbreakableRanges(in: text.substring(with: before) as NSString) {
                measure(NSRange(location: piece.location + cursor, length: piece.length))
            }
            text.enumerateSubstrings(in: range, options: .byComposedCharacterSequences) { _, character, _, _ in measure(character) }
            cursor = range.upperBound
        }

        let floor = wrapAnywhere.isEmpty ? 0 : wrapAnywhereFloor
        let minimum = max(widest + chrome, floor)
        let full = cell.boundingRect(with: CGSize(width: 1_000_000, height: 1_000_000), options: [.usesLineFragmentOrigin], context: nil).width
        return (minimum, max(LayoutUnit.ceiling(full) + chrome, minimum))
    }

    /// `:is(code, a, [data-token]) { overflow-wrap: anywhere }`. Code and links end a run.
    private static func wrapAnywhereRanges(in cell: NSAttributedString) -> IndexSet {
        var ranges = IndexSet()
        let full = NSRange(location: 0, length: cell.length)
        cell.enumerateAttributes(in: full) { attributes, range, _ in
            if attributes[.mdInlineCode] != nil || attributes[.link] != nil, let indexes = Range(range) {
                ranges.insert(integersIn: indexes)
            }
        }
        let text = cell.string as NSString
        var start: Int?
        var tokens = IndexSet()
        for index in 0...text.length {
            let endsRun = index == text.length || ranges.contains(index)
                || CharacterSet.whitespacesAndNewlines.contains(Unicode.Scalar(text.character(at: index)) ?? "x")
            if !endsRun {
                if start == nil { start = index }
            } else if let runStart = start {
                let run = MarkdownUITextView.withoutLayoutCharacters(text.substring(with: NSRange(location: runStart, length: index - runStart)))
                if isLongToken(run) { tokens.insert(integersIn: runStart..<index) }
                start = nil
            }
        }
        return ranges.union(tokens)
    }

    private static let tokenMinScalars = 16
    private static let wordTokenMinScalars = 22
    private static let plainWord = try! NSRegularExpression(pattern: "^[^\\p{L}\\p{N}]*[\\p{L}\\p{M}]+(?:['\u{2019}-][\\p{L}\\p{M}]+)*[^\\p{L}\\p{N}]*$")
    private static let camelCase = try! NSRegularExpression(pattern: "\\p{Ll}\\p{Lu}")
    private static let hasLetter = try! NSRegularExpression(pattern: "\\p{L}")
    private static let selfBreaking = try! NSRegularExpression(
        pattern: "[\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}\\p{Script=Thai}\\p{Script=Lao}\\p{Script=Khmer}\\p{Script=Myanmar}]+"
    )

    /// `isLongToken`: an unbreakable run the web marks to wrap anywhere, because it's too long
    /// to sit whole on a phone. Identifier-like runs qualify sooner than ordinary words.
    static func isLongToken(_ run: String) -> Bool {
        func matches(_ regex: NSRegularExpression, _ text: String) -> Bool {
            regex.firstMatch(in: text, range: NSRange(location: 0, length: (text as NSString).length)) != nil
        }
        if run.unicodeScalars.contains(where: { CharacterSet.whitespacesAndNewlines.contains($0) }) { return false }
        let length = run.unicodeScalars.count
        if length < tokenMinScalars { return false }
        if matches(selfBreaking, run) {
            let separated = selfBreaking.stringByReplacingMatches(in: run, range: NSRange(location: 0, length: (run as NSString).length), withTemplate: " ")
            return separated.split(separator: " ").contains { isLongToken(String($0)) }
        }
        if length >= wordTokenMinScalars { return true }
        if !matches(hasLetter, run) { return false }
        return !matches(plainWord, run) || matches(camelCase, run)
    }
}

/// Parses markdown with Foundation's GFM parser (cmark-gfm) and lays it out using
/// the exact metrics of the web's TextContainer.module.scss:
/// - `p` 16.8/28.56, margin-bottom 16
/// - `h1` 32 (margin-top 0.125rem in a response), `h2` 24, `h3` 18.72, `h4` 16; all 700,
///   line-height 1.7, margin 24/12; `h5` 13.28, `h6` 10.72 (no margins — only h1–h4 get them)
/// - tight list items 16/27.2, loose ones get the `p` rule; lists have no margin or
///   indent of their own (the reset's `padding: 0`), with markers hanging outside
/// - `blockquote` italic secondary text, 4pt bar + 12pt padding, margin 19.2
/// Adjacent margins collapse like CSS (the larger wins).
enum MarkdownParser {
    /// How far the text view reaches past the text on each side: the page gutter, which list
    /// markers hang into. Anything wider than that runs off the screen on the web too.
    static let hangingInset: CGFloat = 24

    struct Options: Hashable {
        /// Web `Request`: `p:first-of-type::first-letter { text-transform: uppercase }`.
        var capitalizeFirstLetter = false
        /// `.responseWrapper article h1 { margin-top: 0.125rem }`.
        var tightFirstHeading = true
        /// Detail cards: `.markdown ol, ul { padding-left: 1.5rem }`, so markers sit inside the text column.
        var listIndent: CGFloat = 0
        /// A conversation turn (`.article.turn`): text at this size (16 a response, 17 a prompt),
        /// line height 1.55, 12pt between blocks, lists indented 22pt a level with 4pt between
        /// items, and no margin before the first block or after the last.
        var turnTextSize: CGFloat?
    }

    /// The metrics a document is laid out with: the card's (the rules above) or a turn's.
    struct Typography {
        let paragraphSize: CGFloat
        let listItemSize: CGFloat
        /// `h1`–`h6` are 2, 1.5, 1.17, 1, 0.83 and 0.67em of it.
        let headingBase: CGFloat
        let lineHeight: CGFloat
        let blockGap: CGFloat
        let listItemGap: CGFloat
        /// Below a list that isn't inside another one.
        let listGap: CGFloat
        let listIndent: CGFloat
        /// A nested list adds its own indent (a turn's `padding-left` per list).
        let nestsListIndent: Bool
        let trimsEdges: Bool

        init(_ options: Options) {
            if let size = options.turnTextSize {
                paragraphSize = size
                listItemSize = size
                headingBase = size
                lineHeight = 1.55
                blockGap = 12
                listItemGap = 4
                listGap = 12
                listIndent = 22
                nestsListIndent = true
                trimsEdges = true
            } else {
                paragraphSize = 16.8
                listItemSize = 16
                headingBase = 16
                lineHeight = 1.7
                blockGap = 16
                listItemGap = 0
                listGap = 0
                listIndent = options.listIndent
                nestsListIndent = false
                trimsEdges = false
            }
        }

        static let card = Typography(Options())
    }

    private static let cache: NSCache<NSString, Box> = {
        let c = NSCache<NSString, Box>()
        c.countLimit = 200
        return c
    }()

    static func clearCache() { cache.removeAllObjects() }

    private final class Box {
        let segments: [MarkdownSegment]
        init(_ s: [MarkdownSegment]) { segments = s }
    }

    static func segments(for markdown: String, options: Options = Options()) -> [MarkdownSegment] {
        let key = "\(options.capitalizeFirstLetter ? 1 : 0)\(options.tightFirstHeading ? 1 : 0)\(options.listIndent)|\(options.turnTextSize ?? 0)|\(markdown)" as NSString
        if let hit = cache.object(forKey: key) { return hit.segments }
        let result = build(markdown, options: options)
        cache.setObject(Box(result), forKey: key)
        return result
    }

    // MARK: - Math

    private static let mathOpen = "\u{E000}"
    private static let mathClose = "\u{E001}"
    private static let displayMathRegex = try! NSRegularExpression(pattern: "^\\$\\$[ \\t]*\\n([\\s\\S]+?)\\n\\$\\$[ \\t]*$", options: [.anchorsMatchLines])
    private static let inlineMathRegex = try! NSRegularExpression(pattern: "\\$\\$(.+?)\\$\\$", options: [])
    private static let tagDisplay = try! NSRegularExpression(pattern: "\\\\\\[([\\s\\S]+?)\\\\\\]", options: [])
    private static let tagInline = try! NSRegularExpression(pattern: "\\\\\\((.+?)\\\\\\)", options: [])
    private static let codeSplit = try! NSRegularExpression(pattern: "(```[\\s\\S]*?(?:```|$)|`[^`\\n]*`)", options: [])

    /// `normalizeMathDelimiters` + math extraction: fenced `$$` is display math,
    /// `$$…$$` inline (single-dollar stays text — currency). Code stays untouched.
    private static func extractMath(_ source: String) -> (String, [String]) {
        guard source.contains("$$") || source.contains("\\[") || source.contains("\\(") else { return (source, []) }
        var maths: [String] = []
        let ns = source as NSString
        var result = ""
        var cursor = 0
        func transform(_ text: String) -> String {
            var t = text
            t = replacing(tagDisplay, in: t) { "\n$$\n\($0.trimmingCharacters(in: .whitespacesAndNewlines))\n$$\n" }
            t = replacing(tagInline, in: t) { "$$\($0.trimmingCharacters(in: .whitespacesAndNewlines))$$" }
            t = replacing(displayMathRegex, in: t) { body in
                maths.append(body)
                return "\n\n\(mathOpen)D\(maths.count - 1)\(mathClose)\n\n"
            }
            t = replacing(inlineMathRegex, in: t) { body in
                maths.append(body)
                return "\(mathOpen)I\(maths.count - 1)\(mathClose)"
            }
            return t
        }
        for match in codeSplit.matches(in: source, range: NSRange(location: 0, length: ns.length)) {
            result += transform(ns.substring(with: NSRange(location: cursor, length: match.range.location - cursor)))
            result += ns.substring(with: match.range)
            cursor = match.range.location + match.range.length
        }
        result += transform(ns.substring(from: cursor))
        return (result, maths)
    }

    private static func replacing(_ regex: NSRegularExpression, in text: String, _ transform: (String) -> String) -> String {
        let ns = text as NSString
        var out = ""
        var cursor = 0
        for match in regex.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
            out += ns.substring(with: NSRange(location: cursor, length: match.range.location - cursor))
            out += transform(ns.substring(with: match.range(at: 1)))
            cursor = match.range.location + match.range.length
        }
        return out + ns.substring(from: cursor)
    }

    // MARK: - List tightness

    /// Foundation's parser doesn't expose CommonMark's tight/loose distinction, so
    /// lists are scanned from the source in document order (the same pre-order the
    /// parser reports them in). A wrong guess only changes 16 vs 16.8pt text.
    static func listLooseness(in source: String) -> [Bool] {
        struct Open { var index: Int; var indent: Int; var contentOffset: Int; var marker: Character; var ordered: Bool }
        var results: [Bool] = []
        var stack: [Open] = []
        var blank = false
        var fence: String?
        let itemRegex = try! NSRegularExpression(pattern: "^( *)((?:[-*+])|(?:\\d{1,9}[.)]))( +|$)")

        for rawLine in source.components(separatedBy: "\n") {
            var line = rawLine
            while line.hasPrefix(">") || line.hasPrefix(" >") {
                line = String(line.drop { $0 == " " }.dropFirst())
                if line.hasPrefix(" ") { line.removeFirst() }
            }
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if let openFence = fence {
                if trimmed.hasPrefix(openFence) { fence = nil }
                continue
            }
            if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") { fence = String(trimmed.prefix(3)) }
            if trimmed.isEmpty {
                blank = true
                continue
            }
            let ns = line as NSString
            if let m = itemRegex.firstMatch(in: line, range: NSRange(location: 0, length: ns.length)), fence == nil {
                let indent = m.range(at: 1).length
                let markerText = ns.substring(with: m.range(at: 2))
                let ordered = markerText.first?.isNumber == true
                let marker = markerText.last ?? "-"
                let contentOffset = indent + m.range(at: 2).length + max(1, m.range(at: 3).length)
                while let top = stack.last, indent < top.indent, indent < top.contentOffset {
                    stack.removeLast()
                }
                if let top = stack.last, indent < top.contentOffset, top.ordered == ordered, top.marker == marker {
                    if blank { results[top.index] = true }
                    stack[stack.count - 1].contentOffset = contentOffset
                    stack[stack.count - 1].indent = indent
                } else {
                    if let top = stack.last, indent < top.contentOffset { stack.removeLast() }
                    results.append(false)
                    stack.append(Open(index: results.count - 1, indent: indent, contentOffset: contentOffset, marker: marker, ordered: ordered))
                }
                blank = false
            } else {
                let indent = line.prefix { $0 == " " }.count
                if blank {
                    while let top = stack.last, indent < top.contentOffset { stack.removeLast() }
                    if let top = stack.last { results[top.index] = true }
                }
                blank = false
            }
        }
        return results
    }

    // MARK: - Build

    private struct Leaf {
        enum Kind {
            case paragraph, header(Int), code(String?), rule, tableCell(row: Int, col: Int, tableId: Int, alignments: [MarkdownTable.Alignment]), html
        }
        var kind: Kind
        var id: Int
        var containers: [PresentationIntent.IntentType]
        var runs: AttributedString
    }

    private static func build(_ raw: String, options: Options) -> [MarkdownSegment] {
        guard !raw.isEmpty else { return [] }
        let (source, maths) = extractMath(raw)
        let parseOptions = AttributedString.MarkdownParsingOptions(
            allowsExtendedAttributes: true,
            interpretedSyntax: .full,
            failurePolicy: .returnPartiallyParsedIfPossible
        )
        let typography = Typography(options)
        guard let document = try? AttributedString(markdown: source, options: parseOptions) else {
            return [.text(id: 0, paragraphFallback(raw, typography), marginTop: 0, marginBottom: typography.trimsEdges ? 0 : typography.blockGap)]
        }

        let leaves = collectLeaves(document)
        let looseFlags = listLooseness(in: source)

        var segments: [MarkdownSegment] = []
        var nextId = 0
        var current: NSMutableAttributedString?
        /// Collapsed margin above `current`'s first block (TextKit ignores spacing before the
        /// first paragraph of a text view, so the segment carries it).
        var currentTopMargin: CGFloat = 0
        /// Bottom margin of the last emitted block, still uncollapsed.
        var pendingMargin: CGFloat = 0
        var lastWasText = false
        var listOrder: [Int: Int] = [:]
        var didCapitalize = false
        var seenFirstBlock = false

        func flushText(marginBottom: CGFloat) {
            if let text = current {
                segments.append(.text(id: nextId, text, marginTop: currentTopMargin, marginBottom: marginBottom))
                nextId += 1
                current = nil
                currentTopMargin = 0
            }
        }

        /// The margin between text and a following block lives on the block, collapsed.
        func emit(block: () -> MarkdownSegment) {
            flushText(marginBottom: 0)
            segments.append(block())
            nextId += 1
            lastWasText = false
        }

        func looseness(of containers: [PresentationIntent.IntentType]) -> Bool {
            for intent in containers {
                switch intent.kind {
                case .orderedList, .unorderedList:
                    if listOrder[intent.identity] == nil { listOrder[intent.identity] = listOrder.count }
                default: break
                }
            }
            for intent in containers {
                switch intent.kind {
                case .orderedList, .unorderedList:
                    let idx = listOrder[intent.identity] ?? 0
                    return idx < looseFlags.count ? looseFlags[idx] : false
                default: continue
                }
            }
            return false
        }

        let explicitLeftColumns = MarkdownTable.explicitLeftColumns(in: source)
        var tableIndex = 0
        var i = 0
        while i < leaves.count {
            let leaf = leaves[i]
            let quoteDepth = leaf.containers.filter { if case .blockQuote = $0.kind { return true }; return false }.count
            let inList = leaf.containers.contains { if case .listItem = $0.kind { return true }; return false }
            let quoteMargin: CGFloat = quoteDepth > 0 && isFirstInQuote(leaves, i) ? LayoutUnit.truncating(19.2) : 0
            let quoteBottom: CGFloat = quoteDepth > 0 && isLastInQuote(leaves, i) ? LayoutUnit.truncating(19.2) : 0

            switch leaf.kind {
            case .tableCell(_, _, let tableId, let alignments):
                var header: [Int: NSAttributedString] = [:]
                var rows: [Int: [Int: NSAttributedString]] = [:]
                let explicitLeft = explicitLeftColumns.indices.contains(tableIndex) ? explicitLeftColumns[tableIndex] : []
                tableIndex += 1
                var bodyValues: [Int: [String]] = [:]
                var scan = i
                while scan < leaves.count, case .tableCell(let row, let col, let id, _) = leaves[scan].kind, id == tableId {
                    if row != 0 { bodyValues[col, default: []].append(String(leaves[scan].runs.characters)) }
                    scan += 1
                }
                let numericColumns = Set(bodyValues.compactMap { column, values in
                    (column >= alignments.count || alignments[column] == .left) && !explicitLeft.contains(column)
                        && MarkdownTable.isNumericColumn(values) ? column : nil
                })
                var j = i
                while j < leaves.count, case .tableCell(let row, let col, let id, _) = leaves[j].kind, id == tableId {
                    let style: InlineStyle = row == 0 ? .tableHeader : .tableCell
                    let cell = tableBlock(
                        inlineString(leaves[j].runs, style: style, maths: maths, typography: typography),
                        style: style,
                        typography: typography,
                        alignment: numericColumns.contains(col) ? .right : (col < alignments.count ? alignments[col] : .left),
                        fixedLineHeight: maths.isEmpty
                    )
                    if row == 0 { header[col] = cell } else { rows[row, default: [:]][col] = cell }
                    j += 1
                }
                i = j
                let columns = max(alignments.count, (header.keys.max() ?? -1) + 1)
                let blank = NSAttributedString()
                let table = MarkdownTable(
                    alignments: alignments,
                    numericColumns: numericColumns,
                    header: (0..<columns).map { header[$0] ?? blank },
                    rows: rows.keys.sorted().map { key in (0..<columns).map { rows[key]?[$0] ?? blank } },
                    labels: (0..<columns).map { column in
                        let text = (header[column]?.string ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                        return tableBlock(
                            NSAttributedString(string: text, attributes: [.font: DSFont.ui(15.2, weight: 600), .foregroundColor: AppTheme.UI.textSecondary]),
                            style: .tableHeader,
                            typography: typography,
                            alignment: column < alignments.count ? alignments[column] : .left,
                            fixedLineHeight: true
                        )
                    }
                )
                let marginTop = typography.trimsEdges && !seenFirstBlock ? 0 : max(pendingMargin, quoteMargin)
                pendingMargin = 24
                seenFirstBlock = true
                emit { .table(id: nextId, table, marginTop: marginTop, marginBottom: 0) }
                continue
            case .code(let language):
                let code = String(leaf.runs.characters).replacingOccurrences(of: "\\n$", with: "", options: .regularExpression)
                let marginTop = typography.trimsEdges && !seenFirstBlock ? 0 : max(pendingMargin, quoteMargin)
                pendingMargin = 24
                seenFirstBlock = true
                emit { .code(id: nextId, language: language, code: code, marginTop: marginTop, marginBottom: 0) }
                i += 1
                continue
            default:
                break
            }

            // A paragraph holding only a fenced `$$` placeholder or a lone image is its own view.
            let plain = String(leaf.runs.characters)
            if case .paragraph = leaf.kind {
                if plain.hasPrefix(mathOpen + "D"), plain.hasSuffix(mathClose),
                   let index = Int(plain.dropFirst(2).dropLast()), index < maths.count {
                    let marginTop = typography.trimsEdges && !seenFirstBlock ? 0 : max(pendingMargin, quoteMargin)
                    pendingMargin = typography.blockGap
                    seenFirstBlock = true
                    emit { .math(id: nextId, latex: maths[index], marginTop: marginTop, marginBottom: 0) }
                    i += 1
                    continue
                }
                let runs = Array(leaf.runs.runs)
                if runs.count == 1, let url = runs[0].imageURL {
                    let marginTop = typography.trimsEdges && !seenFirstBlock ? 0 : max(pendingMargin, quoteMargin)
                    pendingMargin = typography.blockGap
                    seenFirstBlock = true
                    emit { .image(id: nextId, url: url, alt: plain, marginTop: marginTop, marginBottom: 0) }
                    i += 1
                    continue
                }
            }

            // Prose: merged into the current text run.
            let loose = inList && looseness(of: leaf.containers)
            let style: InlineStyle
            var marginTop: CGFloat = 0
            var marginBottom: CGFloat = 0
            switch leaf.kind {
            case .header(let level):
                style = .heading(level)
                if level <= 4 {
                    marginTop = 24
                    marginBottom = 12
                    if level == 1, options.tightFirstHeading { marginTop = 2 }
                }
            case .rule:
                style = .paragraph
            case .html:
                style = .paragraph
                marginBottom = typography.blockGap
            default:
                if inList && !loose {
                    style = .listItem
                } else {
                    style = .paragraph
                    marginBottom = typography.blockGap
                }
            }
            let isQuote = quoteDepth > 0
            let finalStyle: InlineStyle = isQuote ? style.quoted : style

            if inList {
                if isFirstLeafOfItem(leaves, i) { marginTop = max(marginTop, typography.listItemGap) }
                if isLastLeafOfItem(leaves, i) { marginBottom = max(marginBottom, typography.listItemGap) }
                if endsOutermostList(leaves, i) { marginBottom = max(marginBottom, typography.listGap) }
            }
            marginTop = max(marginTop, quoteMargin)
            marginBottom = max(marginBottom, quoteBottom)
            // A turn's first block: only a list item's own margin stays (it collapses through the list's).
            let collapsedTop = typography.trimsEdges && !seenFirstBlock
                ? (inList ? typography.listItemGap : 0)
                : max(pendingMargin, marginTop)

            var content = inlineString(leaf.runs, style: finalStyle, maths: maths, typography: typography)
            if options.capitalizeFirstLetter, !didCapitalize, case .paragraph = leaf.kind, content.length > 0 {
                didCapitalize = true
                let mutable = NSMutableAttributedString(attributedString: content)
                let first = (mutable.string as NSString).substring(to: 1)
                mutable.replaceCharacters(in: NSRange(location: 0, length: 1), with: first.uppercased())
                content = mutable
            }

            if case .rule = leaf.kind {
                content = NSAttributedString(string: "\u{200B}", attributes: [.font: UIFont.systemFont(ofSize: 1), .mdRule: true])
            }

            let metrics = finalStyle.metrics(typography)
            let paragraph = NSMutableParagraphStyle()
            let quoteIndent = CGFloat(quoteDepth) * 16
            let listIndent = inList ? typography.listIndent * (typography.nestsListIndent ? CGFloat(listDepth(leaf.containers)) : 1) : 0
            paragraph.firstLineHeadIndent = hangingInset + quoteIndent + listIndent
            paragraph.headIndent = hangingInset + quoteIndent + listIndent
            paragraph.tailIndent = -hangingInset
            paragraph.lineBreakMode = .byWordWrapping
            if case .rule = leaf.kind {
                paragraph.minimumLineHeight = 2
                paragraph.maximumLineHeight = 2
            } else {
                paragraph.minimumLineHeight = metrics.lineHeight
                paragraph.maximumLineHeight = maths.isEmpty ? metrics.lineHeight : 0
            }

            let mutable = NSMutableAttributedString(attributedString: content)
            let full = NSRange(location: 0, length: mutable.length)
            mutable.addAttribute(.paragraphStyle, value: paragraph, range: full)
            if case .rule = leaf.kind {} else {
                mutable.addAttribute(.baselineOffset, value: metrics.baselineOffset, range: full)
            }
            if quoteDepth > 0 {
                mutable.addAttribute(.mdQuoteBars, value: quoteDepth, range: full)
            }
            if inList, isFirstLeafOfItem(leaves, i), mutable.length > 0 {
                mutable.addAttribute(.mdMarker, value: marker(for: leaf.containers, metrics: metrics, style: finalStyle, typography: typography), range: NSRange(location: 0, length: 1))
            }

            if current == nil {
                current = NSMutableAttributedString()
                if collapsedTop > 0, seenFirstBlock || marginTop > 0 || typography.trimsEdges {
                    currentTopMargin = collapsedTop
                }
            } else if let existing = current {
                // Spacing between blocks in one text view: the collapsed margin.
                let last = existing.length - 1
                if last >= 0, let style = existing.attribute(.paragraphStyle, at: last, effectiveRange: nil) as? NSParagraphStyle {
                    let updated = paragraphCopy(style)
                    updated.paragraphSpacing = collapsedTop
                    let range = (existing.string as NSString).paragraphRange(for: NSRange(location: last, length: 0))
                    existing.addAttribute(.paragraphStyle, value: updated, range: range)
                }
                existing.append(NSAttributedString(string: "\n", attributes: existing.attributes(at: last, effectiveRange: nil)))
            }
            current?.append(mutable)
            pendingMargin = marginBottom
            lastWasText = true
            seenFirstBlock = true
            i += 1
        }
        // A turn's last block keeps only a list item's own margin (it collapses through the list's).
        let endMargin = typography.trimsEdges
            ? (leaves.last.map { leaf in leaf.containers.contains { if case .listItem = $0.kind { return true }; return false } } == true ? typography.listItemGap : 0)
            : pendingMargin
        flushText(marginBottom: endMargin)
        // A block view that ends the document keeps its own margin (web: margins stay
        // inside `.markdownBody`, a block formatting context).
        if !lastWasText, let last = segments.last {
            segments[segments.count - 1] = withBottomMargin(last, endMargin)
        }
        return segments
    }

    private static func withBottomMargin(_ segment: MarkdownSegment, _ margin: CGFloat) -> MarkdownSegment {
        switch segment {
        case .code(let id, let l, let c, let t, _): return .code(id: id, language: l, code: c, marginTop: t, marginBottom: margin)
        case .table(let id, let table, let t, _): return .table(id: id, table, marginTop: t, marginBottom: margin)
        case .math(let id, let l, let t, _): return .math(id: id, latex: l, marginTop: t, marginBottom: margin)
        case .image(let id, let u, let a, let t, _): return .image(id: id, url: u, alt: a, marginTop: t, marginBottom: margin)
        case .text: return segment
        }
    }

    /// A cell's text as the single block of its own text view.
    private static func tableBlock(_ content: NSAttributedString, style: InlineStyle, typography: Typography, alignment: MarkdownTable.Alignment, fixedLineHeight: Bool) -> NSAttributedString {
        let metrics = style.metrics(typography)
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineBreakMode = .byWordWrapping
        paragraph.minimumLineHeight = metrics.lineHeight
        paragraph.maximumLineHeight = fixedLineHeight ? metrics.lineHeight : 0
        switch alignment {
        case .left: paragraph.alignment = .left
        case .center: paragraph.alignment = .center
        case .right: paragraph.alignment = .right
        }
        let block = NSMutableAttributedString(attributedString: content)
        let full = NSRange(location: 0, length: block.length)
        block.addAttribute(.paragraphStyle, value: paragraph, range: full)
        block.addAttribute(.baselineOffset, value: metrics.baselineOffset, range: full)
        return block
    }

    private static func paragraphCopy(_ style: NSParagraphStyle) -> NSMutableParagraphStyle {
        (style.mutableCopy() as? NSMutableParagraphStyle) ?? NSMutableParagraphStyle()
    }

    private static func paragraphFallback(_ text: String, _ typography: Typography) -> NSAttributedString {
        NSAttributedString(string: text, attributes: [.font: DSFont.ui(typography.paragraphSize), .foregroundColor: AppTheme.UI.textPrimary])
    }

    private static func collectLeaves(_ document: AttributedString) -> [Leaf] {
        var leaves: [Leaf] = []
        var currentId: Int?
        for run in document.runs {
            let slice = AttributedString(document[run.range])
            guard let intent = run.presentationIntent else {
                // Raw HTML blocks: react-markdown (no rehype-raw) shows them as text.
                if run.inlinePresentationIntent?.contains(.blockHTML) == true {
                    let id = (leaves.last?.id ?? 0) - 1
                    leaves.append(Leaf(kind: .html, id: id, containers: [], runs: slice))
                    currentId = id
                }
                continue
            }
            let components = intent.components
            guard let first = components.first else { continue }
            if first.identity == currentId, !leaves.isEmpty {
                leaves[leaves.count - 1].runs.append(slice)
                continue
            }
            currentId = first.identity
            let containers = Array(components.dropFirst())
            switch first.kind {
            case .paragraph:
                leaves.append(Leaf(kind: .paragraph, id: first.identity, containers: containers, runs: slice))
            case .header(let level):
                leaves.append(Leaf(kind: .header(level), id: first.identity, containers: containers, runs: slice))
            case .codeBlock(let language):
                leaves.append(Leaf(kind: .code(language), id: first.identity, containers: containers, runs: slice))
            case .thematicBreak:
                leaves.append(Leaf(kind: .rule, id: first.identity, containers: containers, runs: slice))
            case .tableCell(let column):
                var row = 0
                var tableId = 0
                var alignments: [MarkdownTable.Alignment] = []
                for c in containers {
                    switch c.kind {
                    case .tableHeaderRow: row = 0
                    case .tableRow(let index): row = index
                    case .table(let columns):
                        tableId = c.identity
                        alignments = columns.map {
                            switch $0.alignment {
                            case .center: return .center
                            case .right: return .right
                            default: return .left
                            }
                        }
                    default: break
                    }
                }
                leaves.append(Leaf(kind: .tableCell(row: row, col: column, tableId: tableId, alignments: alignments), id: first.identity, containers: containers, runs: slice))
            default:
                leaves.append(Leaf(kind: .paragraph, id: first.identity, containers: containers, runs: slice))
            }
        }
        return leaves
    }

    private static func quoteIds(_ leaf: Leaf) -> Set<Int> {
        Set(leaf.containers.compactMap { if case .blockQuote = $0.kind { return $0.identity }; return nil })
    }

    private static func isFirstInQuote(_ leaves: [Leaf], _ index: Int) -> Bool {
        guard index > 0 else { return true }
        return quoteIds(leaves[index]).isDisjoint(with: quoteIds(leaves[index - 1]))
    }

    private static func isLastInQuote(_ leaves: [Leaf], _ index: Int) -> Bool {
        guard index + 1 < leaves.count else { return true }
        return quoteIds(leaves[index]).isDisjoint(with: quoteIds(leaves[index + 1]))
    }

    private static func itemId(_ leaf: Leaf) -> Int? {
        for c in leaf.containers { if case .listItem = c.kind { return c.identity } }
        return nil
    }

    private static func isFirstLeafOfItem(_ leaves: [Leaf], _ index: Int) -> Bool {
        guard let id = itemId(leaves[index]) else { return false }
        guard index > 0 else { return true }
        let previous = leaves[index - 1].containers.contains { $0.identity == id }
        return !previous
    }

    private static func isLastLeafOfItem(_ leaves: [Leaf], _ index: Int) -> Bool {
        guard let id = itemId(leaves[index]) else { return false }
        guard index + 1 < leaves.count else { return true }
        return !leaves[index + 1].containers.contains { $0.identity == id }
    }

    private static func isList(_ intent: PresentationIntent.IntentType) -> Bool {
        switch intent.kind {
        case .orderedList, .unorderedList: return true
        default: return false
        }
    }

    /// The last leaf of a list that isn't inside another one.
    private static func endsOutermostList(_ leaves: [Leaf], _ index: Int) -> Bool {
        guard let outermost = leaves[index].containers.last(where: isList) else { return false }
        guard index + 1 < leaves.count else { return true }
        return !leaves[index + 1].containers.contains { $0.identity == outermost.identity }
    }

    private static func listDepth(_ containers: [PresentationIntent.IntentType]) -> Int {
        containers.filter(isList).count
    }

    private static func marker(for containers: [PresentationIntent.IntentType], metrics: InlineStyle.Metrics, style: InlineStyle, typography: Typography) -> MarkdownMarker {
        var depth = 0
        var kind: MarkdownMarker.Kind?
        var ordinal = 1
        for c in containers {
            switch c.kind {
            case .listItem(let value):
                if kind == nil { ordinal = value }
            case .orderedList:
                if kind == nil { kind = .ordinal("\(ordinal).") } else { depth += 1 }
            case .unorderedList:
                if kind == nil { kind = .disc } else { depth += 1 }
            default: break
            }
        }
        var resolved = kind ?? .disc
        if case .disc = resolved {
            resolved = depth == 0 ? .disc : (depth == 1 ? .circle : .square)
        }
        // `::marker` takes the li's font (16px in a card) even when a loose item's <p> is 16.8.
        return MarkdownMarker(kind: resolved, font: DSFont.ui(typography.listItemSize), color: style.color, baselineFromTop: metrics.baselineFromTop)
    }

    // MARK: - Inline

    enum InlineStyle {
        case paragraph, listItem, heading(Int), tableHeader, tableCell
        indirect case quote(InlineStyle)

        struct Metrics {
            let font: UIFont
            let lineHeight: CGFloat
            let baselineOffset: CGFloat
            let baselineFromTop: CGFloat
        }

        var quoted: InlineStyle { .quote(self) }

        var isQuoted: Bool { if case .quote = self { return true }; return false }

        var base: InlineStyle { if case .quote(let inner) = self { return inner }; return self }

        func size(_ typography: Typography) -> CGFloat {
            switch base {
            case .paragraph: return typography.paragraphSize
            case .listItem: return typography.listItemSize
            case .heading(let level):
                return typography.headingBase * [2, 1.5, 1.17, 1, 0.83, 0.67][max(0, min(5, level - 1))]
            case .tableHeader, .tableCell: return 15.2
            case .quote: return typography.paragraphSize
            }
        }

        var weight: CGFloat {
            switch base {
            case .heading: return 700
            case .tableHeader: return 600
            default: return 400
            }
        }

        var color: UIColor { isQuoted ? AppTheme.UI.textSecondary : AppTheme.UI.textPrimary }

        func metrics(_ typography: Typography) -> Metrics {
            let size = size(typography)
            let font = DSFont.ui(size, weight: weight, italic: isQuoted)
            let box = WebLineBox(font: font, lineHeight: DSFont.scaledSize(size * typography.lineHeight))
            // TextKit rests the descender on the bottom of a fixed line box.
            return Metrics(font: font, lineHeight: box.height, baselineOffset: box.height + font.descender - box.baseline, baselineFromTop: box.baseline)
        }
    }

    static func inlineString(_ runs: AttributedString, style: InlineStyle, maths: [String] = [], typography: Typography = .card) -> NSAttributedString {
        let out = NSMutableAttributedString()
        let base = style
        let metrics = style.metrics(typography)
        for run in runs.runs {
            var text = String(runs[run.range].characters)
            let intent = run.inlinePresentationIntent ?? []
            if intent.contains(.lineBreak) { text = "\u{2028}" }
            if intent.contains(.softBreak) { text = " " }

            if text.contains(mathOpen) {
                appendMath(text, to: out, style: base, maths: maths, typography: typography)
                continue
            }

            var attributes: [NSAttributedString.Key: Any] = [:]
            let bold = intent.contains(.stronglyEmphasized)
            let italic = intent.contains(.emphasized) || base.isQuoted
            attributes[.foregroundColor] = base.color

            if intent.contains(.code) {
                let codeFont = DSFont.uiMono(15.2)
                attributes[.font] = codeFont
                attributes[.mdInlineCode] = InlineCodeBox(baselineFromTop: metrics.baselineFromTop, font: codeFont, parentLineHeight: metrics.lineHeight, lineHeight: typography.lineHeight)
                // The kern on a word joiner is padding that wraps onto the next line with the code.
                // A word joiner also forbids the break after a preceding space, except that a
                // zero-width space always gets its break.
                if let last = out.string.last, last.isWhitespace {
                    out.append(NSAttributedString(string: "\u{200B}", attributes: out.attributes(at: out.length - 1, effectiveRange: nil)))
                }
                let piece = NSMutableAttributedString(string: "\u{2060}" + text.webHyphenBreakable, attributes: attributes)
                piece.addAttribute(.kern, value: InlineCodeBox.paddingX, range: NSRange(location: 0, length: 1))
                piece.addAttribute(.kern, value: InlineCodeBox.paddingX, range: NSRange(location: piece.length - 1, length: 1))
                out.append(piece)
                continue
            }

            attributes[.font] = DSFont.ui(base.size(typography), weight: bold ? max(700, base.weight) : base.weight, italic: italic)
            if intent.contains(.strikethrough) {
                attributes[.strikethroughStyle] = NSUnderlineStyle.single.rawValue
                attributes[.strikethroughColor] = base.color
            }
            if let link = run.link {
                attributes[.link] = link
                attributes[.underlineStyle] = NSUnderlineStyle.single.rawValue
            }
            out.append(NSAttributedString(string: text.webHyphenBreakable, attributes: attributes))
        }
        return out
    }

    private static func appendMath(_ text: String, to out: NSMutableAttributedString, style: InlineStyle, maths: [String], typography: Typography) {
        let ns = text as NSString
        let regex = try! NSRegularExpression(pattern: "\(mathOpen)[DI](\\d+)\(mathClose)")
        var cursor = 0
        let attributes: [NSAttributedString.Key: Any] = [.font: DSFont.ui(style.size(typography), weight: style.weight, italic: style.isQuoted), .foregroundColor: style.color]
        for match in regex.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
            out.append(NSAttributedString(string: ns.substring(with: NSRange(location: cursor, length: match.range.location - cursor)), attributes: attributes))
            if let index = Int(ns.substring(with: match.range(at: 1))), index < maths.count {
                out.append(MathRenderer.inlineAttachment(latex: maths[index], fontSize: style.size(typography)))
            }
            cursor = match.range.location + match.range.length
        }
        out.append(NSAttributedString(string: ns.substring(from: cursor), attributes: attributes))
    }
}

/// Attribute value carrying what the layout manager needs to draw an inline-code chip.
final class InlineCodeBox: NSObject {
    /// `padding: 0.2rem 0.4rem`.
    static let paddingX = LayoutUnit.truncating(6.4)
    static let paddingY = LayoutUnit.truncating(3.2)

    let baselineFromTop: CGFloat
    let font: UIFont
    let growsLineAbove: CGFloat
    let growsLineBelow: CGFloat

    init(baselineFromTop: CGFloat, font: UIFont, parentLineHeight: CGFloat, lineHeight: CGFloat = 1.7) {
        self.baselineFromTop = baselineFromTop
        self.font = font
        let own = WebLineBox(font: font, lineHeight: font.pointSize * lineHeight)
        growsLineAbove = max(0, own.baseline - baselineFromTop)
        growsLineBelow = max(0, (own.height - own.baseline) - (parentLineHeight - baselineFromTop))
    }
}
