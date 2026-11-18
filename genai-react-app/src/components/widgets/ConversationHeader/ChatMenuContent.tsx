import React, { useState } from 'react'
import { useNavigate } from 'react-router'
import { useTranslation } from 'react-i18next'
import ConversationHistoryComponent from '../ConversationHistoryWidget/ConversationHistoryComponent'
import MobileMenuBody from '../MobileMenuBody/MobileMenuBody'
import MenuSearchResults from '../MobileMenuBody/MenuSearchResults'

const SEARCH_TYPES = ['conversation' as const]

/** The Chat page's L2 Menu: Projects and History, or search results. */
export default function ChatMenuContent({ onClose }: { onClose: () => void }): React.ReactElement {
    const { t } = useTranslation()
    const navigate = useNavigate()
    const [query, setQuery] = useState('')

    return (
        <MobileMenuBody
            searchValue={query}
            onSearchChange={setQuery}
            searchPlaceholder={t('layout.mobileMenu.searchChats')}
            results={query.trim() !== '' ? (
                <MenuSearchResults
                    query={query}
                    types={SEARCH_TYPES}
                    variant="history"
                    untitledLabel={t('conversation.conversationHistory.untitledConversation')}
                    onSelect={result => {
                        navigate(`/chat/${result.key}`)
                        onClose()
                    }}
                    onLeave={onClose}
                />
            ) : undefined}
        >
            <ConversationHistoryComponent menu onSelect={onClose} />
        </MobileMenuBody>
    )
}
