import SwiftUI

/// BlockedUsersList.tsx on its own page, opened from Settings › Profile.
struct BlockedUsersView: View {
    @EnvironmentObject private var auth: AuthStore
    @EnvironmentObject private var router: AppRouter

    private enum Phase: Equatable { case loading, loaded, failed }

    @State private var users: [BlockedUser] = []
    @State private var phase = Phase.loading
    @State private var unblockingId: String?
    @State private var message: (text: String, failed: Bool)?

    var body: some View {
        DetailScaffold(
            title: L("moderation.blockedUsers.title"),
            backLabel: L("settingsPage.settingsSidebar.title"),
            onLeading: { router.openWithL2Menu(.settings(.profile)) }
        ) {
            note(L("moderation.blockedUsers.intro"))
            content
            if let message {
                Text(message.text)
                    .webText(14, lineHeight: 20)
                    .foregroundStyle(message.failed ? AppTheme.error : AppTheme.textMuted)
            }
            if !users.isEmpty { note(L("moderation.blockedUsers.note")) }
        }
        .task { await load() }
    }

    @ViewBuilder
    private var content: some View {
        switch phase {
        case .loading:
            note(L("moderation.blockedUsers.loading"))
        case .failed:
            note(L("moderation.blockedUsers.loadFailed"))
            PillButton(label: L("moderation.blockedUsers.retry"), style: .secondary) { Task { await load() } }
        case .loaded where users.isEmpty:
            note(L("moderation.blockedUsers.empty"))
                .accessibilityIdentifier("blocked-users-empty")
        case .loaded:
            VStack(spacing: 0) {
                ForEach(Array(users.enumerated()), id: \.element.id) { index, user in
                    row(user, isFirst: index == 0)
                }
            }
            .background(AppTheme.backgroundSecondary)
            .clipShape(RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(AppTheme.border, lineWidth: 1))
        }
    }

    private func note(_ text: String) -> some View {
        Text(text)
            .webText(14, lineHeight: 20)
            .foregroundStyle(AppTheme.textMuted)
    }

    private func row(_ user: BlockedUser, isFirst: Bool) -> some View {
        HStack(spacing: 12) {
            Text(user.initials)
                .webText(15, 500)
                .foregroundStyle(AppTheme.primary)
                .frame(width: 40, height: 40)
                .background(AppTheme.primaryLight)
                .clipShape(Circle())
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(user.label)
                    .webText(15, 500, lineHeight: 20)
                    .foregroundStyle(AppTheme.textPrimary)
                    .lineLimit(1)
                Text(L("moderation.blockedUsers.blockedOn", ["date": Self.displayDate(user.blockedAt)]))
                    .webText(13, lineHeight: 18)
                    .foregroundStyle(AppTheme.textMuted)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Button { Task { await unblock(user) } } label: {
                Text(L(unblockingId == user.customerId ? "moderation.blockedUsers.unblocking" : "moderation.blockedUsers.unblock"))
                    .webText(14, 500)
                    .foregroundStyle(AppTheme.textPrimary)
                    .padding(.horizontal, 16)
                    .frame(height: 36)
                    .overlay(RoundedRectangle(cornerRadius: 18).strokeBorder(AppTheme.border, lineWidth: 1))
                    .contentShape(Rectangle())
            }
            .buttonStyle(WebPressStyle())
            .disabled(unblockingId == user.customerId)
            .accessibilityIdentifier("unblock-\(user.customerId)")
        }
        .padding(.horizontal, 14)
        .frame(minHeight: 64)
        .overlay(alignment: .top) {
            if !isFirst { Rectangle().fill(AppTheme.backgroundTertiary).frame(height: 1) }
        }
    }

    static func displayDate(_ iso: String) -> String {
        let parser = ISO8601DateFormatter()
        parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let date = parser.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
        return date?.formatted(date: .abbreviated, time: .omitted) ?? ""
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
