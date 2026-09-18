import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../../../context/AuthContext'
import { storeCustomerVectorDBConfig } from '../../../services/storeCustomerVectorDBConfigService'
import { CredentialCard, PillButton } from '@genflowly/component-library'
import { ICONS } from '../../../constants/icons'
import { InputTextWithHint } from '@genflowly/component-library'
import { CustomerVectorDBConfigStatus } from '../../common/CustomerVectorDBConfigStatus/CustomerVectorDBConfigStatus'
import { useToast } from '../../../context/ToastContext'
import styles from './DatabaseConnectionsSettingsWidget.module.scss'

export default function DatabaseConnectionsSettingsWidget(): React.ReactElement {
    const { t } = useTranslation()
    const { customerId, getAccessTokenSilently, isAuthenticated, updateVectorDBConfigStatus } = useAuth()
    const { showToast } = useToast()

    const [zillizEndpoint, setZillizEndpoint] = useState<string>('')
    const [zillizToken, setZillizToken] = useState<string>('')
    const [savingZilliz, setSavingZilliz] = useState<boolean>(false)

    const handleSaveZilliz = async () => {
        if (!isAuthenticated || !customerId) {
            showToast(t('dbSettings.databaseConnectionsSettingsWidget.pleaseLogInFirst'))
            return
        }

        const endpointValue = zillizEndpoint.trim()
        const tokenValue = zillizToken.trim()

        if (!endpointValue || !tokenValue) {
            showToast(t('dbSettings.databaseConnectionsSettingsWidget.enterEndpointAndToken'))
            return
        }

        const endpointRegex = /^https:\/\/[a-zA-Z0-9-]+\.(?:serverless|dedicated)\.[a-zA-Z0-9-]+\.cloud\.zilliz\.com\/?$/i
        if (!endpointRegex.test(endpointValue)) {
            showToast(t('dbSettings.databaseConnectionsSettingsWidget.invalidZillizEndpoint'))
            return
        }

        const tokenRegex = /^[a-fA-F0-9]{64,}$/
        if (!tokenRegex.test(tokenValue)) {
            showToast(t('dbSettings.databaseConnectionsSettingsWidget.invalidZillizToken'))
            return
        }

        setSavingZilliz(true)
        try {
            const token = await getAccessTokenSilently()
            const response = await storeCustomerVectorDBConfig(token, {
                vendor: 'Zilliz',
                endpoint: zillizEndpoint,
                token: zillizToken
            })

            if (response.configStatus && response.configStatus.updateSuccessful) {
                updateVectorDBConfigStatus(response.configStatus)
            }
            setZillizEndpoint('')
            setZillizToken('')
            showToast(t('dbSettings.databaseConnectionsSettingsWidget.zillizSavedSuccessfully'))
        } catch (error: any) {
            console.error(error)
            showToast(error.message || t('dbSettings.databaseConnectionsSettingsWidget.errorSavingZilliz'))
        } finally {
            setSavingZilliz(false)
        }
    }

    return (
        <div className={styles.form}>
            <CredentialCard
                label={t('dbSettings.databaseConnectionsSettingsWidget.milvusCloud')}
                pills={<CustomerVectorDBConfigStatus vendor="Zilliz" />}
                data-testid="vector-db-zilliz"
            >
                <div className={styles.inputsGroup}>
                    <InputTextWithHint
                        hint={t('dbSettings.databaseConnectionsSettingsWidget.endpointHint')}
                        value={zillizEndpoint}
                        onChange={e => setZillizEndpoint(e.target.value)}
                        placeholder={t('dbSettings.databaseConnectionsSettingsWidget.zillizEndpointPlaceholder')}
                    />
                    <InputTextWithHint
                        hint={t('dbSettings.databaseConnectionsSettingsWidget.tokenHint')}
                        value={zillizToken}
                        onChange={e => setZillizToken(e.target.value)}
                        placeholder={t('dbSettings.databaseConnectionsSettingsWidget.zillizTokenPlaceholder')}
                    />
                </div>
                <div className={styles.cardFooter}>
                    <PillButton
                        onClick={handleSaveZilliz}
                        label={savingZilliz ? t('dbSettings.databaseConnectionsSettingsWidget.saving') : t('dbSettings.databaseConnectionsSettingsWidget.save')}
                        icon={ICONS.SAVE_ICON}
                        disabled={savingZilliz || !zillizEndpoint.trim() || !zillizToken.trim()}
                    />
                </div>
            </CredentialCard>
        </div>
    )
}
