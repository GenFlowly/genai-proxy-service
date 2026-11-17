import { useAuth } from '../context/AuthContext'
import { useConversation } from '../context/ConversationContext'
import { loadHistoryCache } from '../components/widgets/ConversationHistoryWidget/historyCache'

/**
 * The name of the project a new chat will be created in (the chat was started
 * from a project's plus), while that chat has no conversation yet. Read from
 * the history the sidebar keeps, so it costs no request; null when the
 * project isn't in it.
 */
export function usePendingProjectName(): string | null {
    const { conversationId, pendingProjectId } = useConversation()
    const { customerId } = useAuth()
    if (conversationId || !pendingProjectId) return null
    return loadHistoryCache(customerId)?.projects.find(p => p.projectId === pendingProjectId)?.name ?? null
}
