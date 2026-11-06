import React from 'react'
import { render } from '@testing-library/react'
import '@testing-library/jest-dom'

jest.mock('../../../../context/AuthContext', () => ({
    useAuth: jest.fn(),
}))

import { useAuth } from '../../../../context/AuthContext'
import { hideSplashScreen, SplashScreenDismisser } from '../../../../components/common/SplashScreen/SplashScreen'

const mockUseAuth = useAuth as jest.Mock

function mountSplash(): HTMLElement {
    const splash = document.createElement('div')
    splash.id = 'splash'
    document.body.appendChild(splash)
    return splash
}

describe('hideSplashScreen', () => {
    beforeEach(() => {
        jest.useFakeTimers()
    })

    afterEach(() => {
        jest.useRealTimers()
        document.getElementById('splash')?.remove()
    })

    test('fades the splash out, then removes it', () => {
        const splash = mountSplash()

        hideSplashScreen()
        expect(splash).toHaveClass('splash-hidden')
        expect(document.getElementById('splash')).toBe(splash)

        jest.advanceTimersByTime(250)
        expect(document.getElementById('splash')).toBeNull()
    })

    test('does nothing when there is no splash', () => {
        expect(() => hideSplashScreen()).not.toThrow()
        expect(jest.getTimerCount()).toBe(0)
    })

    test('a second call while fading schedules no second removal', () => {
        mountSplash()

        hideSplashScreen()
        hideSplashScreen()
        expect(jest.getTimerCount()).toBe(1)
    })
})

describe('SplashScreenDismisser', () => {
    beforeEach(() => {
        jest.useFakeTimers()
    })

    afterEach(() => {
        jest.useRealTimers()
        document.getElementById('splash')?.remove()
    })

    test('keeps the splash while the session check runs', () => {
        const splash = mountSplash()
        mockUseAuth.mockReturnValue({ isLoading: true })

        render(<SplashScreenDismisser />)
        jest.advanceTimersByTime(1000)

        expect(splash).not.toHaveClass('splash-hidden')
        expect(document.getElementById('splash')).toBe(splash)
    })

    test('lifts the splash once the session check settles', () => {
        mountSplash()
        mockUseAuth.mockReturnValue({ isLoading: true })
        const { rerender } = render(<SplashScreenDismisser />)

        mockUseAuth.mockReturnValue({ isLoading: false })
        rerender(<SplashScreenDismisser />)
        jest.advanceTimersByTime(250)

        expect(document.getElementById('splash')).toBeNull()
    })
})
