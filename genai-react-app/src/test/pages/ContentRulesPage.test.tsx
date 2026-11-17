import React from 'react'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import ContentRulesPage from '../../pages/ContentRulesPage/ContentRulesPage'

jest.mock('../../components/navbar/Navbar', () => () => <div data-testid="navbar" />)
jest.mock('../../components/widgets/MobileHeader/MobileHeader', () => ({
    __esModule: true,
    default: ({ title }: { title: string }) => <div data-testid="mobile-header">{title}</div>,
}))
const mockBreakpoints = jest.fn()
jest.mock('../../hooks/useResponsiveBreakpoints', () => ({ useResponsiveBreakpoints: () => mockBreakpoints() }))

const renderPage = () => render(<MemoryRouter><ContentRulesPage /></MemoryRouter>)

describe('ContentRulesPage', () => {
    test('shows the rules and links support and the privacy policy on desktop', () => {
        mockBreakpoints.mockReturnValue({ isNarrow: false })
        renderPage()
        expect(screen.getByRole('heading', { level: 1, name: 'Content rules' })).toBeInTheDocument()
        expect(screen.getByText("You can't share")).toBeInTheDocument()
        expect(screen.getAllByRole('listitem').length).toBeGreaterThanOrEqual(7)
        expect(screen.getByRole('link', { name: 'genflowly.com/support' })).toHaveAttribute('href', '/support')
        expect(screen.getByRole('link', { name: 'privacy policy' })).toHaveAttribute('href', '/privacy-policy')
        expect(screen.getByTestId('navbar')).toBeInTheDocument()
    })

    test('uses the phone header when narrow', () => {
        mockBreakpoints.mockReturnValue({ isNarrow: true })
        renderPage()
        expect(screen.getByTestId('mobile-header')).toHaveTextContent('Content rules')
    })
})
