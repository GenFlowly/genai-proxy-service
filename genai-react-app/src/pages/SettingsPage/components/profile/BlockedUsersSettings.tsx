import React from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { SettingsCard, StatusPill } from '@genflowly/component-library'
import { useAuth } from '../../../../context/AuthContext'
import { BLOCKED_USERS_QUERY_KEY } from '../../../../hooks/queries/queryKeys'
import { getBlockedUsers } from '../../../../services/moderationService'
import { BlockedUsersList } from '../../../../components/common/BlockedUsersList/BlockedUsersList'
import { SettingsFrame } from '../SettingsFrame'

/** Profile › Blocked users: the people you blocked, with Unblock. */
export function BlockedUsersSettings(): React.ReactElement {
    const { t } = useTranslation()
    const { customerId, isAuthenticated, getAccessTokenSilently } = useAuth()
    // Same query the list runs, so the count and the list never disagree
    const { data: users } = useQuery({
        queryKey: [BLOCKED_USERS_QUERY_KEY, customerId],
        queryFn: async () => getBlockedUsers(await getAccessTokenSilently()),
        enabled: isAuthenticated,
        retry: false,
        staleTime: 0,
    })
    const count = users?.length
    const statusText = count != null ? t('settingsPage.blocked.count', { count }) : undefined

    const knowledge = [
        { title: t('settingsPage.blocked.howTitle'), text: t('settingsPage.blocked.howText') },
        { title: t('settingsPage.blocked.whatTitle'), text: t('settingsPage.blocked.whatText') },
        { title: t('settingsPage.blocked.undoTitle'), text: t('settingsPage.blocked.undoText') },
    ]

    return (
        <SettingsFrame
            page="blocked"
            knowledge={knowledge}
            statusText={statusText}
            status={statusText ? <StatusPill>{statusText}</StatusPill> : undefined}
        >
            <SettingsCard title={t('settingsPage.blocked.card')} flush>
                <BlockedUsersList />
            </SettingsCard>
        </SettingsFrame>
    )
}
