import SwiftUI

/// ReportDialog.tsx as a bottom sheet: why an item is being reported, then what to do next.
struct ReportSheet: View {
    @EnvironmentObject private var auth: AuthStore
    @EnvironmentObject private var toasts: ToastCenter
    @Environment(\.dismiss) private var dismiss
    @ObservedObject var moderation: SharedItemModeration
    let onGone: () -> Void

    private enum Phase { case editing, sending, failed, sent }

    @State private var form = ReportForm()
    @State private var phase = Phase.editing
    @FocusState private var detailsFocused: Bool

    static let contentRulesURL = AppConfig.webAppURL.appendingPathComponent("content-rules")

    private var isConversation: Bool { moderation.item?.isConversation ?? true }
    private var ownerLabel: String { moderation.owner?.label ?? L("moderation.theOwner") }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                if phase == .sent { confirmation } else { fields }
            }
            .padding(.horizontal, 20)
            .padding(.top, 28)
            .padding(.bottom, 20)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(AppTheme.backgroundSecondary)
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
        .presentationCornerRadius(20)
        .accessibilityIdentifier("report-sheet")
    }

    @ViewBuilder
    private var fields: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(L(isConversation ? "moderation.report.titleConversation" : "moderation.report.titleInstruction"))
                .webText(20, 600, lineHeight: 26)
                .foregroundStyle(AppTheme.textPrimary)
            Text(L("moderation.report.sharedBy", ["name": ownerLabel]))
                .webText(14, lineHeight: 20)
                .foregroundStyle(AppTheme.textMuted)
        }

        VStack(spacing: 0) {
            ForEach(Array(ReportReason.allCases.enumerated()), id: \.element) { index, reason in
                reasonRow(reason, isFirst: index == 0)
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(AppTheme.border, lineWidth: 1))

        VStack(alignment: .leading, spacing: 6) {
            Text(L("moderation.report.detailsLabel"))
                .webText(13, 500)
                .foregroundStyle(AppTheme.textMuted)
            ZStack(alignment: .topLeading) {
                if form.details.isEmpty {
                    Text(L("moderation.report.detailsPlaceholder"))
                        .webText(15, lineHeight: 21)
                        .foregroundStyle(AppTheme.textMuted)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 12)
                        .allowsHitTesting(false)
                }
                TextEditor(text: Binding(get: { form.details }, set: { form.details = ReportForm.clip($0) }))
                    .focused($detailsFocused)
                    .font(DSFont.arial(15))
                    .foregroundStyle(AppTheme.textPrimary)
                    .tint(AppTheme.primary)
                    .scrollContentBackground(.hidden)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 4)
                    .accessibilityLabel(L("moderation.report.detailsLabel"))
                    .accessibilityIdentifier("report-details")
            }
            .frame(height: 76)
            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(detailsFocused ? AppTheme.primary : AppTheme.border, lineWidth: 1))
        }

        Text(SupportForm.linked(L("moderation.report.note"), tag: "rules", to: Self.contentRulesURL))
            .webText(13, lineHeight: 18)
            .foregroundStyle(AppTheme.textMuted)
            .tint(AppTheme.primary)

        if phase == .failed {
            Text(L("moderation.report.failed"))
                .webText(14, lineHeight: 20)
                .foregroundStyle(AppTheme.error)
                .accessibilityIdentifier("report-error")
        }

        PillButton(
            label: L(phase == .sending ? "moderation.report.sending" : "moderation.report.send"),
            disabled: !form.canSend || phase == .sending,
            fullWidth: true
        ) { Task { await send() } }
        .accessibilityIdentifier("report-send")

        PillButton(label: L("moderation.report.cancel"), style: .secondary, disabled: phase == .sending, fullWidth: true) { dismiss() }
    }

    private func reasonRow(_ reason: ReportReason, isFirst: Bool) -> some View {
        let selected = form.reason == reason
        return Button { form.reason = reason } label: {
            HStack {
                Text(reason.label)
                    .webText(15, selected ? 500 : 400)
                    .foregroundStyle(AppTheme.textPrimary)
                Spacer(minLength: 8)
                Circle()
                    .fill(selected ? Color.white : AppTheme.backgroundSecondary)
                    .overlay(Circle().strokeBorder(selected ? AppTheme.primary : AppTheme.border, lineWidth: selected ? 6 : 2))
                    .frame(width: 20, height: 20)
            }
            .padding(.horizontal, 14)
            .frame(height: 46)
            .background(selected ? AppTheme.primaryLight : Color.clear)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .overlay(alignment: .top) {
            if !isFirst { Rectangle().fill(AppTheme.backgroundTertiary).frame(height: 1) }
        }
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityIdentifier("report-reason-\(reason.rawValue)")
    }

    @ViewBuilder
    private var confirmation: some View {
        VStack(spacing: 10) {
            ZStack {
                Circle().fill(AppTheme.primaryLight).frame(width: 56, height: 56)
                Image(systemName: "checkmark")
                    .font(.system(size: 24, weight: .semibold))
                    .foregroundStyle(AppTheme.primary)
            }
            Text(L("moderation.report.sentTitle"))
                .webText(20, 600, lineHeight: 26)
                .foregroundStyle(AppTheme.textPrimary)
            Text(L("moderation.report.sentBody"))
                .webText(14, lineHeight: 20)
                .foregroundStyle(AppTheme.textMuted)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 8)
        .accessibilityIdentifier("report-sent")

        if moderation.owner?.canBlock == true {
            followUp(
                title: L("moderation.report.blockTitle", ["name": ownerLabel]),
                body: L("moderation.report.blockBody"),
                button: L("moderation.report.blockButton"),
                destructive: true,
                disabled: moderation.isBlocking,
                identifier: "report-block"
            ) { Task { await moderation.block(auth: auth, toasts: toasts, onGone: onGone) } }
        }
        if moderation.owner?.canRemove == true {
            followUp(
                title: L("moderation.report.removeTitle"),
                body: L(isConversation ? "moderation.report.removeBodyConversation" : "moderation.report.removeBodyInstruction"),
                button: L("moderation.report.removeButton"),
                destructive: false,
                disabled: false,
                identifier: "report-remove"
            ) { Task { await moderation.remove(auth: auth, toasts: toasts, onGone: onGone) } }
        }
        if let error = moderation.blockError {
            Text(error)
                .webText(14, lineHeight: 20)
                .foregroundStyle(AppTheme.error)
        }

        PillButton(label: L("moderation.report.done"), fullWidth: true) { dismiss() }
            .accessibilityIdentifier("report-done")
            .padding(.top, 6)
    }

    private func followUp(title: String, body: String, button: String, destructive: Bool, disabled: Bool, identifier: String, action: @escaping () -> Void) -> some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .webText(15, 500, lineHeight: 20)
                    .foregroundStyle(AppTheme.textPrimary)
                Text(body)
                    .webText(13, lineHeight: 18)
                    .foregroundStyle(AppTheme.textMuted)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Button(action: action) {
                Text(button)
                    .webText(14, 500)
                    .foregroundStyle(destructive ? AppTheme.error : AppTheme.textPrimary)
                    .padding(.horizontal, 16)
                    .frame(height: 36)
                    .overlay(RoundedRectangle(cornerRadius: 18).strokeBorder(destructive ? AppTheme.buttonDanger : AppTheme.border, lineWidth: 1))
                    .contentShape(Rectangle())
            }
            .buttonStyle(WebPressStyle())
            .disabled(disabled)
            .accessibilityIdentifier(identifier)
        }
        .padding(14)
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(AppTheme.border, lineWidth: 1))
    }

    private func send() async {
        guard let reason = form.reason, let item = moderation.item else { return }
        phase = .sending
        do {
            let token = try await auth.getAccessTokenSilently()
            try await ModerationService.report(token: token, item: item, reason: reason, details: form.trimmedDetails)
            phase = .sent
        } catch {
            phase = .failed
        }
    }
}
