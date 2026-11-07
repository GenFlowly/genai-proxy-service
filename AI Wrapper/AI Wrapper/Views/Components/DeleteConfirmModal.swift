import SwiftUI

// MARK: - DeleteConfirmModal (components/common/DeleteConfirmModal)

/// Asks before a permanent delete: the message, why the last attempt failed if it did, then
/// Cancel and Delete. While the delete runs both buttons are off and the dialog stays up.
struct DeleteConfirmContent: View {
    let message: String
    let isDeleting: Bool
    var error: String?
    let onConfirm: () -> Void
    let onCancel: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            Text(message)
                .webText(14.4, lineHeight: 21.6)
                .foregroundStyle(AppTheme.textMuted)
                .frame(maxWidth: .infinity, alignment: .leading)
            if let error {
                Text(error)
                    .webText(13.6)
                    .foregroundStyle(AppTheme.error)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityIdentifier("delete-confirm-error")
            }
            HStack(spacing: 12) {
                Spacer(minLength: 0)
                Button(action: onCancel) {
                    Text(L("common.deleteConfirm.cancel"))
                        .webText(arial: 13.6)
                        .foregroundStyle(AppTheme.textSecondary)
                        // 0.4rem 0.75rem inside a 1pt border
                        .padding(.horizontal, 13)
                        .padding(.vertical, 7.4)
                        .overlay(RoundedRectangle(cornerRadius: DSRadius.md).strokeBorder(AppTheme.border, lineWidth: 1))
                }
                .buttonStyle(WebPressStyle())
                .disabled(isDeleting)
                .opacity(isDeleting ? 0.5 : 1)
                .accessibilityIdentifier("delete-confirm-cancel")
                Button(action: onConfirm) {
                    Text(isDeleting ? L("common.deleteConfirm.deleting") : L("common.deleteConfirm.delete"))
                        .webText(arial: 13.6, bold: true)
                        .foregroundStyle(.white)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 7.2)
                        .background(AppTheme.error)
                        .clipShape(RoundedRectangle(cornerRadius: DSRadius.md))
                }
                .buttonStyle(WebPressStyle())
                .disabled(isDeleting)
                .opacity(isDeleting ? 0.5 : 1)
                .accessibilityIdentifier("delete-confirm-confirm")
            }
        }
    }
}

extension View {
    /// Presents `DeleteConfirmContent` in a `WebModal`. It can't be dismissed while the
    /// delete runs.
    func deleteConfirmModal(
        isPresented: Binding<Bool>,
        title: String,
        message: String,
        isDeleting: Bool,
        error: String?,
        onConfirm: @escaping () -> Void
    ) -> some View {
        let binding = Binding(
            get: { isPresented.wrappedValue },
            set: { if $0 || !isDeleting { isPresented.wrappedValue = $0 } }
        )
        return webModal(isPresented: binding, title: title, maxWidth: 416) {
            DeleteConfirmContent(
                message: message,
                isDeleting: isDeleting,
                error: error,
                onConfirm: onConfirm,
                onCancel: { binding.wrappedValue = false }
            )
        }
    }
}
