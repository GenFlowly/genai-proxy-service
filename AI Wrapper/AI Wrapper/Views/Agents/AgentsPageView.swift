import SwiftUI

/// Node-type metadata shared by AgentCard and the editor (AgentsPage.tsx).
struct NodeTypeMeta {
    let icon: String
    let label: String
    let color: Color

    static func meta(for nodeType: String) -> NodeTypeMeta {
        switch nodeType {
        case "QUERY_ANALYZER": return .init(icon: "🔍", label: "Query Analyzer", color: Color(hex: "#4f86f7"))
        case "QUERY_REWRITER": return .init(icon: "✏️", label: "Query Rewriter", color: Color(hex: "#7c5cfc"))
        case "RETRIEVAL": return .init(icon: "📦", label: "Retrieval", color: Color(hex: "#2ecc71"))
        case "RESULT_RANKER": return .init(icon: "📊", label: "Result Ranker", color: Color(hex: "#f39c12"))
        case "RESPONSE_GENERATOR": return .init(icon: "💬", label: "Response Generator", color: Color(hex: "#e74c3c"))
        case "RESPONSE_GENERATOR_WITH_REFLECTION": return .init(icon: "🪞", label: "Reflective Generator", color: Color(hex: "#e67e22"))
        default: return .init(icon: "⚙️", label: nodeType, color: Color(hex: "#6b7280"))
        }
    }
}

/// Mirrors AgentsPage — "My Agents" heading + card list with node pipeline.
struct AgentsPageView: View {
    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var router: AppRouter

    @State private var agents: [Agent] = []
    @State private var isLoading = false
    @State private var errorMessage: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            PageHeaderView(title: "My Agents", subtitle: "AI pipelines powering your conversations") {
                EmptyView()
            }

            if !auth.isAuthenticated {
                LoginRequiredView(message: "Log in to see your agents")
            } else if isLoading && agents.isEmpty {
                ProgressView("Loading agents…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let errorMessage, agents.isEmpty {
                VStack(spacing: 12) {
                    Text("⚠️").font(.largeTitle)
                    Text(errorMessage)
                        .foregroundStyle(AppTheme.textMuted)
                        .multilineTextAlignment(.center)
                    PillButton(label: "Retry") { Task { await load() } }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .padding()
            } else if agents.isEmpty {
                VStack(spacing: 12) {
                    Text("🤖").font(.largeTitle)
                    Text("No agents found")
                        .font(.headline)
                        .foregroundStyle(AppTheme.textPrimary)
                    Text("Agents are created automatically when you onboard. If you see this, try refreshing.")
                        .font(.caption)
                        .foregroundStyle(AppTheme.textMuted)
                        .multilineTextAlignment(.center)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .padding()
            } else {
                ScrollView {
                    LazyVStack(spacing: 12) {
                        ForEach(agents) { agent in
                            AgentCardView(agent: agent) {
                                router.navigate(.editAgent(agent))
                            }
                        }
                    }
                    .padding()
                }
                .refreshable { await load() }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(AppTheme.background)
        .task { await load() }
    }

    private func load() async {
        guard auth.isAuthenticated else { return }
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            let token = try await auth.getAccessTokenSilently()
            agents = try await AgentsService.getCustomerAgents(token: token).agents
        } catch {
            errorMessage = "Failed to load agents"
        }
    }
}

struct AgentCardView: View {
    var agent: Agent
    var onEdit: () -> Void
    @State private var showDetails = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("🤖")
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(agent.name)
                            .font(.headline)
                            .foregroundStyle(AppTheme.textPrimary)
                        if agent.isDefault {
                            Text("Default")
                                .font(.caption2.weight(.semibold))
                                .padding(.horizontal, 6)
                                .padding(.vertical, 2)
                                .background(AppTheme.primaryLight)
                                .foregroundStyle(AppTheme.primary)
                                .clipShape(Capsule())
                        }
                    }
                    Text("\(agent.nodes.count) node\(agent.nodes.count == 1 ? "" : "s") · max \(agent.maxIterations) iterations")
                        .font(.caption2)
                        .foregroundStyle(AppTheme.textMuted)
                }
                Spacer()
                Button {
                    onEdit()
                } label: {
                    Text("✏️ Edit")
                        .font(.caption)
                        .foregroundStyle(AppTheme.primary)
                }
            }

            // Node pipeline
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(Array(agent.nodes.enumerated()), id: \.element.nodeId) { index, node in
                        let meta = NodeTypeMeta.meta(for: node.nodeType)
                        HStack(spacing: 4) {
                            Text(meta.icon)
                                .font(.caption)
                                .padding(4)
                                .background(meta.color.opacity(0.15))
                                .clipShape(Circle())
                            VStack(alignment: .leading, spacing: 0) {
                                Text(node.name)
                                    .font(.caption2.weight(.medium))
                                    .foregroundStyle(AppTheme.textPrimary)
                                Text(meta.label)
                                    .font(.system(size: 9))
                                    .foregroundStyle(AppTheme.textMuted)
                            }
                        }
                        .padding(6)
                        .background(AppTheme.backgroundTertiary)
                        .clipShape(RoundedRectangle(cornerRadius: 6))
                        if index < agent.nodes.count - 1 {
                            Text("→").foregroundStyle(AppTheme.textMuted)
                        }
                    }
                }
            }

            Button {
                withAnimation { showDetails.toggle() }
            } label: {
                Text(showDetails ? "▲ Hide details" : "▼ Show details")
                    .font(.caption2)
                    .foregroundStyle(AppTheme.primary)
            }

            if showDetails {
                VStack(alignment: .leading, spacing: 4) {
                    detailRow("Graph ID", agent.graphId, monospaced: true)
                    detailRow("Entry point", agent.entryPoint, monospaced: true)
                    if let createdAt = agent.createdAt {
                        detailRow("Created", createdAt)
                    }
                    if let updatedAt = agent.updatedAt {
                        detailRow("Last updated", updatedAt)
                    }
                }
            }
        }
        .padding()
        .background(AppTheme.backgroundSecondary)
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(AppTheme.borderLight, lineWidth: 1))
    }

    private func detailRow(_ label: String, _ value: String, monospaced: Bool = false) -> some View {
        HStack(alignment: .top) {
            Text(label)
                .font(.caption2)
                .foregroundStyle(AppTheme.textMuted)
                .frame(width: 80, alignment: .leading)
            Text(value)
                .font(monospaced ? .system(.caption2, design: .monospaced) : .caption2)
                .foregroundStyle(AppTheme.textPrimary)
        }
    }
}
