import SwiftUI
import UIKit
import JavaScriptCore

/// Syntax highlighting for fenced code blocks that matches the web app exactly.
///
/// The web renders code with **highlight.js** (via rehype-highlight) themed with
/// GitHub's "prettylights" palette. We run the *same* highlight.js engine in a
/// `JSContext` (the `highlightjs` data asset is highlight.js 11.x) to get identical
/// tokenization, then map each `hljs-*` token to the exact GitHub Dark / GitHub
/// Light colors the web ships — token-for-token, color-for-color parity.
///
/// We deliberately do NOT use a third-party Swift wrapper: those parse the theme
/// CSS with a naive regex that silently drops GitHub's compound selectors
/// (`.hljs-title.function_`, `.hljs-variable.language_`), leaving keywords and
/// function names uncolored. Driving highlight.js directly avoids that entirely.
///
/// MainActor-isolated: the shared `JSContext` is only ever touched on the main
/// actor (all highlighting runs from a view's `.task`), so it is never raced.
@MainActor
enum SyntaxHighlighter {
    // MARK: highlight.js engine

    private static let context: JSContext? = {
        guard let data = NSDataAsset(name: "highlightjs")?.data,
              let js = String(data: data, encoding: .utf8),
              let ctx = JSContext() else { return nil }
        ctx.exceptionHandler = { _, _ in }
        // highlight.js is a UMD bundle: with no `module`/`exports` defined it takes
        // the browser-global branch and assigns `hljs` on the JSContext global.
        ctx.evaluateScript(js)
        return ctx
    }()

    private static let hljs: JSValue? = {
        guard let hljs = context?.objectForKeyedSubscript("hljs"), !hljs.isUndefined else { return nil }
        return hljs
    }()

    /// Highlight `code`. `language` is the fence info-string (e.g. "swift"); an
    /// unknown/nil language falls back to highlight.js auto-detection. Returns nil
    /// to let the caller render plain text (engine unavailable or empty result).
    static func highlight(_ code: String, language: String?, dark: Bool) -> AttributedString? {
        guard let hljs else { return nil }
        let lang = language?.lowercased().trimmingCharacters(in: .whitespaces)

        var result: JSValue?
        if let lang, !lang.isEmpty,
           hljs.invokeMethod("getLanguage", withArguments: [lang])?.isUndefined == false {
            // Old-style signature (matches the bundled engine): highlight(lang, code, ignoreIllegals)
            result = hljs.invokeMethod("highlight", withArguments: [lang, code, true])
        }
        // Unknown language or the explicit call didn't produce a value → auto-detect.
        if result == nil || result?.isUndefined == true || result?.objectForKeyedSubscript("value") == nil {
            result = hljs.invokeMethod("highlightAuto", withArguments: [code])
        }
        guard let html = result?.objectForKeyedSubscript("value")?.toString(), !html.isEmpty else { return nil }
        return parse(html, dark: dark)
    }

    // MARK: HTML → AttributedString

    /// Parses highlight.js output — `<span class="hljs-x">…</span>` (possibly
    /// nested) with HTML entities — into a colored `AttributedString`. The color of
    /// each text run is the innermost enclosing `hljs-*` class, matching how CSS
    /// specificity resolves nested spans on the web.
    private static func parse(_ html: String, dark: Bool) -> AttributedString {
        var result = AttributedString()
        var classStack: [String] = []
        let scalars = Array(html)
        var i = 0
        var textBuffer = ""

        func flush() {
            guard !textBuffer.isEmpty else { return }
            var piece = AttributedString(unescape(textBuffer))
            piece.foregroundColor = color(for: classStack.last, dark: dark)
            result.append(piece)
            textBuffer = ""
        }

        while i < scalars.count {
            if scalars[i] == "<" {
                flush()
                // Read the tag up to '>'.
                var tag = ""
                i += 1
                while i < scalars.count, scalars[i] != ">" { tag.append(scalars[i]); i += 1 }
                i += 1 // consume '>'
                if tag.hasPrefix("/") {
                    if !classStack.isEmpty { classStack.removeLast() }
                } else if let range = tag.range(of: "class=\"") {
                    let rest = tag[range.upperBound...]
                    let cls = String(rest.prefix(while: { $0 != "\"" }))
                    classStack.append(cls)
                } else {
                    classStack.append("") // span without class — inherit
                }
            } else {
                textBuffer.append(scalars[i])
                i += 1
            }
        }
        flush()
        return result
    }

    private static func unescape(_ s: String) -> String {
        guard s.contains("&") else { return s }
        return s
            .replacingOccurrences(of: "&lt;", with: "<")
            .replacingOccurrences(of: "&gt;", with: ">")
            .replacingOccurrences(of: "&quot;", with: "\"")
            .replacingOccurrences(of: "&#39;", with: "'")
            .replacingOccurrences(of: "&#x27;", with: "'")
            .replacingOccurrences(of: "&amp;", with: "&")
    }

    // MARK: Palette (exact GitHub prettylights colors the web ships)

    /// Maps an `hljs-*` class string to its GitHub palette color. A class string may
    /// carry modifiers (`hljs-title function_`); we match on the primary token.
    private static func color(for cls: String?, dark: Bool) -> Color {
        guard let cls, !cls.isEmpty else { return base(dark) }
        if cls.contains("hljs-title") { return hex(dark ? "#d2a8ff" : "#6f42c1") }      // function/class names
        // Take the first `hljs-` token (ignoring trailing modifiers like function_).
        let token = cls.split(separator: " ").first.map(String.init) ?? cls
        switch token {
        case "hljs-keyword", "hljs-type", "hljs-template-tag", "hljs-template-variable":
            return hex(dark ? "#ff7b72" : "#d73a49")
        case "hljs-built_in", "hljs-symbol":
            return hex(dark ? "#ffa657" : "#e36209")
        case "hljs-string", "hljs-regexp", "hljs-meta-string":
            return hex(dark ? "#a5d6ff" : "#032f62")
        case "hljs-attr", "hljs-attribute", "hljs-literal", "hljs-meta", "hljs-number",
             "hljs-operator", "hljs-variable", "hljs-selector-attr", "hljs-selector-class", "hljs-selector-id":
            return hex(dark ? "#79c0ff" : "#005cc5")
        case "hljs-comment", "hljs-code", "hljs-formula":
            return hex(dark ? "#8b949e" : "#6a737d")
        case "hljs-name", "hljs-quote", "hljs-selector-tag", "hljs-selector-pseudo":
            return hex(dark ? "#7ee787" : "#22863a")
        case "hljs-section":
            return hex(dark ? "#1f6feb" : "#005cc5")
        case "hljs-bullet":
            return hex(dark ? "#f2cc60" : "#735c0f")
        case "hljs-subst":
            return base(dark)
        default:
            return base(dark)
        }
    }

    private static func base(_ dark: Bool) -> Color { hex(dark ? "#c9d1d9" : "#24292e") }

    private static func hex(_ s: String) -> Color {
        let h = s.hasPrefix("#") ? String(s.dropFirst()) : s
        let v = UInt32(h, radix: 16) ?? 0
        return Color(
            red: Double((v >> 16) & 0xFF) / 255,
            green: Double((v >> 8) & 0xFF) / 255,
            blue: Double(v & 0xFF) / 255
        )
    }
}
