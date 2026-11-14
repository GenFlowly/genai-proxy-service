import React, { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { PillButton } from '@genflowly/component-library'
import { useAuth } from '../../../context/AuthContext'
import { BLOCKED_USERS_QUERY_KEY } from '../../../hooks/queries/queryKeys'
import { BlockedUser, getBlockedUsers, unblockUser } from '../../../services/moderationService'
import { formatServerDateOnly } from '../../../utils/timeUtils'
import styles from './BlockedUsersList.module.scss'

function displayName(user: BlockedUser, fallback: string): string {
    return user.username ? `@${user.username}` : user.name || fallback
}

function initials(user: BlockedUser): string {
    const source = user.name || user.username || '?'
    return source.split(/\s+/).map(part => part[0]).join('').slice(0, 2).toUpperCase()
}

/** Who the signed-in user has blocked, with Unblock. */
export function BlockedUsersList(): React.ReactElement {
    const { t } = useTranslation()
    const { customerId, isAuthenticated, getAccessTokenSilently } = useAuth()
    const queryClient = useQueryClient()
    const queryKey = [BLOCKED_USERS_QUERY_KEY, customerId]
    const { data: users, isPending, isError, refetch } = useQuery({
        queryKey,
        queryFn: async () => getBlockedUsers(await getAccessTokenSilently()),
        enabled: isAuthenticated,
        retry: false,
        staleTime: 0,
    })
    const [unblockingId, setUnblockingId] = useState<string | null>(null)
    const [message, setMessage] = useState<{ text: string; failed: boolean } | null>(null)

    const unblock = async (user: BlockedUser) => {
        const name = displayName(user, t('moderation.blockedUsers.unknownUser'))
        setUnblockingId(user.customerId)
        setMessage(null)
        try {
            await unblockUser(await getAccessTokenSilently(), user.customerId)
            queryClient.setQueryData(queryKey, (current: BlockedUser[] | undefined) => current?.filter(existing => existing.customerId !== user.customerId))
            setMessage({ text: t('moderation.blockedUsers.unblocked', { name }), failed: false })
        } catch (error) {
            console.error('Failed to unblock user', error)
            setMessage({ text: t('moderation.blockedUsers.unblockFailed', { name }), failed: true })
        } finally {
            setUnblockingId(null)
        }
    }

    return (
        <div className={styles.container} data-testid="blocked-users">
            <p className={styles.note}>{t('moderation.blockedUsers.intro')}</p>
            {isPending && isAuthenticated && <p className={styles.note}>{t('moderation.blockedUsers.loading')}</p>}
            {isError && (
                <div className={styles.failed}>
                    <p className={styles.note} role="alert">{t('moderation.blockedUsers.loadFailed')}</p>
                    <PillButton variant="secondary" label={t('moderation.blockedUsers.retry')} onClick={() => refetch()} />
                </div>
            )}
            {users && users.length === 0 && <p className={styles.note} data-testid="blocked-users-empty">{t('moderation.blockedUsers.empty')}</p>}
            {users && users.length > 0 && (
                <ul className={styles.list}>
                    {users.map(user => (
                        <li key={user.customerId} className={styles.row}>
                            <span className={styles.avatar} aria-hidden="true">{initials(user)}</span>
                            <span className={styles.text}>
                                <span className={styles.name}>{displayName(user, t('moderation.blockedUsers.unknownUser'))}</span>
                                <span className={styles.date}>{t('moderation.blockedUsers.blockedOn', { date: formatServerDateOnly(user.blockedAt) })}</span>
                            </span>
                            <button
                                type="button"
                                className={styles.unblock}
                                onClick={() => unblock(user)}
                                disabled={unblockingId === user.customerId}
                                data-testid={`unblock-${user.customerId}`}
                            >
                                {unblockingId === user.customerId ? t('moderation.blockedUsers.unblocking') : t('moderation.blockedUsers.unblock')}
                            </button>
                        </li>
                    ))}
                </ul>
            )}
            {message && <p className={message.failed ? styles.error : styles.note} role="status">{message.text}</p>}
            {users && users.length > 0 && <p className={styles.note}>{t('moderation.blockedUsers.note')}</p>}
        </div>
    )
}
