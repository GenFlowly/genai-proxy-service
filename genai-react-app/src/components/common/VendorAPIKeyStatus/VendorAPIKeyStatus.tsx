import React from 'react'
import { AIVendor } from '../../../constants/vendors'
import { useAuth } from '../../../context/AuthContext'
import { Icon } from '../Icon/Icon'
import { ICONS } from '../../../constants/icons'

import { APIKeyStatus } from '../../../models/storeCustomerVendorAPIKeys.models'

interface VendorAPIKeyStatusProps {
    vendor: AIVendor
}

export const VendorAPIKeyStatus: React.FC<VendorAPIKeyStatusProps> = ({ vendor }) => {
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
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            {isValid ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--color-success)' }}>
                    <Icon src={ICONS.VALID} size={16} />
                    <span style={{ fontSize: '0.9rem', fontWeight: 500 }}>{currentStatus}</span>
                </div>
            ) : (
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: currentStatus === APIKeyStatus.INVALID ? 'var(--color-error)' : '#6B7280' }}>
                    <span style={{ fontSize: '0.9rem' }}>{currentStatus}</span>
                </div>
            )}
        </div>
    )
}
