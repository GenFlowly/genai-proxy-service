import SwiftUI

/// The agreement's date on this device's calendar.
enum AiDataConsentDate {
    static func display(_ iso: String?, timeZone: TimeZone = .current) -> String? {
        guard let iso else { return nil }
        let parser = ISO8601DateFormatter()
        parser.formatOptions = iso.contains(".") ? [.withInternetDateTime, .withFractionalSeconds] : [.withInternetDateTime]
        guard let date = parser.date(from: iso) else { return nil }
        return date.formatted(Date.FormatStyle(date: .abbreviated, time: .omitted, timeZone: timeZone))
    }
}

/// Where the customer's data goes, in generic terms: the backend can change vendors without a
/// release (AiDataConsentRows.tsx).
struct AiDataConsentRows: View {
    private struct Row: Identifiable {
        let icon: String
        let title: String
        let body: String
        var id: String { icon }
    }

    private let rows = [
        Row(icon: "lucide-cpu", title: L("aiDataConsent.modelsTitle"), body: L("aiDataConsent.modelsBody")),
        Row(icon: "lucide-database", title: L("aiDataConsent.memoryTitle"), body: L("aiDataConsent.memoryBody")),
        Row(icon: "lucide-globe", title: L("aiDataConsent.webTitle"), body: L("aiDataConsent.webBody")),
    ]

    var body: some View {
        VStack(spacing: 0) {
            ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                if index > 0 { Rectangle().fill(AppTheme.backgroundTertiary).frame(height: 1) }
                HStack(alignment: .top, spacing: 12) {
                    WebIcon(name: row.icon, size: 20)
                        .frame(width: 36, height: 36)
                        .background(AppTheme.backgroundTertiary)
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                    VStack(alignment: .leading, spacing: 4) {
                        Text(row.title)
                            .webText(15, 500, lineHeight: 20)
                            .foregroundStyle(AppTheme.textPrimary)
                        Text(row.body)
                            .webText(13, lineHeight: 18)
                            .foregroundStyle(AppTheme.textMuted)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .padding(16)
            }
        }
        .background(AppTheme.backgroundSecondary)
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(AppTheme.borderLight, lineWidth: 1))
    }
}

/// Full-screen permission to share data with third-party AI services, shown in place of the
/// whole app until the customer agrees (AiDataConsentScreen.tsx). Declining signs out: without
/// the sharing there is no app to fall back to.
struct AiDataConsentView: View {
    @EnvironmentObject var auth: AuthStore

    @State private var saving = false
    @State private var error: String?
    @State private var isPolicyShown = false

    var body: some View {
        ScrollView {
            disclosure
                .padding(.horizontal, 20)
                .padding(.bottom, 16)
                .frame(maxWidth: 520)
                .frame(maxWidth: .infinity)
        }
        .scrollBounceBehavior(.basedOnSize)
        // Stays on screen while the disclosure scrolls, so the way out is never below the fold.
        .safeAreaInset(edge: .bottom, spacing: 0) {
            actions
                .padding(.horizontal, 20)
                .padding(.top, 8)
                .frame(maxWidth: 520)
                .frame(maxWidth: .infinity)
                .background(AppTheme.background.ignoresSafeArea())
        }
        .background(AppTheme.background.ignoresSafeArea())
        .sheet(isPresented: $isPolicyShown) { policySheet }
        .accessibilityIdentifier("ai-data-consent-screen")
    }

    private var disclosure: some View {
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 14) {
                WebIcon(name: "lucide-external-link", size: 22, color: AppTheme.primary)
                    .frame(width: 44, height: 44)
                    .background(AppTheme.primaryLight)
                    .clipShape(Circle())
                Text(L("aiDataConsent.title"))
                    .webText(26, 600, lineHeight: 32)
                    .foregroundStyle(AppTheme.textPrimary)
                Text(L("aiDataConsent.intro"))
                    .webText(15, lineHeight: 22)
                    .foregroundStyle(AppTheme.textMuted)
            }
            .padding(.horizontal, 4)

            AiDataConsentRows()

            VStack(alignment: .leading, spacing: 4) {
                Text(L("aiDataConsent.note"))
                    .webText(13, lineHeight: 18)
                    .foregroundStyle(AppTheme.textMuted)
                Button { isPolicyShown = true } label: {
                    Text(L("aiDataConsent.privacyPolicy"))
                        .webText(13, 500, lineHeight: 18)
                        .foregroundStyle(AppTheme.primary)
                }
                .buttonStyle(WebPressStyle())
                .accessibilityIdentifier("ai-data-consent-policy")
            }
            .padding(.horizontal, 4)
        }
    }

    private var actions: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let error {
                Text(error)
                    .webText(13)
                    .foregroundStyle(AppTheme.error)
                    .padding(.horizontal, 4)
                    .padding(.bottom, 12)
            }

            Button { Task { await agree() } } label: {
                Text(L("aiDataConsent.agree"))
                    .webText(16, 500)
                    .foregroundStyle(saving ? AppTheme.disabledText : Color.white)
                    .frame(maxWidth: .infinity, minHeight: 50)
                    .background(saving ? AppTheme.disabled : AppTheme.buttonPrimary)
                    .clipShape(RoundedRectangle(cornerRadius: 12))
            }
            .buttonStyle(WebPressStyle())
            .disabled(saving)
            .accessibilityIdentifier("ai-data-consent-agree")

            Button { auth.logout() } label: {
                Text(L("aiDataConsent.decline"))
                    .webText(15, 500)
                    .foregroundStyle(saving ? AppTheme.disabledText : AppTheme.primary)
                    .frame(maxWidth: .infinity, minHeight: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(WebPressStyle())
            .disabled(saving)
            .padding(.top, 6)
            .accessibilityIdentifier("ai-data-consent-decline")
        }
    }

    private var policySheet: some View {
        VStack(spacing: 0) {
            HStack {
                Text(L("privacyPolicy.title"))
                    .webText(17, 600)
                    .foregroundStyle(AppTheme.textPrimary)
                Spacer()
                Button { isPolicyShown = false } label: {
                    WebIcon(name: "close", size: 20)
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(WebPressStyle())
                .accessibilityLabel(L("aiDataConsent.close"))
            }
            .padding(.leading, 20)
            .padding(.trailing, 8)
            .padding(.vertical, 4)

            ScrollView {
                PrivacyPolicyContent()
                    .padding(16)
            }
        }
        .background(AppTheme.background.ignoresSafeArea())
    }

    private func agree() async {
        saving = true
        error = nil
        do {
            try await auth.acceptAiDataConsent()
        } catch {
            self.error = L("aiDataConsent.saveError")
            saving = false
        }
    }
}
