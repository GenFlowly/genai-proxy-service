import SwiftUI

/// Theme colors mirroring component-library styles/themes.scss (light `:root` /
/// `[data-theme="dark"]`). `AppTheme.UI` holds the same tokens as dynamic UIColors
/// for the UIKit text views.
enum AppTheme {
    enum UI {
        static func dynamic(light: String, dark: String) -> UIColor {
            UIColor { $0.userInterfaceStyle == .dark ? UIColor(hex: dark) : UIColor(hex: light) }
        }

        static let primary = dynamic(light: "#006BE8", dark: "#0A84FF")
        static let error = dynamic(light: "#C62828", dark: "#FF6B6B")
        static let background = dynamic(light: "#F5F5F5", dark: "#1C1C1E")
        static let backgroundSecondary = dynamic(light: "#FFFFFF", dark: "#2C2C2E")
        static let backgroundTertiary = dynamic(light: "#ECECEC", dark: "#3A3A3C")
        static let textPrimary = dynamic(light: "#2C2C2C", dark: "#FFFFFF")
        static let textSecondary = dynamic(light: "#2C2C2C", dark: "#E5E5E7")
        static let textMuted = dynamic(light: "#6B6B6B", dark: "#9CA3AF")
        static let border = dynamic(light: "#CFCFCE", dark: "#48484A")
        static let borderLight = dynamic(light: "#CFCFCE", dark: "#3A3A3C")
        /// In dark the tertiary surface equals the mobile response surface, so code
        /// surfaces use secondary there (TextContainer.module.scss).
        static let codeSurface = dynamic(light: "#ECECEC", dark: "#2C2C2E")
        static let rule = UIColor(hex: "#808080")
        static let composerText = dynamic(light: "#24292F", dark: "#C9D1D9")
        static let composerActiveLine = UIColor { traits in
            traits.userInterfaceStyle == .dark
                ? UIColor(red: 110 / 255, green: 118 / 255, blue: 129 / 255, alpha: 0.4)
                : UIColor(red: 175 / 255, green: 184 / 255, blue: 193 / 255, alpha: 0.2)
        }
    }

    static func dynamic(light: String, dark: String) -> Color {
        Color(uiColor: UI.dynamic(light: light, dark: dark))
    }

    static let primary = Color(uiColor: UI.primary)
    /// Web `--color-button-primary` — deliberately darker than the accent so white
    /// text keeps >=4.5:1 contrast.
    static let buttonPrimary = dynamic(light: "#006BE8", dark: "#0070E0")
    static let buttonDanger = Color(hex: "#DC2626")
    static let primaryPressed = dynamic(light: "#005BC5", dark: "#005A9E")
    static let primaryLight = dynamic(light: "#E6F3FF", dark: "#1C2A3A")
    static let success = dynamic(light: "#3C7267", dark: "#32D74B")
    static let error = Color(uiColor: UI.error)
    static let background = Color(uiColor: UI.background)
    static let backgroundSecondary = Color(uiColor: UI.backgroundSecondary)
    static let backgroundTertiary = Color(uiColor: UI.backgroundTertiary)
    static let backgroundHover = dynamic(light: "#F4F4F4", dark: "#48484A")
    static let backgroundSelected = dynamic(light: "#E6F3FF", dark: "#1C2A3A")
    static let responseContainerBackground = dynamic(light: "#FFFFFF", dark: "#3A3A3C")
    static let codeSurface = Color(uiColor: UI.codeSurface)
    /// Prompt composer (CodeMirror) surface — GitHub theme background.
    static let composerEditorBackground = dynamic(light: "#F6F8FA", dark: "#161B22")
    /// Attach button: `$color-background-secondary`.
    static let composerAttachButton = backgroundSecondary
    /// `--shadow-sm`.
    static let shadowSmall = Color(uiColor: UIColor { UIColor.black.withAlphaComponent($0.userInterfaceStyle == .dark ? 0.3 : 0.05) })
    /// sidebar-card.scss: `--sidebar-material`, `--sidebar-hairline` and its drop shadow.
    static let sidebarMaterial = Color(uiColor: UIColor {
        $0.userInterfaceStyle == .dark
            ? UIColor(red: 38 / 255, green: 38 / 255, blue: 42 / 255, alpha: 0.72)
            : UIColor(red: 243 / 255, green: 243 / 255, blue: 246 / 255, alpha: 0.78)
    })
    /// `--sidebar-surface`: the card over the page background as one opaque colour, for headings
    /// that stay put while the card's rows scroll beneath them.
    static let sidebarSurface = Color(uiColor: UIColor {
        $0.userInterfaceStyle == .dark
            ? UIColor(red: (0.72 * 38 + 0.28 * 28) / 255, green: (0.72 * 38 + 0.28 * 28) / 255, blue: (0.72 * 42 + 0.28 * 30) / 255, alpha: 1)
            : UIColor(red: (0.78 * 243 + 0.22 * 245) / 255, green: (0.78 * 243 + 0.22 * 245) / 255, blue: (0.78 * 246 + 0.22 * 245) / 255, alpha: 1)
    })
    static let sidebarHairline = Color(uiColor: UIColor {
        $0.userInterfaceStyle == .dark ? UIColor.white.withAlphaComponent(0.09) : UIColor.black.withAlphaComponent(0.08)
    })
    static let sidebarShadow = Color(uiColor: UIColor { UIColor.black.withAlphaComponent($0.userInterfaceStyle == .dark ? 0.35 : 0.05) })
    static let systemBadgeText = dynamic(light: "#B06F00", dark: "#F5B544")
    static let textPrimary = Color(uiColor: UI.textPrimary)
    static let textSecondary = Color(uiColor: UI.textSecondary)
    static let textMuted = Color(uiColor: UI.textMuted)
    static let textLight = dynamic(light: "#6B6B6B", dark: "#AEAEB2")
    static let border = Color(uiColor: UI.border)
    static let borderLight = Color(uiColor: UI.borderLight)
    static let sidebarBackground = dynamic(light: "#E8E8E7", dark: "#2C2C2E")
    // Navbar keeps the same colors in both themes (web does not override in dark)
    static let navbarBackground = Color(hex: "#252526")
    static let navbarText = Color.white
    /// Translucent chip behind the mobile header controls — web `rgba(127,127,127,.18)`.
    static let navbarControl = Color(red: 127 / 255, green: 127 / 255, blue: 127 / 255).opacity(0.18)
    /// Instruction name in the header pill — `$color-text-secondary`.
    static let navbarSubtleText = textSecondary
    static let conversationHeaderBackground = Color(hex: "#687077")
    static let conversationHeaderText = Color.white
    static let disabled = dynamic(light: "#DEDEDE", dark: "#48484A")
    static let disabledText = dynamic(light: "#454545", dark: "#636366")
    /// Legacy static tokens CopyToClipboard still uses (`$background-gray`,
    /// `$border-color`, `$text-primary` in variables.scss) — same in both themes.
    static let legacyGray = Color(hex: "#F9FAFB")
    static let legacyBorder = Color(hex: "#D1D5DB")
    static let legacyText = Color(hex: "#1F2937")
}

extension UIColor {
    convenience init(hex: String) {
        var value: UInt64 = 0
        Scanner(string: hex.replacingOccurrences(of: "#", with: "")).scanHexInt64(&value)
        self.init(
            red: CGFloat((value >> 16) & 0xFF) / 255,
            green: CGFloat((value >> 8) & 0xFF) / 255,
            blue: CGFloat(value & 0xFF) / 255,
            alpha: 1
        )
    }
}

extension Color {
    init(hex: String) {
        var value: UInt64 = 0
        Scanner(string: hex.replacingOccurrences(of: "#", with: "")).scanHexInt64(&value)
        self.init(
            .sRGB,
            red: Double((value >> 16) & 0xFF) / 255,
            green: Double((value >> 8) & 0xFF) / 255,
            blue: Double(value & 0xFF) / 255,
            opacity: 1
        )
    }
}

/// Mirrors src/context/ThemeContext.tsx — light | dark | system, persisted.
enum ThemeMode: String, CaseIterable, Identifiable {
    case light, system, dark

    var id: String { rawValue }

    var colorScheme: ColorScheme? {
        switch self {
        case .light: return .light
        case .dark: return .dark
        case .system: return nil
        }
    }
}
