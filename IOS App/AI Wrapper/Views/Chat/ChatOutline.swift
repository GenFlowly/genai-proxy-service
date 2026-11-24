import SwiftUI

/// One turn of the conversation as the Outline lists it (outline.models.ts).
struct OutlineItem: Identifiable, Equatable {
    let id: String
    let number: Int
    let prompt: String
    let meta: String
    let isGenerating: Bool
}

/// The conversation's turns for the Outline and the turn in view (useConversationOutline).
enum ChatOutline {
    /// A turn is a block that was sent; the empty editor block after the last turn is not one.
    static func items(blocks: [ConversationBlock], vendorName: (String) -> String, now: Date = Date()) -> [OutlineItem] {
        blocks
            .filter { $0.status == .resolved || $0.isLoading || !$0.responseMessages.isEmpty }
            .enumerated()
            .map { index, block in
                var vendors: [String] = []
                for message in block.responseMessages where !vendors.contains(message.aiVendor.rawValue) {
                    vendors.append(message.aiVendor.rawValue)
                }
                let names = vendors.map(vendorName).joined(separator: ", ")
                let time = block.sentAt.map { Calendar.current.isDate($0, inSameDayAs: now) ? ServerDate.time($0) : ServerDate.dateTime($0) } ?? ""
                let parts = block.isLoading
                    ? [names, time]
                    : [L("conversation.outline.responses", ["count": block.responseMessages.count]), names, time]
                return OutlineItem(
                    id: block.conversationBlockId,
                    number: index + 1,
                    prompt: plainPrompt(block.prompt),
                    meta: parts.filter { !$0.isEmpty }.joined(separator: " · "),
                    isGenerating: block.isLoading
                )
            }
    }

    /// A prompt as one plain line, for the places that name a turn (the Outline, the header):
    /// markdown's emphasis, strikethrough, code, heading, quote, fence and link marks dropped,
    /// whitespace runs collapsed. Word-internal underscores and asterisks (snake_case, 2*3) stay.
    /// The web's `plainPrompt`.
    static func plainPrompt(_ prompt: String) -> String {
        let rules: [(String, String, NSRegularExpression.Options)] = [
            (#"^\s*```.*$"#, "", .anchorsMatchLines),
            (#"^\s{0,3}(#{1,6}\s+|>\s?)"#, "", .anchorsMatchLines),
            (#"!?\[([^\]]*)\]\([^)]*\)"#, "$1", []),
            (#"(\*\*|__)(?=\S)(.+?)(?<=\S)\1"#, "$2", []),
            (#"(?<![\w*])\*(?=\S)(.+?)(?<=\S)\*(?![\w*])"#, "$1", []),
            (#"(?<![\w_])_(?=\S)(.+?)(?<=\S)_(?![\w_])"#, "$1", []),
            (#"~~(?=\S)(.+?)(?<=\S)~~"#, "$1", []),
            (#"`([^`]+)`"#, "$1", []),
            (#"\s+"#, " ", []),
        ]
        var text = prompt
        for (pattern, template, options) in rules {
            guard let regex = try? NSRegularExpression(pattern: pattern, options: options) else { continue }
            text = regex.stringByReplacingMatches(in: text, range: NSRange(text.startIndex..., in: text), withTemplate: template)
        }
        return text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// The turn in view, or the last turn when the view isn't on one.
    static func currentId(items: [OutlineItem], viewedId: String?) -> String? {
        if let viewedId, items.contains(where: { $0.id == viewedId }) { return viewedId }
        return items.last?.id
    }

    /// The last block whose top has passed 30% of the way down the view: the same band the
    /// web's viewport observer reports (`rootMargin: -10% 0 -70% 0`).
    static func viewedBlockId(blockTops: [(id: String, top: CGFloat)], scrollOffset: CGFloat, viewportHeight: CGFloat) -> String? {
        let line = scrollOffset + viewportHeight * 0.3
        return blockTops.sorted { $0.top < $1.top }.last { $0.top <= line }?.id ?? blockTops.min { $0.top < $1.top }?.id
    }
}

/// One vendor's usage summed over the conversation (conversationUsageByVendor).
struct VendorUsage: Identifiable, Equatable {
    let vendor: AIVendor
    var totals: UsageTotals
    var id: String { vendor.rawValue }

    /// Every vendor that answered with usage data, in the order they first answered.
    static func byVendor(_ blocks: [ConversationBlock]) -> [VendorUsage] {
        var result: [VendorUsage] = []
        for block in blocks {
            for message in block.responseMessages where message.inputTokens != nil || message.outputTokens != nil || message.totalTokens != nil || message.costUsd != nil {
                if let index = result.firstIndex(where: { $0.vendor == message.aiVendor }) {
                    result[index].totals.add(message)
                } else {
                    result.append(VendorUsage(vendor: message.aiVendor, totals: UsageTotals(message)))
                }
            }
        }
        return result
    }
}

// MARK: - Outline sheet (Outline.module.scss .sheet)

/// 📱 The conversation's turns in a bottom sheet over a scrim; a tap jumps to that turn.
struct OutlineSheet: View {
    @Environment(\.windowHeight) private var windowHeight
    let items: [OutlineItem]
    let currentId: String?
    let onSelect: (String) -> Void
    let onClose: () -> Void

    var body: some View {
        ZStack(alignment: .bottom) {
            Color.black.opacity(0.4)
                .ignoresSafeArea()
                .onTapGesture(perform: onClose)
                .accessibilityHidden(true)

            VStack(spacing: 0) {
                Capsule()
                    .fill(AppTheme.textMuted.opacity(0.6))
                    .frame(width: 36, height: 4)
                    .padding(.bottom, 8)
                header
                ScrollView {
                    VStack(spacing: 2) {
                        ForEach(items) { item in
                            row(item)
                        }
                    }
                }
                .scrollBounceBehavior(.basedOnSize)
            }
            .padding(.horizontal, 8)
            .padding(.top, 8)
            .padding(.bottom, 20)
            .frame(maxWidth: .infinity)
            .frame(maxHeight: windowHeight * 0.8, alignment: .top)
            .fixedSize(horizontal: false, vertical: true)
            .background(
                UnevenRoundedRectangle(topLeadingRadius: 16, topTrailingRadius: 16)
                    .fill(AppTheme.backgroundSecondary)
                    .shadow(color: .black.opacity(0.3), radius: 20, y: -12)
                    .ignoresSafeArea(edges: .bottom)
            )
            .accessibilityElement(children: .contain)
            .accessibilityAddTraits(.isModal)
            .accessibilityLabel(L("conversation.outline.title"))
        }
        .transition(.opacity)
    }

    private var header: some View {
        HStack(spacing: 8) {
            Text(L("conversation.outline.title")).webText(16, 600).foregroundStyle(AppTheme.textPrimary)
            Text(L("conversation.outline.turns", ["count": items.count])).webText(16).foregroundStyle(AppTheme.textMuted)
            Spacer(minLength: 0)
            Button(action: onClose) {
                WebIcon(name: "close", size: 16, color: AppTheme.textPrimary)
                    .frame(width: 36, height: 36)
                    .background(Color(.sRGB, red: 127 / 255, green: 127 / 255, blue: 127 / 255, opacity: 0.18))
                    .clipShape(Circle())
            }
            .buttonStyle(WebPressStyle())
            .accessibilityLabel(L("conversation.outline.close"))
            .accessibilityIdentifier("outline-sheet-close")
        }
        .padding(.leading, 10)
        .padding(.trailing, 4)
        .frame(minHeight: 44)
    }

    private func row(_ item: OutlineItem) -> some View {
        let isCurrent = item.id == currentId
        return Button {
            onSelect(item.id)
            onClose()
        } label: {
            HStack(alignment: .top, spacing: 10) {
                Text("\(item.number)")
                    .webText(11, 500)
                    .foregroundStyle(isCurrent ? .white : AppTheme.textMuted)
                    .frame(width: 20, height: 20)
                    .background(isCurrent ? AppTheme.buttonPrimary : AppTheme.backgroundTertiary)
                    .clipShape(Circle())
                    .padding(.top, 1)
                VStack(alignment: .leading, spacing: 2) {
                    WebTruncatedLine(item.prompt)
                        .webText(14.5, lineHeight: 19.575)
                        .foregroundStyle(AppTheme.textPrimary)
                    if !item.meta.isEmpty || item.isGenerating {
                        HStack(spacing: 6) {
                            if item.isGenerating { PulseDot(size: 8, color: AppTheme.primary) }
                            WebTruncatedLine(item.meta)
                                .webText(11.5)
                                .foregroundStyle(AppTheme.textMuted)
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .frame(minHeight: 52, alignment: .top)
            .background(isCurrent ? AppTheme.backgroundSelected : Color.clear)
            .clipShape(RoundedRectangle(cornerRadius: DSRadius.md))
            .contentShape(Rectangle())
        }
        .buttonStyle(WebPressStyle())
        .accessibilityIdentifier("outline-row-\(item.id)")
        .accessibilityAddTraits(isCurrent ? .isSelected : [])
    }
}
