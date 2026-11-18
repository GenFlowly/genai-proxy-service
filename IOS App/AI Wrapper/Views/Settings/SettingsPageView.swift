import SwiftUI

// MARK: - Page frame (SettingsPage.tsx + SettingsFrame.tsx at phone width)

/// What the current settings page tells the shell's header: its status for the subtitle and
/// its knowledge cards for the info drawer.
struct SettingsHeaderInfo: Equatable {
    var statusText: String?
    var knowledge: [KnowledgeItem] = []
}

struct SettingsHeaderKey: PreferenceKey {
    static let defaultValue = SettingsHeaderInfo()
    static func reduce(value: inout SettingsHeaderInfo, nextValue: () -> SettingsHeaderInfo) {
        let next = nextValue()
        if next.statusText != nil || !next.knowledge.isEmpty { value = next }
    }
}

/// A dialog a settings page raises, shown by the frame over the whole screen (a page's content
/// scrolls, and WebModal fills only the space it's placed in).
struct SettingsPageDialog {
    let view: AnyView
}

struct SettingsDialogKey: PreferenceKey {
    static var defaultValue: SettingsPageDialog? { nil }
    static func reduce(value: inout SettingsPageDialog?, nextValue: () -> SettingsPageDialog?) { value = value ?? nextValue() }
}

extension View {
    /// Shows `dialog` over the settings page while `isPresented`.
    func settingsDialog<Dialog: View>(isPresented: Bool, @ViewBuilder _ dialog: () -> Dialog) -> some View {
        let view = isPresented ? AnyView(dialog()) : nil
        return transformPreference(SettingsDialogKey.self) { value in
            if let view, value == nil { value = SettingsPageDialog(view: view) }
        }
    }

    /// A settings page's status (header subtitle) and knowledge cards (info drawer).
    func settingsPage(status: String? = nil, knowledge: [KnowledgeItem] = []) -> some View {
        preference(key: SettingsHeaderKey.self, value: SettingsHeaderInfo(statusText: status, knowledge: knowledge))
    }
}

/// A settings page below isNarrow: the MobileHeader names the page with "Section · status"
/// under it, its hamburger opens the Settings menu, and its ⓘ (or a swipe in from the right
/// edge) opens the page's knowledge cards in a drawer from the left. The page is one scroller
/// with 8pt gutters and 12pt between cards.
struct SettingsSectionPageView: View {
    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var router: AppRouter
    let section: AppRouter.SettingsSection

    @StateObject private var dialogs = SettingsDialogCenter()
    @State private var header = SettingsHeaderInfo()
    @State private var infoOpen = false

    private var canOpenInfo: Bool { !header.knowledge.isEmpty }

    private var subtitle: String {
        [SettingsNav.sectionLabel(section), header.statusText].compactMap { $0 }.joined(separator: " · ")
    }

    var body: some View {
        ZStack(alignment: .top) {
            Group {
                if auth.isAuthenticated {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 12) { content }
                            .padding(.horizontal, 8)
                            .padding(.top, mobileHeaderHeight + 8)
                            .padding(.bottom, 20)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .scrollDismissesKeyboard(.interactively)
                } else {
                    LoginRequiredView()
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)

            MobileHeader(
                title: SettingsNav.title(section),
                trailingAction: canOpenInfo
                    ? MobileHeaderTrailingAction(icon: "info", label: L("settingsPage.frame.aboutTitle"), identifier: "settings-info-button") { infoOpen = true }
                    : nil,
                onMenuClick: router.openPageMenu
            ) {
                Text(subtitle)
            }

            InfoDrawer(isOpen: infoOpen, subtitle: SettingsNav.title(section), items: header.knowledge) { infoOpen = false }
        }
        .statusBarBand()
        .background(AppTheme.background)
        .rightEdgeSwipe(canOpenInfo && !infoOpen ? { infoOpen = true } : nil)
        .onPreferenceChange(SettingsHeaderKey.self) { header = $0 }
        .onChange(of: section) { _, _ in infoOpen = false }
        #if DEBUG
        // Headless capture: `--settings-info` opens the info drawer.
        .onAppear { if CommandLine.arguments.contains("--settings-info") { infoOpen = true } }
        #endif
        .overlayPreferenceValue(SettingsDialogKey.self) { dialog in
            if let dialog { dialog.view }
        }
        .overlay { SettingsDialogOverlay() }
        .environmentObject(dialogs)
    }

    @ViewBuilder
    private var content: some View {
        switch section {
        case .account: AccountSettingsView()
        case .privacy: PrivacySettingsView()
        case .blocked: BlockedUsersSettingsView()
        case .deleteData: DeleteDataSettingsView()
        case .llmKeys: AISettingsView()
        case .embeddingKeys: EmbeddingKeysSettingsView()
        case .vectorDb: VectorDBSettingsView()
        case .webSearchKey: WebSearchKeySettingsView()
        case .agents: DefaultsSettingsView()
        case .memory: MemorySettingsView()
        case .searchIndex: SearchIndexSettingsView()
        case .embeddingModels: EmbeddingModelsSettingsView()
        case .usageLlm: LlmUsageSettingsView()
        case .usageEmbedding: EmbeddingUsageSettingsView()
        case .usageVectorDb: VectorDbUsageSettingsView()
        case .usageWebSearch: WebSearchUsageSettingsView()
        case .developer: DeveloperSettingsView()
        case .tools: ToolsSettingsView()
        case .connectors: ConnectorsSettingsView()
        }
    }
}

// MARK: - Menu (SettingsSidebar.tsx, phone menu)

/// The Settings menu: a card with the grouped sections (a section opens in place; its pages
/// navigate), then a card with Support, the privacy policy and Logout. Searching lists the
/// matching pages, a section's name matching all of its pages.
struct SettingsSidebar: View {
    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var router: AppRouter
    let onNavigate: () -> Void

    /// Manual open/close choices; absent = open while the current page is inside it.
    @State private var expandedOverride: [String: Bool] = [:]
    @State private var query = ""

    private struct SearchHit: Identifiable {
        let id: String
        let label: String
        let icon: String
        let action: () -> Void
    }

    private var activePage: AppRouter.SettingsSection? {
        if case .settings(let page) = router.route { return page }
        return nil
    }

    private var normalizedQuery: String { query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }

    private func contains(_ section: SettingsNavSection) -> Bool {
        section.pages.contains { $0.page == activePage } || (section.single != nil && section.single == activePage)
    }

    private func isExpanded(_ section: SettingsNavSection) -> Bool {
        !section.pages.isEmpty && (expandedOverride[section.key] ?? contains(section))
    }

    private func go(_ page: AppRouter.SettingsSection) {
        router.navigate(.settings(page))
        query = ""
        onNavigate()
    }

    private var searchHits: [SearchHit] {
        let matches = { (label: String) in label.lowercased().contains(normalizedQuery) }
        var hits: [SearchHit] = []
        for section in SettingsNav.sections {
            let sectionLabel = L(section.labelKey)
            if let single = section.single {
                if matches(sectionLabel) {
                    hits.append(SearchHit(id: section.key, label: sectionLabel, icon: section.icon) { go(single) })
                }
                continue
            }
            for page in section.pages where matches(L(page.labelKey)) || matches(sectionLabel) {
                hits.append(SearchHit(id: "\(section.key)-\(page.key)", label: L(page.labelKey), icon: section.icon) { go(page.page) })
            }
        }
        if matches(L("settingsPage.nav.support")) {
            hits.append(SearchHit(id: "support", label: L("settingsPage.nav.support"), icon: "chat-bubble") {
                router.navigate(.support)
                query = ""
                onNavigate()
            })
        }
        return hits
    }

    var body: some View {
        MobileMenuBody(searchText: $query, searchPlaceholder: L("layout.mobileMenu.searchSettings")) {
            VStack(spacing: 12) {
                SidebarWidget(variant: .menu, title: L("settingsPage.nav.title")) {
                    HuggingScrollView {
                        VStack(alignment: .leading, spacing: 2) {
                            if normalizedQuery.isEmpty {
                                ForEach(SettingsNav.sections) { section in
                                    sectionRows(section)
                                }
                            } else if searchHits.isEmpty {
                                Text(L("layout.mobileMenu.noSearchResults"))
                                    .webText(13.6)
                                    .foregroundStyle(AppTheme.textMuted)
                                    .padding(.vertical, 16)
                                    .padding(.horizontal, 8)
                                    .frame(maxWidth: .infinity)
                            } else {
                                ForEach(searchHits) { hit in
                                    itemButton(label: hit.label, icon: hit.icon, state: .plain, chevron: nil, identifier: "settings-search-hit-\(hit.id)", action: hit.action)
                                }
                            }
                        }
                        .padding(.horizontal, 4)
                        .padding(.bottom, 4)
                    }
                }
                .accessibilityElement(children: .contain)
                .accessibilityLabel(L("settingsPage.nav.title"))

                if normalizedQuery.isEmpty {
                    footerCard
                }
            }
        }
    }

    private enum RowState { case plain, sectionActive, active }

    @ViewBuilder
    private func sectionRows(_ section: SettingsNavSection) -> some View {
        if let single = section.single {
            itemButton(label: L(section.labelKey), icon: section.icon, state: activePage == single ? .active : .plain, chevron: nil, identifier: "settings-page-\(section.key)") {
                go(single)
            }
        } else {
            let expanded = isExpanded(section)
            VStack(alignment: .leading, spacing: 2) {
                itemButton(label: L(section.labelKey), icon: section.icon, state: contains(section) ? .sectionActive : .plain, chevron: expanded, identifier: "settings-section-\(section.key)") {
                    expandedOverride[section.key] = !expanded
                }
                .accessibilityAddTraits(expanded ? .isSelected : [])
                if expanded {
                    VStack(alignment: .leading, spacing: 2) {
                        ForEach(section.pages) { page in
                            childButton(page, sectionKey: section.key)
                        }
                    }
                    .padding(.leading, 8)
                    .overlay(alignment: .leading) { Rectangle().fill(AppTheme.sidebarHairline).frame(width: 1) }
                    .padding(.leading, 16)
                    .padding(.bottom, 4)
                }
            }
        }
    }

    private func itemButton(label: String, icon: String, state: RowState, chevron: Bool?, identifier: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 10) {
                WebIcon(name: icon, size: 18, color: state == .plain ? AppTheme.textMuted : AppTheme.primary)
                Text(label)
                    .sidebarRowText(.menu, active: state != .plain)
                    .lineLimit(1)
                Spacer(minLength: 0)
                if let chevron {
                    WebIcon(name: "alt-arrow-right", size: 14, color: AppTheme.textMuted)
                        .rotationEffect(.degrees(chevron ? 90 : 0))
                }
            }
            .padding(.leading, 8)
            .padding(.trailing, 10)
            .frame(minHeight: SidebarRowTokens.menu.minHeight)
            .sidebarRowFill(.menu, active: state == .active)
            .contentShape(Rectangle())
        }
        .buttonStyle(SidebarRowPressStyle(.menu))
        .accessibilityIdentifier(identifier)
    }

    private func childButton(_ page: SettingsNavPage, sectionKey: String) -> some View {
        let active = page.page == activePage
        return Button { go(page.page) } label: {
            Text(L(page.labelKey))
                .sidebarRowText(.menu, active: active)
                .lineLimit(1)
                .padding(.leading, 12)
                .padding(.trailing, 10)
                .frame(minHeight: SidebarRowTokens.menu.childMinHeight)
                .frame(maxWidth: .infinity, alignment: .leading)
                .sidebarRowFill(.menu, active: active)
                .contentShape(Rectangle())
        }
        .buttonStyle(SidebarRowPressStyle(.menu))
        .accessibilityIdentifier("settings-page-\(sectionKey)-\(page.key)")
        .accessibilityAddTraits(active ? .isSelected : [])
    }

    private var footerCard: some View {
        SidebarWidget(variant: .custom, surface: .sidebar) {
            footerLinks
        }
    }

    private var footerLinks: some View {
        VStack(spacing: 0) {
            footerLink(L("settingsPage.nav.support"), identifier: "settings-menu-support") {
                router.navigate(.support)
                onNavigate()
            }
            footerLink(L("settingsPage.nav.privacyPolicy"), identifier: "settings-menu-privacy-policy") {
                router.navigate(.privacyPolicy)
                onNavigate()
            }
            Rectangle()
                .fill(AppTheme.sidebarHairline)
                .frame(height: 1)
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
            Button {
                onNavigate()
                auth.logout()
                router.navigate(.chat)
            } label: {
                HStack(spacing: 10) {
                    WebIcon(name: "logout", size: 18, color: AppTheme.error)
                    Text(L("settingsPage.nav.logout"))
                        .webText(arial: 15)
                        .foregroundStyle(AppTheme.error)
                    Spacer(minLength: 0)
                }
                .padding(.leading, 8)
                .padding(.trailing, 10)
                .frame(minHeight: 48)
                .contentShape(Rectangle())
            }
            .buttonStyle(RowPressStyle())
            .accessibilityIdentifier("settings-menu-logout")
        }
        .padding(4)
    }

    private func footerLink(_ label: String, identifier: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Text(label)
                    .webText(arial: 15)
                    .foregroundStyle(AppTheme.textPrimary)
                Spacer(minLength: 0)
                WebIcon(name: "alt-arrow-right", size: 16, color: AppTheme.textMuted)
            }
            .padding(.leading, 8)
            .padding(.trailing, 10)
            .frame(minHeight: 48)
            .contentShape(Rectangle())
        }
        .buttonStyle(RowPressStyle())
        .accessibilityIdentifier(identifier)
    }
}
