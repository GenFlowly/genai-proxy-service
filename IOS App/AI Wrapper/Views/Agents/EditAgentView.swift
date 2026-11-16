import SwiftUI

/// The form-based agent editor, the phone fallback of GraphAgentEditorPage: compact
/// navbar, top bar with Back / Discard / Save (or Fork for System agents), then the
/// Agent Settings and Node Configuration panes stacked, each scrolling on its own.
struct EditAgentView: View {
    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var router: AppRouter
    @EnvironmentObject var ai: AIStore

    let initialAgent: Agent

    @State private var agent: Agent
    /// Latest version of each instruction for the node selectors; nil = still loading.
    @State private var instructions: [NodeInstructionSummary]?
    @State private var name: String
    @State private var maxIterations: String
    @State private var category: AgentCategory
    @State private var nodeNames: [String: String]
    @State private var nodeConfigs: [String: String]
    @State private var saving = false
    @State private var forking = false
    @State private var saveError: String?
    @State private var saved = false
    @State private var settingsContentHeight: CGFloat = 0
    @State private var nodesContentHeight: CGFloat = 0

    init(agent: Agent) {
        initialAgent = agent
        _agent = State(initialValue: agent)
        _name = State(initialValue: agent.name)
        _maxIterations = State(initialValue: String(agent.maxIterations))
        _category = State(initialValue: agent.resolvedCategory)
        _nodeNames = State(initialValue: Self.names(of: agent))
        _nodeConfigs = State(initialValue: Self.configs(of: agent))
    }

    private static func names(of agent: Agent) -> [String: String] {
        Dictionary(uniqueKeysWithValues: agent.nodes.map { ($0.nodeId, $0.name) })
    }

    private static func configs(of agent: Agent) -> [String: String] {
        Dictionary(uniqueKeysWithValues: agent.nodes.map { ($0.nodeId, AgentConfigJSON.pretty($0.config)) })
    }

    private var isReadOnly: Bool { agent.isSystem == true }

    var body: some View {
        VStack(spacing: 0) {
            CompactNavbar()
            topBar
            if isReadOnly { systemBanner }
            GeometryReader { proxy in
                let heights = paneHeights(available: proxy.size.height)
                VStack(spacing: 0) {
                    settingsPane.frame(height: heights.settings)
                    nodesPane.frame(height: heights.nodes)
                }
            }
            .ignoresSafeArea(.container, edges: .bottom)
        }
        .background(AppTheme.background.ignoresSafeArea())
        .task { await loadAll() }
    }

    /// Auto grid rows of a phone-width `.editLayout`. Each pane starts at its padding (28pt
    /// each way + the hairline, 20pt each way) and the free height grows them equally until
    /// one reaches its content; any height left after that stretches both.
    private func paneHeights(available: CGFloat) -> (settings: CGFloat, nodes: CGFloat) {
        var settings = (available + 17) / 2
        var nodes = (available - 17) / 2
        guard settingsContentHeight > 0, nodesContentHeight > 0 else { return (settings, nodes) }
        if settingsContentHeight + nodesContentHeight <= available {
            let extra = (available - settingsContentHeight - nodesContentHeight) / 2
            return (settingsContentHeight + extra, nodesContentHeight + extra)
        }
        if settings > settingsContentHeight {
            settings = settingsContentHeight
            nodes = available - settings
        } else if nodes > nodesContentHeight {
            nodes = nodesContentHeight
            settings = available - nodes
        }
        return (settings, nodes)
    }

    // MARK: Top bar

    private var topBar: some View {
        VStack(alignment: .leading, spacing: 24) {
            HStack(spacing: 20) {
                Button { router.navigate(.agents) } label: {
                    Text(L("agentsPage.editAgentPage.backToAgents"))
                        .webText(arial: 14)
                        .foregroundStyle(AppTheme.textMuted)
                        .lineLimit(1)
                        .fixedSize()
                        .padding(.horizontal, 15)
                        .frame(height: 30)
                        .overlay(RoundedRectangle(cornerRadius: DSRadius.md).strokeBorder(AppTheme.border, lineWidth: 1))
                }
                .buttonStyle(WebPressStyle())

                HStack(spacing: 12) {
                    EmojiIcon(text: "🤖", size: 24, advance: 24, lineHeight: 24)
                    VStack(alignment: .leading, spacing: 1.6) {
                        WebTruncatedLine(agent.name)
                            .webText(16, 700)
                            .foregroundStyle(AppTheme.textPrimary)
                        HStack(spacing: 8) {
                            metaText
                            if agent.isDefault {
                                AgentDefaultBadge(size: 11.2, horizontalPadding: 9, verticalPadding: 2.6, kerning: 0)
                            }
                            if isReadOnly {
                                AgentSystemBadge(size: 11.2, horizontalPadding: 9, verticalPadding: 2.6, kerning: 0)
                            }
                        }
                    }
                }
            }
            // A long meta line overflows the padding, never the page.
            .frame(minWidth: 0, maxWidth: .infinity, alignment: .leading)

            HStack(spacing: 12) {
                if saved {
                    Text(L("agentsPage.editAgentPage.savedBadge"))
                        .webText(13, 600)
                        .foregroundStyle(Color(hex: "#4ADE80"))
                        .padding(.horizontal, 12)
                        .padding(.vertical, 4)
                        .background(Color(hex: "#4ADE80").opacity(0.1))
                        .clipShape(Capsule())
                        .overlay(Capsule().strokeBorder(Color(red: 46 / 255, green: 204 / 255, blue: 113 / 255).opacity(0.4), lineWidth: 1))
                }
                if saveError != nil {
                    Text(L("agentsPage.editAgentPage.errorBadge"))
                        .webText(13, 600)
                        .foregroundStyle(Color(hex: "#C0392B"))
                        .padding(.horizontal, 12)
                        .padding(.vertical, 4)
                        .background(Color(hex: "#E74C3C").opacity(0.1))
                        .clipShape(Capsule())
                        .overlay(Capsule().strokeBorder(Color(hex: "#E74C3C").opacity(0.3), lineWidth: 1))
                }
                Button { router.navigate(.agents) } label: {
                    Text(L("agentsPage.editAgentPage.discard"))
                        .webText(arial: 14)
                        .foregroundStyle(AppTheme.textSecondary)
                        .padding(.horizontal, 17)
                        .frame(height: 32)
                        .overlay(RoundedRectangle(cornerRadius: DSRadius.md).strokeBorder(AppTheme.border, lineWidth: 1))
                }
                .buttonStyle(WebPressStyle())
                .disabled(saving || forking)
                .opacity(saving || forking ? 0.5 : 1)

                if isReadOnly {
                    primaryButton(disabled: forking, action: { Task { await fork() } }) {
                        if forking {
                            ProgressView().controlSize(.mini).tint(.white)
                            Text(L("agentsPage.editAgentPage.forking"))
                        } else {
                            WebIcon(name: "git-fork", size: 14, color: .white)
                            Text(L("agentsPage.editAgentPage.forkToEdit"))
                        }
                    }
                } else {
                    primaryButton(disabled: saving, action: { Task { await save() } }) {
                        if saving {
                            ProgressView().controlSize(.mini).tint(.white)
                            Text(L("agentsPage.editAgentPage.saving"))
                        } else {
                            Text(L("agentsPage.editAgentPage.saveChanges"))
                        }
                    }
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 12)
        .padding(.bottom, 13)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(AppTheme.backgroundSecondary)
        .overlay(alignment: .bottom) { Rectangle().fill(AppTheme.border).frame(height: 1) }
    }

    /// Wraps between words only: a word never breaks, even if the row overflows slightly.
    private var metaText: some View {
        let text = L("agentsPage.editAgentPage.topBarMeta", ["count": agent.nodes.count, "maxIterations": agent.maxIterations])
        let font = DSFont.ui(12.8)
        let longest = text.split(separator: " ").map { ($0 as NSString).size(withAttributes: [.font: font]).width }.max() ?? 0
        return Text(text)
            .webText(12.8)
            .foregroundStyle(AppTheme.textMuted)
            .fixedSize(horizontal: false, vertical: true)
            .frame(minWidth: ceil(longest), alignment: .leading)
    }

    private func primaryButton<Label: View>(disabled: Bool, action: @escaping () -> Void, @ViewBuilder label: () -> Label) -> some View {
        Button(action: action) {
            HStack(spacing: 6.4) { label() }
                .webText(arial: 14, bold: true)
                .foregroundStyle(.white)
                .padding(.horizontal, 20)
                .frame(height: 30)
                .background(AppTheme.primary)
                .clipShape(RoundedRectangle(cornerRadius: DSRadius.md))
        }
        .buttonStyle(WebPressStyle())
        .disabled(disabled)
        .opacity(disabled ? 0.6 : 1)
    }

    private var systemBanner: some View {
        HStack(spacing: 10) {
            Text("ℹ️").webText(13)
            Text(L("agentsPage.editAgentPage.systemBanner"))
                .webText(13, lineHeight: 18.2)
                .foregroundStyle(AppTheme.textPrimary)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, 16)
        .padding(.top, 10)
        .padding(.bottom, 11)
        .background(Color(red: 243 / 255, green: 156 / 255, blue: 18 / 255).opacity(0.08))
        .overlay(alignment: .bottom) {
            Rectangle().fill(Color(red: 243 / 255, green: 156 / 255, blue: 18 / 255).opacity(0.3)).frame(height: 1)
        }
    }

    // MARK: Agent settings pane

    private func cardTitle(_ text: String) -> some View {
        Text(text.uppercased())
            .webText(14, 700)
            .kerning(0.84)
            .foregroundStyle(AppTheme.textPrimary)
            .padding(.bottom, 11)
            .frame(maxWidth: .infinity, alignment: .leading)
            .overlay(alignment: .bottom) { Rectangle().fill(AppTheme.borderLight).frame(height: 1) }
    }

    private var settingsPane: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                cardTitle(L("agentsPage.editAgentPage.agentSettings"))

                AgentFieldGroup {
                    AgentFieldLabel(L("agentsPage.editAgentPage.nameLabel"))
                    WebFieldInput(text: $name, disabled: isReadOnly)
                }
                AgentFieldGroup {
                    AgentFieldLabel(L("agentsPage.editAgentPage.maxIterations"), detail: L("agentsPage.editAgentPage.maxIterationsRange"))
                    WebFieldInput(text: $maxIterations, disabled: isReadOnly, keyboard: .numberPad)
                }
                AgentFieldGroup {
                    AgentFieldLabel(L("agentsPage.editAgentPage.categoryLabel"))
                    WebFieldSelect(
                        value: category.rawValue,
                        options: AgentCategory.allCases.map { .init(value: $0.rawValue, label: L($0.labelKey)) },
                        disabled: isReadOnly,
                        onChange: { value in
                            if let picked = AgentCategory(rawValue: value) { category = picked }
                        }
                    )
                }

                if let saveError {
                    HStack(alignment: .top, spacing: 8) {
                        Text("⚠️")
                        Text(saveError).webText(13, lineHeight: 18.2)
                    }
                    .font(DSFont.roboto(13))
                    .foregroundStyle(Color(hex: "#C0392B"))
                    .padding(.horizontal, 15)
                    .padding(.vertical, 11)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color(hex: "#E74C3C").opacity(0.07))
                    .clipShape(RoundedRectangle(cornerRadius: DSRadius.md))
                    .overlay(RoundedRectangle(cornerRadius: DSRadius.md).strokeBorder(Color(hex: "#E74C3C").opacity(0.25), lineWidth: 1))
                }

                VStack(alignment: .leading, spacing: 8) {
                    metaRow(L("agentsPage.editAgentPage.graphId"), agent.graphId)
                    metaRow(L("agentsPage.editAgentPage.entryPoint"), agent.entryPoint)
                    if let updated = ServerDate.parse(agent.updatedAt) {
                        metaRow(L("agentsPage.editAgentPage.lastSaved"), ServerDate.dateTime(updated))
                    }
                }
                .padding(15)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(AppTheme.backgroundTertiary)
                .clipShape(RoundedRectangle(cornerRadius: DSRadius.md))
                .overlay(RoundedRectangle(cornerRadius: DSRadius.md).strokeBorder(AppTheme.borderLight, lineWidth: 1))
                .padding(.top, 8)
            }
            .padding(.horizontal, 28)
            .padding(.top, 48)
            .padding(.bottom, 28)
            .padding(.bottom, 1)
            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { settingsContentHeight = $0 }
        }
        .scrollDismissesKeyboard(.interactively)
        .overlay(alignment: .bottom) { Rectangle().fill(AppTheme.border).frame(height: 1) }
    }

    private func metaRow(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 3.2) {
            Text(label).webText(12, 600).foregroundStyle(AppTheme.textMuted)
            Text(verbatim: value)
                .webText(sfMono: 13)
                .foregroundStyle(AppTheme.textPrimary)
                .textSelection(.enabled)
        }
    }

    // MARK: Node pane

    private var nodesPane: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                VStack(alignment: .leading, spacing: 6) {
                    cardTitle(L("agentsPage.editAgentPage.nodeConfiguration"))
                    Text(L("agentsPage.editAgentPage.nodeConfigurationSubtitle"))
                        .webText(13, lineHeight: 19.5)
                        .foregroundStyle(AppTheme.textMuted)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                VStack(spacing: 0) {
                    ForEach(Array(agent.nodes.enumerated()), id: \.element.nodeId) { index, node in
                        NodeConfigEditor(
                            node: node,
                            agentName: agent.name,
                            name: binding(for: node.nodeId, in: $nodeNames, fallback: node.name),
                            config: binding(for: node.nodeId, in: $nodeConfigs, fallback: AgentConfigJSON.pretty(node.config)),
                            instructions: instructions,
                            readOnly: isReadOnly,
                            onCreateInstruction: createInstruction
                        )
                        if index < agent.nodes.count - 1 { pipelineConnector }
                    }
                }
            }
            .padding(.horizontal, 20)
            .padding(.top, 40)
            .padding(.bottom, 20)
            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { nodesContentHeight = $0 }
        }
        .scrollDismissesKeyboard(.interactively)
    }

    private var pipelineConnector: some View {
        VStack(spacing: 0) {
            Rectangle().fill(AppTheme.border).frame(width: 2, height: 10)
            Text("↓").webText(16, lineHeight: 16).foregroundStyle(AppTheme.textMuted)
            Rectangle().fill(AppTheme.border).frame(width: 2, height: 10)
        }
        .padding(.vertical, 4)
        .frame(maxWidth: .infinity)
    }

    private func binding(for key: String, in dict: Binding<[String: String]>, fallback: String) -> Binding<String> {
        Binding(get: { dict.wrappedValue[key] ?? fallback }, set: { dict.wrappedValue[key] = $0 })
    }

    // MARK: Actions

    private func seed(_ value: Agent) {
        agent = value
        name = value.name
        maxIterations = String(value.maxIterations)
        category = value.resolvedCategory
        nodeNames = Self.names(of: value)
        nodeConfigs = Self.configs(of: value)
    }

    /// Paints the cached copy, then revalidates; identical fresh content never re-seeds,
    /// so typing between the paint and the response isn't clobbered.
    private func loadAll() async {
        guard let token = try? await auth.getAccessTokenSilently() else { return }
        async let fresh = try? AgentsService.getAgent(token: token, graphId: initialAgent.graphId)
        async let list = try? InstructionService.getCustomerInstructions(token: token)
        if let found = await fresh, found != agent { seed(found) }
        instructions = NodeInstructionSummary.latest(from: await list?.instructions ?? [])
    }

    /// "Convert to instruction": registers the new one so its name shows immediately.
    private func createInstruction(name: String, text: String) async throws -> InstructionResponse {
        let token = try await auth.getAccessTokenSilently()
        let created = try await InstructionService.createInstruction(
            token: token,
            request: CreateInstructionRequest(instruction: text, instructionName: name, existingInstructionId: nil)
        )
        auth.updateInstruction(created)
        var list = instructions ?? []
        list.removeAll { $0.id == created.id }
        list.append(NodeInstructionSummary(id: created.id, name: created.name.isEmpty ? name : created.name, latestVersion: created.version))
        instructions = list
        return created
    }

    private func save() async {
        saveError = nil
        saved = false
        let trimmedName = name.trimmingCharacters(in: .whitespaces)
        guard !trimmedName.isEmpty else {
            saveError = L("agentsPage.editAgentPage.errorNameBlank")
            return
        }
        guard let iterations = Int(maxIterations), (1...100).contains(iterations) else {
            saveError = L("agentsPage.editAgentPage.errorMaxIterations")
            return
        }
        for node in agent.nodes {
            let config = nodeConfigs[node.nodeId] ?? ""
            if !config.isEmpty, !AgentConfigJSON.isValid(config) {
                saveError = L("agentsPage.editAgentPage.errorNodeConfigJson", ["name": nodeNames[node.nodeId] ?? node.name])
                return
            }
        }

        // Only what changed goes out.
        var patches: [UpdateAgentNodePatch] = []
        for node in agent.nodes {
            let newName = nodeNames[node.nodeId] ?? node.name
            let original = AgentConfigJSON.pretty(node.config)
            let newConfig = nodeConfigs[node.nodeId] ?? original
            guard newName != node.name || newConfig != original else { continue }
            var patch = UpdateAgentNodePatch(nodeId: node.nodeId)
            if newName != node.name { patch.name = newName }
            if newConfig != original { patch.config = newConfig }
            patches.append(patch)
        }
        var request = UpdateAgentRequest()
        if trimmedName != agent.name { request.name = trimmedName }
        if iterations != agent.maxIterations { request.maxIterations = iterations }
        if category != agent.resolvedCategory { request.category = category.rawValue }
        if !patches.isEmpty { request.nodes = patches }

        if request.name == nil, request.maxIterations == nil, request.category == nil, request.nodes == nil {
            router.navigate(.agents)
            return
        }

        saving = true
        defer { saving = false }
        do {
            let token = try await auth.getAccessTokenSilently()
            let updated = try await AgentsService.updateAgent(token: token, graphId: agent.graphId, request: request)
            ai.applyAgent(updated)
            seed(updated)
            saved = true
            Task {
                try? await Task.sleep(nanoseconds: 3_000_000_000)
                saved = false
            }
        } catch {
            saveError = (error as? APIError)?.message ?? L("agentsPage.editAgentPage.saveFailed")
        }
    }

    private func fork() async {
        forking = true
        saveError = nil
        defer { forking = false }
        do {
            let token = try await auth.getAccessTokenSilently()
            let copy = try await AgentsService.forkAgent(token: token, graphId: agent.graphId)
            ai.applyAgent(copy)
            router.navigate(.editAgent(copy))
        } catch {
            saveError = (error as? APIError)?.message ?? L("agentsPage.editAgentPage.forkFailed")
        }
    }
}

// MARK: - Helpers

struct NodeInstructionSummary: Identifiable, Equatable {
    let id: String
    let name: String
    let latestVersion: Int

    static func latest(from list: [InstructionResponse]) -> [NodeInstructionSummary] {
        var byId: [String: NodeInstructionSummary] = [:]
        for instruction in list where (byId[instruction.id]?.latestVersion ?? -1) < instruction.version {
            byId[instruction.id] = NodeInstructionSummary(id: instruction.id, name: instruction.name, latestVersion: instruction.version)
        }
        return byId.values.sorted { $0.name.localizedCompare($1.name) == .orderedAscending }
    }
}

enum AgentConfigJSON {
    /// `JSON.stringify(JSON.parse(raw), null, 2)`, key order preserved.
    static func pretty(_ raw: String) -> String {
        guard let value = JSONValue.parse(raw) else { return raw }
        return prettyPrinted(value)
    }

    static func prettyPrinted(_ value: JSONValue, indent: Int = 0) -> String {
        let pad = String(repeating: "  ", count: indent + 1)
        let close = String(repeating: "  ", count: indent)
        switch value {
        case .array(let items) where !items.isEmpty:
            return "[\n" + items.map { pad + prettyPrinted($0, indent: indent + 1) }.joined(separator: ",\n") + "\n\(close)]"
        case .object(let pairs) where !pairs.isEmpty:
            return "{\n" + pairs.map { pad + JSONValue.string($0.0).jsonString + ": " + prettyPrinted($0.1, indent: indent + 1) }.joined(separator: ",\n") + "\n\(close)}"
        default:
            return value.jsonString
        }
    }

    static func isValid(_ raw: String) -> Bool {
        guard let data = raw.data(using: .utf8) else { return false }
        return (try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])) != nil
    }
}

private struct AgentFieldGroup<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 6) { content }
    }
}

/// `.fieldLabel` + the optional 12/400 inline suffix.
private struct AgentFieldLabel: View {
    let text: String
    var detail: String?

    init(_ text: String, detail: String? = nil) {
        self.text = text
        self.detail = detail
    }

    var body: some View {
        HStack(spacing: 3.5) {
            Text(text).webText(13, 600)
            if let detail { Text(detail).webText(12) }
        }
        .foregroundStyle(AppTheme.textMuted)
    }
}

private struct AgentFieldHint: View {
    let text: String

    var body: some View {
        Text(text)
            .webText(12, lineHeight: 16.8)
            .foregroundStyle(AppTheme.textMuted)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - NodeConfigEditor (accordion)

struct NodeConfigEditor: View {
    let node: AgentNode
    let agentName: String
    @Binding var name: String
    @Binding var config: String
    let instructions: [NodeInstructionSummary]?
    let readOnly: Bool
    let onCreateInstruction: (String, String) async throws -> InstructionResponse

    @State private var open = false
    @State private var pickerOpen = false
    @State private var pickerQuery = ""
    @State private var converting = false
    @State private var convertError: String?

    private var meta: NodeTypeMeta { NodeTypeMeta.meta(for: node.nodeType) }
    private var isResponseNode: Bool {
        node.nodeType == "RESPONSE_GENERATOR" || node.nodeType == "RESPONSE_GENERATOR_WITH_REFLECTION"
    }
    private var configInvalid: Bool {
        !config.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !AgentConfigJSON.isValid(config)
    }
    private var parsed: JSONValue { JSONValue.parse(config.isEmpty ? "{}" : config) ?? .object([]) }

    private var instructionId: String? {
        guard let id = parsed["instruction_id"]?.string, !id.isEmpty else { return nil }
        return id
    }
    /// nil follows the latest version; a number pins that version.
    private var instructionVersion: Int? { parsed["instruction_version"]?.int }
    private var legacyPrompt: String { instructionId == nil ? (parsed["system_prompt"]?.string ?? "") : "" }
    private var modelOverride: String { parsed["model_override"]?.string ?? "" }
    private var thinkingLevel: String { parsed["thinking_level"]?.string ?? "" }
    private var selectedInstruction: NodeInstructionSummary? {
        instructionId.flatMap { id in instructions?.first { $0.id == id } }
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            if open { editorBody }
        }
        .clipShape(RoundedRectangle(cornerRadius: DSRadius.lg))
        .overlay(RoundedRectangle(cornerRadius: DSRadius.lg).strokeBorder(AppTheme.border, lineWidth: 1))
    }

    private var header: some View {
        Button { open.toggle() } label: {
            HStack(spacing: 12) {
                NodeIconTile(meta: meta)
                WebTruncatedLine(name.isEmpty ? node.name : name)
                    .webText(arial: 15, bold: true)
                    .foregroundStyle(AppTheme.textPrimary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Text(meta.label)
                    .webText(arial: 12)
                    .foregroundStyle(AppTheme.textMuted)
                    .lineLimit(1)
                    .fixedSize()
                if configInvalid {
                    Text(L("agentsPage.nodeConfigEditor.invalidJsonBadge"))
                        .webText(11.2, 600)
                        .foregroundStyle(Color(hex: "#C0392B"))
                        .padding(.horizontal, 8)
                        .padding(.vertical, 1.6)
                        .background(Color(hex: "#E74C3C").opacity(0.12))
                        .clipShape(Capsule())
                        .overlay(Capsule().strokeBorder(Color(hex: "#E74C3C").opacity(0.3), lineWidth: 1))
                }
                Text(open ? "▲" : "▼")
                    .webText(arial: 12)
                    .foregroundStyle(AppTheme.textMuted)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .background(AppTheme.backgroundTertiary)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        // A disabled fieldset natively disables nested buttons, the accordion included.
        .disabled(readOnly)
        .opacity(readOnly ? 0.5 : 1)
        .accessibilityAddTraits(open ? .isSelected : [])
    }

    private var editorBody: some View {
        VStack(alignment: .leading, spacing: 20) {
            AgentFieldGroup {
                AgentFieldLabel(L("agentsPage.nodeConfigEditor.nodeName"))
                WebFieldInput(text: $name, placeholder: node.name)
            }

            if node.nodeType != "RETRIEVAL" {
                if isResponseNode {
                    AgentFieldHint(text: L("agentsPage.nodeConfigEditor.responseNodeHint"))
                } else {
                    instructionField
                }
                AgentFieldGroup {
                    AgentFieldLabel(L("agentsPage.nodeConfigEditor.inputTemplate"))
                    WebFieldTextArea(
                        text: Binding(get: { parsed["input_template"]?.string ?? "" }, set: { updateField("input_template", $0) }),
                        placeholder: "{query}"
                    )
                    placeholdersHint
                }
                if !isResponseNode {
                    AgentFieldGroup {
                        AgentFieldLabel(L("agentsPage.nodeConfigEditor.modelOverride"), detail: L("agentsPage.nodeConfigEditor.optional"))
                        WebFieldInput(
                            text: Binding(get: { modelOverride }, set: { updateField("model_override", $0) }),
                            placeholder: L("agentsPage.nodeConfigEditor.modelOverridePlaceholder")
                        )
                    }
                }
                thinkingField
            }

            AgentFieldGroup {
                HStack(spacing: 3.5) {
                    AgentFieldLabel(L("agentsPage.nodeConfigEditor.rawConfigJson"))
                    if configInvalid {
                        Text(L("agentsPage.nodeConfigEditor.invalidJsonSuffix"))
                            .webText(13, 500)
                            .foregroundStyle(Color(hex: "#E74C3C"))
                    }
                }
                WebFieldTextArea(text: $config, rows: 10, mono: true, hasError: configInvalid)
            }
        }
        .padding(.horizontal, 20)
        .padding(.top, 21)
        .padding(.bottom, 24)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(AppTheme.backgroundSecondary)
        .overlay(alignment: .top) { Rectangle().fill(AppTheme.borderLight).frame(height: 1) }
    }

    private var placeholdersHint: some View {
        FlowLayout(spacing: 3) {
            Text(L("agentsPage.nodeConfigEditor.inputTemplatePlaceholdersPrefix"))
                .webText(12, lineHeight: 16.8)
                .foregroundStyle(AppTheme.textMuted)
            ForEach(["{query}", "{context}", "{chunks_text}"], id: \.self) { code in
                Text(code)
                    .webText(sfMono: 12, lineHeight: 16.8)
                    .foregroundStyle(AppTheme.textMuted)
                    .padding(.horizontal, 4.2)
                    .padding(.vertical, 1.2)
                    .background(AppTheme.backgroundTertiary)
                    .clipShape(RoundedRectangle(cornerRadius: 3))
            }
        }
    }

    @ViewBuilder
    private var instructionField: some View {
        AgentFieldGroup {
            AgentFieldLabel(L("agentsPage.nodeConfigEditor.instruction"))
            if let instructionId {
                HStack(spacing: 10) {
                    WebTruncatedLine("📄 \(selectedInstruction?.name ?? node.instructionName ?? instructionId)")
                        .webText(14, 600)
                        .foregroundStyle(AppTheme.textPrimary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Button { pickerOpen.toggle() } label: {
                        Text(L("agentsPage.nodeConfigEditor.changeInstruction"))
                            .webText(arial: 12)
                            .foregroundStyle(AppTheme.textSecondary)
                            .fixedSize()
                            .padding(.horizontal, 13)
                            .frame(height: 24)
                            .overlay(RoundedRectangle(cornerRadius: DSRadius.md).strokeBorder(AppTheme.border, lineWidth: 1))
                    }
                    .buttonStyle(WebPressStyle())
                }
                .padding(.horizontal, 15)
                .padding(.vertical, 9)
                .background(AppTheme.backgroundTertiary)
                .clipShape(RoundedRectangle(cornerRadius: DSRadius.md))
                .overlay(RoundedRectangle(cornerRadius: DSRadius.md).strokeBorder(AppTheme.border, lineWidth: 1))
                if pickerOpen { instructionPicker }
                HStack(spacing: 20) {
                    WebRadio(isOn: instructionVersion == nil, label: L("agentsPage.nodeConfigEditor.followLatest")) {
                        patchConfig(removing: ["instruction_version"])
                    }
                    WebRadio(
                        isOn: instructionVersion != nil,
                        disabled: instructionVersion == nil && selectedInstruction == nil,
                        label: instructionVersion.map { L("agentsPage.nodeConfigEditor.pinnedToVersion", ["version": $0]) } ?? L("agentsPage.nodeConfigEditor.pinToVersion")
                    ) {
                        if let latest = selectedInstruction?.latestVersion {
                            patchConfig(setting: [("instruction_version", .number(String(latest)))])
                        }
                    }
                }
            } else if !legacyPrompt.isEmpty {
                legacyPromptBox
            } else {
                instructionPicker
            }
        }
    }

    private var legacyPromptBox: some View {
        VStack(alignment: .leading, spacing: 8) {
            AgentFieldHint(text: L("agentsPage.nodeConfigEditor.legacyPromptHint"))
            WebFieldTextArea(
                text: .constant(legacyPrompt),
                rows: 5,
                disabled: true,
                textColor: AppTheme.textMuted
            )
            Button { Task { await convert() } } label: {
                Text(converting ? L("agentsPage.nodeConfigEditor.converting") : L("agentsPage.nodeConfigEditor.convertToInstruction"))
                    .webText(arial: 13, bold: true)
                    .foregroundStyle(.white)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 6)
                    .background(AppTheme.primary)
                    .clipShape(RoundedRectangle(cornerRadius: DSRadius.md))
            }
            .buttonStyle(WebPressStyle())
            .disabled(converting)
            .opacity(converting ? 0.6 : 1)
            if let convertError {
                Text(convertError).webText(13, 500).foregroundStyle(Color(hex: "#E74C3C"))
            }
        }
        .padding(12)
        .background(AppTheme.backgroundTertiary)
        .clipShape(RoundedRectangle(cornerRadius: DSRadius.md))
        .overlay(WebDashedBorder(color: AppTheme.border, cornerRadius: DSRadius.md))
    }

    private var instructionPicker: some View {
        let query = pickerQuery.trimmingCharacters(in: .whitespaces).lowercased()
        let filtered = (instructions ?? []).filter { query.isEmpty || $0.name.lowercased().contains(query) }
        return VStack(alignment: .leading, spacing: 4) {
            WebFieldInput(
                text: Binding(
                    get: { pickerQuery },
                    set: {
                        pickerQuery = $0
                        pickerOpen = true
                    }
                ),
                placeholder: L("agentsPage.nodeConfigEditor.instructionSearchPlaceholder"),
                onFocus: { pickerOpen = true }
            )
            if pickerOpen {
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        if instructions == nil {
                            pickerEmpty(L("agentsPage.nodeConfigEditor.instructionsLoading"))
                        } else if filtered.isEmpty {
                            pickerEmpty(L("agentsPage.nodeConfigEditor.noInstructionsFound"))
                        }
                        ForEach(filtered) { instruction in
                            Button { select(instruction) } label: {
                                HStack(spacing: 12) {
                                    WebTruncatedLine(instruction.name.isEmpty ? L("common.instructionTile.untitledInstruction") : instruction.name)
                                        .webText(14)
                                        .foregroundStyle(AppTheme.textPrimary)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                    Text("v\(instruction.latestVersion)")
                                        .webText(11.2)
                                        .foregroundStyle(AppTheme.textMuted)
                                }
                                .padding(.horizontal, 12)
                                .padding(.vertical, 8)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(WebPressStyle())
                        }
                    }
                    .padding(4)
                }
                .frame(maxHeight: 224)
                .fixedSize(horizontal: false, vertical: true)
                .background(AppTheme.backgroundSecondary)
                .clipShape(RoundedRectangle(cornerRadius: DSRadius.md))
                .overlay(RoundedRectangle(cornerRadius: DSRadius.md).strokeBorder(AppTheme.border, lineWidth: 1))
                .shadow(color: .black.opacity(0.4), radius: 3, y: 4)
            }
        }
    }

    private func pickerEmpty(_ text: String) -> some View {
        Text(text)
            .webText(13)
            .foregroundStyle(AppTheme.textMuted)
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
    }

    private var thinkingField: some View {
        // Response generators run on the model picked at request time: the generic set.
        let model = isResponseNode ? nil : modelOverride
        let options = ThinkingLevels.options(for: model)
        var selectOptions: [InputSelectWithHint.Option] = [.init(value: "", label: L("agentsPage.nodeConfigEditor.thinkingLevelDefault"))]
        selectOptions += options.map { .init(value: $0.value.rawValue, label: $0.label) }
        // A stored level the current model doesn't support stays visible to be cleared.
        if !thinkingLevel.isEmpty, !options.contains(where: { $0.value.rawValue == thinkingLevel }) {
            selectOptions.append(.init(value: thinkingLevel, label: thinkingLevel))
        }
        let hintVendor = options.isEmpty ? "unsupported" : ThinkingLevels.vendor(for: model)
        return AgentFieldGroup {
            AgentFieldLabel(L("agentsPage.nodeConfigEditor.thinkingLevel"), detail: L("agentsPage.nodeConfigEditor.optional"))
            WebFieldSelect(value: thinkingLevel, options: selectOptions, onChange: { updateField("thinking_level", $0) })
            AgentFieldHint(text: L("agentsPage.nodeConfigEditor.thinkingHint_\(hintVendor)"))
        }
    }

    // MARK: Config edits (every untouched key is preserved)

    private func updateField(_ key: String, _ value: String) {
        if value.isEmpty {
            patchConfig(removing: [key])
        } else {
            patchConfig(setting: [(key, .string(value))])
        }
    }

    private func patchConfig(setting: [(String, JSONValue)] = [], removing: [String] = []) {
        var pairs = parsed.pairs ?? []
        pairs.removeAll { removing.contains($0.0) }
        for (key, value) in setting {
            if let index = pairs.firstIndex(where: { $0.0 == key }) {
                pairs[index].1 = value
            } else {
                pairs.append((key, value))
            }
        }
        config = AgentConfigJSON.prettyPrinted(.object(pairs))
    }

    private func select(_ instruction: NodeInstructionSummary) {
        // Follow the latest version on (re)selection.
        patchConfig(setting: [("instruction_id", .string(instruction.id))], removing: ["system_prompt", "instruction_version"])
        pickerOpen = false
        pickerQuery = ""
    }

    private func convert() async {
        convertError = nil
        converting = true
        defer { converting = false }
        do {
            let created = try await onCreateInstruction("\(agentName) — \(name.isEmpty ? node.name : name)", legacyPrompt)
            patchConfig(setting: [("instruction_id", .string(created.id))], removing: ["system_prompt", "instruction_version"])
        } catch {
            convertError = (error as? APIError)?.message ?? L("agentsPage.nodeConfigEditor.convertFailed")
        }
    }
}
