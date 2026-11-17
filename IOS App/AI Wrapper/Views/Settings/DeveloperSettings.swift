import SwiftUI

// MARK: - Developer (DeveloperSettings.tsx)

/// API keys that let the customer's own apps call this app as them. A new key is shown once,
/// then only its prefix. Each key lists its requests and cost for the last 30 days and all
/// time, with an "All keys" row; a dash means its usage couldn't be read.
struct DeveloperSettingsView: View {
    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var toasts: ToastCenter

    @State private var keys: [DeveloperApiKeySummary] = []
    @State private var totals: DeveloperApiKeyUsage?
    @State private var isLoading = true
    @State private var newKeyName = ""
    @State private var isCreating = false
    @State private var createdKey: DeveloperApiKeyCreatedResponse?
    @State private var keyToRevoke: DeveloperApiKeySummary?
    @State private var isRevoking = false

    private static let noValue = "—"
    private static let revokeWidth = LayoutUnit.ceiling((L("settingsPage.developerSettings.revoke") as NSString)
        .size(withAttributes: [.font: DSFont.ui(12, weight: 500)]).width) + 22

    private static func date(_ iso: String?) -> String {
        guard let date = ServerDate.parse(iso) else { return noValue }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US")
        formatter.dateFormat = "MM/dd/yyyy"
        return formatter.string(from: date)
    }

    private static func cost(_ value: Double?) -> String { value.map(SettingsFormat.usd) ?? noValue }
    private static func requests(_ value: Int?) -> String { value.map(SettingsFormat.compactCount) ?? noValue }

    var body: some View {
        let keyCount = L("settingsPage.developerSettings.keyCount", ["count": keys.count])
        VStack(alignment: .leading, spacing: 12) {
            SettingsCard(title: L("settingsPage.developerSettings.createCard")) {
                VStack(spacing: 10) {
                    InputTextWithHint(
                        hint: L("settingsPage.developerSettings.keyNameHint"),
                        placeholder: L("settingsPage.developerSettings.keyNamePlaceholder"),
                        text: $newKeyName,
                        stacked: true
                    )
                    .accessibilityIdentifier("api-key-name-input")
                    PillButton(
                        label: isCreating ? L("settingsPage.developerSettings.creatingLabel") : L("settingsPage.developerSettings.createApiKey"),
                        icon: "add-icon",
                        size: .lg,
                        disabled: isCreating,
                        fullWidth: true
                    ) { Task { await create() } }
                    .accessibilityIdentifier("create-api-key")
                }
            }

            if let createdKey { createdCard(createdKey) }

            SettingsCard(title: L("settingsPage.developerSettings.yourApiKeys"), flush: true) {
                if isLoading {
                    Text(L("settingsPage.developerSettings.loading"))
                        .webText(13)
                        .foregroundStyle(AppTheme.textMuted)
                        .padding(12)
                } else {
                    keysTable
                }
            }
        }
        .settingsPage(
            status: isLoading ? nil : keyCount,
            knowledge: [
                KnowledgeItem(title: L("settingsPage.developerSettings.whatTitle"), text: L("settingsPage.developerSettings.whatText")),
                KnowledgeItem(title: L("settingsPage.developerSettings.safeTitle"), text: L("settingsPage.developerSettings.safeText")),
                KnowledgeItem(title: L("settingsPage.developerSettings.costTitle"), text: L("settingsPage.developerSettings.costText"))
            ]
        )
        .settingsDialog(isPresented: keyToRevoke != nil) {
            SettingsConfirmDialog(
                title: L("settingsPage.developerSettings.revokeTitle", ["name": keyToRevoke?.name ?? ""]),
                confirmLabel: isRevoking ? L("settingsPage.developerSettings.revokingLabel") : L("settingsPage.developerSettings.revoke"),
                busy: isRevoking,
                identifier: "revoke-key",
                onClose: { keyToRevoke = nil },
                onConfirm: { Task { await revoke() } }
            ) {
                SettingsDialogText(text: L("settingsPage.developerSettings.revokeText"))
            }
        }
        .task { await load() }
    }

    private var keysTable: some View {
        let costHeader = { (period: String) in
            auth.hasOwnKeys
                ? L(period == "30d" ? "settingsPage.developerSettings.estCost30d" : "settingsPage.developerSettings.estCostAllTime")
                : L(period == "30d" ? "settingsPage.developerSettings.cost30d" : "settingsPage.developerSettings.costAllTime")
        }
        return SettingsTable(
            columns: [
                .init(title: L("settingsPage.developerSettings.name"), medium: true),
                .init(title: L("settingsPage.developerSettings.key"), mono: true),
                .init(title: L("settingsPage.developerSettings.created")),
                .init(title: L("settingsPage.developerSettings.lastUsed")),
                .init(title: L("settingsPage.developerSettings.requests30d"), numeric: true),
                .init(title: costHeader("30d"), numeric: true),
                .init(title: costHeader("allTime"), numeric: true),
                .init(title: L("settingsPage.developerSettings.revoke"), actionWidth: Self.revokeWidth)
            ],
            rows: keys.map { key in
                [key.name, "\(key.prefix)…", Self.date(key.createdAt), Self.date(key.lastUsedAt),
                 Self.requests(key.requests30d), Self.cost(key.costUsd30d), Self.cost(key.costUsdAllTime)]
            },
            footer: keys.isEmpty ? nil : [
                L("settingsPage.developerSettings.allKeys"), "", "", "",
                Self.requests(totals?.requests30d), Self.cost(totals?.costUsd30d), Self.cost(totals?.costUsdAllTime), ""
            ],
            emptyText: L("settingsPage.developerSettings.noKeysYet"),
            rowAction: { index in
                AnyView(
                    PillButton(label: L("settingsPage.developerSettings.revoke"), style: .danger, size: .sm) {
                        keyToRevoke = keys[index]
                    }
                    .accessibilityIdentifier("revoke-key-\(keys[index].keyId)")
                )
            },
            identifier: "api-keys-table"
        )
    }

    private func createdCard(_ created: DeveloperApiKeyCreatedResponse) -> some View {
        SettingsCard(title: L("settingsPage.developerSettings.createdKeyTitle", ["name": created.name])) {
            StatusPill(kind: .ok, text: L("settingsPage.developerSettings.copyItNow"))
        } content: {
            Text(L("settingsPage.developerSettings.createdKeyWarning"))
                .webText(13)
                .foregroundStyle(AppTheme.textSecondary)
            VStack(spacing: 10) {
                Text(created.apiKey)
                    .webText(sfMono: 13)
                    .foregroundStyle(AppTheme.textPrimary)
                    .textSelection(.enabled)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(AppTheme.sidebarHairline, lineWidth: 1))
                    .accessibilityIdentifier("created-key-value")
                PillButton(label: L("settingsPage.developerSettings.copy"), icon: "copy-icon", style: .secondary, size: .lg, fullWidth: true) {
                    UIPasteboard.general.string = created.apiKey
                    toasts.showToast(L("settingsPage.developerSettings.copiedToast"))
                }
            }
            PillButton(label: L("settingsPage.developerSettings.savedMyKey"), size: .lg, fullWidth: true) {
                createdKey = nil
            }
            .accessibilityIdentifier("created-key-dismiss")
        }
        .accessibilityIdentifier("created-key-panel")
    }

    private func load() async {
        defer { isLoading = false }
        do {
            let token = try await auth.getAccessTokenSilently()
            let response = try await DeveloperApiKeysService.listKeys(token: token)
            keys = response.keys
            totals = response.totals
        } catch {
            toasts.showToast(L("settingsPage.developerSettings.loadErrorToast"))
        }
    }

    private func create() async {
        let name = newKeyName.trimmingCharacters(in: .whitespaces)
        guard !name.isEmpty else {
            toasts.showToast(L("settingsPage.developerSettings.enterKeyNameToast"))
            return
        }
        isCreating = true
        defer { isCreating = false }
        do {
            let token = try await auth.getAccessTokenSilently()
            createdKey = try await DeveloperApiKeysService.createKey(token: token, name: name)
            newKeyName = ""
            await load()
        } catch {
            toasts.showToast(L("settingsPage.developerSettings.createErrorToast"))
        }
    }

    private func revoke() async {
        guard let key = keyToRevoke else { return }
        isRevoking = true
        defer { isRevoking = false }
        do {
            let token = try await auth.getAccessTokenSilently()
            try await DeveloperApiKeysService.revokeKey(token: token, keyId: key.keyId)
            if createdKey?.keyId == key.keyId { createdKey = nil }
            keyToRevoke = nil
            toasts.showToast(L("settingsPage.developerSettings.revokedToast"))
            await load()
        } catch {
            toasts.showToast(L("settingsPage.developerSettings.revokeErrorToast"))
        }
    }
}
