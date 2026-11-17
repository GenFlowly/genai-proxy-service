import React from 'react'
import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route } from 'react-router'
import MemoryPage from '../../pages/MemoryPage/MemoryPage'
import { queryClient } from '../../queryClient'
import { memoriesCache } from '../../services/memoriesService'
import { FakeMemoryApi, memory, renderMemoryRoutes } from './MemoryPage/memoryTestKit'

const mockFetch = jest.fn()
jest.mock('../../utils/apiUtils', () => ({ fetchWithRetry: (...args: unknown[]) => mockFetch(...args) }))
jest.mock('../../components/navbar/Navbar', () => () => <div data-testid="navbar" />)

const mockShowToast = jest.fn()
const mockGetToken = jest.fn()
jest.mock('../../context/AuthContext', () => ({
    useAuth: () => ({ isAuthenticated: true, customerId: 'CU1', getAccessTokenSilently: mockGetToken }),
}))
jest.mock('../../context/ToastContext', () => ({ useToast: () => ({ showToast: mockShowToast }) }))

const mockBreakpoints = jest.fn()
jest.mock('../../hooks/useResponsiveBreakpoints', () => ({ useResponsiveBreakpoints: () => mockBreakpoints() }))

const desktop = { width: 1280, height: 900, isMobile: false, isNarrow: false }
const phone = { width: 390, height: 844, isMobile: true, isNarrow: true }

let api: FakeMemoryApi

function renderPage(path = '/memory') {
    return renderMemoryRoutes(path, (
        <>
            <Route path="/memory" element={<MemoryPage />} />
            <Route path="/memory/:memoryId" element={<div />} />
        </>
    ))
}

beforeEach(() => {
    queryClient.clear()
    memoriesCache.clear()
    localStorage.clear()
    localStorage.setItem('customerId', 'CU1')
    mockGetToken.mockResolvedValue('tok')
    mockBreakpoints.mockReturnValue(desktop)
    api = new FakeMemoryApi()
    api.memories = [
        memory('MEM#core', 'Prefers concise answers.', { hitCount: 198, version: 3, updatedAt: '2026-10-30T09:00:00Z' }),
        memory('MEM#older', 'Lives in Lisbon.', { category: 'profile' }),
        memory('MEM#epi', 'Is training for a half marathon.', { placements: [{ projectId: null, kind: 'EPISODIC' }], kind: 'EPISODIC' }),
        memory('MEM#proj', 'Report is due Dec 12.', {
            placements: [{ projectId: 'PRJa', kind: 'CORE' }, { projectId: 'PRJb', kind: 'EPISODIC' }],
            category: 'project',
        }),
    ]
    mockFetch.mockImplementation(api.handle)
})

describe('MemoryPage', () => {
    test('opens on Profile · Core, newest first, with counts in the sidebar', async () => {
        renderPage()

        expect(await screen.findByText('Prefers concise answers.')).toBeInTheDocument()
        expect(screen.getByRole('heading', { name: 'Core memories' })).toBeInTheDocument()
        expect(screen.getByText('Profile · included in every conversation')).toBeInTheDocument()
        const cards = screen.getAllByTestId(/^memory-card-MEM#/)
        expect(cards.map(card => card.dataset.testid)).toEqual(['memory-card-MEM#core', 'memory-card-MEM#older'])
        expect(screen.queryByText('Is training for a half marathon.')).not.toBeInTheDocument()
        expect(within(cards[0]).getByText('198×')).toBeInTheDocument()
        expect(within(cards[0]).getByText('v3')).toBeInTheDocument()

        expect(within(screen.getByTestId('memory-scope-core')).getByText('2')).toBeInTheDocument()
        expect(within(screen.getByTestId('memory-scope-episodic')).getByText('1')).toBeInTheDocument()
        expect(await screen.findByTestId('memory-scope-project-PRJa')).toHaveTextContent('Market research1')
    })

    test('sidebar rows open their list instead of expanding', async () => {
        renderPage()
        await screen.findByText('Prefers concise answers.')

        await userEvent.click(screen.getByTestId('memory-scope-episodic'))

        expect(screen.getByTestId('location')).toHaveTextContent('/memory?scope=episodic')
        expect(await screen.findByText('Is training for a half marathon.')).toBeInTheDocument()
        expect(screen.queryByText('Prefers concise answers.')).not.toBeInTheDocument()
    })

    test('a project list shows its memories with their kind there, and Copy only there', async () => {
        renderPage('/memory?scope=PRJb')

        const card = await screen.findByTestId('memory-card-MEM#proj')
        expect(screen.getByRole('heading', { name: 'Client dashboard' })).toBeInTheDocument()
        expect(within(card).getByText('Episodic')).toBeInTheDocument()

        await userEvent.click(within(card).getByTestId('memory-card-actions-MEM#proj'))
        expect(screen.getByTestId('memory-action-copy')).toBeInTheDocument()
    })

    test('Profile memories offer no Copy', async () => {
        renderPage()
        const card = await screen.findByTestId('memory-card-MEM#core')

        await userEvent.click(within(card).getByTestId('memory-card-actions-MEM#core'))

        expect(screen.getByTestId('memory-action-move')).toBeInTheDocument()
        expect(screen.queryByTestId('memory-action-copy')).not.toBeInTheDocument()
    })

    test('an empty project says so', async () => {
        api.memories = []
        renderPage('/memory?scope=PRJa')

        expect(await screen.findByText('No memories in this project yet')).toBeInTheDocument()
    })

    test('a failed load offers a retry', async () => {
        api.failList = true
        renderPage()

        expect(await screen.findByText("Couldn't load your memories.")).toBeInTheDocument()
        api.failList = false
        await userEvent.click(screen.getByTestId('memory-list-retry'))
        expect(await screen.findByText('Prefers concise answers.')).toBeInTheDocument()
    })

    test('moving a Profile memory into a project takes it out of Profile', async () => {
        renderPage()
        const card = await screen.findByTestId('memory-card-MEM#core')
        await userEvent.click(within(card).getByTestId('memory-card-actions-MEM#core'))
        await userEvent.click(screen.getByTestId('memory-action-move'))

        const dialog = screen.getByTestId('move-memory-dialog')
        await userEvent.click(within(dialog).getByTestId('memory-destination-PRJa'))
        await userEvent.click(within(dialog).getByTestId('memory-kind-episodic'))
        expect(within(dialog).getByTestId('memory-move-confirm')).toHaveTextContent('Move to Market research · Episodic')
        await userEvent.click(within(dialog).getByTestId('memory-move-confirm'))

        await waitFor(() => expect(screen.queryByTestId('memory-card-MEM#core')).not.toBeInTheDocument())
        const call = api.last('POST')!
        expect(call.path).toBe('/memories/MEM#core/move')
        expect(call.body).toEqual({ fromProjectId: null, toProjectId: 'PRJa', kind: 'EPISODIC' })
        expect(mockShowToast).toHaveBeenCalledWith('Memory moved')
        expect(memoriesCache.load('CU1')?.find(m => m.memoryId === 'MEM#core')?.placements)
            .toEqual([{ projectId: 'PRJa', kind: 'EPISODIC' }])
    })

    test('a move that changes nothing is not offered', async () => {
        renderPage()
        const card = await screen.findByTestId('memory-card-MEM#core')
        await userEvent.click(within(card).getByTestId('memory-card-actions-MEM#core'))
        await userEvent.click(screen.getByTestId('memory-action-move'))

        const dialog = screen.getByTestId('move-memory-dialog')
        expect(within(dialog).getByTestId('memory-move-confirm')).toBeDisabled()
        await userEvent.click(within(dialog).getByTestId('memory-destination-profile'))
        expect(within(dialog).getByTestId('memory-move-confirm')).toHaveTextContent('Already here')
        expect(within(dialog).getByTestId('memory-move-confirm')).toBeDisabled()
    })

    test('copying a project memory adds a reference in the other project', async () => {
        api.memories = [memory('MEM#p', 'Survey has 420 responses.', { placements: [{ projectId: 'PRJa', kind: 'EPISODIC' }] })]
        renderPage('/memory?scope=PRJa')
        const card = await screen.findByTestId('memory-card-MEM#p')
        await userEvent.click(within(card).getByTestId('memory-card-actions-MEM#p'))
        await userEvent.click(screen.getByTestId('memory-action-copy'))

        const dialog = screen.getByTestId('move-memory-dialog')
        expect(within(dialog).queryByTestId('memory-destination-profile')).not.toBeInTheDocument()
        expect(within(dialog).queryByTestId('memory-destination-PRJa')).not.toBeInTheDocument()
        await userEvent.click(within(dialog).getByTestId('memory-destination-PRJb'))
        await userEvent.click(within(dialog).getByTestId('memory-move-confirm'))

        await waitFor(() => expect(api.last('POST')?.path).toBe('/memories/MEM#p/copy'))
        expect(api.last('POST')!.body).toEqual({ fromProjectId: 'PRJa', toProjectId: 'PRJb', kind: 'EPISODIC' })
        expect(await screen.findByTestId('memory-card-MEM#p')).toBeInTheDocument()
        expect(within(screen.getByTestId('memory-scope-project-PRJb')).getByText('1')).toBeInTheDocument()
    })

    test('a memory shared by projects can leave just this one', async () => {
        renderPage('/memory?scope=PRJa')
        const card = await screen.findByTestId('memory-card-MEM#proj')
        await userEvent.click(within(card).getByTestId('memory-card-actions-MEM#proj'))
        await userEvent.click(screen.getByTestId('memory-action-delete'))

        expect(screen.getByText(/shared with 1 other project/)).toBeInTheDocument()
        await userEvent.click(screen.getByTestId('memory-remove-here'))

        await waitFor(() => expect(screen.queryByTestId('memory-card-MEM#proj')).not.toBeInTheDocument())
        const call = api.last('DELETE')!
        expect(call.path).toBe('/memories/MEM#proj')
        expect(call.query.get('projectId')).toBe('PRJa')
        expect(mockShowToast).toHaveBeenCalledWith('Removed from this project')
    })

    test('deleting sends the id with its "#" encoded and drops the card', async () => {
        renderPage()
        const card = await screen.findByTestId('memory-card-MEM#older')
        await userEvent.click(within(card).getByTestId('memory-card-actions-MEM#older'))
        await userEvent.click(screen.getByTestId('memory-action-delete'))
        await userEvent.click(screen.getByTestId('memory-delete-confirm'))

        await waitFor(() => expect(screen.queryByTestId('memory-card-MEM#older')).not.toBeInTheDocument())
        const [url] = mockFetch.mock.calls.find(([, init]) => init?.method === 'DELETE')!
        expect(url).toMatch(/\/memories\/MEM%23older$/)
    })

    test('a card opens its memory, keeping the list it came from', async () => {
        renderPage('/memory?scope=PRJa')
        await userEvent.click(await screen.findByTestId('memory-card-open-MEM#proj'))

        expect(screen.getByTestId('location')).toHaveTextContent('/memory/MEM%23proj?scope=PRJa')
    })

    test('Add memory starts from the list on screen', async () => {
        renderPage('/memory?scope=episodic')
        await userEvent.click(await screen.findByTestId('add-memory-button'))

        expect(screen.getByTestId('location')).toHaveTextContent('/memory/new?scope=episodic')
    })

    test('the last known list paints before the server answers', async () => {
        memoriesCache.save('CU1', [memory('MEM#cached', 'From the last session.')])
        mockFetch.mockImplementation(() => new Promise(() => undefined))

        renderPage()

        expect(await screen.findByText('From the last session.')).toBeInTheDocument()
    })

    describe('on a phone', () => {
        beforeEach(() => mockBreakpoints.mockReturnValue(phone))

        test('the kebab opens the actions sheet', async () => {
            renderPage('/memory?scope=PRJa')
            const card = await screen.findByTestId('memory-card-MEM#proj')

            await userEvent.click(within(card).getByTestId('memory-card-actions-MEM#proj'))

            const sheet = screen.getByTestId('memory-actions-sheet')
            expect(within(sheet).getByText('Market research · Core · used 0× · version 1')).toBeInTheDocument()
            await userEvent.click(within(sheet).getByTestId('memory-sheet-move'))
            expect(screen.queryByTestId('memory-actions-sheet')).not.toBeInTheDocument()
            expect(screen.getByTestId('move-memory-dialog')).toBeInTheDocument()
        })

        test('the L2 Menu lists Profile and Projects and opens a list', async () => {
            renderPage()
            await screen.findByText('Prefers concise answers.')

            await act(async () => {
                await userEvent.click(screen.getByRole('button', { name: /menu/i }))
            })

            const profile = await screen.findByTestId('memory-profile-panel-mobile')
            expect(within(profile).getByText('Profile memories')).toBeInTheDocument()
            expect(await screen.findByTestId('memory-projects-panel-mobile')).toBeInTheDocument()
            await userEvent.click(within(screen.getByTestId('memory-projects-panel-mobile')).getByTestId('memory-scope-project-PRJb'))

            expect(screen.getByTestId('location')).toHaveTextContent('/memory?scope=PRJb')
        })
    })
})
