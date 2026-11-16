import SwiftUI
import Combine

// MARK: - Settings dialogs

/// The confirmation dialogs Settings sections open. A section's content scrolls, so the page
/// presents them over the full screen, as the web's `position: fixed` modals cover the
/// viewport.
enum SettingsDialog: Equatable {
    case deleteKeys, deleteAccount, deleteLearnedFacts
}

@MainActor
final class SettingsDialogCenter: ObservableObject {
    @Published var active: SettingsDialog?
    /// "Delete your data"'s status line, set by the keys dialog after it deletes.
    @Published var deleteDataNotice: String?

    func open(_ dialog: SettingsDialog) {
        active = dialog
        if dialog == .deleteKeys || dialog == .deleteAccount { deleteDataNotice = nil }
    }
}

struct SettingsDialogOverlay: View {
    @EnvironmentObject var dialogs: SettingsDialogCenter

    var body: some View {
        Group {
            switch dialogs.active {
            case .deleteKeys: DeleteKeysDialog()
            case .deleteAccount: DeleteAccountDialog()
            case .deleteLearnedFacts: DeleteLearnedFactsDialog()
            case nil: EmptyView()
            }
        }
        .animation(.easeOut(duration: 0.3), value: dialogs.active)
    }
}

// MARK: - Delete your data (DeleteDataSettings.tsx)

/// The "Delete your data" section of Settings › Profile: delete every stored API key, or the
/// whole account. Each asks first; the account also needs the typed confirmation, and signs
/// the user out once deletion has started.
struct DeleteDataSettingsView: View {
    @EnvironmentObject var dialogs: SettingsDialogCenter

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            SettingsSectionTitle(L("settingsPage.profileSettings.deleteData.title"))

            if let notice = dialogs.deleteDataNotice {
                Text(notice)
                    .webText(15)
                    .foregroundStyle(AppTheme.textPrimary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    // 0.75rem 1rem inside a 1pt border
                    .padding(.horizontal, 17)
                    .padding(.vertical, 13)
                    .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(AppTheme.borderLight, lineWidth: 1))
                    .accessibilityIdentifier("delete-data-notice")
            }

            row(
                title: L("settingsPage.profileSettings.deleteData.keysTitle"),
                description: L("settingsPage.profileSettings.deleteData.keysDescription"),
                button: L("settingsPage.profileSettings.deleteData.keysButton"),
                identifier: "delete-keys-button"
            ) { dialogs.open(.deleteKeys) }

            row(
                title: L("settingsPage.profileSettings.deleteData.accountTitle"),
                description: L("settingsPage.profileSettings.deleteData.accountDescription"),
                button: L("settingsPage.profileSettings.deleteData.accountButton"),
                identifier: "delete-account-button"
            ) { dialogs.open(.deleteAccount) }
        }
        // The notice belongs to this visit to Profile, as the web's section state does.
        .onDisappear { dialogs.deleteDataNotice = nil }
    }

    private func row(title: String, description: String, button: String, identifier: String, action: @escaping () -> Void) -> some View {
        DeleteDataRow {
            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .webText(16, 500)
                    .foregroundStyle(AppTheme.textPrimary)
                Text(description)
                    .webText(14, lineHeight: 19.6)
                    .foregroundStyle(AppTheme.textMuted)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            PillButton(label: button, style: .danger, action: action)
                .accessibilityIdentifier(identifier)
        }
        // 1rem inside a 1pt border
        .padding(17)
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(AppTheme.borderLight, lineWidth: 1))
    }
}

/// `.row`: `display: flex; flex-wrap: wrap; justify-content: space-between; align-items:
/// center; gap: 1rem 1.5rem`, the text `flex: 1 1 16rem`. Side by side when the text's 16rem
/// and the button fit on one line; otherwise the button drops below the text, at its start.
struct DeleteDataRow: Layout {
    static let textBasis: CGFloat = 256
    static let columnGap: CGFloat = 24
    static let rowGap: CGFloat = 16

    static func fitsOneLine(width: CGFloat, buttonWidth: CGFloat) -> Bool {
        textBasis + columnGap + buttonWidth <= width
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        guard subviews.count == 2 else { return .zero }
        let button = subviews[1].sizeThatFits(.unspecified)
        let width = proposal.width ?? (Self.textBasis + Self.columnGap + button.width)
        if Self.fitsOneLine(width: width, buttonWidth: button.width) {
            let text = subviews[0].sizeThatFits(ProposedViewSize(width: width - Self.columnGap - button.width, height: nil))
            return CGSize(width: width, height: max(text.height, button.height))
        }
        let text = subviews[0].sizeThatFits(ProposedViewSize(width: width, height: nil))
        return CGSize(width: width, height: text.height + Self.rowGap + button.height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        guard subviews.count == 2 else { return }
        let button = subviews[1].sizeThatFits(.unspecified)
        if Self.fitsOneLine(width: bounds.width, buttonWidth: button.width) {
            let textWidth = bounds.width - Self.columnGap - button.width
            let text = subviews[0].sizeThatFits(ProposedViewSize(width: textWidth, height: nil))
            subviews[0].place(at: CGPoint(x: bounds.minX, y: bounds.midY - text.height / 2), proposal: ProposedViewSize(width: textWidth, height: nil))
            subviews[1].place(at: CGPoint(x: bounds.maxX - button.width, y: bounds.midY - button.height / 2), proposal: .unspecified)
        } else {
            let text = subviews[0].sizeThatFits(ProposedViewSize(width: bounds.width, height: nil))
            subviews[0].place(at: CGPoint(x: bounds.minX, y: bounds.minY), proposal: ProposedViewSize(width: bounds.width, height: nil))
            subviews[1].place(at: CGPoint(x: bounds.minX, y: bounds.minY + text.height + Self.rowGap), proposal: .unspecified)
        }
    }
}

// MARK: - Delete-data dialogs

/// `.dialogActions`: Cancel then the danger button, at the end, `margin-top: 1.25rem`.
private struct DeleteDataActions: View {
    let busy: Bool
    let confirm: String
    let confirmDisabled: Bool
    let identifier: String
    let onCancel: () -> Void
    let onConfirm: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            Spacer(minLength: 0)
            PillButton(label: L("settingsPage.profileSettings.deleteData.cancel"), style: .secondary, disabled: busy, action: onCancel)
            PillButton(label: confirm, style: .danger, disabled: confirmDisabled, action: onConfirm)
                .accessibilityIdentifier(identifier)
        }
        .padding(.top, 20)
    }
}

/// `list-style: disc outside` in a `gutter`-wide padding. Chrome draws the disc rather than a
/// glyph, sized and placed from the font's rounded ascent with integer math (as
/// `MarkdownTextView` draws list markers).
private struct ListDisc: View {
    let font: UIFont
    let lineHeight: CGFloat
    let gutter: CGFloat

    var body: some View {
        let ascent = Int(font.ascender.rounded())
        let offset = ascent * 2 / 3
        let size = CGFloat((offset + 1) / 2)
        let box = WebLineBox(font: font, lineHeight: lineHeight)
        Circle()
            .frame(width: size, height: size)
            .offset(x: gutter - CGFloat(offset) - 7, y: box.baseline - CGFloat(ascent) + CGFloat(3 * (ascent - offset) / 2))
            .frame(width: gutter, height: box.height, alignment: .topLeading)
            .accessibilityHidden(true)
    }
}

private func deleteDataDialogText(_ text: String, bold: Bool = false) -> some View {
    Text(text)
        .webText(15, bold ? 700 : 400, lineHeight: 22.5)
        .foregroundStyle(AppTheme.textPrimary)
        .frame(maxWidth: .infinity, alignment: .leading)
}

private func deleteDataDialogError(_ text: String) -> some View {
    Text(text)
        .webText(14)
        .foregroundStyle(AppTheme.error)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, 12)
        .accessibilityIdentifier("delete-data-dialog-error")
}

struct DeleteKeysDialog: View {
    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var ai: AIStore
    @EnvironmentObject var dialogs: SettingsDialogCenter

    @State private var busy = false
    @State private var dialogError: String?

    var body: some View {
        WebModal(title: L("settingsPage.profileSettings.deleteData.keysConfirmTitle"), maxWidth: 448, onClose: close) {
            VStack(alignment: .leading, spacing: 0) {
                deleteDataDialogText(L("settingsPage.profileSettings.deleteData.keysConfirmBody"))
                if let dialogError { deleteDataDialogError(dialogError) }
                DeleteDataActions(
                    busy: busy,
                    confirm: busy ? L("settingsPage.profileSettings.deleteData.deleting") : L("settingsPage.profileSettings.deleteData.keysConfirmButton"),
                    confirmDisabled: busy,
                    identifier: "delete-keys-confirm",
                    onCancel: close
                ) { Task { await deleteKeys() } }
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("delete-keys-dialog")
        }
    }

    private func close() {
        if !busy { dialogs.active = nil }
    }

    private func deleteKeys() async {
        guard auth.isAuthenticated, let token = try? await auth.getAccessTokenSilently() else {
            dialogError = L("settingsPage.profileSettings.deleteData.loginFirst")
            return
        }
        busy = true
        defer { busy = false }
        do {
            let count = try await AccountService.deleteAllCredentials(token: token, customerId: auth.customerId)
            ai.modelsByVendor = [:]
            auth.resyncAccount()
            dialogs.active = nil
            dialogs.deleteDataNotice = count > 0
                ? L("settingsPage.profileSettings.deleteData.keysDeleted", ["count": count])
                : L("settingsPage.profileSettings.deleteData.keysDeletedNone")
        } catch {
            AppObservability.capture(error, context: ["where": "deleteAllCredentials"])
            dialogError = L("settingsPage.profileSettings.deleteData.keysError")
        }
    }
}

struct DeleteAccountDialog: View {
    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var dialogs: SettingsDialogCenter

    @State private var typed = ""
    @State private var busy = false
    @State private var dialogError: String?
    @FocusState private var inputFocused: Bool

    private static let word = DeleteAccountRequest.confirmationWord
    private static let listKeys = [
        "accountConfirmConversations", "accountConfirmContent", "accountConfirmKeys", "accountConfirmVectors"
    ]
    private static let actionsAnchor = "delete-account-actions"

    var body: some View {
        WebModal(title: L("settingsPage.profileSettings.deleteData.accountConfirmTitle"), maxWidth: 512, onClose: close) {
            ScrollViewReader { scroll in
                VStack(alignment: .leading, spacing: 0) {
                    deleteDataDialogText(L("settingsPage.profileSettings.deleteData.accountConfirmIntro"))
                        .padding(.bottom, 12)
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(Self.listKeys, id: \.self) { key in
                            HStack(alignment: .top, spacing: 0) {
                                ListDisc(font: DSFont.ui(15), lineHeight: DSFont.scaledSize(22.5), gutter: 20)
                                    .foregroundStyle(AppTheme.textPrimary)
                                deleteDataDialogText(L("settingsPage.profileSettings.deleteData.\(key)"))
                            }
                        }
                    }
                    .padding(.bottom, 12)
                    deleteDataDialogText(L("settingsPage.profileSettings.deleteData.accountConfirmKept"))
                        .padding(.bottom, 12)
                    deleteDataDialogText(L("settingsPage.profileSettings.deleteData.accountConfirmUndo"), bold: true)
                        .padding(.bottom, 12)
                    Text(L("settingsPage.profileSettings.deleteData.accountConfirmPrompt", ["word": Self.word]))
                        .webText(14, 500)
                        .foregroundStyle(AppTheme.textSecondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.bottom, 8)
                    TextField("", text: $typed)
                        .focused($inputFocused)
                        .font(DSFont.arial(15.2))
                        .foregroundStyle(AppTheme.textPrimary)
                        .textInputAutocapitalization(.characters)
                        .autocorrectionDisabled()
                        .disabled(busy)
                        // 0.75rem 1rem inside a 1pt border
                        .padding(.horizontal, 17)
                        .frame(height: 43)
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(inputFocused ? AppTheme.primary : AppTheme.borderLight, lineWidth: 1))
                        .overlay {
                            // Focused, `box-shadow: 0 0 0 1px`: a second line outside the border.
                            if inputFocused {
                                RoundedRectangle(cornerRadius: 9)
                                    .strokeBorder(AppTheme.primary, lineWidth: 1)
                                    .padding(-1)
                            }
                        }
                        .accessibilityLabel(L("settingsPage.profileSettings.deleteData.accountConfirmPrompt", ["word": Self.word]))
                        .accessibilityIdentifier("delete-account-input")
                    if let dialogError { deleteDataDialogError(dialogError) }
                    DeleteDataActions(
                        busy: busy,
                        confirm: busy ? L("settingsPage.profileSettings.deleteData.deleting") : L("settingsPage.profileSettings.deleteData.accountConfirmButton"),
                        confirmDisabled: busy || typed != Self.word,
                        identifier: "delete-account-confirm",
                        onCancel: close
                    ) { Task { await deleteAccount() } }
                    .id(Self.actionsAnchor)
                }
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("delete-account-dialog")
                // The keyboard leaves the dialog short. Scrolling the buttons to the top stops at the
                // end of the content, which brings them and the padding below them into view.
                .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardDidShowNotification)) { _ in
                    guard inputFocused else { return }
                    withAnimation(.easeOut(duration: 0.3)) { scroll.scrollTo(Self.actionsAnchor, anchor: .top) }
                }
            }
        }
    }

    private func close() {
        if !busy { dialogs.active = nil }
    }

    private func deleteAccount() async {
        guard typed == Self.word else { return }
        guard auth.isAuthenticated, let token = try? await auth.getAccessTokenSilently() else {
            dialogError = L("settingsPage.profileSettings.deleteData.loginFirst")
            return
        }
        busy = true
        do {
            try await AccountService.deleteAccount(token: token)
            dialogs.active = nil
            auth.logout()
        } catch {
            AppObservability.capture(error, context: ["where": "deleteAccount"])
            dialogError = L("settingsPage.profileSettings.deleteData.accountError")
            busy = false
        }
    }
}
