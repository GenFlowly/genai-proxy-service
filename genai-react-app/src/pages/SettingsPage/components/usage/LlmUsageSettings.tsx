import React from 'react'
import { useTranslation } from 'react-i18next'
import { getLlmUsage } from '../../../../services/getUsageService'
import { useHasOwnKeys } from '../../../../hooks/useHasOwnKeys'
import { UsageCostView } from './UsageCostView'

/** Cost and Usage › LLM Models: every message sent to an AI provider, with its cost. */
export function LlmUsageSettings(): React.ReactElement {
    const { t } = useTranslation()
    const hasOwnKeys = useHasOwnKeys()
    const knowledge = [
        { title: t('settingsPage.usageCommon.countedTitle'), text: t('settingsPage.llmUsageSettings.countedText') },
        { title: t('settingsPage.usageCommon.costTitle'), text: hasOwnKeys ? t('settingsPage.usageCommon.costOwnKeys') : t('settingsPage.usageCommon.costAppKeys') },
    ]
    return <UsageCostView page="llm-models" knowledge={knowledge} load={getLlmUsage} showCacheTokens data-testid="llm-usage" />
}
