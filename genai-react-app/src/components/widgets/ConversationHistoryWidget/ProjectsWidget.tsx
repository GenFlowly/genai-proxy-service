import React from 'react'
import { useTranslation } from 'react-i18next'
import { Icon, IconButton, SidebarListPanel, SidebarWidget } from '@genflowly/component-library'
import type { SidebarListGroup, SidebarListItem } from '@genflowly/component-library'
import { ICONS } from '../../../constants/icons'
import { getExpandedProject, setExpandedProject } from './historyCache'
import { historyRowBuilder } from './historyRows'
import type { ConversationHistory, ProjectBucket } from './useConversationHistory'

interface ProjectsWidgetProps {
    history: ConversationHistory
    /** The full-screen mobile menu: touch rows with swipe trays. */
    menu: boolean
}

/**
 * The Projects widget: the customer's projects, each opening to its own
 * pinned and recent conversations. A project row carries New conversation
 * (always visible) and, behind More actions, Rename and Delete project.
 */
export default function ProjectsWidget({ history, menu }: ProjectsWidgetProps): React.ReactElement {
    const { t } = useTranslation()
    const { toTreeRows } = historyRowBuilder(history, t, menu)
    const title = t('conversation.conversationHistory.projects')

    // First mount expands the project of the active conversation; after that
    // the user's own toggles win for the rest of the session
    const toProjectGroup = (project: ProjectBucket): SidebarListGroup => {
        const containsActive =
            !!history.activeId &&
            [...project.pinned, ...project.recent].some(c => c.conversationId === history.activeId)
        const expandEpoch = history.expandEpochs[project.id]
        // A project whose members were never fetched (or cached) must still be
        // expandable — the library only renders expand semantics when there is
        // something inside, and expanding is exactly what triggers the lazy
        // fetch. A placeholder row fills the gap until the first page lands;
        // a fetched-and-empty project legitimately renders chevron-less.
        const membersKnown = history.projectItems[project.id] !== undefined
        const loadingRow: SidebarListItem[] = !membersKnown
            ? [{
                id: `project-${project.id}-loading`,
                label: t('conversation.conversationHistory.loading'),
                onSelect: () => history.ensureProjectLoaded(project.id),
                testId: `conv-history-project-loading-${project.id}`,
            }]
            : []
        return {
            id: expandEpoch ? `project-${project.id}-x${expandEpoch}` : `project-${project.id}`,
            label: project.name,
            collapsible: true,
            defaultExpanded: getExpandedProject(project.id) ?? containsActive,
            onToggle: expanded => {
                setExpandedProject(project.id, expanded)
                // Lazy load: a project's members are first fetched the moment
                // the user opens it, so the login burst stays project-free
                if (expanded) history.ensureProjectLoaded(project.id)
            },
            testId: `conv-history-project-${project.id}`,
            actions: [
                {
                    // Starting a chat in a project is a primary affordance,
                    // not a row-management one, so it is always visible
                    icon: <Icon src={ICONS.PLUS} size={14} aria-hidden={true} />,
                    label: t('conversation.conversationHistory.newConversationInProject'),
                    onClick: (e: React.MouseEvent) => {
                        e.stopPropagation()
                        history.newConversationInProject(project.id)
                    },
                    testId: `conv-history-project-new-conv-${project.id}`,
                },
            ],
            menuActions: [
                {
                    icon: <Icon src={ICONS.EDIT} size={14} aria-hidden={true} />,
                    label: t('conversation.conversationHistory.renameProject'),
                    tone: 'neutral',
                    onClick: (e: React.MouseEvent) => {
                        e.stopPropagation()
                        history.openRenameProject(project)
                    },
                    testId: `conv-history-project-rename-${project.id}`,
                },
                {
                    icon: <Icon src={ICONS.TRASH} size={14} aria-hidden={true} />,
                    label: t('conversation.conversationHistory.deleteProject'),
                    tone: 'muted',
                    onClick: (e: React.MouseEvent) => {
                        e.stopPropagation()
                        history.requestDeleteProject(project)
                    },
                    testId: `conv-history-project-delete-${project.id}`,
                },
            ],
            groups: [
                ...(project.pinned.length > 0
                    ? [{
                        id: `project-${project.id}-pinned`,
                        label: t('conversation.conversationHistory.pinned'),
                        items: toTreeRows(project.pinned, true),
                    }]
                    : []),
                ...(project.recent.length > 0 || loadingRow.length > 0
                    ? [{
                        id: `project-${project.id}-recent`,
                        label: t('conversation.conversationHistory.recent'),
                        items: [...toTreeRows(project.recent, false), ...loadingRow],
                    }]
                    : []),
            ],
        }
    }

    // One unlabeled section holds the project rows, so they keep the row look
    // (a top-level collapsible group would render as a section heading)
    const groups: SidebarListGroup[] = [{
        id: 'projects',
        label: '',
        groups: history.projectBuckets.map(toProjectGroup),
    }]

    return (
        <SidebarWidget
            title={title}
            icon={ICONS.FOLDER}
            collapsible
            collapsed={!history.sectionExpanded.projects}
            onCollapsedChange={collapsed => history.toggleSection('projects', !collapsed)}
            collapseLabel={t('layout.chatSidebar.collapseSection', { name: title })}
            expandLabel={t('layout.chatSidebar.expandSection', { name: title })}
            variant={menu ? 'menu' : 'default'}
            actions={
                <IconButton
                    icon={ICONS.FOLDER_PLUS}
                    label={t('conversation.conversationHistory.newProject')}
                    size="sm"
                    onClick={history.openCreateProject}
                    data-testid="conv-history-new-project"
                />
            }
            toggleTestId="conv-history-projects-heading"
            data-testid="projects-widget"
        >
            <SidebarListPanel
                variant={menu ? 'menu' : 'default'}
                surface="card"
                moreActionsLabel={t('layout.mobileHeader.moreActions')}
                groups={groups}
                isLoading={false}
                hasError={false}
                errorText={t('conversation.conversationHistory.failedToLoad')}
                emptyText={t('conversation.conversationHistory.noProjectsYet')}
                listAriaLabel={title}
            />
        </SidebarWidget>
    )
}
