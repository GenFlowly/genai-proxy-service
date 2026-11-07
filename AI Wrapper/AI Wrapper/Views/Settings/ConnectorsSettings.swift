import SwiftUI

/// Connectors: one thing connected, many tools out of it. Both flows are two steps and
/// the first writes nothing: the customer sees exactly what they're about to get and says
/// yes to it. Secret values go to the credential store; a connector request never
/// carries one (ConnectorsSettings.tsx).
struct ConnectorsSettingsView: View {
    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var router: AppRouter
    @EnvironmentObject var toasts: ToastCenter

    private enum Flow { case openapi, mcp }

    private static let maxImportedOperations = 20
    private static let mcpCredentialKey = "token"
    private static let mcpAuthHeaders = ["Authorization": "Bearer {{credential.\(mcpCredentialKey)}}"]
    private static let defaultSpecCredentialKey = "api_key"

    @State private var connectors: [Connector] = []
    @State private var isLoading = true
    @State private var busyConnectorId: String?
    @State private var connectorToDisconnect: Connector?

    @State private var chooserOpen = false
    @State private var flow: Flow?

    @State private var url = ""
    @State private var credentialRef = ""
    /// Typed this session only: posted to the credential store, then dropped.
    @State private var secret = ""
    @State private var urlError: String?

    @State private var preview: JSONValue?
    @State private var previewError: String?
    @State private var previewing = false
    @State private var selected: [String] = []
    @State private var importing = false
    @State private var imported: Int?

    @State private var discovery: JSONValue?
    @State private var discoverError: String?
    @State private var discovering = false
    @State private var label = ""
    @State private var connecting = false

    private var trimmedUrl: String { url.trimmingCharacters(in: .whitespaces) }

    private var effectiveCredentialRef: String {
        let typed = credentialRef.trimmingCharacters(in: .whitespaces)
        return typed.isEmpty ? Self.suggestedCredentialRef(trimmedUrl) : typed
    }

    private var selectionFull: Bool { selected.count >= Self.maxImportedOperations }

    var body: some View {
        VStack(alignment: .leading, spacing: 40) {
            VStack(alignment: .leading, spacing: 16) {
                FlexShrinkRow(spacing: 16) {
                    Text(L("settingsPage.connectorsSettings.yourConnectors"))
                        .webText(18, 600)
                        .foregroundStyle(AppTheme.textPrimary)
                        .fixedSize(horizontal: false, vertical: true)
                    PillButton(label: L("settingsPage.connectorsSettings.addConnector"), icon: "add-icon", fullWidth: true) {
                        resetFlow()
                        flow = nil
                        chooserOpen = true
                    }
                    .layoutValue(key: FlexItemPadding.self, value: PillButton<PillButtonLabel>.horizontalPadding * 2)
                }
                if isLoading {
                    emptyState(L("settingsPage.connectorsSettings.loading"))
                } else if connectors.isEmpty {
                    emptyState(L("settingsPage.connectorsSettings.noConnectorsYet"))
                } else {
                    VStack(spacing: 0) {
                        ForEach(Array(connectors.enumerated()), id: \.element.id) { index, connector in
                            connectorRow(connector, isLast: index == connectors.count - 1)
                        }
                    }
                }
            }

            if chooserOpen { chooser }
            if flow == .openapi { specForm }
            if flow == .mcp { mcpForm }
        }
        .webConfirm(
            connectorToDisconnect.map { L("settingsPage.connectorsSettings.disconnectConfirm", ["label": $0.label, "count": $0.toolCount]) },
            isPresented: Binding(get: { connectorToDisconnect != nil }, set: { if !$0 { connectorToDisconnect = nil } })
        ) {
            if let connector = connectorToDisconnect { Task { await disconnect(connector) } }
        }
        .task { await load() }
    }

    private func emptyState(_ text: String) -> some View {
        Text(text).webText(15.2).foregroundStyle(AppTheme.textMuted)
    }

    private func connectorRow(_ connector: Connector, isLast: Bool) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 4) {
                Text(connector.label)
                    .webText(16, 600)
                    .foregroundStyle(AppTheme.textPrimary)
                Text(connector.ref)
                    .webText(mono: 12.8)
                    .foregroundStyle(AppTheme.textMuted)
                    .lineLimit(1)
            }
            HStack(spacing: 8) {
                SettingsChip(text: L("settingsPage.connectorsSettings.kind_\(connector.kind)"))
                SettingsChip(text: L("settingsPage.connectorsSettings.toolCount", ["count": connector.toolCount]))
            }
            PillButton(
                label: busyConnectorId == connector.id ? L("settingsPage.connectorsSettings.disconnectingLabel") : L("settingsPage.connectorsSettings.disconnect"),
                style: .danger,
                disabled: busyConnectorId == connector.id
            ) {
                connectorToDisconnect = connector
            }
        }
        .padding(.vertical, 16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(alignment: .bottom) {
            if !isLast { Rectangle().fill(AppTheme.borderLight).frame(height: 1) }
        }
    }

    // MARK: Chooser

    private var chooser: some View {
        SettingsFormCard(title: L("settingsPage.connectorsSettings.chooseTitle")) {
            VStack(spacing: 12) {
                chooserOption(L("settingsPage.connectorsSettings.chooseSpec"), L("settingsPage.connectorsSettings.chooseSpecHelp"), .openapi)
                chooserOption(L("settingsPage.connectorsSettings.chooseMcp"), L("settingsPage.connectorsSettings.chooseMcpHelp"), .mcp)
            }
            SettingsFormFooter {
                PillButton(label: L("settingsPage.connectorsSettings.cancel"), style: .secondary) { closeFlow() }
            }
        }
    }

    private func chooserOption(_ title: String, _ help: String, _ kind: Flow) -> some View {
        Button {
            resetFlow()
            chooserOpen = false
            flow = kind
        } label: {
            VStack(alignment: .leading, spacing: 5.6) {
                Text(title)
                    .webText(arial: 15.2, bold: true)
                    .foregroundStyle(AppTheme.textPrimary)
                Text(help)
                    .webText(arial: 13)
                    .foregroundStyle(AppTheme.textMuted)
                    .multilineTextAlignment(.leading)
            }
            .padding(17)
            .frame(maxWidth: .infinity, alignment: .leading)
            .overlay(WebDashedBorder(color: AppTheme.border, cornerRadius: 8))
            .contentShape(Rectangle())
        }
        .buttonStyle(WebPressStyle())
    }

    // MARK: Address fields

    @ViewBuilder
    private func addressFields(urlHint: String, urlPlaceholder: String, urlHelp: String, secretHelp: String) -> some View {
        InputTextWithHint(hint: urlHint, placeholder: urlPlaceholder, text: $url, keyboard: .URL)
        WebFieldHelp(urlError ?? urlHelp, isError: urlError != nil)
        VStack(alignment: .leading, spacing: 4) {
            WebFieldLabel(L("settingsPage.connectorsSettings.keyHint"))
            WebCellInput(text: $secret, placeholder: L("settingsPage.connectorsSettings.keyPlaceholder"), isSecure: true)
        }
        WebFieldHelp(secretHelp)
        InputTextWithHint(
            hint: L("settingsPage.connectorsSettings.credentialNameHint"),
            placeholder: {
                let suggested = Self.suggestedCredentialRef(trimmedUrl)
                return suggested.isEmpty ? L("settingsPage.connectorsSettings.credentialNamePlaceholder") : suggested
            }(),
            text: $credentialRef
        )
        WebFieldHelp(L("settingsPage.connectorsSettings.credentialNameHelp"))
    }

    // MARK: API description flow

    private var specForm: some View {
        SettingsFormCard(title: L("settingsPage.connectorsSettings.specTitle")) {
            SettingsFormSection {
                addressFields(
                    urlHint: L("settingsPage.connectorsSettings.specUrlHint"),
                    urlPlaceholder: L("settingsPage.connectorsSettings.specUrlPlaceholder"),
                    urlHelp: L("settingsPage.connectorsSettings.specUrlHelp"),
                    secretHelp: L("settingsPage.connectorsSettings.specKeyHelp")
                )
                PillButton(
                    label: previewing ? L("settingsPage.connectorsSettings.previewingLabel") : L("settingsPage.connectorsSettings.preview"),
                    icon: "send-icon",
                    disabled: previewing || importing
                ) {
                    Task { await runPreview() }
                }
            }
            if let previewError {
                SettingsErrorPanel(title: L("settingsPage.connectorsSettings.previewErrorTitle"), detail: previewError)
            }
            if let preview, imported == nil {
                previewSection(preview)
            }
            if let imported {
                SettingsFormSection(title: L("settingsPage.connectorsSettings.importedTitle"), isPanel: true) {
                    WebFieldHelp(L("settingsPage.connectorsSettings.importedToast", ["count": imported]))
                    WebFieldHelp(L("settingsPage.connectorsSettings.importedHelp"))
                    Button(L("settingsPage.connectorsSettings.openTools")) {
                        router.navigate(.settings(.tools))
                    }
                    .font(DSFont.roboto(14, 500))
                    .foregroundStyle(AppTheme.primary)
                }
            }
            SettingsFormFooter {
                PillButton(
                    label: imported != nil ? L("settingsPage.connectorsSettings.done") : L("settingsPage.connectorsSettings.cancel"),
                    style: .secondary,
                    disabled: previewing || importing
                ) {
                    closeFlow()
                }
            }
        }
    }

    private func previewSection(_ preview: JSONValue) -> some View {
        let operations = preview["operations"]?.array ?? []
        let skipped = preview["skipped"]?.array ?? []
        return SettingsFormSection(title: preview["title"]?.string ?? "", isPanel: true) {
            WebFieldHelp(L("settingsPage.connectorsSettings.previewFound", ["count": operations.count, "server": preview["server_url"]?.string ?? ""]))
            WebFieldHelp(L("settingsPage.connectorsSettings.selectionHelp", ["max": Self.maxImportedOperations]))
            Text(L("settingsPage.connectorsSettings.selectionCount", ["selected": selected.count, "max": Self.maxImportedOperations]))
                .webText(13, 600)
                .foregroundStyle(AppTheme.textSecondary)
            if selectionFull {
                Text(L("settingsPage.connectorsSettings.selectionFull"))
                    .webText(13)
                    .foregroundStyle(AppTheme.textSecondary)
            }
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(operations.enumerated()), id: \.offset) { index, operation in
                        operationRow(operation, isLast: index == operations.count - 1)
                    }
                }
            }
            .frame(maxHeight: 416)
            .fixedSize(horizontal: false, vertical: true)
            if !skipped.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    Text(L("settingsPage.connectorsSettings.skippedTitle", ["count": skipped.count]))
                        .webText(13.6, 600)
                        .foregroundStyle(AppTheme.textSecondary)
                        .padding(.top, 8)
                    ForEach(Array(skipped.enumerated()), id: \.offset) { _, entry in
                        HStack(alignment: .top, spacing: 9.6) {
                            Text(entry["operationId"]?.string ?? "")
                                .webText(mono: 12.8)
                                .foregroundStyle(AppTheme.textSecondary)
                                .fixedSize()
                            Text(entry["reason"]?.string ?? "")
                                .webText(13)
                                .foregroundStyle(AppTheme.textMuted)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                }
            }
            PillButton(
                label: importing ? L("settingsPage.connectorsSettings.importingLabel") : L("settingsPage.connectorsSettings.import"),
                icon: "save-icon",
                disabled: importing || selected.isEmpty
            ) {
                Task { await runImport() }
            }
            WebFieldHelp(L("settingsPage.connectorsSettings.importedHelp"))
        }
    }

    private func operationRow(_ operation: JSONValue, isLast: Bool) -> some View {
        let name = operation["name"]?.string ?? ""
        let isOn = selected.contains(name)
        let warnings = (operation["warnings"]?.array ?? []).compactMap(\.string)
        let methodFont = DSFont.uiMono(12, weight: .bold)
        return FlexWrapBaselineRow(spacing: 9.6) {
            WebCheckbox(isOn: isOn, disabled: selectionFull && !isOn, label: name) { _ in toggle(name) }
                .layoutValue(key: FlexBaseline.self, value: 13)
            Text(operation["method"]?.string ?? "")
                .modifier(WebFontModifier(uiFont: methodFont))
                .foregroundStyle(AppTheme.textSecondary)
                .fixedSize()
                .padding(.horizontal, 6.4)
                .padding(.vertical, 1.6)
                .background(AppTheme.borderLight)
                .clipShape(RoundedRectangle(cornerRadius: DSRadius.sm))
                .layoutValue(key: FlexBaseline.self, value: 1.6 + WebLineBox(font: methodFont, lineHeight: nil).baseline)
            Text(operation["path"]?.string ?? "")
                .webText(mono: 12.8)
                .foregroundStyle(AppTheme.textPrimary)
                .fixedSize()
                .layoutValue(key: FlexBaseline.self, value: WebLineBox(font: DSFont.uiMono(12.8), lineHeight: nil).baseline)
            Text(operation["description"]?.string ?? "")
                .webText(13)
                .foregroundStyle(AppTheme.textMuted)
                .layoutValue(key: FlexBaseline.self, value: WebLineBox(font: DSFont.ui(13), lineHeight: nil).baseline)
                .layoutValue(key: FlexItemSizingKey.self, value: .grow)
            if !warnings.isEmpty {
                Text(L("settingsPage.connectorsSettings.operationWarnings", ["warnings": warnings.joined(separator: " ")]))
                    .webText(12)
                    .foregroundStyle(AppTheme.textSecondary)
                    .layoutValue(key: FlexItemSizingKey.self, value: .fullLine)
            }
        }
        .padding(.vertical, 8)
        .padding(.bottom, isLast ? 0 : 1)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
        .onTapGesture { toggle(name) }
        .overlay(alignment: .bottom) {
            if !isLast { Rectangle().fill(AppTheme.borderLight).frame(height: 1) }
        }
    }

    private func toggle(_ name: String) {
        if selected.contains(name) {
            selected.removeAll { $0 == name }
        } else if !selectionFull {
            selected.append(name)
        }
    }

    // MARK: MCP flow

    private var mcpForm: some View {
        SettingsFormCard(title: L("settingsPage.connectorsSettings.mcpTitle")) {
            SettingsFormSection {
                addressFields(
                    urlHint: L("settingsPage.connectorsSettings.serverUrlHint"),
                    urlPlaceholder: L("settingsPage.connectorsSettings.serverUrlPlaceholder"),
                    urlHelp: L("settingsPage.connectorsSettings.serverUrlHelp"),
                    secretHelp: L("settingsPage.connectorsSettings.mcpKeyHelp")
                )
                PillButton(
                    label: discovering ? L("settingsPage.connectorsSettings.discoveringLabel") : L("settingsPage.connectorsSettings.discover"),
                    icon: "send-icon",
                    disabled: discovering || connecting
                ) {
                    Task { await runDiscover() }
                }
            }
            if let discoverError {
                SettingsErrorPanel(title: L("settingsPage.connectorsSettings.discoverErrorTitle"), detail: discoverError)
            }
            if let discovery {
                approvalSection(discovery)
            }
            SettingsFormFooter {
                PillButton(label: L("settingsPage.connectorsSettings.cancel"), style: .secondary, disabled: discovering || connecting) {
                    closeFlow()
                }
            }
        }
    }

    private func approvalSection(_ discovery: JSONValue) -> some View {
        let tools = discovery["tools"]?.array ?? []
        let serverName = discovery["server_name"]?.string ?? ""
        return SettingsFormSection(title: L("settingsPage.connectorsSettings.approvalTitle"), isPanel: true) {
            Text(L("settingsPage.connectorsSettings.approvalLead", ["count": tools.count, "server": serverName]))
                .webText(14.4)
                .foregroundStyle(AppTheme.textPrimary)
            WebFieldHelp(L("settingsPage.connectorsSettings.approvalNothingYet"))
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(tools.enumerated()), id: \.offset) { index, tool in
                        VStack(alignment: .leading, spacing: 2.4) {
                            Text(tool["name"]?.string ?? "")
                                .font(Font(DSFont.uiMono(13.6, weight: .bold) as CTFont))
                                .foregroundStyle(AppTheme.textPrimary)
                            Text(tool["description"]?.string ?? "")
                                .webText(13)
                                .foregroundStyle(AppTheme.textMuted)
                        }
                        .padding(.vertical, 8)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .overlay(alignment: .bottom) {
                            if index < tools.count - 1 { Rectangle().fill(AppTheme.borderLight).frame(height: 1) }
                        }
                    }
                }
            }
            .frame(maxHeight: 416)
            .fixedSize(horizontal: false, vertical: true)
            Text(L("settingsPage.connectorsSettings.approvalPinned"))
                .webText(13)
                .foregroundStyle(AppTheme.textSecondary)
                .padding(.leading, 15)
                .overlay(alignment: .leading) { Rectangle().fill(AppTheme.primary).frame(width: 3) }
            InputTextWithHint(hint: L("settingsPage.connectorsSettings.approvalLabelHint"), placeholder: serverName, text: $label)
            WebFieldHelp(L("settingsPage.connectorsSettings.approvalLabelHelp"))
            PillButton(
                label: connecting ? L("settingsPage.connectorsSettings.approvingLabel") : L("settingsPage.connectorsSettings.approve", ["count": tools.count]),
                icon: "valid",
                disabled: connecting || tools.isEmpty
            ) {
                Task { await approve() }
            }
        }
    }

    // MARK: Actions

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let token = try await auth.getAccessTokenSilently()
            connectors = try await ConnectorsService.listConnectors(token: token)
        } catch {
            toasts.showToast(error.localizedDescription)
        }
    }

    private func resetFlow() {
        url = ""
        credentialRef = ""
        secret = ""
        urlError = nil
        preview = nil
        previewError = nil
        selected = []
        imported = nil
        discovery = nil
        discoverError = nil
        label = ""
    }

    private func closeFlow() {
        resetFlow()
        chooserOpen = false
        flow = nil
    }

    /// The address is checked here so a bad one never leaves the device.
    private func validateUrl() -> Bool {
        if trimmedUrl.isEmpty {
            urlError = L("settingsPage.connectorsSettings.errorUrlRequired")
            return false
        }
        if !trimmedUrl.lowercased().hasPrefix("https://") {
            urlError = L("settingsPage.connectorsSettings.errorUrlHttps")
            return false
        }
        urlError = nil
        return true
    }

    /// api.example.com becomes EXAMPLE, so the usual case needs no thought.
    private static func suggestedCredentialRef(_ url: String) -> String {
        guard let scheme = url.range(of: "://") else { return "" }
        let rest = url[scheme.upperBound...]
        let host = (rest.firstIndex(of: "/").map { rest[..<$0] } ?? rest).split(separator: ":").first.map(String.init) ?? ""
        let labels = host.split(separator: ".").map(String.init)
        guard !labels.isEmpty else { return "" }
        let name = labels.count > 1 ? labels[labels.count - 2] : labels[0]
        return name.filter { $0.isASCII && ($0.isLetter || $0.isNumber) }.uppercased()
    }

    /// The `{{credential.x}}` keys the chosen operations read at call time, so the one key
    /// pasted is stored under exactly the names the imported drafts look for.
    private static func credentialKeys(_ operations: [JSONValue]) -> [String] {
        var keys: [String] = []
        for operation in operations {
            let request = operation["request"]
            var source = [request?["url"]?.string ?? ""]
            for field in ["headers", "query", "body"] {
                source += (request?[field]?.pairs ?? []).compactMap { $0.1.string }
            }
            for text in source {
                for match in text.matches(of: /\{\{\s*credential\.([a-zA-Z0-9_]+)\s*\}\}/) {
                    let key = String(match.output.1)
                    if !keys.contains(key) { keys.append(key) }
                }
            }
        }
        return keys
    }

    private func runPreview() async {
        guard validateUrl() else { return }
        previewing = true
        preview = nil
        previewError = nil
        selected = []
        imported = nil
        defer { previewing = false }
        do {
            let token = try await auth.getAccessTokenSilently()
            // The key isn't needed to read a description, and a preview writes nothing.
            let result = try await ConnectorsService.previewSpec(token: token, specUrl: trimmedUrl, credentialRef: effectiveCredentialRef)
            if result["ok"]?.boolean == true {
                preview = result
            } else {
                previewError = result["error"]?.string ?? L("settingsPage.connectorsSettings.previewErrorToast")
            }
        } catch {
            previewError = error.localizedDescription
        }
    }

    private func runImport() async {
        guard let preview else { return }
        let operations = (preview["operations"]?.array ?? []).filter { selected.contains($0["name"]?.string ?? "") }
        guard !operations.isEmpty, operations.count <= Self.maxImportedOperations else { return }
        let ref = effectiveCredentialRef
        importing = true
        defer { importing = false }
        do {
            let token = try await auth.getAccessTokenSilently()
            let key = secret.trimmingCharacters(in: .whitespacesAndNewlines)
            if !key.isEmpty {
                let found = Self.credentialKeys(operations)
                let names = found.isEmpty ? [Self.defaultSpecCredentialKey] : found
                try await ToolsService.storeCredentials(token: token, request: StoreToolCredentialsRequest(
                    toolType: ref,
                    authType: "api_key",
                    credentials: Dictionary(uniqueKeysWithValues: names.map { ($0, key) })
                ))
                secret = ""
            }
            let count = try await ConnectorsService.importSpec(token: token, specUrl: trimmedUrl, credentialRef: ref, operations: operations)
            imported = count
            toasts.showToast(L("settingsPage.connectorsSettings.importedToast", ["count": count]))
            await load()
        } catch {
            toasts.showToast(error.localizedDescription)
        }
    }

    private func runDiscover() async {
        guard validateUrl() else { return }
        let ref = effectiveCredentialRef
        discovering = true
        discovery = nil
        discoverError = nil
        defer { discovering = false }
        do {
            let token = try await auth.getAccessTokenSilently()
            // Stored first: the server is asked with the key in place, and the request
            // below names the key rather than carrying it.
            let key = secret.trimmingCharacters(in: .whitespacesAndNewlines)
            if !key.isEmpty {
                try await ToolsService.storeCredentials(token: token, request: StoreToolCredentialsRequest(toolType: ref, authType: "api_key", credentials: [Self.mcpCredentialKey: key]))
                secret = ""
            }
            let result = try await ConnectorsService.discoverMcp(token: token, serverUrl: trimmedUrl, credentialRef: ref, headers: Self.mcpAuthHeaders)
            if result["ok"]?.boolean == true {
                discovery = result
                label = result["server_name"]?.string ?? ""
            } else {
                discoverError = result["error"]?.string ?? L("settingsPage.connectorsSettings.discoverErrorToast")
            }
        } catch {
            discoverError = error.localizedDescription
        }
    }

    /// Saves the list exactly as it was approved. Nothing else is ever bound.
    private func approve() async {
        guard let discovery else { return }
        let tools = discovery["tools"]?.array ?? []
        let trimmedLabel = label.trimmingCharacters(in: .whitespaces)
        connecting = true
        defer { connecting = false }
        do {
            let token = try await auth.getAccessTokenSilently()
            try await ConnectorsService.connectMcp(
                token: token,
                serverUrl: trimmedUrl,
                credentialRef: effectiveCredentialRef,
                label: trimmedLabel.isEmpty ? (discovery["server_name"]?.string ?? "") : trimmedLabel,
                headers: Self.mcpAuthHeaders,
                tools: tools
            )
            toasts.showToast(L("settingsPage.connectorsSettings.connectedToast", ["count": tools.count]))
            closeFlow()
            await load()
        } catch {
            toasts.showToast(error.localizedDescription)
        }
    }

    private func disconnect(_ connector: Connector) async {
        busyConnectorId = connector.id
        defer { busyConnectorId = nil }
        do {
            let token = try await auth.getAccessTokenSilently()
            try await ConnectorsService.disconnect(token: token, id: connector.id)
            toasts.showToast(L("settingsPage.connectorsSettings.disconnectedToast"))
            await load()
        } catch {
            toasts.showToast(error.localizedDescription)
        }
    }
}
