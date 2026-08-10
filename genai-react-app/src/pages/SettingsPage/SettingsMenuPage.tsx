import React from 'react'
import { SettingsSidebar } from './components/SettingsSidebar'

/**
 * Mobile-only full-page view of the Settings menu.
 * Reuses SettingsSidebar (in its fullPage variant) so the menu items and
 * styles are defined in one place — the desktop sidebar.
 */
export default function SettingsMenuPage(): React.ReactElement {
    return <SettingsSidebar fullPage />
}
