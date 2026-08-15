import SwiftUI

/// Mirrors SettingsPage (mobile): breadcrumbs + SettingsMenuPage listing the
/// sections, with Logout in the footer.
struct SettingsMenuPageView: View {
    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var router: AppRouter

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            SettingsBreadcrumbs(section: nil)

            if !auth.isAuthenticated {
                LoginRequiredView(message: "Log in to manage settings")
            } else {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Settings")
                        .font(.title2.weight(.bold))
                        .foregroundStyle(AppTheme.textPrimary)
                        .padding(.bottom, 8)

                    ForEach(AppRouter.SettingsSection.allCases) { section in
                        Button {
                            router.navigate(.settings(section))
                        } label: {
                            HStack(spacing: 10) {
                                Image(systemName: section.icon)
                                    .frame(width: 22)
                                Text(section.label)
                                    .font(.subheadline)
                                Spacer()
                                Image(systemName: "chevron.right")
                                    .font(.caption2)
                                    .foregroundStyle(AppTheme.textMuted)
                            }
                            .foregroundStyle(AppTheme.textPrimary)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 12)
                            .background(AppTheme.backgroundSecondary)
                            .clipShape(RoundedRectangle(cornerRadius: 8))
                        }
                    }

                    Spacer()

                    HStack {
                        ThemeToggleView()
                        Spacer()
                        Button {
                            auth.logout()
                            router.navigate(.chat)
                        } label: {
                            Text("Logout")
                                .font(.subheadline.weight(.medium))
                                .foregroundStyle(AppTheme.error)
                        }
                    }
                }
                .padding()
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(AppTheme.background)
    }
}

/// Mirrors the mobile Breadcrumbs trail: Menu → Settings → [Section].
struct SettingsBreadcrumbs: View {
    @EnvironmentObject var router: AppRouter
    var section: AppRouter.SettingsSection?

    var body: some View {
        HStack(spacing: 6) {
            Button("Menu") { router.isMobileMenuOpen = true }
                .foregroundStyle(AppTheme.primary)
            Text("/").foregroundStyle(AppTheme.textMuted)
            Button("Settings") { router.navigate(.settingsMenu) }
                .foregroundStyle(section == nil ? AppTheme.textMuted : AppTheme.primary)
                .disabled(section == nil)
            if let section {
                Text("/").foregroundStyle(AppTheme.textMuted)
                Text(section.label).foregroundStyle(AppTheme.textMuted)
            }
            Spacer()
        }
        .font(.caption)
        .padding(.horizontal)
        .padding(.vertical, 8)
        .background(AppTheme.backgroundSecondary)
        .overlay(alignment: .bottom) { Divider() }
    }
}

/// A settings section page: breadcrumbs + web-style title/subtitle + content.
struct SettingsSectionPageView: View {
    @EnvironmentObject var auth: AuthStore
    var section: AppRouter.SettingsSection

    private var subtitle: String {
        switch section {
        case .profile: return "Manage your personal information and preferences."
        case .ai: return "Configure your API keys to enable various AI models across the platform."
        case .memory: return "Configure connections to your vector databases and storage providers."
        case .developer: return "Create API keys to call the API from your own applications."
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            SettingsBreadcrumbs(section: section)

            if !auth.isAuthenticated {
                LoginRequiredView(message: "Log in to manage settings")
            } else {
                VStack(alignment: .leading, spacing: 2) {
                    Text(section.title)
                        .font(.title3.weight(.bold))
                        .foregroundStyle(AppTheme.textPrimary)
                    Text(subtitle)
                        .font(.caption)
                        .foregroundStyle(AppTheme.textMuted)
                }
                .padding(.horizontal)
                .padding(.top, 12)

                Group {
                    switch section {
                    case .profile: ProfileSettingsView()
                    case .ai: AISettingsView()
                    case .memory: MemorySettingsView()
                    case .developer: DeveloperSettingsView()
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(AppTheme.background)
    }
}

// MARK: - Profile (ProfileSettings.tsx)

struct ProfileSettingsView: View {
    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var toasts: ToastCenter

    @State private var profile: CustomerProfileResponse?
    @State private var username = ""
    @State private var isDiscoverable = false
    @State private var isSavingUsername = false
    @State private var message: (text: String, isError: Bool)?

    var body: some View {
        List {
            if let message {
                Section {
                    Text(message.text)
                        .font(.caption)
                        .foregroundStyle(message.isError ? AppTheme.error : AppTheme.success)
                }
            }

            Section("Personal Details") {
                HStack(spacing: 12) {
                    if let picture = profile?.picture ?? auth.customerPicture, let url = URL(string: picture) {
                        AsyncImage(url: url) { image in
                            image.resizable()
                        } placeholder: {
                            Image(systemName: "person.crop.circle.fill")
                                .resizable()
                                .foregroundStyle(AppTheme.textMuted)
                        }
                        .frame(width: 48, height: 48)
                        .clipShape(Circle())
                    } else {
                        Image(systemName: "person.crop.circle.fill")
                            .resizable()
                            .frame(width: 48, height: 48)
                            .foregroundStyle(AppTheme.textMuted)
                    }
                    VStack(alignment: .leading, spacing: 2) {
                        Text(profile?.name ?? auth.customerName ?? "No Name")
                            .font(.headline)
                        Text(profile?.email ?? "No Email")
                            .font(.caption)
                            .foregroundStyle(AppTheme.textMuted)
                    }
                }
            }

            Section {
                TextField("e.g. johndoe-1234", text: $username)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                Button {
                    Task { await saveUsername() }
                } label: {
                    if isSavingUsername { ProgressView() } else { Text("Update Username") }
                }
                .disabled(username.isEmpty || username == profile?.username || isSavingUsername)
            } header: {
                Text("Username")
            }

            Section {
                Toggle("Discoverable", isOn: $isDiscoverable)
                    .onChange(of: isDiscoverable) { oldValue, newValue in
                        guard profile != nil, newValue != (profile?.isDiscoverable ?? false) else { return }
                        Task { await saveDiscoverability(newValue, revertTo: oldValue) }
                    }
            } header: {
                Text("Privacy")
            } footer: {
                Text("Allow other users to search for you by your exact username when sharing instructions.")
            }
        }
        .scrollContentBackground(.hidden)
        .task { await load() }
    }

    private func load() async {
        guard let token = try? await auth.getAccessTokenSilently() else { return }
        if let loaded = await UserService.getUserProfile(token: token) {
            profile = loaded
            username = loaded.username ?? ""
            isDiscoverable = loaded.isDiscoverable
        }
    }

    private func saveUsername() async {
        guard let token = try? await auth.getAccessTokenSilently() else { return }
        isSavingUsername = true
        defer { isSavingUsername = false }
        do {
            try await UserService.updateUsername(token: token, username: username)
            profile?.username = username
            message = ("Username updated.", false)
        } catch {
            message = ((error as? APIError)?.message ?? "Failed to update username.", true)
        }
    }

    private func saveDiscoverability(_ newValue: Bool, revertTo oldValue: Bool) async {
        guard let token = try? await auth.getAccessTokenSilently() else { return }
        do {
            try await UserService.updateDiscoverability(token: token, isDiscoverable: newValue)
            profile?.isDiscoverable = newValue
        } catch {
            isDiscoverable = oldValue
            message = ("Failed to update discoverability.", true)
        }
    }
}

// MARK: - AI Settings (AISettings.tsx)

struct AISettingsView: View {
    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var toasts: ToastCenter

    @State private var apiKeys: [AIVendor: String] = [:]
    @State private var savingVendor: AIVendor?

    var body: some View {
        List {
            ForEach(AIVendor.allCases) { vendor in
                let status = auth.aiVendorAPIKeyStatusList.first { $0.aiVendor == vendor.rawValue }
                Section {
                    HStack {
                        BrandNameView(vendor: vendor)
                        Spacer()
                        Text(status?.status ?? APIKeyStatus.notSet)
                            .font(.caption2)
                            .foregroundStyle((status?.isValid ?? false) ? AppTheme.success : AppTheme.textMuted)
                    }
                    SecureField("sk-...", text: Binding(
                        get: { apiKeys[vendor] ?? "" },
                        set: { apiKeys[vendor] = $0 }
                    ))
                    Button {
                        Task { await saveKey(vendor) }
                    } label: {
                        if savingVendor == vendor {
                            Text("Saving...")
                        } else {
                            Text((status?.isValid ?? false) ? "Overwrite API Key" : "Save")
                        }
                    }
                    .disabled(savingVendor != nil)
                }
            }
        }
        .scrollContentBackground(.hidden)
    }

    private func saveKey(_ vendor: AIVendor) async {
        let key = (apiKeys[vendor] ?? "").trimmingCharacters(in: .whitespaces)
        guard auth.isAuthenticated else {
            toasts.showToast("Please log in first.")
            return
        }
        guard !key.isEmpty else {
            toasts.showToast("Please enter a valid API key.")
            return
        }
        guard let token = try? await auth.getAccessTokenSilently() else { return }
        savingVendor = vendor
        defer { savingVendor = nil }
        do {
            let response = try await StoreConfigService.storeVendorApiKey(token: token, aiVendor: vendor.rawValue, apiKey: key)
            auth.updateVendorApiKeyStatus(response.apiKeyStatus)
            toasts.showToast(response.apiKeyStatus.status ?? "API key updated")
            apiKeys[vendor] = ""
        } catch {
            toasts.showToast("Failed to save API key.")
        }
    }
}

// MARK: - Memory Settings (MemorySettings.tsx)

struct MemorySettingsView: View {
    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var toasts: ToastCenter

    @State private var milvusEndpoint = ""
    @State private var milvusToken = ""
    @State private var supabaseEndpoint = ""
    @State private var supabaseKey = ""
    @State private var supabasePassword = ""
    @State private var savingSection: String?

    var body: some View {
        List {
            Section("Milvus Cloud") {
                if let status = auth.vectorDBConfigStatusList.first(where: { $0.vendor == "Zilliz" }) {
                    statusRow(status.status)
                }
                TextField("https://in03-....zillizcloud.com", text: $milvusEndpoint)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                SecureField("Placeholder token...", text: $milvusToken)
                Button(savingSection == "milvus" ? "Saving..." : "Save") {
                    Task { await saveMilvus() }
                }
                .disabled(savingSection != nil)
            }

            Section("Supabase") {
                if let status = auth.supabaseConfigStatus {
                    statusRow(status.status)
                }
                TextField("https://your-project.supabase.co", text: $supabaseEndpoint)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                SecureField("your-anon-key / service_role", text: $supabaseKey)
                SecureField("PostgreSQL Database Password", text: $supabasePassword)
                Button(savingSection == "supabase" ? "Saving..." : "Save") {
                    Task { await saveSupabase() }
                }
                .disabled(savingSection != nil)
            }
        }
        .scrollContentBackground(.hidden)
    }

    private func statusRow(_ status: String?) -> some View {
        HStack {
            Text("Status")
            Spacer()
            Text(status ?? "NOT_SET")
                .font(.caption)
                .foregroundStyle(status == "PRESENT" ? AppTheme.success : AppTheme.textMuted)
        }
    }

    private func saveMilvus() async {
        guard !milvusEndpoint.isEmpty, !milvusToken.isEmpty else {
            toasts.showToast("Please enter an endpoint and token.")
            return
        }
        guard let token = try? await auth.getAccessTokenSilently() else { return }
        savingSection = "milvus"
        defer { savingSection = nil }
        do {
            let response = try await StoreConfigService.storeVectorDBConfig(
                token: token,
                request: StoreCustomerVectorDBConfigRequest(vendor: "Zilliz", endpoint: milvusEndpoint, token: milvusToken)
            )
            auth.updateVectorDBConfigStatus(response.configStatus)
            toasts.showToast(response.configStatus.updateSuccessful == true ? "Milvus config saved" : "Milvus config failed validation")
        } catch {
            toasts.showToast("Failed to save Milvus config.")
        }
    }

    private func saveSupabase() async {
        guard URL(string: supabaseEndpoint)?.scheme?.hasPrefix("http") == true else {
            toasts.showToast("Please enter a valid endpoint URL.")
            return
        }
        guard let token = try? await auth.getAccessTokenSilently() else { return }
        savingSection = "supabase"
        defer { savingSection = nil }
        do {
            let response = try await StoreConfigService.storeSupabaseConfig(
                token: token,
                request: StoreCustomerSupabaseConfigRequest(
                    endpoint: supabaseEndpoint,
                    token: supabaseKey,
                    password: supabasePassword.isEmpty ? nil : supabasePassword
                )
            )
            auth.supabaseConfigStatus = response.configStatus
            toasts.showToast(response.configStatus.updateSuccessful == true ? "Supabase config saved" : "Supabase config failed validation")
        } catch {
            toasts.showToast("Failed to save Supabase config.")
        }
    }
}

// MARK: - Developer (DeveloperSettings.tsx)

struct DeveloperSettingsView: View {
    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var toasts: ToastCenter

    @State private var keys: [DeveloperApiKeySummary] = []
    @State private var isLoading = false
    @State private var newKeyName = ""
    @State private var isCreating = false
    @State private var createdKey: DeveloperApiKeyCreatedResponse?
    @State private var keyToRevoke: DeveloperApiKeySummary?

    var body: some View {
        List {
            Section {
                Text("Authorization: Bearer gfy_...")
                    .font(.system(.caption2, design: .monospaced))
                    .foregroundStyle(AppTheme.textMuted)
            }

            if let createdKey {
                Section {
                    Text("Key \"\(createdKey.name)\" created — copy it now")
                        .font(.subheadline.weight(.semibold))
                    Text("This key is shown only once. Store it somewhere safe.")
                        .font(.caption)
                        .foregroundStyle(AppTheme.error)
                    HStack {
                        Text(createdKey.apiKey)
                            .font(.system(.caption2, design: .monospaced))
                            .lineLimit(1)
                            .truncationMode(.middle)
                        Spacer()
                        Button("Copy") {
                            UIPasteboard.general.string = createdKey.apiKey
                            toasts.showToast("API key copied to clipboard.")
                        }
                    }
                    Button("I've saved my key") {
                        self.createdKey = nil
                    }
                }
                .listRowBackground(AppTheme.backgroundSelected)
            }

            Section("Create a key") {
                TextField("e.g. My CI server", text: $newKeyName)
                Button {
                    Task { await createKey() }
                } label: {
                    Label(isCreating ? "Creating…" : "Create API key", systemImage: "plus")
                }
                .disabled(newKeyName.isEmpty || isCreating)
            }

            Section("Your API keys") {
                if isLoading && keys.isEmpty {
                    Text("Loading…").foregroundStyle(AppTheme.textMuted)
                } else if keys.isEmpty {
                    Text("No API keys yet.").foregroundStyle(AppTheme.textMuted)
                } else {
                    ForEach(keys) { key in
                        VStack(alignment: .leading, spacing: 2) {
                            HStack {
                                Text(key.name).font(.subheadline)
                                Spacer()
                                Button("Revoke", role: .destructive) {
                                    keyToRevoke = key
                                }
                                .font(.caption)
                            }
                            Text("\(key.prefix)…")
                                .font(.system(.caption2, design: .monospaced))
                                .foregroundStyle(AppTheme.textMuted)
                            HStack(spacing: 10) {
                                if let createdAt = key.createdAt {
                                    Text("Created \(createdAt)")
                                }
                                if let lastUsedAt = key.lastUsedAt {
                                    Text("Last used \(lastUsedAt)")
                                }
                            }
                            .font(.caption2)
                            .foregroundStyle(AppTheme.textMuted)
                        }
                    }
                }
            }
        }
        .scrollContentBackground(.hidden)
        .confirmationDialog(
            "Revoke the key \"\(keyToRevoke?.name ?? "")\"? Applications using it will stop working immediately.",
            isPresented: Binding(get: { keyToRevoke != nil }, set: { if !$0 { keyToRevoke = nil } }),
            titleVisibility: .visible
        ) {
            Button("Revoke", role: .destructive) {
                if let key = keyToRevoke {
                    Task { await revoke(key) }
                }
            }
        }
        .task { await load() }
    }

    private func load() async {
        guard let token = try? await auth.getAccessTokenSilently() else { return }
        isLoading = true
        defer { isLoading = false }
        if let response = try? await DeveloperApiKeysService.listKeys(token: token) {
            keys = response.keys
        }
    }

    private func createKey() async {
        guard let token = try? await auth.getAccessTokenSilently() else { return }
        isCreating = true
        defer { isCreating = false }
        do {
            let created = try await DeveloperApiKeysService.createKey(token: token, name: newKeyName)
            createdKey = created
            newKeyName = ""
            await load()
        } catch {
            toasts.showToast("Failed to create API key.")
        }
    }

    private func revoke(_ key: DeveloperApiKeySummary) async {
        guard let token = try? await auth.getAccessTokenSilently() else { return }
        do {
            try await DeveloperApiKeysService.revokeKey(token: token, keyId: key.keyId)
            keys.removeAll { $0.keyId == key.keyId }
        } catch {
            toasts.showToast("Failed to revoke API key.")
        }
    }
}
