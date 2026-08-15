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
            withAnimation(.easeOut(duration: 0.3)) {
                toasts.removeAll { $0.id == toast.id }
            }
        }
    }
}

struct ToastOverlay: View {
    @EnvironmentObject var toastCenter: ToastCenter

    var body: some View {
        VStack(spacing: 8) {
            ForEach(toastCenter.toasts) { toast in
                Text(toast.message)
                    .font(.subheadline)
                    .foregroundStyle(.white)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                    .background(AppTheme.navbarBackground)
                    .clipShape(RoundedRectangle(cornerRadius: 6))
                    .shadow(radius: 8)
                    .frame(maxWidth: 300)
                    .transition(.move(edge: .trailing).combined(with: .opacity))
            }
            Spacer()
        }
        .padding(.top, 8)
        .frame(maxWidth: .infinity, alignment: .trailing)
        .padding(.trailing, 16)
        .allowsHitTesting(false)
        .animation(.easeOut(duration: 0.3), value: toastCenter.toasts)
    }
}
