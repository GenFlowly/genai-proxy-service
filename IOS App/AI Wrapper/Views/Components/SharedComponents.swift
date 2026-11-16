import SwiftUI

// MARK: - Icon (web <Icon src=... size=...>, mask-image + currentColor)

struct WebIcon: View {
    var name: String
    var size: CGFloat = 20
    var color: Color?

    var body: some View {
        Image(name)
            .renderingMode(.template)
            .resizable()
            .scaledToFit()
            .frame(width: size, height: size)
            .foregroundStyle(color ?? AppTheme.textPrimary)
    }
}

/// Dims on press, the web buttons' `:active` feedback.
struct WebPressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.opacity(configuration.isPressed ? 0.7 : 1)
    }
}

// MARK: - PillButton (PillButton.module.scss: radius 100, h 38, padding 0 1rem, 14.4/500)

enum PillStyle {
    case primary, secondary, danger
}

struct PillButton<Label: View>: View {
    static var horizontalPadding: CGFloat { 16 }

    var style: PillStyle = .primary
    var disabled = false
    var fullWidth = false
    /// `min-width: min(120px, 100%)` — 120 in block contexts; a cramped flex row
    /// (the response action bar) lets it shrink to its content.
    var minWidth: CGFloat? = 120
    var action: () -> Void
    @ViewBuilder var label: Label

    init(style: PillStyle = .primary, disabled: Bool = false, fullWidth: Bool = false, minWidth: CGFloat? = 120, action: @escaping () -> Void, @ViewBuilder label: () -> Label) {
        self.style = style
        self.disabled = disabled
        self.fullWidth = fullWidth
        self.minWidth = minWidth
        self.action = action
        self.label = label()
    }

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                label
            }
            .webText(14.4, 500)
            // `.secondary` and `.danger` add a 1pt border to the box (danger's is its own red, so only
            // its width shows); `.primary` has none.
            .padding(.horizontal, Self.horizontalPadding + (style == .primary ? 0 : 1))
            .frame(minWidth: minWidth, minHeight: 38)
            .frame(maxWidth: fullWidth ? .infinity : nil)
            .background(background)
            .foregroundStyle(foreground)
            .clipShape(Capsule())
            .overlay {
                if style == .secondary {
                    Capsule().strokeBorder(AppTheme.border, lineWidth: 1)
                }
            }
            .shadow(color: style != .secondary && !disabled ? .black.opacity(0.15) : .clear, radius: 1.5, y: 1)
        }
        .buttonStyle(WebPressStyle())
        .disabled(disabled)
        .opacity(disabled ? 0.5 : 1)
    }

    private var background: Color {
        switch style {
        case .primary: return AppTheme.buttonPrimary
        case .secondary: return .clear
        case .danger: return AppTheme.buttonDanger
        }
    }

    private var foreground: Color {
        switch style {
        case .primary, .danger: return .white
        case .secondary: return AppTheme.textPrimary
        }
    }
}

extension PillButton where Label == PillButtonLabel {
    init(label: String, icon: String? = nil, style: PillStyle = .primary, disabled: Bool = false, fullWidth: Bool = false, minWidth: CGFloat? = 120, action: @escaping () -> Void) {
        self.init(style: style, disabled: disabled, fullWidth: fullWidth, minWidth: minWidth, action: action) {
            PillButtonLabel(text: label, icon: icon, iconColor: style == .secondary ? AppTheme.textPrimary : .white)
        }
    }
}

struct PillButtonLabel: View {
    let text: String
    let icon: String?
    let iconColor: Color

    var body: some View {
        if let icon { WebIcon(name: icon, size: 16, color: iconColor) }
        FitContent { Text(text).multilineTextAlignment(.center) }
    }
}

/// `width: fit-content`: text that had to wrap fills the room it was given rather than hugging
/// its longest line, which is what decides where its neighbors sit.
struct FitContent: Layout {
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        guard let text = subviews.first else { return .zero }
        let natural = text.sizeThatFits(.unspecified)
        guard let width = proposal.width, width < natural.width else { return natural }
        return CGSize(width: width, height: text.sizeThatFits(ProposedViewSize(width: width, height: nil)).height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        subviews.first?.place(at: CGPoint(x: bounds.midX, y: bounds.midY), anchor: .center, proposal: ProposedViewSize(bounds.size))
    }
}

// MARK: - RectangleButton (padding 10/24/10/16, h 38, radius 4, Arial 13.33 — no font set)

struct RectangleButton: View {
    var label: String
    var icon: String?
    var disabled = false
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Text(label).webText(arial: 13.3333)
                if let icon {
                    WebIcon(name: icon, size: 13.33, color: .white)
                }
            }
            .foregroundStyle(.white)
            .padding(.leading, 17)
            .padding(.trailing, 25)
            .frame(height: 38)
            .background(disabled ? AppTheme.disabled : AppTheme.buttonPrimary)
            .clipShape(RoundedRectangle(cornerRadius: 4))
        }
        .buttonStyle(WebPressStyle())
        .disabled(disabled)
        .opacity(disabled ? 0.5 : 1)
    }
}

// MARK: - CopyToClipboard (sm secondary: 6.4/12.8 padding, 1pt border, icon 1.2em)

struct CopyToClipboardButton: View {
    let content: String
    let accessibilityLabel: String
    @State private var copied = false

    var body: some View {
        Button {
            UIPasteboard.general.string = content
            copied = true
            Task {
                try? await Task.sleep(nanoseconds: 2_000_000_000)
                copied = false
            }
        } label: {
            Group {
                if copied {
                    Text("✓").webText(arial: 12, bold: true)
                } else {
                    WebIcon(name: "copy-icon", size: 14.4, color: AppTheme.legacyText)
                }
            }
            .foregroundStyle(AppTheme.legacyText)
            .frame(minHeight: 17.4)
            .padding(.horizontal, 13.8)
            .padding(.vertical, 7.4)
            .background(AppTheme.legacyGray)
            .clipShape(RoundedRectangle(cornerRadius: DSRadius.sm))
            .overlay(RoundedRectangle(cornerRadius: DSRadius.sm).strokeBorder(AppTheme.legacyBorder, lineWidth: 1))
        }
        .buttonStyle(WebPressStyle())
        .disabled(content.isEmpty)
        .accessibilityLabel(accessibilityLabel)
    }
}

// MARK: - CheckboxButtonGroup (PillButtonGroup.module.scss)

/// Capped multi-select: options toggle independently until `maxSelection`, then a new
/// pick evicts the oldest; `allowEmpty` false keeps the last selected one selected.
struct CheckboxButtonGroup: View {
    struct Option: Identifiable {
        let id: String
        let label: String
    }

    let options: [Option]
    let selected: [String]
    let maxSelection: Int
    var allowEmpty = false
    var showCheckbox = true
    let onChange: ([String]) -> Void

    var body: some View {
        HStack(spacing: -1) {
            ForEach(Array(options.enumerated()), id: \.element.id) { index, option in
                let isActive = selected.contains(option.id)
                Button { toggle(option.id) } label: {
                    HStack(spacing: DSSpacing.xs) {
                        if showCheckbox { checkbox(isActive) }
                        Text(option.label).webText(arial: 16, lineHeight: 24)
                    }
                    .foregroundStyle(isActive ? Color.white : AppTheme.textPrimary)
                    .padding(.horizontal, 17)
                    .padding(.vertical, 9)
                    .background(isActive ? AppTheme.primaryPressed : Color.clear)
                    .clipShape(segmentShape(index))
                    .overlay(segmentShape(index).strokeBorder(isActive ? AppTheme.primary : AppTheme.border, lineWidth: 1))
                    .shadow(color: isActive ? .black.opacity(0.15) : .clear, radius: 1.5, y: 1)
                }
                .buttonStyle(.plain)
                .zIndex(isActive ? 2 : 0)
                .accessibilityLabel(L("common.pillButtonGroup.toggleOption", ["label": option.label]))
                .accessibilityAddTraits(isActive ? .isSelected : [])
            }
        }
    }

    private func checkbox(_ on: Bool) -> some View {
        ZStack {
            RoundedRectangle(cornerRadius: 4)
                .stroke(lineWidth: 1.5)
                .frame(width: 15, height: 15)
            if on {
                // Checkmark drawn from two borders of a rotated rectangle.
                Path { path in
                    path.move(to: CGPoint(x: 3.4, y: 7.8))
                    path.addLine(to: CGPoint(x: 6.2, y: 10.6))
                    path.addLine(to: CGPoint(x: 11.6, y: 4.4))
                }
                .stroke(style: StrokeStyle(lineWidth: 2))
                .frame(width: 15, height: 15)
            }
        }
        .opacity(on ? 1 : 0.75)
    }

    private func segmentShape(_ index: Int) -> UnevenRoundedRectangle {
        let radius: CGFloat = 100
        return UnevenRoundedRectangle(
            topLeadingRadius: index == 0 ? radius : 0,
            bottomLeadingRadius: index == 0 ? radius : 0,
            bottomTrailingRadius: index == options.count - 1 ? radius : 0,
            topTrailingRadius: index == options.count - 1 ? radius : 0,
            style: .circular
        )
    }

    private func toggle(_ id: String) {
        var next: [String]
        if selected.contains(id) {
            next = selected.filter { $0 != id }
        } else if selected.count >= maxSelection {
            next = Array(selected.suffix(maxSelection - 1)) + [id]
        } else {
            next = selected + [id]
        }
        if !allowEmpty && next.isEmpty { return }
        onChange(next)
    }
}

// MARK: - Brand names (BrandName.tsx — vendor logos were removed from the web)

/// Full vendor name, plain text, from the provider catalog.
struct VendorBrandName: View {
    let vendor: AIVendor
    @ObservedObject private var catalog = ProviderCatalog.shared

    var body: some View {
        Text(catalog.displayName(for: vendor.rawValue))
    }
}

/// Collapsed contexts: just the vendor's initial, no badge chrome.
struct CollapsedVendorBrandName: View {
    let vendorId: String
    var size: CGFloat = 20
    @ObservedObject private var catalog = ProviderCatalog.shared

    var body: some View {
        let name = catalog.displayName(for: vendorId)
        let fontSize = max(10, (size * 0.75).rounded())
        Text(String(name.prefix(1)).uppercased())
            .webText(arial: fontSize, bold: true, lineHeight: fontSize)
            .foregroundStyle(AppTheme.textSecondary)
            .frame(width: size, height: size)
            .accessibilityLabel(name)
    }
}

/// User name + 24pt avatar (falls back to the web's user-circle icon).
struct UserBrandName: View {
    let name: String
    let picture: String?

    var body: some View {
        HStack(spacing: 8) {
            AvatarImage(picture: picture, size: 24)
            WebTruncatedLine(name).webText(16, 500, lineHeight: 27.2).foregroundStyle(AppTheme.textPrimary)
        }
    }
}

struct AvatarImage: View {
    let picture: String?
    let size: CGFloat
    var placeholderColor: Color = AppTheme.textPrimary

    var body: some View {
        if let picture, let url = URL(string: picture) {
            AsyncImage(url: url) { image in
                image.resizable().scaledToFill()
            } placeholder: {
                WebIcon(name: "user-circle", size: size, color: placeholderColor)
            }
            .frame(width: size, height: size)
            .clipShape(Circle())
        } else {
            WebIcon(name: "user-circle", size: size, color: placeholderColor)
        }
    }
}

// MARK: - Backdrop blur

/// `backdrop-filter: blur(Npx)` without the tint a system material adds: a blur effect
/// held at a fraction of its animation, the public way to get a light blur.
struct BackdropBlur: UIViewRepresentable {
    var fraction: CGFloat = 0.12

    func makeUIView(context: Context) -> BackdropBlurView { BackdropBlurView(fraction: fraction) }
    func updateUIView(_ uiView: BackdropBlurView, context: Context) {}
}

final class BackdropBlurView: UIVisualEffectView {
    private var animator: UIViewPropertyAnimator?
    private var hasLaidOut = false
    private let fraction: CGFloat

    init(fraction: CGFloat) {
        self.fraction = fraction
        super.init(effect: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(restart), name: UIApplication.didBecomeActiveNotification, object: nil)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        if window != nil { restart() } else { stop() }
    }

    /// An animator started before the view has a size (lazily built scroll content) lands
    /// on the full effect instead of the fraction, so it starts over at first layout.
    override func layoutSubviews() {
        super.layoutSubviews()
        guard !hasLaidOut, window != nil, !bounds.isEmpty else { return }
        hasLaidOut = true
        restart()
    }

    @objc private func restart() {
        guard window != nil else { return }
        stop()
        effect = nil
        let animator = UIViewPropertyAnimator(duration: 1, curve: .linear) { [weak self] in
            guard let self else { return }
            self.effect = UIBlurEffect(style: .regular)
        }
        animator.pausesOnCompletion = true
        animator.fractionComplete = fraction
        self.animator = animator
    }

    private func stop() {
        animator?.stopAnimation(true)
        animator = nil
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

/// Key window insets, for the web's `max(0.5rem, env(safe-area-inset-top))` rule.
/// `--mobile-header-height`: 3rem + 0.5rem. The web's viewport (status-bar-style
/// "default") starts below the status bar, so no safe-area term applies from there.
let mobileHeaderHeight: CGFloat = 56

extension View {
    /// The status bar as a browser shows it: an opaque band scrolling content never
    /// shows through.
    func statusBarBand() -> some View {
        overlay(alignment: .top) {
            AppTheme.background
                .ignoresSafeArea(edges: .top)
                .frame(height: 0)
                .allowsHitTesting(false)
        }
    }
}
