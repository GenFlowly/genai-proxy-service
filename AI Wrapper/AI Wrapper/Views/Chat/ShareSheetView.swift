import SwiftUI

/// Mirrors the web ShareModal: PRIVATE / PUBLIC (role VIEW·EDIT) / SPECIFIC (search
/// users, per-user VIEW·EDIT). After saving a non-private share, the conversation's
/// `<WEB_APP_URL>/chat/<id>` link goes on the clipboard, like the web.
struct ShareModal: View {
    enum Target {
        case conversation(String)
        case instruction(String)
    }

    enum VisibilityMode { case privateMode, publicMode, specific }

    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var toasts: ToastCenter

    let target: Target
    let onClose: () -> Void

    @State private var mode: VisibilityMode = .privateMode
    @State private var publicRole = "VIEW"
    @State private var searchTerm = ""
    @State private var searchResults: [SearchUserResponse] = []
    @State private var selectedUsers: [SearchUserResponse] = []
    @State private var initialUsers: [SearchUserResponse] = []
    @State private var isSearching = false
    @State private var isSaving = false
    @State private var isLoading = true
    @State private var searchTask: Task<Void, Never>?
    @State private var isSearchFocused = false

    private static let searchFont = DSFont.uiArial(15.2)

    var body: some View {
        Group {
            if isLoading {
                Text(L("common.shareModal.loading"))
                    .webText(16)
                    .foregroundStyle(AppTheme.textPrimary)
                    .frame(maxWidth: .infinity)
                    .padding(20)
            } else {
                VStack(alignment: .leading, spacing: 24) {
                    VStack(alignment: .leading, spacing: 12) {
                        radio(L("common.shareModal.notSharedPrivate"), .privateMode)
                        radio(L("common.shareModal.makePublicToEveryone"), .publicMode)
                        radio(L("common.shareModal.shareWithOnlySomeUsers"), .specific)
                    }
                    if mode == .publicMode { publicSection }
                    if mode == .specific { specificSection }
                    actions
                }
            }
        }
        .task { await loadInitial() }
    }

    private func radio(_ title: String, _ value: VisibilityMode) -> some View {
        Button { mode = value } label: {
            HStack(spacing: 8) {
                NativeRadioMark(isOn: mode == value, size: 18)
                Text(title)
                    .webText(16)
                    .foregroundStyle(AppTheme.textPrimary)
                    .multilineTextAlignment(.leading)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(mode == value ? .isSelected : [])
    }

    /// `.publicSection`: padding 15, a bottom border, margin below.
    private var publicSection: some View {
        HStack(spacing: 10) {
            Text(L("common.shareModal.roleForEveryone")).webText(16).foregroundStyle(AppTheme.textPrimary)
            rolePicker(selection: publicRole) { publicRole = $0 }
        }
        .padding(.vertical, 15)
        .padding(.bottom, 1)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(alignment: .bottom) { Rectangle().fill(AppTheme.border).frame(height: 1) }
        .padding(.bottom, 15)
    }

    private static let roleFont = DSFont.uiArial(13.6)

    /// A `<select>` is as wide as its widest option, plus the native insets and the box's.
    private var roleSelectWidth: CGFloat {
        let widest = [L("common.shareModal.view"), L("common.shareModal.edit")]
            .map { ($0 as NSString).size(withAttributes: [.font: Self.roleFont]).width }
            .max() ?? 0
        return ceil(widest + 4 + 12) + (4 + 1) * 2
    }

    /// `.roleSelect`: padding 2/4, 1pt border, radius 4, 0.85rem, no background of its own
    /// (`--color-background-primary` is undefined).
    private func rolePicker(selection: String, onChange: @escaping (String) -> Void) -> some View {
        Menu {
            Button(L("common.shareModal.view")) { onChange("VIEW") }
            Button(L("common.shareModal.edit")) { onChange("EDIT") }
        } label: {
            NativeSelectLabel(
                text: selection == "EDIT" ? L("common.shareModal.edit") : L("common.shareModal.view"),
                font: Self.roleFont,
                horizontalPadding: 4
            )
            .padding(1)
            .frame(width: roleSelectWidth, height: 23)
            .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(AppTheme.border, lineWidth: 1))
            .contentShape(Rectangle())
        }
    }

    private var specificSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            WebInputField(text: $searchTerm, isFocused: $isSearchFocused, font: Self.searchFont)
                .accessibilityLabel(L("common.shareModal.searchUsernamePlaceholder"))
                .inputPlaceholder(L("common.shareModal.searchUsernamePlaceholder"), isEmpty: searchTerm.isEmpty, font: Self.searchFont)
                .padding(.horizontal, 13)
                .frame(height: 35)
                .background(AppTheme.backgroundTertiary)
                .clipShape(RoundedRectangle(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(isSearchFocused ? AppTheme.primary : AppTheme.border, lineWidth: 1))
                .onChange(of: searchTerm) { _, value in scheduleSearch(value) }

            if isSearching {
                Text(L("common.shareModal.searching")).webText(13.6).foregroundStyle(AppTheme.textSecondary)
            }
            if !searchResults.isEmpty {
                VStack(spacing: 4) {
                    ForEach(searchResults) { user in
                        Button { addUser(user) } label: {
                            Text(joining: Text(verbatim: user.username).bold(), Text(user.name.map { " (\($0))" } ?? ""))
                                .webText(14.4)
                                .foregroundStyle(AppTheme.textPrimary)
                                .padding(.horizontal, 12)
                                .padding(.vertical, 8)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(WebPressStyle())
                    }
                }
                .padding(1)
                .background(AppTheme.backgroundSecondary)
                .clipShape(RoundedRectangle(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(AppTheme.border, lineWidth: 1))
                .padding(.top, 4)
            }
            if searchResults.isEmpty, searchTerm.count >= 3, !isSearching {
                Text(L("common.shareModal.noUsersFound", ["searchTerm": searchTerm])).webText(13.6).foregroundStyle(AppTheme.textSecondary)
            }
            if !selectedUsers.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    Text(L("common.shareModal.sharedWith")).webText(14.4, 500).foregroundStyle(AppTheme.textSecondary)
                    WebFlowLayout(spacing: 8) {
                        ForEach(selectedUsers) { user in
                            HStack(spacing: 6) {
                                Text(user.username).webText(13.6).foregroundStyle(AppTheme.textPrimary)
                                rolePicker(selection: user.role ?? "VIEW") { setRole(user, $0) }
                                Button { selectedUsers.removeAll { $0.customerId == user.customerId } } label: {
                                    Text("×").webText(arial: 17.6, lineHeight: 17.6).foregroundStyle(AppTheme.textSecondary)
                                }
                                .buttonStyle(.plain)
                            }
                            .padding(.horizontal, 10 + 1)
                            .padding(.vertical, 4 + 1)
                            .background(AppTheme.backgroundHover)
                            .clipShape(RoundedRectangle(cornerRadius: 16))
                            .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(AppTheme.border, lineWidth: 1))
                        }
                    }
                }
                .padding(.top, 8)
            }
        }
        .padding(.leading, 26)
    }

    private var actions: some View {
        HStack(spacing: 12) {
            PillButton(label: L("common.shareModal.cancel"), style: .secondary, disabled: isSaving, action: onClose)
            PillButton(
                label: isSaving ? L("common.shareModal.saving") : L("common.shareModal.save"),
                disabled: isSaving || (mode == .specific && selectedUsers.isEmpty)
            ) {
                Task { await save() }
            }
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
        .padding(.top, 16 + 1)
        .overlay(alignment: .top) { Rectangle().fill(AppTheme.border).frame(height: 1) }
        .padding(.top, 16)
    }

    // MARK: - Data

    private func loadInitial() async {
        defer { isLoading = false }
        guard let token = try? await auth.getAccessTokenSilently() else { return }
        let users: [SearchUserResponse]
        switch target {
        case .conversation(let id):
            guard !id.isEmpty else { return }
            users = (try? await ConversationService.getSharedUsers(token: token, conversationId: id)) ?? []
        case .instruction(let id):
            users = (try? await InstructionService.getInstructionSharedUsers(token: token, instructionId: id)) ?? []
        }
        initialUsers = users
        if let publicUser = users.first(where: { $0.customerId == "PUBLIC" }) {
            mode = .publicMode
            publicRole = publicUser.role ?? "VIEW"
            selectedUsers = users.filter { $0.customerId != "PUBLIC" }
        } else if !users.isEmpty {
            mode = .specific
            selectedUsers = users
        } else {
            mode = .privateMode
        }
    }

    private func scheduleSearch(_ query: String) {
        searchTask?.cancel()
        guard query.count >= 3 else {
            searchResults = []
            return
        }
        searchTask = Task {
            try? await Task.sleep(nanoseconds: 500_000_000)
            guard !Task.isCancelled, let token = try? await auth.getAccessTokenSilently() else { return }
            isSearching = true
            let results = await UserService.searchUserByUsername(token: token, username: query)
            if !Task.isCancelled {
                searchResults = results
                isSearching = false
            }
        }
    }

    private func addUser(_ user: SearchUserResponse) {
        guard !selectedUsers.contains(where: { $0.customerId == user.customerId }) else { return }
        var added = user
        added.role = "VIEW"
        selectedUsers.append(added)
        searchTerm = ""
        searchResults = []
    }

    private func setRole(_ user: SearchUserResponse, _ role: String) {
        if let index = selectedUsers.firstIndex(where: { $0.customerId == user.customerId }) {
            selectedUsers[index].role = role
        }
    }

    private func save() async {
        guard let token = try? await auth.getAccessTokenSilently() else { return }
        isSaving = true
        defer { isSaving = false }

        var finalUsers: [SearchUserResponse] = []
        switch mode {
        case .privateMode: finalUsers = []
        case .publicMode: finalUsers = [SearchUserResponse(customerId: "PUBLIC", name: nil, username: "Public", picture: nil, role: publicRole)]
        case .specific: finalUsers = selectedUsers
        }
        let removed = initialUsers.filter { initial in !finalUsers.contains { $0.customerId == initial.customerId } }

        do {
            for user in finalUsers { try await share(token, user.customerId, user.role ?? "VIEW") }
            for user in removed { try await unshare(token, user.customerId) }
            if case .conversation(let id) = target {
                toasts.showToast(L("conversation.conversationHeader.shareSettingsUpdated"))
                if mode != .privateMode {
                    // The link is what the user shares next — put it on the clipboard.
                    let link = AppConfig.webAppURL.appendingPathComponent("chat").appendingPathComponent(id).absoluteString
                    UIPasteboard.general.string = link
                    toasts.showToast(L("conversation.conversationHeader.urlCopiedToClipboard"))
                }
            } else {
                toasts.showToast(L("conversation.conversationHeader.shareSettingsUpdated"))
            }
        } catch {
            toasts.showToast(L("conversation.conversationHeader.shareSettingsUpdateFailed"))
        }
        onClose()
    }

    private func share(_ token: String, _ customerId: String, _ role: String) async throws {
        switch target {
        case .conversation(let id): try await ConversationService.shareConversation(token: token, conversationId: id, targetCustomerId: customerId, role: role)
        case .instruction(let id): try await InstructionService.shareInstruction(token: token, instructionId: id, targetCustomerId: customerId, role: role)
        }
    }

    private func unshare(_ token: String, _ customerId: String) async throws {
        switch target {
        case .conversation(let id): try await ConversationService.unshareConversation(token: token, conversationId: id, targetCustomerId: customerId)
        case .instruction(let id): try await InstructionService.unshareInstruction(token: token, instructionId: id, targetCustomerId: customerId)
        }
    }
}
