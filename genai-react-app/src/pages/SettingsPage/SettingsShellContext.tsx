import { createContext, useContext } from 'react'

/** What the current settings page tells the shell's phone header. */
export interface SettingsHeaderInfo {
    /** Short status after the section in the header's subtitle, e.g. "2 set". */
    statusText?: string
    /** The page has knowledge cards, so the header shows the info button. */
    hasKnowledge: boolean
}

export interface SettingsShellValue {
    /** Below isNarrow: phone layout, knowledge in the info drawer. */
    narrow: boolean
    infoOpen: boolean
    openInfo: () => void
    closeInfo: () => void
    setHeader: (header: SettingsHeaderInfo | null) => void
}

export const SettingsShellContext = createContext<SettingsShellValue>({
    narrow: false,
    infoOpen: false,
    openInfo: () => {},
    closeInfo: () => {},
    setHeader: () => {},
})

export function useSettingsShell(): SettingsShellValue {
    return useContext(SettingsShellContext)
}
