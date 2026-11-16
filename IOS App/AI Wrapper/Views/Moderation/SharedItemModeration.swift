import Combine
import SwiftUI

/// Report and Block for an item shared with the signed-in user (useSharedItemModeration.tsx):
/// who owns it, the menu actions, and what they do.
@MainActor
final class SharedItemModeration: ObservableObject {
    @Published private(set) var owner: SharedItemOwner?
    @Published var isReportPresented = false
    @Published var isBlockConfirmPresented = false
    @Published private(set) var isBlocking = false
    @Published private(set) var blockError: String?
    private(set) var item: SharedItem?

    /// `item` is nil when there's nothing to moderate: a new chat, or something the user owns.
    func load(item: SharedItem?, auth: AuthStore) async {
        self.item = item
        owner = nil
        guard let item, let token = try? await auth.getAccessTokenSilently() else { return }
        let loaded = try? await ModerationService.owner(token: token, item: item)
        if self.item == item { owner = loaded }
    }

    var menuItems: [MobileHeaderMenuItem] {
        guard let owner, let item else { return [] }
        var items = [MobileHeaderMenuItem(label: L(item.isConversation ? "moderation.report.menuConversation" : "moderation.report.menuInstruction")) { [weak self] in
            self?.isReportPresented = true
        }]
        if owner.canBlock {
            items.append(MobileHeaderMenuItem(label: L("moderation.block.menu", ["name": owner.label]), destructive: true) { [weak self] in
                self?.blockError = nil
                self?.isBlockConfirmPresented = true
            })
        }
        return items
    }

    func block(auth: AuthStore, toasts: ToastCenter, onGone: @escaping () -> Void) async {
        guard let owner else { return }
        isBlocking = true
        blockError = nil
        defer { isBlocking = false }
        do {
            let token = try await auth.getAccessTokenSilently()
            try await ModerationService.block(token: token, customerId: owner.ownerCustomerId)
            toasts.showToast(L("moderation.block.done", ["name": owner.label]))
            isReportPresented = false
            await auth.refreshInstructions()
            onGone()
        } catch {
            blockError = L("moderation.block.failed", ["name": owner.label])
            if !isReportPresented { toasts.showToast(blockError ?? "") }
        }
    }

    func remove(auth: AuthStore, toasts: ToastCenter, onGone: @escaping () -> Void) async {
        guard let item, let customerId = auth.customerId else { return }
        do {
            let token = try await auth.getAccessTokenSilently()
            switch item {
            case .conversation(let id): try await ConversationHistoryService.deleteConversation(token: token, conversationId: id)
            case .instruction(let id): try await InstructionService.unshareInstruction(token: token, instructionId: id, targetCustomerId: customerId)
            }
            toasts.showToast(L("moderation.report.removed"))
            isReportPresented = false
            await auth.refreshInstructions()
            onGone()
        } catch {
            toasts.showToast(L("moderation.report.removeFailed"))
        }
    }
}

private struct SharedItemModerationDialogs: ViewModifier {
    @EnvironmentObject private var auth: AuthStore
    @EnvironmentObject private var toasts: ToastCenter
    @ObservedObject var moderation: SharedItemModeration
    let onGone: () -> Void

    func body(content: Content) -> some View {
        content
            .sheet(isPresented: $moderation.isReportPresented) {
                ReportSheet(moderation: moderation, onGone: onGone)
                    .environmentObject(auth)
                    .environmentObject(toasts)
            }
            .webConfirm(blockMessage, isPresented: $moderation.isBlockConfirmPresented) {
                Task { await moderation.block(auth: auth, toasts: toasts, onGone: onGone) }
            }
    }

    private var blockMessage: String? {
        moderation.owner.map { "\(L("moderation.block.title", ["name": $0.label])) \(L("moderation.block.message"))" }
    }
}

extension View {
    /// The report sheet and the block confirmation for [moderation]. `onGone` runs once the
    /// item is no longer the user's to see.
    func sharedItemModerationDialogs(_ moderation: SharedItemModeration, onGone: @escaping () -> Void) -> some View {
        modifier(SharedItemModerationDialogs(moderation: moderation, onGone: onGone))
    }
}
