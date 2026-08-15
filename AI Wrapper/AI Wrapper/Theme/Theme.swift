import SwiftUI

/// Theme colors mirroring src/styles/themes.scss (light `:root` / `[data-theme="dark"]`).
enum AppTheme {
    static func dynamic(light: String, dark: String) -> Color {
        Color(UIColor { traits in
            UIColor(Color(hex: traits.userInterfaceStyle == .dark ? dark : light))
        })
    }

    static let primary = dynamic(light: "#006BE8", dark: "#0A84FF")
    static let primaryPressed = dynamic(light: "#005BC5", dark: "#005A9E")
    static let primaryLight = dynamic(light: "#E6F3FF", dark: "#1C2A3A")
    static let success = dynamic(light: "#3C7267", dark: "#32D74B")
    static let error = dynamic(light: "#C62828", dark: "#FF6B6B")
    static let background = dynamic(light: "#F5F5F5", dark: "#1C1C1E")
    static let backgroundSecondary = dynamic(light: "#FFFFFF", dark: "#2C2C2E")
    static let backgroundTertiary = dynamic(light: "#ECECEC", dark: "#3A3A3C")
    static let backgroundHover = dynamic(light: "#F4F4F4", dark: "#48484A")
    static let backgroundSelected = dynamic(light: "#E6F3FF", dark: "#1C2A3A")
    static let responseContainerBackground = dynamic(light: "#FFFFFF", dark: "#3A3A3C")
    static let textPrimary = dynamic(light: "#2C2C2C", dark: "#FFFFFF")
    static let textSecondary = dynamic(light: "#2C2C2C", dark: "#E5E5E7")
    static let textMuted = dynamic(light: "#6B6B6B", dark: "#9CA3AF")
    static let border = dynamic(light: "#CFCFCE", dark: "#48484A")
    static let borderLight = dynamic(light: "#CFCFCE", dark: "#3A3A3C")
    static let sidebarBackground = dynamic(light: "#E8E8E7", dark: "#2C2C2E")
    // Navbar keeps the same colors in both themes (web does not override in dark)
    static let navbarBackground = Color(hex: "#252526")
    static let navbarText = Color.white
    static let conversationHeaderBackground = Color(hex: "#687077")
    static let conversationHeaderText = Color.white
    static let disabled = dynamic(light: "#DEDEDE", dark: "#48484A")
    static let disabledText = dynamic(light: "#454545", dark: "#636366")
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

    var label: String {
        switch self {
        case .light: return "☀️ Light"
        case .system: return "💻 System"
        case .dark: return "🌙 Dark"
        }
    }

    var colorScheme: ColorScheme? {
        switch self {
        case .light: return .light
        case .dark: return .dark
        case .system: return nil
        }
    }
}
