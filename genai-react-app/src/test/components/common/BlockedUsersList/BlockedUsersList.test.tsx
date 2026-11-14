import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BlockedUsersList } from '../../../../components/common/BlockedUsersList/BlockedUsersList'
import { getBlockedUsers, unblockUser } from '../../../../services/moderationService'

jest.mock('../../../../context/AuthContext', () => ({
    useAuth: () => ({ customerId: 'CU1', isAuthenticated: true, getAccessTokenSilently: jest.fn().mockResolvedValue('token') }),
}))
jest.mock('../../../../services/moderationService', () => ({
    ...jest.requireActual('../../../../services/moderationService'),
    getBlockedUsers: jest.fn(),
    unblockUser: jest.fn(),
}))

const mockList = getBlockedUsers as jest.Mock
const mockUnblock = unblockUser as jest.Mock

const renderList = () =>
    render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
            <BlockedUsersList />
        </QueryClientProvider>
    )

describe('BlockedUsersList', () => {
    beforeEach(() => {
        mockList.mockReset()
        mockUnblock.mockReset()
        jest.spyOn(console, 'error').mockImplementation(() => undefined)
    })

    test('says so when nobody is blocked', async () => {
        mockList.mockResolvedValue([])
        renderList()
        expect(await screen.findByTestId('blocked-users-empty')).toBeInTheDocument()
    })

    test('lists people and removes one on Unblock', async () => {
        mockList.mockResolvedValue([
            { customerId: 'CU2', username: 'mara', name: 'Mara K', blockedAt: '2026-11-01T10:00:00Z' },
            { customerId: 'CU3', name: 'Sam O', blockedAt: '2026-11-02T10:00:00Z' },
            { customerId: 'CU4', blockedAt: '2026-11-03T10:00:00Z' },
        ])
        mockUnblock.mockResolvedValue(undefined)
        renderList()
        expect(await screen.findByText('@mara')).toBeInTheDocument()
        expect(screen.getByText('Sam O')).toBeInTheDocument()
        expect(screen.getByText('Unknown user')).toBeInTheDocument()

        fireEvent.click(screen.getByTestId('unblock-CU2'))
        await waitFor(() => expect(screen.queryByText('@mara')).not.toBeInTheDocument())
        expect(mockUnblock).toHaveBeenCalledWith('token', 'CU2')
        expect(screen.getByText('Unblocked @mara.')).toBeInTheDocument()
    })

    test('keeps the person and says so when Unblock fails', async () => {
        mockList.mockResolvedValue([{ customerId: 'CU2', username: 'mara', blockedAt: '2026-11-01T10:00:00Z' }])
        mockUnblock.mockRejectedValue(new Error('nope'))
        renderList()
        fireEvent.click(await screen.findByTestId('unblock-CU2'))
        expect(await screen.findByText("Couldn't unblock @mara. Please try again.")).toBeInTheDocument()
        expect(screen.getByText('@mara')).toBeInTheDocument()
    })

    test('offers a retry when the list fails to load', async () => {
        mockList.mockRejectedValueOnce(new Error('nope')).mockResolvedValue([])
        renderList()
        expect(await screen.findByRole('alert')).toBeInTheDocument()
        fireEvent.click(screen.getByText('Try again'))
        expect(await screen.findByTestId('blocked-users-empty')).toBeInTheDocument()
    })
})
