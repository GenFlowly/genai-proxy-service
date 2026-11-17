import React from 'react'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import BlockedUsersPage from '../../pages/BlockedUsersPage/BlockedUsersPage'

jest.mock('../../components/widgets/MobileHeader/MobileHeader', () => ({
    __esModule: true,
    default: ({ title }: { title: string }) => <div data-testid="mobile-header">{title}</div>,
}))
jest.mock('../../hooks/useResponsiveBreakpoints', () => ({ useResponsiveBreakpoints: () => ({ isNarrow: true }) }))
jest.mock('../../components/common/BlockedUsersList/BlockedUsersList', () => ({ BlockedUsersList: () => <div data-testid="list" /> }))

test('shows the list under the phone header with a link back to Settings', () => {
    render(<MemoryRouter><BlockedUsersPage /></MemoryRouter>)
    expect(screen.getByTestId('mobile-header')).toHaveTextContent('Blocked users')
    expect(screen.getByTestId('list')).toBeInTheDocument()
    expect(screen.getByTestId('detail-back')).toHaveAttribute('href', '/settings/profile')
})
