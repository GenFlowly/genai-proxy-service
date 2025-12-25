import { useAI } from '../context/AIContext'
import { useAuth } from '../context/AuthContext'
import { useConversation } from '../context/ConversationContext'
import { useLayout } from '../context/LayoutContext'

export const useSidebarWidget = () => {
    const ai = useAI()
    const auth = useAuth()
    const conversation = useConversation()
    const layout = useLayout()

    return {
        ai,
        auth,
        conversation,
        layout,
    }
}
