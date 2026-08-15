import SwiftUI

/// Mirrors EditAgentPage — "← Back to Agents" top bar, Agent Settings card,
/// Node Configuration card with per-node accordions; saves a diff-only request.
struct EditAgentView: View {
    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var router: AppRouter

    let agent: Agent

    @State private var currentAgent: Agent
    @State private var name: String
    @State private var maxIterations: String
    @State private var nodeNames: [String: String]
    @State private var nodeConfigs: [String: String]
    @State private var isSaving = false
    @State private var errorMessage: String?
    @State private var showSaved = false

    init(agent: Agent) {
        self.agent = agent
        _currentAgent = State(initialValue: agent)
        _name = State(initialValue: agent.name)
        _maxIterations = State(initialValue: String(agent.maxIterations))
        _nodeNames = State(initialValue: Dictionary(uniqueKeysWithValues: agent.nodes.map { ($0.nodeId, $0.name) }))
        _nodeConfigs = State(initialValue: Dictionary(uniqueKeysWithValues: agent.nodes.map { ($0.nodeId, Self.prettyJSON($0.config)) }))
    }

    static func prettyJSON(_ raw: String) -> String {
        guard let data = raw.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data),
              let pretty = try? JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys]),
              let string = String(data: pretty, encoding: .utf8) else { return raw }
        return string
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            topBar

            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    if let errorMessage {
                        Text("⚠️ \(errorMessage)")
                            .font(.caption)
                            .foregroundStyle(AppTheme.error)
                            .padding(10)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(AppTheme.error.opacity(0.1))
                            .clipShape(RoundedRectangle(cornerRadius: 8))
                    }

                    settingsCard
                    nodesCard
                }
                .padding()
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(AppTheme.background)
    }

    private var topBar: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button {
                router.navigate(.agents)
            } label: {
                Text("← Back to Agents")
                    .font(.subheadline)
                    .foregroundStyle(AppTheme.primary)
            }
            HStack {
                Text("🤖")
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(currentAgent.name)
                            .font(.headline)
                            .foregroundStyle(AppTheme.textPrimary)
                        if currentAgent.isDefault {
                            Text("Default")
                                .font(.caption2.weight(.semibold))
                                .padding(.horizontal, 6)
                                .padding(.vertical, 2)
                                .background(AppTheme.primaryLight)
                                .foregroundStyle(AppTheme.primary)
                                .clipShape(Capsule())
                        }
                    }
                    Text("\(currentAgent.nodes.count) nodes · max \(currentAgent.maxIterations) iterations")
                        .font(.caption2)
                        .foregroundStyle(AppTheme.textMuted)
                }
                Spacer()
                if showSaved {
                    Text("✓ Saved")
                        .font(.caption)
                        .foregroundStyle(AppTheme.success)
                }
                PillButton(label: "Discard", style: .secondary) {
                    router.navigate(.agents)
                }
                PillButton(label: isSaving ? "Saving…" : "Save Changes", disabled: isSaving) {
                    Task { await save() }
                }
            }
        }
        .padding()
        .background(AppTheme.backgroundSecondary)
        .overlay(alignment: .bottom) {
            Divider()
        }
    }

    private var settingsCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Agent Settings")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(AppTheme.textPrimary)

            VStack(alignment: .leading, spacing: 4) {
                Text("Name").font(.caption.weight(.medium)).foregroundStyle(AppTheme.textMuted)
                TextField("Agent name", text: $name)
                    .textFieldStyle(.roundedBorder)
            }
            VStack(alignment: .leading, spacing: 4) {
                Text("Max Iterations (1–100)").font(.caption.weight(.medium)).foregroundStyle(AppTheme.textMuted)
                TextField("1–100", text: $maxIterations)
                    .keyboardType(.numberPad)
                    .textFieldStyle(.roundedBorder)
            }

            VStack(alignment: .leading, spacing: 4) {
                metaRow("Graph ID", currentAgent.graphId)
                metaRow("Entry point", currentAgent.entryPoint)
                if let updatedAt = currentAgent.updatedAt {
                    metaRow("Last saved", updatedAt)
                }
            }
        }
        .padding()
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(AppTheme.backgroundSecondary)
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(AppTheme.borderLight, lineWidth: 1))
    }

    private var nodesCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Node Configuration")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(AppTheme.textPrimary)
            Text("Expand each node to edit its name, system prompt, or full config JSON.")
                .font(.caption2)
                .foregroundStyle(AppTheme.textMuted)

            ForEach(Array(currentAgent.nodes.enumerated()), id: \.element.nodeId) { index, node in
                NodeConfigEditor(
                    node: node,
                    name: binding(for: node.nodeId, in: $nodeNames, default: node.name),
                    configJSON: binding(for: node.nodeId, in: $nodeConfigs, default: node.config)
                )
                if index < currentAgent.nodes.count - 1 {
                    Text("↓")
                        .font(.caption)
                        .foregroundStyle(AppTheme.textMuted)
                        .frame(maxWidth: .infinity)
                }
            }
        }
        .padding()
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(AppTheme.backgroundSecondary)
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(AppTheme.borderLight, lineWidth: 1))
    }

    private func metaRow(_ label: String, _ value: String) -> some View {
        HStack(alignment: .top) {
            Text(label)
                .font(.caption2)
                .foregroundStyle(AppTheme.textMuted)
                .frame(width: 80, alignment: .leading)
            Text(value)
                .font(.system(.caption2, design: .monospaced))
                .foregroundStyle(AppTheme.textPrimary)
        }
    }

    private func binding(for key: String, in dict: Binding<[String: String]>, default defaultValue: String) -> Binding<String> {
        Binding(
            get: { dict.wrappedValue[key] ?? defaultValue },
            set: { dict.wrappedValue[key] = $0 }
        )
    }

    private func save() async {
        errorMessage = nil

        let trimmedName = name.trimmingCharacters(in: .whitespaces)
        guard !trimmedName.isEmpty else {
            errorMessage = "Name cannot be blank"
            return
        }
        guard let iterations = Int(maxIterations), (1...100).contains(iterations) else {
            errorMessage = "Max iterations must be between 1 and 100"
            return
        }
        for node in currentAgent.nodes {
            let config = nodeConfigs[node.nodeId] ?? node.config
            if let data = config.data(using: .utf8), (try? JSONSerialization.jsonObject(with: data)) != nil {
                continue
            }
            errorMessage = "Node \"\(nodeNames[node.nodeId] ?? node.name)\" has invalid JSON"
            return
        }

        // Diff-only request
        var request = UpdateAgentRequest()
        if trimmedName != currentAgent.name { request.name = trimmedName }
        if iterations != currentAgent.maxIterations { request.maxIterations = iterations }
        var nodePatches: [UpdateAgentNodePatch] = []
        for node in currentAgent.nodes {
            var patch = UpdateAgentNodePatch(nodeId: node.nodeId)
            var changed = false
            if let newName = nodeNames[node.nodeId], newName != node.name {
                patch.name = newName
                changed = true
            }
            let newConfig = nodeConfigs[node.nodeId] ?? node.config
            if canonicalJSON(newConfig) != canonicalJSON(node.config) {
                patch.config = newConfig
                changed = true
            }
            if changed { nodePatches.append(patch) }
        }
        if !nodePatches.isEmpty { request.nodes = nodePatches }

        if request.name == nil, request.maxIterations == nil, request.nodes == nil {
            router.navigate(.agents)
            return
        }

        isSaving = true
        defer { isSaving = false }
        do {
            let token = try await auth.getAccessTokenSilently()
            let updated = try await AgentsService.updateAgent(token: token, graphId: currentAgent.graphId, request: request)
            currentAgent = updated
            showSaved = true
            Task {
                try? await Task.sleep(nanoseconds: 3_000_000_000)
                showSaved = false
            }
        } catch {
            errorMessage = (error as? APIError)?.message ?? "Failed to save agent"
        }
    }

    private func canonicalJSON(_ raw: String) -> String {
        guard let data = raw.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data),
              let canonical = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) else { return raw }
        return String(data: canonical, encoding: .utf8) ?? raw
    }
}

/// Mirrors NodeConfigEditor — friendly fields (system prompt / input template /
/// model override) that read/write into the raw config JSON.
struct NodeConfigEditor: View {
    let node: AgentNode
    @Binding var name: String
    @Binding var configJSON: String
    @State private var expanded = false

    private var meta: NodeTypeMeta { NodeTypeMeta.meta(for: node.nodeType) }

    private var isRetrieval: Bool { node.nodeType == "RETRIEVAL" }
    private var isResponseNode: Bool {
        node.nodeType == "RESPONSE_GENERATOR" || node.nodeType == "RESPONSE_GENERATOR_WITH_REFLECTION"
    }

    private var parsedConfig: [String: Any]? {
        guard let data = configJSON.data(using: .utf8) else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }

    private var isValidJSON: Bool {
        guard let data = configJSON.data(using: .utf8) else { return false }
        return (try? JSONSerialization.jsonObject(with: data)) != nil
    }

    var body: some View {
        DisclosureGroup(isExpanded: $expanded) {
            VStack(alignment: .leading, spacing: 12) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Node Name").font(.caption.weight(.medium))
                    TextField(node.name, text: $name)
                        .textFieldStyle(.roundedBorder)
                }

                if !isRetrieval {
                    if isResponseNode {
                        Text("The system prompt and model for this node come from the instruction and model selected at request time.")
                            .font(.caption2)
                            .foregroundStyle(AppTheme.textMuted)
                    } else {
                        configField(key: "system_prompt", label: "System Prompt", placeholder: "You are a helpful assistant.")
                        configField(key: "model_override", label: "Model Override (optional)", placeholder: "e.g. gpt-4o, claude-sonnet-4-5")
                    }
                    configField(key: "input_template", label: "Input Template", placeholder: "{query}")
                    Text("Placeholders: {query}, {context}, {chunks_text}")
                        .font(.caption2)
                        .foregroundStyle(AppTheme.textMuted)
                }

                VStack(alignment: .leading, spacing: 4) {
                    HStack {
                        Text("Raw Config JSON").font(.caption.weight(.medium))
                        if !isValidJSON {
                            Text("— invalid JSON")
                                .font(.caption2)
                                .foregroundStyle(AppTheme.error)
                        }
                    }
                    TextEditor(text: $configJSON)
                        .font(.system(.caption2, design: .monospaced))
                        .frame(minHeight: 140)
                        .padding(4)
                        .background(AppTheme.backgroundTertiary)
                        .clipShape(RoundedRectangle(cornerRadius: 6))
                }
            }
            .padding(.vertical, 4)
        } label: {
            HStack(spacing: 8) {
                Text(meta.icon)
                    .padding(5)
                    .background(meta.color.opacity(0.15))
                    .clipShape(Circle())
                VStack(alignment: .leading, spacing: 0) {
                    Text(name.isEmpty ? node.name : name)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(AppTheme.textPrimary)
                    Text(meta.label)
                        .font(.caption2)
                        .foregroundStyle(AppTheme.textMuted)
                }
                if !isValidJSON {
                    Text("Invalid JSON")
                        .font(.caption2.weight(.semibold))
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(AppTheme.error.opacity(0.15))
                        .foregroundStyle(AppTheme.error)
                        .clipShape(Capsule())
                }
            }
        }
    }

    private func configField(key: String, label: String, placeholder: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label).font(.caption.weight(.medium))
            TextField(placeholder, text: Binding(
                get: { (parsedConfig?[key] as? String) ?? "" },
                set: { newValue in
                    guard var config = parsedConfig else { return }
                    if newValue.isEmpty {
                        config.removeValue(forKey: key)
                    } else {
                        config[key] = newValue
                    }
                    if let data = try? JSONSerialization.data(withJSONObject: config, options: [.prettyPrinted, .sortedKeys]),
                       let string = String(data: data, encoding: .utf8) {
                        configJSON = string
                    }
                }
            ), axis: .vertical)
            .textFieldStyle(.roundedBorder)
        }
    }
}
