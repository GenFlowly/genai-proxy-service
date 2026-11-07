import SwiftUI

extension AppRouter.SettingsSection {
    /// The MobileHeader title is the active section's own label (SECTION_LABEL_KEYS).
    var title: String {
        switch self {
        case .profile: return L("settingsPage.settingsPage.sectionProfile")
        case .llmKeys: return L("settingsPage.settingsPage.sectionAiModelKeys")
        case .embeddingKeys: return L("settingsPage.settingsPage.sectionAiEmbeddingKeys")
        case .vectorDb: return L("settingsPage.settingsPage.sectionAiVectorDb")
        case .usageLlm: return L("settingsPage.settingsPage.sectionUsageLlmModels")
        case .usageEmbedding: return L("settingsPage.settingsPage.sectionUsageEmbeddingModels")
        case .usageVectorDb: return L("settingsPage.settingsPage.sectionUsageVectorDb")
        case .usageWebSearch: return L("settingsPage.settingsPage.sectionUsageWebSearch")
        case .defaults: return L("settingsPage.settingsPage.sectionDefaults")
        case .tools: return L("settingsPage.settingsPage.sectionTools")
        case .connectors: return L("settingsPage.settingsPage.sectionConnectors")
        case .developer: return L("settingsPage.settingsPage.sectionDeveloper")
        }
    }
}

/// SettingsPage below isNarrow: the MobileHeader names the section, its hamburger opens
/// the SettingsSidebar, and the page is one full-bleed scroller (`.contentInner`:
/// 20pt gutters, 2.5rem bottom padding, resting below the overlay header).
struct SettingsSectionPageView: View {
    @EnvironmentObject var auth: AuthStore
    let section: AppRouter.SettingsSection

    @StateObject private var dialogs = SettingsDialogCenter()

    var body: some View {
        PageScaffold(title: section.title) {
            if auth.isAuthenticated {
                ScrollView {
                    content
                        .padding(.horizontal, 20)
                        .padding(.top, mobileHeaderHeight)
                        .padding(.bottom, 40)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .scrollDismissesKeyboard(.interactively)
            } else {
                LoginRequiredView()
            }
        }
        .overlay { SettingsDialogOverlay() }
        .environmentObject(dialogs)
    }

    @ViewBuilder
    private var content: some View {
        switch section {
        case .profile: ProfileSettingsView()
        case .llmKeys: AISettingsView()
        case .embeddingKeys: EmbeddingKeysSettingsView()
        case .vectorDb: VectorDBSettingsView()
        case .usageLlm: LlmUsageSettingsView()
        case .usageEmbedding: EmbeddingUsageSettingsView()
        case .usageVectorDb: VectorDbUsageSettingsView()
        case .usageWebSearch: WebSearchUsageSettingsView()
        case .defaults: DefaultsSettingsView()
        case .tools: ToolsSettingsView()
        case .connectors: ConnectorsSettingsView()
        case .developer: DeveloperSettingsView()
        }
    }
}

// MARK: - Menu (SettingsSidebar.tsx)

struct SettingsSidebar: View {
    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var router: AppRouter
    let onNavigate: () -> Void

    private struct Child: Identifiable {
        let section: AppRouter.SettingsSection
        let label: String
        var id: String { label }
    }

    private struct Item: Identifiable {
        let key: String
        let label: String
        let icon: String
        var section: AppRouter.SettingsSection?
        var children: [Child] = []
        var id: String { key }
    }

    /// Manual expand/collapse choices; absent = expanded while the route is inside it.
    @State private var expandedOverride: [String: Bool] = [:]
    @State private var query = ""

    private var items: [Item] {
        [
            Item(key: "profile", label: L("settingsPage.settingsSidebar.profile"), icon: "user-circle", section: .profile),
            Item(key: "ai", label: L("settingsPage.settingsSidebar.aiSettings"), icon: "models", children: [
                Child(section: .llmKeys, label: L("settingsPage.settingsSidebar.aiModelKeys")),
                Child(section: .embeddingKeys, label: L("settingsPage.settingsSidebar.aiEmbeddingKeys")),
                Child(section: .vectorDb, label: L("settingsPage.settingsSidebar.aiVectorDb"))
            ]),
            Item(key: "usage", label: L("settingsPage.settingsSidebar.usage"), icon: "tokens", children: [
                Child(section: .usageLlm, label: L("settingsPage.settingsSidebar.usageLlmModels")),
                Child(section: .usageEmbedding, label: L("settingsPage.settingsSidebar.usageEmbeddingModels")),
                Child(section: .usageVectorDb, label: L("settingsPage.settingsSidebar.usageVectorDb")),
                Child(section: .usageWebSearch, label: L("settingsPage.settingsSidebar.usageWebSearch"))
            ]),
            Item(key: "defaults", label: L("settingsPage.settingsSidebar.defaults"), icon: "prompt-icon", section: .defaults),
            Item(key: "tools", label: L("settingsPage.settingsSidebar.tools"), icon: "steps", section: .tools),
            // Connectors are hidden on iOS for now. This row is the only way in.
            // Item(key: "connectors", label: L("settingsPage.settingsSidebar.connectors"), icon: "link", section: .connectors),
            Item(key: "developer", label: L("settingsPage.settingsSidebar.developer"), icon: "edit", section: .developer)
        ]
    }

    private var activeSection: AppRouter.SettingsSection? {
        if case .settings(let section) = router.route { return section }
        return nil
    }

    private func isInSection(_ item: Item) -> Bool {
        item.children.contains { $0.section == activeSection }
    }

    private func isExpanded(_ item: Item) -> Bool {
        !item.children.isEmpty && (expandedOverride[item.key] ?? isInSection(item))
    }

    private func go(_ section: AppRouter.SettingsSection) {
        router.navigate(.settings(section))
        onNavigate()
    }

    private var normalizedQuery: String { query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }

    /// Support lives outside Settings, at the web app's /support page.
    private var supportMatches: Bool {
        L("settingsPage.settingsSidebar.support").lowercased().contains(normalizedQuery)
    }

    /// Sections and sub-pages matching the search, flattened into one list.
    private var searchHits: [(key: String, label: String, icon: String, section: AppRouter.SettingsSection)] {
        items.flatMap { item -> [(key: String, label: String, icon: String, section: AppRouter.SettingsSection)] in
            let itemMatches = item.label.lowercased().contains(normalizedQuery)
            if let section = item.section {
                return itemMatches ? [(item.key, item.label, item.icon, section)] : []
            }
            return item.children
                .filter { itemMatches || $0.label.lowercased().contains(normalizedQuery) }
                .map { ("\(item.key)-\($0.label)", $0.label, item.icon, $0.section) }
        }
    }

    private func linkRowLabel(_ label: String, icon: String) -> some View {
        HStack(spacing: 10) {
            WebIcon(name: icon, size: 18, color: AppTheme.textMuted)
            Text(label)
                .webText(arial: 15)
                .foregroundStyle(AppTheme.textPrimary)
            Spacer(minLength: 0)
        }
        .padding(.leading, 8)
        .padding(.trailing, 10)
        .frame(height: 48)
        .contentShape(Rectangle())
    }

    var body: some View {
        MobileMenuBody(searchText: $query, searchPlaceholder: L("layout.mobileMenu.searchSettings")) {
            VStack(spacing: 12) {
                HuggingScrollView {
                    VStack(alignment: .leading, spacing: 2) {
                        MenuCardLabel(title: L("settingsPage.settingsSidebar.title"))
                        if normalizedQuery.isEmpty {
                            ForEach(items) { item in
                                if item.children.isEmpty {
                                    leafRow(item)
                                } else {
                                    parentRow(item)
                                }
                            }
                        } else if searchHits.isEmpty && !supportMatches {
                            Text(L("layout.mobileMenu.noSearchResults"))
                                .webText(13.6, lineHeight: 20.4)
                                .foregroundStyle(AppTheme.textMuted)
                                .padding(.vertical, 16)
                                .frame(maxWidth: .infinity)
                        } else {
                            ForEach(searchHits, id: \.key) { hit in
                                row(label: hit.label, icon: hit.icon, active: false) { go(hit.section) }
                            }
                            if supportMatches {
                                row(label: L("settingsPage.settingsSidebar.support"), icon: "chat-bubble", active: false) {
                                    SupportLink.open()
                                }
                            }
                        }
                    }
                    .padding(.horizontal, 4)
                    .padding(.bottom, 4)
                }
                .sidebarCard()

                VStack(spacing: 0) {
                    Button {
                        SupportLink.open()
                    } label: {
                        linkRowLabel(L("settingsPage.settingsSidebar.support"), icon: "chat-bubble")
                    }
                    .buttonStyle(RowPressStyle())
                    .accessibilityIdentifier("settings-menu-support")

                    Button {
                        router.navigate(.privacyPolicy)
                        onNavigate()
                    } label: {
                        linkRowLabel(L("settingsPage.settingsSidebar.privacyPolicy"), icon: "document-text")
                    }
                    .buttonStyle(RowPressStyle())
                }
                .padding(4)
                .sidebarCard()

                Button {
                    onNavigate()
                    auth.logout()
                    router.navigate(.chat)
                } label: {
                    HStack(spacing: 10) {
                        WebIcon(name: "logout", size: 18, color: AppTheme.error)
                        Text(L("settingsPage.settingsSidebar.logout"))
                            .webText(arial: 15)
                            .foregroundStyle(AppTheme.error)
                        Spacer(minLength: 0)
                    }
                    .padding(.leading, 8)
                    .padding(.trailing, 10)
                    .frame(height: 48)
                    .contentShape(Rectangle())
                }
                .buttonStyle(RowPressStyle())
                .padding(4)
                .sidebarCard()
            }
        }
    }

    private func leafRow(_ item: Item) -> some View {
        row(label: item.label, icon: item.icon, active: item.section == activeSection) {
            if let section = item.section { go(section) }
        }
    }

    private func row(label: String, icon: String, active: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 10) {
                WebIcon(name: icon, size: 18, color: AppTheme.textMuted)
                Text(label)
                    .webText(arial: 15, bold: active)
                    .foregroundStyle(active ? AppTheme.textPrimary : AppTheme.textSecondary)
                Spacer(minLength: 0)
            }
            .padding(.leading, 8)
            .padding(.trailing, 10)
            .frame(height: 48)
            .background(active ? AppTheme.backgroundSelected : Color.clear)
            .clipShape(RoundedRectangle(cornerRadius: DSRadius.md))
            .contentShape(Rectangle())
        }
        .buttonStyle(RowPressStyle())
    }

    private func parentRow(_ item: Item) -> some View {
        let inSection = isInSection(item)
        let expanded = isExpanded(item)
        return VStack(alignment: .leading, spacing: 2) {
            Button {
                expandedOverride[item.key] = !expanded
            } label: {
                HStack(spacing: 10) {
                    WebIcon(name: item.icon, size: 18, color: AppTheme.textMuted)
                    Text(item.label)
                        .webText(arial: 15, bold: inSection)
                        .foregroundStyle(inSection ? AppTheme.textPrimary : AppTheme.textSecondary)
                    Spacer(minLength: 0)
                    WebIcon(name: "alt-arrow-right", size: 16, color: AppTheme.textMuted)
                        .rotationEffect(.degrees(expanded ? 90 : 0))
                }
                .padding(.leading, 8)
                .padding(.trailing, 10)
                .frame(height: 48)
                .contentShape(Rectangle())
            }
            .buttonStyle(RowPressStyle())
            .accessibilityAddTraits(expanded ? .isSelected : [])

            if expanded {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(item.children) { child in
                        let active = inSection && child.section == activeSection
                        Button { go(child.section) } label: {
                            Text(child.label)
                                .webText(arial: 15, bold: active)
                                .foregroundStyle(active ? AppTheme.textPrimary : AppTheme.textSecondary)
                                .padding(.horizontal, 10)
                                .frame(height: 44)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background(active ? AppTheme.backgroundSelected : Color.clear)
                                .clipShape(RoundedRectangle(cornerRadius: DSRadius.md))
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(RowPressStyle())
                    }
                }
                .padding(.leading, 8)
                .overlay(alignment: .leading) { Rectangle().fill(AppTheme.borderLight).frame(width: 1) }
                .padding(.leading, 16)
            }
        }
    }
}

// MARK: - Profile (ProfileSettings.tsx)

struct ProfileSettingsView: View {
    @EnvironmentObject var auth: AuthStore

    @State private var profile: CustomerProfileResponse?
    @State private var isLoading = true
    @State private var username = ""
    @State private var isDiscoverable = false
    @State private var isSavingUsername = false
    @State private var isSavingDiscoverability = false
    @State private var message: (text: String, kind: WebMessageKind)?
    @State private var seededSignature: String?
    @FocusState private var usernameFocused: Bool

    private var cacheKey: String? {
        auth.customerId.map { StorageSuffix.customerKey($0, StorageSuffix.profile) }
    }

    var body: some View {
        Group {
            if let profile {
                form(profile)
            } else {
                Text(isLoading ? L("settingsPage.profileSettings.loadingProfile") : L("settingsPage.profileSettings.loadProfileFailed"))
                    .webText(16)
                    .foregroundStyle(AppTheme.textPrimary)
            }
        }
        .task { await load() }
    }

    private func form(_ profile: CustomerProfileResponse) -> some View {
        VStack(alignment: .leading, spacing: 32) {
            if let message { messageBox(message) }

            section(L("settingsPage.profileSettings.personalDetails")) {
                HStack(spacing: 24) {
                    avatar(profile)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(profile.name?.isEmpty == false ? profile.name! : L("settingsPage.profileSettings.noName"))
                            .webText(18, 700)
                            .foregroundStyle(AppTheme.textPrimary)
                        Text(profile.email?.isEmpty == false ? profile.email! : L("settingsPage.profileSettings.noEmail"))
                            .webText(15.2)
                            .foregroundStyle(AppTheme.textMuted)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }

            section(L("settingsPage.profileSettings.usernameSection")) {
                VStack(alignment: .leading, spacing: 8) {
                    Text(L("settingsPage.profileSettings.yourUsername"))
                        .webText(14, 500)
                        .foregroundStyle(AppTheme.textSecondary)
                    TextField("", text: $username, prompt: Text(L("settingsPage.profileSettings.usernamePlaceholder")).foregroundStyle(AppTheme.textLight))
                        .focused($usernameFocused)
                        .font(DSFont.arial(15.2))
                        .foregroundStyle(AppTheme.textPrimary)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .padding(.horizontal, 17)
                        .frame(height: 43)
                        .background(usernameFocused ? Color.white.opacity(0.02) : Color.clear)
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(usernameFocused ? AppTheme.primary : AppTheme.borderLight, lineWidth: usernameFocused ? 2 : 1))
                }
                PillButton(
                    label: isSavingUsername ? L("settingsPage.profileSettings.savingLabel") : L("settingsPage.profileSettings.updateUsername"),
                    disabled: isSavingUsername || username == (profile.username ?? "") || username.trimmingCharacters(in: .whitespaces).isEmpty
                ) {
                    Task { await saveUsername() }
                }
                .padding(.top, 8)
            }

            section(L("settingsPage.profileSettings.privacy")) {
                HStack(alignment: .top, spacing: 24) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(L("settingsPage.profileSettings.discoverable"))
                            .webText(16, 500)
                            .foregroundStyle(AppTheme.textPrimary)
                        Text(L("settingsPage.profileSettings.discoverableDescription"))
                            .webText(14, lineHeight: 19.6)
                            .foregroundStyle(AppTheme.textMuted)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    WebCheckbox(isOn: isDiscoverable, size: 20, disabled: isSavingDiscoverability, label: L("settingsPage.profileSettings.discoverable")) { value in
                        Task { await toggleDiscoverability(value) }
                    }
                    .padding(.top, 4)
                }
                .padding(17)
                .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(AppTheme.borderLight, lineWidth: 1))
            }

            DeleteDataSettingsView()
        }
    }

    private func section<Content: View>(_ title: String, isLast: Bool = false, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 20) {
            SettingsSectionTitle(title)
            content()
        }
        .padding(.bottom, isLast ? 0 : 33)
        .overlay(alignment: .bottom) {
            if !isLast { Rectangle().fill(AppTheme.borderLight).frame(height: 1) }
        }
    }

    private func avatar(_ profile: CustomerProfileResponse) -> some View {
        Group {
            if let picture = profile.picture, let url = URL(string: picture) {
                AsyncImage(url: url) { image in
                    image.resizable().scaledToFill()
                } placeholder: {
                    Color(hex: "#E2E8F0")
                }
            } else {
                Color(hex: "#E2E8F0")
            }
        }
        .frame(width: 64, height: 64)
        .clipShape(Circle())
        .overlay(Circle().strokeBorder(AppTheme.borderLight, lineWidth: 2).padding(1))
    }

    private func messageBox(_ message: (text: String, kind: WebMessageKind)) -> some View {
        let isError = message.kind == .error
        let tint = isError ? Color(hex: "#DC2626") : AppTheme.success
        return Text(message.text)
            .webText(15.2, 500)
            .foregroundStyle(tint)
            .padding(17)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(isError ? Color(red: 220 / 255, green: 38 / 255, blue: 38 / 255).opacity(0.1) : Color(red: 60 / 255, green: 114 / 255, blue: 103 / 255).opacity(0.1))
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(isError ? Color(red: 220 / 255, green: 38 / 255, blue: 38 / 255).opacity(0.2) : Color(red: 60 / 255, green: 114 / 255, blue: 103 / 255).opacity(0.2), lineWidth: 1))
    }

    /// The previous session's copy paints, a fresh fetch revalidates; the same content
    /// coming back again must not clobber in-progress typing (useProfile + seededRef).
    private func load() async {
        if profile == nil, let cacheKey, let cached = CacheStore.shared.read(CustomerProfileResponse.self, key: cacheKey) {
            apply(cached)
        }
        guard let token = try? await auth.getAccessTokenSilently() else {
            isLoading = false
            return
        }
        if let fresh = await UserService.getUserProfile(token: token) {
            apply(fresh)
            persist(fresh)
        }
        isLoading = false
    }

    private func apply(_ value: CustomerProfileResponse) {
        profile = value
        let signature = "\(value.username ?? "")|\(value.isDiscoverable)"
        guard seededSignature != signature else { return }
        seededSignature = signature
        username = value.username ?? ""
        isDiscoverable = value.isDiscoverable
    }

    private func persist(_ value: CustomerProfileResponse) {
        if let cacheKey { CacheStore.shared.write(value, key: cacheKey) }
    }

    private func saveUsername() async {
        guard !username.isEmpty, username != profile?.username, let token = try? await auth.getAccessTokenSilently() else { return }
        isSavingUsername = true
        message = nil
        defer { isSavingUsername = false }
        do {
            try await UserService.updateUsername(token: token, username: username)
            profile?.username = username
            if let profile {
                seededSignature = "\(profile.username ?? "")|\(profile.isDiscoverable)"
                persist(profile)
            }
            message = (L("settingsPage.profileSettings.usernameUpdatedMessage"), .success)
        } catch {
            let text = (error as? APIError)?.message
            message = (text?.isEmpty == false ? text! : L("settingsPage.profileSettings.usernameUpdateFailedMessage"), .error)
            username = profile?.username ?? ""
        }
    }

    private func toggleDiscoverability(_ checked: Bool) async {
        isDiscoverable = checked
        isSavingDiscoverability = true
        message = nil
        defer { isSavingDiscoverability = false }
        do {
            let token = try await auth.getAccessTokenSilently()
            try await UserService.updateDiscoverability(token: token, isDiscoverable: checked)
            profile?.isDiscoverable = checked
            if let profile {
                seededSignature = "\(profile.username ?? "")|\(profile.isDiscoverable)"
                persist(profile)
            }
        } catch {
            message = (L("settingsPage.profileSettings.discoverabilityUpdateFailedMessage"), .error)
            isDiscoverable = !checked
        }
    }
}

// MARK: - Developer (DeveloperSettings.tsx)

struct DeveloperSettingsView: View {
    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var toasts: ToastCenter

    @State private var keys: [DeveloperApiKeySummary] = []
    @State private var isLoading = true
    @State private var newKeyName = ""
    @State private var isCreating = false
    @State private var revokingKeyId: String?
    /// The full value is only ever available here, right after creation.
    @State private var createdKey: DeveloperApiKeyCreatedResponse?
    @State private var keyToRevoke: DeveloperApiKeySummary?

    var body: some View {
        VStack(alignment: .leading, spacing: 40) {
            VStack(alignment: .leading, spacing: 16) {
                InputTextWithHint(
                    hint: L("settingsPage.developerSettings.keyNameHint"),
                    placeholder: L("settingsPage.developerSettings.keyNamePlaceholder"),
                    text: $newKeyName
                )
                PillButton(
                    label: isCreating ? L("settingsPage.developerSettings.creatingLabel") : L("settingsPage.developerSettings.createApiKey"),
                    icon: "add-icon",
                    disabled: isCreating
                ) {
                    Task { await create() }
                }
            }
            .padding(.bottom, 33)
            .overlay(alignment: .bottom) { Rectangle().fill(AppTheme.borderLight).frame(height: 1) }

            if let createdKey { createdPanel(createdKey) }

            VStack(alignment: .leading, spacing: 16) {
                SettingsSectionTitle(L("settingsPage.developerSettings.yourApiKeys"))
                if isLoading {
                    emptyState(L("settingsPage.developerSettings.loading"))
                } else if keys.isEmpty {
                    emptyState(L("settingsPage.developerSettings.noKeysYet"))
                } else {
                    VStack(spacing: 0) {
                        ForEach(Array(keys.enumerated()), id: \.element.id) { index, key in
                            keyRow(key, isLast: index == keys.count - 1)
                        }
                    }
                }
            }
        }
        .alert(
            keyToRevoke.map { L("settingsPage.developerSettings.revokeConfirm", ["name": $0.name]) } ?? "",
            isPresented: Binding(get: { keyToRevoke != nil }, set: { if !$0 { keyToRevoke = nil } })
        ) {
            Button(L("settingsPage.developerSettings.revoke"), role: .destructive) {
                if let key = keyToRevoke { Task { await revoke(key) } }
            }
            Button(L("settingsPage.toolsSettings.cancel"), role: .cancel) {}
        }
        .task { await load() }
    }

    private func emptyState(_ text: String) -> some View {
        Text(text).webText(15.2).foregroundStyle(AppTheme.textMuted)
    }

    private func createdPanel(_ created: DeveloperApiKeyCreatedResponse) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(L("settingsPage.developerSettings.createdKeyTitle", ["name": created.name]))
                .webText(16, 600)
                .foregroundStyle(AppTheme.textPrimary)
            Text(L("settingsPage.developerSettings.createdKeyWarning"))
                .webText(14.4)
                .foregroundStyle(AppTheme.textMuted)
            HStack(spacing: 12) {
                ScrollView(.horizontal, showsIndicators: false) {
                    Text(verbatim: created.apiKey)
                        .webText(mono: 14.4)
                        .foregroundStyle(AppTheme.textPrimary)
                        .textSelection(.enabled)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 9.6)
                }
                .background(AppTheme.borderLight)
                .clipShape(RoundedRectangle(cornerRadius: DSRadius.md))
                PillButton(label: L("settingsPage.developerSettings.copy"), icon: "copy-icon", style: .secondary) {
                    UIPasteboard.general.string = created.apiKey
                    toasts.showToast(L("settingsPage.developerSettings.copiedToast"))
                }
                .fixedSize()
            }
            PillButton(label: L("settingsPage.developerSettings.savedMyKey"), style: .secondary) {
                createdKey = nil
            }
        }
        .padding(21)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(AppTheme.borderLight, lineWidth: 1))
    }

    private func keyRow(_ key: DeveloperApiKeySummary, isLast: Bool) -> some View {
        HStack(spacing: 16) {
            VStack(alignment: .leading, spacing: 4) {
                WebTruncatedLine(key.name)
                    .webText(16, 600)
                    .foregroundStyle(AppTheme.textPrimary)
                Text("\(key.prefix)…")
                    .webText(mono: 13.6)
                    .foregroundStyle(AppTheme.textMuted)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            PillButton(
                label: revokingKeyId == key.keyId ? L("settingsPage.developerSettings.revokingLabel") : L("settingsPage.developerSettings.revoke"),
                style: .danger,
                disabled: revokingKeyId == key.keyId
            ) {
                keyToRevoke = key
            }
        }
        .padding(.vertical, 16)
        .padding(.bottom, isLast ? 0 : 1)
        .overlay(alignment: .bottom) {
            if !isLast { Rectangle().fill(AppTheme.borderLight).frame(height: 1) }
        }
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let token = try await auth.getAccessTokenSilently()
            keys = try await DeveloperApiKeysService.listKeys(token: token).keys
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

    private func revoke(_ key: DeveloperApiKeySummary) async {
        revokingKeyId = key.keyId
        defer { revokingKeyId = nil }
        do {
            let token = try await auth.getAccessTokenSilently()
            try await DeveloperApiKeysService.revokeKey(token: token, keyId: key.keyId)
            if createdKey?.keyId == key.keyId { createdKey = nil }
            toasts.showToast(L("settingsPage.developerSettings.revokedToast"))
            await load()
        } catch {
            toasts.showToast(L("settingsPage.developerSettings.revokeErrorToast"))
        }
    }
}
