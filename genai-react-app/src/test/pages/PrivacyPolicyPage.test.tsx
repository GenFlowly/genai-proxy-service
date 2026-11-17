import React from 'react'
import fs from 'fs'
import path from 'path'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import PrivacyPolicyPage, { PRIVACY_POLICY_URL } from '../../pages/PrivacyPolicyPage/PrivacyPolicyPage'

jest.mock('../../components/navbar/Navbar', () => () => <div data-testid="navbar" />)
jest.mock('../../components/widgets/MobileHeader/MobileHeader', () => ({
    __esModule: true,
    default: ({ title, swipeBack }: { title: string; swipeBack?: object }) => (
        <div data-testid="mobile-header" data-swipe-back={JSON.stringify(swipeBack ?? null)}>{title}</div>
    ),
}))

const mockUseAuth = jest.fn()
jest.mock('../../context/AuthContext', () => ({ useAuth: () => mockUseAuth() }))

const mockBreakpoints = jest.fn()
jest.mock('../../hooks/useResponsiveBreakpoints', () => ({ useResponsiveBreakpoints: () => mockBreakpoints() }))

// The library's markdown renderer doesn't run in JSDOM.
jest.mock('@genflowly/component-library', () => ({
    ...jest.requireActual('@genflowly/component-library'),
    TextContainer: ({ content, isLoading }: { content: string; isLoading?: boolean }) => (
        <div data-testid="markdown" data-loading={isLoading ? 'true' : 'false'}>{content}</div>
    ),
}))

const PUBLISHED_POLICY = path.join(__dirname, '..', '..', '..', 'public', 'privacy-policy.md')

function renderPage() {
    return render(
        <MemoryRouter initialEntries={['/privacy-policy']}>
            <PrivacyPolicyPage />
        </MemoryRouter>
    )
}

describe('PrivacyPolicyPage', () => {
    const originalFetch = global.fetch

    beforeEach(() => {
        mockBreakpoints.mockReturnValue({ isNarrow: false, isMobile: false })
        mockUseAuth.mockReturnValue({ isSessionAuthenticated: false })
        global.fetch = jest.fn()
    })

    afterEach(() => {
        global.fetch = originalFetch
        jest.restoreAllMocks()
    })

    const respond = (ok: boolean, body = '') =>
        (global.fetch as jest.Mock).mockResolvedValue({ ok, status: ok ? 200 : 404, text: async () => body })

    test('shows the published policy under the navbar on desktop', async () => {
        respond(true, "# Privacy Policy\n\nWe don't sell your data.")
        renderPage()

        expect(screen.getByTestId('markdown')).toHaveAttribute('data-loading', 'true')
        await waitFor(() => expect(screen.getByTestId('markdown')).toHaveTextContent("We don't sell your data."))
        expect(screen.getByTestId('markdown')).toHaveAttribute('data-loading', 'false')
        expect(screen.getByTestId('navbar')).toBeInTheDocument()
        expect(global.fetch).toHaveBeenCalledWith(PRIVACY_POLICY_URL, expect.objectContaining({ signal: expect.anything() }))
        expect(PRIVACY_POLICY_URL).toMatch(/\/privacy-policy\.md$/)
    })

    test('on a phone it has the mobile header instead of the navbar', async () => {
        mockBreakpoints.mockReturnValue({ isNarrow: true, isMobile: true })
        respond(true, 'Policy text')
        renderPage()

        await waitFor(() => expect(screen.getByTestId('markdown')).toHaveTextContent('Policy text'))
        expect(screen.queryByTestId('navbar')).not.toBeInTheDocument()
        expect(screen.getByTestId('mobile-header')).toHaveTextContent('Privacy policy')
    })

    test('signed in on a phone, a swipe from the left edge goes back to the Settings menu it was opened from', () => {
        mockBreakpoints.mockReturnValue({ isNarrow: true, isMobile: true })
        mockUseAuth.mockReturnValue({ isSessionAuthenticated: true })
        respond(true, 'Policy text')
        renderPage()

        expect(screen.getByTestId('mobile-header')).toHaveAttribute(
            'data-swipe-back', JSON.stringify({ to: '/settings/profile/account', state: { openMobileMenu: true } })
        )
    })

    test('signed out there is no Settings menu, so the swipe opens the L1 Menu as the header button does', () => {
        mockBreakpoints.mockReturnValue({ isNarrow: true, isMobile: true })
        respond(true, 'Policy text')
        renderPage()

        expect(screen.getByTestId('mobile-header')).toHaveAttribute('data-swipe-back', 'null')
    })

    test('a failed load says so and can be retried', async () => {
        jest.spyOn(console, 'error').mockImplementation(() => {})
        respond(false)
        renderPage()

        expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load the privacy policy.")

        respond(true, 'Policy text')
        await userEvent.click(screen.getByText('Try again'))

        await waitFor(() => expect(screen.getByTestId('markdown')).toHaveTextContent('Policy text'))
        expect(global.fetch).toHaveBeenCalledTimes(2)
    })

    test('the published text covers both modes and has no draft markers or placeholders left', () => {
        const policy = fs.readFileSync(PUBLISHED_POLICY, 'utf8')

        expect(policy).toContain('## Section 1: Bring Your Own Key (BYOK)')
        expect(policy).toContain('## Section 2: Pay-as-you-go')
        expect(policy).toContain('operated by Genflowly, based in Seattle, Washington')
        expect(policy).toContain('privacy@genflowly.com')
        expect(policy).not.toMatch(/⛔|`\[|\[[A-Z][A-Z _-]+\]/)
    })
})
