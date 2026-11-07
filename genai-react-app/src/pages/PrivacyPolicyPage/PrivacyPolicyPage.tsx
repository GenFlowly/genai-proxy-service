import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { PillButton, TextContainer } from '@genflowly/component-library'
import { DetailShell } from '../../components/DetailPage/DetailParts'
import { useResponsiveBreakpoints } from '../../hooks/useResponsiveBreakpoints'
import styles from './PrivacyPolicyPage.module.scss'

/**
 * The published policy text. It's a static file rather than part of the
 * bundle so the iOS app renders the same document.
 */
export const PRIVACY_POLICY_URL = `${process.env.PUBLIC_URL ?? ''}/privacy-policy.md`

type PolicyState = { status: 'loading' } | { status: 'loaded'; markdown: string } | { status: 'failed' }

/** /privacy-policy: the privacy policy, readable without signing in. */
export default function PrivacyPolicyPage(): React.ReactElement {
    const { t } = useTranslation()
    const { isNarrow } = useResponsiveBreakpoints()
    const [state, setState] = useState<PolicyState>({ status: 'loading' })
    const [attempt, setAttempt] = useState(0)

    useEffect(() => {
        const controller = new AbortController()
        setState({ status: 'loading' })
        fetch(PRIVACY_POLICY_URL, { signal: controller.signal })
            .then(response => {
                if (!response.ok) throw new Error(`HTTP ${response.status}`)
                return response.text()
            })
            .then(markdown => setState({ status: 'loaded', markdown }))
            .catch(error => {
                if (controller.signal.aborted) return
                console.error('Failed to load the privacy policy:', error)
                setState({ status: 'failed' })
            })
        return () => controller.abort()
    }, [attempt])

    return (
        <DetailShell
            title={t('privacyPolicy.title')}
            breadcrumbs={[{ label: t('privacyPolicy.title') }]}
            narrow={isNarrow}
            data-testid="privacy-policy-page"
        >
            <article className={styles.document}>
                {state.status === 'failed' ? (
                    <div className={styles.error} role="alert">
                        <p>{t('privacyPolicy.loadError')}</p>
                        <PillButton
                            variant="secondary"
                            label={t('privacyPolicy.retry')}
                            onClick={() => setAttempt(n => n + 1)}
                        />
                    </div>
                ) : (
                    <TextContainer
                        content={state.status === 'loaded' ? state.markdown : ''}
                        isLoading={state.status === 'loading'}
                        showCopyButton={false}
                        data-testid="privacy-policy-text"
                    />
                )}
            </article>
        </DetailShell>
    )
}
