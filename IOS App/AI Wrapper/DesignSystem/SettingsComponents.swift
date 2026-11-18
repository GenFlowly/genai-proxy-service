import SwiftUI

// The settings building blocks of the component library, at phone width (the library's
// `@container (max-width: 480px)` rules always apply here).

// MARK: - Numbers (numberFormat.ts, usageFormat.ts)

enum SettingsFormat {
    private static func decimal() -> NumberFormatter {
        let formatter = NumberFormatter()
        formatter.locale = Locale(identifier: "en_US")
        formatter.numberStyle = .decimal
        return formatter
    }

    /// "486,400".
    static func count(_ value: Int) -> String {
        decimal().string(from: NSNumber(value: value)) ?? String(value)
    }

    /// Counts of a million or more as "1.7M" (one decimal, "B" from a billion); below that the full number.
    static func compactCount(_ value: Int) -> String {
        let magnitude = abs(Double(value))
        guard magnitude >= 1_000_000 else { return count(value) }
        let formatter = NumberFormatter()
        formatter.locale = Locale(identifier: "en_US")
        formatter.minimumFractionDigits = 0
        formatter.maximumFractionDigits = 1
        let (scaled, suffix): (Double, String) = {
            let millions = (Double(value) / 1_000_000 * 10).rounded() / 10
            if abs(millions) >= 1_000 { return ((Double(value) / 1_000_000_000 * 10).rounded() / 10, "B") }
            return (millions, "M")
        }()
        return (formatter.string(from: NSNumber(value: scaled)) ?? String(scaled)) + suffix
    }

    /// Prices: two decimals, up to four under a dollar ("$0.21", "$0.0034").
    static func usd(_ value: Double) -> String {
        let formatter = NumberFormatter()
        formatter.locale = Locale(identifier: "en_US")
        formatter.numberStyle = .currency
        formatter.currencyCode = "USD"
        formatter.minimumFractionDigits = 2
        formatter.maximumFractionDigits = abs(value) < 1 ? 4 : 2
        return formatter.string(from: NSNumber(value: value)) ?? "$\(value)"
    }

    /// Chart labels: costs under a cent keep two significant digits, so a tiny bar never reads "$0.00".
    static func chartUsd(_ value: Double) -> String {
        if value == 0 { return "$0" }
        if abs(value) >= 0.01 { return usd(value) }
        let formatter = NumberFormatter()
        formatter.locale = Locale(identifier: "en_US")
        formatter.numberStyle = .currency
        formatter.currencyCode = "USD"
        formatter.usesSignificantDigits = true
        formatter.maximumSignificantDigits = 2
        return formatter.string(from: NSNumber(value: value)) ?? "$\(value)"
    }
}

// MARK: - Wrapping row (flex-wrap: wrap; align-items: center)

/// Lays its views out left to right and wraps to a new line when the next one doesn't fit,
/// each line's views centered on it, as a wrapping flex row does.
struct WrapRow: Layout {
    var spacing: CGFloat = 8
    var lineSpacing: CGFloat = 4

    private func lines(_ sizes: [CGSize], width: CGFloat) -> [[Int]] {
        var result: [[Int]] = [[]]
        var lineWidth: CGFloat = 0
        for (index, size) in sizes.enumerated() {
            let needed = result[result.count - 1].isEmpty ? size.width : lineWidth + spacing + size.width
            if needed > width, !result[result.count - 1].isEmpty {
                result.append([index])
                lineWidth = size.width
            } else {
                result[result.count - 1].append(index)
                lineWidth = needed
            }
        }
        return result
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        let sizes: [CGSize] = subviews.map { $0.sizeThatFits(ProposedViewSize(width: width, height: nil)) }
        var height: CGFloat = 0
        var used: CGFloat = 0
        for (index, row) in lines(sizes, width: width).enumerated() {
            var lineHeight: CGFloat = 0
            var lineWidth: CGFloat = 0
            for item in row {
                lineHeight = max(lineHeight, sizes[item].height)
                lineWidth += sizes[item].width
            }
            lineWidth += spacing * CGFloat(max(row.count - 1, 0))
            used = max(used, lineWidth)
            height += lineHeight + (index > 0 ? lineSpacing : 0)
        }
        return CGSize(width: min(used, width), height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let sizes = subviews.map { $0.sizeThatFits(.init(width: bounds.width, height: nil)) }
        var y = bounds.minY
        for row in lines(sizes, width: bounds.width) {
            let lineHeight = row.map { sizes[$0].height }.max() ?? 0
            var x = bounds.minX
            for index in row {
                subviews[index].place(at: CGPoint(x: x, y: y + (lineHeight - sizes[index].height) / 2), proposal: .init(sizes[index]))
                x += sizes[index].width + spacing
            }
            y += lineHeight + lineSpacing
        }
    }
}

// MARK: - StatusPill (StatusPill.tsx)

enum StatusPillKind { case ok, neutral, unset, warn, locked }

/// A small rounded status: green when set up, muted outline for a fact or something not set,
/// red when it needs attention, filled grey when it can't be changed.
struct StatusPill: View {
    var kind: StatusPillKind = .neutral
    let text: String

    var body: some View {
        Text(text)
            .webText(11, 500, lineHeight: 11)
            .foregroundStyle(foreground)
            .lineLimit(1)
            .fixedSize()
            .padding(.horizontal, 9)
            .frame(height: 20)
            .background(background, in: Capsule())
            .overlay {
                if kind == .neutral || kind == .unset {
                    Capsule().strokeBorder(AppTheme.border, lineWidth: 1)
                }
            }
    }

    private var foreground: Color {
        switch kind {
        case .ok: return AppTheme.success
        case .warn: return AppTheme.error
        case .locked: return AppTheme.textPrimary
        case .neutral, .unset: return AppTheme.textMuted
        }
    }

    private var background: Color {
        switch kind {
        case .ok: return AppTheme.success.opacity(0.14)
        case .warn: return AppTheme.error.opacity(0.12)
        case .locked: return AppTheme.backgroundTertiary
        case .neutral, .unset: return .clear
        }
    }
}

// MARK: - SettingsCard (SettingsCard.tsx)

/// The card every settings page is built from: the sidebar card material, a header with the
/// title, status pills and a hint on its own line, then the body. `flush` drops the body padding
/// for tables; a nil title leaves the header out.
struct SettingsCard<Pills: View, Content: View>: View {
    var title: String?
    var icon: String?
    var hint: String?
    var danger = false
    var flush = false
    @ViewBuilder var pills: Pills
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let title { header(title) }
            if Content.self != EmptyView.self {
                VStack(alignment: .leading, spacing: flush ? 0 : 10) { content }
                    .padding(.horizontal, flush ? 0 : 14)
                    .padding(.vertical, flush ? 0 : 12)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .sidebarWidgetCard()
        .overlay {
            if danger {
                RoundedRectangle(cornerRadius: DSRadius.lg).strokeBorder(AppTheme.buttonDanger, lineWidth: 1)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(title ?? "")
    }

    private func header(_ title: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            WrapRow(spacing: 8, lineSpacing: 4) {
                if let icon {
                    WebIcon(name: icon, size: 14, color: danger ? AppTheme.error : AppTheme.textMuted)
                }
                Text(title)
                    .webText(13, 500, lineHeight: 16.9)
                    .foregroundStyle(danger ? AppTheme.error : AppTheme.textSecondary)
                    .accessibilityAddTraits(.isHeader)
                if Pills.self != EmptyView.self {
                    WrapRow(spacing: 6, lineSpacing: 6) { pills }
                }
            }
            if let hint {
                Text(hint)
                    .webText(12, lineHeight: 16.8)
                    .foregroundStyle(AppTheme.textMuted)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, minHeight: 35, alignment: .leading)
        .overlay(alignment: .bottom) { Rectangle().fill(AppTheme.sidebarHairline).frame(height: 1).offset(y: 1) }
        .padding(.bottom, 1)
    }
}

extension SettingsCard where Pills == EmptyView {
    init(title: String? = nil, icon: String? = nil, hint: String? = nil, danger: Bool = false, flush: Bool = false, @ViewBuilder content: () -> Content) {
        self.init(title: title, icon: icon, hint: hint, danger: danger, flush: flush, pills: { EmptyView() }, content: content)
    }
}

// MARK: - SettingsRow / ToggleRow (SettingsRow.tsx, ToggleRow.tsx)

/// A label with an optional description and an action. At phone width an action that should
/// stack (buttons) sits under the text at full width; switches and links stay on the right.
/// `separated` draws the hairline a row gets after another row.
struct SettingsRow<Action: View, Extra: View>: View {
    let label: String
    var description: String?
    var mutedLabel = false
    var stack = true
    var separated = false
    @ViewBuilder var action: Action
    @ViewBuilder var extra: Extra

    var body: some View {
        Group {
            if stack && Action.self != EmptyView.self {
                VStack(alignment: .leading, spacing: 10) {
                    text
                    action.frame(maxWidth: .infinity)
                }
            } else {
                HStack(alignment: .center, spacing: 14) {
                    text.frame(maxWidth: .infinity, alignment: .leading)
                    if Action.self != EmptyView.self {
                        HStack(spacing: 8) { action }.fixedSize()
                    }
                }
            }
        }
        .padding(.top, separated ? 10 : 0)
        .overlay(alignment: .top) {
            if separated { Rectangle().fill(AppTheme.sidebarHairline).frame(height: 1) }
        }
    }

    private var text: some View {
        VStack(alignment: .leading, spacing: 2) {
            if mutedLabel {
                Text(label)
                    .webText(13, lineHeight: 18.85)
                    .foregroundStyle(AppTheme.textMuted)
            } else {
                Text(label)
                    .webText(14, 500)
                    .foregroundStyle(AppTheme.textPrimary)
            }
            if let description {
                Text(description)
                    .webText(13, lineHeight: 18.85)
                    .foregroundStyle(AppTheme.textMuted)
            }
            if Extra.self != EmptyView.self { extra }
        }
    }
}

extension SettingsRow where Extra == EmptyView {
    init(label: String, description: String? = nil, mutedLabel: Bool = false, stack: Bool = true, separated: Bool = false, @ViewBuilder action: () -> Action) {
        self.init(label: label, description: description, mutedLabel: mutedLabel, stack: stack, separated: separated, action: action, extra: { EmptyView() })
    }
}

extension SettingsRow where Action == EmptyView, Extra == EmptyView {
    init(label: String, description: String? = nil, separated: Bool = false) {
        self.init(label: label, description: description, stack: false, separated: separated, action: { EmptyView() }, extra: { EmptyView() })
    }
}

/// The library Switch as a control: WebSwitch's track and thumb in a button.
struct SettingsSwitch: View {
    let isOn: Bool
    var disabled = false
    let label: String
    let onChange: (Bool) -> Void

    var body: some View {
        Button { onChange(!isOn) } label: {
            WebSwitch(isOn: isOn)
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .opacity(disabled ? 0.5 : 1)
        .accessibilityLabel(label)
        .accessibilityAddTraits(isOn ? [.isToggle, .isSelected] : .isToggle)
    }
}

struct ToggleRow: View {
    let label: String
    var description: String?
    let isOn: Bool
    var disabled = false
    var separated = false
    var identifier: String?
    let onChange: (Bool) -> Void

    var body: some View {
        SettingsRow(label: label, description: description, stack: false, separated: separated) {
            SettingsSwitch(isOn: isOn, disabled: disabled, label: label, onChange: onChange)
                .accessibilityIdentifier(identifier ?? "")
        }
    }
}

/// A link-styled action in a settings row ("Open Memory", "Set up").
struct SettingsLink: View {
    let text: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(text)
                .webText(13, 500)
                .foregroundStyle(AppTheme.primary)
                .lineLimit(1)
                .fixedSize()
        }
        .buttonStyle(WebPressStyle())
    }
}

// MARK: - Knowledge cards (KnowledgeStrip.tsx, stacked as in the info drawer)

struct KnowledgeItem: Equatable, Identifiable {
    let title: String
    let text: String
    var id: String { title }
}

struct KnowledgeList: View {
    let items: [KnowledgeItem]

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(items) { item in
                VStack(alignment: .leading, spacing: 2) {
                    Text(item.title)
                        .webText(14, 500)
                        .foregroundStyle(AppTheme.textPrimary)
                    Text(item.text)
                        .webText(14, lineHeight: 20.3)
                        .foregroundStyle(AppTheme.textMuted)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(AppTheme.backgroundSecondary)
        .clipShape(RoundedRectangle(cornerRadius: DSRadius.lg))
        .overlay(RoundedRectangle(cornerRadius: DSRadius.lg).strokeBorder(AppTheme.borderLight, lineWidth: 1))
    }
}

// MARK: - InfoDrawer (InfoDrawer.tsx on SlideOverPanel.tsx)

/// "About this page": covers the screen, sliding in from the right, with a close button, the
/// page's name in a pill, its knowledge cards and how to open it again. While it is open the
/// left-edge swipe is off, so the menu can't open over it.
struct InfoDrawer: View {
    let isOpen: Bool
    let subtitle: String
    let items: [KnowledgeItem]
    let onClose: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// How far a swipe has pulled the panel back toward the right edge.
    @State private var dragOffset: CGFloat = 0

    private var motion: Animation? {
        reduceMotion ? nil : .timingCurve(0.2, 0.8, 0.2, 1, duration: 0.25)
    }

    var body: some View {
        GeometryReader { proxy in
            ZStack(alignment: .trailing) {
                if isOpen {
                    Color.black.opacity(0.45)
                        .ignoresSafeArea()
                        .onTapGesture(perform: onClose)
                        .transition(.opacity)
                        .accessibilityHidden(true)
                }
                // Kept in place while closed, off past the right edge, so a swipe that closes it
                // slides on from where the finger let go.
                panel(width: proxy.size.width)
                    .offset(x: isOpen ? dragOffset : proxy.size.width + 32)
                    .gesture(closeSwipe(width: proxy.size.width))
                    .allowsHitTesting(isOpen)
                    .accessibilityHidden(!isOpen)
            }
            .animation(motion, value: isOpen)
        }
        .preference(key: DialogShownKey.self, value: isOpen)
    }

    /// A swipe back to the right closes it, like the left-edge swipe closes a page; it commits
    /// past 30% of the screen or on a flick (EdgeSwipeGesture.commits).
    private func closeSwipe(width: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 10)
            .onChanged { value in
                guard dragOffset > 0 || value.translation.width > abs(value.translation.height) else { return }
                dragOffset = max(0, value.translation.width)
            }
            .onEnded { value in
                let commits = dragOffset > 0
                    && EdgeSwipeGesture.commits(translation: dragOffset, velocity: value.velocity.width, width: width)
                if commits { onClose() }
                withAnimation(motion) { dragOffset = 0 }
            }
    }

    private func panel(width: CGFloat) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Button(action: onClose) {
                    WebIcon(name: "close", size: 20, color: AppTheme.textPrimary)
                        .frame(width: 40, height: 40)
                        .background(AppTheme.backgroundSecondary, in: Circle())
                        .overlay(Circle().strokeBorder(AppTheme.borderLight, lineWidth: 1))
                        .shadow(color: .black.opacity(0.4), radius: 3, y: 4)
                }
                .buttonStyle(WebPressStyle())
                .accessibilityLabel(L("settingsPage.frame.close"))
                .accessibilityIdentifier("settings-info-close")
                Spacer(minLength: 0)
                VStack(spacing: 0) {
                    Text(L("settingsPage.frame.aboutTitle"))
                        .webText(14, 500, lineHeight: 16.1)
                        .foregroundStyle(AppTheme.textPrimary)
                    Text(subtitle)
                        .webText(11, lineHeight: 12.65)
                        .foregroundStyle(AppTheme.textMuted)
                }
                .lineLimit(1)
                .padding(.horizontal, 18)
                .frame(height: 40)
                .background(AppTheme.backgroundSecondary, in: Capsule())
                .overlay(Capsule().strokeBorder(AppTheme.borderLight, lineWidth: 1))
                .shadow(color: .black.opacity(0.4), radius: 3, y: 4)
                Spacer(minLength: 0)
                Color.clear.frame(width: 40, height: 40)
            }
            KnowledgeList(items: items)
            Text(L("settingsPage.frame.drawerHint"))
                .webText(13, lineHeight: 18.85)
                .foregroundStyle(AppTheme.textMuted)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .frame(maxWidth: .infinity)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 12)
        .padding(.top, 8)
        .padding(.bottom, 20)
        .frame(width: width)
        .frame(maxHeight: .infinity, alignment: .top)
        .background(AppTheme.background.ignoresSafeArea())
        .shadow(color: .black.opacity(0.25), radius: 12, x: -8)
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(.isModal)
        .accessibilityIdentifier("settings-info-drawer")
    }
}

// MARK: - StatTile (StatTile.tsx)

struct StatTile: View {
    let label: String
    let value: String
    var sub: String?
    var identifier: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label.uppercased())
                .webText(11, 600)
                .kerning(0.66)
                .foregroundStyle(AppTheme.textMuted)
                .lineLimit(1)
            Text(value)
                .webText(20, 500, lineHeight: 25)
                .monospacedDigit()
                .foregroundStyle(AppTheme.textPrimary)
                .lineLimit(1)
                .truncationMode(.tail)
            if let sub {
                Text(sub)
                    .webText(12)
                    .foregroundStyle(AppTheme.textMuted)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(AppTheme.backgroundSecondary)
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(AppTheme.borderLight, lineWidth: 1))
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier(identifier ?? "")
    }
}

/// Two tiles per row, as the phone grid lays them out (GridCol span 6, 8pt gaps).
struct StatTileGrid: View {
    let tiles: [(label: String, value: String, id: String)]

    var body: some View {
        let rows = stride(from: 0, to: tiles.count, by: 2).map { Array(tiles[$0..<min($0 + 2, tiles.count)]) }
        VStack(spacing: 8) {
            ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                HStack(spacing: 8) {
                    ForEach(row, id: \.id) { tile in
                        StatTile(label: tile.label, value: tile.value, identifier: tile.id)
                    }
                    if row.count == 1 { Color.clear.frame(maxWidth: .infinity) }
                }
                .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

// MARK: - DataTable (DataTable.tsx)

/// A settings table: uppercase headers that may wrap, right-aligned numbers, hairline rows, an
/// optional totals footer. Columns size like a browser's automatic table layout and the table
/// scrolls sideways when it can't fit.
struct SettingsTable: View {
    struct Column {
        let title: String
        var numeric = false
        var mono = false
        /// `font-weight: 500` cells, e.g. the Developer table's key names.
        var medium = false
        /// A column of controls (Revoke) with a fixed width; its header is for screen readers only.
        var actionWidth: CGFloat?
    }

    let columns: [Column]
    let rows: [[String]]
    var footer: [String]?
    var emptyText: String?
    var rowAction: ((Int) -> AnyView)?
    var identifier: String?

    private static let headerFont = DSFont.ui(11, weight: 500)
    private static let bodyFont = DSFont.ui(12.5)
    private static let footerFont = DSFont.ui(12.5, weight: 500)
    private static let monoFont = DSFont.uiSFMono(13)
    private static let padding: CGFloat = 24

    @State private var measuredHeight: CGFloat = 0

    var body: some View {
        GeometryReader { proxy in
            let widths = columnWidths(available: proxy.size.width)
            ScrollView(.horizontal, showsIndicators: false) {
                table(widths: widths, available: proxy.size.width)
            }
            .scrollBounceBehavior(.basedOnSize, axes: .horizontal)
            .preference(key: SettingsTableHeightKey.self, value: tableHeight(widths: widths))
        }
        .frame(height: measuredHeight)
        .onPreferenceChange(SettingsTableHeightKey.self) { measuredHeight = $0 }
        .accessibilityIdentifier(identifier ?? "")
    }

    private func font(column: Int) -> UIFont {
        columns[column].mono ? Self.monoFont : columns[column].medium ? Self.footerFont : Self.bodyFont
    }

    private func table(widths: [CGFloat], available: CGFloat) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            headerRow(widths: widths)
            if rows.isEmpty, let emptyText {
                Text(emptyText)
                    .modifier(WebFontModifier(uiFont: Self.bodyFont))
                    .foregroundStyle(AppTheme.textMuted)
                    .frame(width: widths.reduce(0, +))
                    .padding(.vertical, 9)
            }
            ForEach(Array(rows.enumerated()), id: \.offset) { index, cells in
                bodyRow(index: index, cells: cells, widths: widths)
                    .overlay(alignment: .top) {
                        if index > 0 { Rectangle().fill(AppTheme.sidebarHairline).frame(height: 1) }
                    }
            }
            if let footer {
                HStack(spacing: 0) {
                    ForEach(Array(footer.enumerated()), id: \.offset) { index, cell in
                        cellText(cell, column: index, width: widths[index], font: Self.footerFont, color: AppTheme.textPrimary)
                    }
                }
                .frame(height: lineHeight(Self.footerFont) + 18 + 1, alignment: .bottom)
                .overlay(alignment: .top) { Rectangle().fill(AppTheme.border).frame(height: 1) }
            }
        }
        .frame(minWidth: available, alignment: .leading)
    }

    private func headerRow(widths: [CGFloat]) -> some View {
        HStack(alignment: .bottom, spacing: 0) {
            ForEach(Array(columns.enumerated()), id: \.offset) { index, column in
                Text(column.actionWidth == nil ? column.title.uppercased() : "")
                    .modifier(WebFontModifier(uiFont: Self.headerFont))
                    .kerning(0.44)
                    .foregroundStyle(AppTheme.textMuted)
                    .multilineTextAlignment(column.numeric ? .trailing : .leading)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .frame(width: widths[index], alignment: column.numeric ? .bottomTrailing : .bottomLeading)
                    .accessibilityLabel(column.title)
            }
        }
        .frame(height: headerHeight(widths: widths), alignment: .bottom)
        .overlay(alignment: .bottom) { Rectangle().fill(AppTheme.sidebarHairline).frame(height: 1) }
        .accessibilityElement(children: .contain)
    }

    private func bodyRow(index: Int, cells: [String], widths: [CGFloat]) -> some View {
        HStack(spacing: 0) {
            ForEach(Array(columns.enumerated()), id: \.offset) { column, spec in
                if spec.actionWidth != nil, let rowAction {
                    rowAction(index)
                        .padding(.horizontal, 12)
                        .frame(width: widths[column], alignment: .trailing)
                } else {
                    cellText(column < cells.count ? cells[column] : "", column: column, width: widths[column], font: font(column: column), color: spec.mono ? AppTheme.textSecondary : AppTheme.textPrimary)
                }
            }
        }
        .frame(height: rowHeight)
        .accessibilityElement(children: .combine)
    }

    private func cellText(_ text: String, column: Int, width: CGFloat, font: UIFont, color: Color) -> some View {
        let numeric = column < columns.count && columns[column].numeric
        return Text(text)
            .modifier(WebFontModifier(uiFont: font))
            .monospacedDigit()
            .foregroundStyle(color)
            .lineLimit(1)
            .fixedSize()
            .padding(.horizontal, 12)
            .frame(width: width, alignment: numeric ? .trailing : .leading)
    }

    private func lineHeight(_ font: UIFont) -> CGFloat {
        WebLineBox(font: font, lineHeight: nil).height
    }

    /// Rows hold one line; a row with controls is as tall as the 26pt Revoke pill plus padding.
    private var rowHeight: CGFloat {
        let text = lineHeight(Self.bodyFont) + 18
        return rowAction == nil ? text : max(text, 26 + 18)
    }

    private func headerHeight(widths: [CGFloat]) -> CGFloat {
        var lines: CGFloat = 1
        for (index, column) in columns.enumerated() where column.actionWidth == nil {
            let text = NSAttributedString(string: column.title.uppercased(), attributes: [.font: Self.headerFont, .kern: 0.44])
            let box = text.boundingRect(with: CGSize(width: max(widths[index] - Self.padding, 1), height: 1_000), options: [.usesLineFragmentOrigin], context: nil)
            lines = max(lines, (box.height / Self.headerFont.lineHeight).rounded())
        }
        return lines * lineHeight(Self.headerFont) + 16 + 1
    }

    private func tableHeight(widths: [CGFloat]) -> CGFloat {
        var height = headerHeight(widths: widths)
        height += rows.isEmpty && emptyText != nil ? lineHeight(Self.bodyFont) + 18 : CGFloat(rows.count) * rowHeight
        if footer != nil { height += lineHeight(Self.footerFont) + 18 + 1 }
        return height
    }

    private func columnWidths(available: CGFloat) -> [CGFloat] {
        var minWidths = [CGFloat](repeating: 0, count: columns.count)
        var maxWidths = [CGFloat](repeating: 0, count: columns.count)
        for (index, column) in columns.enumerated() {
            if let actionWidth = column.actionWidth {
                minWidths[index] = actionWidth + Self.padding
                maxWidths[index] = actionWidth + Self.padding
                continue
            }
            let title = column.title.uppercased() as NSString
            let headerAttributes: [NSAttributedString.Key: Any] = [.font: Self.headerFont, .kern: 0.44]
            maxWidths[index] = LayoutUnit.ceiling(title.size(withAttributes: headerAttributes).width) + Self.padding
            for piece in WebLineBreak.unbreakableRanges(in: title) {
                minWidths[index] = max(minWidths[index], LayoutUnit.ceiling(title.substring(with: piece).size(withAttributes: headerAttributes).width) + Self.padding)
            }
            let cellFont = font(column: index)
            for cells in rows + (footer.map { [$0] } ?? []) where index < cells.count {
                let width = LayoutUnit.ceiling((cells[index] as NSString).size(withAttributes: [.font: cellFont]).width) + Self.padding
                minWidths[index] = max(minWidths[index], width)
                maxWidths[index] = max(maxWidths[index], width)
            }
        }
        let totalMax = maxWidths.reduce(0, +)
        if totalMax <= available {
            let extra = available - totalMax
            return maxWidths.map { $0 + extra * $0 / max(totalMax, 1) }
        }
        let totalMin = minWidths.reduce(0, +)
        guard totalMin < available else { return minWidths }
        let wanted = zip(maxWidths, minWidths).map { $0 - $1 }
        let totalWanted = max(wanted.reduce(0, +), 1)
        return zip(minWidths, wanted).map { $0 + (available - totalMin) * $1 / totalWanted }
    }
}

private struct SettingsTableHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}

// MARK: - BarChart (BarChart.tsx)

struct BarChartPoint: Identifiable, Equatable {
    let key: String
    let value: Double
    let axisLabel: String
    let tooltipTitle: String
    var tooltipDetail: String?
    var id: String { key }
}

/// Cost per day (or week): the web chart's geometry exactly — 50pt for the axis on the left,
/// three gridlines, the tallest bar labelled, up to six axis labels. Touch a bar for its tooltip.
struct UsageBarChart: View {
    let points: [BarChartPoint]
    let formatValue: (Double) -> String
    let accessibilityTitle: String
    var height: CGFloat = 196

    @State private var active: Int?

    private static let margin = (top: CGFloat(18), right: CGFloat(6), bottom: CGFloat(24), left: CGFloat(50))
    private static let axisFont = DSFont.ui(10)
    private static let labelFont = DSFont.ui(10, weight: 500)
    private static let tooltipTitleFont = DSFont.ui(11, weight: 500)
    private static let tooltipDetailFont = DSFont.ui(11)

    static func niceMax(_ max: Double) -> Double {
        guard max > 0 else { return 1 }
        let raw = max / 2
        let magnitude = pow(10, floor(log10(raw)))
        let step = [1, 2, 2.5, 5, 10].map { $0 * magnitude }.first { $0 >= raw } ?? 10 * magnitude
        return step * 2
    }

    var body: some View {
        GeometryReader { proxy in
            chart(width: proxy.size.width)
        }
        .frame(height: height)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityTitle)
        .accessibilityValue(points.map { "\($0.tooltipTitle): \(formatValue($0.value))" }.joined(separator: ", "))
    }

    @ViewBuilder
    private func chart(width: CGFloat) -> some View {
        if !points.isEmpty {
            let m = Self.margin
            let plotWidth = max(width - m.left - m.right, 40)
            let plotHeight = height - m.top - m.bottom
            let baseline = m.top + plotHeight
            let maxValue = points.map(\.value).max() ?? 0
            let top = Self.niceMax(maxValue)
            let slot = plotWidth / CGFloat(points.count)
            let barWidth = max(min(16, slot * 0.6), 2)
            let labelEvery = Int((Double(points.count) / 6).rounded(.up))
            let maxIndex = points.firstIndex { $0.value == maxValue } ?? 0
            let yFor = { (value: Double) -> CGFloat in baseline - CGFloat(value / top) * plotHeight }

            ZStack(alignment: .topLeading) {
                Canvas { context, _ in
                    for fraction in [0.0, 0.5, 1.0] {
                        let y = yFor(top * fraction)
                        var line = Path()
                        line.move(to: CGPoint(x: m.left, y: y))
                        line.addLine(to: CGPoint(x: width - m.right, y: y))
                        context.stroke(line, with: .color(fraction == 0 ? AppTheme.border : AppTheme.sidebarHairline), lineWidth: 1)
                    }
                    for (index, point) in points.enumerated() {
                        let x = m.left + slot * CGFloat(index) + (slot - barWidth) / 2
                        let y = yFor(point.value)
                        let barHeight = baseline - y
                        guard barHeight > 0 else { continue }
                        let radius = min(4, barWidth / 2, barHeight)
                        var bar = Path()
                        bar.move(to: CGPoint(x: x, y: baseline))
                        bar.addLine(to: CGPoint(x: x, y: y + radius))
                        bar.addArc(center: CGPoint(x: x + radius, y: y + radius), radius: radius, startAngle: .degrees(180), endAngle: .degrees(270), clockwise: false)
                        bar.addLine(to: CGPoint(x: x + barWidth - radius, y: y))
                        bar.addArc(center: CGPoint(x: x + barWidth - radius, y: y + radius), radius: radius, startAngle: .degrees(270), endAngle: .degrees(0), clockwise: false)
                        bar.addLine(to: CGPoint(x: x + barWidth, y: baseline))
                        bar.closeSubpath()
                        context.fill(bar, with: .color(active == index ? AppTheme.chartBarActive : AppTheme.primary))
                    }
                }

                ForEach([0.0, 0.5, 1.0], id: \.self) { fraction in
                    let text = formatValue(top * fraction)
                    // `text-anchor: end` at 6pt left of the plot: a long label runs off to the left.
                    let textWidth = (text as NSString).size(withAttributes: [.font: Self.axisFont]).width
                    chartText(text, font: Self.axisFont, color: AppTheme.textMuted)
                        .fixedSize()
                        .position(x: m.left - 6 - textWidth / 2, y: yFor(top * fraction))
                }

                ForEach(Array(points.enumerated()), id: \.offset) { index, point in
                    let centre = m.left + slot * CGFloat(index) + slot / 2
                    if index % labelEvery == 0 {
                        chartText(point.axisLabel, font: Self.axisFont, color: AppTheme.textMuted)
                            .fixedSize()
                            .position(x: centre, y: baseline + 16 - Self.axisFont.capHeight / 2)
                    }
                    if index == maxIndex, maxValue > 0, active == nil {
                        chartText(formatValue(point.value), font: Self.labelFont, color: AppTheme.textPrimary)
                            .fixedSize()
                            .position(x: centre, y: yFor(point.value) - 6 - Self.labelFont.capHeight / 2)
                    }
                }

                if let active, active < points.count {
                    tooltip(points[active], index: active, width: width, slot: slot, yFor: yFor)
                }
            }
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { value in
                        let index = Int((value.location.x - m.left) / slot)
                        active = (0..<points.count).contains(index) ? index : nil
                    }
                    .onEnded { _ in active = nil }
            )
        }
    }

    private func chartText(_ text: String, font: UIFont, color: Color) -> some View {
        Text(text)
            .modifier(WebFontModifier(uiFont: font))
            .foregroundStyle(color)
            .lineLimit(1)
    }

    private func tooltip(_ point: BarChartPoint, index: Int, width: CGFloat, slot: CGFloat, yFor: (Double) -> CGFloat) -> some View {
        let m = Self.margin
        let detail = formatValue(point.value) + (point.tooltipDetail.map { " · \($0)" } ?? "")
        let tooltipWidth = CGFloat(max(point.tooltipTitle.count, detail.count)) * 6.4 + 20
        let centre = m.left + slot * CGFloat(index) + slot / 2
        let x = min(max(centre - tooltipWidth / 2, m.left), width - m.right - tooltipWidth)
        let y = max(yFor(point.value) - 40 - 8, 0)
        return VStack(alignment: .leading, spacing: 2) {
            chartText(point.tooltipTitle, font: Self.tooltipTitleFont, color: AppTheme.textPrimary)
            chartText(detail, font: Self.tooltipDetailFont, color: AppTheme.textMuted)
        }
        .padding(.horizontal, 10)
        .frame(width: tooltipWidth, height: 40, alignment: .leading)
        .background(AppTheme.backgroundSecondary, in: RoundedRectangle(cornerRadius: 6))
        .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(AppTheme.border, lineWidth: 1))
        .offset(x: x, y: y)
        .allowsHitTesting(false)
    }
}

// MARK: - Daily buckets (dailySeries.ts)

struct SeriesBucket: Equatable {
    let start: String
    let end: String
    let value: Double
    let count: Int
}

enum DailySeries {
    private static let utc = TimeZone(identifier: "UTC") ?? .gmt

    private static func formatter() -> DateFormatter {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = utc
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }

    /// One bar per day from `from` to `to` (UTC dates, inclusive), missing days as zero; ranges
    /// longer than 60 days become 7-day buckets starting at `from`.
    static func bucket(_ days: [(date: String, value: Double, count: Int)], from: String, to: String, maxDailyBars: Int = 60) -> (isWeekly: Bool, buckets: [SeriesBucket]) {
        let format = formatter()
        guard let start = format.date(from: from), let end = format.date(from: to), end >= start else { return (false, []) }
        var byDate: [String: (value: Double, count: Int)] = [:]
        for day in days {
            let current = byDate[day.date] ?? (0, 0)
            byDate[day.date] = (current.value + day.value, current.count + day.count)
        }
        let dayCount = Int((end.timeIntervalSince(start) / 86_400).rounded()) + 1
        let size = dayCount > maxDailyBars ? 7 : 1
        var buckets: [SeriesBucket] = []
        var offset = 0
        while offset < dayCount {
            let bucketStart = start.addingTimeInterval(Double(offset) * 86_400)
            let bucketEnd = min(bucketStart.addingTimeInterval(Double(size - 1) * 86_400), end)
            var value = 0.0
            var count = 0
            var day = bucketStart
            while day <= bucketEnd {
                let entry = byDate[format.string(from: day)]
                value += entry?.value ?? 0
                count += entry?.count ?? 0
                day = day.addingTimeInterval(86_400)
            }
            buckets.append(SeriesBucket(start: format.string(from: bucketStart), end: format.string(from: bucketEnd), value: value, count: count))
            offset += size
        }
        return (size == 7, buckets)
    }
}
