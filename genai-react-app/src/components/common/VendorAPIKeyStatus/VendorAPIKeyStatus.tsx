import React from 'react'
import { AIVendor } from '../../../constants/vendors'
import { useAuth } from '../../../context/AuthContext'
import { Icon } from '@genflowly/component-library'
import { ICONS } from '../../../constants/icons'

import { APIKeyStatus } from '../../../models/storeCustomerVendorAPIKeys.models'

interface VendorAPIKeyStatusProps {
    vendor: AIVendor
    'data-testid'?: string
}

export const VendorAPIKeyStatus: React.FC<VendorAPIKeyStatusProps> = ({ vendor, 'data-testid': testId }) => {
    const { aiVendorAPIKeyStatusList } = useAuth()

    const getStatus = (): APIKeyStatus => {
        const vendorStatus = aiVendorAPIKeyStatusList.find(s => s.aiVendor === vendor)

        if (vendorStatus?.status) {
            return vendorStatus.status
        }

        return vendorStatus?.isAPIKeyValid ? APIKeyStatus.VALID : APIKeyStatus.NOT_SET
    }

    const currentStatus = getStatus()
    const isValid = currentStatus === APIKeyStatus.VALID

    return (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }} data-testid={testId}>
            {isValid ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--color-success)' }} data-testid={testId ? `${testId}-valid` : undefined}>
                    <Icon src={ICONS.VALID} size={16} data-testid={testId ? `${testId}-icon` : undefined} />
                    <span style={{ fontSize: '0.9rem', fontWeight: 500 }} data-testid={testId ? `${testId}-text` : undefined}>{currentStatus}</span>
                </div>
            ) : (
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: currentStatus === APIKeyStatus.INVALID ? 'var(--color-error)' : '#6B7280' }} data-testid={testId ? `${testId}-other` : undefined}>
                    <span style={{ fontSize: '0.9rem' }} data-testid={testId ? `${testId}-text` : undefined}>{currentStatus}</span>
                </div>
            )}
        </div>
    )
}
