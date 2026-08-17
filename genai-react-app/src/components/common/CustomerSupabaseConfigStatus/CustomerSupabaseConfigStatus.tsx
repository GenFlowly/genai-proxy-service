import React from 'react'
import { useAuth } from '../../../context/AuthContext'
import { Icon } from '@genflowly/component-library'
import { ICONS } from '../../../constants/icons'
import { SupabaseConfigStatusValue } from '../../../models/storeCustomerSupabaseConfig.models'

interface CustomerSupabaseConfigStatusProps {
    'data-testid'?: string
}

export const CustomerSupabaseConfigStatus: React.FC<CustomerSupabaseConfigStatusProps> = ({ 'data-testid': testId }) => {
    const { supabaseConfigStatus } = useAuth()

    const currentStatus = supabaseConfigStatus?.status || SupabaseConfigStatusValue.NOT_SET
    const isPresent = currentStatus === SupabaseConfigStatusValue.PRESENT

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
