import React from 'react'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route } from 'react-router-dom'
import MemoryDetailPage from '../../pages/MemoryPage/MemoryDetailPage'
import NewMemoryPage from '../../pages/MemoryPage/NewMemoryPage'
import { queryClient } from '../../queryClient'
import { memoriesCache } from '../../services/memoriesService'
import { MemoryChange } from '../../models/memory.models'
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

describe('MemoryDetailPage', () => {
    test('shows where it applies, its versions newest first and the change log', async () => {
        renderAt('/memory/MEM%23m?scope=core')

        expect(await screen.findByTestId('memory-text')).toHaveValue('Prefers concise answers with the conclusion first.')
        expect(screen.getAllByText('Profile · Core')).toHaveLength(2)
        expect(screen.getByText(/Used 198×/)).toBeInTheDocument()
        const versions = within(screen.getByTestId('memory-versions'))
        expect(versions.getByTestId('memory-version-3')).toHaveTextContent('Latest')
        expect(versions.getByTestId('memory-version-1')).toHaveTextContent('Learned from a conversation')

        const log = screen.getByTestId('memory-change-log')
        const learned = within(log).getByTestId('memory-change-c1')
        expect(within(learned).getByRole('link', { name: 'Learning From User Conversations' })).toHaveAttribute('href', '/chat/CONV1')
        expect(within(learned).getByText('MSG-1')).toBeInTheDocument()
        expect(within(learned).getByText('“Keep answers short.”')).toBeInTheDocument()
        expect(within(learned).getByText('States a lasting preference.')).toBeInTheDocument()
        const moved = within(log).getByTestId('memory-change-c2')
        expect(within(moved).getByText('No new version')).toBeInTheDocument()
        expect(within(moved).getByText('Profile · Episodic')).toBeInTheDocument()
        const updated = within(log).getByTestId('memory-change-c4')
        expect(within(updated).getByText('Deleted conversation')).toBeInTheDocument()
        expect(within(updated).getByText('Prefers concise answers.')).toBeInTheDocument()
    })

    test('each version says how it was made', async () => {
        api.changes['MEM#m'] = [
            { changeId: 'a1', type: 'ADDED_BY_YOU', createdAt: '2026-11-06T08:48:00Z', version: 1, text: 'Prefers short answers.' },
            { changeId: 'a2', type: 'EDITED_BY_YOU', createdAt: '2026-11-06T08:49:00Z', version: 2, text: 'Prefers concise answers.', previousText: 'Prefers short answers.' },
            { changeId: 'a3', type: 'UPDATED', createdAt: '2026-11-06T09:04:00Z', version: 3, text: 'Prefers concise answers with the conclusion first.', sourceType: 'CONVERSATION' },
        ]
        renderAt('/memory/MEM%23m')

        const versions = within(await screen.findByTestId('memory-versions'))
        expect(versions.getByTestId('memory-version-1')).toHaveTextContent('Added by you')
        expect(versions.getByTestId('memory-version-2')).toHaveTextContent('Edited by you')
        expect(versions.getByTestId('memory-version-3')).toHaveTextContent('Updated from a conversation')
    })

    test('saving creates the next version from the one edited', async () => {
        renderAt('/memory/MEM%23m')
        const text = await screen.findByTestId('memory-text')
        expect(screen.getByTestId('memory-save')).toBeDisabled()

        await userEvent.clear(text)
        await userEvent.type(text, 'Prefers bullet points.')
        expect(screen.getByTestId('memory-save')).toHaveTextContent('Save as version 4')
        await userEvent.click(screen.getByTestId('memory-save'))

        await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('Saved as version 4'))
        expect(api.last('PUT')!.body).toEqual({ text: 'Prefers bullet points.', baseVersion: 3 })
    })

    test('an older version can be read and saved again as a new version', async () => {
        renderAt('/memory/MEM%23m')
        await screen.findByTestId('memory-text')

        await userEvent.click(screen.getByTestId('memory-version-1'))

        expect(screen.getByTestId('memory-text')).toHaveValue('Prefers short answers.')
        expect(screen.getByText(/Viewing version 1\. Saving this text creates version 4/)).toBeInTheDocument()
        await userEvent.click(screen.getByTestId('memory-save'))
        await waitFor(() => expect(api.last('PUT')!.body).toEqual({ text: 'Prefers short answers.', baseVersion: 3 }))
    })

    test('a save that lost a race says so', async () => {
        api.refuseWith = 409
        renderAt('/memory/MEM%23m')
        const text = await screen.findByTestId('memory-text')

        await userEvent.type(text, ' Really.')
        await userEvent.click(screen.getByTestId('memory-save'))

        await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith(
            "A newer version was saved while you were editing. It's listed now, and your text is still here."
        ))
    })

    test('the usage log pages through the replies it was used in', async () => {
        api.usage['MEM#m'] = [
            { items: [{ conversationId: 'CONV1', messageId: 'MSG-5', usedAt: '2026-11-05T10:42:00Z', how: 'core', conversationTitle: 'Weekly Report', conversationAvailable: true }], nextCursor: '1', total: 198 },
            { items: [{ conversationId: 'GONE', messageId: 'MSG-2', usedAt: '2026-11-01T10:42:00Z', how: 'search', conversationAvailable: false }], total: 198 },
        ]
        renderAt('/memory/MEM%23m')
        await screen.findByTestId('memory-text')

        await userEvent.click(screen.getByTestId('memory-tab-usage'))

        const log = await screen.findByTestId('memory-usage-log')
        expect(within(log).getByRole('link', { name: 'Weekly Report' })).toBeInTheDocument()
        expect(screen.getByText('Showing the latest 1 of 198')).toBeInTheDocument()
        await userEvent.click(screen.getByTestId('memory-usage-load-more'))
        expect(await within(log).findByText('Memory search')).toBeInTheDocument()
        expect(within(log).getByText('Deleted conversation')).toBeInTheDocument()
        expect(screen.queryByTestId('memory-usage-load-more')).not.toBeInTheDocument()
    })

    test('a project memory offers Copy and can leave just this project', async () => {
        renderAt('/memory/MEM%23p?scope=PRJb')
        await screen.findByTestId('memory-text')
        expect(screen.getByTestId('memory-detail-copy')).toBeInTheDocument()

        await userEvent.click(screen.getByTestId('memory-detail-delete-button'))
        await userEvent.click(screen.getByTestId('memory-remove-here'))

        await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/memory?scope=PRJb'))
        expect(api.last('DELETE')!.query.get('projectId')).toBe('PRJb')
    })

    test('a Profile memory has no Copy', async () => {
        renderAt('/memory/MEM%23m')
        await screen.findByTestId('memory-text')

        expect(screen.getByTestId('memory-detail-move')).toBeInTheDocument()
        expect(screen.queryByTestId('memory-detail-copy')).not.toBeInTheDocument()
    })

    test('moving it elsewhere follows it to its new list', async () => {
        renderAt('/memory/MEM%23m?scope=core')
        await screen.findByTestId('memory-text')

        await userEvent.click(screen.getByTestId('memory-detail-move'))
        await userEvent.click(screen.getByTestId('memory-destination-PRJa'))
        await userEvent.click(screen.getByTestId('memory-move-confirm'))

        await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/memory/MEM%23m?scope=PRJa'))
    })

    test('a memory that no longer exists says so', async () => {
        renderAt('/memory/MEM%23gone')

        expect(await screen.findByText("This memory doesn't exist anymore.")).toBeInTheDocument()
    })

    test('on a phone the versions open from a row above the editor', async () => {
        mockBreakpoints.mockReturnValue(phone)
        renderAt('/memory/MEM%23m')
        await screen.findByTestId('memory-text')
        expect(screen.queryByTestId('memory-versions')).not.toBeInTheDocument()

        await userEvent.click(screen.getByTestId('memory-versions-toggle'))
        await userEvent.click(screen.getByTestId('memory-version-2'))

        expect(screen.getByTestId('memory-text')).toHaveValue('Prefers concise answers.')
        expect(screen.queryByTestId('memory-versions')).not.toBeInTheDocument()
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
