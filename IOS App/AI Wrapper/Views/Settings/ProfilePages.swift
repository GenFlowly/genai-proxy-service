import SwiftUI
import Combine

extension AuthStore {
    /// useHasOwnKeys: any stored LLM key. Drives "estimate" wording and the rows only own-key
    /// customers see.
    var hasOwnKeys: Bool {
        aiVendorAPIKeyStatusList.contains { $0.isAPIKeyValid == true || ($0.status != nil && $0.status != APIKeyStatus.notSet) }
    }
}

/// The customer profile both Profile pages read: the previous session's copy paints, a fresh
/// fetch revalidates (useProfile).
@MainActor
final class ProfileLoader: ObservableObject {
    @Published var profile: CustomerProfileResponse?
    @Published var isLoading = true

    func load(auth: AuthStore) async {
        let cacheKey = auth.customerId.map { StorageSuffix.customerKey($0, StorageSuffix.profile) }
        if profile == nil, let cacheKey, let cached = CacheStore.shared.read(CustomerProfileResponse.self, key: cacheKey) {
            profile = cached
        }
        defer { isLoading = false }
        guard let token = try? await auth.getAccessTokenSilently(),
              let fresh = await UserService.getUserProfile(token: token) else { return }
        profile = fresh
        persist(auth: auth)
    }

    func persist(auth: AuthStore) {
        guard let profile, let customerId = auth.customerId else { return }
        CacheStore.shared.write(profile, key: StorageSuffix.customerKey(customerId, StorageSuffix.profile))
    }
}

// MARK: - Profile › Account (AccountSettings.tsx)

struct AccountSettingsView: View {
    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var toasts: ToastCenter
    @StateObject private var loader = ProfileLoader()

    @State private var username = ""
    @State private var seeded: String?
    @State private var saving = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let profile = loader.profile {
                SettingsCard(title: L("settingsPage.account.personalDetails")) {
                    HStack(spacing: 12) {
                        avatar(profile)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(profile.name?.isEmpty == false ? profile.name! : L("settingsPage.profileSettings.noName"))
                                .webText(16, 500)
                                .foregroundStyle(AppTheme.textPrimary)
                            Text(profile.email?.isEmpty == false ? profile.email! : L("settingsPage.profileSettings.noEmail"))
                                .webText(13)
                                .foregroundStyle(AppTheme.textMuted)
                                .lineLimit(1)
                        }
                    }
                }
                SettingsCard(title: L("settingsPage.account.usernameCard")) {
                    InputTextWithHint(
                        hint: L("settingsPage.account.usernameLabel"),
                        placeholder: L("settingsPage.profileSettings.usernamePlaceholder"),
                        text: $username,
                        stacked: true
                    )
                    .accessibilityIdentifier("username-input")
                    PillButton(
                        label: saving ? L("settingsPage.account.saving") : L("settingsPage.account.updateUsername"),
                        size: .lg,
                        disabled: saving || username == (profile.username ?? "") || username.trimmingCharacters(in: .whitespaces).isEmpty,
                        fullWidth: true
                    ) { Task { await save() } }
                    .accessibilityIdentifier("update-username")
                }
            } else {
                Text(loader.isLoading ? L("settingsPage.profileSettings.loadingProfile") : L("settingsPage.profileSettings.loadProfileFailed"))
                    .webText(14)
                    .foregroundStyle(AppTheme.textMuted)
            }
        }
        .settingsPage(knowledge: [
            KnowledgeItem(title: L("settingsPage.account.sourceTitle"), text: L("settingsPage.account.sourceText")),
            KnowledgeItem(title: L("settingsPage.account.usernameTitle"), text: L("settingsPage.account.usernameText"))
        ])
        .task { await loader.load(auth: auth) }
        .onChange(of: loader.profile?.username) { _, value in
            // Seed once per distinct server value, so a refetch never overwrites typing.
            guard seeded != value else { return }
            seeded = value
            username = value ?? ""
        }
    }

    @ViewBuilder
    private func avatar(_ profile: CustomerProfileResponse) -> some View {
        if let picture = profile.picture, !picture.isEmpty {
            AvatarImage(picture: picture, size: 48, placeholderColor: AppTheme.textMuted)
        } else {
            Text(Self.initials(profile.name))
                .webText(16, 500)
                .foregroundStyle(AppTheme.textSecondary)
                .frame(width: 48, height: 48)
                .background(AppTheme.backgroundTertiary, in: Circle())
                .accessibilityHidden(true)
        }
    }

    static func initials(_ name: String?) -> String {
        let parts = (name?.isEmpty == false ? name! : "?").split(whereSeparator: \.isWhitespace)
        return String(parts.compactMap(\.first).prefix(2)).uppercased()
    }

    private func save() async {
        guard let profile = loader.profile, !username.trimmingCharacters(in: .whitespaces).isEmpty, username != profile.username,
              let token = try? await auth.getAccessTokenSilently() else { return }
        saving = true
        defer { saving = false }
        do {
            try await UserService.updateUsername(token: token, username: username)
            loader.profile?.username = username
            seeded = username
            loader.persist(auth: auth)
            toasts.showToast(L("settingsPage.profileSettings.usernameUpdatedMessage"))
        } catch {
            let text = (error as? APIError)?.message
            toasts.showToast(text?.isEmpty == false ? text! : L("settingsPage.profileSettings.usernameUpdateFailedMessage"))
            username = profile.username ?? ""
        }
    }
}

// MARK: - Profile › Privacy (PrivacySettings.tsx)

struct PrivacySettingsView: View {
    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var router: AppRouter
    @EnvironmentObject var toasts: ToastCenter
    @StateObject private var loader = ProfileLoader()

    @State private var discoverable = false
    @State private var saving = false

    private var agreedDate: String? {
        guard let at = auth.aiDataConsentAt, let date = ServerDate.parse(at) else { return nil }
        return date.formatted(date: .numeric, time: .omitted)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            SettingsCard(title: L("settingsPage.privacy.visibility")) {
                ToggleRow(
                    label: L("settingsPage.privacy.discoverable"),
                    isOn: discoverable,
                    disabled: saving || loader.profile == nil,
                    identifier: "discoverable-switch"
                ) { checked in Task { await toggle(checked) } }
            }
            SettingsCard(
                title: L("settingsPage.privacy.repliesTitle"),
                hint: agreedDate.map { L("settingsPage.privacy.agreedOn", ["date": $0]) }
            ) {
                SettingsRow(label: L("settingsPage.privacy.modelsTitle"), description: L("settingsPage.privacy.modelsText"))
                SettingsRow(label: L("settingsPage.privacy.memoryTitle"), description: L("settingsPage.privacy.memoryText"), separated: true)
                SettingsRow(label: L("settingsPage.privacy.toolsTitle"), description: L("settingsPage.privacy.toolsText"), separated: true)
                SettingsRow(label: L("settingsPage.privacy.ownTerms"), separated: true) {
                    WrapRow(spacing: 16, lineSpacing: 6) {
                        if auth.hasOwnKeys {
                            SettingsLink(text: L("settingsPage.privacy.manageServices")) { router.navigate(.settings(.llmKeys)) }
                        }
                        SettingsLink(text: L("settingsPage.privacy.privacyPolicy")) { router.navigate(.privacyPolicy) }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .accessibilityIdentifier("ai-data-sharing")
        }
        .settingsPage(knowledge: [
            KnowledgeItem(title: L("settingsPage.privacy.discoverableTitle"), text: L("settingsPage.privacy.discoverableText")),
            KnowledgeItem(
                title: L("settingsPage.privacy.repliesTitle"),
                text: [L("settingsPage.privacy.repliesText"), agreedDate.map { L("settingsPage.privacy.agreedOnSentence", ["date": $0]) }]
                    .compactMap { $0 }
                    .joined(separator: " ")
            )
        ])
        .task { await loader.load(auth: auth) }
        .onChange(of: loader.profile?.isDiscoverable) { _, value in
            if let value { discoverable = value }
        }
    }

    private func toggle(_ checked: Bool) async {
        discoverable = checked
        saving = true
        defer { saving = false }
        do {
            let token = try await auth.getAccessTokenSilently()
            try await UserService.updateDiscoverability(token: token, isDiscoverable: checked)
            loader.profile?.isDiscoverable = checked
            loader.persist(auth: auth)
        } catch {
            toasts.showToast(L("settingsPage.profileSettings.discoverabilityUpdateFailedMessage"))
            discoverable = !checked
        }
    }
}

// MARK: - Profile › Blocked users (BlockedUsersSettings.tsx + BlockedUsersList.tsx)

struct BlockedUsersSettingsView: View {
    @EnvironmentObject private var auth: AuthStore

    private enum Phase: Equatable { case loading, loaded, failed }

    @State private var users: [BlockedUser] = []
    @State private var phase = Phase.loading
    @State private var unblockingId: String?
    @State private var message: (text: String, failed: Bool)?

    var body: some View {
        SettingsCard(title: L("settingsPage.blocked.card"), flush: true) {
            VStack(alignment: .leading, spacing: 0) {
                switch phase {
                case .loading:
                    note(L("moderation.blockedUsers.loading"))
                case .failed:
                    VStack(alignment: .leading, spacing: 10) {
                        note(L("moderation.blockedUsers.loadFailed"))
                        PillButton(label: L("moderation.blockedUsers.retry"), style: .secondary) { Task { await load() } }
                            .padding(.leading, 14)
                    }
                    .padding(.bottom, 12)
                case .loaded where users.isEmpty:
                    note(L("moderation.blockedUsers.empty"))
                        .accessibilityIdentifier("blocked-users-empty")
                case .loaded:
                    ForEach(Array(users.enumerated()), id: \.element.id) { index, user in
                        row(user, isFirst: index == 0)
                    }
                }
                if let message {
                    Text(message.text)
                        .webText(14, lineHeight: 20.3)
                        .foregroundStyle(message.failed ? AppTheme.error : AppTheme.textMuted)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 12)
                }
            }
        }
        .settingsPage(
            status: phase == .loaded ? L("settingsPage.blocked.count", ["count": users.count]) : nil,
            knowledge: [
                KnowledgeItem(title: L("settingsPage.blocked.howTitle"), text: L("settingsPage.blocked.howText")),
                KnowledgeItem(title: L("settingsPage.blocked.whatTitle"), text: L("settingsPage.blocked.whatText")),
                KnowledgeItem(title: L("settingsPage.blocked.undoTitle"), text: L("settingsPage.blocked.undoText"))
            ]
        )
        .task { await load() }
    }

    private func note(_ text: String) -> some View {
        Text(text)
            .webText(14, lineHeight: 20.3)
            .foregroundStyle(AppTheme.textMuted)
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
    }

    private func row(_ user: BlockedUser, isFirst: Bool) -> some View {
        HStack(spacing: 12) {
            Text(user.initials)
                .webText(14, 500)
                .foregroundStyle(AppTheme.primary)
                .frame(width: 38, height: 38)
                .background(AppTheme.primaryLight, in: Circle())
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(user.label)
                    .webText(15, 500)
                    .foregroundStyle(AppTheme.textPrimary)
                    .lineLimit(1)
                Text(L("moderation.blockedUsers.blockedOn", ["date": Self.displayDate(user.blockedAt)]))
                    .webText(13)
                    .foregroundStyle(AppTheme.textMuted)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Button { Task { await unblock(user) } } label: {
                Text(L(unblockingId == user.customerId ? "moderation.blockedUsers.unblocking" : "moderation.blockedUsers.unblock"))
                    .webText(13, 500)
                    .foregroundStyle(AppTheme.textPrimary)
                    .padding(.horizontal, 17)
                    .frame(height: 34)
                    .background(AppTheme.backgroundSecondary, in: Capsule())
                    .overlay(Capsule().strokeBorder(AppTheme.border, lineWidth: 1))
                    .contentShape(Rectangle())
            }
            .buttonStyle(WebPressStyle())
            .disabled(unblockingId == user.customerId)
            .opacity(unblockingId == user.customerId ? 0.6 : 1)
            .accessibilityIdentifier("unblock-\(user.customerId)")
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .frame(minHeight: 60)
        .overlay(alignment: .top) {
            if !isFirst { Rectangle().fill(AppTheme.sidebarHairline).frame(height: 1) }
        }
    }

    static func displayDate(_ iso: String) -> String {
        guard let date = ServerDate.parse(iso) else { return "" }
        return date.formatted(.dateTime.month(.abbreviated).day().year())
    }

    private func load() async {
        guard let token = try? await auth.getAccessTokenSilently() else { return }
        do {
            users = try await ModerationService.blockedUsers(token: token)
            phase = .loaded
        } catch {
            phase = .failed
        }
    }

    private func unblock(_ user: BlockedUser) async {
        unblockingId = user.customerId
        message = nil
        defer { unblockingId = nil }
        do {
            let token = try await auth.getAccessTokenSilently()
            try await ModerationService.unblock(token: token, customerId: user.customerId)
            users.removeAll { $0.customerId == user.customerId }
            message = (L("moderation.blockedUsers.unblocked", ["name": user.label]), false)
        } catch {
            message = (L("moderation.blockedUsers.unblockFailed", ["name": user.label]), true)
        }
    }
}
