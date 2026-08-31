import React from 'react'
import { useAuth } from '../../../context/AuthContext'
import { Icon } from '@genflowly/component-library'
import { ICONS } from '../../../constants/icons'
import { VectorDBConfigStatusValue } from '../../../models/storeCustomerVectorDBConfig.models'

interface CustomerVectorDBConfigStatusProps {
    vendor: string
    'data-testid'?: string
}

export const CustomerVectorDBConfigStatus: React.FC<CustomerVectorDBConfigStatusProps> = ({ vendor, 'data-testid': testId }) => {
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
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }} data-testid={testId}>
            {isPresent ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--color-success)' }} data-testid={testId ? `${testId}-present` : undefined}>
                    <Icon src={ICONS.VALID} size={16} data-testid={testId ? `${testId}-icon` : undefined} />
                    <span style={{ fontSize: '0.9rem', fontWeight: 500 }} data-testid={testId ? `${testId}-text` : undefined}>{currentStatus}</span>
                </div>
            ) : (
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: '#6B7280' }} data-testid={testId ? `${testId}-other` : undefined}>
                    <span style={{ fontSize: '0.9rem' }} data-testid={testId ? `${testId}-text` : undefined}>{currentStatus}</span>
                </div>
            )}
        </div>
    )
}
