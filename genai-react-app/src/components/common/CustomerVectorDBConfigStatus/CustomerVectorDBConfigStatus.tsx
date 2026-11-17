import React from 'react'
import { useAuth } from '../../../context/AuthContext'
import { useTranslation } from 'react-i18next'
import { StatusPill } from '@genflowly/component-library'
import { VectorDBConfigStatusValue } from '../../../models/storeCustomerVectorDBConfig.models'

interface CustomerVectorDBConfigStatusProps {
    vendor: string
    'data-testid'?: string
}

export const CustomerVectorDBConfigStatus: React.FC<CustomerVectorDBConfigStatusProps> = ({ vendor, 'data-testid': testId }) => {
    const { t } = useTranslation()
    const { vectorDBConfigStatusList } = useAuth()

    const getStatus = (): VectorDBConfigStatusValue => {
        const vendorStatus = vectorDBConfigStatusList.find(s => s.vendor.toLowerCase() === vendor.toLowerCase())

        if (vendorStatus?.status) {
            return vendorStatus.status
        }

        return VectorDBConfigStatusValue.NOT_SET
    }

    const currentStatus = getStatus()
    const isPresent = currentStatus === VectorDBConfigStatusValue.PRESENT

    return (
        <StatusPill kind={isPresent ? 'ok' : 'unset'} data-testid={testId}>
            <span data-testid={testId ? `${testId}-${isPresent ? 'present' : 'other'}` : undefined}>
                {isPresent ? t('settingsPage.vectorDb.connected') : t('settingsPage.vectorDb.notConnected')}
            </span>
        </StatusPill>
    )
}
