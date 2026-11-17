import React, { useEffect, useState } from 'react'
import { Link, useLocation, useSearchParams } from 'react-router-dom'
import { Trans, useTranslation } from 'react-i18next'
import { PillButton } from '@genflowly/component-library'
import { DetailShell } from '../../components/DetailPage/DetailParts'
import { useAuth } from '../../context/AuthContext'
import { useResponsiveBreakpoints } from '../../hooks/useResponsiveBreakpoints'
import { SUPPORT_TOPICS, SupportTopic, isSupportTopic, sendSupportRequest } from '../../services/supportService'
import styles from './SupportPage.module.scss'

export const SUPPORT_EMAIL = 'customer-support@genflowly.com'
// The support Lambda enforces the same limits.
export const NAME_MAX_CHARS = 100
export const EMAIL_MAX_CHARS = 254
export const MESSAGE_MIN_CHARS = 10
export const MESSAGE_MAX_CHARS = 5000
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

type SendState = { status: 'idle' } | { status: 'sending' } | { status: 'sent'; email: string } | { status: 'failed' }

/**
 * /support: a form that emails the support inbox. Anyone can open the page (it's the App Store
 * Support URL), but only a signed-in user can send. The iOS app opens it with
 * ?source=ios&appVersion=… so requests say where they came from.
 */
export default function SupportPage(): React.ReactElement {
    const { t } = useTranslation()
    const { isNarrow } = useResponsiveBreakpoints()
    const { user, customerId, isAuthenticated, isSessionAuthenticated, getAccessTokenSilently, loginWithRedirect } = useAuth()
    const [params] = useSearchParams()
    const location = useLocation()

    const [name, setName] = useState(user?.name ?? '')
    const [email, setEmail] = useState(user?.email ?? '')
    const [topic, setTopic] = useState<SupportTopic | ''>(() => {
        const requested = params.get('topic')
        return isSupportTopic(requested) ? requested : ''
    })
    const [message, setMessage] = useState('')
    const [website, setWebsite] = useState('')
    const [emailTouched, setEmailTouched] = useState(false)
    const [state, setState] = useState<SendState>({ status: 'idle' })

    // Auth0 can finish after the first render: fill in only what the person hasn't typed.
    const signedInName = user?.name ?? ''
    const signedInEmail = user?.email ?? ''
    useEffect(() => {
        if (signedInName) setName(current => current || signedInName)
        if (signedInEmail) setEmail(current => current || signedInEmail)
    }, [signedInName, signedInEmail])

    const trimmedEmail = email.trim()
    const emailValid = trimmedEmail.length <= EMAIL_MAX_CHARS && EMAIL_PATTERN.test(trimmedEmail)
    const messageLength = message.trim().length
    const messageValid = messageLength >= MESSAGE_MIN_CHARS && messageLength <= MESSAGE_MAX_CHARS
    const sending = state.status === 'sending'
    const canSend = emailValid && topic !== '' && messageValid && !sending

    const send = async (event?: React.FormEvent) => {
        event?.preventDefault()
        if (!canSend) {
            setEmailTouched(true)
            return
        }
        setState({ status: 'sending' })
        try {
            await sendSupportRequest(await getAccessTokenSilently(), {
                name: name.trim(),
                email: trimmedEmail,
                topic,
                message: message.trim(),
                website,
                context: {
                    source: params.get('source') === 'ios' ? 'ios' : 'web',
                    appVersion: params.get('appVersion') ?? undefined,
                    page: `${window.location.origin}${window.location.pathname}`,
                    customerId: isAuthenticated && customerId ? customerId : undefined,
                },
            })
            setState({ status: 'sent', email: trimmedEmail })
            setMessage('')
            setTopic('')
            setEmailTouched(false)
        } catch (error) {
            console.error('Failed to send the support request:', error)
            setState({ status: 'failed' })
        }
    }

    return (
        <DetailShell
            title={t('supportPage.title')}
            breadcrumbs={[{ label: t('supportPage.title') }]}
            narrow={isNarrow}
            data-testid="support-page"
        >
            <div className={styles.page}>
                {!isSessionAuthenticated ? (
                    <section className={styles.signIn} data-testid="support-sign-in">
                        <p className={styles.intro}>{t('supportPage.signInIntro')}</p>
                        <PillButton
                            label={t('supportPage.signIn')}
                            onClick={() => loginWithRedirect({ appState: { returnTo: `${location.pathname}${location.search}` } })}
                            data-testid="support-sign-in-button"
                        />
                    </section>
                ) : state.status === 'sent' ? (
                    <section className={styles.sent} role="status" data-testid="support-sent">
                        <h2 className={styles.sentTitle}>{t('supportPage.sentTitle')}</h2>
                        <p className={styles.intro}>{t('supportPage.sentBody', { email: state.email })}</p>
                        <PillButton
                            variant="secondary"
                            label={t('supportPage.sendAnother')}
                            onClick={() => setState({ status: 'idle' })}
                            data-testid="support-send-another"
                        />
                    </section>
                ) : (
                    <form className={styles.form} onSubmit={send} noValidate data-testid="support-form">
                        <p className={styles.intro}>{t('supportPage.intro')}</p>

                        <div className={styles.fieldRow}>
                            <div className={styles.field}>
                                <label className={styles.fieldLabel} htmlFor="support-name">{t('supportPage.name')}</label>
                                <input
                                    id="support-name"
                                    className={styles.input}
                                    type="text"
                                    autoComplete="name"
                                    maxLength={NAME_MAX_CHARS}
                                    value={name}
                                    onChange={event => setName(event.target.value)}
                                    data-testid="support-name"
                                />
                            </div>
                            <div className={styles.field}>
                                <label className={styles.fieldLabel} htmlFor="support-email">{t('supportPage.email')}</label>
                                <input
                                    id="support-email"
                                    className={styles.input}
                                    type="email"
                                    autoComplete="email"
                                    inputMode="email"
                                    maxLength={EMAIL_MAX_CHARS}
                                    required
                                    aria-invalid={emailTouched && !emailValid}
                                    aria-describedby={emailTouched && !emailValid ? 'support-email-error' : undefined}
                                    value={email}
                                    onChange={event => setEmail(event.target.value)}
                                    onBlur={() => setEmailTouched(true)}
                                    data-testid="support-email"
                                />
                                {emailTouched && !emailValid && (
                                    <p id="support-email-error" className={styles.fieldError} data-testid="support-email-error">
                                        {t('supportPage.emailInvalid')}
                                    </p>
                                )}
                            </div>
                        </div>

                        <div className={styles.field}>
                            <label className={styles.fieldLabel} htmlFor="support-topic">{t('supportPage.topic')}</label>
                            <select
                                id="support-topic"
                                className={styles.select}
                                required
                                value={topic}
                                onChange={event => setTopic(isSupportTopic(event.target.value) ? event.target.value : '')}
                                data-testid="support-topic"
                            >
                                <option value="" disabled>{t('supportPage.topicPlaceholder')}</option>
                                {SUPPORT_TOPICS.map(key => (
                                    <option key={key} value={key}>{t(`supportPage.topics.${key}`)}</option>
                                ))}
                            </select>
                        </div>

                        <div className={styles.field}>
                            <label className={styles.fieldLabel} htmlFor="support-message">{t('supportPage.message')}</label>
                            <textarea
                                id="support-message"
                                className={styles.textArea}
                                required
                                maxLength={MESSAGE_MAX_CHARS}
                                placeholder={t('supportPage.messagePlaceholder')}
                                aria-describedby="support-message-help"
                                value={message}
                                onChange={event => setMessage(event.target.value)}
                                data-testid="support-message"
                            />
                            <div id="support-message-help" className={styles.messageHelp}>
                                <span>{t('supportPage.messageHint', { min: MESSAGE_MIN_CHARS })}</span>
                                <span data-testid="support-message-count">
                                    {t('supportPage.messageCount', { count: message.length, max: MESSAGE_MAX_CHARS })}
                                </span>
                            </div>
                        </div>

                        <div className={styles.honeypot} aria-hidden="true">
                            <label htmlFor="support-website">Website</label>
                            <input
                                id="support-website"
                                name="website"
                                type="text"
                                tabIndex={-1}
                                autoComplete="off"
                                value={website}
                                onChange={event => setWebsite(event.target.value)}
                                data-testid="support-website"
                            />
                        </div>

                        {isAuthenticated && customerId && (
                            <p className={styles.help} data-testid="support-account-note">{t('supportPage.accountNote')}</p>
                        )}

                        {state.status === 'failed' && (
                            <p className={styles.error} role="alert" data-testid="support-error">
                                <Trans
                                    i18nKey="supportPage.failed"
                                    values={{ email: SUPPORT_EMAIL }}
                                    components={{ mail: <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a> }}
                                />
                            </p>
                        )}

                        <div className={styles.actions}>
                            <PillButton
                                type="submit"
                                label={sending ? t('supportPage.sending') : t('supportPage.send')}
                                disabled={!canSend}
                                data-testid="support-send"
                            />
                        </div>

                        <p className={styles.help}>
                            <Trans i18nKey="supportPage.privacyNote" components={{ policy: <Link to="/privacy-policy" /> }} />
                        </p>
                    </form>
                )}
            </div>
        </DetailShell>
    )
}
