import SwiftUI
import Combine

// MARK: - Settings dialogs

/// The confirmation dialogs Settings pages open. A page's content scrolls, so the page frame
/// presents them over the full screen, as the web's `position: fixed` modals cover the viewport.
enum SettingsDialog: Equatable {
    case deleteFacts, deleteIndex, deleteKeys, deleteAccount
}

@MainActor
final class SettingsDialogCenter: ObservableObject {
    @Published var active: SettingsDialog?

    func open(_ dialog: SettingsDialog) {
        active = dialog
    }
}

struct SettingsDialogOverlay: View {
    @EnvironmentObject var dialogs: SettingsDialogCenter

    var body: some View {
        Group {
            switch dialogs.active {
            case .deleteFacts: DeleteFactsDialog()
            case .deleteIndex: DeleteIndexDialog()
            case .deleteKeys: DeleteKeysDialog()
            case .deleteAccount: DeleteAccountDialog()
            case nil: EmptyView()
            }
        }
        .animation(.easeOut(duration: 0.3), value: dialogs.active)
    }
}

// MARK: - Profile › Delete your data (DeleteDataSettings.tsx)

/// Every delete in Settings: learned facts, indexed chats, keys and connections (own-key
/// customers only) and the account. Each asks first; the account needs DELETE typed. Deleting
/// clears our servers only.
struct DeleteDataSettingsView: View {
    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var dialogs: SettingsDialogCenter

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            SettingsCard(title: L("settingsPage.deleteData.factsCard")) {
                SettingsRow(label: L("settingsPage.deleteData.factsRow"), description: L("settingsPage.deleteData.factsText")) {
                    deleteButton(L("settingsPage.deleteData.factsButton"), identifier: "delete-facts-button") { dialogs.open(.deleteFacts) }
                }
            }
            SettingsCard(title: L("settingsPage.deleteData.indexCard")) {
                SettingsRow(label: L("settingsPage.deleteData.indexRow"), description: L("settingsPage.deleteData.indexText")) {
                    deleteButton(L("settingsPage.deleteData.indexButton"), identifier: "delete-index-button") { dialogs.open(.deleteIndex) }
                }
            }
            if auth.hasOwnKeys {
                SettingsCard(title: L("settingsPage.deleteData.keysCard")) {
                    SettingsRow(label: L("settingsPage.deleteData.keysRow"), description: L("settingsPage.deleteData.keysRowText")) {
                        deleteButton(L("settingsPage.deleteData.keysButton"), identifier: "delete-keys-button") { dialogs.open(.deleteKeys) }
                    }
                }
            }
            SettingsCard(title: L("settingsPage.deleteData.accountCard"), danger: true) {
                SettingsRow(label: L("settingsPage.deleteData.accountRow"), description: L("settingsPage.deleteData.accountIntro")) {
                    deleteButton(L("settingsPage.deleteData.accountButton"), identifier: "delete-account-button") { dialogs.open(.deleteAccount) }
                } extra: {
                    SettingsBulletList(items: AccountDeletion.items(ownKeys: auth.hasOwnKeys), fontSize: 13, lineHeight: 19.5, color: AppTheme.textMuted)
                        .padding(.top, 4)
                }
            }
        }
        .settingsPage(knowledge: (auth.hasOwnKeys ? [KnowledgeItem(title: L("settingsPage.deleteData.keysTitle"), text: L("settingsPage.deleteData.keysText"))] : [])
            + [KnowledgeItem(title: L("settingsPage.deleteData.accountTitle"), text: L("settingsPage.deleteData.accountText"))]
            + (auth.hasOwnKeys ? [KnowledgeItem(title: L("settingsPage.deleteData.providersTitle"), text: L("settingsPage.deleteData.providersText"))] : []))
    }

    private func deleteButton(_ label: String, identifier: String, action: @escaping () -> Void) -> some View {
        PillButton(label: label, style: .danger, size: .lg, fullWidth: true, action: action)
            .accessibilityIdentifier(identifier)
    }
}

/// What deleting the account removes.
enum AccountDeletion {
    static func items(ownKeys: Bool) -> [String] {
        [L("settingsPage.deleteData.accountConversations"), L("settingsPage.deleteData.accountContent")]
            + (ownKeys ? [L("settingsPage.deleteData.accountKeys"), L("settingsPage.deleteData.accountVectors")] : [])
    }
}

/// A `<ul>` with `padding-left: 18px` and discs.
struct SettingsBulletList: View {
    let items: [String]
    let fontSize: CGFloat
    let lineHeight: CGFloat
    let color: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(items, id: \.self) { item in
                HStack(alignment: .firstTextBaseline, spacing: 0) {
                    Text("•")
                        .webText(fontSize, lineHeight: lineHeight)
                        .frame(width: 18, alignment: .center)
                        .accessibilityHidden(true)
                    Text(item)
                        .webText(fontSize, lineHeight: lineHeight)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .foregroundStyle(color)
            }
        }
    }
}

// MARK: - Dialogs

/// `.dialogText` / `.dialogError` / `.dialogActions` on the library Modal.
struct SettingsConfirmDialog<Message: View>: View {
    let title: String
    let confirmLabel: String
    var danger = true
    var busy = false
    var confirmDisabled = false
    var error: String?
    var identifier: String
    let onClose: () -> Void
    let onConfirm: () -> Void
    @ViewBuilder var message: Message

    var body: some View {
        WebModal(title: title, maxWidth: 448, onClose: { if !busy { onClose() } }) {
            VStack(alignment: .leading, spacing: 0) {
                message
                if let error {
                    Text(error)
                        .webText(13)
                        .foregroundStyle(AppTheme.error)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.bottom, 12)
                        .accessibilityIdentifier("delete-data-dialog-error")
                }
                HStack(spacing: 8) {
                    Spacer(minLength: 0)
                    PillButton(label: L("settingsPage.profileSettings.deleteData.cancel"), style: .secondary, disabled: busy, action: onClose)
                    PillButton(label: confirmLabel, style: danger ? .danger : .primary, disabled: busy || confirmDisabled, action: onConfirm)
                        .accessibilityIdentifier("\(identifier)-confirm")
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier(identifier)
        }
    }
}

struct SettingsDialogText: View {
    let text: String

    var body: some View {
        Text(text)
            .webText(14, lineHeight: 21)
            .foregroundStyle(AppTheme.textSecondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.bottom, 12)
    }
}

/// TypedConfirmDialog.tsx: the message, a field the word must be typed into, then the actions.
struct TypedConfirmDialog<Message: View>: View {
    let title: String
    let confirmWord: String
    let inputLabel: String
    let confirmLabel: String
    var danger = true
    var busy = false
    var identifier: String
    let onClose: () -> Void
    let onConfirm: () -> Void
    @ViewBuilder var message: Message

    @State private var typed = ""
    @FocusState private var focused: Bool

    var body: some View {
        WebModal(title: title, maxWidth: 448, onClose: { if !busy { onClose() } }) {
            VStack(alignment: .leading, spacing: 14) {
                message
                    .webText(14, lineHeight: 21)
                    .foregroundStyle(AppTheme.textSecondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                VStack(alignment: .leading, spacing: 6) {
                    Text(inputLabel)
                        .webText(13, 500)
                        .foregroundStyle(AppTheme.textPrimary)
                    TextField("", text: $typed)
                        .focused($focused)
                        .font(DSFont.arial(16))
                        .kerning(0.64)
                        .foregroundStyle(AppTheme.textPrimary)
                        .textInputAutocapitalization(.characters)
                        .autocorrectionDisabled()
                        .disabled(busy)
                        .padding(.horizontal, 13)
                        .frame(height: 42)
                        .background(AppTheme.backgroundSecondary, in: RoundedRectangle(cornerRadius: 8))
                        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(focused ? AppTheme.primary : AppTheme.borderLight, lineWidth: 1))
                        .accessibilityLabel(inputLabel)
                        .accessibilityIdentifier("\(identifier)-input")
                }
                HStack(spacing: 8) {
                    Spacer(minLength: 0)
                    PillButton(label: L("settingsPage.profileSettings.deleteData.cancel"), style: .secondary, disabled: busy, action: onClose)
                        .accessibilityIdentifier("\(identifier)-cancel")
                    PillButton(label: confirmLabel, style: danger ? .danger : .primary, disabled: busy || typed != confirmWord, action: onConfirm)
                        .accessibilityIdentifier("\(identifier)-confirm")
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier(identifier)
        }
    }
}

/// Runs one delete from a dialog: closes it and toasts on success, keeps it open with the error otherwise.
@MainActor
private func runDelete(
    auth: AuthStore,
    dialogs: SettingsDialogCenter,
    toasts: ToastCenter,
    busy: Binding<Bool>,
    errorText: Binding<String?>,
    failure: String,
    _ action: @escaping (String) async throws -> String
) async {
    guard auth.isAuthenticated, let token = try? await auth.getAccessTokenSilently() else {
        errorText.wrappedValue = L("settingsPage.profileSettings.deleteData.loginFirst")
        return
    }
    busy.wrappedValue = true
    defer { busy.wrappedValue = false }
    do {
        let message = try await action(token)
        dialogs.active = nil
        toasts.showToast(message)
    } catch {
        AppObservability.capture(error, context: ["where": "settingsDelete"])
        errorText.wrappedValue = failure
    }
}

struct DeleteFactsDialog: View {
    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var toasts: ToastCenter
    @EnvironmentObject var memories: MemoriesStore
    @EnvironmentObject var dialogs: SettingsDialogCenter
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        SettingsConfirmDialog(
            title: L("settingsPage.learnedFacts.deleteAllTitle"),
            confirmLabel: busy ? L("settingsPage.profileSettings.deleteData.deleting") : L("settingsPage.learnedFacts.deleteAllConfirmButton"),
            busy: busy,
            error: error,
            identifier: "delete-facts",
            onClose: { dialogs.active = nil },
            onConfirm: { Task { await delete() } }
        ) {
            SettingsDialogText(text: L("settingsPage.learnedFacts.deleteAllConfirm"))
        }
    }

    private func delete() async {
        await runDelete(auth: auth, dialogs: dialogs, toasts: toasts, busy: $busy, errorText: $error, failure: L("settingsPage.learnedFacts.deleteErrorToast")) { token in
            let deleted = try await LearnedFactsService.deleteAll(token: token)
            memories.memories = []
            if let customerId = auth.customerId {
                CacheStore.shared.write([CustomerMemory](), key: StorageSuffix.customerKey(customerId, StorageSuffix.memories))
            }
            return L("settingsPage.learnedFacts.deletedToast", ["count": deleted])
        }
    }
}

struct DeleteIndexDialog: View {
    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var toasts: ToastCenter
    @EnvironmentObject var dialogs: SettingsDialogCenter
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        SettingsConfirmDialog(
            title: L("settingsPage.chatIndexing.deleteTitle"),
            confirmLabel: busy ? L("settingsPage.profileSettings.deleteData.deleting") : L("settingsPage.chatIndexing.deleteConfirmButton"),
            busy: busy,
            error: error,
            identifier: "delete-index",
            onClose: { dialogs.active = nil },
            onConfirm: { Task { await delete() } }
        ) {
            SettingsDialogText(text: L("settingsPage.chatIndexing.deleteConfirm"))
        }
    }

    private func delete() async {
        await runDelete(auth: auth, dialogs: dialogs, toasts: toasts, busy: $busy, errorText: $error, failure: L("settingsPage.chatIndexing.deleteErrorToast")) { token in
            try await ChatIndexingService.deleteIndexedChats(token: token)
            return L("settingsPage.chatIndexing.deletedToast")
        }
    }
}

struct DeleteKeysDialog: View {
    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var ai: AIStore
    @EnvironmentObject var toasts: ToastCenter
    @EnvironmentObject var dialogs: SettingsDialogCenter
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        SettingsConfirmDialog(
            title: L("settingsPage.profileSettings.deleteData.keysConfirmTitle"),
            confirmLabel: busy ? L("settingsPage.profileSettings.deleteData.deleting") : L("settingsPage.profileSettings.deleteData.keysConfirmButton"),
            busy: busy,
            error: error,
            identifier: "delete-keys",
            onClose: { dialogs.active = nil },
            onConfirm: { Task { await delete() } }
        ) {
            SettingsDialogText(text: L("settingsPage.profileSettings.deleteData.keysConfirmBody"))
        }
    }

    private func delete() async {
        await runDelete(auth: auth, dialogs: dialogs, toasts: toasts, busy: $busy, errorText: $error, failure: L("settingsPage.profileSettings.deleteData.keysError")) { token in
            let count = try await AccountService.deleteAllCredentials(token: token, customerId: auth.customerId)
            ai.modelsByVendor = [:]
            auth.resyncAccount()
            return count > 0
                ? L("settingsPage.profileSettings.deleteData.keysDeleted", ["count": count])
                : L("settingsPage.profileSettings.deleteData.keysDeletedNone")
        }
    }
}

struct DeleteAccountDialog: View {
    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var dialogs: SettingsDialogCenter
    @State private var busy = false
    @State private var error: String?

    private static let word = DeleteAccountRequest.confirmationWord

    var body: some View {
        TypedConfirmDialog(
            title: L("settingsPage.profileSettings.deleteData.accountConfirmTitle"),
            confirmWord: Self.word,
            inputLabel: L("settingsPage.profileSettings.deleteData.accountConfirmPrompt", ["word": Self.word]),
            confirmLabel: busy ? L("settingsPage.profileSettings.deleteData.deleting") : L("settingsPage.profileSettings.deleteData.accountConfirmButton"),
            busy: busy,
            identifier: "delete-account-dialog",
            onClose: { dialogs.active = nil },
            onConfirm: { Task { await delete() } }
        ) {
            VStack(alignment: .leading, spacing: 6) {
                Text(L("settingsPage.deleteData.accountIntro"))
                SettingsBulletList(items: AccountDeletion.items(ownKeys: auth.hasOwnKeys), fontSize: 14, lineHeight: 21, color: AppTheme.textSecondary)
                if let error {
                    Text(error)
                        .webText(13)
                        .foregroundStyle(AppTheme.error)
                        .accessibilityIdentifier("delete-data-dialog-error")
                }
            }
        }
    }

    private func delete() async {
        guard auth.isAuthenticated, let token = try? await auth.getAccessTokenSilently() else {
            error = L("settingsPage.profileSettings.deleteData.loginFirst")
            return
        }
        busy = true
        do {
            try await AccountService.deleteAccount(token: token)
            dialogs.active = nil
            auth.logout()
        } catch {
            AppObservability.capture(error, context: ["where": "deleteAccount"])
            self.error = L("settingsPage.profileSettings.deleteData.accountError")
            busy = false
        }
    }
}
