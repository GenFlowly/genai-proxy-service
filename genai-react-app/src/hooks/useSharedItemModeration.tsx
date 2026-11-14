import React, { useCallback, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { BlockConfirmDialog } from '../components/common/ModerationDialogs/BlockConfirmDialog'
import { ReportDialog } from '../components/common/ModerationDialogs/ReportDialog'
import { CONVERSATION_LIST_CHANGED_EVENT } from '../constants/events'
import { useAuth } from '../context/AuthContext'
import { useToast } from '../context/ToastContext'
import { deleteConversation } from '../services/conversationHistoryService'
import { unshareInstruction } from '../services/instructionService'
import { ReportedEntityType, blockUser, getSharedItemOwner } from '../services/moderationService'
import { SHARED_ITEM_OWNER_QUERY_KEY } from './queries/queryKeys'

export interface ModerationAction {
    key: string
    label: string
    onSelect: () => void
    danger?: boolean
    testId: string
}

interface Options {
    entityType: ReportedEntityType
    entityId: string | undefined
    /** The caller can see the item and doesn't own it. */
    enabled: boolean
    /** The item is no longer the caller's to see: they blocked its owner or left the share. */
    onGone: () => void
}

/** Report and Block for an item shared with the caller: the menu actions and the dialogs behind them. */
export function useSharedItemModeration({ entityType, entityId, enabled, onGone }: Options) {
    const { t } = useTranslation()
    const { isAuthenticated, customerId, getAccessTokenSilently, refreshInstructions } = useAuth()
    const { showToast } = useToast()
    const [reportOpen, setReportOpen] = useState(false)
    const [blockOpen, setBlockOpen] = useState(false)
    const [blocking, setBlocking] = useState(false)
    const [blockError, setBlockError] = useState<string | null>(null)

    const { data: owner } = useQuery({
        queryKey: [SHARED_ITEM_OWNER_QUERY_KEY, entityType, entityId],
        queryFn: async () => getSharedItemOwner(await getAccessTokenSilently(), entityType, entityId!),
        enabled: enabled && isAuthenticated && !!entityId,
        retry: false,
    })
    const visibleOwner = enabled ? owner : undefined
    const ownerLabel = visibleOwner?.ownerUsername
        ? `@${visibleOwner.ownerUsername}`
        : visibleOwner?.ownerName || t('moderation.theOwner')

    const listsChanged = useCallback(() => {
        window.dispatchEvent(new CustomEvent(CONVERSATION_LIST_CHANGED_EVENT))
        refreshInstructions()
    }, [refreshInstructions])

    const block = useCallback(async () => {
        if (!visibleOwner) return
        setBlocking(true)
        setBlockError(null)
        try {
            await blockUser(await getAccessTokenSilently(), visibleOwner.ownerCustomerId)
            showToast(t('moderation.block.done', { name: ownerLabel }))
            setBlockOpen(false)
            setReportOpen(false)
            listsChanged()
            onGone()
        } catch (error) {
            console.error('Failed to block user', error)
            setBlockError(t('moderation.block.failed', { name: ownerLabel }))
        } finally {
            setBlocking(false)
        }
    }, [visibleOwner, getAccessTokenSilently, showToast, t, ownerLabel, listsChanged, onGone])

    const remove = useCallback(async () => {
        if (!entityId || !customerId) return
        try {
            const token = await getAccessTokenSilently()
            if (entityType === 'CONVERSATION') await deleteConversation(token, entityId)
            else await unshareInstruction(token, entityId, customerId)
            showToast(t('moderation.report.removed'))
            setReportOpen(false)
            listsChanged()
            onGone()
        } catch (error) {
            console.error('Failed to leave the share', error)
            showToast(t('moderation.report.removeFailed'))
        }
    }, [entityId, customerId, entityType, getAccessTokenSilently, showToast, t, listsChanged, onGone])

    const actions = useMemo<ModerationAction[]>(() => {
        if (!visibleOwner) return []
        const prefix = entityType === 'CONVERSATION' ? 'conversation' : 'instruction'
        return [
            {
                key: 'report',
                label: t(entityType === 'CONVERSATION' ? 'moderation.report.menuConversation' : 'moderation.report.menuInstruction'),
                onSelect: () => setReportOpen(true),
                testId: `${prefix}-report`,
            },
            ...(visibleOwner.canBlock ? [{
                key: 'block',
                label: t('moderation.block.menu', { name: ownerLabel }),
                onSelect: () => { setBlockError(null); setBlockOpen(true) },
                danger: true,
                testId: `${prefix}-block`,
            }] : []),
        ]
    }, [visibleOwner, entityType, ownerLabel, t])

    const dialogs: React.ReactElement | null = visibleOwner && entityId ? (
        <>
            <ReportDialog
                isOpen={reportOpen}
                onClose={() => setReportOpen(false)}
                entityType={entityType}
                entityId={entityId}
                ownerLabel={ownerLabel}
                canBlock={visibleOwner.canBlock}
                canRemove={visibleOwner.canRemove}
                onBlock={block}
                blocking={blocking}
                blockError={blockError}
                onRemove={remove}
            />
            <BlockConfirmDialog
                isOpen={blockOpen}
                name={ownerLabel}
                blocking={blocking}
                error={blockError}
                onConfirm={block}
                onCancel={() => setBlockOpen(false)}
            />
        </>
    ) : null

    return { owner: visibleOwner, ownerLabel, actions, dialogs }
}
