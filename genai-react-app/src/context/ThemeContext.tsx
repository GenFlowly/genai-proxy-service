import React, { createContext, useContext, useEffect, useState, ReactNode } from 'react'

type Theme = 'light' | 'dark'

interface ThemeContextType {
    theme: Theme
    setTheme: (theme: Theme) => void
    toggleTheme: () => void
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined)

export const ThemeProvider = ({ children }: { children: ReactNode }) => {
    const [theme, setThemeState] = useState<Theme>('light')

    // Initialize theme on mount
    useEffect(() => {
        // Check if user has a saved preference
        const savedTheme = localStorage.getItem('theme') as Theme | null

        if (savedTheme) {
            setThemeState(savedTheme)
            document.documentElement.setAttribute('data-theme', savedTheme)
        } else {
            // Use system preference
            const prefersDark = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)').matches : false
            const systemTheme = prefersDark ? 'dark' : 'light'
            setThemeState(systemTheme)
            document.documentElement.setAttribute('data-theme', systemTheme)
        }

        // Listen for system theme changes
        let mediaQuery: MediaQueryList | null = null
        if (window.matchMedia) {
            mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
        }

        const handleChange = (e: MediaQueryListEvent) => {
            // Only update if user hasn't set a preference
            if (!localStorage.getItem('theme')) {
                const newTheme = e.matches ? 'dark' : 'light'
                setThemeState(newTheme)
                document.documentElement.setAttribute('data-theme', newTheme)
            }
        }

        if (mediaQuery) {
            mediaQuery.addEventListener('change', handleChange)
        }
        return () => {
            if (mediaQuery) {
                mediaQuery.removeEventListener('change', handleChange)
            }
        }
    }, [])

    const setTheme = (newTheme: Theme) => {
        setThemeState(newTheme)
        document.documentElement.setAttribute('data-theme', newTheme)
        localStorage.setItem('theme', newTheme)
    }

    const toggleTheme = () => {
        const newTheme = theme === 'light' ? 'dark' : 'light'
        setTheme(newTheme)
    }

    return (
        <ThemeContext.Provider value={{ theme, setTheme, toggleTheme }}>
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
