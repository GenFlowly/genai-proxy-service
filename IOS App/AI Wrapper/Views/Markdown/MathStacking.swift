import CoreGraphics
import Foundation
import SwiftMath

/// `\underbrace`, `\overbrace`, `\underset`, `\overset` and `\stackrel`, which KaTeX
/// renders and SwiftMath can't parse. `prepare` swaps each command for a sentinel
/// `\colorbox` SwiftMath does parse; `restructure` then turns the parsed list into a
/// table of the formula's own row, left untouched so its baseline and spacing hold,
/// plus label rows over and under it, each label shifted by measured space until it
/// is centred on its base. The braces themselves are not drawn.
enum MathStacking {
    /// Width in points of a list as SwiftMath typesets it.
    typealias Measure = (MTMathList) -> CGFloat

    private enum Kind: String {
        case underBrace = "mathstackunderbrace"
        case overBrace = "mathstackoverbrace"
        case underSet = "mathstackunderset"
        case overSet = "mathstackoverset"

        var below: Bool { self == .underBrace || self == .underSet }
    }

    /// `\underset{label}{base}` keeps its two arguments as a fraction's numerator and
    /// denominator, the only two-argument container SwiftMath parses.
    private static let replacements: [String: String] = [
        "underbrace": "\\colorbox{\(Kind.underBrace.rawValue)}",
        "overbrace": "\\colorbox{\(Kind.overBrace.rawValue)}",
        "underset": "\\colorbox{\(Kind.underSet.rawValue)}\\frac",
        "overset": "\\colorbox{\(Kind.overSet.rawValue)}\\frac",
        "stackrel": "\\colorbox{\(Kind.overSet.rawValue)}\\frac",
    ]

    /// The LaTeX with every stacking command replaced, or nil when it has none.
    static func prepare(_ latex: String) -> String? {
        var out = ""
        var changed = false
        var index = latex.startIndex
        while index < latex.endIndex {
            guard latex[index] == "\\" else {
                out.append(latex[index])
                index = latex.index(after: index)
                continue
            }
            let nameStart = latex.index(after: index)
            var nameEnd = nameStart
            while nameEnd < latex.endIndex, latex[nameEnd].isASCII, latex[nameEnd].isLetter {
                nameEnd = latex.index(after: nameEnd)
            }
            if nameEnd == nameStart {
                let end = nameEnd < latex.endIndex ? latex.index(after: nameEnd) : nameEnd
                out += latex[index..<end]
                index = end
                continue
            }
            if let replacement = replacements[String(latex[nameStart..<nameEnd])] {
                out += replacement
                changed = true
            } else {
                out += latex[index..<nameEnd]
            }
            index = nameEnd
        }
        return changed ? out : nil
    }

    /// Label rows around the formula's own row, when the top level became a table.
    struct Outcome {
        var rowsAbove = 0
        var rowsBelow = 0
    }

    /// Rebuilds, in place, a list parsed from `prepare`'s output. Returns nil when a
    /// sentinel can't be resolved; the list must not be rendered then.
    static func restructure(_ list: MTMathList, style: MTLineStyle, measure: @escaping Measure) -> Outcome? {
        // SwiftMath's mathListToString, which MTMathUILabel runs on every list it is
        // given, deletes the first atom of matrix and aligned cells; the typesetter
        // never reads the environment name, so clearing it disarms that.
        forEachList(in: list) { inner in
            for case let table as MTMathTable in inner.atoms { table.environment = "" }
        }
        var builder = Builder(measure: measure)
        builder.rebuild(list, style: style, top: true)
        var leftover = false
        forEachList(in: list) { inner in
            leftover = leftover || inner.atoms.contains { ($0 as? MTMathColorbox).flatMap { Kind(rawValue: $0.colorString) } != nil }
        }
        return builder.resolved && !leftover ? builder.outcome : nil
    }

    private struct Note {
        var start: Int
        var end: Int
        var label: [MTMathAtom]
        var below: Bool
        var level: Int
        var style: MTLineStyle
    }

    private struct Placed {
        var x: CGFloat
        var width: CGFloat
        var note: Note
    }

    private struct LabelRows {
        var above: [MTMathList] = []
        var below: [MTMathList] = []
        var lead: [MTMathAtom] = []
    }

    private struct Builder {
        let measure: Measure
        var resolved = true
        var outcome = Outcome()
        private var muWidths: [MTLineStyle: CGFloat] = [:]

        init(measure: @escaping Measure) {
            self.measure = measure
        }

        func measured(_ atoms: [MTMathAtom], _ style: MTLineStyle) -> CGFloat {
            measure(MTMathList(atoms: [MathStacking.styleAtom(style)] + atoms))
        }

        /// A free-standing list: when it holds labels it becomes a one-column table.
        mutating func rebuild(_ list: MTMathList, style: MTLineStyle, top: Bool = false) {
            let (content, notes) = flatten(list.atoms, style: style)
            guard !notes.isEmpty else {
                list.atoms = content
                return
            }
            let rows = labelRows(content: content, notes: notes, style: style, rowStyle: style, width: nil)
            var cells = rows.above.reversed().map { [$0] }
            cells.append([MTMathList(atoms: rows.lead + content)])
            cells += rows.below.map { [$0] }
            var error: NSError?
            guard let table = MTMathAtomFactory.table(withEnvironment: nil, rows: cells, error: &error) as? MTMathTable else {
                resolved = false
                return
            }
            table.interRowAdditionalSpacing = 0
            list.atoms = [table]
            if top { outcome = Outcome(rowsAbove: rows.above.count, rowsBelow: rows.below.count) }
        }

        /// A table's cells keep their rows; labels go into new rows of the same table
        /// so every cell of a row stays on one baseline.
        mutating func rebuildTable(_ table: MTMathTable, style: MTLineStyle) {
            var rows: [[MTMathList]] = []
            for row in table.cells {
                var above: [[Int: MTMathList]] = []
                var below: [[Int: MTMathList]] = []
                for (column, cell) in row.enumerated() {
                    let (content, notes) = flatten(cell.atoms, style: style)
                    cell.atoms = content
                    guard !notes.isEmpty else { continue }
                    let cellStyle = (content.first as? MTMathStyle)?.style ?? style
                    let width = measured(content, style)
                    let labels = labelRows(content: content, notes: notes, style: style, rowStyle: cellStyle, width: width)
                    for (level, list) in labels.above.enumerated() {
                        if above.count <= level { above.append([:]) }
                        above[level][column] = list
                    }
                    for (level, list) in labels.below.enumerated() {
                        if below.count <= level { below.append([:]) }
                        below[level][column] = list
                    }
                }
                let fill = { (lists: [Int: MTMathList]) in (0..<row.count).map { lists[$0] ?? MTMathList() } }
                rows += above.reversed().map(fill)
                rows.append(row)
                rows += below.map(fill)
            }
            table.cells = rows
        }

        /// Splices each sentinel's base into the line and records its label.
        mutating func flatten(_ atoms: [MTMathAtom], style: MTLineStyle) -> ([MTMathAtom], [Note]) {
            var content: [MTMathAtom] = []
            var notes: [Note] = []
            var current = style
            var index = 0
            while index < atoms.count {
                let atom = atoms[index]
                index += 1
                if let change = atom as? MTMathStyle { current = change.style }
                guard let box = atom as? MTMathColorbox, let kind = Kind(rawValue: box.colorString) else {
                    descend(atom, style: current)
                    content.append(atom)
                    continue
                }
                var base: [MTMathAtom] = []
                var label: [MTMathAtom] = []
                switch kind {
                case .underBrace, .overBrace:
                    base = box.innerList?.atoms ?? []
                    // A colorbox takes no scripts, so SwiftMath hangs the brace's label
                    // on an empty atom right after it.
                    if index < atoms.count, atoms[index].type == .ordinary, atoms[index].nucleus.isEmpty {
                        let holder = atoms[index]
                        if kind.below, let script = holder.subScript {
                            label = script.atoms
                            holder.subScript = nil
                        } else if !kind.below, let script = holder.superScript {
                            label = script.atoms
                            holder.superScript = nil
                        }
                        if holder.subScript == nil, holder.superScript == nil { index += 1 }
                    }
                case .underSet, .overSet:
                    guard let parts = box.innerList?.atoms, parts.count == 1, let fraction = parts[0] as? MTFraction else {
                        resolved = false
                        continue
                    }
                    label = fraction.numerator?.atoms ?? []
                    base = fraction.denominator?.atoms ?? []
                }
                let (inner, innerNotes) = flatten(base, style: current)
                let start = content.count
                content += inner
                notes += innerNotes.map { note in
                    var note = note
                    note.start += start
                    note.end += start
                    return note
                }
                guard !label.isEmpty else { continue }
                let labelList = MTMathList(atoms: label)
                rebuild(labelList, style: MathStacking.script(current))
                let nested = innerNotes.filter { $0.below == kind.below }.map(\.level).max() ?? 0
                notes.append(Note(start: start, end: content.count, label: labelList.atoms, below: kind.below, level: nested + 1, style: current))
            }
            return (content, notes)
        }

        mutating func descend(_ atom: MTMathAtom, style: MTLineStyle) {
            if let table = atom as? MTMathTable { rebuildTable(table, style: style) }
            for (list, childStyle) in MathStacking.children(of: atom, style: style) {
                rebuild(list, style: childStyle)
            }
        }

        /// One row per side and nesting level, nearest the formula first. With a
        /// `width` the rows are padded to it, so the column's alignment can't move them.
        mutating func labelRows(content: [MTMathAtom], notes: [Note], style: MTLineStyle, rowStyle: MTLineStyle, width: CGFloat?) -> LabelRows {
            let probe = { MTMathAtomFactory.atom(forCharacter: "x")! }
            let placed = notes.map { note -> Placed in
                let start = note.start == 0 ? 0 : measured(Array(content[..<note.start]) + [probe()], style) - measured([probe()], note.style)
                let end = max(start, measured(Array(content[..<note.end]), style))
                let labelWidth = measured(note.label, MathStacking.script(note.style))
                return Placed(x: (start + end - labelWidth) / 2, width: labelWidth, note: note)
            }
            let gap = 6 * mu(rowStyle)
            var groups: [(below: Bool, items: [Placed])] = []
            for below in [true, false] {
                let side = placed.filter { $0.note.below == below }
                for level in 1...max(1, side.map(\.note.level).max() ?? 0) {
                    var items: [Placed] = []
                    for var item in side.filter({ $0.note.level == level }).sorted(by: { $0.x < $1.x }) {
                        if let width { item.x = min(max(item.x, 0), max(0, width - item.width)) }
                        if let last = items.last { item.x = max(item.x, last.x + last.width + gap) }
                        items.append(item)
                    }
                    if !items.isEmpty { groups.append((below, items)) }
                }
            }
            let shift = width == nil ? max(0, -(placed.map(\.x).min() ?? 0)) : 0
            var rows = LabelRows()
            if shift > 0.01 { rows.lead = [space(shift, rowStyle)] }
            for group in groups {
                var atoms: [MTMathAtom] = [MathStacking.styleAtom(rowStyle)]
                var cursor: CGFloat = 0
                for item in group.items {
                    let x = item.x + shift
                    if abs(x - cursor) > 0.01 { atoms.append(space(x - cursor, rowStyle)) }
                    atoms.append(MathStacking.styleAtom(MathStacking.script(item.note.style)))
                    atoms += item.note.label
                    atoms.append(MathStacking.styleAtom(rowStyle))
                    cursor = x + item.width
                }
                if let width, cursor < width - 0.01 {
                    atoms.append(space(width - cursor, rowStyle))
                    atoms.append(MathStacking.widthMarker())
                }
                if group.below { rows.below.append(MTMathList(atoms: atoms)) } else { rows.above.append(MTMathList(atoms: atoms)) }
            }
            return rows
        }

        /// Points per mu in `style`.
        mutating func mu(_ style: MTLineStyle) -> CGFloat {
            if let cached = muWidths[style] { return cached }
            let probe = { MTMathAtomFactory.atom(forCharacter: "x")! }
            let quad = MTMathAtomFactory.atom(forLatexSymbol: "quad") as! MTMathSpace
            let value = max(0.01, (measured([quad, probe()], style) - measured([probe()], style)) / quad.space)
            muWidths[style] = value
            return value
        }

        mutating func space(_ points: CGFloat, _ style: MTLineStyle) -> MTMathAtom {
            let atom = MTMathAtomFactory.atom(forLatexSymbol: ",") as! MTMathSpace
            atom.space = points / mu(style)
            return atom
        }
    }

    private static func styleAtom(_ style: MTLineStyle) -> MTMathAtom {
        let atom = MTMathAtomFactory.atom(forLatexSymbol: "displaystyle") as! MTMathStyle
        atom.style = style
        return atom
    }

    /// An empty colour group: invisible, but SwiftMath counts its position in a line's
    /// width, which a trailing space alone doesn't reach.
    private static func widthMarker() -> MTMathAtom {
        MTMathListBuilder.build(fromString: "\\color{#000000}{}")!.atoms[0]
    }

    private static func script(_ style: MTLineStyle) -> MTLineStyle {
        style == .display || style == .text ? .script : .scriptOfScript
    }

    private static func fraction(_ style: MTLineStyle) -> MTLineStyle {
        switch style {
        case .display: return .text
        case .text: return .script
        default: return .scriptOfScript
        }
    }

    /// Every list an atom holds, other than table cells, with the style it is set in.
    private static func children(of atom: MTMathAtom, style: MTLineStyle) -> [(MTMathList, MTLineStyle)] {
        var lists: [(MTMathList, MTLineStyle)] = []
        if let list = atom.superScript { lists.append((list, script(style))) }
        if let list = atom.subScript { lists.append((list, script(style))) }
        switch atom {
        case let fraction as MTFraction:
            for list in [fraction.numerator, fraction.denominator].compactMap({ $0 }) {
                lists.append((list, Self.fraction(style)))
            }
        case let radical as MTRadical:
            if let list = radical.radicand { lists.append((list, style)) }
            if let list = radical.degree { lists.append((list, .scriptOfScript)) }
        case let inner as MTInner:
            if let list = inner.innerList { lists.append((list, style)) }
        case let line as MTOverLine:
            if let list = line.innerList { lists.append((list, style)) }
        case let line as MTUnderLine:
            if let list = line.innerList { lists.append((list, style)) }
        case let accent as MTAccent:
            if let list = accent.innerList { lists.append((list, style)) }
        case let color as MTMathColor:
            if let list = color.innerList { lists.append((list, style)) }
        case let color as MTMathTextColor:
            if let list = color.innerList { lists.append((list, style)) }
        case let box as MTMathColorbox:
            if let list = box.innerList { lists.append((list, style)) }
        default:
            break
        }
        return lists
    }

    private static func forEachList(in list: MTMathList, _ body: (MTMathList) -> Void) {
        body(list)
        for atom in list.atoms {
            if let table = atom as? MTMathTable {
                for row in table.cells { for cell in row { forEachList(in: cell, body) } }
            }
            for (child, _) in children(of: atom, style: .display) { forEachList(in: child, body) }
        }
    }
}
