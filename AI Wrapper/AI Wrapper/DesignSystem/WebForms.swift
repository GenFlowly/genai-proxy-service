import SwiftUI

// MARK: - Input with hint (mixins.scss input-with-hint-*)

/// 42pt row with a 1pt border (primary while focused), radius 4, an optional tinted
/// `hint` prefix and a 16pt field.
struct InputTextWithHint: View {
    var hint: String?
    var placeholder: String = ""
    @Binding var text: String
    var isSecure = false
    var disabled = false
    var keyboard: UIKeyboardType = .default
    var autofocus = false

    @State private var focused = false

    #if DEBUG
    /// Headless capture: keeps the keyboard down, via `--no-autofocus`.
    private static let suppressAutofocus = CommandLine.arguments.contains("--no-autofocus")
    #else
    private static let suppressAutofocus = false
    #endif

    var body: some View {
        HStack(spacing: 0) {
            if let hint { HintPrefix(text: hint) }
            WebInputField(text: $text, isFocused: $focused, font: DSFont.uiArial(16), isSecure: isSecure, disabled: disabled, keyboard: keyboard)
                .accessibilityLabel(hint ?? placeholder)
                .inputPlaceholder(placeholder, isEmpty: text.isEmpty, font: DSFont.uiArial(16))
                .padding(.horizontal, 16)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .inputWithHintContainer(focused: focused)
        .onAppear { if autofocus, !Self.suppressAutofocus { focused = true } }
    }
}

/// `<input>`: text that doesn't fit is clipped, where a SwiftUI `TextField` ellipsizes it while
/// it isn't focused.
struct WebInputField: UIViewRepresentable {
    @Binding var text: String
    @Binding var isFocused: Bool
    let font: UIFont
    var isSecure = false
    var disabled = false
    var keyboard: UIKeyboardType = .default

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> UITextField {
        let field = UITextField()
        field.delegate = context.coordinator
        field.autocapitalizationType = .none
        field.autocorrectionType = .no
        field.spellCheckingType = .no
        field.tintColor = AppTheme.UI.primary
        // An `<input>` clips its value at the padding. A text field that isn't being edited
        // draws a long value past its own bounds.
        field.clipsToBounds = true
        let style = NSMutableParagraphStyle()
        style.lineBreakMode = .byClipping
        field.defaultTextAttributes = [.font: font, .foregroundColor: AppTheme.UI.textPrimary, .paragraphStyle: style]
        field.setContentHuggingPriority(.defaultLow, for: .horizontal)
        field.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        field.addTarget(context.coordinator, action: #selector(Coordinator.textChanged(_:)), for: .editingChanged)
        return field
    }

    func updateUIView(_ field: UITextField, context: Context) {
        context.coordinator.parent = self
        if field.text != text { field.text = text }
        field.isSecureTextEntry = isSecure
        field.isEnabled = !disabled
        field.keyboardType = keyboard
        if isFocused, !field.isFirstResponder, !context.coordinator.isEnding {
            DispatchQueue.main.async { field.becomeFirstResponder() }
        }
    }

    final class Coordinator: NSObject, UITextFieldDelegate {
        var parent: WebInputField?
        var isEnding = false

        @objc func textChanged(_ field: UITextField) {
            parent?.text = field.text ?? ""
        }

        func textFieldDidBeginEditing(_ textField: UITextField) {
            parent?.isFocused = true
        }

        func textFieldDidEndEditing(_ textField: UITextField) {
            isEnding = true
            parent?.isFocused = false
            DispatchQueue.main.async { self.isEnding = false }
        }

        func textFieldShouldReturn(_ textField: UITextField) -> Bool {
            textField.resignFirstResponder()
            return true
        }
    }
}

/// `border: 1px dashed`. Chrome draws 3 on and 2 off, then stretches the gap so that the dashes
/// come out even around the whole box.
struct WebDashedBorder: View {
    private static let dash: CGFloat = 3
    private static let gap: CGFloat = 2

    let color: Color
    let cornerRadius: CGFloat

    /// `StrokeData::SelectBestDashGap`, for a closed path.
    static func bestGap(strokeLength: CGFloat) -> CGFloat {
        let fewest = (strokeLength / (dash + gap)).rounded(.down)
        let most = fewest + 1
        let fewestGap = (strokeLength - fewest * dash) / fewest
        let mostGap = (strokeLength - most * dash) / most
        return mostGap <= 0 || abs(fewestGap - gap) < abs(mostGap - gap) ? fewestGap : mostGap
    }

    var body: some View {
        GeometryReader { proxy in
            let radius = max(cornerRadius - 0.5, 0)
            let length = 2 * (proxy.size.width + proxy.size.height - 2) - 8 * radius + 2 * .pi * radius
            RoundedRectangle(cornerRadius: cornerRadius)
                .strokeBorder(color, style: StrokeStyle(lineWidth: 1, dash: [Self.dash, Self.bestGap(strokeLength: length)]))
        }
    }
}

/// A browser blurs an input on a tap anywhere outside it, which takes a phone's keyboard away.
/// UIKit keeps it up. The tap still reaches whatever it landed on.
struct TapOutsideEndsEditing: UIViewRepresentable {
    final class InstallerView: UIView, UIGestureRecognizerDelegate {
        private lazy var recognizer: UITapGestureRecognizer = {
            let recognizer = UITapGestureRecognizer(target: self, action: #selector(tapped))
            recognizer.cancelsTouchesInView = false
            recognizer.delegate = self
            return recognizer
        }()

        override func didMoveToWindow() {
            super.didMoveToWindow()
            recognizer.view?.removeGestureRecognizer(recognizer)
            window?.addGestureRecognizer(recognizer)
        }

        @objc private func tapped() {
            window?.endEditing(true)
        }

        func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
            var view = touch.view
            while let current = view {
                if current is UITextField || (current as? UITextView)?.isEditable == true || current is ComposerCompletionPopup {
                    return false
                }
                view = current.superview
            }
            return true
        }

        func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer) -> Bool {
            true
        }
    }

    func makeUIView(context: Context) -> InstallerView {
        let view = InstallerView()
        view.isUserInteractionEnabled = false
        return view
    }

    func updateUIView(_ uiView: InstallerView, context: Context) {}
}

extension View {
    /// An `<input>`'s placeholder: too long for the field, it is clipped rather than truncated.
    func inputPlaceholder(_ placeholder: String, isEmpty: Bool, font: UIFont) -> some View {
        overlay(alignment: .leading) {
            if isEmpty {
                Text(placeholder)
                    .modifier(WebFontModifier(uiFont: font))
                    .foregroundStyle(AppTheme.textMuted)
                    .lineLimit(1)
                    .fixedSize()
                    .frame(minWidth: 0, maxWidth: .infinity, alignment: .leading)
                    .clipShape(HorizontalClip())
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
            }
        }
    }
}

private struct HintPrefix: View {
    let text: String

    var body: some View {
        Text(text)
            .webText(14, 500)
            .foregroundStyle(AppTheme.textSecondary)
            .lineLimit(1)
            .fixedSize()
            .padding(.leading, 16)
            .padding(.trailing, 17)
            .frame(maxHeight: .infinity)
            .background(AppTheme.backgroundTertiary)
    }
}

private extension View {
    func inputWithHintContainer(focused: Bool) -> some View {
        padding(1)
            .frame(height: 42)
            .background(AppTheme.backgroundSecondary)
            .clipShape(RoundedRectangle(cornerRadius: DSRadius.sm))
            .overlay(RoundedRectangle(cornerRadius: DSRadius.sm).strokeBorder(focused ? AppTheme.primary : AppTheme.borderLight, lineWidth: 1))
    }
}

/// A `<select>` with the same prefix. Empty `value` shows `placeholder`; like the web's
/// hidden placeholder option it can't be re-picked once a value is chosen.
struct InputSelectWithHint: View {
    struct Option: Identifiable, Hashable {
        let value: String
        let label: String
        var id: String { value }
    }

    let hint: String
    var placeholder: String?
    let value: String
    let options: [Option]
    let onChange: (String) -> Void

    /// An unset value shows the placeholder option. A value none of the options carry falls
    /// to the first option, which is what a browser selects.
    private var shown: String {
        if let match = options.first(where: { $0.value == value }) { return match.label }
        if !value.isEmpty, let first = options.first { return first.label }
        return placeholder ?? L("common.inputSelectWithHint.placeholder")
    }

    var body: some View {
        HStack(spacing: 0) {
            HintPrefix(text: hint)
            Menu {
                ForEach(options) { option in
                    Button {
                        onChange(option.value)
                    } label: {
                        if option.value == value {
                            Label(option.label, systemImage: "checkmark")
                        } else {
                            Text(option.label)
                        }
                    }
                }
            } label: {
                NativeSelectLabel(text: shown, font: DSFont.uiArial(16), horizontalPadding: 16)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .contentShape(Rectangle())
            }
            .accessibilityLabel(hint)
        }
        .inputWithHintContainer(focused: false)
    }
}

/// What a native `<select>` draws: its text starts 4pt inside the CSS padding, is centered
/// without the font's line gap, and is clipped (no ellipsis) short of the arrow, which ends
/// 2pt from the edge.
struct NativeSelectLabel: View {
    let text: String
    let font: UIFont
    let horizontalPadding: CGFloat
    var paddingClip: PaddingClip?

    /// Where the line sits and where it gets cut, measured from the top of the box.
    struct PaddingClip {
        let lineTop: CGFloat
        let clipBottom: CGFloat
    }

    private static let internalPaddingStart: CGFloat = 4
    private static let arrowBoxWidth: CGFloat = 12

    private var line: some View {
        Text(text)
            .modifier(WebFontModifier(uiFont: font))
            .foregroundStyle(AppTheme.textPrimary)
            .lineLimit(1)
            .fixedSize()
    }

    var body: some View {
        Group {
            if let paddingClip {
                line
                    .offset(y: paddingClip.lineTop)
                    .frame(minWidth: 0, maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                    .mask(alignment: .top) { Rectangle().frame(height: paddingClip.clipBottom) }
            } else {
                line
                    .offset(y: font.leading.rounded() / 2)
                    .frame(minWidth: 0, maxWidth: .infinity, alignment: .leading)
                    .clipShape(HorizontalClip())
            }
        }
        .padding(.leading, horizontalPadding + Self.internalPaddingStart)
        .padding(.trailing, horizontalPadding + Self.arrowBoxWidth)
        .frame(maxHeight: .infinity)
        .overlay(alignment: .trailing) {
            SelectChevron().padding(.trailing, 2)
        }
    }
}

/// Clips sideways only, so descenders below the line box survive.
struct HorizontalClip: Shape {
    func path(in rect: CGRect) -> Path {
        Path(rect.insetBy(dx: 0, dy: -rect.height))
    }
}

/// The dropdown arrow a native `<select>` draws.
struct SelectChevron: View {
    var body: some View {
        Path { path in
            path.move(to: CGPoint(x: 1, y: 0.5))
            path.addLine(to: CGPoint(x: 5, y: 4.5))
            path.addLine(to: CGPoint(x: 9, y: 0.5))
        }
        .stroke(AppTheme.textPrimary, style: StrokeStyle(lineWidth: 2, lineCap: .butt, lineJoin: .miter))
        .frame(width: 10, height: 5)
        .accessibilityHidden(true)
    }
}

/// Plain `<select>` styled by the `input-field` mixin (agent editor): 40pt tall, 15pt
/// text, 1pt border, radius 6.
struct WebFieldSelect: View {
    let value: String
    let options: [InputSelectWithHint.Option]
    var disabled = false
    let onChange: (String) -> Void

    var body: some View {
        Menu {
            ForEach(options) { option in
                Button {
                    onChange(option.value)
                } label: {
                    if option.value == value {
                        Label(option.label, systemImage: "checkmark")
                    } else {
                        Text(option.label)
                    }
                }
            }
        } label: {
            NativeSelectLabel(
                text: options.first { $0.value == value }?.label ?? "",
                font: DSFont.uiArial(15),
                horizontalPadding: 16,
                paddingClip: Self.paddingClip
            )
            .padding(.horizontal, 1)
            .frame(height: 40)
            .background(AppTheme.backgroundSecondary)
            .clipShape(RoundedRectangle(cornerRadius: DSRadius.md))
            .overlay(RoundedRectangle(cornerRadius: DSRadius.md).strokeBorder(AppTheme.border, lineWidth: 1))
            .contentShape(Rectangle())
        }
        .disabled(disabled)
        .opacity(disabled ? 0.7 : 1)
    }

    /// The mixin's 12pt vertical padding leaves less room than a line, so a browser paints the
    /// text low and cuts it off at the padding edge.
    private static let paddingClip = NativeSelectLabel.PaddingClip(lineTop: 14.4, clipBottom: 27.4)
}

/// `<input>` styled by the `input-field` mixin (agent editor): 40pt tall, 15pt text.
struct WebFieldInput: View {
    @Binding var text: String
    var placeholder: String = ""
    var disabled = false
    var keyboard: UIKeyboardType = .default
    var onFocus: (() -> Void)?

    @State private var focused = false

    var body: some View {
        WebInputField(text: $text, isFocused: $focused, font: DSFont.uiArial(15), disabled: disabled, keyboard: keyboard)
            .accessibilityLabel(placeholder)
            .inputPlaceholder(placeholder, isEmpty: text.isEmpty, font: DSFont.uiArial(15))
            .padding(.horizontal, 17)
            .frame(height: 40)
            .background(AppTheme.backgroundSecondary)
            .clipShape(RoundedRectangle(cornerRadius: DSRadius.md))
            .overlay(RoundedRectangle(cornerRadius: DSRadius.md).strokeBorder(focused ? AppTheme.primary : AppTheme.border, lineWidth: 1))
            .onChange(of: focused) { _, isFocused in
                if isFocused { onFocus?() }
            }
    }
}

/// `<textarea>` styled by the `input-field` mixin (agent editor).
struct WebFieldTextArea: View {
    @Binding var text: String
    var placeholder: String = ""
    var rows: Int = 3
    var mono = false
    var disabled = false
    var hasError = false
    var surface: Color = AppTheme.backgroundSecondary
    var textColor: Color = AppTheme.textPrimary

    @FocusState private var focused: Bool

    private var font: UIFont { mono ? DSFont.uiSFMono(13) : DSFont.uiMono(14) }
    private var lineHeight: CGFloat { mono ? 13 * 1.55 : 14 * 1.55 }

    var body: some View {
        ZStack(alignment: .topLeading) {
            if text.isEmpty {
                Text(placeholder)
                    .font(Font(font as CTFont))
                    .kerning(mono ? DSFont.sfMonoKerning(13) : 0)
                    .foregroundStyle(AppTheme.textMuted)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .allowsHitTesting(false)
            }
            TextEditor(text: $text)
                .focused($focused)
                .font(Font(font as CTFont))
                .kerning(mono ? DSFont.sfMonoKerning(13) : 0)
                .lineSpacing(max(0, lineHeight - font.lineHeight))
                .foregroundStyle(textColor)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .scrollContentBackground(.hidden)
                .disabled(disabled)
                .padding(.horizontal, 9)
                .padding(.vertical, 2)
        }
        .frame(minHeight: CGFloat(rows) * lineHeight + 22)
        .background(surface)
        .clipShape(RoundedRectangle(cornerRadius: DSRadius.md))
        .overlay(RoundedRectangle(cornerRadius: DSRadius.md).strokeBorder(hasError ? Color(hex: "#E74C3C") : (focused ? AppTheme.primary : AppTheme.border), lineWidth: 1))
    }
}

// MARK: - Checkbox / radio (native inputs, accent-color primary)

struct WebCheckbox: View {
    let isOn: Bool
    var size: CGFloat = 13
    var disabled = false
    /// The text beside the box, which a `<label>` would tie to it on the web.
    var label: String = ""
    let onToggle: (Bool) -> Void

    /// Chrome draws 2pt corners on its 13pt box and scales them with the size.
    private static let radiusRatio: CGFloat = 2 / 13
    private static let nativeBorder = Color(hex: "#767676")

    var body: some View {
        Button { onToggle(!isOn) } label: {
            ZStack {
                RoundedRectangle(cornerRadius: size * Self.radiusRatio)
                    .fill(isOn ? AppTheme.primary : Color.white)
                RoundedRectangle(cornerRadius: size * Self.radiusRatio)
                    .strokeBorder(isOn ? AppTheme.primary : Self.nativeBorder, lineWidth: 1)
                if isOn {
                    Image(systemName: "checkmark")
                        .font(.system(size: size * 0.62, weight: .heavy))
                        .foregroundStyle(.white)
                }
            }
            .frame(width: size, height: size)
            .contentShape(Rectangle().inset(by: -8))
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .opacity(disabled ? 0.5 : 1)
        .accessibilityLabel(label)
        .accessibilityAddTraits(isOn ? .isSelected : [])
    }
}

/// Chrome's radio in `accent-color`: always a white disc, a blue border and center when picked.
struct NativeRadioMark: View {
    let isOn: Bool
    var size: CGFloat = 13

    var body: some View {
        ZStack {
            Circle().fill(Color.white)
            Circle().strokeBorder(isOn ? AppTheme.primary : Color(hex: "#767676"), lineWidth: 1)
            if isOn {
                Circle().fill(AppTheme.primary).frame(width: size * 5 / 9, height: size * 5 / 9)
            }
        }
        .frame(width: size, height: size)
    }
}

struct WebRadio: View {
    let isOn: Bool
    var disabled = false
    let label: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                NativeRadioMark(isOn: isOn)
                Text(label)
                    .webText(13)
                    .foregroundStyle(AppTheme.textSecondary)
            }
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .opacity(disabled ? 0.5 : 1)
        .accessibilityAddTraits(isOn ? .isSelected : [])
    }
}

// MARK: - CredentialCard (CredentialCard.module.scss)

enum CredentialPillKind { case ok, unset, neutral }

struct CredentialStatusPill: View {
    let kind: CredentialPillKind
    let text: String

    private var foreground: Color {
        switch kind {
        case .ok: return AppTheme.success
        case .unset: return AppTheme.textMuted
        case .neutral: return AppTheme.textPrimary
        }
    }

    var body: some View {
        Text(text)
            .webText(12, 600)
            .foregroundStyle(foreground)
            .lineLimit(1)
            .fixedSize()
            .padding(.horizontal, 10.6)
            .padding(.vertical, 4.2)
            .overlay(Capsule().strokeBorder(kind == .ok ? AppTheme.success : AppTheme.borderLight, lineWidth: 1))
    }
}

enum WebMessageKind { case success, error }

struct CredentialCard<Label: View, Pills: View, Content: View>: View {
    @ViewBuilder var label: Label
    @ViewBuilder var pills: Pills
    var message: String?
    var messageKind: WebMessageKind?
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 12) {
                    label.fixedSize()
                    Spacer(minLength: 0)
                    HStack(spacing: 8) { pills }
                }
                VStack(alignment: .leading, spacing: 12) {
                    label
                    HStack(spacing: 8) { pills }
                }
            }

            content

            if let message, !message.isEmpty {
                Text(message)
                    .webText(13.6)
                    .foregroundStyle(messageKind == .error ? AppTheme.error : AppTheme.success)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(21)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(AppTheme.borderLight, lineWidth: 1))
    }
}

extension CredentialCard where Label == CredentialCardLabel {
    init(title: String, weight: CGFloat = 600, message: String? = nil, messageKind: WebMessageKind? = nil, @ViewBuilder pills: () -> Pills, @ViewBuilder content: () -> Content) {
        self.label = CredentialCardLabel(text: title, weight: weight)
        self.pills = pills()
        self.message = message
        self.messageKind = messageKind
        self.content = content()
    }
}

struct CredentialCardLabel: View {
    let text: String
    let weight: CGFloat

    var body: some View {
        Text(text).webText(18, weight).foregroundStyle(AppTheme.textPrimary)
    }
}

// MARK: - RadioButtonGroup (PillButtonGroup.module.scss, one pick)

/// `inline-flex; flex-wrap: wrap` of `flex: 1 1 auto` segments with overlapping borders:
/// each row's leftover width is shared equally between that row's segments.
struct RadioButtonGroup: View {
    struct Option: Identifiable {
        let id: String
        let label: String
    }

    let options: [Option]
    let selected: String?
    let onSelect: (String) -> Void

    var body: some View {
        FlexGrowRows(overlap: 1) {
            ForEach(Array(options.enumerated()), id: \.element.id) { index, option in
                let isActive = selected == option.id
                Button { onSelect(option.id) } label: {
                    Text(option.label)
                        .webText(arial: 16, lineHeight: 24)
                        .foregroundStyle(isActive ? Color.white : AppTheme.textPrimary)
                        .lineLimit(1)
                        .fixedSize()
                        .padding(.horizontal, 17)
                        .padding(.vertical, 9)
                        .frame(maxWidth: .infinity)
                        .background(isActive ? AppTheme.primaryPressed : Color.clear)
                        .clipShape(Self.shape(index: index, count: options.count))
                        .overlay(Self.shape(index: index, count: options.count).strokeBorder(isActive ? AppTheme.primary : AppTheme.border, lineWidth: 1))
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .zIndex(isActive ? 2 : 0)
                .accessibilityAddTraits(isActive ? .isSelected : [])
            }
        }
    }

    static func shape(index: Int, count: Int) -> UnevenRoundedRectangle {
        let radius: CGFloat = 100
        return UnevenRoundedRectangle(
            topLeadingRadius: index == 0 ? radius : 0,
            bottomLeadingRadius: index == 0 ? radius : 0,
            bottomTrailingRadius: index == count - 1 ? radius : 0,
            topTrailingRadius: index == count - 1 ? radius : 0,
            style: .circular
        )
    }
}

/// Wrapping rows whose items grow equally to fill the row (`flex: 1 1 auto`).
struct FlexGrowRows: Layout {
    var overlap: CGFloat = 0
    var verticalSpacing: CGFloat = 0

    private struct Row {
        var indexes: [Int] = []
        var width: CGFloat = 0
        var height: CGFloat = 0
    }

    private func rows(_ subviews: Subviews, width: CGFloat) -> [Row] {
        var rows: [Row] = []
        var current = Row()
        for (index, subview) in subviews.enumerated() {
            let size = subview.sizeThatFits(.unspecified)
            // Every item but the very first has the negative margin, even one that starts a line.
            let margin = index == 0 ? 0 : overlap
            let nextWidth = current.width + size.width - margin
            if !current.indexes.isEmpty, nextWidth > width {
                rows.append(current)
                current = Row(indexes: [index], width: size.width - margin, height: size.height)
            } else {
                current.indexes.append(index)
                current.width = nextWidth
                current.height = max(current.height, size.height)
            }
        }
        if !current.indexes.isEmpty { rows.append(current) }
        return rows
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        let laidOut = rows(subviews, width: width)
        let height = laidOut.reduce(0) { $0 + $1.height } + CGFloat(max(laidOut.count - 1, 0)) * verticalSpacing
        return CGSize(width: width.isFinite ? width : (laidOut.map(\.width).max() ?? 0), height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var y = bounds.minY
        for row in rows(subviews, width: bounds.width) {
            let extra = max(0, bounds.width - row.width) / CGFloat(row.indexes.count)
            var x = bounds.minX - (row.indexes.first == 0 ? 0 : overlap)
            for index in row.indexes {
                let natural = subviews[index].sizeThatFits(.unspecified)
                let width = natural.width + extra
                subviews[index].place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(width: width, height: row.height))
                x += width - overlap
            }
            y += row.height + verticalSpacing
        }
    }
}

/// A flex item's horizontal padding: `flex-shrink` weighs only what's inside it.
struct FlexItemPadding: LayoutValueKey {
    static let defaultValue: CGFloat = 0
}

/// `display: flex; justify-content: space-between; align-items: center` whose children shrink
/// in proportion to their content width when they don't fit (`flex-shrink: 1`).
struct FlexShrinkRow: Layout {
    var spacing: CGFloat = 16

    private func widths(_ subviews: Subviews, available: CGFloat) -> [CGFloat] {
        let natural = subviews.map { $0.sizeThatFits(.unspecified).width }
        let room = available - spacing * CGFloat(max(subviews.count - 1, 0))
        let overflow = natural.reduce(0, +) - room
        let weights = zip(natural, subviews).map { $0 - $1[FlexItemPadding.self] }
        let totalWeight = weights.reduce(0, +)
        guard overflow > 0, totalWeight > 0 else { return natural }
        return zip(natural, weights).map { $0 - overflow * $1 / totalWeight }
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? subviews.reduce(0) { $0 + $1.sizeThatFits(.unspecified).width }
        let height = zip(subviews, widths(subviews, available: width))
            .map { $0.sizeThatFits(ProposedViewSize(width: $1, height: nil)).height }
            .max() ?? 0
        return CGSize(width: width, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let resolved = widths(subviews, available: bounds.width)
        let leftover = bounds.width - resolved.reduce(0, +)
        let gap = subviews.count > 1 ? leftover / CGFloat(subviews.count - 1) : 0
        var x = bounds.minX
        for (subview, width) in zip(subviews, resolved) {
            let size = subview.sizeThatFits(ProposedViewSize(width: width, height: nil))
            subview.place(at: CGPoint(x: x, y: bounds.midY - size.height / 2), proposal: ProposedViewSize(width: width, height: nil))
            x += width + gap
        }
    }
}

/// How an item takes space in `FlexWrapBaselineRow`.
enum FlexItemSizing {
    /// `flex-shrink: 0`.
    case natural
    /// `flex: 1; min-width: 0`: no space of its own, and whatever its line has left over.
    case grow
    /// `flex-basis: 100%`.
    case fullLine
}

struct FlexItemSizingKey: LayoutValueKey {
    static let defaultValue = FlexItemSizing.natural
}

/// A flex item's first baseline, down from its top. SwiftUI's own `firstTextBaseline` doesn't know
/// where a web line box paints its glyphs.
struct FlexBaseline: LayoutValueKey {
    static let defaultValue: CGFloat = 0
}

/// `display: flex; flex-wrap: wrap; align-items: baseline`, with one gap in both directions.
struct FlexWrapBaselineRow: Layout {
    var spacing: CGFloat

    private struct Item {
        let index: Int
        var width: CGFloat
        let sizing: FlexItemSizing
    }

    private struct Line {
        var items: [Item] = []
        var top: CGFloat = 0
        var ascent: CGFloat = 0
        var descent: CGFloat = 0
    }

    private func lines(_ subviews: Subviews, width: CGFloat) -> [Line] {
        var lines: [Line] = []
        var current = Line()
        var used: CGFloat = 0
        for (index, subview) in subviews.enumerated() {
            let sizing = subview[FlexItemSizingKey.self]
            let basis: CGFloat
            switch sizing {
            case .natural: basis = subview.sizeThatFits(.unspecified).width
            case .grow: basis = 0
            case .fullLine: basis = width
            }
            let next = current.items.isEmpty ? basis : used + spacing + basis
            if !current.items.isEmpty, next > width {
                lines.append(current)
                current = Line()
                used = basis
            } else {
                used = next
            }
            current.items.append(Item(index: index, width: basis, sizing: sizing))
        }
        if !current.items.isEmpty { lines.append(current) }

        var top: CGFloat = 0
        for lineIndex in lines.indices {
            let occupied = lines[lineIndex].items.reduce(0) { $0 + $1.width }
                + spacing * CGFloat(lines[lineIndex].items.count - 1)
            let growing = lines[lineIndex].items.filter { $0.sizing == .grow }.count
            for itemIndex in lines[lineIndex].items.indices where lines[lineIndex].items[itemIndex].sizing == .grow {
                lines[lineIndex].items[itemIndex].width = max(width - occupied, 0) / CGFloat(growing)
            }
            for item in lines[lineIndex].items {
                let height = subviews[item.index].sizeThatFits(ProposedViewSize(width: item.width, height: nil)).height
                let baseline = subviews[item.index][FlexBaseline.self]
                lines[lineIndex].ascent = max(lines[lineIndex].ascent, baseline)
                lines[lineIndex].descent = max(lines[lineIndex].descent, height - baseline)
            }
            lines[lineIndex].top = top
            top += lines[lineIndex].ascent + lines[lineIndex].descent + spacing
        }
        return lines
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? 10_000
        let laidOut = lines(subviews, width: width)
        let height = laidOut.last.map { $0.top + $0.ascent + $0.descent } ?? 0
        return CGSize(width: width, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        for line in lines(subviews, width: bounds.width) {
            var x = bounds.minX
            for item in line.items {
                let baseline = subviews[item.index][FlexBaseline.self]
                subviews[item.index].place(
                    at: CGPoint(x: x, y: bounds.minY + line.top + line.ascent - baseline),
                    proposal: ProposedViewSize(width: item.width, height: nil)
                )
                x += item.width + spacing
            }
        }
    }
}

// MARK: - Tabular data (`table-layout: auto`, the usage breakdowns)

/// A plain data table. Columns take their max-content width when everything fits, else
/// shrink toward their longest unbreakable piece (hyphens break, as in a browser); below
/// that the table overflows and scrolls sideways (`.tableScroll`).
struct WebDataTable: View {
    struct Column {
        let title: String
        var numeric = false
    }

    let columns: [Column]
    let rows: [[String]]

    @Environment(\.windowWidth) private var windowWidth

    /// usageTable.scss: padding and text scale with the screen so five columns fit on a phone.
    /// `clamp(0.8125rem, 3.75vw, 0.9rem)`
    private var bodyFont: UIFont { DSFont.ui(min(max(13, windowWidth * 0.0375), 14.4)) }
    /// `clamp(0.75rem, 3.33vw, 0.8rem)`
    private var headerFont: UIFont { DSFont.ui(min(max(12, windowWidth * 0.0333), 12.8), weight: 500) }
    /// Both sides of `clamp(0.25rem, 1.5vw, 0.75rem)`
    private var horizontalPadding: CGFloat { 2 * min(max(4, windowWidth * 0.015), 12) }

    var body: some View {
        GeometryReader { proxy in
            let widths = columnWidths(available: proxy.size.width)
            ScrollView(.horizontal, showsIndicators: false) {
                table(widths: widths)
            }
            .scrollBounceBehavior(.basedOnSize, axes: .horizontal)
            .preference(key: TableHeightKey.self, value: tableHeight(widths: widths))
        }
        .frame(height: measuredHeight)
        .onPreferenceChange(TableHeightKey.self) { measuredHeight = $0 }
    }

    @State private var measuredHeight: CGFloat = 0

    private func table(widths: [CGFloat]) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            // `.table .numeric`: a column of numbers aligns right, headers included.
            row(columns.map(\.title), widths: widths, font: headerFont, color: AppTheme.textMuted)
            ForEach(Array(rows.enumerated()), id: \.offset) { _, cells in
                row(cells, widths: widths, font: bodyFont, color: AppTheme.textPrimary)
            }
        }
    }

    private func row(_ cells: [String], widths: [CGFloat], font: UIFont, color: Color) -> some View {
        HStack(alignment: .center, spacing: 0) {
            ForEach(Array(cells.enumerated()), id: \.offset) { index, cell in
                let numeric = index < columns.count && columns[index].numeric
                Text(cell)
                    .modifier(WebFontModifier(uiFont: font))
                    .foregroundStyle(color)
                    .multilineTextAlignment(numeric ? .trailing : .leading)
                    .padding(.horizontal, horizontalPadding / 2)
                    .frame(width: widths[index], alignment: numeric ? .trailing : .leading)
            }
        }
        .frame(height: rowHeight(cells, widths: widths, font: font))
        .overlay(alignment: .bottom) { Rectangle().fill(AppTheme.border).frame(height: 1) }
    }

    private func rowHeight(_ cells: [String], widths: [CGFloat], font: UIFont) -> CGFloat {
        var tallest: CGFloat = 0
        for (index, cell) in cells.enumerated() {
            let text = NSAttributedString(string: cell.webBreakable, attributes: [.font: font])
            let box = text.boundingRect(
                with: CGSize(width: max(widths[index] - horizontalPadding, 1), height: 1_000),
                options: [.usesLineFragmentOrigin],
                context: nil
            )
            let lines = (box.height / font.lineHeight).rounded()
            tallest = max(tallest, lines * WebLineBox(font: font, lineHeight: nil).height)
        }
        return tallest + 19.2 + 1
    }

    private func tableHeight(widths: [CGFloat]) -> CGFloat {
        var height = rowHeight(columns.map(\.title), widths: widths, font: headerFont)
        for cells in rows { height += rowHeight(cells, widths: widths, font: bodyFont) }
        return height
    }

    private func columnWidths(available: CGFloat) -> [CGFloat] {
        var minWidths = [CGFloat](repeating: 0, count: columns.count)
        var maxWidths = [CGFloat](repeating: 0, count: columns.count)
        for (col, column) in columns.enumerated() {
            measure(column.title, font: headerFont, into: col, &minWidths, &maxWidths)
        }
        for cells in rows {
            for (col, cell) in cells.enumerated() where col < columns.count {
                measure(cell, font: bodyFont, into: col, &minWidths, &maxWidths)
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

    private func measure(_ text: String, font: UIFont, into col: Int, _ minWidths: inout [CGFloat], _ maxWidths: inout [CGFloat]) {
        let attributes: [NSAttributedString.Key: Any] = [.font: font]
        let full = LayoutUnit.ceiling((text as NSString).size(withAttributes: attributes).width)
        maxWidths[col] = max(maxWidths[col], full + horizontalPadding)
        let nsText = text as NSString
        for piece in WebLineBreak.unbreakableRanges(in: nsText) {
            let width = LayoutUnit.ceiling(nsText.substring(with: piece).size(withAttributes: attributes).width)
            minWidths[col] = max(minWidths[col], width + horizontalPadding)
        }
    }
}

private struct TableHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}

// MARK: - Small labels shared by the settings pages

/// `font-size: 0.8125rem; font-weight: 500` field label above a control.
struct WebFieldLabel: View {
    let text: String
    var color: Color = AppTheme.textSecondary
    var weight: CGFloat = 500

    init(_ text: String, color: Color = AppTheme.textSecondary, weight: CGFloat = 500) {
        self.text = text
        self.color = color
        self.weight = weight
    }

    var body: some View {
        Text(text)
            .webText(13, weight)
            .foregroundStyle(color)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// `font-size: 0.8125rem` muted help line under a control.
struct WebFieldHelp: View {
    let text: String
    var isError = false

    init(_ text: String, isError: Bool = false) {
        self.text = text
        self.isError = isError
    }

    var body: some View {
        Text(text)
            .webText(13)
            .foregroundStyle(isError ? AppTheme.error : AppTheme.textMuted)
            .frame(maxWidth: .infinity, alignment: .leading)
            .fixedSize(horizontal: false, vertical: true)
    }
}

/// Section title: `font-size: 1.125rem; font-weight: 600`.
struct SettingsSectionTitle: View {
    let text: String

    init(_ text: String) { self.text = text }

    var body: some View {
        Text(text)
            .webText(18, 600)
            .foregroundStyle(AppTheme.textPrimary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .fixedSize(horizontal: false, vertical: true)
    }
}
