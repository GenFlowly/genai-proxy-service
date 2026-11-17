import React from 'react'
import { Link } from 'react-router'
import { Trans, useTranslation } from 'react-i18next'
import { Grid, GridCol } from '@genflowly/component-library'
import { DetailShell } from '../../components/DetailPage/DetailParts'
import { useResponsiveBreakpoints } from '../../hooks/useResponsiveBreakpoints'
import styles from './ContentRulesPage.module.scss'

/** /content-rules: what may be shared with other people, readable without signing in. */
export default function ContentRulesPage(): React.ReactElement {
    const { t } = useTranslation()
    const { isNarrow } = useResponsiveBreakpoints()
    const prohibited = t('contentRules.list', { returnObjects: true }) as string[]

    return (
        <DetailShell
            title={t('contentRules.title')}
            breadcrumbs={[{ label: t('contentRules.title') }]}
            narrow={isNarrow}
            data-testid="content-rules-page"
        >
            <div className={styles.page}>
                <Grid gap="lg">
                    <GridCol span={12} md={7}>
                        <article className={styles.article}>
                            <header className={styles.header}>
                                <h1 className={styles.title}>{t('contentRules.title')}</h1>
                                <p className={styles.scope}>{t('contentRules.scope')}</p>
                            </header>
                            <p className={styles.lead}>{t('contentRules.intro')}</p>
                            <section className={styles.section}>
                                <h2>{t('contentRules.reportsTitle')}</h2>
                                <p>{t('contentRules.reportsBody')}</p>
                            </section>
                            <section className={styles.section}>
                                <h2>{t('contentRules.blockingTitle')}</h2>
                                <p>{t('contentRules.blockingBody')}</p>
                            </section>
                            <section className={styles.section}>
                                <h2>{t('contentRules.contactTitle')}</h2>
                                <p>
                                    <Trans
                                        i18nKey="contentRules.contactBody"
                                        components={{ support: <Link to="/support" />, policy: <Link to="/privacy-policy" /> }}
                                    />
                                </p>
                            </section>
                        </article>
                    </GridCol>
                    <GridCol span={12} md={5}>
                        <aside className={styles.card}>
                            <h2>{t('contentRules.listTitle')}</h2>
                            <ul>
                                {prohibited.map(rule => <li key={rule}>{rule}</li>)}
                            </ul>
                            <p className={styles.scope}>{t('contentRules.filterNote')}</p>
                        </aside>
                    </GridCol>
                </Grid>
            </div>
        </DetailShell>
    )
}
