import { useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { formatServerDateTime, formatServerTime, parseServerDate } from '@genflowly/component-library'
import type { OutlineItem } from '@genflowly/component-library'
import { useConversation, useConversationUI } from '../context/ConversationContext'
import { useVendorDisplayNames } from './useVendorDisplayNames'
import { plainPrompt } from '../utils/plainPrompt'

const isToday = (date: Date): boolean => {
    const now = new Date()
    return date.getFullYear() === now.getFullYear()
        && date.getMonth() === now.getMonth()
        && date.getDate() === now.getDate()
}

/**
 * The conversation's turns for the Outline, the turn in view, and a way to
 * jump to a turn. A turn is a block that was sent; the empty editor block
 * after the last turn is not one.
 */
export function useConversationOutline(): {
    items: OutlineItem[]
    currentId: string | null
    scrollToTurn: (blockId: string) => void
} {
    const { t } = useTranslation()
    const { conversationBlockList } = useConversation()
    const { activeViewportItem } = useConversationUI()
    const vendorName = useVendorDisplayNames()

    const items = useMemo<OutlineItem[]>(() => (
        conversationBlockList
            .filter(block => block.status === 'resolved' || block.isLoading || block.responseMessages.length > 0)
            .map((block, index) => {
                const vendors = Array.from(new Set(
                    block.responseMessages.map(m => m.aiVendor).filter((v): v is string => !!v)
                )).map(vendorName)
                const sent = parseServerDate(block.sentAt)
                const time = sent ? (isToday(sent) ? formatServerTime(sent) : formatServerDateTime(sent)) : ''
                const parts = block.isLoading
                    ? [vendors.join(', '), time]
                    : [
                        t('conversation.outline.responses', { count: block.responseMessages.length }),
                        vendors.join(', '),
                        time,
                    ]
                return {
                    id: block.conversationBlockId,
                    number: index + 1,
                    prompt: plainPrompt(block.prompt),
                    meta: parts.filter(Boolean).join(' · '),
                    isGenerating: block.isLoading,
                }
            })
    ), [conversationBlockList, vendorName, t])

    const viewedId = activeViewportItem?.blockId
    const currentId = items.some(item => item.id === viewedId)
        ? viewedId ?? null
        : items[items.length - 1]?.id ?? null

    const scrollToTurn = useCallback((blockId: string) => {
        const target = document.querySelector<HTMLElement>(`.conversation-block-item[data-block-id="${blockId}"]`)
        target?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }, [])

    return { items, currentId, scrollToTurn }
}
