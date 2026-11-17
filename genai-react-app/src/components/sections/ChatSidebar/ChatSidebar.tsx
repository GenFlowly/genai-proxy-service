import React, { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { useTranslation } from 'react-i18next'
import { CollapseStrip, MenuSearchField, PillButton, ResizableSidebar, SidebarRail, Tooltip } from '@genflowly/component-library'
import { useLayout } from '../../../context/LayoutContext'
import { useConversation } from '../../../context/ConversationContext'
import { ICONS } from '../../../constants/icons'
import ConversationHistoryComponent from '../../widgets/ConversationHistoryWidget/ConversationHistoryComponent'
import MenuSearchResults from '../../widgets/MobileMenuBody/MenuSearchResults'
import styles from './ChatSidebar.module.scss'

// Persisted in rem so the width follows the root font size
const WIDTH_STORAGE_KEY = 'chat_sidebar_width_rem'
const SEARCH_TYPES = ['conversation' as const]

/**
 * 🖥️ The chat page's left side: New Chat, the chat search field, then the
 * Projects and Chats cards, collapsing to a 28px rail. Only the user opens or
 * closes it.
 */
export default function ChatSidebar(): React.ReactElement {
    const { t } = useTranslation()
    const navigate = useNavigate()
    const { isChatSidebarExpanded, setChatSidebarExpanded, toggleChatSidebar } = useLayout()
    const { resetConversation } = useConversation()
    const [query, setQuery] = useState('')
    const searchRef = useRef<HTMLDivElement>(null)
    // The rail's Search expands the sidebar; its field can only take focus once rendered
    const focusSearchOnExpand = useRef(false)

    useEffect(() => {
        if (!isChatSidebarExpanded || !focusSearchOnExpand.current) return
        focusSearchOnExpand.current = false
        searchRef.current?.querySelector('input')?.focus()
    }, [isChatSidebarExpanded])

    const openSearch = () => {
        focusSearchOnExpand.current = true
        setChatSidebarExpanded(true)
    }

    const clearSearch = () => setQuery('')

    if (!isChatSidebarExpanded) {
        return (
            <SidebarRail
                side="left"
                aria-label={t('layout.chatSidebar.label')}
                items={[
                    { id: 'new-chat', icon: ICONS.COMPOSE, label: t('conversation.conversationHeader.newChat'), onClick: resetConversation, testId: 'rail-new-chat' },
                    { id: 'search', icon: ICONS.SEARCH, label: t('layout.mobileMenu.searchChats'), onClick: openSearch, testId: 'rail-search' },
                ]}
                tabs={[
                    { id: 'chats', label: t('layout.chatSidebar.chats'), onClick: () => setChatSidebarExpanded(true), testId: 'rail-chats' },
                    { id: 'projects', label: t('layout.chatSidebar.projects'), onClick: () => setChatSidebarExpanded(true), testId: 'rail-projects' },
                ]}
                expandLabel={t('layout.rightSidebar.expandSidebar')}
                onExpand={toggleChatSidebar}
                expandTestId="chat-sidebar-expand"
                data-testid="chat-sidebar-rail"
            />
        )
    }

    const searching = query.trim() !== ''

    return (
        <ResizableSidebar
            storageKey={WIDTH_STORAGE_KEY}
            defaultWidth={240}
            minWidth={200}
            variant="plain"
            data-testid="chat-sidebar"
            handleTestId="chat-sidebar-resize-handle"
        >
            <aside className={styles.column} aria-label={t('layout.chatSidebar.label')}>
                <Tooltip content={t('conversation.conversationHeader.newChat')} position="bottom" fullWidth className={styles.newChatTip}>
                    <PillButton
                        label={t('conversation.conversationHeader.newChat')}
                        icon={ICONS.COMPOSE}
                        className={styles.newChat}
                        onClick={resetConversation}
                        data-testid="new-chat-button"
                    />
                </Tooltip>
                <Tooltip content={t('layout.mobileMenu.searchChats')} position="right" showOnFocus={false} fullWidth className={styles.searchTip}>
                    <div
                        ref={searchRef}
                        className={styles.search}
                        onKeyDown={e => {
                            if (e.key === 'Escape') clearSearch()
                        }}
                    >
                        <MenuSearchField
                            value={query}
                            onChange={setQuery}
                            placeholder={t('layout.mobileMenu.searchChats')}
                            clearLabel={t('layout.mobileMenu.clearSearch')}
                            variant="sidebar"
                            data-testid="chat-sidebar-search"
                        />
                    </div>
                </Tooltip>
                <div className={styles.cards} hidden={searching} data-testid="chat-sidebar-cards">
                    <ConversationHistoryComponent />
                </div>
                {searching && (
                    <div className={styles.cards}>
                        <MenuSearchResults
                            query={query}
                            types={SEARCH_TYPES}
                            surface="card"
                            variant="default"
                            untitledLabel={t('conversation.conversationHistory.untitledConversation')}
                            onSelect={result => {
                                navigate(`/chat/${result.key}`)
                                clearSearch()
                            }}
                            onLeave={clearSearch}
                        />
                    </div>
                )}
                <CollapseStrip
                    direction="left"
                    label={t('layout.rightSidebar.collapseSidebar')}
                    onClick={toggleChatSidebar}
                    aria-expanded={true}
                    data-testid="chat-sidebar-collapse"
                />
            </aside>
        </ResizableSidebar>
    )
}
