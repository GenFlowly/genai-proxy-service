import SwiftUI

/// Renders markdown the way the web's TextContainer does (react-markdown + remark-gfm
/// + remark-math + rehype-highlight), using `MarkdownParser`'s measured CSS metrics.
struct MarkdownView: View {
    let text: String
    var options = MarkdownParser.Options()
    var onSelectionChange: ((String?) -> Void)?

    @State private var width: CGFloat = 0

    var body: some View {
        let segments = MarkdownParser.segments(for: text, options: options)
        VStack(alignment: .leading, spacing: 0) {
            ForEach(segments) { segment in
                switch segment {
                case .text(_, let attributed, let marginTop, let marginBottom):
                    MarkdownTextView(attributedText: attributed, onSelectionChange: onSelectionChange)
                        .padding(.horizontal, -MarkdownParser.hangingInset)
                        .padding(.top, marginTop)
                        .padding(.bottom, marginBottom)
                case .code(_, let language, let code, let top, let bottom):
                    CodeBlockView(language: language, code: code)
                        .padding(.top, top)
                        .padding(.bottom, bottom)
                case .table(_, let table, let top, let bottom):
                    MarkdownTableView(table: table, containerWidth: width, onSelectionChange: onSelectionChange)
                        .padding(.top, top)
                        .padding(.bottom, bottom)
                case .math(_, let latex, let top, let bottom):
                    MathBlockView(latex: latex)
                        .padding(.top, top)
                        .padding(.bottom, bottom)
                case .image(_, let url, let alt, let top, let bottom):
                    AsyncImage(url: url) { image in
                        image.resizable().scaledToFit()
                    } placeholder: {
                        Text(alt).webText(16.8, lineHeight: 28.56).foregroundStyle(AppTheme.textPrimary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.top, top)
                    .padding(.bottom, bottom)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
    }
}

// MARK: - Code block

/// `pre`: bg secondary (dark) / tertiary (light), 1pt border, radius 6, padding 16/24,
/// 14.4pt, scrolling horizontally; `code.hljs`: block, padding 1em (15.2), 15.2/25.84.
/// Copy button: CopyToClipboard sm secondary pinned 8pt from the top-right corner.
struct CodeBlockView: View {
    var language: String?
    var code: String
    @Environment(\.colorScheme) private var colorScheme
    @State private var highlighted: AttributedString?

    var body: some View {
        // `code` is the block that scrolls, so long lines clip at the `pre`'s padding.
        ScrollView(.horizontal, showsIndicators: false) {
            codeText
                .fixedSize(horizontal: true, vertical: false)
                .padding(LayoutUnit.truncating(15.2))
                .textSelection(.enabled)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 25)
        .padding(.vertical, 17)
        .background(AppTheme.codeSurface)
        .clipShape(RoundedRectangle(cornerRadius: DSRadius.md))
        .overlay(RoundedRectangle(cornerRadius: DSRadius.md).strokeBorder(AppTheme.border, lineWidth: 1))
        .overlay(alignment: .topTrailing) {
            CopyToClipboardButton(content: code, accessibilityLabel: L("common.textContainer.copyCode"))
                .padding(8)
        }
        .task(id: code + (colorScheme == .dark ? "·d" : "·l")) {
            highlighted = SyntaxHighlighter.highlight(code, language: language, dark: colorScheme == .dark)
        }
    }

    @ViewBuilder private var codeText: some View {
        if let highlighted {
            Text(highlighted).webText(mono: 15.2, lineHeight: 25.84)
        } else {
            Text(verbatim: code)
                .webText(mono: 15.2, lineHeight: 25.84)
                .foregroundStyle(colorScheme == .dark ? Color(hex: "#C9D1D9") : Color(hex: "#24292E"))
        }
    }
}

// MARK: - Table

/// GFM tables. 1–2 columns stay a grid with wrapping cells; 3–4 columns restack into
/// cards at ≤500pt of container width and 5+ at ≤760pt (`data-stack` late/early).
struct MarkdownTableView: View {
    let table: MarkdownTable
    let containerWidth: CGFloat
    var onSelectionChange: ((String?) -> Void)?

    private var isStacked: Bool {
        let columns = table.columnCount
        if columns >= 5 { return containerWidth <= 760 }
        if columns >= 3 { return containerWidth <= 500 }
        return false
    }

    var body: some View {
        if isStacked { stacked } else { grid }
    }

    // MARK: Stacked cards

    /// `border-collapse: separate`: the default 2pt spacing surrounds the rows' block, and
    /// each `td { display: table }` spaces its label and value cells the same way.
    private static let spacing: CGFloat = 2

    private var stacked: some View {
        VStack(spacing: 12) {
            ForEach(Array(table.stackedRows.enumerated()), id: \.offset) { _, row in
                VStack(spacing: 0) {
                    ForEach(Array(row.enumerated()), id: \.offset) { index, cell in
                        stackedCell(label: table.labels[index], value: cell)
                        if index < row.count - 1 {
                            Rectangle().fill(AppTheme.borderLight).frame(height: 1)
                        }
                    }
                }
                .padding(1)
                .background(AppTheme.background)
                .clipShape(RoundedRectangle(cornerRadius: DSRadius.md))
                .overlay(RoundedRectangle(cornerRadius: DSRadius.md).strokeBorder(AppTheme.borderLight, lineWidth: 1))
            }
        }
        .padding(Self.spacing)
    }

    /// The `::before` label cell is 38% of what the spacing leaves, its padding included.
    private func stackedCell(label: NSAttributedString, value: NSAttributedString) -> some View {
        let spacing = Self.spacing
        let cardContent = containerWidth - spacing * 2 - 2 - MarkdownTable.cellPaddingX * 2
        let hasLabel = label.length > 0
        let cells = max(cardContent - spacing * (hasLabel ? 3 : 2), 0)
        let labelWidth = hasLabel ? cells * 0.38 : 0
        return HStack(alignment: .top, spacing: spacing) {
            if hasLabel {
                MarkdownTextView(attributedText: label, onSelectionChange: onSelectionChange)
                    .padding(.trailing, MarkdownTable.cellPaddingX)
                    .frame(width: labelWidth, alignment: .leading)
            }
            MarkdownTextView(attributedText: value, onSelectionChange: onSelectionChange)
                .frame(width: cells - labelWidth, alignment: .leading)
        }
        .padding(.horizontal, MarkdownTable.cellPaddingX + spacing)
        .padding(.vertical, MarkdownTable.cellPaddingY + spacing)
    }

    // MARK: Grid

    @ViewBuilder private var grid: some View {
        let widths = table.columnWidths(available: containerWidth)
        if widths.reduce(0, +) + MarkdownTable.collapsedBorder > containerWidth {
            ScrollView(.horizontal, showsIndicators: false) { gridBody(widths) }
        } else {
            gridBody(widths).frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    /// `border-collapse: collapse`: borders sit centered on the grid lines, so the table box
    /// holds half of the outer ones and each cell half of the ones around it.
    private func gridBody(_ widths: [CGFloat]) -> some View {
        VStack(spacing: 0) {
            gridRow(table.header, widths: widths, isHeader: true)
            ForEach(Array(table.rows.enumerated()), id: \.offset) { _, row in
                gridRow(row, widths: widths, isHeader: false)
            }
        }
        .padding(MarkdownTable.collapsedBorder / 2)
    }

    private func gridRow(_ row: [NSAttributedString], widths: [CGFloat], isHeader: Bool) -> some View {
        HStack(spacing: 0) {
            ForEach(0..<table.columnCount, id: \.self) { column in
                MarkdownTextView(attributedText: row[column], onSelectionChange: onSelectionChange)
                    .padding(.horizontal, MarkdownTable.cellPaddingX + MarkdownTable.collapsedBorder / 2)
                    .padding(.vertical, MarkdownTable.cellPaddingY + MarkdownTable.collapsedBorder / 2)
                    .frame(width: widths[column], alignment: .leading)
                    .frame(maxHeight: .infinity, alignment: .top)
                    .background(isHeader ? AppTheme.backgroundTertiary : AppTheme.background)
                    .overlay(Rectangle().stroke(AppTheme.borderLight, lineWidth: MarkdownTable.collapsedBorder))
            }
        }
        .fixedSize(horizontal: false, vertical: true)
    }
}
