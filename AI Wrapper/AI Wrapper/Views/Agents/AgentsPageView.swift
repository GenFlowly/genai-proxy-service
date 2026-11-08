import SwiftUI

/// Node-type metadata shared by the agent cards and the editor (NODE_TYPE_META).
struct NodeTypeMeta {
    let icon: String
    let label: String
    let hex: String

    /// `${color}22` / `${color}55` on the icon tile.
    var fill: Color { Color(hex: hex).opacity(0x22 / 255) }
    var stroke: Color { Color(hex: hex).opacity(0x55 / 255) }

    static func meta(for nodeType: String) -> NodeTypeMeta {
        switch nodeType {
        case "QUERY_ANALYZER": return .init(icon: "🔍", label: L("agentsPage.nodeTypes.queryAnalyzer"), hex: "#4f86f7")
        case "QUERY_REWRITER": return .init(icon: "✏️", label: L("agentsPage.nodeTypes.queryRewriter"), hex: "#7c5cfc")
        case "RETRIEVAL": return .init(icon: "📦", label: L("agentsPage.nodeTypes.retrieval"), hex: "#2ecc71")
        case "RESULT_RANKER": return .init(icon: "📊", label: L("agentsPage.nodeTypes.resultRanker"), hex: "#f39c12")
        case "RESPONSE_GENERATOR": return .init(icon: "💬", label: L("agentsPage.nodeTypes.responseGenerator"), hex: "#e74c3c")
        case "RESPONSE_GENERATOR_WITH_REFLECTION": return .init(icon: "🪞", label: L("agentsPage.nodeTypes.reflectiveGenerator"), hex: "#e67e22")
        default: return .init(icon: "⚙️", label: nodeType, hex: "#6b7280")
        }
    }
}

extension AgentCategory {
    var labelKey: String {
        switch self {
        case .conversation: return "agentsPage.categories.conversation"
        case .memory: return "agentsPage.categories.memory"
        case .titleCreator: return "agentsPage.categories.titleCreator"
        case .instructions: return "agentsPage.categories.instructions"
        }
    }

    var menuIcon: String {
        switch self {
        case .conversation: return "chat-bubble"
        case .memory: return "brain"
        case .titleCreator: return "tag"
        case .instructions: return "document-text"
        }
    }
}

/// AgentsPage on a phone: the cards only, under the transparent MobileHeader with
/// the categories in its hamburger. Agents are created and changed on a desktop.
struct AgentsPageView: View {
    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var router: AppRouter
    @EnvironmentObject var ai: AIStore

    @State private var isLoading = true

    private var defaultId: String? {
        Agent.effectiveDefaultId(ai.agents, selectedAgentId: ai.selectedAgentId)
    }

    private var visibleAgents: [Agent] {
        ai.agents.filter { $0.resolvedCategory == router.agentsCategory && (router.agentsOwnership == .all || $0.isSystem != true) }
    }

    var body: some View {
        PageScaffold(title: L("agentsPage.agentsPage.title")) {
            if !auth.isAuthenticated {
                LoginRequiredView()
            } else {
                ScrollViewReader { proxy in
                    ScrollView {
                        content
                            .padding(.horizontal, 20)
                            .padding(.top, mobileHeaderHeight + 16)
                            .padding(.bottom, 20)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .onChange(of: router.revealAgentId, initial: true) { _, id in
                        guard let id else { return }
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
                            withAnimation(.easeOut(duration: 0.3)) { proxy.scrollTo(Self.revealAnchor(id), anchor: .top) }
                            router.revealAgentId = nil
                        }
                    }
                }
            }
        }
        .task { await load() }
    }

    private static func revealAnchor(_ id: String) -> String { "agent-\(id)" }

    @ViewBuilder
    private var content: some View {
        if isLoading && ai.agents.isEmpty {
            stateContainer {
                ProgressView().accessibilityLabel(L("agentsPage.agentsPage.loadingAriaLabel"))
                stateText(L("agentsPage.agentsPage.loading"))
            }
        } else if ai.agentsLoadFailed {
            stateContainer {
                Text("⚠️").font(.system(size: 48))
                stateText(L("agentsPage.agentsPage.loadFailed"))
                Button { Task { await load() } } label: {
                    Text(L("agentsPage.agentsPage.retry"))
                        .webText(arial: 15, bold: true)
                        .foregroundStyle(.white)
                        .padding(.horizontal, 20)
                        .padding(.vertical, 8)
                        .background(AppTheme.primary)
                        .clipShape(RoundedRectangle(cornerRadius: DSRadius.md))
                }
                .buttonStyle(WebPressStyle())
                .padding(.top, 4)
            }
        } else if ai.agents.isEmpty {
            emptyState(L("agentsPage.agentsPage.emptyTitle"), L("agentsPage.agentsPage.emptySubtitle"))
        } else {
            VStack(alignment: .leading, spacing: 16) {
                HStack(spacing: 8) {
                    AgentFilterChip(label: L("agentsPage.filters.allAgents"), value: .all)
                    AgentFilterChip(label: L("agentsPage.filters.createdByMe"), value: .mine)
                }
                if visibleAgents.isEmpty {
                    emptyState(L("agentsPage.agentsPage.noMatchesTitle"), L("agentsPage.agentsPage.noMatchesSubtitle"))
                } else {
                    LazyVStack(spacing: 24) {
                        ForEach(visibleAgents) { agent in
                            AgentCardView(
                                agent: agent,
                                isEffectiveDefault: agent.graphId == defaultId,
                                reveal: router.revealAgentId == agent.graphId,
                                onOpen: { router.navigate(.editAgent(agent)) }
                            )
                            // Lands the card below the overlay header
                            .background(alignment: .top) {
                                Color.clear
                                    .frame(height: 1)
                                    .offset(y: -(mobileHeaderHeight + 8))
                                    .id(Self.revealAnchor(agent.graphId))
                            }
                        }
                    }
                }
            }
        }
    }

    private func stateContainer<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        VStack(spacing: 16, content: content)
            .multilineTextAlignment(.center)
            .padding(.horizontal, 16)
            .padding(.vertical, 40)
            .frame(maxWidth: .infinity)
    }

    private func stateText(_ text: String) -> some View {
        Text(text).webText(17, 600).foregroundStyle(AppTheme.textPrimary)
    }

    private func emptyState(_ title: String, _ subtitle: String) -> some View {
        stateContainer {
            Text("🤖").font(.system(size: 48))
            stateText(title)
            Text(subtitle)
                .webText(14.4, lineHeight: 23.04)
                .foregroundStyle(AppTheme.textMuted)
        }
    }

    private func load() async {
        guard auth.isAuthenticated, let token = try? await auth.getAccessTokenSilently() else {
            isLoading = false
            return
        }
        isLoading = true
        await ai.fetchAgents(token: token, version: auth.cacheVersions?["agents"], force: true)
        isLoading = false
    }
}

/// `Chip` with the `cta` + `selected` variants, sized up for touch in the menu.
struct AgentFilterChip: View {
    @EnvironmentObject var router: AppRouter
    let label: String
    let value: AgentOwnership
    var forMenu = false

    var body: some View {
        let active = router.agentsOwnership == value
        Button { router.agentsOwnership = value } label: {
            Text(label)
                .webText(arial: forMenu ? 13 : 11.2, bold: active)
                .kerning(forMenu ? 0 : 0.224)
                .foregroundStyle(active ? AppTheme.primary : AppTheme.textMuted)
                .padding(.horizontal, forMenu ? 12 : 10.6)
                .frame(height: forMenu ? 36 : 21.2)
                .background(active ? AppTheme.primaryLight : AppTheme.backgroundTertiary)
                .clipShape(Capsule())
                .overlay(Capsule().strokeBorder(active ? AppTheme.primary : AppTheme.borderLight, lineWidth: 1))
        }
        .buttonStyle(WebPressStyle())
        .accessibilityAddTraits(active ? .isSelected : [])
    }
}

/// The Agents page's L2 Menu: categories above that category's agents. Search filters by name
/// across every category, since the API doesn't index agents.
struct AgentsMenuContent: View {
    @EnvironmentObject var ai: AIStore
    @EnvironmentObject var router: AppRouter
    let onClose: () -> Void

    @State private var query = ""

    private var normalizedQuery: String { query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }

    private var visibleAgents: [Agent] {
        ai.agents.filter { agent in
            (router.agentsOwnership == .all || agent.isSystem != true) && (normalizedQuery.isEmpty
                ? agent.resolvedCategory == router.agentsCategory
                : agent.name.lowercased().contains(normalizedQuery))
        }
    }

    var body: some View {
        MobileMenuBody(searchText: $query, searchPlaceholder: L("layout.mobileMenu.searchAgents")) {
            VerticalSplit(
                storageKey: "agents_menu_split_fraction",
                defaultFraction: 0.37,
                topCollapsed: false,
                bottomCollapsed: false,
                hasTop: true,
                separatorLabel: L("agentsPage.menu.resizePanels"),
                top: { categoriesCard },
                bottom: { agentsCard }
            )
        }
    }

    private var categoriesCard: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 2) {
                MenuCardLabel(title: L("agentsPage.categories.sectionLabel"))
                ForEach(AgentCategory.allCases, id: \.self) { category in
                    categoryRow(category)
                }
            }
            .padding(.bottom, 8)
        }
        .scrollBounceBehavior(.basedOnSize)
    }

    private func categoryRow(_ category: AgentCategory) -> some View {
        let active = normalizedQuery.isEmpty && router.agentsCategory == category
        let count = ai.agents.filter { $0.resolvedCategory == category }.count
        return Button { router.agentsCategory = category } label: {
            HStack(spacing: 8) {
                WebIcon(name: category.menuIcon, size: 18, color: AppTheme.textMuted)
                Text(L(category.labelKey))
                    .webText(arial: 15.2, bold: active, lineHeight: 19.76)
                    .foregroundStyle(active ? AppTheme.textPrimary : AppTheme.textSecondary)
                    .lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Text(String(count))
                    .webText(arial: 12, lineHeight: 15.6)
                    .foregroundStyle(AppTheme.textMuted)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 1.6)
                    .background(AppTheme.backgroundTertiary)
                    .clipShape(Capsule())
            }
            .padding(.horizontal, 8)
            .frame(minHeight: 48)
            .background(active ? AppTheme.backgroundSelected : Color.clear)
            .clipShape(RoundedRectangle(cornerRadius: DSRadius.sm))
            .contentShape(Rectangle())
        }
        .buttonStyle(RowPressStyle())
        .accessibilityAddTraits(active ? .isSelected : [])
    }

    private var agentsCard: some View {
        VStack(spacing: 0) {
            HStack(spacing: 6) {
                Text(L("agentsPage.menu.agents").uppercased())
                    .webText(arial: 12, bold: true)
                    .kerning(0.6)
                    .foregroundStyle(AppTheme.textMuted)
                    .frame(maxWidth: .infinity, alignment: .leading)
                AgentFilterChip(label: L("agentsPage.filters.allAgents"), value: .all, forMenu: true)
                AgentFilterChip(label: L("agentsPage.filters.createdByMe"), value: .mine, forMenu: true)
            }
            .padding(.horizontal, 8)
            .frame(height: 52)

            ScrollView {
                if visibleAgents.isEmpty {
                    Text(L("agentsPage.menu.noAgents"))
                        .webText(13.6, lineHeight: 20.4)
                        .foregroundStyle(AppTheme.textMuted)
                        .padding(.vertical, 16)
                        .frame(maxWidth: .infinity)
                } else {
                    LazyVStack(alignment: .leading, spacing: 2) {
                        ForEach(visibleAgents) { agent in
                            agentRow(agent)
                        }
                    }
                    .padding(.bottom, 8)
                }
            }
            .scrollBounceBehavior(.basedOnSize)
        }
    }

    private func agentRow(_ agent: Agent) -> some View {
        Button {
            router.agentsCategory = agent.resolvedCategory
            router.revealAgentId = agent.graphId
            onClose()
        } label: {
            VStack(alignment: .leading, spacing: 4) {
                WebTruncatedLine(agent.name)
                    .webText(arial: 15.2, lineHeight: 19.76)
                    .foregroundStyle(AppTheme.textSecondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Text(L(agent.isSystem == true ? "agentsPage.menu.systemReadOnly" : "agentsPage.menu.createdByYou"))
                    .webText(arial: 11.52, lineHeight: 13.824)
                    .foregroundStyle(AppTheme.textMuted)
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 9.6)
            .frame(minHeight: 48)
            .contentShape(Rectangle())
        }
        .buttonStyle(RowPressStyle())
    }
}

/// `/agents/:graphId` and `/agents/new` on a phone: the link to open on a desktop.
struct AgentDesktopNoticeView: View {
    @EnvironmentObject var router: AppRouter
    /// Nil for `/agents/new`.
    let graphId: String?

    @State private var copied = false

    static func desktopURL(graphId: String?) -> String {
        AppConfig.webAppURL
            .appendingPathComponent("agents")
            .appendingPathComponent(graphId ?? "new")
            .absoluteString
    }

    private var url: String { Self.desktopURL(graphId: graphId) }

    var body: some View {
        PageScaffold(title: L("agentsPage.graphEditorPage.desktopNeededTitle")) {
            VStack(spacing: 12) {
                Text("🖥️").font(.system(size: 40))
                Text(L("agentsPage.graphEditorPage.desktopNeededTitle"))
                    .webText(20, 700)
                    .foregroundStyle(AppTheme.textPrimary)
                Text(L(graphId == nil ? "agentsPage.graphEditorPage.desktopNeededCreateBody" : "agentsPage.graphEditorPage.desktopNeededEditBody"))
                    .webText(15, lineHeight: 22.5)
                    .foregroundStyle(AppTheme.textMuted)
                Text(verbatim: url)
                    .font(DSFont.mono(14))
                    .foregroundStyle(AppTheme.textPrimary)
                    .textSelection(.enabled)
                    .padding(.horizontal, 13)
                    .padding(.vertical, 9)
                    .frame(maxWidth: 416)
                    .background(AppTheme.backgroundSecondary)
                    .clipShape(RoundedRectangle(cornerRadius: DSRadius.md))
                    .overlay(RoundedRectangle(cornerRadius: DSRadius.md).strokeBorder(AppTheme.border, lineWidth: 1))
                    .accessibilityIdentifier("agent-desktop-url")
                Button {
                    UIPasteboard.general.string = url
                    copied = true
                } label: {
                    Text(L(copied ? "common.copyToClipboard.copied" : "common.copyToClipboard.copy"))
                        .webText(arial: 15, bold: true)
                        .foregroundStyle(AppTheme.textPrimary)
                        .padding(.horizontal, 21)
                        .padding(.vertical, 9)
                        .background(AppTheme.backgroundSecondary)
                        .clipShape(RoundedRectangle(cornerRadius: DSRadius.md))
                        .overlay(RoundedRectangle(cornerRadius: DSRadius.md).strokeBorder(AppTheme.border, lineWidth: 1))
                }
                .buttonStyle(WebPressStyle())
                .task(id: copied) {
                    guard copied else { return }
                    try? await Task.sleep(nanoseconds: 2_000_000_000)
                    if !Task.isCancelled { copied = false }
                }
                Button { router.navigate(.agents) } label: {
                    Text(L("agentsPage.graphEditorPage.backToAgents"))
                        .webText(15, 600)
                        .foregroundStyle(.white)
                        .padding(.horizontal, 20)
                        .padding(.vertical, 8)
                        .background(AppTheme.primary)
                        .clipShape(RoundedRectangle(cornerRadius: DSRadius.md))
                }
                .buttonStyle(WebPressStyle())
                .padding(.top, 8)
            }
            .multilineTextAlignment(.center)
            .padding(.horizontal, 24)
            .padding(.top, 56)
            .padding(.bottom, 32)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .edgeSwipeBack { router.navigate(.agents) }
    }
}

// MARK: - Badges shared with the editor

struct AgentSystemBadge: View {
    var size: CGFloat = 12
    var horizontalPadding: CGFloat = 11
    var verticalPadding: CGFloat = 4.2
    var kerning: CGFloat = 0.24

    var body: some View {
        Text(L("agentsPage.agentCard.systemBadge"))
            .webText(size, 600)
            .kerning(kerning)
            .foregroundStyle(AppTheme.systemBadgeText)
            .fixedSize()
            .padding(.horizontal, horizontalPadding)
            .padding(.vertical, verticalPadding)
            .background(Color(red: 243 / 255, green: 156 / 255, blue: 18 / 255).opacity(0.12))
            .clipShape(Capsule())
            .overlay(Capsule().strokeBorder(Color(red: 243 / 255, green: 156 / 255, blue: 18 / 255).opacity(0.5), lineWidth: 1))
    }
}

struct AgentDefaultBadge: View {
    var size: CGFloat = 12
    var horizontalPadding: CGFloat = 11
    var verticalPadding: CGFloat = 4.2
    var kerning: CGFloat = 0.24

    var body: some View {
        Text(L("agentsPage.agentCard.defaultBadge"))
            .webText(size, 600)
            .kerning(kerning)
            .foregroundStyle(AppTheme.primary)
            .fixedSize()
            .padding(.horizontal, horizontalPadding)
            .padding(.vertical, verticalPadding)
            .background(AppTheme.primaryLight)
            .clipShape(Capsule())
            .overlay(Capsule().strokeBorder(AppTheme.primary, lineWidth: 1))
    }
}

// MARK: - AgentCard

struct AgentCardView: View {
    let agent: Agent
    let isEffectiveDefault: Bool
    /// Picked in the mobile menu: opens the details.
    var reveal = false
    let onOpen: () -> Void

    @State private var expanded = false

    private var isSystem: Bool { agent.isSystem == true }

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            header
            pipeline
            detailsToggle
            if expanded { details }
        }
        .onChange(of: reveal, initial: true) { _, reveal in
            if reveal { expanded = true }
        }
        .padding(25)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(AppTheme.backgroundSecondary)
        .clipShape(RoundedRectangle(cornerRadius: DSRadius.xl))
        .overlay(
            RoundedRectangle(cornerRadius: DSRadius.xl)
                .strokeBorder(isEffectiveDefault ? AppTheme.primary : AppTheme.border, lineWidth: 1)
        )
        .overlay {
            // `box-shadow: 0 0 0 1px`: a second line outside the border.
            if isEffectiveDefault {
                RoundedRectangle(cornerRadius: DSRadius.xl + 1)
                    .strokeBorder(AppTheme.primary, lineWidth: 1)
                    .padding(-1)
            }
        }
        .shadow(color: AppTheme.shadowSmall, radius: 1, y: 1)
        .contentShape(RoundedRectangle(cornerRadius: DSRadius.xl))
        .onTapGesture(perform: onOpen)
        .accessibilityAddTraits(.isButton)
        .accessibilityLabel(L(isSystem ? "agentsPage.agentCard.viewAriaLabel" : "agentsPage.agentCard.editAriaLabel", ["name": agent.name]))
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 12) {
                EmojiIcon(text: "🤖", size: 32, advance: 32, lineHeight: 32)
                VStack(alignment: .leading, spacing: 3.2) {
                    Text(agent.name)
                        .webText(17, 700, lineHeight: 22.1)
                        .foregroundStyle(AppTheme.textPrimary)
                    Text(L("agentsPage.agentCard.meta", ["count": agent.nodes.count, "maxIterations": agent.maxIterations]))
                        .webText(13)
                        .foregroundStyle(AppTheme.textMuted)
                        .frame(minHeight: 18.75)
                }
            }
            if isEffectiveDefault || isSystem {
                HStack(spacing: 8) {
                    if isEffectiveDefault { AgentDefaultBadge() }
                    if isSystem { AgentSystemBadge() }
                }
            }
        }
    }

    private var pipeline: some View {
        VStack(spacing: 6) {
            ForEach(Array(agent.nodes.enumerated()), id: \.element.nodeId) { index, node in
                let meta = NodeTypeMeta.meta(for: node.nodeType)
                HStack(spacing: 10) {
                    NodeIconTile(meta: meta)
                    WebTruncatedLine(node.name)
                        .webText(14, 600)
                        .foregroundStyle(AppTheme.textPrimary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .padding(.horizontal, 13)
                .padding(.vertical, 9)
                .background(AppTheme.backgroundTertiary)
                .clipShape(RoundedRectangle(cornerRadius: DSRadius.md))
                .overlay(RoundedRectangle(cornerRadius: DSRadius.md).strokeBorder(AppTheme.borderLight, lineWidth: 1))
                if index < agent.nodes.count - 1 {
                    Text("→")
                        .webText(14, lineHeight: 14)
                        .foregroundStyle(AppTheme.textMuted)
                        .frame(maxWidth: .infinity)
                        .padding(.leading, 14)
                }
            }
        }
    }

    private var detailsToggle: some View {
        Button { expanded.toggle() } label: {
            Text(expanded ? L("agentsPage.agentCard.hideDetails") : L("agentsPage.agentCard.showDetails"))
                .webText(arial: 13)
                .foregroundStyle(AppTheme.textMuted)
                .padding(.vertical, 8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
        }
        .buttonStyle(WebPressStyle())
        .accessibilityAddTraits(expanded ? .isSelected : [])
    }

    private var details: some View {
        VStack(alignment: .leading, spacing: 8) {
            detailRow(L("agentsPage.agentCard.graphId"), agent.graphId, mono: true)
            detailRow(L("agentsPage.agentCard.entryPoint"), agent.entryPoint, mono: true)
            if let created = ServerDate.parse(agent.createdAt) {
                detailRow(L("agentsPage.agentCard.created"), ServerDate.dateTime(created))
            }
            if let updated = ServerDate.parse(agent.updatedAt) {
                detailRow(L("agentsPage.agentCard.lastUpdated"), ServerDate.dateTime(updated))
            }
        }
        .padding(15)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(AppTheme.backgroundTertiary)
        .clipShape(RoundedRectangle(cornerRadius: DSRadius.md))
        .overlay(RoundedRectangle(cornerRadius: DSRadius.md).strokeBorder(AppTheme.borderLight, lineWidth: 1))
        // Taps here select/copy ids and must not open the agent.
        .contentShape(Rectangle())
        .onTapGesture {}
    }

    private func detailRow(_ label: String, _ value: String, mono: Bool = false) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Text(label)
                .webText(13, 600)
                .foregroundStyle(AppTheme.textMuted)
                .frame(minWidth: 96, alignment: .leading)
            Text(verbatim: value)
                .font(mono ? DSFont.mono(13) : DSFont.roboto(13))
                .foregroundStyle(AppTheme.textPrimary)
                .textSelection(.enabled)
        }
    }
}

/// `.nodeIcon`: 32pt tile tinted with the node type's color.
struct NodeIconTile: View {
    let meta: NodeTypeMeta

    var body: some View {
        Text(meta.icon)
            .font(.system(size: 16))
            .frame(width: 32, height: 32)
            .background(meta.fill)
            .clipShape(RoundedRectangle(cornerRadius: DSRadius.sm))
            .overlay(RoundedRectangle(cornerRadius: DSRadius.sm).strokeBorder(meta.stroke, lineWidth: 1))
    }
}
