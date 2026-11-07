import UIKit
import JavaScriptCore

/// The web's prompt editor is CodeMirror, so its colors come from real grammars and its typing
/// behavior from real commands. This runs those same packages (`composerengine` data asset, built
/// by `Tools/composer-engine`) rather than approximating them.
///
/// The JS context stays on one serial queue. Loading it takes long enough to notice, so a keystroke
/// that arrives first is treated as a plain edit instead of waiting.
nonisolated final class ComposerEngine: @unchecked Sendable {
    static let shared = ComposerEngine()

    /// Same cases and order as `colors` in `Tools/composer-engine/entry.js`.
    enum TokenColor: Int, CaseIterable {
        case comment, variable, entity, keyword, string, accent, red, list, heading, regexp, literal, link, fg, tag, constant
    }

    struct Run: Equatable {
        let range: NSRange
        let color: TokenColor?
        let bold: Bool
        let underline: Bool
    }

    struct Edit: Decodable {
        struct Change: Decodable {
            let from: Int
            let to: Int
            let insert: String
        }

        let changes: [Change]
        let anchor: Int
        let head: Int
    }

    struct BracketMark: Decodable, Equatable {
        let from: Int
        let to: Int
        let matched: Bool
    }

    struct Completion: Decodable, Equatable {
        let label: String
        let type: String
        let detail: String
        /// Pairs of start and end offsets into `label`.
        let matched: [Int]
    }

    struct CompletionList: Decodable, Equatable {
        /// Where the text being completed starts, which is what the popup lines up with.
        let from: Int
        let options: [Completion]
    }

    private let queue = DispatchQueue(label: "composer-engine", qos: .userInitiated)
    private let lock = NSLock()
    private var context: JSContext?
    private var api: JSValue?
    private var isReady = false
    private var generations: [String: Int] = [:]

    private init() {
        queue.async { [self] in load() }
    }

    private func load() {
        guard let data = NSDataAsset(name: "composerengine")?.data,
              let source = String(data: data, encoding: .utf8),
              let context = JSContext() else { return }
        context.exceptionHandler = { _, exception in
            let message = exception?.toString() ?? ""
            DispatchQueue.main.async {
                AppObservability.capture(ComposerEngineError(message: message), context: ["where": "composerEngine"])
            }
        }
        context.evaluateScript(source)
        let api = context.objectForKeyedSubscript("ComposerEngine")
        guard let api, !api.isUndefined else { return }
        self.context = context
        self.api = api
        lock.withLock { isReady = true }
    }

    private var ready: Bool { lock.withLock { isReady } }

    private func decode<T: Decodable>(_ type: T.Type, from json: String?) -> T? {
        guard let data = json?.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode(type, from: data)
    }

    /// `nil` unless the result is a string: JS `null` means the editor had nothing to add.
    private func string(_ value: JSValue?) -> String? {
        guard let value, value.isString else { return nil }
        return value.toString()
    }

    private func newestGeneration(for id: String) -> Int {
        lock.withLock {
            generations[id, default: 0] += 1
            return generations[id, default: 0]
        }
    }

    private func isNewest(_ generation: Int, for id: String) -> Bool {
        lock.withLock { generations[id] == generation }
    }

    /// Colored runs for the text. Only the newest request per editor does the work, and the
    /// completion runs on the main thread, possibly more than once when a fenced language loads.
    func highlight(id: String, text: String, completion: @escaping @Sendable ([Run]) -> Void) {
        let generation = newestGeneration(for: id)
        queue.async { [self] in
            guard isNewest(generation, for: id), let api, let context else { return }
            let callback: @convention(block) (String) -> Void = { json in
                let runs = Self.runs(fromJSON: json)
                DispatchQueue.main.async { completion(runs) }
            }
            api.invokeMethod("highlight", withArguments: [id, text, JSValue(object: callback, in: context) as Any])
        }
    }

    private static func runs(fromJSON json: String) -> [Run] {
        guard let data = json.data(using: .utf8),
              let flat = try? JSONDecoder().decode([Int].self, from: data) else { return [] }
        var runs: [Run] = []
        runs.reserveCapacity(flat.count / 5)
        var index = 0
        while index + 4 < flat.count {
            runs.append(Run(
                range: NSRange(location: flat[index], length: flat[index + 1] - flat[index]),
                color: TokenColor(rawValue: flat[index + 2]),
                bold: flat[index + 3] == 1,
                underline: flat[index + 4] == 1
            ))
            index += 5
        }
        return runs
    }

    /// A keyboard edit. Returns what to apply when the editor does more than the plain edit (a
    /// closing bracket, list markup, indentation), otherwise nil and the text view does it.
    func input(id: String, text: String, selection: NSRange, range: NSRange, insert: String) -> Edit? {
        guard ready else { return nil }
        return queue.sync {
            let result = api?.invokeMethod("input", withArguments: [
                id, text, selection.location, selection.upperBound, range.location, range.upperBound, insert
            ])
            return decode(Edit.self, from: string(result))
        }
    }

    func brackets(id: String, text: String, selection: NSRange, completion: @escaping @Sendable ([BracketMark]) -> Void) {
        queue.async { [self] in
            let result = api?.invokeMethod("brackets", withArguments: [id, text, selection.location, selection.upperBound])
            let marks = decode([BracketMark].self, from: string(result)) ?? []
            DispatchQueue.main.async { completion(marks) }
        }
    }

    func pasteLink(id: String, text: String, selection: NSRange, pasted: String) -> Edit? {
        guard ready else { return nil }
        return queue.sync {
            let result = api?.invokeMethod("pasteLink", withArguments: [id, text, selection.location, selection.upperBound, pasted])
            return decode(Edit.self, from: string(result))
        }
    }

    func completions(id: String, text: String, position: Int, completion: @escaping @Sendable (CompletionList) -> Void) {
        queue.async { [self] in
            guard let api, let context else { return }
            let callback: @convention(block) (String) -> Void = { [self] json in
                let list = decode(CompletionList.self, from: json) ?? CompletionList(from: position, options: [])
                DispatchQueue.main.async { completion(list) }
            }
            api.invokeMethod("completions", withArguments: [id, text, position, JSValue(object: callback, in: context) as Any])
        }
    }

    func applyCompletion(id: String, text: String, selection: NSRange, index: Int) -> Edit? {
        guard ready else { return nil }
        return queue.sync {
            let result = api?.invokeMethod("applyCompletion", withArguments: [id, text, selection.location, selection.upperBound, index])
            return decode(Edit.self, from: string(result))
        }
    }

    func close(id: String) {
        lock.withLock { _ = generations.removeValue(forKey: id) }
        queue.async { [self] in
            api?.invokeMethod("close", withArguments: [id])
        }
    }
}

private nonisolated struct ComposerEngineError: Error {
    let message: String
}

extension ComposerEngine.TokenColor {
    /// `--color-prettylights-syntax-*` from `@uiw/react-markdown-preview/markdown.css`, as the
    /// theme in `@uiw/react-markdown-editor` assigns them.
    var uiColor: UIColor {
        switch self {
        case .comment: return AppTheme.UI.dynamic(light: "#6E7781", dark: "#8B949E")
        case .variable: return AppTheme.UI.dynamic(light: "#953800", dark: "#FFA657")
        case .entity: return AppTheme.UI.dynamic(light: "#8250DF", dark: "#D2A8FF")
        case .keyword: return AppTheme.UI.dynamic(light: "#CF222E", dark: "#FF7B72")
        case .string: return AppTheme.UI.dynamic(light: "#0A3069", dark: "#A5D6FF")
        case .accent: return AppTheme.UI.dynamic(light: "#0969DA", dark: "#1F6FEB")
        case .red: return UIColor(red: 1, green: 0, blue: 0, alpha: 1)
        case .list: return AppTheme.UI.dynamic(light: "#3B2300", dark: "#F2CC60")
        case .heading: return AppTheme.UI.dynamic(light: "#0550AE", dark: "#1F6FEB")
        case .regexp: return AppTheme.UI.dynamic(light: "#116329", dark: "#7EE787")
        case .literal: return AppTheme.UI.composerText
        case .link: return AppTheme.UI.dynamic(light: "#0A3069", dark: "#A5D6FF")
        case .fg: return AppTheme.UI.composerText
        case .tag: return AppTheme.UI.dynamic(light: "#116329", dark: "#7EE787")
        case .constant: return AppTheme.UI.dynamic(light: "#0550AE", dark: "#79C0FF")
        }
    }
}

/// Paints CodeMirror's decorations under the text: `.cm-matchingBracket`, `.cm-nonmatchingBracket`
/// and `.cm-selectionMatch`. They're display state, so they stay out of the text's attributes.
final class ComposerLayoutManager: NSLayoutManager {
    struct Mark: Equatable {
        let range: NSRange
        let color: UIColor
    }

    var marks: [Mark] = [] {
        didSet {
            guard marks != oldValue, let length = textStorage?.length, length > 0 else { return }
            invalidateDisplay(forCharacterRange: NSRange(location: 0, length: length))
        }
    }

    override func drawBackground(forGlyphRange glyphsToShow: NSRange, at origin: CGPoint) {
        super.drawBackground(forGlyphRange: glyphsToShow, at: origin)
        guard let container = textContainers.first, let length = textStorage?.length else { return }
        for mark in marks where mark.range.upperBound <= length {
            let glyphs = glyphRange(forCharacterRange: mark.range, actualCharacterRange: nil)
            guard NSIntersectionRange(glyphs, glyphsToShow).length > 0 else { continue }
            mark.color.setFill()
            enumerateEnclosingRects(
                forGlyphRange: glyphs,
                withinSelectedGlyphRange: NSRange(location: NSNotFound, length: 0),
                in: container
            ) { rect, _ in
                UIRectFillUsingBlendMode(rect.offsetBy(dx: origin.x, dy: origin.y), .normal)
            }
        }
    }
}

/// By default a drag that starts on a control stays with it, so a slow one would pick the row
/// instead of scrolling the list.
private final class ListScrollView: UIScrollView {
    override func touchesShouldCancel(in view: UIView) -> Bool { true }
}

/// `.cm-tooltip-autocomplete`, in the window like the web's, which lives under `<body>`.
final class ComposerCompletionPopup: UIView {
    private static let font = DSFont.uiMono(24)
    private static let iconFont = DSFont.uiMono(21.6)
    private static let rowHeight = (DSFont.scaledSize(24) * 1.2 * 64).rounded(.down) / 64 + 2
    private static let minimumWidth: CGFloat = 250
    private static let maximumHeight: CGFloat = 240
    private static let selectedBackground = UIColor(hex: "#1177CC")
    private static let background = AppTheme.UI.dynamic(light: "#FFFFFF", dark: "#2C2C2E")
    private static let border = AppTheme.UI.dynamic(light: "#CFCFCE", dark: "#48484A")
    private static let text = AppTheme.UI.dynamic(light: "#2C2C2C", dark: "#FFFFFF")

    private let scrollView = ListScrollView()
    private var rows: [UIView] = []
    private var contentWidth: CGFloat = minimumWidth
    private var onPick: ((Int) -> Void)?

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = Self.background
        layer.borderWidth = 1
        addSubview(scrollView)
        scrollView.showsHorizontalScrollIndicator = false
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        layer.borderColor = Self.border.resolvedColor(with: traitCollection).cgColor
    }

    /// The glyph `baseTheme` draws after `.cm-completionIcon-<type>`.
    private static func icon(for type: String) -> String {
        switch type.split(separator: " ").first.map(String.init) {
        case "function", "method": return "ƒ"
        case "class": return "○"
        case "interface": return "◌"
        case "variable": return "𝑥"
        case "constant": return "𝐶"
        case "type": return "𝑡"
        case "enum": return "∪"
        case "property": return "□"
        case "keyword": return "🔑\u{FE0E}"
        case "namespace": return "▢"
        case "text": return "abc"
        default: return ""
        }
    }

    private static func label(for option: ComposerEngine.Completion, color: UIColor) -> NSAttributedString {
        let text = NSMutableAttributedString(string: option.label, attributes: [.font: font, .foregroundColor: color])
        var index = 0
        while index + 1 < option.matched.count {
            let range = NSRange(location: option.matched[index], length: option.matched[index + 1] - option.matched[index])
            if range.upperBound <= text.length {
                text.addAttribute(.underlineStyle, value: NSUnderlineStyle.single.rawValue, range: range)
            }
            index += 2
        }
        if !option.detail.isEmpty {
            let detail = UIFontDescriptor(name: font.fontName, size: font.pointSize).withSymbolicTraits(.traitItalic)
            text.append(NSAttributedString(string: "\u{2003}\(option.detail)", attributes: [
                .font: detail.map { UIFont(descriptor: $0, size: font.pointSize) } ?? font,
                .foregroundColor: color
            ]))
        }
        return text
    }

    func show(_ options: [ComposerEngine.Completion], onPick: @escaping (Int) -> Void) {
        self.onPick = onPick
        rows.forEach { $0.removeFromSuperview() }
        rows = options.enumerated().map { index, option in makeRow(option, index: index, isSelected: index == 0) }
        rows.forEach(scrollView.addSubview)
        let widest = options.map { Self.rowWidth($0) }.max() ?? 0
        contentWidth = max(Self.minimumWidth, widest)
    }

    private static func rowWidth(_ option: ComposerEngine.Completion) -> CGFloat {
        ceil(label(for: option, color: .black).size().width) + iconColumn + 6
    }

    private static var iconColumn: CGFloat { iconFont.pointSize * 1.4 }

    private func makeRow(_ option: ComposerEngine.Completion, index: Int, isSelected: Bool) -> UIView {
        let color = isSelected ? UIColor.white : Self.text
        let row = UIControl()
        row.tag = index
        row.backgroundColor = isSelected ? Self.selectedBackground : .clear
        row.addTarget(self, action: #selector(pick(_:)), for: .touchUpInside)
        let icon = UILabel()
        icon.attributedText = NSAttributedString(string: Self.icon(for: option.type), attributes: [
            .font: Self.iconFont, .foregroundColor: color.withAlphaComponent(0.6)
        ])
        icon.textAlignment = .center
        icon.frame = CGRect(x: 3, y: 1, width: Self.iconFont.pointSize * 0.8, height: Self.rowHeight - 2)
        icon.isUserInteractionEnabled = false
        row.addSubview(icon)
        let label = UILabel()
        label.attributedText = Self.label(for: option, color: color)
        label.frame = CGRect(x: 3 + Self.iconColumn, y: 1, width: 10_000, height: Self.rowHeight - 2)
        label.isUserInteractionEnabled = false
        row.addSubview(label)
        return row
    }

    @objc private func pick(_ sender: UIControl) {
        onPick?(sender.tag)
    }

    var fittingSize: CGSize {
        let height = min(CGFloat(rows.count) * Self.rowHeight, Self.maximumHeight)
        return CGSize(width: contentWidth + 2, height: height + 2)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        scrollView.frame = bounds.insetBy(dx: 1, dy: 1)
        let width = scrollView.bounds.width
        for (index, row) in rows.enumerated() {
            row.frame = CGRect(x: 0, y: CGFloat(index) * Self.rowHeight, width: width, height: Self.rowHeight)
            row.clipsToBounds = true
        }
        scrollView.contentSize = CGSize(width: width, height: CGFloat(rows.count) * Self.rowHeight)
    }
}
