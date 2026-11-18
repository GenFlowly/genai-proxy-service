import React from 'react'
import { useTranslation } from 'react-i18next'
import { Icon, SidebarWidget } from '@genflowly/component-library'
import type { SidebarListGroup } from '@genflowly/component-library'
import { ICONS } from '../../../constants/icons'
import { historyRowBuilder } from './historyRows'
import type { ConversationHistory } from './useConversationHistory'

interface ChatsWidgetProps {
    history: ConversationHistory
    /** The full-screen mobile menu: touch rows with swipe trays. */
    menu: boolean
}

/** The Chats widget: pinned conversations, then the recent ones, outside any project. */
export default function ChatsWidget({ history, menu }: ChatsWidgetProps): React.ReactElement {
    const { t } = useTranslation()
    const { toTreeRows } = historyRowBuilder(history, t, menu)
    const title = t('conversation.conversationHistory.chats')
    const expanded = history.sectionExpanded.history

    const groups: SidebarListGroup[] = [
        ...(history.globalPinned.length > 0
            ? [{
                id: 'pinned',
                label: t('conversation.conversationHistory.pinned'),
                icon: <Icon src={ICONS.PIN} size={13} aria-hidden={true} />,
                items: toTreeRows(history.globalPinned, true),
            }]
            : []),
        ...(history.globalRecent.length > 0
            ? [{
                id: 'recent',
                label: t('conversation.conversationHistory.recents'),
                items: toTreeRows(history.globalRecent, false),
            }]
            : []),
    ]

    return (
        <SidebarWidget
            variant="history"
            title={title}
            icon={ICONS.CHAT_BUBBLE}
            collapsible
            collapsed={!expanded}
            onCollapsedChange={collapsed => history.toggleSection('history', !collapsed)}
            collapseLabel={t('layout.chatSidebar.collapseSection', { name: title })}
            expandLabel={t('layout.chatSidebar.expandSection', { name: title })}
            touch={menu}
            toggleTestId="conv-history-history-heading"
            data-testid="chats-widget"
            list={{
                moreActionsLabel: t('layout.mobileHeader.moreActions'),
                groups,
                testIds: { list: 'history-scroll-list', endSentinel: 'history-end-sentinel' },
                // Older pages stream in as the end of the list nears; paused
                // while a fetch runs and after a failure — re-arming on a
                // failing request would loop, so a failed page retries itself
                // with backoff instead. A collapsed card has no visible end to
                // reach, so it requests nothing.
                onEndReached: history.hasMore && !history.isLoading && !history.error && expanded ? history.loadMore : undefined,
                isLoading: history.isLoading,
                hasError: history.error,
                errorText: t('conversation.conversationHistory.failedToLoad'),
                emptyText: t('conversation.conversationHistory.noConversationsYet'),
                listAriaLabel: t('conversation.conversationHistory.listAriaLabel'),
            }}
        />
    )
}
