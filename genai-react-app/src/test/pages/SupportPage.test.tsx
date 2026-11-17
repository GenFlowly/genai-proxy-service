import React from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import SupportPage, { MESSAGE_MAX_CHARS, SUPPORT_EMAIL } from '../../pages/SupportPage/SupportPage'
import { useAuth } from '../../context/AuthContext'
import { sendSupportRequest } from '../../services/supportService'

jest.mock('../../components/navbar/Navbar', () => () => <div data-testid="navbar" />)
jest.mock('../../components/widgets/MobileHeader/MobileHeader', () => ({
    __esModule: true,
    default: ({ title }: { title: string }) => <div data-testid="mobile-header">{title}</div>,
}))
jest.mock('../../context/AuthContext')
jest.mock('../../services/supportService', () => ({
    ...jest.requireActual('../../services/supportService'),
    sendSupportRequest: jest.fn(),
}))

const mockBreakpoints = jest.fn()
jest.mock('../../hooks/useResponsiveBreakpoints', () => ({ useResponsiveBreakpoints: () => mockBreakpoints() }))

const mockUseAuth = useAuth as jest.Mock
const mockSend = sendSupportRequest as jest.Mock

const mockGetToken = jest.fn()
const mockLogin = jest.fn()
const auth = (state: object) => ({ getAccessTokenSilently: mockGetToken, loginWithRedirect: mockLogin, ...state })

const SIGNED_OUT = auth({ user: null, customerId: null, isAuthenticated: false, isSessionAuthenticated: false })
// Signed in to Auth0 before the account's profile has loaded: nothing to fill in yet.
const SESSION_ONLY = auth({ user: { sub: 'auth0|1', email: '', name: '' }, customerId: null, isAuthenticated: false, isSessionAuthenticated: true })
const SIGNED_IN = auth({
    user: { sub: 'auth0|1', email: 'jane@example.com', name: 'Jane Doe' },
    customerId: 'CU20EA760EBA18',
    isAuthenticated: true,
    isSessionAuthenticated: true,
})
const MESSAGE = 'The send button does nothing after I attach a photo.'

function renderPage(path = '/support') {
    return render(
        <MemoryRouter initialEntries={[path]}>
            <SupportPage />
        </MemoryRouter>
    )
}

async function fillForm({ email = 'sam@example.com', topic = 'bug', message = MESSAGE } = {}) {
    if (email) await userEvent.type(screen.getByTestId('support-email'), email)
    if (topic) await userEvent.selectOptions(screen.getByTestId('support-topic'), topic)
    if (message) await userEvent.type(screen.getByTestId('support-message'), message)
}

async function sendAndWaitForConfirmation() {
    await userEvent.click(screen.getByTestId('support-send'))
    await screen.findByTestId('support-sent')
}

describe('SupportPage', () => {
    beforeEach(() => {
        jest.clearAllMocks()
        mockBreakpoints.mockReturnValue({ isNarrow: false, isMobile: false })
        mockUseAuth.mockReturnValue(SESSION_ONLY)
        mockGetToken.mockResolvedValue('token-1')
        mockSend.mockResolvedValue('req-1')
    })

    test('signed out, it asks to sign in instead of showing the form, and never shows the support address', async () => {
        mockUseAuth.mockReturnValue(SIGNED_OUT)
        renderPage('/support?source=ios&appVersion=1.0%20(12)')

        expect(screen.queryByTestId('support-form')).not.toBeInTheDocument()
        expect(screen.getByTestId('support-sign-in')).toHaveTextContent('Sign in to send us a message')
        expect(screen.getByTestId('support-page')).not.toHaveTextContent(SUPPORT_EMAIL)
        expect(screen.queryByRole('link', { name: SUPPORT_EMAIL })).not.toBeInTheDocument()

        await userEvent.click(screen.getByTestId('support-sign-in-button'))

        expect(mockLogin).toHaveBeenCalledWith({ appState: { returnTo: '/support?source=ios&appVersion=1.0%20(12)' } })
        expect(mockSend).not.toHaveBeenCalled()
    })

    test('signed in, it starts with an empty topic and message under the navbar and only sends once the form is complete', async () => {
        renderPage()

        expect(screen.getByTestId('navbar')).toBeInTheDocument()
        expect(screen.getByTestId('support-name')).toHaveValue('')
        expect(screen.getByTestId('support-email')).toHaveValue('')
        expect(screen.getByTestId('support-topic')).toHaveValue('')
        expect(screen.queryByTestId('support-account-note')).not.toBeInTheDocument()
        expect(screen.getByTestId('support-send')).toBeDisabled()

        await fillForm()

        expect(screen.getByTestId('support-send')).toBeEnabled()
    })

    test('sends what was typed, trimmed, with where it came from', async () => {
        renderPage()
        await userEvent.type(screen.getByTestId('support-name'), '  Sam  ')
        await fillForm({ email: ' sam@example.com ', message: `  ${MESSAGE}  ` })

        await sendAndWaitForConfirmation()

        expect(mockSend).toHaveBeenCalledTimes(1)
        expect(mockSend).toHaveBeenCalledWith('token-1', {
            name: 'Sam',
            email: 'sam@example.com',
            topic: 'bug',
            message: MESSAGE,
            website: '',
            context: { source: 'web', appVersion: undefined, page: `${window.location.origin}/`, customerId: undefined },
        })
    })

    test('signed in, it fills in the name and email and sends the account ID', async () => {
        mockUseAuth.mockReturnValue(SIGNED_IN)
        renderPage()

        expect(screen.getByTestId('support-name')).toHaveValue('Jane Doe')
        expect(screen.getByTestId('support-email')).toHaveValue('jane@example.com')
        expect(screen.getByTestId('support-account-note')).toHaveTextContent('Your account ID is sent with this message')

        await fillForm({ email: '' })
        await sendAndWaitForConfirmation()

        expect(mockSend.mock.calls[0][1]).toMatchObject({
            name: 'Jane Doe',
            email: 'jane@example.com',
            context: { customerId: 'CU20EA760EBA18' },
        })
    })

    test("a sign-in that finishes later fills in only what's still empty", async () => {
        const { rerender } = renderPage()
        await userEvent.type(screen.getByTestId('support-name'), 'Typed name')

        mockUseAuth.mockReturnValue(SIGNED_IN)
        rerender(
            <MemoryRouter initialEntries={['/support']}>
                <SupportPage />
            </MemoryRouter>
        )

        expect(screen.getByTestId('support-name')).toHaveValue('Typed name')
        expect(screen.getByTestId('support-email')).toHaveValue('jane@example.com')
    })

    test('the iOS app passes its source, version and a topic in the URL', async () => {
        renderPage('/support?source=ios&appVersion=1.0%20(12)&topic=privacy')

        expect(screen.getByTestId('support-topic')).toHaveValue('privacy')
        await fillForm({ topic: '' })
        await sendAndWaitForConfirmation()

        expect(mockSend.mock.calls[0][1]).toMatchObject({ topic: 'privacy', context: { source: 'ios', appVersion: '1.0 (12)' } })
    })

    test('an unknown topic or source in the URL is ignored', async () => {
        renderPage('/support?source=android&topic=refund')

        expect(screen.getByTestId('support-topic')).toHaveValue('')
        await fillForm()
        await sendAndWaitForConfirmation()

        expect(mockSend.mock.calls[0][1].context.source).toBe('web')
    })

    test('a bad email address is pointed out once the field is left', async () => {
        renderPage()
        const email = screen.getByTestId('support-email')

        await userEvent.type(email, 'jane@example')
        expect(screen.queryByTestId('support-email-error')).not.toBeInTheDocument()

        await userEvent.tab()
        expect(screen.getByTestId('support-email-error')).toHaveTextContent('Enter an email address we can reply to.')
        expect(email).toHaveAttribute('aria-invalid', 'true')

        await userEvent.type(email, '.com')
        expect(screen.queryByTestId('support-email-error')).not.toBeInTheDocument()
    })

    test('submitting an incomplete form sends nothing and flags the email', () => {
        renderPage()

        fireEvent.submit(screen.getByTestId('support-form'))

        expect(mockSend).not.toHaveBeenCalled()
        expect(screen.getByTestId('support-email-error')).toBeInTheDocument()
    })

    test('a message needs ten characters and shows its length against the limit', async () => {
        renderPage()
        await fillForm({ message: 'Too short' })

        expect(screen.getByTestId('support-message-count')).toHaveTextContent(`9 / ${MESSAGE_MAX_CHARS}`)
        expect(screen.getByTestId('support-send')).toBeDisabled()

        await userEvent.type(screen.getByTestId('support-message'), '!')
        expect(screen.getByTestId('support-send')).toBeEnabled()
    })

    test('while sending the button says so, then the page confirms and can start over', async () => {
        let finish: (id: string) => void = () => {}
        mockSend.mockReturnValue(new Promise<string>(resolve => { finish = resolve }))
        renderPage()
        await userEvent.type(screen.getByTestId('support-name'), 'Sam')
        await fillForm()

        await userEvent.click(screen.getByTestId('support-send'))
        expect(screen.getByTestId('support-send')).toHaveTextContent('Sending…')
        expect(screen.getByTestId('support-send')).toBeDisabled()

        await act(async () => finish('req-1'))
        expect(await screen.findByTestId('support-sent')).toHaveTextContent("Thanks. We'll reply to sam@example.com.")

        await userEvent.click(screen.getByTestId('support-send-another'))
        expect(screen.getByTestId('support-name')).toHaveValue('Sam')
        expect(screen.getByTestId('support-email')).toHaveValue('sam@example.com')
        expect(screen.getByTestId('support-topic')).toHaveValue('')
        expect(screen.getByTestId('support-message')).toHaveValue('')
    })

    test('a failed send keeps the message and offers the support address', async () => {
        jest.spyOn(console, 'error').mockImplementation(() => {})
        mockSend.mockRejectedValue(new Error('Failed to fetch'))
        renderPage()
        await fillForm()

        await userEvent.click(screen.getByTestId('support-send'))

        const alert = await screen.findByRole('alert')
        expect(alert).toHaveTextContent(`Couldn't send your message. Try again, or email ${SUPPORT_EMAIL}.`)
        expect(screen.getByRole('link', { name: SUPPORT_EMAIL })).toHaveAttribute('href', `mailto:${SUPPORT_EMAIL}`)
        expect(screen.getByTestId('support-message')).toHaveValue(MESSAGE)
        expect(screen.getByTestId('support-send')).toBeEnabled()
    })

    test("a token that can't be refreshed counts as a failed send and sends nothing", async () => {
        jest.spyOn(console, 'error').mockImplementation(() => {})
        mockGetToken.mockRejectedValue(new Error('login_required'))
        renderPage()
        await fillForm()

        await userEvent.click(screen.getByTestId('support-send'))

        expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't send your message.")
        expect(mockSend).not.toHaveBeenCalled()
    })

    test('the hidden field bots fill in is sent along', async () => {
        renderPage()
        expect(screen.getByTestId('support-website')).toHaveAttribute('tabindex', '-1')
        fireEvent.change(screen.getByTestId('support-website'), { target: { value: 'https://spam.example' } })
        await fillForm()

        await sendAndWaitForConfirmation()

        expect(mockSend.mock.calls[0][1].website).toBe('https://spam.example')
    })

    test('links to the privacy policy', () => {
        renderPage()
        expect(screen.getByRole('link', { name: 'privacy policy' })).toHaveAttribute('href', '/privacy-policy')
    })

    test('on a phone it has the mobile header instead of the navbar', () => {
        mockBreakpoints.mockReturnValue({ isNarrow: true, isMobile: true })
        renderPage()

        expect(screen.queryByTestId('navbar')).not.toBeInTheDocument()
        expect(screen.getByTestId('mobile-header')).toHaveTextContent('Support')
    })
})
