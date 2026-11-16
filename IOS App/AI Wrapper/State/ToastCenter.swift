import SwiftUI
import Combine

/// Mirrors src/context/ToastContext.tsx — stacked auto-dismissing toasts.
@MainActor
final class ToastCenter: ObservableObject {
    struct Toast: Identifiable, Equatable {
        let id = UUID()
        let message: String
    }

    @Published var toasts: [Toast] = []

    func showToast(_ message: String, duration: TimeInterval = 3) {
        let toast = Toast(message: message)
        toasts.append(toast)
        Task {
            try? await Task.sleep(nanoseconds: UInt64(duration * 1_000_000_000))
            toasts.removeAll { $0.id == toast.id }
        }
    }
}

/// Toast.module.scss: fixed 5rem from the top, 1.5rem from the right.
struct ToastOverlay: View {
    @EnvironmentObject var toastCenter: ToastCenter

    var body: some View {
        VStack(alignment: .trailing, spacing: 8) {
            ForEach(toastCenter.toasts) { toast in
                ToastWidth {
                    Text(toast.message)
                        .webText(14.4, 500)
                        .foregroundStyle(AppTheme.navbarText)
                }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
                    .background(AppTheme.navbarBackground)
                    .clipShape(RoundedRectangle(cornerRadius: DSRadius.md))
                    .shadow(color: .black.opacity(0.5), radius: 7.5, y: 10)
                    .transition(.asymmetric(
                        insertion: .opacity.combined(with: .offset(x: 20)),
                        removal: .opacity.combined(with: .offset(y: -10))
                    ))
            }
        }
        .padding(.top, 80)
        .padding(.trailing, 24)
        .frame(maxWidth: .infinity, alignment: .trailing)
        .allowsHitTesting(false)
        .animation(.easeOut(duration: 0.3), value: toastCenter.toasts)
    }
}

/// `max-width: 300px` shrink-to-fit: a toast hugs its text and wraps only past the limit
/// (a SwiftUI flexible frame would grow to the limit instead).
private struct ToastWidth: Layout {
    private static let maxTextWidth: CGFloat = 300 - 32

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        subviews.first?.sizeThatFits(ProposedViewSize(width: Self.maxTextWidth, height: nil)) ?? .zero
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        subviews.first?.place(at: bounds.origin, proposal: ProposedViewSize(bounds.size))
    }
}
