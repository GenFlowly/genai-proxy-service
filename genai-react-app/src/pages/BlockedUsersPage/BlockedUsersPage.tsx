import React from 'react'
import { useTranslation } from 'react-i18next'
import { DetailShell } from '../../components/DetailPage/DetailParts'
import { BlockedUsersList } from '../../components/common/BlockedUsersList/BlockedUsersList'
import { useResponsiveBreakpoints } from '../../hooks/useResponsiveBreakpoints'

/** The phone's page for the Blocked users list; desktop shows it inside Settings › Profile. */
export default function BlockedUsersPage(): React.ReactElement {
    const { t } = useTranslation()
    const { isNarrow } = useResponsiveBreakpoints()
    return (
        <DetailShell
            title={t('moderation.blockedUsers.title')}
            breadcrumbs={[{ label: t('moderation.blockedUsers.title') }]}
            back={{ label: t('moderation.blockedUsers.settingsLabel'), to: '/settings/profile' }}
            narrow={isNarrow}
            data-testid="blocked-users-page"
        >
            <BlockedUsersList />
        </DetailShell>
    )
}
