import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router'
import MenuSearchResults from '../../../../components/widgets/MobileMenuBody/MenuSearchResults'
import { searchContent, SearchResultItem } from '../../../../services/searchService'
import { SearchError } from '../../../../services/searchError'

jest.mock('../../../../services/searchService')
const mockAuth = { isSignedOut: false }
jest.mock('../../../../context/AuthContext', () => ({
    useAuth: () => ({ getAccessTokenSilently: jest.fn().mockResolvedValue('token'), isSignedOut: mockAuth.isSignedOut }),
}))

const mockSearch = searchContent as jest.Mock

const result: SearchResultItem = {
    type: 'conversation',
    key: 'conv-1',
    title: 'Tax questions',
    snippet: 'What can I deduct',
    score: 0.9,
    matchedChunks: 1,
}

const renderResults = (onSelect = jest.fn(), onLeave = jest.fn()) => {
    render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
            <MemoryRouter initialEntries={['/chat']}>
                <Routes>
                    <Route
                        path="/chat"
                        element={<MenuSearchResults query="tax" types={['conversation']} untitledLabel="Untitled" onSelect={onSelect} onLeave={onLeave} />}
                    />
                    <Route path="/settings/byok/:section" element={<p>Settings page</p>} />
                </Routes>
            </MemoryRouter>
        </QueryClientProvider>
    )
    return { onSelect, onLeave }
}

describe('MenuSearchResults', () => {
    beforeEach(() => {
        mockSearch.mockReset()
        mockAuth.isSignedOut = false
    })

    test('sends the query and lists results with their snippets', async () => {
        mockSearch.mockResolvedValue([result])
        const { onSelect } = renderResults()

        expect(await screen.findByText('Tax questions')).toBeInTheDocument()
        expect(screen.getByText('What can I deduct')).toBeInTheDocument()
        expect(mockSearch).toHaveBeenCalledWith('token', 'tax', ['conversation'])

        await userEvent.click(screen.getByTestId('menu-search-result-conv-1'))
        expect(onSelect).toHaveBeenCalledWith(result)
    })

    test('labels a result that has no title', async () => {
        mockSearch.mockResolvedValue([{ ...result, title: null }])
        renderResults()
        expect(await screen.findByText('Untitled')).toBeInTheDocument()
    })

    test('says when nothing matched', async () => {
        mockSearch.mockResolvedValue([])
        renderResults()
        expect(await screen.findByText('No results')).toBeInTheDocument()
    })

    test('asks a signed-out user to log in instead of searching', async () => {
        mockAuth.isSignedOut = true
        renderResults()

        expect(await screen.findByText('Please log in first.')).toBeInTheDocument()
        await new Promise(resolve => setTimeout(resolve, 400))
        expect(mockSearch).not.toHaveBeenCalled()
    })

    test('says when the search failed', async () => {
        jest.spyOn(console, 'error').mockImplementation(() => {})
        mockSearch.mockRejectedValue(new Error('500'))
        renderResults()
        await waitFor(() => expect(screen.getByText('Search failed. Try again.')).toBeInTheDocument())
    })

    test('says when search is not set up and opens the Settings page for it', async () => {
        jest.spyOn(console, 'error').mockImplementation(() => {})
        mockSearch.mockRejectedValue(new SearchError('409', 409, 'SEARCH_NOT_CONFIGURED', 'VECTOR_DB_NOT_CONFIGURED'))
        const { onLeave } = renderResults()

        expect(await screen.findByText("Search isn't set up. Connect a vector DB to search.")).toBeInTheDocument()
        expect(screen.queryByText('Search failed. Try again.')).not.toBeInTheDocument()

        await userEvent.click(screen.getByTestId('menu-search-open-settings'))
        expect(screen.getByText('Settings page')).toBeInTheDocument()
        expect(onLeave).toHaveBeenCalled()
    })

    test('names a missing embedding key', async () => {
        jest.spyOn(console, 'error').mockImplementation(() => {})
        mockSearch.mockRejectedValue(new SearchError('409', 409, 'SEARCH_NOT_CONFIGURED', 'EMBEDDING_KEY_MISSING'))
        renderResults()
        expect(await screen.findByText("Search isn't set up. Add an embedding key to search.")).toBeInTheDocument()
    })

    test('offers no Settings link when the search simply failed', async () => {
        jest.spyOn(console, 'error').mockImplementation(() => {})
        mockSearch.mockRejectedValue(new SearchError('502', 502, 'SEARCH_UNAVAILABLE'))
        renderResults()
        expect(await screen.findByText('Search failed. Try again.')).toBeInTheDocument()
        expect(screen.queryByTestId('menu-search-open-settings')).not.toBeInTheDocument()
    })
})
