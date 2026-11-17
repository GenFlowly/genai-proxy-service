import Foundation

/// One Settings page in the menu (settingsNav.ts).
struct SettingsNavPage: Identifiable {
    let page: AppRouter.SettingsSection
    let key: String
    let labelKey: String
    var id: String { key }
}

/// A menu section: its pages, or a single page of its own (Developer).
struct SettingsNavSection: Identifiable {
    let key: String
    let labelKey: String
    let icon: String
    var pages: [SettingsNavPage] = []
    var single: AppRouter.SettingsSection?
    var id: String { key }
}

/// The Settings menu (settingsNav.ts): grouped sections with their pages. Tools and
/// Connectors keep their pages but aren't listed; Support and the privacy policy live only
/// in the menu's footer card.
enum SettingsNav {
    static let sections: [SettingsNavSection] = [
        SettingsNavSection(key: "profile", labelKey: "settingsPage.nav.profile", icon: "user-circle", pages: [
            SettingsNavPage(page: .account, key: "account", labelKey: "settingsPage.nav.account"),
            SettingsNavPage(page: .privacy, key: "privacy", labelKey: "settingsPage.nav.privacy"),
            SettingsNavPage(page: .blocked, key: "blocked", labelKey: "settingsPage.nav.blockedUsers"),
            SettingsNavPage(page: .deleteData, key: "delete", labelKey: "settingsPage.nav.deleteData")
        ]),
        SettingsNavSection(key: "byok", labelKey: "settingsPage.nav.byok", icon: "models", pages: [
            SettingsNavPage(page: .llmKeys, key: "llm-keys", labelKey: "settingsPage.nav.llmKeys"),
            SettingsNavPage(page: .embeddingKeys, key: "embedding-keys", labelKey: "settingsPage.nav.embeddingKeys"),
            SettingsNavPage(page: .vectorDb, key: "vector-db", labelKey: "settingsPage.nav.vectorDb"),
            SettingsNavPage(page: .webSearchKey, key: "web-search", labelKey: "settingsPage.nav.webSearchKey")
        ]),
        SettingsNavSection(key: "defaults", labelKey: "settingsPage.nav.defaults", icon: "prompt-icon", pages: [
            SettingsNavPage(page: .agents, key: "agents", labelKey: "settingsPage.nav.agents"),
            SettingsNavPage(page: .memory, key: "memory", labelKey: "settingsPage.nav.memory"),
            SettingsNavPage(page: .searchIndex, key: "search-index", labelKey: "settingsPage.nav.searchIndex"),
            SettingsNavPage(page: .embeddingModels, key: "embedding-models", labelKey: "settingsPage.nav.embeddingModels")
        ]),
        SettingsNavSection(key: "usage", labelKey: "settingsPage.nav.usage", icon: "tokens", pages: [
            SettingsNavPage(page: .usageLlm, key: "llm-models", labelKey: "settingsPage.nav.usageLlm"),
            SettingsNavPage(page: .usageEmbedding, key: "embedding-models", labelKey: "settingsPage.nav.usageEmbedding"),
            SettingsNavPage(page: .usageVectorDb, key: "vector-db", labelKey: "settingsPage.nav.usageVectorDb"),
            SettingsNavPage(page: .usageWebSearch, key: "web-search", labelKey: "settingsPage.nav.usageWebSearch")
        ]),
        SettingsNavSection(key: "developer", labelKey: "settingsPage.nav.developer", icon: "edit", single: .developer)
    ]

    /// The section and page for a Settings page; nil for Tools and Connectors.
    static func location(_ page: AppRouter.SettingsSection) -> (section: SettingsNavSection, page: SettingsNavPage?)? {
        for section in sections {
            if section.single == page { return (section, nil) }
            if let match = section.pages.first(where: { $0.page == page }) { return (section, match) }
        }
        return nil
    }

    /// The page's own name, for the header title.
    static func title(_ page: AppRouter.SettingsSection) -> String {
        switch page {
        case .tools: return L("settingsPage.settingsSidebar.tools")
        case .connectors: return L("settingsPage.settingsSidebar.connectors")
        default:
            guard let location = location(page) else { return L("settingsPage.nav.title") }
            return L(location.page?.labelKey ?? location.section.labelKey)
        }
    }

    /// The header subtitle's first part: the page's section, or "Settings" for a page that is its own section.
    static func sectionLabel(_ page: AppRouter.SettingsSection) -> String {
        guard let location = location(page), location.page != nil else { return L("settingsPage.nav.title") }
        return L(location.section.labelKey)
    }
}
