import SwiftUI

// MARK: - Shared controls of the tool and connector forms

/// `.cellInput`: 34pt tall, 14pt, page-colored surface.
struct WebCellInput: View {
    @Binding var text: String
    var placeholder: String = ""
    var isSecure = false
    var keyboard: UIKeyboardType = .default

    @State private var focused = false

    var body: some View {
        WebInputField(text: $text, isFocused: $focused, font: DSFont.uiArial(14), isSecure: isSecure, keyboard: keyboard)
        .accessibilityLabel(placeholder)
        .inputPlaceholder(placeholder, isEmpty: text.isEmpty, font: DSFont.uiArial(14))
        .padding(.horizontal, 10.6)
        .frame(height: 34)
        .background(AppTheme.background)
        .clipShape(RoundedRectangle(cornerRadius: DSRadius.md))
        .overlay(RoundedRectangle(cornerRadius: DSRadius.md).strokeBorder(focused ? AppTheme.primary : AppTheme.border, lineWidth: 1))
    }
}

/// `.addRowButton`: dashed outline, 13pt.
struct DashedAddButton: View {
    let label: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(label)
                .webText(arial: 13)
                .foregroundStyle(AppTheme.textSecondary)
                .padding(.horizontal, 13)
                .padding(.vertical, 6.6)
                .overlay(WebDashedBorder(color: AppTheme.border, cornerRadius: DSRadius.md))
        }
        .buttonStyle(WebPressStyle())
    }
}

/// `.pill`: muted chip in tool and connector rows.
struct SettingsChip: View {
    let text: String
    var foreground: Color = AppTheme.textMuted
    var background: Color = AppTheme.borderLight

    var body: some View {
        WebTruncatedLine(text)
            .webText(12, 500)
            .foregroundStyle(foreground)
            .padding(.horizontal, 9.6)
            .padding(.vertical, 2.4)
            .background(background)
            .clipShape(Capsule())
    }
}

/// `.form`: the outlined card an add/edit flow opens in.
struct SettingsFormCard<Content: View>: View {
    let title: String
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 32) {
            SettingsSectionTitle(title)
            content
        }
        .padding(25)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(AppTheme.borderLight, lineWidth: 1))
    }
}

/// `.section`: 16/600 title (optional) over 12pt-spaced content.
struct SettingsFormSection<Content: View>: View {
    var title: String?
    /// `.dryRunSection` / `.approvalSection`: a tinted panel.
    var isPanel = false
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let title {
                Text(title)
                    .webText(16, 600)
                    .foregroundStyle(AppTheme.textPrimary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            content
        }
        .padding(isPanel ? 21 : 0)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(isPanel ? AppTheme.backgroundSecondary : Color.clear)
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay {
            if isPanel { RoundedRectangle(cornerRadius: 8).strokeBorder(AppTheme.borderLight, lineWidth: 1) }
        }
    }
}

/// `.formFooter`: hairline above a wrapping row of buttons.
struct SettingsFormFooter<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        FlowLayout(spacing: 12) { content }
            .padding(.top, 9)
            .frame(maxWidth: .infinity, alignment: .leading)
            .overlay(alignment: .top) { Rectangle().fill(AppTheme.borderLight).frame(height: 1) }
    }
}

/// `.errorPanel`: red outline, bold title, muted detail.
struct SettingsErrorPanel: View {
    let title: String
    let detail: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).webText(16, 600).foregroundStyle(AppTheme.error)
            Text(detail).webText(13.6).foregroundStyle(AppTheme.textMuted)
        }
        .padding(.horizontal, 17)
        .padding(.vertical, 13)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(RoundedRectangle(cornerRadius: DSRadius.md).strokeBorder(AppTheme.error, lineWidth: 1))
    }
}

/// `window.confirm`: a message with OK and Cancel.
extension View {
    func webConfirm(_ message: String?, isPresented: Binding<Bool>, onConfirm: @escaping () -> Void) -> some View {
        alert(message ?? "", isPresented: isPresented) {
            Button(L("library.dialog.ok"), role: .destructive, action: onConfirm)
            Button(L("library.dialog.cancel"), role: .cancel) {}
        }
    }
}


// MARK: - Tool definition helpers (customerToolsService.ts + ToolsSettings.tsx)

private struct ArgumentDraft: Identifiable {
    let id = UUID()
    var name = ""
    var type = "string"
    var required = true
    var description = ""
}

private struct PairDraft: Identifiable {
    let id = UUID()
    var key = ""
    var value = ""
}

private struct ToolRequestTemplate {
    var method: String
    var url: String
    var headers: [(String, String)]
    var query: [(String, String)]
    var body: [(String, String)]?
    var bodyType: String

    /// Every placeholder-bearing string of the template.
    var source: [String] {
        [url] + headers.map(\.1) + query.map(\.1) + (body ?? []).map(\.1)
    }

    var json: JSONValue {
        func map(_ pairs: [(String, String)]) -> JSONValue { .object(pairs.map { ($0.0, .string($0.1)) }) }
        return .object([
            ("method", .string(method)),
            ("url", .string(url)),
            ("headers", map(headers)),
            ("query", map(query)),
            ("body", body.map(map) ?? .null),
            ("bodyType", .string(bodyType))
        ])
    }
}

private struct ToolFormDraft {
    var name = ""
    var description = ""
    var args = [ArgumentDraft()]
    var method = "GET"
    var url = ""
    var headers = [PairDraft()]
    var query = [PairDraft()]
    var body = [PairDraft()]
    var bodyType = "json"
    var transformMode = "text"
    var transformPath = ""
    var maxChars = String(ToolRules.defaultMaxChars)
    var credentialRef = ""

    private static func pairsToMap(_ pairs: [PairDraft]) -> [(String, String)] {
        var seen = Set<String>()
        var out: [(String, String)] = []
        for pair in pairs {
            let key = pair.key.trimmingCharacters(in: .whitespaces)
            guard !key.isEmpty else { continue }
            if seen.insert(key).inserted {
                out.append((key, pair.value))
            } else if let index = out.firstIndex(where: { $0.0 == key }) {
                out[index].1 = pair.value
            }
        }
        return out
    }

    var requestTemplate: ToolRequestTemplate {
        let bodyMap = Self.pairsToMap(body)
        let carriesBody = method != "GET" && method != "DELETE" && !bodyMap.isEmpty
        return ToolRequestTemplate(
            method: method,
            url: url.trimmingCharacters(in: .whitespaces),
            headers: Self.pairsToMap(headers),
            query: Self.pairsToMap(query),
            body: carriesBody ? bodyMap : nil,
            bodyType: bodyType
        )
    }

    /// The argument rows, as the restricted JSON Schema the contract stores.
    var parametersJSON: String {
        let named = args.filter { !$0.name.trimmingCharacters(in: .whitespaces).isEmpty }
        let properties: [(String, JSONValue)] = named.map { arg in
            let description = arg.description.trimmingCharacters(in: .whitespaces)
            var property: [(String, JSONValue)] = [("type", .string(arg.type))]
            if !description.isEmpty { property.append(("description", .string(description))) }
            return (arg.name.trimmingCharacters(in: .whitespaces), .object(property))
        }
        let required: [JSONValue] = named.filter(\.required).map { .string($0.name.trimmingCharacters(in: .whitespaces)) }
        return JSONValue.object([
            ("type", .string("object")),
            ("properties", .object(properties)),
            ("required", .array(required))
        ]).jsonString
    }

    var transformJSON: String {
        var pairs: [(String, JSONValue)] = [("mode", .string(transformMode))]
        if transformMode == "json_path" {
            pairs.append(("path", .string(transformPath.trimmingCharacters(in: .whitespaces))))
        }
        pairs.append(("maxChars", .number(String(Int(maxChars) ?? 0))))
        return JSONValue.object(pairs).jsonString
    }

    init() {}

    init(editing tool: CustomerTool) {
        name = tool.name
        description = tool.description
        credentialRef = tool.credentialRef

        let parameters = JSONValue.parse(tool.parameters)
        let required = (parameters?["required"]?.array ?? []).compactMap(\.string)
        let rows = (parameters?["properties"]?.pairs ?? []).map { key, property in
            ArgumentDraft(
                name: key,
                type: property["type"]?.string ?? "string",
                required: required.contains(key),
                description: property["description"]?.string ?? ""
            )
        }
        args = rows.isEmpty ? [ArgumentDraft()] : rows

        func pairs(_ value: JSONValue?) -> [PairDraft] {
            let rows = (value?.pairs ?? []).map { PairDraft(key: $0.0, value: $0.1.string ?? $0.1.jsonString) }
            return rows.isEmpty ? [PairDraft()] : rows
        }
        let request = JSONValue.parse(tool.request)
        method = request?["method"]?.string ?? "GET"
        url = request?["url"]?.string ?? ""
        headers = pairs(request?["headers"])
        query = pairs(request?["query"])
        body = pairs(request?["body"])
        bodyType = request?["bodyType"]?.string ?? "json"

        let transform = JSONValue.parse(tool.responseTransform)
        transformMode = transform?["mode"]?.string ?? "text"
        transformPath = transform?["path"]?.string ?? ""
        maxChars = String(transform?["maxChars"]?.int ?? ToolRules.defaultMaxChars)
    }
}

enum ToolRules {
    static let methods = ["GET", "POST", "PUT", "PATCH", "DELETE"]
    static let argumentTypes = ["string", "number", "integer", "boolean"]
    static let transformModes = ["text", "json", "json_path"]
    static let reservedNames = ["web_search", "generate_pdf"]
    static let minDescriptionLength = 10
    static let maxDescriptionLength = 1024
    static let maxArguments = 20
    static let defaultMaxChars = 8000
    static let maxMaxChars = 32000
    static let maskedCredential = "••••••••"

    static func isValidName(_ name: String) -> Bool {
        name.wholeMatch(of: /[a-z][a-z0-9_]{2,63}/) != nil
    }

    static func isValidArgumentName(_ name: String) -> Bool {
        name.wholeMatch(of: /[a-zA-Z_][a-zA-Z0-9_]*/) != nil
    }

    static func referenced(_ pattern: Regex<(Substring, Substring)>, in source: [String]) -> [String] {
        var keys: [String] = []
        for text in source {
            for match in text.matches(of: pattern) {
                let key = String(match.output.1)
                if !keys.contains(key) { keys.append(key) }
            }
        }
        return keys
    }

    static func credentialKeys(_ source: [String]) -> [String] {
        referenced(/\{\{\s*credential\.([a-zA-Z0-9_]+)\s*\}\}/, in: source)
    }

    static func argumentKeys(_ source: [String]) -> [String] {
        referenced(/\{\{\s*args\.([a-zA-Z0-9_]+)\s*\}\}/, in: source)
    }

    static func referencesCredential(_ value: String) -> Bool { !credentialKeys([value]).isEmpty }

    static func blankCredentials(_ value: String) -> String {
        value.replacing(/\{\{\s*credential\.([a-zA-Z0-9_]+)\s*\}\}/) { _ in maskedCredential }
    }

    /// The URL's scheme and host are pinned at definition time.
    static func urlOriginIsLiteral(_ url: String) -> Bool {
        guard let scheme = url.range(of: "://") else { return false }
        let rest = url[scheme.upperBound...]
        let origin = rest.firstIndex(of: "/").map { url[url.startIndex..<$0] } ?? url[...]
        return !origin.contains("{{")
    }

    /// A credential value must never reach the screen: any field whose template pulled
    /// one in renders from the template, blanked. A credential anywhere in the body masks
    /// the whole payload rather than leaking a fragment.
    fileprivate static func formatOutbound(_ outbound: DryRunResolvedRequest, template: ToolRequestTemplate, queryLabel: String, noBodyLabel: String) -> String {
        func mask(_ templateValue: String?, _ resolved: String) -> String {
            guard let templateValue, referencesCredential(templateValue) else { return resolved }
            return blankCredentials(templateValue)
        }
        func lines(_ pairs: [(key: String, value: String)], _ templateMap: [(String, String)]) -> String {
            pairs.map { item in
                "\(item.key): \(mask(templateMap.first { $0.0 == item.key }?.1, item.value))"
            }.joined(separator: "\n")
        }
        var out = ["\(outbound.method) \(mask(template.url, outbound.url))"]
        if !outbound.headers.isEmpty { out.append(lines(outbound.headers, template.headers)) }
        if !outbound.query.isEmpty {
            out += ["", queryLabel, lines(outbound.query, template.query)]
        }
        out.append("")
        if let body = template.body, body.contains(where: { referencesCredential($0.1) }) {
            let masked = JSONValue.object(body.map { ($0.0, .string(blankCredentials($0.1))) })
            out.append(prettyJSON(masked))
        } else if let body = outbound.body, !body.isNull {
            out.append(body.string ?? prettyJSON(body))
        } else {
            out.append(noBodyLabel)
        }
        return out.joined(separator: "\n")
    }

    /// `JSON.stringify(value, null, 2)`.
    static func prettyJSON(_ value: JSONValue, indent: Int = 0) -> String {
        let pad = String(repeating: "  ", count: indent + 1)
        let close = String(repeating: "  ", count: indent)
        switch value {
        case .array(let items) where !items.isEmpty:
            return "[\n" + items.map { pad + prettyJSON($0, indent: indent + 1) }.joined(separator: ",\n") + "\n\(close)]"
        case .object(let pairs) where !pairs.isEmpty:
            return "{\n" + pairs.map { pad + JSONValue.string($0.0).jsonString + ": " + prettyJSON($0.1, indent: indent + 1) }.joined(separator: ",\n") + "\n\(close)}"
        default:
            return value.jsonString
        }
    }
}

// MARK: - Tools page (ToolsSettings.tsx)

struct ToolsSettingsView: View {
    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var toasts: ToastCenter

    @State private var tools: [CustomerTool] = []
    @State private var credentialStatuses: [ToolCredentialStatus] = []
    @State private var isLoading = true

    @State private var formOpen = false
    /// Set while editing: the stored tool the form was opened from.
    @State private var editing: CustomerTool?
    @State private var draft = ToolFormDraft()
    @State private var fieldErrors: [String: String] = [:]

    /// Secret values typed this session: write-only, never kept on the tool row.
    @State private var credentialValues: [String: String] = [:]
    @State private var savingCredential = false

    @State private var testValues: [String: String] = [:]
    @State private var dryRunResult: DryRunResult?
    @State private var dryRunError: String?
    @State private var dryRunning = false
    @State private var dryRunTemplate: ToolRequestTemplate?

    @State private var saving = false
    @State private var busyToolName: String?
    @State private var toolToDelete: CustomerTool?

    private var requestTemplate: ToolRequestTemplate { draft.requestTemplate }
    private var credentialKeys: [String] { ToolRules.credentialKeys(requestTemplate.source) }

    /// Declared arguments first, then anything the call refers to but never declared.
    private var testArgumentNames: [String] {
        var names = draft.args.map { $0.name.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        for key in ToolRules.argumentKeys(requestTemplate.source) where !names.contains(key) { names.append(key) }
        var seen = Set<String>()
        return names.filter { seen.insert($0).inserted }
    }

    private var canActivate: Bool {
        dryRunResult?.ok == true || editing?.lastDryRunAt?.isEmpty == false
    }

    private func credentialConnected(_ ref: String) -> Bool {
        !ref.isEmpty && credentialStatuses.contains { $0.toolType == ref && $0.connected }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 40) {
            VStack(alignment: .leading, spacing: 16) {
                HStack(spacing: 16) {
                    Text(L("settingsPage.toolsSettings.yourTools"))
                        .webText(18, 600)
                        .foregroundStyle(AppTheme.textPrimary)
                    Spacer(minLength: 0)
                    PillButton(label: L("settingsPage.toolsSettings.addTool"), icon: "add-icon") {
                        resetForm()
                        formOpen = true
                    }
                }
                if isLoading {
                    emptyState(L("settingsPage.toolsSettings.loading"))
                } else if tools.isEmpty {
                    emptyState(L("settingsPage.toolsSettings.noToolsYet"))
                } else {
                    VStack(spacing: 0) {
                        ForEach(Array(tools.enumerated()), id: \.element.id) { index, tool in
                            toolRow(tool, isLast: index == tools.count - 1)
                        }
                    }
                }
            }

            if formOpen { form }
        }
        .webConfirm(
            toolToDelete.map { L("settingsPage.toolsSettings.deleteConfirm", ["name": $0.name]) },
            isPresented: Binding(get: { toolToDelete != nil }, set: { if !$0 { toolToDelete = nil } })
        ) {
            if let tool = toolToDelete { Task { await delete(tool) } }
        }
        .task { await load() }
    }

    private func emptyState(_ text: String) -> some View {
        Text(text).webText(15.2).foregroundStyle(AppTheme.textMuted)
    }

    private func toolRow(_ tool: CustomerTool, isLast: Bool) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 4) {
                Text(tool.name)
                    .font(Font(DSFont.uiMono(16, weight: .bold) as CTFont))
                    .foregroundStyle(AppTheme.textPrimary)
                WebTruncatedLine(tool.description)
                    .webText(13.6)
                    .foregroundStyle(AppTheme.textMuted)
            }
            HStack(spacing: 8) {
                statusChip(tool.status)
                SettingsChip(text: credentialConnected(tool.credentialRef) ? L("settingsPage.toolsSettings.credentialConnected") : L("settingsPage.toolsSettings.credentialMissing"))
            }
            HStack(spacing: 8) {
                PillButton(label: L("settingsPage.toolsSettings.edit"), style: .secondary) { openEditor(tool) }
                PillButton(
                    label: busyToolName == tool.name ? L("settingsPage.toolsSettings.deletingLabel") : L("settingsPage.toolsSettings.delete"),
                    style: .danger,
                    disabled: busyToolName == tool.name
                ) {
                    toolToDelete = tool
                }
            }
        }
        .padding(.vertical, 16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(alignment: .bottom) {
            if !isLast { Rectangle().fill(AppTheme.borderLight).frame(height: 1) }
        }
    }

    private func statusChip(_ status: CustomerToolStatus) -> some View {
        let label = L("settingsPage.toolsSettings.status_\(status.rawValue)")
        switch status {
        case .active:
            return SettingsChip(text: label, foreground: AppTheme.success, background: Color(red: 34 / 255, green: 197 / 255, blue: 94 / 255).opacity(0.12))
        case .draft:
            return SettingsChip(text: label, foreground: AppTheme.textSecondary)
        case .disabled:
            return SettingsChip(text: label, foreground: AppTheme.disabledText)
        }
    }

    // MARK: Form

    private var form: some View {
        SettingsFormCard(title: editing.map { L("settingsPage.toolsSettings.formTitleEdit", ["name": $0.name]) } ?? L("settingsPage.toolsSettings.formTitleNew")) {
            basicsSection
            argumentsSection
            callSection
            responseSection
            credentialSection
            dryRunSection
            SettingsFormFooter {
                PillButton(
                    label: saving ? L("settingsPage.toolsSettings.savingLabel") : L("settingsPage.toolsSettings.save"),
                    icon: "save-icon",
                    disabled: saving || dryRunning
                ) {
                    Task { await save() }
                }
                if editing?.status == .active {
                    PillButton(label: L("settingsPage.toolsSettings.disable"), style: .secondary, disabled: saving || dryRunning) {
                        Task { await setStatus(.disabled) }
                    }
                } else {
                    PillButton(label: L("settingsPage.toolsSettings.activate"), style: .secondary, disabled: !canActivate || saving || dryRunning) {
                        Task { await setStatus(.active) }
                    }
                }
                PillButton(label: L("settingsPage.toolsSettings.cancel"), style: .secondary, disabled: saving || dryRunning) {
                    closeForm()
                }
                if !canActivate {
                    Text(L("settingsPage.toolsSettings.activateHelp"))
                        .webText(13)
                        .foregroundStyle(AppTheme.textMuted)
                }
            }
        }
    }

    private func helpOrError(_ field: String, help: String) -> some View {
        WebFieldHelp(fieldErrors[field] ?? help, isError: fieldErrors[field] != nil)
    }

    private var basicsSection: some View {
        SettingsFormSection(title: L("settingsPage.toolsSettings.basicsTitle")) {
            InputTextWithHint(
                hint: L("settingsPage.toolsSettings.nameHint"),
                placeholder: L("settingsPage.toolsSettings.namePlaceholder"),
                text: $draft.name,
                disabled: editing != nil
            )
            helpOrError("name", help: L("settingsPage.toolsSettings.nameHelp"))
            InputTextWithHint(
                hint: L("settingsPage.toolsSettings.descriptionHint"),
                placeholder: L("settingsPage.toolsSettings.descriptionPlaceholder"),
                text: $draft.description
            )
            helpOrError("description", help: L("settingsPage.toolsSettings.descriptionHelp"))
        }
    }

    private var argumentsSection: some View {
        SettingsFormSection(title: L("settingsPage.toolsSettings.argumentsTitle")) {
            WebFieldHelp(L("settingsPage.toolsSettings.argumentsHelp"))
            VStack(alignment: .leading, spacing: 8) {
                ForEach($draft.args) { $arg in
                    argumentRow($arg)
                }
                DashedAddButton(label: L("settingsPage.toolsSettings.addArgument")) {
                    draft.args.append(ArgumentDraft())
                }
            }
            if let error = fieldErrors["args"] { WebFieldHelp(error, isError: true) }
        }
    }

    private func argumentRow(_ arg: Binding<ArgumentDraft>) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                WebCellInput(text: arg.name, placeholder: L("settingsPage.toolsSettings.argName"))
                    .frame(width: 144)
                Menu {
                    ForEach(ToolRules.argumentTypes, id: \.self) { type in
                        Button(L("settingsPage.toolsSettings.argType_\(type)")) { arg.wrappedValue.type = type }
                    }
                } label: {
                    HStack(spacing: 4) {
                        Text(L("settingsPage.toolsSettings.argType_\(arg.wrappedValue.type)"))
                            .webText(arial: 14)
                            .foregroundStyle(AppTheme.textPrimary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        SelectChevron()
                    }
                    .padding(.horizontal, 10.6)
                    .frame(width: 128, height: 36)
                    .background(AppTheme.background)
                    .clipShape(RoundedRectangle(cornerRadius: DSRadius.md))
                    .overlay(RoundedRectangle(cornerRadius: DSRadius.md).strokeBorder(AppTheme.border, lineWidth: 1))
                }
                .accessibilityLabel(L("settingsPage.toolsSettings.argType"))
                Spacer(minLength: 0)
            }
            HStack(spacing: 8) {
                HStack(spacing: 5.6) {
                    WebCheckbox(isOn: arg.wrappedValue.required, label: L("settingsPage.toolsSettings.argRequired")) { arg.wrappedValue.required = $0 }
                    Text(L("settingsPage.toolsSettings.argRequired"))
                        .webText(13)
                        .foregroundStyle(AppTheme.textSecondary)
                        .fixedSize()
                }
                WebCellInput(text: arg.description, placeholder: L("settingsPage.toolsSettings.argDescription"))
                removeButton {
                    let id = arg.wrappedValue.id
                    draft.args.removeAll { $0.id == id }
                    if draft.args.isEmpty { draft.args = [ArgumentDraft()] }
                }
            }
        }
    }

    private func removeButton(action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text("×")
                .webText(arial: 16)
                .foregroundStyle(AppTheme.textMuted)
                .frame(width: 28, height: 28)
                .overlay(RoundedRectangle(cornerRadius: DSRadius.md).strokeBorder(AppTheme.borderLight, lineWidth: 1))
        }
        .buttonStyle(WebPressStyle())
        .accessibilityLabel(L("settingsPage.toolsSettings.removeRow"))
    }

    private func pairRows(_ pairs: Binding<[PairDraft]>) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(pairs) { $pair in
                HStack(spacing: 8) {
                    WebCellInput(text: $pair.key, placeholder: L("settingsPage.toolsSettings.keyColumn"))
                    WebCellInput(text: $pair.value, placeholder: L("settingsPage.toolsSettings.valueColumn"))
                    removeButton {
                        let id = pair.id
                        pairs.wrappedValue.removeAll { $0.id == id }
                        if pairs.wrappedValue.isEmpty { pairs.wrappedValue = [PairDraft()] }
                    }
                }
            }
            DashedAddButton(label: L("settingsPage.toolsSettings.addRow")) {
                pairs.wrappedValue.append(PairDraft())
            }
        }
    }

    private func subsectionTitle(_ text: String) -> some View {
        Text(text)
            .webText(13.6, 600)
            .foregroundStyle(AppTheme.textSecondary)
            .padding(.top, 8)
    }

    private var callSection: some View {
        SettingsFormSection(title: L("settingsPage.toolsSettings.callTitle")) {
            VStack(spacing: 12) {
                InputSelectWithHint(
                    hint: L("settingsPage.toolsSettings.methodHint"),
                    value: draft.method,
                    options: ToolRules.methods.map { .init(value: $0, label: $0) },
                    onChange: { draft.method = $0 }
                )
                InputTextWithHint(
                    hint: L("settingsPage.toolsSettings.urlHint"),
                    placeholder: L("settingsPage.toolsSettings.urlPlaceholder"),
                    text: $draft.url,
                    keyboard: .URL
                )
            }
            helpOrError("url", help: L("settingsPage.toolsSettings.urlHelp"))
            subsectionTitle(L("settingsPage.toolsSettings.headersTitle"))
            pairRows($draft.headers)
            subsectionTitle(L("settingsPage.toolsSettings.queryTitle"))
            pairRows($draft.query)
            subsectionTitle(L("settingsPage.toolsSettings.bodyTitle"))
            pairRows($draft.body)
            InputSelectWithHint(
                hint: L("settingsPage.toolsSettings.bodyTypeHint"),
                value: draft.bodyType,
                options: [
                    .init(value: "json", label: L("settingsPage.toolsSettings.bodyTypeJson")),
                    .init(value: "form", label: L("settingsPage.toolsSettings.bodyTypeForm"))
                ],
                onChange: { draft.bodyType = $0 }
            )
        }
    }

    private var responseSection: some View {
        SettingsFormSection(title: L("settingsPage.toolsSettings.responseTitle")) {
            InputSelectWithHint(
                hint: L("settingsPage.toolsSettings.transformModeHint"),
                value: draft.transformMode,
                options: ToolRules.transformModes.map { .init(value: $0, label: L("settingsPage.toolsSettings.transformMode_\($0)")) },
                onChange: { draft.transformMode = $0 }
            )
            if draft.transformMode == "json_path" {
                InputTextWithHint(
                    hint: L("settingsPage.toolsSettings.transformPathHint"),
                    placeholder: L("settingsPage.toolsSettings.transformPathPlaceholder"),
                    text: $draft.transformPath
                )
                helpOrError("transformPath", help: L("settingsPage.toolsSettings.transformPathHelp"))
            }
            VStack(alignment: .leading, spacing: 4) {
                WebFieldLabel(L("settingsPage.toolsSettings.maxCharsHint"))
                WebCellInput(text: $draft.maxChars, keyboard: .numberPad)
            }
            helpOrError("maxChars", help: L("settingsPage.toolsSettings.maxCharsHelp"))
        }
    }

    private var credentialSection: some View {
        SettingsFormSection(title: L("settingsPage.toolsSettings.credentialTitle")) {
            if credentialKeys.isEmpty {
                WebFieldHelp(L("settingsPage.toolsSettings.credentialNoneHelp"))
            } else {
                WebFieldHelp(L("settingsPage.toolsSettings.credentialHelp"))
                InputTextWithHint(
                    hint: L("settingsPage.toolsSettings.credentialNameHint"),
                    placeholder: draft.name.trimmingCharacters(in: .whitespaces).isEmpty ? L("settingsPage.toolsSettings.credentialNamePlaceholder") : draft.name.trimmingCharacters(in: .whitespaces),
                    text: $draft.credentialRef
                )
                ForEach(credentialKeys, id: \.self) { key in
                    VStack(alignment: .leading, spacing: 4) {
                        WebFieldLabel(key)
                        WebCellInput(
                            text: Binding(get: { credentialValues[key] ?? "" }, set: { credentialValues[key] = $0 }),
                            placeholder: L("settingsPage.toolsSettings.credentialValuePlaceholder"),
                            isSecure: true
                        )
                    }
                }
                PillButton(
                    label: savingCredential ? L("settingsPage.toolsSettings.savingLabel") : L("settingsPage.toolsSettings.saveCredential"),
                    icon: "save-icon",
                    style: .secondary,
                    disabled: savingCredential
                ) {
                    Task { await saveCredential() }
                }
            }
        }
    }

    private var dryRunSection: some View {
        SettingsFormSection(title: L("settingsPage.toolsSettings.testValuesTitle"), isPanel: true) {
            WebFieldHelp(L("settingsPage.toolsSettings.testValuesHelp"))
            if testArgumentNames.isEmpty {
                WebFieldHelp(L("settingsPage.toolsSettings.testValuesNone"))
            } else {
                ForEach(testArgumentNames, id: \.self) { name in
                    VStack(alignment: .leading, spacing: 4) {
                        WebFieldLabel(name)
                        WebCellInput(text: Binding(get: { testValues[name] ?? "" }, set: { testValues[name] = $0 }))
                    }
                }
            }
            VStack(alignment: .leading, spacing: 12) {
                PillButton(
                    label: dryRunning ? L("settingsPage.toolsSettings.dryRunningLabel") : L("settingsPage.toolsSettings.dryRun"),
                    icon: "send-icon",
                    disabled: dryRunning
                ) {
                    Task { await runDryRun() }
                }
                Text(L("settingsPage.toolsSettings.dryRunHelp"))
                    .webText(13)
                    .foregroundStyle(AppTheme.textMuted)
            }
            .padding(.top, 8)
            if let dryRunError {
                SettingsErrorPanel(title: L("settingsPage.toolsSettings.dryRunErrorTitle"), detail: dryRunError)
            }
            if let dryRunResult {
                dryRunPanel(dryRunResult)
            }
        }
    }

    private func dryRunPanel(_ result: DryRunResult) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(result.ok
                 ? L("settingsPage.toolsSettings.dryRunSucceeded", ["status": result.statusCode.map(String.init) ?? ""])
                 : L("settingsPage.toolsSettings.dryRunFailed", ["status": result.statusCode.map(String.init) ?? ""]))
                .font(DSFont.roboto(16, 600))
                .foregroundStyle(result.ok ? AppTheme.success : AppTheme.error)
            if let error = result.error {
                Text(error).webText(13.6).foregroundStyle(AppTheme.textMuted)
            }
            dryRunBlock(L("settingsPage.toolsSettings.outboundTitle")) {
                dryRunNote(L("settingsPage.toolsSettings.outboundMaskNote"))
                codeBlock(outboundText(result))
            }
            dryRunBlock(L("settingsPage.toolsSettings.rawResponseTitle")) {
                codeBlock(result.responseBody ?? "")
                if result.truncated { dryRunNote(L("settingsPage.toolsSettings.rawTruncated")) }
            }
            dryRunBlock(L("settingsPage.toolsSettings.modelTextTitle")) {
                codeBlock(result.modelSees ?? "", accented: true)
                dryRunNote(L("settingsPage.toolsSettings.modelTextChars", ["chars": (result.modelSees ?? "").count]))
            }
        }
        .padding(17)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(AppTheme.background)
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(AppTheme.borderLight, lineWidth: 1))
    }

    private func outboundText(_ result: DryRunResult) -> String {
        guard let request = result.request, let dryRunTemplate else { return L("settingsPage.toolsSettings.outboundMissing") }
        return ToolRules.formatOutbound(
            request,
            template: dryRunTemplate,
            queryLabel: L("settingsPage.toolsSettings.queryTitle"),
            noBodyLabel: L("settingsPage.toolsSettings.noBody")
        )
    }

    private func dryRunBlock<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 5.6) {
            Text(title).webText(14, 600).foregroundStyle(AppTheme.textPrimary)
            content()
        }
    }

    private func dryRunNote(_ text: String) -> some View {
        Text(text).webText(12).foregroundStyle(AppTheme.textMuted)
    }

    private func codeBlock(_ text: String, accented: Bool = false) -> some View {
        ScrollView {
            WebSelectableText(text: text, font: DSFont.uiMono(12.8), lineHeight: 19.2, color: AppTheme.UI.textPrimary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(12)
        }
        .frame(maxHeight: 288)
        .fixedSize(horizontal: false, vertical: true)
        .background(AppTheme.borderLight)
        .clipShape(RoundedRectangle(cornerRadius: DSRadius.md))
        .overlay(alignment: .leading) {
            if accented { Rectangle().fill(AppTheme.primary).frame(width: 3) }
        }
    }

    // MARK: Actions

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let token = try await auth.getAccessTokenSilently()
            async let toolList = ToolsService.listTools(token: token)
            async let statuses = ToolsService.getCredentialStatuses(token: token)
            tools = try await toolList
            credentialStatuses = try await statuses
        } catch {
            toasts.showToast(error.localizedDescription.isEmpty ? L("settingsPage.toolsSettings.loadErrorToast") : error.localizedDescription)
        }
    }

    private func resetForm() {
        draft = ToolFormDraft()
        editing = nil
        resetFormState()
    }

    private func resetFormState() {
        fieldErrors = [:]
        credentialValues = [:]
        testValues = [:]
        dryRunResult = nil
        dryRunError = nil
        dryRunTemplate = nil
    }

    private func openEditor(_ tool: CustomerTool) {
        draft = ToolFormDraft(editing: tool)
        editing = tool
        resetFormState()
        formOpen = true
    }

    private func closeForm() {
        resetForm()
        formOpen = false
    }

    /// The same rules the server enforces on save, so the form fails first.
    private func validate() -> [String: String] {
        var errors: [String: String] = [:]
        let name = draft.name.trimmingCharacters(in: .whitespaces)
        if !ToolRules.isValidName(name) {
            errors["name"] = L("settingsPage.toolsSettings.errorNameFormat")
        } else if ToolRules.reservedNames.contains(name) {
            errors["name"] = L("settingsPage.toolsSettings.errorNameReserved", ["name": name])
        }

        let description = draft.description.trimmingCharacters(in: .whitespaces)
        if description.count < ToolRules.minDescriptionLength || description.count > ToolRules.maxDescriptionLength {
            errors["description"] = L("settingsPage.toolsSettings.errorDescriptionLength", ["min": ToolRules.minDescriptionLength, "max": ToolRules.maxDescriptionLength])
        }

        let argNames = draft.args.map { $0.name.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        if argNames.count > ToolRules.maxArguments {
            errors["args"] = L("settingsPage.toolsSettings.errorTooManyArguments", ["max": ToolRules.maxArguments])
        } else if argNames.contains(where: { !ToolRules.isValidArgumentName($0) }) {
            errors["args"] = L("settingsPage.toolsSettings.errorArgumentName")
        } else if Set(argNames).count != argNames.count {
            errors["args"] = L("settingsPage.toolsSettings.errorArgumentDuplicate")
        }

        let url = draft.url.trimmingCharacters(in: .whitespaces)
        if !url.lowercased().hasPrefix("https://") {
            errors["url"] = L("settingsPage.toolsSettings.errorUrlHttps")
        } else if !ToolRules.urlOriginIsLiteral(url) {
            errors["url"] = L("settingsPage.toolsSettings.errorUrlOrigin")
        }

        if errors["args"] == nil,
           let unknown = ToolRules.argumentKeys(requestTemplate.source).first(where: { !argNames.contains($0) }) {
            errors["args"] = L("settingsPage.toolsSettings.errorArgumentUnknown", ["name": unknown])
        }

        if draft.transformMode == "json_path", draft.transformPath.trimmingCharacters(in: .whitespaces).isEmpty {
            errors["transformPath"] = L("settingsPage.toolsSettings.errorPathRequired")
        }

        let maxChars = Int(draft.maxChars) ?? 0
        if maxChars < 1 || maxChars > ToolRules.maxMaxChars {
            errors["maxChars"] = L("settingsPage.toolsSettings.errorMaxChars", ["max": ToolRules.maxMaxChars])
        }
        return errors
    }

    private func payload(_ status: CustomerToolStatus) -> UpsertCustomerToolRequest {
        UpsertCustomerToolRequest(
            name: draft.name.trimmingCharacters(in: .whitespaces),
            description: draft.description.trimmingCharacters(in: .whitespaces),
            parameters: draft.parametersJSON,
            provider: "http",
            request: draft.requestTemplate.json.jsonString,
            credentialRef: draft.credentialRef.trimmingCharacters(in: .whitespaces),
            responseTransform: draft.transformJSON,
            status: status,
            origin: editing?.origin?.isEmpty == false ? editing!.origin! : "manual",
            originRef: editing?.originRef ?? "",
            // The stamp from the last successful dry run; sending it back lets a save set `active`.
            lastDryRunAt: editing?.lastDryRunAt ?? ""
        )
    }

    /// Saves the draft and reports it, or nil when validation stopped it.
    private func persistDraft(_ status: CustomerToolStatus) async throws -> CustomerTool? {
        let errors = validate()
        fieldErrors = errors
        guard errors.isEmpty else {
            toasts.showToast(L("settingsPage.toolsSettings.fixFieldsToast"))
            return nil
        }
        let token = try await auth.getAccessTokenSilently()
        let saved = try await ToolsService.saveTool(token: token, request: payload(status))
        editing = saved
        return saved
    }

    private func save() async {
        saving = true
        defer { saving = false }
        do {
            // An edit keeps the status the tool earned; a new tool can only be a draft.
            guard try await persistDraft(editing?.status ?? .draft) != nil else { return }
            toasts.showToast(L("settingsPage.toolsSettings.savedToast"))
            await load()
        } catch {
            toasts.showToast(error.localizedDescription)
        }
    }

    private func typedTestArgs() -> [String: JSONEncodableValue] {
        var out: [String: JSONEncodableValue] = [:]
        for (key, value) in testValues {
            let declared = draft.args.first { $0.name.trimmingCharacters(in: .whitespaces) == key }
            switch declared?.type {
            case "boolean":
                out[key] = .bool(value.trimmingCharacters(in: .whitespaces).lowercased() == "true")
            case "number", "integer":
                out[key] = Double(value).map(JSONEncodableValue.number) ?? .string(value)
            default:
                out[key] = .string(value)
            }
        }
        return out
    }

    /// Saved first on purpose: the server only stamps a successful dry run onto a stored
    /// row, and that stamp is what unlocks `active`.
    private func runDryRun() async {
        dryRunning = true
        dryRunResult = nil
        dryRunError = nil
        defer { dryRunning = false }
        do {
            guard let saved = try await persistDraft(editing?.status ?? .draft) else { return }
            let template = draft.requestTemplate
            let token = try await auth.getAccessTokenSilently()
            let result = try await ToolsService.dryRun(token: token, name: saved.name, tool: payload(saved.status), args: typedTestArgs())
            dryRunTemplate = template
            dryRunResult = result
            if result.ok {
                editing = try await ToolsService.getTool(token: token, name: saved.name)
            }
            await load()
        } catch {
            dryRunError = error.localizedDescription.isEmpty ? L("settingsPage.toolsSettings.dryRunErrorToast") : error.localizedDescription
        }
    }

    private func setStatus(_ status: CustomerToolStatus) async {
        saving = true
        defer { saving = false }
        do {
            guard try await persistDraft(status) != nil else { return }
            toasts.showToast(status == .active ? L("settingsPage.toolsSettings.activatedToast") : L("settingsPage.toolsSettings.disabledToast"))
            await load()
        } catch {
            toasts.showToast(error.localizedDescription)
        }
    }

    private func saveCredential() async {
        let typedRef = draft.credentialRef.trimmingCharacters(in: .whitespaces)
        let ref = typedRef.isEmpty ? draft.name.trimmingCharacters(in: .whitespaces) : typedRef
        let values = credentialKeys.reduce(into: [String: String]()) { result, key in
            if let value = credentialValues[key], !value.isEmpty { result[key] = value }
        }
        guard !ref.isEmpty, !values.isEmpty else {
            toasts.showToast(L("settingsPage.toolsSettings.credentialValuesRequiredToast"))
            return
        }
        savingCredential = true
        defer { savingCredential = false }
        do {
            let token = try await auth.getAccessTokenSilently()
            try await ToolsService.storeCredentials(token: token, request: StoreToolCredentialsRequest(toolType: ref, authType: "api_key", credentials: values))
            draft.credentialRef = ref
            credentialValues = [:]
            toasts.showToast(L("settingsPage.toolsSettings.credentialSavedToast"))
            await load()
        } catch {
            toasts.showToast(error.localizedDescription)
        }
    }

    private func delete(_ tool: CustomerTool) async {
        busyToolName = tool.name
        defer { busyToolName = nil }
        do {
            let token = try await auth.getAccessTokenSilently()
            try await ToolsService.deleteTool(token: token, name: tool.name)
            if editing?.name == tool.name { closeForm() }
            toasts.showToast(L("settingsPage.toolsSettings.deletedToast"))
            await load()
        } catch {
            toasts.showToast(error.localizedDescription)
        }
    }
}
