import React from 'react'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route } from 'react-router-dom'
import MemoryDetailPage from '../../pages/MemoryPage/MemoryDetailPage'
import NewMemoryPage from '../../pages/MemoryPage/NewMemoryPage'
import MemoryEditPage from '../../pages/MemoryPage/MemoryEditPage'
import MemoryHistoryPage from '../../pages/MemoryPage/MemoryHistoryPage'
import MemoryUsedInPage from '../../pages/MemoryPage/MemoryUsedInPage'
import { queryClient } from '../../queryClient'
import { memoriesCache } from '../../services/memoriesService'
import { MemoryChange } from '../../models/memory.models'
import { FakeMemoryApi, memory, renderMemoryRoutes } from './MemoryPage/memoryTestKit'
import { swipeFromLeftEdge } from '../utils/edgeSwipe'
import { appliesLabel } from '../../pages/MemoryPage/memoryDetail'

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

const CHANGES: MemoryChange[] = [
    {
        changeId: 'c1', type: 'LEARNED', createdAt: '2026-09-19T16:44:00Z', version: 1, text: 'Prefers short answers.',
        sourceType: 'CONVERSATION', conversationId: 'CONV1', messageId: 'MSG-1', conversationTitle: 'Learning From User Conversations',
        conversationAvailable: true, youSaid: 'Keep answers short.', reason: 'States a lasting preference.',
    },
    {
        changeId: 'c2', type: 'MOVED', createdAt: '2026-10-14T18:20:00Z',
        from: [{ projectId: null, kind: 'EPISODIC' }], to: [{ projectId: null, kind: 'CORE' }],
    },
    {
        changeId: 'c3', type: 'EDITED_BY_YOU', createdAt: '2026-10-30T09:14:00Z', version: 2,
        text: 'Prefers concise answers.', previousText: 'Prefers short answers.',
    },
    {
        changeId: 'c4', type: 'UPDATED', createdAt: '2026-11-01T09:14:00Z', version: 3,
        text: 'Prefers concise answers with the conclusion first.', previousText: 'Prefers concise answers.',
        sourceType: 'CONVERSATION', conversationId: 'GONE', messageId: 'MSG-9', conversationAvailable: false,
        reason: 'Adds an ordering preference.',
    },
]

let api: FakeMemoryApi

function renderAt(path: string) {
    return renderMemoryRoutes(path, (
        <>
            <Route path="/memory" element={<div data-testid="list-page" />} />
            <Route path="/memory/new" element={<NewMemoryPage />} />
            <Route path="/memory/:memoryId" element={<MemoryDetailPage />} />
            <Route path="/memory/:memoryId/edit" element={<MemoryEditPage />} />
            <Route path="/memory/:memoryId/history" element={<MemoryHistoryPage />} />
            <Route path="/memory/:memoryId/usage" element={<MemoryUsedInPage />} />
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
        memory('MEM#m', 'Prefers concise answers with the conclusion first.', {
            version: 3, hitCount: 198, lastUsedAt: '2026-11-05T10:42:00Z', category: 'preference',
        }),
        memory('MEM#p', 'Report is due Dec 12.', { placements: [{ projectId: 'PRJa', kind: 'CORE' }, { projectId: 'PRJb', kind: 'EPISODIC' }] }),
    ]
    api.changes['MEM#m'] = CHANGES
    mockFetch.mockImplementation(api.handle)
})

const USAGE = [
    {
        items: [
            { conversationId: 'CONV1', messageId: 'MSG-5', usedAt: '2026-11-05T10:42:00Z', how: 'core', conversationTitle: 'Weekly Report', conversationAvailable: true },
            { conversationId: 'CONV1', messageId: 'MSG-4', usedAt: '2026-11-05T10:41:00Z', how: 'core', conversationTitle: 'Weekly Report', conversationAvailable: true },
        ],
        nextCursor: '1',
        total: 198,
    },
    { items: [{ conversationId: 'GONE', messageId: 'MSG-2', usedAt: '2026-11-01T10:42:00Z', how: 'search', conversationAvailable: false }], total: 198 },
]

describe('MemoryDetailPage', () => {
    test('desktop: the text, where it applies, usage and history side by side', async () => {
        api.usage['MEM#m'] = USAGE
        renderAt('/memory/MEM%23m?scope=core')

        expect(await screen.findByTestId('memory-text-shown')).toHaveTextContent('Prefers concise answers with the conclusion first.')
        expect(screen.getByText('preference')).toBeInTheDocument()
        expect(within(screen.getByTestId('memory-applies')).getByText('Every conversation · Core')).toBeInTheDocument()
        const usage = screen.getByTestId('memory-usage')
        expect(within(usage).getByText('198')).toBeInTheDocument()
        expect(await within(usage).findByText('Weekly Report')).toBeInTheDocument()
        expect(within(usage).getByText(/^2 replies · last/)).toBeInTheDocument()
        expect(within(usage).getByRole('link', { name: 'See all usage' })).toHaveAttribute('href', '/memory/MEM%23m/usage?scope=core')

        const timeline = screen.getByTestId('detail-timeline')
        const learned = within(timeline).getByTestId('timeline-c1')
        expect(within(learned).getByRole('link', { name: 'Learning From User Conversations' })).toHaveAttribute('href', '/chat/CONV1')
        expect(within(learned).getByText('“Keep answers short.”')).toBeInTheDocument()
        expect(within(learned).getByText('States a lasting preference.')).toBeInTheDocument()
        expect(within(learned).getByRole('link', { name: /View version 1/ })).toHaveAttribute('href', '/memory/MEM%23m?version=1&scope=core')
        const updated = within(timeline).getByTestId('timeline-c4')
        expect(within(updated).getByText('Deleted conversation')).toBeInTheDocument()
        expect(within(updated).getByText('with the conclusion first').tagName).toBe('INS')
        expect(within(updated).queryByRole('link', { name: /View version/ })).not.toBeInTheDocument()
        expect(within(within(timeline).getByTestId('timeline-c2')).getByText('No new version')).toBeInTheDocument()
        expect(screen.queryByTestId('memory-detail-copy')).not.toBeInTheDocument()
    })

    test('desktop: Edit turns the card into an editor and saves the next version', async () => {
        renderAt('/memory/MEM%23m')
        await screen.findByTestId('memory-text-shown')

        await userEvent.click(screen.getByTestId('memory-edit'))
        const text = screen.getByTestId('memory-text') as HTMLTextAreaElement
        expect(text).toHaveValue('Prefers concise answers with the conclusion first.')
        expect(text).toHaveFocus()
        expect(text.selectionStart).toBe(text.value.length)
        expect(screen.getByTestId('memory-save')).toBeDisabled()
        await userEvent.clear(text)
        await userEvent.type(text, 'Prefers bullet points.')
        await userEvent.click(screen.getByTestId('memory-save'))

        await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('Saved as version 4'))
        expect(api.last('PUT')!.body).toEqual({ text: 'Prefers bullet points.', baseVersion: 3 })
        expect(screen.queryByTestId('memory-text')).not.toBeInTheDocument()
    })

    test('desktop: an older version can be restored as the next version', async () => {
        renderAt('/memory/MEM%23m?version=1')

        expect(await screen.findByTestId('memory-older')).toHaveTextContent('This is version 1. Replies use the latest, version 3.')
        expect(screen.getByTestId('memory-text-shown')).toHaveTextContent('Prefers short answers.')
        await userEvent.click(screen.getByRole('button', { name: 'Restore as version 4' }))
        expect(screen.getByTestId('memory-text')).toHaveValue('Prefers short answers.')
        await userEvent.click(screen.getByTestId('memory-save'))

        await waitFor(() => expect(api.last('PUT')!.body).toEqual({ text: 'Prefers short answers.', baseVersion: 3 }))
        await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent(/^\/memory\/MEM%23m\?scope=core$/))
    })

    test('a save that lost a race says so and keeps the editor', async () => {
        renderAt('/memory/MEM%23m')
        await screen.findByTestId('memory-text-shown')
        api.refuseWith = 409

        await userEvent.click(screen.getByTestId('memory-edit'))
        await userEvent.type(screen.getByTestId('memory-text'), ' Always.')
        await userEvent.click(screen.getByTestId('memory-save'))

        await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith(
            "A newer version was saved while you were editing. It's listed now, and your text is still here."))
        expect(screen.getByTestId('memory-text')).toBeInTheDocument()
    })

    test('a project memory offers Copy in the more menu and can leave just this project', async () => {
        renderAt('/memory/MEM%23p?scope=PRJb')
        await screen.findByTestId('memory-text-shown')

        await userEvent.click(screen.getByTestId('detail-more'))
        expect(screen.getByTestId('memory-detail-copy')).toBeInTheDocument()
        await userEvent.click(screen.getByTestId('memory-detail-delete'))
        await userEvent.click(screen.getByTestId('memory-remove-here'))

        await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/memory?scope=PRJb'))
        expect(api.last('DELETE')!.query.get('projectId')).toBe('PRJb')
    })

    test('moving it elsewhere follows it to its new list', async () => {
        renderAt('/memory/MEM%23m?scope=core')
        await screen.findByTestId('memory-text-shown')

        await userEvent.click(screen.getByTestId('memory-detail-move'))
        await userEvent.click(screen.getByTestId('memory-destination-PRJa'))
        await userEvent.click(screen.getByTestId('memory-move-confirm'))

        await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/memory/MEM%23m?scope=PRJa'))
    })

    test('a memory that no longer exists says so', async () => {
        renderAt('/memory/MEM%23gone')

        expect(await screen.findByText("This memory doesn't exist anymore.")).toBeInTheDocument()
    })

    test('phone: the text card, then rows for where it applies, usage and history', async () => {
        mockBreakpoints.mockReturnValue(phone)
        renderAt('/memory/MEM%23m?scope=core')
        await screen.findByTestId('memory-text-shown')

        expect(screen.getByTestId('detail-row-applies')).toHaveTextContent('Every conversation · Core')
        expect(screen.getByTestId('detail-row-usage')).toHaveTextContent('198 replies · last')
        expect(screen.getByTestId('detail-row-history')).toHaveTextContent('Version 3 · 4 changes')
        expect(screen.getByTestId('detail-row-history')).toHaveAttribute('href', '/memory/MEM%23m/history?scope=core')
        expect(screen.getByTestId('detail-row-usage')).toHaveAttribute('href', '/memory/MEM%23m/usage?scope=core')
        expect(screen.queryByTestId('detail-timeline')).not.toBeInTheDocument()

        await userEvent.click(screen.getByTestId('detail-row-applies'))
        expect(await screen.findByTestId('memory-destination-PRJa')).toBeInTheDocument()
    })

    test('phone: a swipe from the left edge goes back to the list it was opened from', async () => {
        mockBreakpoints.mockReturnValue(phone)
        renderAt('/memory/MEM%23m?scope=core')

        swipeFromLeftEdge(await screen.findByTestId('memory-text-shown'))

        expect(await screen.findByTestId('list-page')).toBeInTheDocument()
        expect(screen.getByTestId('location')).toHaveTextContent(/^\/memory\?scope=core$/)
    })

    test('phone: Edit and Restore open the edit page', async () => {
        mockBreakpoints.mockReturnValue(phone)
        renderAt('/memory/MEM%23m?scope=core&version=2')
        await screen.findByTestId('memory-text-shown')

        await userEvent.click(screen.getByRole('button', { name: 'Restore as version 4' }))

        await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/memory/MEM%23m/edit?version=2&scope=core'))
    })
})

describe('appliesLabel', () => {
    test('only Core in Profile applies to every conversation', () => {
        const names = { PRJ1: 'Market research' }
        expect(appliesLabel({ projectId: null, kind: 'CORE' }, names)).toBe('Every conversation · Core')
        expect(appliesLabel({ projectId: null, kind: 'EPISODIC' }, names)).toBe('When relevant · Episodic')
        expect(appliesLabel({ projectId: 'PRJ1', kind: 'EPISODIC' }, names)).toBe('Market research · Episodic')
    })
})

describe('MemoryEditPage', () => {
    test('shows the change while typing and saves the next version', async () => {
        mockBreakpoints.mockReturnValue(phone)
        renderAt('/memory/MEM%23m/edit?scope=core')
        const text = await screen.findByTestId('memory-text')
        expect(screen.queryByTestId('memory-change-preview')).not.toBeInTheDocument()
        expect(screen.getByTestId('detail-back')).toHaveAttribute('href', '/memory/MEM%23m?scope=core')

        await userEvent.type(text, ' Always.')
        expect(within(screen.getByTestId('memory-change-preview')).getByText('Always.').tagName).toBe('INS')
        expect(screen.getByText(`${'Prefers concise answers with the conclusion first. Always.'.length} / 500`)).toBeInTheDocument()
        await userEvent.click(screen.getByTestId('memory-save'))

        await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent(/^\/memory\/MEM%23m\?scope=core$/))
        expect(api.last('PUT')!.body).toEqual({ text: 'Prefers concise answers with the conclusion first. Always.', baseVersion: 3 })
    })

    test('starts from an older version and says so', async () => {
        mockBreakpoints.mockReturnValue(phone)
        renderAt('/memory/MEM%23m/edit?version=1')

        expect(await screen.findByTestId('memory-text')).toHaveValue('Prefers short answers.')
        expect(screen.getByText('Editing from version 1. Saving makes it version 4.')).toBeInTheDocument()
    })

    test('Cancel goes back, and a failed save says so', async () => {
        renderAt('/memory/MEM%23m/edit')
        await userEvent.type(await screen.findByTestId('memory-text'), ' Always.')
        api.refuseWith = 500

        await userEvent.click(screen.getByTestId('memory-save'))
        await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith("Couldn't save the memory."))
        await userEvent.click(screen.getByTestId('memory-edit-cancel'))

        await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent(/^\/memory\/MEM%23m\?scope=core$/))
    })
})

describe('MemoryHistoryPage', () => {
    test('every change, with a link back to the memory', async () => {
        mockBreakpoints.mockReturnValue(phone)
        renderAt('/memory/MEM%23m/history')

        const timeline = await screen.findByTestId('detail-timeline')
        expect(within(timeline).getAllByRole('listitem')).toHaveLength(4)
        expect(within(timeline).getByText('Learned from a conversation')).toBeInTheDocument()
        expect(screen.getByTestId('detail-back')).toHaveTextContent('Memory')
    })
})

describe('MemoryUsedInPage', () => {
    test('one row per conversation, with older uses on request', async () => {
        mockBreakpoints.mockReturnValue(phone)
        api.usage['MEM#m'] = USAGE
        renderAt('/memory/MEM%23m/usage')

        const list = await screen.findByTestId('detail-conversations')
        expect(within(list).getByRole('link', { name: /Weekly Report/ })).toHaveAttribute('href', '/chat/CONV1')
        expect(within(list).getByText(/^2 replies · last/)).toBeInTheDocument()
        await userEvent.click(screen.getByTestId('memory-usage-load-more'))
        expect(await within(list).findByText('Deleted conversation')).toBeInTheDocument()
        expect(screen.queryByTestId('memory-usage-load-more')).not.toBeInTheDocument()
        expect(screen.getByTestId('memory-usage-unlisted')).toHaveTextContent('Plus 195 earlier replies, from before conversations were listed.')
    })

    test('replies from before conversations were listed are counted, not hidden', async () => {
        mockBreakpoints.mockReturnValue(phone)
        api.memories = [memory('MEM#old', 'Runs a studio.', { hitCount: 12 })]
        renderAt('/memory/MEM%23old/usage')

        expect(await screen.findByTestId('memory-usage-empty')).toHaveTextContent('12 replies used it before conversations were listed.')
        expect(screen.getByTestId('mobile-header-subtitle')).toHaveTextContent('12 replies')
    })

    test('desktop: a count without a last use says the date was not recorded', async () => {
        api.memories = [memory('MEM#old', 'Runs a studio.', { hitCount: 12 })]
        renderAt('/memory/MEM%23old')

        const usage = await screen.findByTestId('memory-usage')
        expect(within(usage).getByText('12')).toBeInTheDocument()
        expect(within(usage).getByText('last use not recorded')).toBeInTheDocument()
    })

    test('says when it was never used', async () => {
        renderAt('/memory/MEM%23p/usage')

        expect(await screen.findByText('Not used in any reply yet.')).toBeInTheDocument()
    })
})

describe('NewMemoryPage', () => {
    test('adds a memory to the chosen project and opens it', async () => {
        renderAt('/memory/new?scope=PRJa')
        const where = await screen.findByTestId('new-memory-where')
        await waitFor(() => expect(where).toHaveValue('PRJa'))
        expect(screen.getByText('Core: included in every conversation in this project.')).toBeInTheDocument()
        expect(screen.getByTestId('new-memory-save')).toBeDisabled()

        await userEvent.click(screen.getByTestId('memory-kind-episodic'))
        await userEvent.type(screen.getByTestId('new-memory-text'), '  Survey has 420 responses.  ')
        await userEvent.click(screen.getByTestId('new-memory-save'))

        await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/memory/MEM%23new?scope=PRJa'))
        expect(api.last('POST')!.body).toEqual({ text: 'Survey has 420 responses.', kind: 'EPISODIC', projectId: 'PRJa' })
    })

    test('phone: a swipe from the left edge goes back to the list it was opened from', async () => {
        mockBreakpoints.mockReturnValue(phone)
        renderAt('/memory/new?scope=episodic')

        swipeFromLeftEdge(await screen.findByTestId('new-memory-text'))

        expect(await screen.findByTestId('list-page')).toBeInTheDocument()
        expect(screen.getByTestId('location')).toHaveTextContent(/^\/memory\?scope=episodic$/)
    })

    test('starts in Profile from a Profile list', async () => {
        renderAt('/memory/new?scope=episodic')

        expect(await screen.findByTestId('new-memory-where')).toHaveValue('profile')
        expect(screen.getByTestId('memory-kind-episodic')).toHaveAttribute('aria-pressed', 'true')
    })

    test('a failed add keeps the text', async () => {
        renderAt('/memory/new')
        mockFetch.mockImplementation(async (url: string, init?: RequestInit) =>
            init?.method === 'POST' ? { ok: false, status: 500, statusText: 'Error', json: async () => ({}) } : api.handle(url, init))
        await userEvent.type(await screen.findByTestId('new-memory-text'), 'Prefers metric units.')

        await userEvent.click(screen.getByTestId('new-memory-save'))

        await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith("Couldn't add the memory."))
        expect(screen.getByTestId('new-memory-text')).toHaveValue('Prefers metric units.')
    })
})
