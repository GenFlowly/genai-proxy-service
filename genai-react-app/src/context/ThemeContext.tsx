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

export const ThemeProvider = ({ children }: { children: ReactNode }) => {
    const [themeMode, setThemeModeState] = useState<ThemeMode>(getInitialThemeMode)
    const [theme, setThemeState] = useState<EffectiveTheme>('light')

    useEffect(() => {
        const prefersDark = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)').matches : false
        const effective: EffectiveTheme = themeMode === 'system' ? (prefersDark ? 'dark' : 'light') : themeMode

        setThemeState(effective)
        document.documentElement.setAttribute('data-theme', effective)

        if (themeMode === 'system') {
            const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
            const handleChange = (e: MediaQueryListEvent) => {
                const newTheme = e.matches ? 'dark' : 'light'
                setThemeState(newTheme)
                document.documentElement.setAttribute('data-theme', newTheme)
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
