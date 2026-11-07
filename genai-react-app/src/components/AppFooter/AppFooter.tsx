import React, { useLayoutEffect } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import styles from './AppFooter.module.scss'

/** Pages size themselves to the window minus this. */
export const FOOTER_HEIGHT_VARIABLE = '--app-footer-height'
const FOOTER_HEIGHT = '32px'

/**
 * The desktop footer under every page. It sets the height pages leave free
 * while it's shown; phones have no footer, so the variable stays unset there.
 */
export default function AppFooter(): React.ReactElement {
    const { t } = useTranslation()

    useLayoutEffect(() => {
        const root = document.documentElement
        root.style.setProperty(FOOTER_HEIGHT_VARIABLE, FOOTER_HEIGHT)
        return () => {
            root.style.removeProperty(FOOTER_HEIGHT_VARIABLE)
        }
    }, [])

    return (
        <footer className={styles.footer} data-testid="app-footer">
            <span>{t('layout.footer.copyright', { year: new Date().getFullYear() })}</span>
            <Link to="/privacy-policy" className={styles.link} data-testid="app-footer-privacy-policy">
                {t('layout.footer.privacyPolicy')}
            </Link>
        </footer>
    )
}
