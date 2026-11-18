import SwiftUI

/// sidebar-row.scss on the phone: the type, height, corners and the pressed and selected looks
/// of every SidebarWidget list row, one entry per variant. Rows read these values only, so
/// making the variants match means editing this table.
struct SidebarRowTokens {
    enum Face { case arial, roboto }

    var face: Face
    var fontSize: CGFloat
    var lineHeight: CGFloat?
    /// A collapsible group's row (a project), where it differs from an item's.
    var groupLineHeight: CGFloat?
    var weight: CGFloat = 400
    var activeWeight: CGFloat = 400
    var color: Color
    var activeColor: Color
    var minHeight: CGFloat
    var groupMinHeight: CGFloat?
    var childMinHeight: CGFloat?
    /// Corners of the selected fill; 0 leaves the row square.
    var radius: CGFloat
    var activeFill: Color
    var pressedFill: Color
    /// Corners of the pressed fill; 0 leaves it square.
    var pressedRadius: CGFloat

    static let history = SidebarRowTokens(
        face: .arial,
        fontSize: 15.2,
        lineHeight: 19.76,
        groupLineHeight: 18.24,
        activeWeight: 700,
        color: AppTheme.textSecondary,
        activeColor: AppTheme.textPrimary,
        minHeight: 62,
        groupMinHeight: 48,
        radius: 0,
        activeFill: AppTheme.backgroundSelected,
        pressedFill: AppTheme.backgroundHover,
        pressedRadius: 0
    )

    static let directory = SidebarRowTokens(
        face: .arial,
        fontSize: 15.2,
        lineHeight: 19.76,
        activeWeight: 700,
        color: AppTheme.textSecondary,
        activeColor: AppTheme.textPrimary,
        minHeight: 48,
        radius: DSRadius.sm,
        activeFill: AppTheme.backgroundSelected,
        pressedFill: AppTheme.backgroundHover,
        pressedRadius: DSRadius.sm
    )

    /// Memory's scope rows keep 6pt corners and a secondary selected label, where the Agents
    /// rows have 4pt and the primary label.
    static let directoryMemory: SidebarRowTokens = {
        var tokens = directory
        tokens.radius = DSRadius.md
        tokens.activeColor = AppTheme.textSecondary
        return tokens
    }()

    static let menu = SidebarRowTokens(
        face: .roboto,
        fontSize: 15,
        weight: 400,
        activeWeight: 500,
        color: AppTheme.textSecondary,
        activeColor: AppTheme.textPrimary,
        minHeight: 48,
        childMinHeight: 44,
        radius: DSRadius.md,
        activeFill: AppTheme.backgroundSelected,
        pressedFill: AppTheme.backgroundHover,
        pressedRadius: DSRadius.sm
    )
}

extension View {
    /// A row label's type and colour; `active` also covers a section holding the current page.
    @ViewBuilder
    func sidebarRowText(_ tokens: SidebarRowTokens, active: Bool = false, group: Bool = false) -> some View {
        let lineHeight = group ? (tokens.groupLineHeight ?? tokens.lineHeight) : tokens.lineHeight
        switch tokens.face {
        case .arial:
            self.webText(arial: tokens.fontSize, bold: active && tokens.activeWeight >= 700, lineHeight: lineHeight)
                .foregroundStyle(active ? tokens.activeColor : tokens.color)
        case .roboto:
            self.webText(tokens.fontSize, active ? tokens.activeWeight : tokens.weight, lineHeight: lineHeight)
                .foregroundStyle(active ? tokens.activeColor : tokens.color)
        }
    }

    /// The selected fill behind a row.
    @ViewBuilder
    func sidebarRowFill(_ tokens: SidebarRowTokens, active: Bool) -> some View {
        if tokens.radius > 0 {
            self.background(active ? tokens.activeFill : Color.clear)
                .clipShape(RoundedRectangle(cornerRadius: tokens.radius))
        } else {
            self.background(active ? tokens.activeFill : Color.clear)
        }
    }
}

/// A row's pressed look, from its variant's tokens.
struct SidebarRowPressStyle: ButtonStyle {
    let tokens: SidebarRowTokens

    init(_ tokens: SidebarRowTokens) {
        self.tokens = tokens
    }

    func makeBody(configuration: Configuration) -> some View {
        if tokens.pressedRadius > 0 {
            configuration.label
                .background(configuration.isPressed ? tokens.pressedFill : Color.clear)
                .clipShape(RoundedRectangle(cornerRadius: tokens.pressedRadius))
        } else {
            configuration.label
                .background(configuration.isPressed ? tokens.pressedFill : Color.clear)
        }
    }
}
