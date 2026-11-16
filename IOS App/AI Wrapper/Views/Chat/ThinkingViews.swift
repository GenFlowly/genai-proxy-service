import SwiftUI

/// Thinking summary inside each response card, between the header and the text. The whole
/// section collapses behind "Thinking" / "Thought for Ns" — open while the turn is live,
/// auto-collapsed once the answer lands; each step manages its own expansion too.
struct ThinkingSection: View {
    let steps: [String]
    let stepList: [ThinkingStep]
    let isThinking: Bool
    let durationMs: Int?
    let text: String

    @State private var isExpanded: Bool

    init(steps: [String], stepList: [ThinkingStep], isThinking: Bool, durationMs: Int?, text: String) {
        self.steps = steps
        self.stepList = stepList
        self.isThinking = isThinking
        self.durationMs = durationMs
        self.text = text
        // Expanded only while live thinking — historical loads start collapsed.
        _isExpanded = State(initialValue: isThinking)
    }

    /// Legacy flat "k" strings become plain steps so everything renders through one view.
    private var displaySteps: [ThinkingStep] {
        steps.enumerated().map { index, step in
            ThinkingStep(node: "legacy-\(index)", name: step, status: "done")
        } + stepList
    }

    private var label: String {
        if !isThinking, let durationMs {
            return L("conversation.response.thoughtForSeconds", ["count": max(1, Int((Double(durationMs) / 1000).rounded()))])
        }
        return L("conversation.response.thinking")
    }

    var body: some View {
        if !displaySteps.isEmpty || isThinking {
            VStack(alignment: .leading, spacing: 4) {
                Button { isExpanded.toggle() } label: {
                    HStack(spacing: 6) {
                        if isThinking { PulseDot() }
                        Text(label).webText(14, lineHeight: 19.6)
                        Text(isExpanded ? "▼" : "▶\u{FE0E}").webText(9)
                    }
                    .foregroundStyle(AppTheme.textMuted)
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(isExpanded ? .isSelected : [])

                if isExpanded {
                    ThinkingStepsList(steps: displaySteps, isThinking: isThinking, finalText: text)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.bottom, 14)
            .onChange(of: isThinking) { _, thinking in
                if !thinking { isExpanded = false }
            }
        }
    }
}

/// ThinkingSteps.tsx: per-node steps in arrival order.
struct ThinkingStepsList: View {
    let steps: [ThinkingStep]
    let isThinking: Bool
    let finalText: String

    /// The LAST completed LLM-backed step that produced answer text rather than tool calls:
    /// its response IS the message's answer, so it never renders inside the thinking flow.
    private var terminalIndex: Int? {
        steps.lastIndex { step in
            step.status == "done"
                && (step.kind == "LLM" || step.kind == "REFLECTION")
                && !(step.response ?? "").isEmpty
                && (step.toolCalls ?? []).isEmpty
        }
    }

    /// Every todos-carrying step holds the FULL list; only the newest is current.
    private var todosIndex: Int? {
        steps.lastIndex { !($0.todos ?? []).isEmpty }
    }

    var body: some View {
        let hasFinalText = !finalText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        VStack(alignment: .leading, spacing: 7.2) {
            ForEach(Array(steps.enumerated()), id: \.offset) { index, step in
                ThinkingStepRow(
                    step: step,
                    isThinking: isThinking,
                    isFinalAnswer: index == terminalIndex && hasFinalText,
                    isOrphanAnswer: index == terminalIndex && !hasFinalText,
                    showTodos: index == todosIndex
                )
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct ThinkingStepRow: View {
    let step: ThinkingStep
    let isThinking: Bool
    let isFinalAnswer: Bool
    let isOrphanAnswer: Bool
    let showTodos: Bool

    @State private var expanded: Bool

    private static let stepIndent: CGFloat = 22.4

    init(step: ThinkingStep, isThinking: Bool, isFinalAnswer: Bool, isOrphanAnswer: Bool, showTodos: Bool) {
        self.step = step
        self.isThinking = isThinking
        self.isFinalAnswer = isFinalAnswer
        self.isOrphanAnswer = isOrphanAnswer
        self.showTodos = showTodos
        _expanded = State(initialValue: isThinking)
    }

    private var isRunning: Bool { step.status == "running" }

    private var kindIcon: String? {
        switch step.kind {
        case "LLM": return "lucide-brain"
        case "MEMORY": return "lucide-book-open"
        case "RETRIEVAL": return "lucide-file-search"
        case "WEB_SEARCH": return "lucide-globe"
        case "REFLECTION": return "lucide-sparkles"
        case "TOOL": return "lucide-wrench"
        default: return nil
        }
    }

    private var hasToolCalls: Bool { !isRunning && !(step.toolCalls ?? []).isEmpty }
    private var hasCalls: Bool { !isRunning && !(step.calls ?? []).isEmpty }
    private var hasSources: Bool { !isRunning && !(step.sources ?? []).isEmpty }
    private var hasItems: Bool { !isRunning && !(step.items ?? []).isEmpty }
    private var hasMemories: Bool {
        !isRunning && ((step.memoriesCore?.count ?? 0) + (step.memoriesRecalled?.count ?? 0)) > 0
    }

    /// The response block only earns its place when it says something the row doesn't
    /// already; an errored turn's terminal step is the one override.
    private var showResponse: Bool {
        !isRunning && !(step.response ?? "").isEmpty && !isFinalAnswer
            && (isOrphanAnswer || ((step.toolCalls ?? []).isEmpty && (step.detail ?? "").isEmpty && step.response != step.reasoning))
    }

    private var hasDetails: Bool {
        !isRunning && (hasToolCalls || hasCalls || hasSources || hasMemories || hasItems || !(step.prompt ?? "").isEmpty || showResponse)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 2.4) {
            HStack(spacing: 6.4) {
                if let kindIcon {
                    WebIcon(name: kindIcon, size: 14, color: AppTheme.textMuted).opacity(0.8)
                }
                if isRunning { PulseDot() }
                Text(isRunning ? (step.label?.isEmpty == false ? step.label! : step.name) : step.name)
                    .webText(13.6, lineHeight: 20.4)
                    .foregroundStyle(AppTheme.textMuted)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if hasDetails {
                    Button { expanded.toggle() } label: {
                        Text(expanded ? "▼" : "▶\u{FE0E}")
                            .webText(10.88, lineHeight: 16.32)
                            .foregroundStyle(AppTheme.textMuted)
                            .padding(.horizontal, 3.2)
                    }
                    .buttonStyle(.plain)
                }
            }

            // Narration stays visible even when the row is collapsed — it's the turn's
            // story, like the detail line, not a debug artifact.
            if !isRunning, let reasoning = step.reasoning, !reasoning.isEmpty {
                Text(reasoning)
                    .webText(12.8, lineHeight: 19.2, italic: true)
                    .foregroundStyle(AppTheme.textMuted)
                    .opacity(0.85)
                    .padding(.leading, Self.stepIndent)
            }
            if showTodos, let todos = step.todos, !todos.isEmpty {
                TodoChecklist(todos: todos).padding(.leading, Self.stepIndent)
            }
            if !isRunning, let detail = step.detail, !detail.isEmpty, !hasToolCalls, !isFinalAnswer {
                Text(detail)
                    .webText(12.8, lineHeight: 19.2)
                    .foregroundStyle(AppTheme.textMuted)
                    .opacity(0.85)
                    .padding(.leading, Self.stepIndent)
            }
            if expanded { expandedContent }
        }
        .onChange(of: isThinking) { _, thinking in
            if !thinking { expanded = false }
        }
    }

    @ViewBuilder private var expandedContent: some View {
        if hasToolCalls {
            ItemList(items: (step.toolCalls ?? []).map(\.signature)).padding(.leading, Self.stepIndent)
        }
        if hasCalls {
            VStack(alignment: .leading, spacing: 6.4) {
                ForEach(Array((step.calls ?? []).enumerated()), id: \.offset) { _, call in
                    VStack(alignment: .leading, spacing: 2.4) {
                        Text(call.signature)
                            .webText(mono: 12, lineHeight: 18)
                            .foregroundStyle(AppTheme.textMuted)
                            .opacity(0.85)
                        if let error = call.error, !error.isEmpty {
                            Text(error)
                                .webText(12.48, lineHeight: 18.72)
                                .foregroundStyle(AppTheme.error)
                                .opacity(0.9)
                        } else if !call.sources.isEmpty {
                            SourceLinks(sources: call.sources)
                        }
                    }
                }
            }
            .padding(.leading, Self.stepIndent)
        }
        if hasMemories {
            VStack(alignment: .leading, spacing: 5.6) {
                memoryGroup(L("conversation.response.memoryRecalledLabel"), step.memoriesRecalled ?? [])
                memoryGroup(L("conversation.response.memoryCoreLabel"), step.memoriesCore ?? [])
            }
            .padding(.leading, Self.stepIndent)
        }
        if !hasCalls, !hasSources, !hasMemories, hasItems {
            ItemList(items: step.items ?? []).padding(.leading, Self.stepIndent)
        }
        if hasSources, let sources = step.sources {
            SourceLinks(sources: sources)
        }
        if let prompt = step.prompt, !prompt.isEmpty {
            // The label's 0.2rem margin collapses into the block's larger one.
            VStack(alignment: .leading, spacing: 0) {
                Text(L("conversation.response.thinkingPrompt"))
                    .webText(11.52, lineHeight: 17.28)
                    .foregroundStyle(AppTheme.textMuted)
                PromptBlock(text: prompt)
            }
            .padding(.leading, Self.stepIndent)
        }
        if showResponse, let response = step.response {
            NestedResponseCard(title: step.name, content: response)
                .padding(.leading, Self.stepIndent)
        }
    }

    @ViewBuilder private func memoryGroup(_ label: String, _ texts: [String]) -> some View {
        if !texts.isEmpty {
            VStack(alignment: .leading, spacing: 3.2) {
                Text(label).webText(11.52, lineHeight: 17.28).foregroundStyle(AppTheme.textMuted)
                ItemList(items: texts)
            }
        }
    }
}

/// `.items`: circle-bulleted list, 12.48/18.72 at 75% opacity, 17.6pt inside its indent.
private struct ItemList: View {
    let items: [String]

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                HStack(alignment: .top, spacing: 0) {
                    Circle()
                        .strokeBorder(AppTheme.textMuted, lineWidth: 1)
                        .frame(width: 5, height: 5)
                        .frame(width: 17.6, height: 18.72, alignment: .center)
                    Text(item)
                        .webText(12.48, lineHeight: 18.72)
                        .foregroundStyle(AppTheme.textMuted)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
        .opacity(0.75)
    }
}

/// {index, title, url} results as clickable links.
private struct SourceLinks: View {
    let sources: [WebSource]

    var body: some View {
        VStack(alignment: .leading, spacing: 3.2) {
            ForEach(sources, id: \.index) { source in
                HStack(alignment: .firstTextBaseline, spacing: 5.6) {
                    Text("[\(source.index)]")
                        .webText(12.48, lineHeight: 18.72)
                        .monospacedDigit()
                        .foregroundStyle(AppTheme.textMuted)
                    Link(destination: URL(string: source.url) ?? AppConfig.webAppURL) {
                        Text(source.title.isEmpty ? source.url : source.title)
                            .webText(12.48, lineHeight: 18.72)
                            .underline()
                            .multilineTextAlignment(.leading)
                            .foregroundStyle(AppTheme.textPrimary)
                    }
                }
            }
        }
        .padding(.leading, 17.6)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// The agent's current plan as a checklist (write_todos).
private struct TodoChecklist: View {
    let todos: [TodoItem]

    var body: some View {
        VStack(alignment: .leading, spacing: 2.4) {
            ForEach(Array(todos.enumerated()), id: \.offset) { _, todo in
                HStack(alignment: .firstTextBaseline, spacing: 6.4) {
                    Text(todo.status == "completed" ? "☑" : (todo.status == "in_progress" ? "◐" : "☐"))
                        .webText(12.8)
                    Text(todo.content)
                        .webText(12.8, todo.status == "in_progress" ? 600 : 400)
                        .strikethrough(todo.status == "completed")
                        .opacity(todo.status == "completed" ? 0.6 : 1)
                }
                .foregroundStyle(AppTheme.textMuted)
            }
        }
        .padding(.vertical, 3.2)
    }
}

/// `.expanderContent` under the article's `pre` rule: code surface, 1pt border, 16/24
/// padding, wrapping 14.4/20.88 monospace, scrolling inside a 256pt cap.
private struct PromptBlock: View {
    private static let maximumHeight: CGFloat = 256

    let text: String

    @State private var contentHeight: CGFloat = 0

    var body: some View {
        ScrollView {
            WebSelectableText(text: text, font: DSFont.uiMono(14.4), lineHeight: 20.88, color: AppTheme.UI.textMuted)
                .padding(.horizontal, 24)
                .padding(.vertical, 16)
                .frame(maxWidth: .infinity, alignment: .leading)
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { contentHeight = $0 }
        }
        .scrollBounceBehavior(.basedOnSize)
        .frame(height: min(contentHeight, Self.maximumHeight))
        .padding(1)
        .background(AppTheme.codeSurface)
        .clipShape(RoundedRectangle(cornerRadius: DSRadius.md))
        .overlay(RoundedRectangle(cornerRadius: DSRadius.md).strokeBorder(AppTheme.border, lineWidth: 1))
        .padding(.top, 4)
        .padding(.bottom, 24)
    }
}

/// A step's own response: a nested TextContainer (title, copy, markdown).
private struct NestedResponseCard: View {
    let title: String
    let content: String

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ZStack(alignment: .trailing) {
                Text(title)
                    .webText(19.2, 600)
                    .foregroundStyle(AppTheme.primary)
                    .frame(maxWidth: .infinity)
                    .padding(.horizontal, 50)
                CopyToClipboardButton(content: content, accessibilityLabel: L("common.textContainer.copyResponse"))
            }
            .padding(.bottom, 20)
            MarkdownView(text: content, options: .init(capitalizeFirstLetter: false, tightFirstHeading: false))
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .background(AppTheme.background)
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(AppTheme.borderLight, lineWidth: 1))
    }
}
