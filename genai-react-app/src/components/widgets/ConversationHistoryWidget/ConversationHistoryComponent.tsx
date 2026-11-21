import React from 'react'
import { SidebarStack } from '@genflowly/component-library'
import { useConversationHistory } from './useConversationHistory'
import ProjectsWidget from './ProjectsWidget'
import ChatsWidget from './ChatsWidget'
import ConversationHistoryDialogs from './ConversationHistoryDialogs'

interface ConversationHistoryComponentProps {
    // Fired synchronously on tap/click, before the conversation has loaded —
    // lets a mobile full-screen overlay close itself immediately instead of
    // waiting on the (async, failure-prone) conversation load to flip some
    // unrelated piece of state
    onSelect?: () => void
    // The full-screen mobile menu: touch rows and swipe trays
    menu?: boolean
}

/**
 * The chat page's Projects and Chats widgets, each at its full height, in one
 * column that scrolls as a whole. Each widget collapses to its header.
 */
export default function ConversationHistoryComponent({ onSelect, menu = false }: ConversationHistoryComponentProps = {}) {
    const history = useConversationHistory({ onSelect })

    return (
        <>
            <SidebarStack touch={menu} data-testid="history-stack">
                {history.showProjectsPanel && <ProjectsWidget history={history} menu={menu} />}
                <ChatsWidget history={history} menu={menu} />
            </SidebarStack>
            <ConversationHistoryDialogs history={history} />
        </>
    )
}
