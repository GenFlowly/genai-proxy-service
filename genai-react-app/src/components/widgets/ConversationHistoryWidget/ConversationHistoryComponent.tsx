import React from 'react'
import { useTranslation } from 'react-i18next'
import { VerticalSplit } from '@genflowly/component-library'
import { useConversationHistory } from './useConversationHistory'
import ProjectsWidget from './ProjectsWidget'
import ChatsWidget from './ChatsWidget'
import ConversationHistoryDialogs from './ConversationHistoryDialogs'

// Top (Projects) pane's share of the sidebar height, persisted as a fraction
// so both panes keep scaling together when the sidebar resizes
const HISTORY_SPLIT_STORAGE_KEY = 'conversation_history_split_fraction'

interface ConversationHistoryComponentProps {
    // Fired synchronously on tap/click, before the conversation has loaded —
    // lets a mobile full-screen overlay close itself immediately instead of
    // waiting on the (async, failure-prone) conversation load to flip some
    // unrelated piece of state
    onSelect?: () => void
    // The full-screen mobile menu: touch rows, swipe trays and a visible grip
    menu?: boolean
}

/**
 * The chat page's Projects and Chats widgets, stacked on a split whose gap
 * between them is the drag handle. Each widget collapses to its header; the
 * split then hugs it.
 */
export default function ConversationHistoryComponent({ onSelect, menu = false }: ConversationHistoryComponentProps = {}) {
    const { t } = useTranslation()
    const history = useConversationHistory({ onSelect })

    return (
        <>
            <VerticalSplit
                bare
                storageKey={HISTORY_SPLIT_STORAGE_KEY}
                separatorLabel={t('conversation.conversationHistory.resizePanels')}
                topCollapsed={history.projects.length === 0 || !history.sectionExpanded.projects}
                bottomCollapsed={!history.sectionExpanded.history}
                showGrip={menu}
                handleTestId="history-split-handle"
                topTestId="projects-pane"
                bottomTestId="history-pane"
                top={history.showProjectsPanel ? <ProjectsWidget history={history} menu={menu} /> : null}
                bottom={<ChatsWidget history={history} menu={menu} />}
            />
            <ConversationHistoryDialogs history={history} />
        </>
    )
}
