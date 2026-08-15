import SwiftUI

/// Mirrors ConversationHistoryPage (/history) — "History" heading, grouped
/// Today / Yesterday / Last 7 days / Older, archive per row, Load more.
struct ConversationHistoryPageView: View {
    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var conversation: ConversationStore
    @EnvironmentObject var router: AppRouter

    @State private var conversations: [ConversationSummary] = []
    @State private var lastEvaluatedKey: String?
    @State private var isLoading = false
    @State private var loadFailed = false
    @State private var hasLoadedOnce = false

    private static let pageSize = 15

    private struct HistoryGroup: Identifiable {
        let title: String
        let items: [ConversationSummary]
        var id: String { title }
    }

    private var groups: [HistoryGroup] {
        let calendar = Calendar.current
        let now = Date()

        var today: [ConversationSummary] = []
        var yesterday: [ConversationSummary] = []
        var lastWeek: [ConversationSummary] = []
        var older: [ConversationSummary] = []

        for item in conversations {
            guard let itemDate = Self.parseDate(item.updatedAt ?? item.createdAt) else {
                older.append(item)
                continue
            }
            if calendar.isDateInToday(itemDate) {
                today.append(item)
            } else if calendar.isDateInYesterday(itemDate) {
                yesterday.append(item)
            } else if let sevenDaysAgo = calendar.date(byAdding: .day, value: -7, to: now), itemDate > sevenDaysAgo {
                lastWeek.append(item)
            } else {
                older.append(item)
            }
        }
        return [
            HistoryGroup(title: "Today", items: today),
            HistoryGroup(title: "Yesterday", items: yesterday),
            HistoryGroup(title: "Last 7 days", items: lastWeek),
            HistoryGroup(title: "Older", items: older),
        ].filter { !$0.items.isEmpty }
    }

    static func parseDate(_ raw: String?) -> Date? {
        guard let raw else { return nil }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: raw) ?? ISO8601DateFormatter().date(from: raw)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            PageHeaderView(title: "History", subtitle: nil) { EmptyView() }

            if !auth.isAuthenticated {
                LoginRequiredView(message: "Log in to see your history")
            } else if isLoading && !hasLoadedOnce {
                skeleton
            } else if loadFailed && conversations.isEmpty {
                centered("Failed to load history")
            } else if conversations.isEmpty {
                centered("No conversations yet")
            } else {
                historyList
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(AppTheme.background)
        .task { await loadPage(reset: true) }
    }

    private func centered(_ text: String) -> some View {
        Text(text)
            .foregroundStyle(AppTheme.textMuted)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var skeleton: some View {
        VStack(spacing: 10) {
            ForEach(0..<5, id: \.self) { _ in
                RoundedRectangle(cornerRadius: 6)
                    .fill(AppTheme.backgroundTertiary)
                    .frame(height: 44)
            }
            Spacer()
        }
        .padding()
    }

    private var historyList: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                ForEach(groups) { group in
                    VStack(alignment: .leading, spacing: 6) {
                        Text(group.title)
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(AppTheme.textMuted)
                        ForEach(group.items) { item in
                            historyRow(item)
                        }
                    }
                }

                if lastEvaluatedKey != nil {
                    Button(isLoading ? "Loading…" : "Load more") {
                        Task { await loadPage(reset: false) }
                    }
                    .disabled(isLoading)
                    .font(.subheadline)
                    .foregroundStyle(AppTheme.primary)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 8)
                }
            }
            .padding()
        }
    }

    private func historyRow(_ item: ConversationSummary) -> some View {
        let isActive = item.conversationId == conversation.conversationId
        return HStack(spacing: 8) {
            HStack(spacing: 2) {
                ForEach(vendorList(item), id: \.self) { vendor in
                    CollapsedBrandIcon(vendor: vendor, size: 16)
                }
            }
            Button {
                router.navigate(.chat)
                Task { await conversation.loadConversation(item.conversationId) }
            } label: {
                VStack(alignment: .leading, spacing: 2) {
                    Text(item.title ?? item.conversationId)
                        .font(.subheadline)
                        .foregroundStyle(AppTheme.textPrimary)
                        .lineLimit(1)
                    if let date = Self.parseDate(item.updatedAt ?? item.createdAt) {
                        Text(date.formatted(date: .abbreviated, time: .shortened))
                            .font(.caption2)
                            .foregroundStyle(AppTheme.textMuted)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            Button {
                Task { await archive(item) }
            } label: {
                Image(systemName: "archivebox")
                    .font(.caption)
                    .foregroundStyle(AppTheme.textMuted)
            }
        }
        .padding(10)
        .background(isActive ? AppTheme.backgroundSelected : AppTheme.backgroundSecondary)
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(AppTheme.borderLight, lineWidth: 1))
    }

    private func vendorList(_ item: ConversationSummary) -> [AIVendor] {
        (item.vendors ?? []).compactMap(AIVendor.init(rawValue:)).sorted { $0.rawValue < $1.rawValue }
    }

    private func loadPage(reset: Bool) async {
        guard auth.isAuthenticated, !isLoading else { return }
        if reset {
            conversations = []
            lastEvaluatedKey = nil
            hasLoadedOnce = false
        }
        isLoading = true
        loadFailed = false
        defer {
            isLoading = false
            hasLoadedOnce = true
        }
        do {
            let token = try await auth.getAccessTokenSilently()
            let response = try await ConversationHistoryService.getCustomerConversations(
                token: token, pageSize: Self.pageSize, lastEvaluatedKey: reset ? nil : lastEvaluatedKey
            )
            conversations.append(contentsOf: response.conversations)
            lastEvaluatedKey = response.lastEvaluatedKey
        } catch {
            loadFailed = true
        }
    }

    private func archive(_ item: ConversationSummary) async {
        guard let token = try? await auth.getAccessTokenSilently() else { return }
        do {
            try await ConversationHistoryService.archiveConversation(token: token, conversationId: item.conversationId)
            conversations.removeAll { $0.conversationId == item.conversationId }
            if item.conversationId == conversation.conversationId {
                conversation.resetConversation()
            }
        } catch {
            // Keep the item on failure
        }
    }
}
