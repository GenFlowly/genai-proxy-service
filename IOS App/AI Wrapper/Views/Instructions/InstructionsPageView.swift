import SwiftUI

/// InstructionsPage on a phone: transparent MobileHeader (Create in its kebab) over a
/// full-screen scroller with the search box and one column of tiles.
struct InstructionsPageView: View {
    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var router: AppRouter

    @State private var search = ""

    /// Only the latest version of each instruction.
    private var latest: [InstructionResponse] {
        var seen: [String: Int] = [:]
        var order: [InstructionResponse] = []
        for instruction in auth.customerInstructions {
            if let index = seen[instruction.id] {
                if instruction.version > order[index].version { order[index] = instruction }
            } else {
                seen[instruction.id] = order.count
                order.append(instruction)
            }
        }
        return order
    }

    /// Client-side search over name and instruction text.
    private var visible: [InstructionResponse] {
        let query = search.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !query.isEmpty else { return latest }
        return latest.filter { $0.name.lowercased().contains(query) || $0.instruction.lowercased().contains(query) }
    }

    var body: some View {
        PageScaffold(
            title: L("instructionsPage.instructionsPage.title"),
            menuItems: [MobileHeaderMenuItem(label: L("instructionsPage.instructionsPage.createInstruction")) { router.navigate(.instructionEdit(nil)) }]
        ) {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    if !latest.isEmpty {
                        InputTextWithHint(placeholder: L("instructionsPage.instructionsPage.searchPlaceholder"), text: $search)
                            .padding(.bottom, 24)
                    }
                    if latest.isEmpty {
                        emptyState(L("instructionsPage.instructionsPage.emptyState"))
                    } else if visible.isEmpty {
                        emptyState(L("instructionsPage.instructionsPage.noSearchResults"))
                    } else {
                        LazyVStack(spacing: 24) {
                            ForEach(visible) { instruction in
                                Button {
                                    router.navigate(.instructionDetail(instruction.id))
                                } label: {
                                    InstructionTileView(
                                        instruction: instruction,
                                        // The list only knows the creator of the user's own.
                                        owner: instruction.role == "OWNER" ? auth.customerPicture ?? "" : nil
                                    )
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }
                }
                .padding(.horizontal, 16)
                .padding(.top, mobileHeaderHeight)
                .padding(.bottom, 16)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .scrollDismissesKeyboard(.interactively)
            .background(AppTheme.background)
        }
        // Onboard also writes the list, in its own order; the refresh has to land after it.
        .task(id: auth.isOnboarding) {
            if !auth.isOnboarding { await auth.refreshInstructions() }
        }
    }

    private func emptyState(_ text: String) -> some View {
        Text(text)
            .webText(17.6)
            .foregroundStyle(AppTheme.textMuted)
            .multilineTextAlignment(.center)
            .frame(maxWidth: .infinity)
            .frame(height: 300)
            .background(AppTheme.backgroundSecondary)
            .clipShape(RoundedRectangle(cornerRadius: 12))
            .overlay(WebDashedBorder(color: AppTheme.border, cornerRadius: 12))
    }
}

/// InstructionTile (component library): color accent, icon + title, 140-character preview,
/// tag chips, and a footer with the owner's avatar and version badge.
struct InstructionTileView: View {
    let instruction: InstructionResponse
    /// The creator's avatar URL ("" = fallback icon); nil omits the avatar.
    var owner: String?

    private static let previewLength = 140

    /// Cut first, then collapse: HTML renders the raw text's newlines as single spaces.
    private var preview: String {
        let text = instruction.instruction
        let cut = text.count > Self.previewLength ? String(text.prefix(Self.previewLength)) + "…" : text
        return cut.split(whereSeparator: \.isWhitespace).joined(separator: " ")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 9.6) {
                if let icon = instruction.icon, !icon.isEmpty {
                    EmojiIcon(text: icon)
                }
                WebTruncatedLine(instruction.name.isEmpty ? L("common.instructionTile.untitledInstruction") : instruction.name)
                    .webText(17.6, 600)
                    .foregroundStyle(AppTheme.textPrimary)
            }

            Text(preview)
                .webText(14.4, lineHeight: 21.6)
                .foregroundStyle(AppTheme.textMuted)
                .multilineTextAlignment(.leading)
                .frame(maxWidth: .infinity, alignment: .leading)

            if let tags = instruction.tags, !tags.isEmpty {
                FlowLayout(spacing: 4.8) {
                    ForEach(tags, id: \.self) { tag in
                        WebTruncatedLine("#\(tag)")
                            .webText(12, 500)
                            .foregroundStyle(AppTheme.textMuted)
                            .padding(.horizontal, 9.6)
                            .padding(.vertical, 2.4)
                            .background(AppTheme.backgroundTertiary)
                            .clipShape(Capsule())
                    }
                }
            }

            // `margin-top: auto`: pinned to the bottom of a tile taller than its content.
            HStack {
                if let owner {
                    AvatarImage(picture: owner.isEmpty ? nil : owner, size: 24, placeholderColor: AppTheme.textMuted)
                }
                Spacer(minLength: 0)
                Text("v\(instruction.version)")
                    .webText(12, 500)
                    .foregroundStyle(AppTheme.textMuted)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(AppTheme.backgroundTertiary)
                    .clipShape(RoundedRectangle(cornerRadius: DSRadius.sm))
            }
            .frame(maxHeight: .infinity, alignment: .bottom)
        }
        .padding(25)
        .frame(maxWidth: .infinity, minHeight: 180, alignment: .leading)
        .background(AppTheme.backgroundSecondary)
        .overlay(alignment: .top) {
            Rectangle()
                .fill(instruction.color.flatMap { $0.isEmpty ? nil : Color(hex: $0) } ?? AppTheme.primary)
                .frame(height: 4)
        }
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(AppTheme.border, lineWidth: 1))
        .contentShape(RoundedRectangle(cornerRadius: 12))
    }
}

/// An instruction's emoji run. Chrome's advance for the color emoji font isn't proportional to
/// the size (22pt at 20, 15pt at 12) and differs from CoreText's, so each glyph gets its own cell.
struct EmojiIcon: View {
    let text: String
    var size: CGFloat = 20
    var advance: CGFloat = 22
    var lineHeight: CGFloat = 20

    var body: some View {
        HStack(spacing: 0) {
            ForEach(Array(text.enumerated()), id: \.offset) { _, glyph in
                Text(String(glyph))
                    .font(.system(size: size))
                    .lineHeight(nil)
                    .textRenderer(PlainTextRenderer())
                    .fixedSize()
                    .frame(width: advance, height: lineHeight, alignment: .leading)
            }
        }
    }
}

/// InstructionPickerModal.tsx: debounced server-side search + recently used tiles.
struct InstructionPickerModal: View {
    @Environment(\.windowHeight) private var windowHeight
    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var router: AppRouter
    var onClose: () -> Void = {}
    let onSelect: (InstructionResponse) -> Void

    @State private var query = ""
    @State private var recent: [InstructionResponse] = []
    @State private var results: [InstructionResponse] = []
    @State private var isLoading = false
    @State private var hasError = false
    @State private var setupError: SearchSetupReason?
    @State private var searchTask: Task<Void, Never>?
    @State private var tilesHeight: CGFloat = 0

    /// `max-height: 55vh`.
    private static let tilesMaxHeightFraction: CGFloat = 0.55

    private var isSearching: Bool { !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    private var shown: [InstructionResponse] { isSearching ? results : recent }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            InputTextWithHint(placeholder: L("conversation.instructionPicker.searchPlaceholder"), text: $query, autofocus: true)
                .onChange(of: query) { _, value in scheduleSearch(value) }

            Text((isSearching ? L("conversation.instructionPicker.searchResults") : L("conversation.instructionPicker.recentlyUsed")).uppercased())
                .webText(13.6, 600)
                .kerning(0.544)
                .foregroundStyle(AppTheme.textMuted)

            if isSearching && !auth.isAuthenticated {
                stateText(L("conversation.instructionPicker.signInToSearch"))
                    .accessibilityIdentifier("instruction-picker-sign-in")
            } else if isSearching, let setupError {
                notSetUp(setupError)
            } else if hasError {
                stateText(L("conversation.instructionPicker.error"))
            } else if isLoading && shown.isEmpty {
                stateText(L("conversation.instructionPicker.loading"))
            } else if shown.isEmpty {
                stateText(isSearching ? L("conversation.instructionPicker.noResults") : L("conversation.instructionPicker.noRecent"))
            } else {
                ScrollView {
                    VStack(spacing: 12) {
                        ForEach(shown) { instruction in
                            Button { onSelect(instruction) } label: {
                                InstructionTileView(instruction: instruction)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { tilesHeight = $0 }
                }
                .scrollBounceBehavior(.basedOnSize)
                .frame(maxHeight: min(tilesHeight, windowHeight * Self.tilesMaxHeightFraction))
            }
        }
        .task { await loadRecent() }
    }

    private func stateText(_ text: String) -> some View {
        Text(text).webText(14.4).foregroundStyle(AppTheme.textMuted)
    }

    private func notSetUp(_ reason: SearchSetupReason) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 5) {
            stateText(reason.message)
            Button {
                onClose()
                router.navigate(.settings(reason.settingsSection))
            } label: {
                Text(L("common.search.openSettings")).webText(14.4).foregroundStyle(AppTheme.primary)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("instruction-picker-open-settings")
        }
        .accessibilityIdentifier("instruction-picker-not-set-up")
    }

    /// Stale-while-revalidate: the last known list paints first, then refreshes.
    private func loadRecent() async {
        let key = auth.customerId.map { StorageSuffix.customerKey($0, StorageSuffix.recentInstructions) }
        let cached = key.flatMap { CacheStore.shared.read([InstructionResponse].self, key: $0) }
        if let cached { recent = cached }
        guard let token = try? await auth.getAccessTokenSilently() else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            let response = try await InstructionService.recentInstructions(token: token, limit: 3)
            recent = response
            if let key { CacheStore.shared.write(response, key: key) }
        } catch {
            if cached == nil { hasError = true }
        }
    }

    private func scheduleSearch(_ value: String) {
        searchTask?.cancel()
        let term = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !term.isEmpty else {
            hasError = false
            setupError = nil
            return
        }
        guard auth.isAuthenticated else { return }
        searchTask = Task {
            try? await Task.sleep(nanoseconds: 300_000_000)
            guard !Task.isCancelled, let token = try? await auth.getAccessTokenSilently() else { return }
            isLoading = true
            hasError = false
            setupError = nil
            defer { isLoading = false }
            do {
                let found = try await InstructionService.searchInstructions(token: token, query: term)
                if !Task.isCancelled { results = found }
            } catch {
                guard !Task.isCancelled else { return }
                if let reason = SearchSetupReason(error) { setupError = reason } else { hasError = true }
            }
        }
    }
}

/// Minimal wrapping layout (rows that wrap left-to-right).
struct FlowLayout: Layout {
    var spacing: CGFloat = 6
    /// Gap between rows; the item spacing when nil.
    var lineSpacing: CGFloat?

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let maxWidth = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, rowHeight: CGFloat = 0, widest: CGFloat = 0
        for subview in subviews {
            let size = fitted(subview, maxWidth: maxWidth)
            if x + size.width > maxWidth, x > 0 {
                x = 0
                y += rowHeight + (lineSpacing ?? spacing)
                rowHeight = 0
            }
            x += size.width + spacing
            widest = max(widest, x - spacing)
            rowHeight = max(rowHeight, size.height)
        }
        return CGSize(width: maxWidth == .infinity ? widest : maxWidth, height: y + rowHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, rowHeight: CGFloat = 0
        for subview in subviews {
            let size = fitted(subview, maxWidth: bounds.width)
            if x + size.width > bounds.maxX, x > bounds.minX {
                x = bounds.minX
                y += rowHeight + (lineSpacing ?? spacing)
                rowHeight = 0
            }
            subview.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
    }

    /// Natural size, wrapped to the row width when wider (long text pieces).
    private func fitted(_ subview: LayoutSubview, maxWidth: CGFloat) -> CGSize {
        let natural = subview.sizeThatFits(.unspecified)
        guard natural.width > maxWidth, maxWidth.isFinite else { return natural }
        return subview.sizeThatFits(ProposedViewSize(width: maxWidth, height: nil))
    }
}
