import SwiftUI

// MARK: - Icon (web <Icon src=... size=...>, using the copied SVG assets)

struct WebIcon: View {
    var name: String
    var size: CGFloat = 20
    var color: Color?

    var body: some View {
        Image(name)
            .resizable()
            .scaledToFit()
            .frame(width: size, height: size)
            .foregroundStyle(color ?? AppTheme.textPrimary)
    }
}

// MARK: - PillButton (web PillButton.module.scss: radius 100, min-width 120, h 38)

enum PillStyle {
    case primary, secondary, danger
}

struct PillButton<Label: View>: View {
    var style: PillStyle = .primary
    var disabled = false
    var fullWidth = false
    var action: () -> Void
    @ViewBuilder var label: Label

    init(style: PillStyle = .primary, disabled: Bool = false, fullWidth: Bool = false, action: @escaping () -> Void, @ViewBuilder label: () -> Label) {
        self.style = style
        self.disabled = disabled
        self.fullWidth = fullWidth
        self.action = action
        self.label = label()
    }

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                label
            }
            .font(.subheadline.weight(.medium))
            .padding(.horizontal, 16)
            .frame(minWidth: 120, minHeight: 38)
            .frame(maxWidth: fullWidth ? .infinity : nil)
            .background(background)
            .foregroundStyle(foreground)
            .clipShape(Capsule())
            .overlay {
                if style == .secondary {
                    Capsule().stroke(AppTheme.border, lineWidth: 1)
                }
            }
        }
        .disabled(disabled)
        .opacity(disabled ? 0.5 : 1)
    }

    private var background: Color {
        switch style {
        case .primary: return disabled ? AppTheme.disabled : AppTheme.primary
        case .secondary: return .clear
        case .danger: return Color(hex: "#DC2626")
        }
    }

    private var foreground: Color {
        switch style {
        case .primary, .danger: return .white
        case .secondary: return AppTheme.textPrimary
        }
    }
}

extension PillButton where Label == Text {
    init(label: String, style: PillStyle = .primary, disabled: Bool = false, action: @escaping () -> Void) {
        self.init(style: style, disabled: disabled, action: action) { Text(label) }
    }
}

/// Web MultiPurposeButton — the Generate / Stop Generating button:
/// blue rectangle, radius 4, height 38, label + optional icon.
struct MultiPurposeButton: View {
    var label: String
    var icon: String?
    var disabled = false
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Text(label)
                if let icon {
                    WebIcon(name: icon, size: 18, color: .white)
                }
            }
            .font(.subheadline.weight(.medium))
            .foregroundStyle(.white)
            .padding(.leading, 16)
            .padding(.trailing, 24)
            .frame(height: 38)
            .background(disabled ? AppTheme.disabled : AppTheme.primary)
            .clipShape(RoundedRectangle(cornerRadius: 4))
            .shadow(color: .black.opacity(disabled ? 0 : 0.15), radius: 1.5, y: 1)
        }
        .disabled(disabled)
        .opacity(disabled ? 0.5 : 1)
    }
}

// MARK: - Brand names (web BrandName.tsx, using the real vendor SVGs)

extension AIVendor {
    var iconAsset: String {
        switch self {
        case .openai: return "OpenAI"
        case .claude: return "Claude"
        case .gemini: return "Gemini"
        }
    }

    /// Web uses iconSize 30 for OpenAI, 20 for Claude/Gemini.
    var brandIconSize: CGFloat {
        self == .openai ? 30 : 20
    }
}

/// Web BrandName — vendor icon + name.
struct BrandNameView: View {
    var vendor: AIVendor
    var color: Color = AppTheme.textPrimary

    var body: some View {
        HStack(spacing: 8) {
            Image(vendor.iconAsset)
                .resizable()
                .scaledToFit()
                .frame(width: vendor.brandIconSize, height: vendor.brandIconSize)
            Text(vendor.displayName)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(color)
        }
    }
}

/// Web CollapsedBrandName — icon only.
struct CollapsedBrandIcon: View {
    var vendor: AIVendor
    var size: CGFloat = 20

    var body: some View {
        Image(vendor.iconAsset)
            .resizable()
            .scaledToFit()
            .frame(width: size, height: size)
    }
}

// MARK: - Markdown rendering (react-markdown + code fence equivalent)

struct MarkdownView: View {
    let text: String

    private enum Segment: Identifiable {
        case text(id: Int, String)
        case code(id: Int, language: String?, String)

        var id: Int {
            switch self {
            case .text(let id, _), .code(let id, _, _): return id
            }
        }
    }

    private var segments: [Segment] {
        var result: [Segment] = []
        var current = ""
        var codeLanguage: String?
        var inCode = false
        var index = 0

        func flush() {
            let trimmed = current.trimmingCharacters(in: .newlines)
            if !trimmed.isEmpty {
                result.append(inCode ? .code(id: index, language: codeLanguage, trimmed) : .text(id: index, trimmed))
                index += 1
            }
            current = ""
        }

        for line in text.components(separatedBy: "\n") {
            if line.hasPrefix("```") {
                flush()
                if !inCode {
                    let lang = line.dropFirst(3).trimmingCharacters(in: .whitespaces)
                    codeLanguage = lang.isEmpty ? nil : lang
                }
                inCode.toggle()
            } else {
                current += line + "\n"
            }
        }
        flush()
        return result
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(segments) { segment in
                switch segment {
                case .text(_, let content):
                    Text(attributed(content))
                        .foregroundStyle(AppTheme.textPrimary)
                        .textSelection(.enabled)
                case .code(_, let language, let code):
                    CodeBlockView(language: language, code: code)
                }
            }
        }
    }

    private func attributed(_ markdown: String) -> AttributedString {
        (try? AttributedString(
            markdown: markdown,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        )) ?? AttributedString(markdown)
    }
}

struct CodeBlockView: View {
    var language: String?
    var code: String
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(language ?? "code")
                    .font(.caption2)
                    .foregroundStyle(AppTheme.textMuted)
                Spacer()
                Button {
                    UIPasteboard.general.string = code
                    copied = true
                    Task {
                        try? await Task.sleep(nanoseconds: 1_500_000_000)
                        copied = false
                    }
                } label: {
                    HStack(spacing: 4) {
                        WebIcon(name: "copy-icon", size: 12, color: AppTheme.textMuted)
                        Text(copied ? "Copied" : "Copy Code")
                    }
                    .font(.caption2)
                    .foregroundStyle(AppTheme.textMuted)
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(AppTheme.backgroundTertiary)

            ScrollView(.horizontal, showsIndicators: false) {
                Text(code)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(AppTheme.textPrimary)
                    .padding(10)
                    .textSelection(.enabled)
            }
            .background(AppTheme.backgroundSecondary)
        }
        .clipShape(RoundedRectangle(cornerRadius: 6))
        .overlay(RoundedRectangle(cornerRadius: 6).stroke(AppTheme.borderLight, lineWidth: 1))
    }
}

// MARK: - Token badges (web token icons + toLocaleString values)

struct TokenBadges: View {
    var message: Message

    var body: some View {
        HStack(spacing: 10) {
            if let input = message.inputTokens {
                badge("input-tokens", input, "Total Input Tokens")
            }
            if let output = message.outputTokens {
                badge("output-tokens", output, "Total Output Tokens")
            }
            if let cache = message.tokensReadFromCache, cache > 0 {
                badge("cache-tokens", cache, "Tokens read from cache")
            }
            if let total = message.totalTokens {
                badge("total-tokens", total, "Total Tokens")
            }
        }
    }

    private func badge(_ icon: String, _ value: Int, _ tooltip: String) -> some View {
        HStack(spacing: 3) {
            WebIcon(name: icon, size: 14, color: AppTheme.textMuted)
            Text(value.formatted())
        }
        .font(.caption2)
        .foregroundStyle(AppTheme.textMuted)
        .accessibilityLabel(tooltip)
    }
}

// MARK: - Token estimate (src/utils/tokenEstimate.ts)

enum TokenEstimator {
    /// CJK characters count as 1 token each; the rest ≈ 4 chars/token.
    static func estimateTokens(_ text: String) -> Int {
        guard !text.isEmpty else { return 0 }
        var cjkCount = 0
        var otherCount = 0
        for scalar in text.unicodeScalars {
            switch scalar.value {
            case 0x3040...0x30FF, 0x4E00...0x9FFF, 0x3400...0x4DBF, 0xAC00...0xD7AF:
                cjkCount += 1
            default:
                otherCount += 1
            }
        }
        return cjkCount + Int(ceil(Double(otherCount) / 4.0))
    }
}
