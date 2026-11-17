import React from 'react'
import { useTranslation } from 'react-i18next'
import { Icon, SidebarWidget, SidebarListPanel } from '@genflowly/component-library'
import type { SidebarListGroup } from '@genflowly/component-library'
import { ICONS } from '../../../constants/icons'
import { Project } from '../../../models/conversationHistory.models'
import { MemoryKind, MemoryScope } from '../../../models/memory.models'
import { getExpandedSection, setExpandedSection } from '../../../components/widgets/ConversationHistoryWidget/historyCache'
import styles from '../MemoryPage.module.scss'

interface MemoryScopePanelsProps {
    /** The list on screen; null on pages that aren't a list. */
    scope: MemoryScope | null
    counts: Record<string, number>
    projects: Project[]
    isLoading: boolean
    hasError: boolean
    onSelect: (scope: MemoryScope) => void
    /** The mobile L2 Menu: touch sizing and collapsible card headers. */
    menu?: boolean
}

/**
 * The Memory page's two sidebar cards: Profile memories (Core, Episodic) and
 * Projects. Rows open their list; they never expand in place.
 */
export default function MemoryScopePanels({
    scope,
    counts,
    projects,
    isLoading,
    hasError,
    onSelect,
    menu = false,
}: MemoryScopePanelsProps): React.ReactElement {
    const { t } = useTranslation()

    const row = (label: string, icon: string, count: number | undefined) => (
        <span className={styles.scopeItem}>
            <Icon src={icon} size={menu ? 18 : 14} className={styles.scopeIcon} aria-hidden={true} />
            <span className={styles.scopeLabel}>{label}</span>
            {count ? <span className={styles.scopeCount}>{count}</span> : null}
        </span>
    )

    const profileRow = (kind: MemoryKind) => {
        const key = kind === 'CORE' ? 'core' : 'episodic'
        return {
            id: key,
            label: row(t(`memoryPage.kinds.${key}`), kind === 'CORE' ? ICONS.BRAIN : ICONS.HISTORY, counts[key]),
            isActive: scope?.type === 'profile' && scope.kind === kind,
            ariaCurrent: 'page' as const,
            onSelect: () => onSelect({ type: 'profile', kind }),
            testId: `memory-scope-${key}`,
        }
    }

    const section = (
        id: 'memoryProfile' | 'memoryProjects',
        label: string,
        items: SidebarListGroup['items']
    ): SidebarListGroup[] => {
        if (!menu) return [{ id, label: '', items }]
        return [{
            id,
            label,
            collapsible: true,
            defaultExpanded: getExpandedSection(id) ?? true,
            onToggle: expanded => setExpandedSection(id, expanded),
            testId: `${id}-heading`,
            groups: [{ id: `${id}-rows`, label: '', items }],
        }]
    }

    const projectItems = projects.map(project => ({
        id: project.projectId,
        label: row(project.name, ICONS.FOLDER, counts[project.projectId]),
        isActive: scope?.type === 'project' && scope.projectId === project.projectId,
        ariaCurrent: 'page' as const,
        onSelect: () => onSelect({ type: 'project', projectId: project.projectId }),
        testId: `memory-scope-project-${project.projectId}`,
    }))

    return (
        <>
            <SidebarWidget className={styles.profileCard}>
                <SidebarListPanel
                    title={menu ? undefined : t('memoryPage.menu.profileMemories')}
                    variant={menu ? 'menu' : 'default'}
                    groups={section('memoryProfile', t('memoryPage.menu.profileMemories'), [profileRow('CORE'), profileRow('EPISODIC')])}
                    isLoading={false}
                    hasError={false}
                    errorText=""
                    emptyText=""
                    listAriaLabel={t('memoryPage.menu.profileMemories')}
                    data-testid={menu ? 'memory-profile-panel-mobile' : 'memory-profile-panel'}
                />
            </SidebarWidget>
            <SidebarWidget className={styles.projectsCard}>
                <SidebarListPanel
                    title={menu ? undefined : t('memoryPage.menu.projects')}
                    variant={menu ? 'menu' : 'default'}
                    groups={projectItems.length > 0 || menu
                        ? section('memoryProjects', t('memoryPage.menu.projects'), projectItems)
                        : []}
                    isLoading={isLoading && projects.length === 0}
                    hasError={hasError && projects.length === 0}
                    errorText={t('memoryPage.menu.projectsFailed')}
                    emptyText={t('memoryPage.menu.noProjects')}
                    listAriaLabel={t('memoryPage.menu.projects')}
                    data-testid={menu ? 'memory-projects-panel-mobile' : 'memory-projects-panel'}
                />
            </SidebarWidget>
        </>
    )
}
