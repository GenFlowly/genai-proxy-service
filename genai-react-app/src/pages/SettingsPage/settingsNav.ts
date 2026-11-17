import { ICONS } from '../../constants/icons'

/** One settings page: its route segment, label, and the id its frame looks it up by. */
export interface SettingsNavPage {
    /** Unique across sections, e.g. 'usage-vector-db' vs 'byok-vector-db'. */
    id: string
    /** Route segment under its section. */
    key: string
    labelKey: string
    path: string
}

export interface SettingsNavSection {
    key: string
    labelKey: string
    icon: string
    path: string
    pages?: SettingsNavPage[]
}

const page = (section: string, key: string, labelKey: string, id = key): SettingsNavPage => ({
    id,
    key,
    labelKey,
    path: `/settings/${section}/${key}`,
})

/**
 * The Settings menu: grouped sections, each with its pages. Tools and
 * Connectors keep their routes but are not listed. Support and the privacy
 * policy live only in the phone menu's footer card.
 */
export const SETTINGS_SECTIONS: SettingsNavSection[] = [
    {
        key: 'profile',
        labelKey: 'settingsPage.nav.profile',
        icon: ICONS.USER_CIRCLE,
        path: '/settings/profile',
        pages: [
            page('profile', 'account', 'settingsPage.nav.account'),
            page('profile', 'privacy', 'settingsPage.nav.privacy'),
            page('profile', 'blocked', 'settingsPage.nav.blockedUsers'),
            page('profile', 'delete', 'settingsPage.nav.deleteData'),
        ],
    },
    {
        key: 'byok',
        labelKey: 'settingsPage.nav.byok',
        icon: ICONS.MODELS,
        path: '/settings/byok',
        pages: [
            page('byok', 'llm-keys', 'settingsPage.nav.llmKeys'),
            page('byok', 'embedding-keys', 'settingsPage.nav.embeddingKeys'),
            page('byok', 'vector-db', 'settingsPage.nav.vectorDb', 'byok-vector-db'),
            page('byok', 'web-search', 'settingsPage.nav.webSearchKey', 'byok-web-search'),
        ],
    },
    {
        key: 'defaults',
        labelKey: 'settingsPage.nav.defaults',
        icon: ICONS.PROMPT_ICON,
        path: '/settings/defaults',
        pages: [
            page('defaults', 'agents', 'settingsPage.nav.agents'),
            page('defaults', 'memory', 'settingsPage.nav.memory'),
            page('defaults', 'search-index', 'settingsPage.nav.searchIndex'),
            page('defaults', 'embedding-models', 'settingsPage.nav.embeddingModels', 'defaults-embedding-models'),
        ],
    },
    {
        key: 'usage',
        labelKey: 'settingsPage.nav.usage',
        icon: ICONS.TOKENS,
        path: '/settings/usage',
        pages: [
            page('usage', 'llm-models', 'settingsPage.nav.usageLlm'),
            page('usage', 'embedding-models', 'settingsPage.nav.usageEmbedding', 'usage-embedding-models'),
            page('usage', 'vector-db', 'settingsPage.nav.usageVectorDb', 'usage-vector-db'),
            page('usage', 'web-search', 'settingsPage.nav.usageWebSearch', 'usage-web-search'),
        ],
    },
    {
        key: 'developer',
        labelKey: 'settingsPage.nav.developer',
        icon: ICONS.EDIT,
        path: '/settings/developer',
    },
]

/** Pages that keep a route but aren't in the menu. */
const UNLISTED: SettingsNavSection[] = [
    { key: 'tools', labelKey: 'settingsPage.settingsSidebar.tools', icon: ICONS.EDIT, path: '/settings/tools' },
    { key: 'connectors', labelKey: 'settingsPage.settingsSidebar.connectors', icon: ICONS.EDIT, path: '/settings/connectors' },
]

const isUnder = (pathname: string, base: string) => pathname === base || pathname.startsWith(`${base}/`)

/** The section and page a route belongs to, for titles and breadcrumbs. */
export function findSettingsLocation(pathname: string): { section?: SettingsNavSection; page?: SettingsNavPage } {
    const section = [...SETTINGS_SECTIONS, ...UNLISTED].find(s => isUnder(pathname, s.path))
    const found = section?.pages?.find(p => isUnder(pathname, p.path))
    return { section, page: found }
}

/** A page by its id, with its section. */
export function findSettingsPage(id: string): { section: SettingsNavSection; page?: SettingsNavPage } | undefined {
    for (const section of [...SETTINGS_SECTIONS, ...UNLISTED]) {
        if (!section.pages && section.key === id) return { section }
        const found = section.pages?.find(p => p.id === id)
        if (found) return { section, page: found }
    }
    return undefined
}
