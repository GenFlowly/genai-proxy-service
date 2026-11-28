import React from 'react'
import { TFunction } from 'i18next'
import { Icon, sidebarListPanelStyles as panelStyles } from '@genflowly/component-library'
import type { SidebarListItem } from '@genflowly/component-library'
import { ConversationSummary } from '../../../models/conversationHistory.models'
import { CollapsedVendorBrandName } from '../../common/BrandName/BrandName'
import { ICONS } from '../../../constants/icons'
import { formatServerDateTime, formatServerTime, parseServerDate } from '../../../utils/timeUtils'
import type { ConversationHistory } from './useConversationHistory'
import styles from './ConversationHistory.module.scss'

const isToday = (value: string) => {
    const d = parseServerDate(value)
    if (!d) return false
    const now = new Date()
    return d.getFullYear() === now.getFullYear()
        && d.getMonth() === now.getMonth()
        && d.getDate() === now.getDate()
}

/** A row's second line: the vendors that answered, then when it was last updated. */
function renderDetails(conv: ConversationSummary): React.ReactElement {
    return (
        <>
            <div className={styles.vendorIcons}>
                {[...(conv.vendors || [])].sort().map((v, idx) => (
                    <CollapsedVendorBrandName key={idx} vendorId={v} size={11} className={styles.vendorIcon} />
                ))}
            </div>
            {(conv.vendors?.length ?? 0) > 0 && conv.updatedAt && (
                <span className={panelStyles.detailsSeparator} aria-hidden="true">·</span>
            )}
            {conv.updatedAt && (
                <span className={panelStyles.timestamp}>
                    {isToday(conv.updatedAt)
                        // Same-day conversations don't need the date — time only
                        ? formatServerTime(conv.updatedAt)
                        : formatServerDateTime(conv.updatedAt)}
                </span>
            )}
        </>
    )
}

/** A row's title, with a dot after it when a reply came in since the chat was last read. */
function renderLabel(title: string, unread: boolean, t: TFunction): React.ReactNode {
    if (!unread) return title
    return (
        <span className={styles.unreadLabel}>
            <span className={styles.unreadTitle}>{title}</span>
            <span
                className={styles.unreadDot}
                role="img"
                aria-label={t('conversation.conversationHistory.unreadReply')}
                data-testid="conv-history-unread-dot"
            />
        </span>
    )
}

/**
 * Builds the rows the Projects and Chats widgets list: a conversation with
 * Move to project, Pin or Unpin and Delete behind its More actions button.
 * On touch rows those become swipe trays: Pin on the right swipe, the rest on
 * the left.
 */
export function historyRowBuilder(history: ConversationHistory, t: TFunction, menu: boolean) {
    const toRow = (conv: ConversationSummary, isPinned: boolean): SidebarListItem => ({
        id: conv.conversationId,
        label: renderLabel(
            conv.title?.trim() || (menu ? t('conversation.conversationHistory.untitledConversation') : conv.conversationId),
            !!conv.unread && conv.conversationId !== history.activeId,
            t
        ),
        details: renderDetails(conv),
        isActive: conv.conversationId === history.activeId,
        ariaCurrent: 'page',
        onSelect: () => history.navigateTo(conv.conversationId),
        testId: `conv-history-item-${conv.conversationId}`,
        menuActions: [
            {
                icon: <Icon src={ICONS.FOLDER} size={14} aria-hidden={true} />,
                label: t('conversation.conversationHistory.moveToProject'),
                tone: 'neutral',
                onClick: (e: React.MouseEvent) => {
                    e.stopPropagation()
                    history.setMoveTarget(conv)
                },
                testId: `conv-move-btn-${conv.conversationId}`,
            },
            {
                icon: <Icon src={isPinned ? ICONS.PIN_OFF : ICONS.PIN} size={14} aria-hidden={true} />,
                label: isPinned
                    ? t('conversation.conversationHistory.unpin')
                    : t('conversation.conversationHistory.pin'),
                tone: 'primary',
                swipe: 'leading',
                onClick: (e: React.MouseEvent) => (isPinned ? history.unpin(e, conv) : history.pin(e, conv)),
                testId: `conv-${isPinned ? 'unpin' : 'pin'}-btn-${conv.conversationId}`,
            },
            {
                icon: <Icon src={ICONS.TRASH} size={14} aria-hidden={true} />,
                label: t('conversation.conversationHistory.delete'),
                tone: 'muted',
                onClick: (e: React.MouseEvent) => {
                    e.stopPropagation()
                    history.requestDelete(conv)
                },
                testId: `conv-delete-btn-${conv.conversationId}`,
            },
        ],
    })

    /**
     * Nest forked conversations under their parent, forming the fork tree the
     * sidebar draws with indent + connector lines. A conversation becomes a
     * child only when its parent renders in the SAME section list (pinned vs
     * recent vs a project's subsection) — otherwise it stays a flat root, so
     * a fork never disappears just because its parent moved elsewhere. Forks
     * of forks nest recursively; parents keep the list's order.
     */
    const toTreeRows = (list: ConversationSummary[], isPinned: boolean): SidebarListItem[] => {
        const idsInList = new Set(list.map(c => c.conversationId))
        const childrenByParent = new Map<string, ConversationSummary[]>()
        const roots: ConversationSummary[] = []
        for (const conv of list) {
            const parentId = conv.parentConversationId
            if (parentId && parentId !== conv.conversationId && idsInList.has(parentId)) {
                childrenByParent.set(parentId, [...(childrenByParent.get(parentId) ?? []), conv])
            } else {
                roots.push(conv)
            }
        }
        const build = (conv: ConversationSummary): SidebarListItem => ({
            ...toRow(conv, isPinned),
            children: (childrenByParent.get(conv.conversationId) ?? []).map(build),
        })
        return roots.map(build)
    }

    return { toTreeRows }
}
