import React, { createContext, useContext, useEffect, useState, ReactNode } from 'react'

export type ThemeMode = 'light' | 'dark' | 'system'
export type EffectiveTheme = 'light' | 'dark'

interface ThemeContextType {
    theme: EffectiveTheme
    themeMode: ThemeMode
    setThemeMode: (mode: ThemeMode) => void
    cycleTheme: () => void
    // Keep for backward compatibility in tests
    setTheme: (theme: EffectiveTheme) => void
    toggleTheme: () => void
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined)

const getInitialThemeMode = (): ThemeMode => {
    return (localStorage.getItem('theme') as ThemeMode | null) || 'system'
}

// Mirrors --color-primary from themes.scss for each theme. The browser/OS
// chrome (PWA title bar, status bar, task switcher) reads the <meta
// name="theme-color"> tag, which can't reference a CSS variable, so the
// value is kept in sync here instead.
const PRIMARY_COLOR: Record<EffectiveTheme, string> = {
    light: '#006BE8',
    dark: '#0a84ff',
}

// data-color-mode drives third-party @uiw components (markdown editor/preview),
// which otherwise fall back to the browser's prefers-color-scheme instead of the app theme
const applyThemeAttributes = (theme: EffectiveTheme) => {
    document.documentElement.setAttribute('data-theme', theme)
    document.documentElement.setAttribute('data-color-mode', theme)
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', PRIMARY_COLOR[theme])
}

export const ThemeProvider = ({ children }: { children: ReactNode }) => {
    const [themeMode, setThemeModeState] = useState<ThemeMode>(getInitialThemeMode)
    const [theme, setThemeState] = useState<EffectiveTheme>('light')

    useEffect(() => {
        const prefersDark = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)').matches : false
        const effective: EffectiveTheme = themeMode === 'system' ? (prefersDark ? 'dark' : 'light') : themeMode

        setThemeState(effective)
        applyThemeAttributes(effective)

        if (themeMode === 'system') {
            const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
            const handleChange = (e: MediaQueryListEvent) => {
                const newTheme = e.matches ? 'dark' : 'light'
                setThemeState(newTheme)
                applyThemeAttributes(newTheme)
            }
            if (mediaQuery.addEventListener) {
                mediaQuery.addEventListener('change', handleChange)
                return () => mediaQuery.removeEventListener('change', handleChange)
            }
        }
    }, [themeMode])

    const setThemeMode = (mode: ThemeMode) => {
        setThemeModeState(mode)
        localStorage.setItem('theme', mode)
    }

    const cycleTheme = () => {
        if (themeMode === 'system') setThemeMode('light')
        else if (themeMode === 'light') setThemeMode('dark')
        else setThemeMode('system')
    }

    const setTheme = (newTheme: EffectiveTheme) => {
        setThemeMode(newTheme)
    }

    const toggleTheme = () => {
        const newTheme = theme === 'light' ? 'dark' : 'light'
        setThemeMode(newTheme)
    }

    return (
        <ThemeContext.Provider value={{ theme, themeMode, setThemeMode, cycleTheme, setTheme, toggleTheme }}>
            {children}
        </ThemeContext.Provider>
    )
}

export const useTheme = () => {
    const context = useContext(ThemeContext)
    if (!context) {
        throw new Error('useTheme must be used within a ThemeProvider')
    }
    return context
}
