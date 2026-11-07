import SwiftUI

// MARK: - Word diff (utils/wordDiff.ts)

struct DiffPart: Equatable {
    enum Kind { case same, ins, del }
    var text: String
    var kind: Kind
}

enum WordDiff {
    // Past this many token pairs the table is too big to build on every render; the diff
    // falls back to one changed block between the common start and end.
    private static let maxCells = 400_000
    private static let punctuation: Set<Character> = [".", ",", ";", ":", "!", "?", "(", ")", "[", "]", "\"", "“", "”", "'", "‘", "’"]

    /// Words, runs of spaces and punctuation marks, in order.
    static func tokens(_ text: String) -> [String] {
        var tokens: [String] = []
        var current = ""
        var currentIsSpace = false
        for character in text {
            if punctuation.contains(character) {
                if !current.isEmpty { tokens.append(current); current = "" }
                tokens.append(String(character))
                continue
            }
            let isSpace = character.isWhitespace
            if !current.isEmpty && isSpace != currentIsSpace {
                tokens.append(current)
                current = ""
            }
            current.append(character)
            currentIsSpace = isSpace
        }
        if !current.isEmpty { tokens.append(current) }
        return tokens
    }

    private static func push(_ parts: inout [DiffPart], _ text: String, _ kind: DiffPart.Kind) {
        guard !text.isEmpty else { return }
        if let last = parts.last, last.kind == kind {
            parts[parts.count - 1].text += text
        } else {
            parts.append(DiffPart(text: text, kind: kind))
        }
    }

    private static func edgeDiff(_ before: String, _ after: String) -> [DiffPart] {
        let a = Array(before), b = Array(after)
        var start = 0
        while start < a.count && start < b.count && a[start] == b[start] { start += 1 }
        var end = 0
        while end < a.count - start && end < b.count - start && a[a.count - 1 - end] == b[b.count - 1 - end] { end += 1 }
        var parts: [DiffPart] = []
        push(&parts, String(a[0..<start]), .same)
        push(&parts, String(a[start..<(a.count - end)]), .del)
        push(&parts, String(b[start..<(b.count - end)]), .ins)
        push(&parts, String(a[(a.count - end)...]), .same)
        return parts
    }

    /// The words removed from [before] and added in [after], in reading order.
    static func diff(_ before: String, _ after: String) -> [DiffPart] {
        let a = tokens(before), b = tokens(after)
        if a.count * b.count > maxCells { return edgeDiff(before, after) }
        var lcs = Array(repeating: Array(repeating: 0, count: b.count + 1), count: a.count + 1)
        if !a.isEmpty && !b.isEmpty {
            for i in stride(from: a.count - 1, through: 0, by: -1) {
                for j in stride(from: b.count - 1, through: 0, by: -1) {
                    lcs[i][j] = a[i] == b[j] ? lcs[i + 1][j + 1] + 1 : max(lcs[i + 1][j], lcs[i][j + 1])
                }
            }
        }
        var parts: [DiffPart] = []
        var i = 0, j = 0
        while i < a.count && j < b.count {
            if a[i] == b[j] {
                push(&parts, a[i], .same); i += 1; j += 1
            } else if lcs[i + 1][j] >= lcs[i][j + 1] {
                push(&parts, a[i], .del); i += 1
            } else {
                push(&parts, b[j], .ins); j += 1
            }
        }
        while i < a.count { push(&parts, a[i], .del); i += 1 }
        while j < b.count { push(&parts, b[j], .ins); j += 1 }
        return trimChanges(parts)
    }

    /// Moves the spaces at either end of a change out of it, so only words are highlighted.
    private static func trimChanges(_ parts: [DiffPart]) -> [DiffPart] {
        var out: [DiffPart] = []
        for part in parts {
            guard part.kind != .same else { push(&out, part.text, .same); continue }
            let lead = String(part.text.prefix { $0.isWhitespace })
            let rest = part.text.dropFirst(lead.count)
            let tail = String(rest.reversed().prefix { $0.isWhitespace }.reversed())
            push(&out, lead, .same)
            push(&out, String(rest.dropLast(tail.count)), part.kind)
            push(&out, tail, .same)
        }
        return out
    }

    // Unchanged runs longer than this, in tokens, are shortened to their ends.
    private static let context = 12

    /// Long unchanged runs shortened to the words next to each change.
    static func condense(_ parts: [DiffPart]) -> [DiffPart] {
        parts.enumerated().map { index, part in
            guard part.kind == .same else { return part }
            let words = tokens(part.text)
            guard words.count > context * 2 else { return part }
            let head = index == 0 ? "" : words.prefix(context).joined()
            let tail = index == parts.count - 1 ? "" : words.suffix(context).joined()
            return DiffPart(text: "\(head)…\(tail)", kind: .same)
        }
    }
}

/// [after] with the words added since [before] highlighted and the removed ones struck through.
struct DiffText: View {
    let before: String
    let after: String
    var short = false
    var size: CGFloat = 14.5

    var body: some View {
        Text(attributed)
            .webText(size, lineHeight: size * 1.55)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var attributed: AttributedString {
        let parts = short ? WordDiff.condense(WordDiff.diff(before, after)) : WordDiff.diff(before, after)
        var result = AttributedString()
        for (index, part) in parts.enumerated() {
            // A replaced word sits right against its replacement; keep them apart on screen.
            if part.kind == .ins, index > 0, parts[index - 1].kind == .del { result += AttributedString(" ") }
            var piece = AttributedString(part.text)
            switch part.kind {
            case .same:
                piece.foregroundColor = AppTheme.textSecondary
            case .ins:
                piece.foregroundColor = AppTheme.textPrimary
                piece.backgroundColor = AppTheme.primary.opacity(0.28)
            case .del:
                piece.foregroundColor = AppTheme.textMuted
                piece.strikethroughStyle = .single
            }
            result += piece
        }
        return result
    }
}

// MARK: - Page frame

/// The detail pages' frame: the floating header over scrolling content.
struct DetailScaffold<Content: View>: View {
    let title: String
    var subtitle: String?
    var menuItems: [MobileHeaderMenuItem] = []
    /// Set on child pages: the header's left button goes back.
    var backLabel: String?
    let onLeading: () -> Void
    /// Edit pages: Cancel and Save, pinned above the keyboard.
    var actions: AnyView?
    @ViewBuilder var content: Content

    var body: some View {
        ZStack(alignment: .top) {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) { content }
                    .padding(.horizontal, 16)
                    .padding(.top, mobileHeaderHeight + 12)
                    .padding(.bottom, 40)
            }
            .scrollDismissesKeyboard(.interactively)
            .safeAreaInset(edge: .bottom, spacing: 0) {
                if let actions {
                    VStack(spacing: 0) {
                        Rectangle().fill(AppTheme.borderLight).frame(height: 1)
                        actions.padding(.horizontal, 16).padding(.vertical, 12)
                    }
                    .background(AppTheme.background)
                }
            }

            if let subtitle {
                MobileHeader(title: title, menuItems: menuItems, backLabel: backLabel, onMenuClick: onLeading) {
                    Text(subtitle)
                }
            } else {
                MobileHeader(title: title, menuItems: menuItems, backLabel: backLabel, onMenuClick: onLeading)
            }
        }
        .statusBarBand()
        .background(AppTheme.background)
    }
}

/// The text card at the top of a detail page.
struct DetailCard<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 14) { content }
            .padding(20)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(AppTheme.backgroundSecondary)
            .clipShape(RoundedRectangle(cornerRadius: 18))
            .overlay(RoundedRectangle(cornerRadius: 18).strokeBorder(AppTheme.borderLight, lineWidth: 1))
    }
}

/// The card's footer: what version is on screen, and its one action.
struct DetailCardFoot: View {
    let note: String
    let actionLabel: String?
    var primary = false
    var actionId = "detail-edit"
    let action: () -> Void

    var body: some View {
        VStack(spacing: 14) {
            Rectangle().fill(AppTheme.borderLight).frame(height: 1)
            HStack(spacing: 12) {
                Text(note).webText(13, 600).foregroundStyle(AppTheme.textSecondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if let actionLabel {
                    PillButton(label: actionLabel, style: primary ? .primary : .secondary, minWidth: nil, action: action)
                        .fixedSize(horizontal: true, vertical: false)
                        .accessibilityIdentifier(actionId)
                }
            }
        }
    }
}

struct DetailChip: View {
    let text: String
    var accent = false

    var body: some View {
        Text(text)
            .webText(12, accent ? 600 : 500)
            .foregroundStyle(accent ? AppTheme.primary : AppTheme.textSecondary)
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(accent ? AppTheme.backgroundSelected : AppTheme.backgroundTertiary)
            .clipShape(Capsule())
    }
}

/// A note above the card, e.g. "This is version 1", with an optional link.
struct DetailBanner: View {
    let text: String
    var linkLabel: String?
    var onLink: (() -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(text).webText(14, lineHeight: 20).foregroundStyle(AppTheme.textPrimary)
            if let linkLabel, let onLink {
                Button(action: onLink) {
                    Text(linkLabel).webText(14, 600).foregroundStyle(AppTheme.primary)
                }
                .buttonStyle(WebPressStyle())
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(AppTheme.backgroundSelected)
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("detail-banner")
    }
}

// MARK: - Rows

struct DetailRowItem: Identifiable {
    let id: String
    let icon: String
    var accent = false
    let title: String
    let summary: String
    var action: (() -> Void)?
}

/// The short list under the text card. Each row opens its own page or dialog.
struct DetailRowsView: View {
    let rows: [DetailRowItem]

    var body: some View {
        VStack(spacing: 0) {
            ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                Button { row.action?() } label: {
                    HStack(spacing: 14) {
                        WebIcon(name: row.icon, size: 19, color: row.accent ? AppTheme.primary : AppTheme.textSecondary)
                            .frame(width: 36, height: 36)
                            .background(row.accent ? AppTheme.backgroundSelected : AppTheme.backgroundTertiary)
                            .clipShape(RoundedRectangle(cornerRadius: 10))
                        VStack(alignment: .leading, spacing: 2) {
                            Text(row.title).webText(15.5, 600).foregroundStyle(AppTheme.textPrimary)
                            WebTruncatedLine(row.summary).webText(13).foregroundStyle(AppTheme.textMuted)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        if row.action != nil {
                            WebIcon(name: "alt-arrow-right", size: 16, color: AppTheme.textMuted)
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
                    .frame(minHeight: 64)
                    .contentShape(Rectangle())
                }
                .buttonStyle(RowPressStyle())
                .disabled(row.action == nil)
                .accessibilityIdentifier("detail-row-\(row.id)")
                if index < rows.count - 1 {
                    Rectangle().fill(AppTheme.borderLight).frame(height: 1)
                }
            }
        }
        .background(AppTheme.backgroundSecondary)
        .clipShape(RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(AppTheme.borderLight, lineWidth: 1))
    }
}

// MARK: - Timeline

struct TimelineFact: Identifiable {
    enum Value {
        case text(String)
        case diff(before: String, after: String, short: Bool)
    }
    let label: String
    let value: Value
    var id: String { label }
}

struct TimelineEntryItem: Identifiable {
    let id: String
    let title: String
    var badge: String?
    var current = false
    let date: String
    var conversation: (id: String, title: String?, available: Bool)?
    var facts: [TimelineFact] = []
    var move: (from: String, to: String)?
    var view: (label: String, action: () -> Void)?
}

/// A vertical history, newest first.
struct TimelineView: View {
    let entries: [TimelineEntryItem]
    let untitled: String
    let deleted: String
    let onOpenConversation: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(entries.enumerated()), id: \.element.id) { index, entry in
                HStack(alignment: .top, spacing: 14) {
                    VStack(spacing: 6) {
                        Circle()
                            .fill(entry.current ? AppTheme.primary : Color.clear)
                            .overlay(Circle().strokeBorder(entry.current ? AppTheme.primary : AppTheme.border, lineWidth: 2))
                            .frame(width: 10, height: 10)
                            .padding(.top, 6)
                        if index < entries.count - 1 {
                            Rectangle().fill(AppTheme.borderLight).frame(width: 2).frame(maxHeight: .infinity)
                        }
                    }
                    .frame(width: 14)
                    body(of: entry)
                        .padding(.bottom, index < entries.count - 1 ? 24 : 4)
                }
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("timeline-\(entry.id)")
            }
        }
        .padding(.leading, 4)
        .accessibilityIdentifier("detail-timeline")
    }

    private func body(of entry: TimelineEntryItem) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            FlowLayout(spacing: 8) {
                Text(entry.title).webText(15.5, 600).foregroundStyle(AppTheme.textPrimary)
                if let badge = entry.badge {
                    Text(badge)
                        .webText(12, 600)
                        .foregroundStyle(entry.current ? AppTheme.primary : AppTheme.textSecondary)
                        .padding(.horizontal, 7)
                        .padding(.vertical, 2)
                        .background(entry.current ? AppTheme.backgroundSelected : AppTheme.backgroundTertiary)
                        .clipShape(RoundedRectangle(cornerRadius: 5))
                }
                Text(entry.date).webText(12.5).foregroundStyle(AppTheme.textMuted)
            }
            if let conversation = entry.conversation {
                if conversation.available {
                    Button { onOpenConversation(conversation.id) } label: {
                        HStack(spacing: 8) {
                            WebIcon(name: "chat-bubble", size: 16, color: AppTheme.textMuted)
                            WebTruncatedLine(conversation.title?.isEmpty == false ? conversation.title! : untitled)
                                .webText(14, 500)
                                .foregroundStyle(AppTheme.textPrimary)
                        }
                        .padding(.horizontal, 12)
                        .frame(minHeight: 40)
                        .background(AppTheme.backgroundSecondary)
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(AppTheme.borderLight, lineWidth: 1))
                    }
                    .buttonStyle(WebPressStyle())
                } else {
                    Text(deleted).webText(14).foregroundStyle(AppTheme.textMuted)
                }
            }
            ForEach(entry.facts) { fact in
                HStack(alignment: .firstTextBaseline, spacing: 12) {
                    Text(fact.label.uppercased())
                        .webText(arial: 11, bold: true)
                        .kerning(0.66)
                        .foregroundStyle(AppTheme.textMuted)
                        .frame(width: 72, alignment: .leading)
                    switch fact.value {
                    case .text(let text):
                        Text(text).webText(14.5, lineHeight: 22).foregroundStyle(AppTheme.textSecondary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    case .diff(let before, let after, let short):
                        DiffText(before: before, after: after, short: short)
                    }
                }
            }
            if let move = entry.move {
                FlowLayout(spacing: 8) {
                    Text(move.from).webText(13).strikethrough().foregroundStyle(AppTheme.textMuted)
                        .padding(.horizontal, 10).padding(.vertical, 5)
                        .background(AppTheme.backgroundTertiary).clipShape(Capsule())
                    Text("→").webText(13).foregroundStyle(AppTheme.textMuted)
                    DetailChip(text: move.to, accent: true)
                }
            }
            if let view = entry.view {
                Button(action: view.action) {
                    HStack(spacing: 4) {
                        Text(view.label).webText(14.5, 500).foregroundStyle(AppTheme.textSecondary)
                        WebIcon(name: "alt-arrow-right", size: 14, color: AppTheme.textMuted)
                    }
                    .frame(minHeight: 40)
                }
                .buttonStyle(WebPressStyle())
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - Conversations

struct ConversationItem: Identifiable {
    let id: String
    var title: String?
    var available = true
    var meta: String?
}

/// Conversations, each opening in Chat; deleted ones are greyed out.
struct ConversationListView: View {
    let items: [ConversationItem]
    let untitled: String
    let deleted: String
    let onOpen: (String) -> Void

    var body: some View {
        VStack(spacing: 0) {
            ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                Button { onOpen(item.id) } label: {
                    HStack(spacing: 14) {
                        WebIcon(name: "chat-bubble", size: 18, color: item.available ? AppTheme.textSecondary : AppTheme.textMuted)
                            .frame(width: 36, height: 36)
                            .background(AppTheme.backgroundTertiary)
                            .clipShape(RoundedRectangle(cornerRadius: 10))
                        VStack(alignment: .leading, spacing: 2) {
                            WebTruncatedLine(item.available ? (item.title?.isEmpty == false ? item.title! : untitled) : deleted)
                                .webText(15.5, item.available ? 600 : 500)
                                .foregroundStyle(item.available ? AppTheme.textPrimary : AppTheme.textMuted)
                            if let meta = item.meta {
                                Text(meta).webText(13).foregroundStyle(AppTheme.textMuted)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        if item.available { WebIcon(name: "alt-arrow-right", size: 16, color: AppTheme.textMuted) }
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
                    .frame(minHeight: 64)
                    .contentShape(Rectangle())
                }
                .buttonStyle(RowPressStyle())
                .disabled(!item.available)
                if index < items.count - 1 {
                    Rectangle().fill(AppTheme.borderLight).frame(height: 1)
                }
            }
        }
        .background(AppTheme.backgroundSecondary)
        .clipShape(RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(AppTheme.borderLight, lineWidth: 1))
        .accessibilityIdentifier("detail-conversations")
    }
}

struct DetailIntro: View {
    let text: String

    var body: some View {
        Text(text).webText(13.5, lineHeight: 19.5).foregroundStyle(AppTheme.textMuted).padding(.horizontal, 4)
    }
}
