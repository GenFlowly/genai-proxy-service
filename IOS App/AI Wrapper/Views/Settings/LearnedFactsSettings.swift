import SwiftUI

// MARK: - Learned facts (LearnedFactsSettings.tsx)

/// Settings › Defaults › Learned facts: the memory switches and "Delete all learned facts". A
/// switch is on until the user turns it off (unset means on, as on the server) and saves as
/// soon as it changes; after a failed save it falls back to the stored value.
struct LearnedFactsSettingsView: View {
    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var toasts: ToastCenter
    @EnvironmentObject var dialogs: SettingsDialogCenter

    enum Switch: CaseIterable {
        case learnFromChats, useInReplies

        var label: String {
            switch self {
            case .learnFromChats: return L("settingsPage.learnedFacts.fromChats")
            case .useInReplies: return L("settingsPage.learnedFacts.useInReplies")
            }
        }

        var description: String {
            switch self {
            case .learnFromChats: return L("settingsPage.learnedFacts.fromChatsDescription")
            case .useInReplies: return L("settingsPage.learnedFacts.useInRepliesDescription")
            }
        }

        var identifier: String {
            switch self {
            case .learnFromChats: return "learned-facts-memoryLearnFromChats"
            case .useInReplies: return "learned-facts-memoryUseInReplies"
            }
        }

        func stored(in preferences: AIConfigPreferences?) -> Bool? {
            switch self {
            case .learnFromChats: return preferences?.memoryLearnFromChats
            case .useInReplies: return preferences?.memoryUseInReplies
            }
        }
    }

    @State private var pending: [Switch: Bool] = [:]

    static func isOn(_ key: Switch, preferences: AIConfigPreferences?, pending: [Switch: Bool]) -> Bool {
        pending[key] ?? (key.stored(in: preferences) != false)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 4) {
                SettingsSectionTitle(L("settingsPage.learnedFacts.title"))
                Text(L("settingsPage.learnedFacts.subtitle"))
                    .webText(14)
                    .foregroundStyle(Color(hex: "#6B7280"))
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            VStack(alignment: .leading, spacing: 12) {
                ForEach(Switch.allCases, id: \.self) { key in
                    toggleRow(key)
                }
                PillButton(label: L("settingsPage.learnedFacts.deleteAll"), style: .danger) {
                    dialogs.open(.deleteLearnedFacts)
                }
                .accessibilityIdentifier("learned-facts-delete-all")
                .padding(.top, 4)
            }
            .frame(maxWidth: 512, alignment: .leading)
        }
        // margin-top/padding-top 2rem under a 1pt border (the section is below the agents)
        .padding(.top, 33)
        .overlay(alignment: .top) { Rectangle().fill(Color(hex: "#E5E7EB")).frame(height: 1) }
    }

    /// `<label class="toggleGroup">`: the whole row toggles its checkbox.
    private func toggleRow(_ key: Switch) -> some View {
        let isOn = Self.isOn(key, preferences: auth.aiConfigPreferences, pending: pending)
        let isPending = pending[key] != nil
        return HStack(alignment: .top, spacing: 24) {
            VStack(alignment: .leading, spacing: 4) {
                Text(key.label)
                    .webText(16, 500)
                    .foregroundStyle(AppTheme.textPrimary)
                Text(key.description)
                    .webText(14, lineHeight: 19.6)
                    .foregroundStyle(AppTheme.textMuted)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            WebCheckbox(isOn: isOn, size: 20, disabled: isPending, label: key.label) { value in
                Task { await toggle(key, value) }
            }
            .padding(.top, 4)
            .accessibilityIdentifier(key.identifier)
        }
        .padding(17)
        .contentShape(Rectangle())
        .onTapGesture {
            guard !isPending else { return }
            Task { await toggle(key, !isOn) }
        }
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(AppTheme.borderLight, lineWidth: 1))
    }

    private func toggle(_ key: Switch, _ checked: Bool) async {
        guard auth.isAuthenticated else {
            toasts.showToast(L("settingsPage.learnedFacts.loginFirstToast"))
            return
        }
        pending[key] = checked
        defer { pending[key] = nil }
        do {
            let token = try await auth.getAccessTokenSilently()
            switch key {
            case .learnFromChats:
                try await SaveAIConfigService.savePreferences(token: token, memoryLearnFromChats: checked)
                auth.mergePreferences(memoryLearnFromChats: checked)
            case .useInReplies:
                try await SaveAIConfigService.savePreferences(token: token, memoryUseInReplies: checked)
                auth.mergePreferences(memoryUseInReplies: checked)
            }
        } catch {
            let message = error.localizedDescription
            toasts.showToast(message.isEmpty ? L("settingsPage.learnedFacts.saveErrorToast") : message)
        }
    }
}

struct DeleteLearnedFactsDialog: View {
    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var toasts: ToastCenter
    @EnvironmentObject var memories: MemoriesStore
    @EnvironmentObject var dialogs: SettingsDialogCenter

    @State private var deleting = false

    var body: some View {
        WebModal(title: L("settingsPage.learnedFacts.deleteAllTitle"), maxWidth: 416, onClose: { dialogs.active = nil }) {
            VStack(alignment: .leading, spacing: 0) {
                Text(L("settingsPage.learnedFacts.deleteAllConfirm"))
                    .webText(15, lineHeight: 22.5)
                    .foregroundStyle(AppTheme.textPrimary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.bottom, 20)
                HStack(spacing: 12) {
                    Spacer(minLength: 0)
                    PillButton(label: L("settingsPage.learnedFacts.cancel"), style: .secondary, disabled: deleting) {
                        dialogs.active = nil
                    }
                    PillButton(
                        label: deleting ? L("settingsPage.learnedFacts.deleting") : L("settingsPage.learnedFacts.deleteAllConfirmButton"),
                        style: .danger,
                        disabled: deleting
                    ) {
                        Task { await deleteAll() }
                    }
                    .accessibilityIdentifier("learned-facts-delete-confirm")
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("delete-learned-facts-dialog")
        }
    }

    private func deleteAll() async {
        deleting = true
        defer { deleting = false }
        do {
            let token = try await auth.getAccessTokenSilently()
            let deleted = try await LearnedFactsService.deleteAll(token: token)
            memories.memories = []
            if let customerId = auth.customerId {
                CacheStore.shared.write([CustomerMemory](), key: StorageSuffix.customerKey(customerId, StorageSuffix.memories))
            }
            toasts.showToast(L("settingsPage.learnedFacts.deletedToast", ["count": deleted]))
            dialogs.active = nil
        } catch {
            AppObservability.capture(error, context: ["where": "deleteAllLearnedFacts"])
            toasts.showToast(L("settingsPage.learnedFacts.deleteErrorToast"))
        }
    }
}
