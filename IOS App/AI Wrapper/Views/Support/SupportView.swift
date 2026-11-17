import SwiftUI

/// The form's fields and the limits the support Lambda enforces on them (SupportPage.tsx).
struct SupportForm: Equatable {
    static let supportEmail = "customer-support@genflowly.com"
    static let nameMax = 100
    static let emailMax = 254
    static let messageMin = 10
    static let messageMax = 5000

    var name = ""
    var email = ""
    var topic: SupportTopic?
    var message = ""

    var trimmedEmail: String { email.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var trimmedMessage: String { message.trimmingCharacters(in: .whitespacesAndNewlines) }

    var isEmailValid: Bool {
        trimmedEmail.unicodeScalars.count <= Self.emailMax && trimmedEmail.wholeMatch(of: /[^\s@]+@[^\s@]+\.[^\s@]+/) != nil
    }

    /// Code points, which is what the Lambda counts.
    var isMessageValid: Bool { (Self.messageMin...Self.messageMax).contains(trimmedMessage.unicodeScalars.count) }

    var canSend: Bool { isEmailValid && topic != nil && isMessageValid }

    func request(appVersion: String?, customerId: String?) -> SupportRequest? {
        guard canSend, let topic else { return nil }
        return SupportRequest(
            name: name.trimmingCharacters(in: .whitespacesAndNewlines),
            email: trimmedEmail,
            topic: topic,
            message: trimmedMessage,
            context: .init(appVersion: appVersion, customerId: customerId)
        )
    }

    /// `maxLength`, in code points.
    static func clip(_ text: String, to limit: Int) -> String {
        guard text.unicodeScalars.count > limit else { return text }
        return String(String.UnicodeScalarView(text.unicodeScalars.prefix(limit)))
    }

    /// "1.0 (12)": the version people see, then the build number.
    static func appVersion(info: [String: Any]) -> String? {
        let version = (info["CFBundleShortVersionString"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        let build = (info["CFBundleVersion"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        switch (version, build) {
        case let (version?, build?): return "\(version) (\(build))"
        case let (version?, nil): return version
        case let (nil, build?): return "(\(build))"
        default: return nil
        }
    }

    /// `<Trans>`: the words inside `<tag>…</tag>` become a link.
    static func linked(_ text: String, tag: String, to url: URL) -> AttributedString {
        guard let open = text.range(of: "<\(tag)>"),
              let close = text.range(of: "</\(tag)>", range: open.upperBound..<text.endIndex) else {
            return AttributedString(text)
        }
        var link = AttributedString(text[open.upperBound..<close.lowerBound])
        link.link = url
        link.underlineStyle = .single
        return AttributedString(text[..<open.lowerBound]) + link + AttributedString(text[close.upperBound...])
    }
}

/// /support, for a signed-in user: sends with the app's own session, which the in-app browser
/// doesn't share.
struct SupportView: View {
    @EnvironmentObject var router: AppRouter
    @EnvironmentObject var auth: AuthStore

    private enum Phase: Equatable {
        case idle, sending, failed
        case sent(email: String)
    }

    private static let privacyURL = AppConfig.webAppURL.appendingPathComponent("privacy-policy")
    /// The field above the message: at the top it sits under the floating header, leaving the
    /// message box clear.
    private static let topicFieldId = "support-topic-field"

    @State private var form = SupportForm()
    @State private var phase = Phase.idle
    @State private var nameFocused = false
    @State private var emailFocused = false
    @State private var emailTouched = false
    @FocusState private var messageFocused: Bool

    private var showsEmailError: Bool { emailTouched && !form.isEmailValid }

    var body: some View {
        DetailScaffold(
            title: L("supportPage.title"),
            backLabel: L("settingsPage.settingsSidebar.title"),
            onLeading: { router.openWithL2Menu(.settings(.account)) },
            actions: actions,
            keyboardScrollTarget: messageFocused ? Self.topicFieldId : nil
        ) {
            if case .sent(let email) = phase {
                sent(to: email)
            } else {
                fields
            }
        }
        .onChange(of: auth.customerName, initial: true) { _, _ in prefill() }
        .onChange(of: emailFocused) { _, focused in
            if !focused { emailTouched = true }
        }
    }

    /// The session can finish loading after the page opens: fill in only what hasn't been typed.
    private func prefill() {
        if form.name.isEmpty { form.name = SupportForm.clip(auth.user?.name ?? "", to: SupportForm.nameMax) }
        if form.email.isEmpty { form.email = SupportForm.clip(auth.user?.email ?? "", to: SupportForm.emailMax) }
    }

    @ViewBuilder
    private var fields: some View {
        Text(L("supportPage.intro"))
            .webText(15.2, lineHeight: 22.8)
            .foregroundStyle(AppTheme.textSecondary)

        field(L("supportPage.name")) {
            SupportInput(
                text: Binding(get: { form.name }, set: { form.name = SupportForm.clip($0, to: SupportForm.nameMax) }),
                isFocused: $nameFocused
            )
            .accessibilityLabel(L("supportPage.name"))
            .accessibilityIdentifier("support-name")
        }

        field(L("supportPage.email")) {
            SupportInput(
                text: Binding(get: { form.email }, set: { form.email = SupportForm.clip($0, to: SupportForm.emailMax) }),
                isFocused: $emailFocused,
                keyboard: .emailAddress,
                hasError: showsEmailError
            )
            .accessibilityLabel(L("supportPage.email"))
            .accessibilityIdentifier("support-email")
            if showsEmailError {
                Text(L("supportPage.emailInvalid"))
                    .webText(12.8, lineHeight: 18.56)
                    .foregroundStyle(AppTheme.error)
                    .padding(.top, 6)
                    .accessibilityIdentifier("support-email-error")
            }
        }

        field(L("supportPage.topic")) {
            PhoneFieldSelect(
                value: form.topic?.rawValue ?? "",
                placeholder: L("supportPage.topicPlaceholder"),
                options: SupportTopic.allCases.map { .init(value: $0.rawValue, label: $0.label) },
                onChange: { form.topic = SupportTopic(rawValue: $0) }
            )
            .accessibilityIdentifier("support-topic")
        }
        .id(Self.topicFieldId)

        field(L("supportPage.message")) {
            SupportTextArea(
                text: Binding(get: { form.message }, set: { form.message = SupportForm.clip($0, to: SupportForm.messageMax) }),
                placeholder: L("supportPage.messagePlaceholder"),
                isFocused: $messageFocused
            )
            .accessibilityLabel(L("supportPage.message"))
            .accessibilityIdentifier("support-message")
            HStack(spacing: 16) {
                Text(L("supportPage.messageHint", ["min": SupportForm.messageMin]))
                Spacer(minLength: 0)
                Text(L("supportPage.messageCount", ["length": form.message.unicodeScalars.count, "max": SupportForm.messageMax]))
                    .accessibilityIdentifier("support-message-count")
            }
            .webText(12.8)
            .foregroundStyle(AppTheme.textMuted)
            .padding(.top, 6)
        }

        if auth.isAuthenticated {
            help(AttributedString(L("supportPage.accountNote")))
                .accessibilityIdentifier("support-account-note")
        }

        help(SupportForm.linked(L("supportPage.privacyNote"), tag: "policy", to: Self.privacyURL))
            .environment(\.openURL, OpenURLAction { url in
                guard url == Self.privacyURL else { return .systemAction }
                router.navigate(.privacyPolicy)
                return .handled
            })
    }

    private func field<Content: View>(_ label: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(label)
                .webText(12.8, 600)
                .foregroundStyle(AppTheme.textSecondary)
                .padding(.bottom, 6)
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func help(_ text: AttributedString) -> some View {
        Text(text)
            .webText(12.8, lineHeight: 18.56)
            .foregroundStyle(AppTheme.textMuted)
            .tint(AppTheme.textMuted)
    }

    /// Send and its error, pinned above the keyboard so a long message can't push them away.
    private var actions: AnyView? {
        if case .sent = phase { return nil }
        return AnyView(
            VStack(alignment: .leading, spacing: 12) {
                if phase == .failed {
                    Text(SupportForm.linked(
                        L("supportPage.failed", ["email": SupportForm.supportEmail]),
                        tag: "mail",
                        to: URL(string: "mailto:\(SupportForm.supportEmail)")!
                    ))
                    .webText(14, lineHeight: 20.3)
                    .foregroundStyle(AppTheme.error)
                    .tint(AppTheme.error)
                    .accessibilityIdentifier("support-error")
                }
                PillButton(
                    label: L(phase == .sending ? "supportPage.sending" : "supportPage.send"),
                    disabled: !form.canSend || phase == .sending,
                    fullWidth: true
                ) { Task { await send() } }
                .accessibilityIdentifier("support-send")
            }
        )
    }

    private func sent(to email: String) -> some View {
        VStack(alignment: .leading, spacing: 20) {
            Text(L("supportPage.sentTitle"))
                .webText(20, 600)
                .foregroundStyle(AppTheme.textPrimary)
            Text(L("supportPage.sentBody", ["email": email]))
                .webText(15.2, lineHeight: 22.8)
                .foregroundStyle(AppTheme.textSecondary)
            PillButton(label: L("supportPage.sendAnother"), style: .secondary) { phase = .idle }
                .accessibilityIdentifier("support-send-another")
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityIdentifier("support-sent")
    }

    private func send() async {
        guard phase != .sending,
              let request = form.request(
                appVersion: SupportForm.appVersion(info: Bundle.main.infoDictionary ?? [:]),
                customerId: auth.customerId
              ) else { return }
        phase = .sending
        do {
            let token = try await auth.getAccessTokenSilently()
            try await SupportService.send(token: token, request: request)
            phase = .sent(email: request.email)
            form.topic = nil
            form.message = ""
            emailTouched = false
        } catch {
            phase = .failed
        }
    }
}

/// `.input` on a phone: 48pt tall, 16pt text, radius 10.
private struct SupportInput: View {
    @Binding var text: String
    @Binding var isFocused: Bool
    var keyboard: UIKeyboardType = .default
    var hasError = false

    var body: some View {
        WebInputField(text: $text, isFocused: $isFocused, font: DSFont.ui(16), keyboard: keyboard)
            .padding(.horizontal, 13)
            .frame(height: 48)
            .background(AppTheme.backgroundSecondary)
            .clipShape(RoundedRectangle(cornerRadius: DSRadius.lg))
            .overlay(
                RoundedRectangle(cornerRadius: DSRadius.lg)
                    .strokeBorder(hasError ? AppTheme.error : isFocused ? AppTheme.primary : AppTheme.border, lineWidth: 1)
            )
    }
}

/// `.textArea`: at least 160pt tall, 16pt text on 24pt lines.
private struct SupportTextArea: View {
    @Binding var text: String
    let placeholder: String
    var isFocused: FocusState<Bool>.Binding

    private static let font = DSFont.ui(16)

    var body: some View {
        ZStack(alignment: .topLeading) {
            if text.isEmpty {
                Text(placeholder)
                    .webText(16, lineHeight: 24)
                    .foregroundStyle(AppTheme.textMuted)
                    .padding(13)
                    .allowsHitTesting(false)
            }
            TextEditor(text: $text)
                .focused(isFocused)
                .font(Font(Self.font as CTFont))
                .lineSpacing(max(0, 24 - Self.font.lineHeight))
                .foregroundStyle(AppTheme.textPrimary)
                .tint(AppTheme.primary)
                .scrollContentBackground(.hidden)
                .padding(.horizontal, 8)
                .padding(.vertical, 5)
        }
        .frame(minHeight: 160)
        .background(AppTheme.backgroundSecondary)
        .clipShape(RoundedRectangle(cornerRadius: DSRadius.lg))
        .overlay(RoundedRectangle(cornerRadius: DSRadius.lg).strokeBorder(isFocused.wrappedValue ? AppTheme.primary : AppTheme.border, lineWidth: 1))
    }
}
