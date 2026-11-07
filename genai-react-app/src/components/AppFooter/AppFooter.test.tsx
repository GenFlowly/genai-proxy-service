import React from 'react'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import AppFooter, { FOOTER_HEIGHT_VARIABLE } from './AppFooter'

function renderFooter() {
    return render(
        <MemoryRouter>
            <AppFooter />
        </MemoryRouter>
    )
}

describe('AppFooter', () => {
    test('names the company and links to the privacy policy', () => {
        renderFooter()

        expect(screen.getByTestId('app-footer')).toHaveTextContent(`© ${new Date().getFullYear()} Genflowly`)
        expect(screen.getByTestId('app-footer-privacy-policy')).toHaveAttribute('href', '/privacy-policy')
    })

    test('pages leave room for it while it is shown, and get the room back when it goes', () => {
        const { unmount } = renderFooter()
        expect(document.documentElement.style.getPropertyValue(FOOTER_HEIGHT_VARIABLE)).toBe('32px')

        unmount()
        expect(document.documentElement.style.getPropertyValue(FOOTER_HEIGHT_VARIABLE)).toBe('')
    })
})
