import { useEffect } from 'react'
import { useAuth } from '../../../context/AuthContext'

/** Must match the .splash-hidden fade in public/index.html. */
const FADE_MS = 250

/** Fades out and removes the boot splash that public/index.html paints before the bundle runs. */
export function hideSplashScreen(): void {
    const splash = document.getElementById('splash')
    if (!splash || splash.classList.contains('splash-hidden')) return
    splash.classList.add('splash-hidden')
    window.setTimeout(() => splash.remove(), FADE_MS)
}

/**
 * Holds the boot splash until Auth0's session check settles. Rendered outside the app's
 * error boundary so a crash still uncovers the fallback.
 */
export function SplashScreenDismisser(): null {
    const { isLoading } = useAuth()

    useEffect(() => {
        if (!isLoading) hideSplashScreen()
    }, [isLoading])

    return null
}
