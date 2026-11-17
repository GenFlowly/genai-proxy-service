import React from 'react'
import { useTranslation } from 'react-i18next'
import { getEmbeddingUsage } from '../../../../services/getUsageService'
import { useHasOwnKeys } from '../../../../hooks/useHasOwnKeys'
import { useEmbeddingVendorName } from '../../../../hooks/useEmbeddingVendorName'
import { UsageCostView } from './UsageCostView'

/** Cost and Usage › Embedding Models: each chat saved for search and each search run. */
export function EmbeddingUsageSettings(): React.ReactElement {
    const { t } = useTranslation()
    const hasOwnKeys = useHasOwnKeys()
    const vendorName = useEmbeddingVendorName()
    const knowledge = [
        { title: t('settingsPage.usageCommon.countedTitle'), text: t('settingsPage.embeddingUsageSettings.countedText') },
        { title: t('settingsPage.usageCommon.costTitle'), text: hasOwnKeys ? t('settingsPage.usageCommon.costOwnKeys') : t('settingsPage.usageCommon.costAppKeys') },
        { title: t('settingsPage.embeddingUsageSettings.zeroTitle'), text: t('settingsPage.embeddingUsageSettings.zeroText') },
    ]
    return <UsageCostView page="usage-embedding-models" knowledge={knowledge} load={getEmbeddingUsage} vendorName={vendorName} data-testid="embedding-usage" />
}
