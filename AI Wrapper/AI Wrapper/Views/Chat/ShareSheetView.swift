import SwiftUI

/// Mirrors ShareModal — search users by exact username, grant VIEW/EDIT,
/// list and revoke existing shares. Works for conversations and instructions.
struct ShareSheetView: View {
    enum Target {
        case conversation(String)
        case instruction(String)
    }

    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var toasts: ToastCenter
    @Environment(\.dismiss) private var dismiss

    var target: Target

    @State private var searchText = ""
    @State private var searchResults: [SearchUserResponse] = []
    @State private var sharedUsers: [SearchUserResponse] = []
    @State private var isSearching = false
    @State private var isSaving = false

    var body: some View {
        NavigationStack {
            List {
                Section("Add people") {
                    HStack {
                        TextField("Search by exact username", text: $searchText)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                        Button {
                            Task { await search() }
                        } label: {
                            if isSearching {
                                ProgressView()
                            } else {
                                Image(systemName: "magnifyingglass")
                            }
                        }
                        .disabled(searchText.isEmpty || isSearching)
                    }
                    ForEach(searchResults) { user in
                        HStack {
                            userRow(user)
                            Spacer()
                            Button("View") { Task { await share(user, role: "VIEW") } }
                                .buttonStyle(.bordered)
                            Button("Edit") { Task { await share(user, role: "EDIT") } }
                                .buttonStyle(.bordered)
                        }
                    }
                }

                Section("Shared with") {
                    if sharedUsers.isEmpty {
                        Text("Not shared with anyone yet")
                            .foregroundStyle(AppTheme.textMuted)
                    }
                    ForEach(sharedUsers) { user in
                        HStack {
                            userRow(user)
                            Spacer()
                            if let role = user.role {
                                Text(role)
                                    .font(.caption2)
                                    .padding(.horizontal, 8)
                                    .padding(.vertical, 3)
                                    .background(AppTheme.backgroundTertiary)
                                    .clipShape(Capsule())
                            }
                            Button(role: .destructive) {
                                Task { await unshare(user) }
                            } label: {
                                Image(systemName: "person.badge.minus")
                            }
                        }
                    }
                }
            }
            .navigationTitle("Share")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
            .task { await loadSharedUsers() }
        }
    }

    private func userRow(_ user: SearchUserResponse) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(user.name ?? user.username)
                .font(.subheadline)
                .foregroundStyle(AppTheme.textPrimary)
            Text("@\(user.username)")
                .font(.caption2)
                .foregroundStyle(AppTheme.textMuted)
        }
    }

    private func loadSharedUsers() async {
        guard let token = try? await auth.getAccessTokenSilently() else { return }
        do {
            switch target {
            case .conversation(let id):
                guard !id.isEmpty else { return }
                sharedUsers = try await ConversationService.getSharedUsers(token: token, conversationId: id)
            case .instruction(let id):
                sharedUsers = try await InstructionService.getInstructionSharedUsers(token: token, instructionId: id)
            }
        } catch {
            // Leave empty
        }
    }

    private func search() async {
        guard let token = try? await auth.getAccessTokenSilently() else { return }
        isSearching = true
        searchResults = await UserService.searchUserByUsername(token: token, username: searchText)
        isSearching = false
    }

    private func share(_ user: SearchUserResponse, role: String) async {
        guard let token = try? await auth.getAccessTokenSilently() else { return }
        do {
            switch target {
            case .conversation(let id):
                try await ConversationService.shareConversation(token: token, conversationId: id, targetCustomerId: user.customerId, role: role)
            case .instruction(let id):
                try await InstructionService.shareInstruction(token: token, instructionId: id, targetCustomerId: user.customerId, role: role)
            }
            toasts.showToast("Share settings updated")
            searchResults.removeAll { $0.customerId == user.customerId }
            await loadSharedUsers()
        } catch {
            toasts.showToast("Failed to update share settings")
        }
    }

    private func unshare(_ user: SearchUserResponse) async {
        guard let token = try? await auth.getAccessTokenSilently() else { return }
        do {
            switch target {
            case .conversation(let id):
                try await ConversationService.unshareConversation(token: token, conversationId: id, targetCustomerId: user.customerId)
            case .instruction(let id):
                try await InstructionService.unshareInstruction(token: token, instructionId: id, targetCustomerId: user.customerId)
            }
            toasts.showToast("Share settings updated")
            sharedUsers.removeAll { $0.customerId == user.customerId }
        } catch {
            toasts.showToast("Failed to update share settings")
        }
    }
}
