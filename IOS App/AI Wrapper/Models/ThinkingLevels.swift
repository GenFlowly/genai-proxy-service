import Foundation

/// Valid values for an LLM's `thinking_level`/`reasoning` config, derived from
/// the model id. Port of src/utils/thinkingLevels.ts, mirroring the vendor
/// mapping applied by the retrieval-server (graph/llm_factory.py).
enum ThinkingLevel: String, Codable, CaseIterable {
    case none, low, medium, high
}

struct ThinkingLevelOption: Identifiable, Equatable {
    let value: ThinkingLevel
    /// Native vendor setting this level maps to, shown next to the label.
    let native: String

    var id: String { value.rawValue }

    /// Web label: i18n `thinkingLevel_<value>` + " — <native>".
    var label: String {
        let base = L("agentsPage.nodeConfigEditor.thinkingLevel_\(value.rawValue)")
        return native.isEmpty ? base : "\(base) — \(native)"
    }
}

enum ThinkingLevels {
    static var defaultLabel: String { L("sidebar.aiVendorWidget.reasoningDefault") }

    private static let genericOptions: [ThinkingLevelOption] = [
        .init(value: .none, native: ""), .init(value: .low, native: ""),
        .init(value: .medium, native: ""), .init(value: .high, native: ""),
    ]

    // Keep in sync with _ADAPTIVE_THINKING_MODELS in llm_factory.py.
    private static let adaptiveClaudePrefixes = [
        "claude-sonnet-4-6", "claude-sonnet-5", "claude-opus-4-6",
        "claude-opus-4-7", "claude-opus-4-8", "claude-fable-5", "claude-mythos-5",
    ]

    /// Which vendor's hint describes the model (ThinkingLevelInfo.vendor).
    static func vendor(for model: String?) -> String {
        let m = (model ?? "").trimmingCharacters(in: .whitespaces).lowercased()
        if m.isEmpty { return "generic" }
        if m.hasPrefix("gpt-") || m.hasPrefix("chatgpt") || m.range(of: "^o[134]", options: .regularExpression) != nil { return "openai" }
        if m.hasPrefix("claude") { return "anthropic" }
        if m.hasPrefix("gemini") { return "gemini" }
        return "generic"
    }

    /// Reasoning options for the given model id. Empty = the model has no
    /// thinking controls (the select is hidden). An empty model id → generic list.
    static func options(for model: String?) -> [ThinkingLevelOption] {
        let m = (model ?? "").trimmingCharacters(in: .whitespaces).lowercased()
        if m.isEmpty { return genericOptions }

        if m.hasPrefix("gpt-5") {
            return [
                .init(value: .none, native: "reasoning_effort: minimal"),
                .init(value: .low, native: "reasoning_effort: low"),
                .init(value: .medium, native: "reasoning_effort: medium"),
                .init(value: .high, native: "reasoning_effort: high"),
            ]
        }
        if m.range(of: "^o[134]", options: .regularExpression) != nil {
            // o-series reasoning models have no off/minimal setting
            return [
                .init(value: .low, native: "reasoning_effort: low"),
                .init(value: .medium, native: "reasoning_effort: medium"),
                .init(value: .high, native: "reasoning_effort: high"),
            ]
        }
        if m.hasPrefix("gpt-") || m.hasPrefix("chatgpt") { return [] }

        if m.hasPrefix("claude") {
            if adaptiveClaudePrefixes.contains(where: { m.hasPrefix($0) }) {
                return [
                    .init(value: .none, native: "thinking off"),
                    .init(value: .low, native: "adaptive thinking, effort: low"),
                    .init(value: .medium, native: "adaptive thinking, effort: medium"),
                    .init(value: .high, native: "adaptive thinking, effort: high"),
                ]
            }
            return []
        }

        if m.hasPrefix("gemini-3") {
            return [
                .init(value: .none, native: "thinking_level: minimal"),
                .init(value: .low, native: "thinking_level: low"),
                .init(value: .medium, native: "thinking_level: medium"),
                .init(value: .high, native: "thinking_level: high"),
            ]
        }
        if m.hasPrefix("gemini-2.5") {
            let isPro = m.contains("pro")
            return [
                .init(value: .none, native: isPro ? "thinking budget: 128 (minimum)" : "thinking budget: 0"),
                .init(value: .low, native: "thinking budget: 1024"),
                .init(value: .medium, native: "thinking budget: 8192"),
                .init(value: .high, native: "thinking budget: 24576"),
            ]
        }
        if m.hasPrefix("gemini") { return [] }

        // Unknown vendor (long-tail BYOK) — generic; server ignores where unsupported.
        return genericOptions
    }
}
