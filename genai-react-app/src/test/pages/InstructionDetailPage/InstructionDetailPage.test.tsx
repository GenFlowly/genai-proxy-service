import React from 'react'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import '@testing-library/jest-dom'
import InstructionDetailPage from '../../../pages/InstructionDetailPage/InstructionDetailPage'
import InstructionEditPage from '../../../pages/InstructionDetailPage/InstructionEditPage'
import InstructionHistoryPage from '../../../pages/InstructionDetailPage/InstructionHistoryPage'
import InstructionUsedInPage from '../../../pages/InstructionDetailPage/InstructionUsedInPage'
import { queryClient } from '../../../queryClient'
import { EdgeSwipeProvider } from '../../../context/EdgeSwipeContext'
import { LayoutProvider } from '../../../context/LayoutContext'
import { swipeFromLeftEdge } from '../../utils/edgeSwipe'
import { useAuth } from '../../../context/AuthContext'
import * as instructionService from '../../../services/instructionService'
import * as moderationService from '../../../services/moderationService'
import { InstructionResponse, InstructionUsageResponse } from '../../../models/instruction.models'

jest.mock('../../../components/navbar/Navbar', () => () => <div data-testid="navbar" />)
jest.mock('../../../context/AuthContext', () => ({ useAuth: jest.fn() }))

const mockShowToast = jest.fn()
jest.mock('../../../context/ToastContext', () => ({ useToast: () => ({ showToast: mockShowToast }) }))

const mockBreakpoints = jest.fn()
jest.mock('../../../hooks/useResponsiveBreakpoints', () => ({ useResponsiveBreakpoints: () => mockBreakpoints() }))

// The library's markdown renderer and code editor don't run in JSDOM.
jest.mock('@genflowly/component-library', () => ({
    ...jest.requireActual('@genflowly/component-library'),
    TextContainer: ({ content }: { content: string }) => <div data-testid="markdown">{content}</div>,
    TextEditor: ({ value, onChange, 'data-testid': testId }: { value: string; onChange: (v: string) => void; 'data-testid'?: string }) => (
        <textarea data-testid={testId ?? 'text-editor'} value={value} onChange={event => onChange(event.target.value)} />
    ),
}))

jest.mock('../../../components/common/ShareModal/ShareModal', () => function MockShareModal(props: any) {
    if (!props.isOpen) return null
    return (
        <div data-testid="share-modal">
            <button onClick={() => props.onSave('SPECIFIC', [{ customerId: 'c1', role: 'EDIT' }], [{ customerId: 'c2' }])}>Save sharing</button>
        </div>
    )
})

const desktop = { width: 1280, height: 900, isMobile: false, isNarrow: false }
const phone = { width: 390, height: 844, isMobile: true, isNarrow: true }

const V1: InstructionResponse = {
    id: 'INS-1', version: 1, name: 'Early-Stage VC', role: 'OWNER', createdAt: '2026-09-03T09:41:00Z',
    instruction: 'You are a VC. You look at customer anecdotes.',
}
const V2: InstructionResponse = {
    ...V1, version: 2, name: 'Early-Stage AI VC', createdAt: '2026-10-28T14:10:00Z', icon: '📊', color: '#6d3be5',
    category: 'Analysis', tags: ['startups', 'AI'],
    instruction: 'You are a VC. Your expertise lies in what will fail. You look at customer anecdotes.',
}
const USAGE: InstructionUsageResponse = {
    usageCount: 7,
    lastUsedAt: '2026-11-06T13:12:00Z',
    conversations: [
        { conversationId: 'CONV1', title: 'Startup Pitch Review', firstUsedAt: '2026-11-06T13:12:00Z' },
        { conversationId: 'CONV2', title: 'Deal Memo' },
    ],
    omitted: 0,
}

const mockRefresh = jest.fn()
const mockLogin = jest.fn()

function auth(overrides: Record<string, unknown> = {}) {
    ;(useAuth as jest.Mock).mockReturnValue({
        customerInstructions: [V1, V2],
        refreshInstructions: mockRefresh,
        isInstructionsLoaded: true,
        isAuthenticated: true,
        loginWithRedirect: mockLogin,
        entitlements: { canShare: true },
        getAccessTokenSilently: jest.fn().mockResolvedValue('tok'),
        ...overrides,
    })
}

function LocationProbe() {
    const location = useLocation()
    return <div data-testid="location">{location.pathname + location.search}</div>
}

function renderAt(path: string) {
    return render(
        <QueryClientProvider client={queryClient}>
            <LayoutProvider>
            <MemoryRouter initialEntries={[path]}>
                <EdgeSwipeProvider>
                <Routes>
                    <Route path="/instructions" element={<div data-testid="list-page" />} />
                    <Route path="/instructions/new" element={<InstructionEditPage isNew />} />
                    <Route path="/instructions/:instructionId" element={<InstructionDetailPage />} />
                    <Route path="/instructions/:instructionId/edit" element={<InstructionEditPage />} />
                    <Route path="/instructions/:instructionId/history" element={<InstructionHistoryPage />} />
                    <Route path="/instructions/:instructionId/usage" element={<InstructionUsedInPage />} />
                </Routes>
                <LocationProbe />
                </EdgeSwipeProvider>
            </MemoryRouter>
            </LayoutProvider>
        </QueryClientProvider>,
    )
}

beforeEach(() => {
    jest.clearAllMocks()
    queryClient.clear()
    mockBreakpoints.mockReturnValue(desktop)
    auth()
    jest.spyOn(instructionService, 'getInstructionUsage').mockResolvedValue(USAGE)
    jest.spyOn(instructionService, 'getInstructionSharedUsers').mockResolvedValue([
        { customerId: 'c1', name: 'Priya Natarajan', username: 'priya', role: 'EDIT' },
    ])
    jest.spyOn(instructionService, 'createInstruction').mockResolvedValue({ ...V2, version: 3 })
    jest.spyOn(instructionService, 'deleteInstruction').mockResolvedValue(undefined)
    jest.spyOn(instructionService, 'shareInstruction').mockResolvedValue(undefined)
    jest.spyOn(instructionService, 'unshareInstruction').mockResolvedValue(undefined)
    jest.spyOn(window, 'confirm').mockReturnValue(true)
})

describe('InstructionDetailPage', () => {
    test('desktop: the instruction, who it is shared with, your usage and its versions', async () => {
        renderAt('/instructions/INS-1')

        const card = screen.getByTestId('instruction-card')
        expect(within(card).getByRole('heading', { name: 'Early-Stage AI VC' })).toBeInTheDocument()
        expect(within(card).getByText('Analysis')).toBeInTheDocument()
        expect(within(card).getByText('#startups')).toBeInTheDocument()
        expect(within(card).getByTestId('markdown')).toHaveTextContent('Your expertise lies in what will fail.')
        expect(within(card).getByText('Version 2')).toBeInTheDocument()

        const sharing = screen.getByTestId('instruction-sharing')
        expect(within(sharing).getByText('You own it')).toBeInTheDocument()
        expect(await within(sharing).findByText('Priya Natarajan')).toBeInTheDocument()
        expect(within(sharing).getByText('1 person can use it')).toBeInTheDocument()
        expect(within(sharing).getByText('Can edit')).toBeInTheDocument()

        const usage = screen.getByTestId('instruction-usage')
        expect(await within(usage).findByText('7')).toBeInTheDocument()
        expect(within(usage).getByRole('link', { name: /Startup Pitch Review/ })).toHaveAttribute('href', '/chat/CONV1')
        expect(within(usage).getByRole('link', { name: 'See all usage' })).toHaveAttribute('href', '/instructions/INS-1/usage')

        const timeline = screen.getByTestId('detail-timeline')
        const edited = within(timeline).getByTestId('timeline-v2')
        expect(within(edited).getByText('Edited')).toBeInTheDocument()
        expect(within(edited).getByText('AI').tagName).toBe('INS')
        expect(within(edited).queryByRole('link', { name: /View version/ })).not.toBeInTheDocument()
        const created = within(timeline).getByTestId('timeline-v1')
        expect(within(created).getByText('Created')).toBeInTheDocument()
        expect(within(created).getByRole('link', { name: /View version 1/ })).toHaveAttribute('href', '/instructions/INS-1?version=1')
    })

    test('desktop: Edit opens the editor in place and saves the next version', async () => {
        renderAt('/instructions/INS-1')

        await userEvent.click(screen.getByTestId('instruction-edit'))
        const text = screen.getByTestId('text-editor')
        expect(text).toHaveValue(V2.instruction)
        await userEvent.type(text, ' Be brief.')
        await userEvent.click(screen.getByTestId('instruction-save'))

        await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('Saved as version 3'))
        expect(instructionService.createInstruction).toHaveBeenCalledWith('tok', {
            instruction: `${V2.instruction} Be brief.`,
            instructionName: 'Early-Stage AI VC',
            existingInstructionId: 'INS-1',
        })
        expect(mockRefresh).toHaveBeenCalled()
        // The toast and the editor closing share a tick, but the close renders after it
        await waitFor(() => expect(screen.queryByTestId('text-editor')).not.toBeInTheDocument())
    })

    test('a failed save says so and keeps the editor', async () => {
        ;(instructionService.createInstruction as jest.Mock).mockRejectedValueOnce(new Error('500'))
        renderAt('/instructions/INS-1')

        await userEvent.click(screen.getByTestId('instruction-edit'))
        await userEvent.click(screen.getByTestId('instruction-save'))

        await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('Failed to save instruction'))
        expect(screen.getByTestId('text-editor')).toBeInTheDocument()
    })

    test('an older version shows a banner, and Restore saves its text as the next version', async () => {
        renderAt('/instructions/INS-1?version=1')

        expect(screen.getByTestId('instruction-older')).toHaveTextContent('This is version 1. Chats use the latest, version 2.')
        expect(screen.getByTestId('markdown')).toHaveTextContent(V1.instruction)
        await userEvent.click(screen.getByRole('button', { name: 'Restore as version 3' }))
        expect(screen.getByTestId('text-editor')).toHaveValue(V1.instruction)
        await userEvent.click(screen.getByTestId('instruction-save'))

        await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent(/^\/instructions\/INS-1$/))
    })

    test('Delete is in the more menu, asks first and returns to the list', async () => {
        renderAt('/instructions/INS-1')

        await userEvent.click(screen.getByTestId('detail-more'))
        await userEvent.click(screen.getByTestId('instruction-delete'))

        await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/instructions'))
        expect(window.confirm).toHaveBeenCalled()
        expect(instructionService.deleteInstruction).toHaveBeenCalledWith('tok', 'INS-1')
    })

    test('a failed delete says so', async () => {
        ;(instructionService.deleteInstruction as jest.Mock).mockRejectedValueOnce(new Error('403'))
        renderAt('/instructions/INS-1')

        await userEvent.click(screen.getByTestId('detail-more'))
        await userEvent.click(screen.getByTestId('instruction-delete'))

        await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('Failed to delete instruction. You can only delete instructions you own.'))
    })

    test('Share saves who can use it', async () => {
        renderAt('/instructions/INS-1')

        await userEvent.click(screen.getByTestId('instruction-share'))
        await userEvent.click(screen.getByText('Save sharing'))

        await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('Instruction share settings updated successfully!'))
        expect(instructionService.shareInstruction).toHaveBeenCalledWith('tok', 'INS-1', 'c1', 'EDIT')
        expect(instructionService.unshareInstruction).toHaveBeenCalledWith('tok', 'INS-1', 'c2')
    })

    test('a failed share says so', async () => {
        ;(instructionService.shareInstruction as jest.Mock).mockRejectedValueOnce(new Error('403'))
        renderAt('/instructions/INS-1')

        await userEvent.click(screen.getByTestId('instruction-share'))
        await userEvent.click(screen.getByText('Save sharing'))

        await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('Failed to share instruction. Make sure you own it.'))
    })

    test('view-only access shows no Edit, Share or Delete', async () => {
        auth({ customerInstructions: [{ ...V1, role: 'VIEW' }, { ...V2, role: 'VIEW' }] })
        renderAt('/instructions/INS-1')

        expect(within(screen.getByTestId('instruction-sharing')).getByText('Shared with you · view only')).toBeInTheDocument()
        expect(screen.queryByTestId('instruction-edit')).not.toBeInTheDocument()
        expect(screen.queryByTestId('instruction-share')).not.toBeInTheDocument()
        expect(screen.queryByTestId('detail-more')).not.toBeInTheDocument()
        expect(instructionService.getInstructionSharedUsers).not.toHaveBeenCalled()
    })

    describe('shared with you', () => {
        const owner = { ownerCustomerId: 'CU-M', ownerUsername: 'mara', canBlock: true, canRemove: true, alreadyReported: false }

        beforeEach(() => {
            jest.spyOn(moderationService, 'getSharedItemOwner').mockResolvedValue(owner)
            auth({ customerInstructions: [{ ...V1, role: 'VIEW' }, { ...V2, role: 'VIEW' }] })
        })

        test('desktop: Report and Block are in the more menu and name the owner', async () => {
            renderAt('/instructions/INS-1')
            const more = await screen.findByTestId('detail-more')
            await userEvent.click(more)
            expect(screen.getByTestId('instruction-report')).toHaveTextContent('Report instruction')
            expect(screen.getByTestId('instruction-block')).toHaveTextContent('Block @mara')
        })

        test('Report opens the report dialog', async () => {
            renderAt('/instructions/INS-1')
            await userEvent.click(await screen.findByTestId('detail-more'))
            await userEvent.click(screen.getByTestId('instruction-report'))
            expect(await screen.findByTestId('report-form')).toBeInTheDocument()
        })

        test('the owner sees neither', async () => {
            auth()
            renderAt('/instructions/INS-1')
            await screen.findByTestId('instruction-card')
            expect(moderationService.getSharedItemOwner).not.toHaveBeenCalled()
            expect(screen.queryByTestId('instruction-report')).not.toBeInTheDocument()
        })
    })

    test.each([
        ['CONTENT_BLOCKED', "Can't share this. It contains language that breaks our content rules, so it stays private."],
        ['BLOCKED', "You can't share with this user."],
    ])('a share refused with %s says why', async (code, message) => {
        ;(instructionService.shareInstruction as jest.Mock).mockRejectedValueOnce(new moderationService.ModerationError('no', code as 'BLOCKED'))
        jest.spyOn(console, 'error').mockImplementation(() => undefined)
        renderAt('/instructions/INS-1')
        await userEvent.click((await screen.findAllByTestId('instruction-share'))[0])
        await userEvent.click(screen.getByText('Save sharing'))
        await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith(message))
    })

    test('saving a listed word into a shared instruction says why', async () => {
        ;(instructionService.createInstruction as jest.Mock).mockRejectedValueOnce(new moderationService.ModerationError('no', 'CONTENT_BLOCKED'))
        jest.spyOn(console, 'error').mockImplementation(() => undefined)
        renderAt('/instructions/INS-1')
        await userEvent.click(await screen.findByTestId('instruction-edit'))
        await userEvent.click(screen.getByTestId('instruction-save'))
        await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith("Can't save this. It's shared with other people and contains language that breaks our content rules."))
    })

    test('an instruction you cannot see says so, and a signed-out visitor is sent to sign in', () => {
        auth({ customerInstructions: [], isAuthenticated: false })
        renderAt('/instructions/INS-1')

        expect(screen.getByTestId('instruction-not-found')).toBeInTheDocument()
        expect(mockLogin).toHaveBeenCalled()
    })

    test('phone: rows for sharing, usage and versions; Edit opens its own page', async () => {
        mockBreakpoints.mockReturnValue(phone)
        renderAt('/instructions/INS-1')

        expect(await screen.findByText('You and 1 other')).toBeInTheDocument()
        expect(await screen.findByText(/^7 chats · last/)).toBeInTheDocument()
        expect(screen.getByTestId('detail-row-versions')).toHaveTextContent('Version 2 ·')
        expect(screen.getByTestId('detail-row-versions')).toHaveAttribute('href', '/instructions/INS-1/history')
        expect(screen.getByTestId('detail-row-usage')).toHaveAttribute('href', '/instructions/INS-1/usage')
        await userEvent.click(screen.getByTestId('detail-row-sharing'))
        expect(screen.getByTestId('share-modal')).toBeInTheDocument()

        await userEvent.click(screen.getByTestId('instruction-edit'))
        expect(screen.getByTestId('location')).toHaveTextContent('/instructions/INS-1/edit')
    })

    test('phone: a swipe from the left edge goes back to the instructions', async () => {
        mockBreakpoints.mockReturnValue(phone)
        renderAt('/instructions/INS-1')

        swipeFromLeftEdge(await screen.findByTestId('instruction-text'))

        expect(await screen.findByTestId('list-page')).toBeInTheDocument()
        expect(screen.getByTestId('location')).toHaveTextContent(/^\/instructions$/)
    })

    test('phone: a swipe on a version\'s history goes back one step, to the instruction', async () => {
        mockBreakpoints.mockReturnValue(phone)
        renderAt('/instructions/INS-1/history')

        swipeFromLeftEdge(await screen.findByTestId('detail-back'))

        await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent(/^\/instructions\/INS-1$/))
    })

    test('phone: a long instruction is clipped until you ask for all of it', async () => {
        mockBreakpoints.mockReturnValue(phone)
        auth({ customerInstructions: [{ ...V2, instruction: 'Long. '.repeat(200) }] })
        renderAt('/instructions/INS-1')

        const toggle = screen.getByRole('button', { name: 'Show the full instruction' })
        expect(screen.getByTestId('instruction-text').className).toMatch(/clipped/)
        await userEvent.click(toggle)
        expect(screen.getByTestId('instruction-text').className).not.toMatch(/clipped/)
        expect(screen.getByRole('button', { name: 'Show less' })).toBeInTheDocument()
    })
})

describe('InstructionEditPage', () => {
    test('a new instruction is created and opened', async () => {
        jest.spyOn(instructionService, 'createInstruction').mockResolvedValueOnce({ ...V1, id: 'INS-new' })
        renderAt('/instructions/new')

        expect(screen.getByTestId('instruction-save')).toBeDisabled()
        await userEvent.type(screen.getByPlaceholderText('e.g., Code Reviewer Persona'), 'Reviewer')
        await userEvent.type(screen.getByTestId('instruction-edit-text'), 'Check every diff.')
        await userEvent.click(screen.getByTestId('instruction-save'))

        await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/instructions/INS-new'))
        expect(instructionService.createInstruction).toHaveBeenCalledWith('tok', {
            instruction: 'Check every diff.', instructionName: 'Reviewer', existingInstructionId: undefined,
        })
    })

    test('editing starts from an older version when asked, and saves the next version', async () => {
        renderAt('/instructions/INS-1/edit?version=1')

        expect(screen.getByTestId('instruction-edit-text')).toHaveValue(V1.instruction)
        expect(screen.getByText('Editing from version 1. Saving makes it version 3.')).toBeInTheDocument()
        await userEvent.click(screen.getByTestId('instruction-save'))

        await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent(/^\/instructions\/INS-1$/))
        expect(instructionService.createInstruction).toHaveBeenCalledWith('tok', {
            instruction: V1.instruction, instructionName: 'Early-Stage VC', existingInstructionId: 'INS-1',
        })
    })

    test('a failed save says so; Cancel goes back', async () => {
        ;(instructionService.createInstruction as jest.Mock).mockRejectedValueOnce(new Error('500'))
        renderAt('/instructions/INS-1/edit')

        await userEvent.click(screen.getByTestId('instruction-save'))
        await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('Failed to save instruction'))
        await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))

        expect(screen.getByTestId('location')).toHaveTextContent(/^\/instructions\/INS-1$/)
    })

    test('view-only access goes back to the instruction', () => {
        auth({ customerInstructions: [{ ...V2, role: 'VIEW' }] })
        renderAt('/instructions/INS-1/edit')

        expect(screen.getByTestId('location')).toHaveTextContent(/^\/instructions\/INS-1$/)
    })

    test('a signed-out visitor creating one is sent to sign in', () => {
        auth({ customerInstructions: [], isAuthenticated: false })
        renderAt('/instructions/new')

        expect(mockLogin).toHaveBeenCalled()
    })
})

describe('InstructionHistoryPage', () => {
    test('every version, newest first, with a link back', () => {
        mockBreakpoints.mockReturnValue(phone)
        renderAt('/instructions/INS-1/history')

        const timeline = screen.getByTestId('detail-timeline')
        expect(within(timeline).getAllByRole('listitem')).toHaveLength(2)
        expect(within(timeline).getByTestId('timeline-v1')).toHaveTextContent(V1.instruction)
        expect(screen.getByTestId('detail-back')).toHaveAttribute('href', '/instructions/INS-1')
    })
})

describe('InstructionUsedInPage', () => {
    test('your conversations that used it, and how many were deleted', async () => {
        mockBreakpoints.mockReturnValue(phone)
        renderAt('/instructions/INS-1/usage')

        const list = await screen.findByTestId('detail-conversations')
        expect(within(list).getByRole('link', { name: /Startup Pitch Review/ })).toHaveAttribute('href', '/chat/CONV1')
        expect(within(list).getByText(/^first used/)).toBeInTheDocument()
        expect(screen.getByText('Plus 5 conversations since deleted.')).toBeInTheDocument()
    })

    test('past the limit it says only the newest are listed', async () => {
        ;(instructionService.getInstructionUsage as jest.Mock).mockResolvedValueOnce({ ...USAGE, usageCount: 80, omitted: 30 })
        renderAt('/instructions/INS-1/usage')

        expect(await screen.findByText("Showing the newest 2. Older conversations aren't listed.")).toBeInTheDocument()
        expect(screen.queryByText(/since deleted/)).not.toBeInTheDocument()
    })

    test('never used, and a failed load, say so', async () => {
        ;(instructionService.getInstructionUsage as jest.Mock).mockResolvedValueOnce({ usageCount: 0, conversations: [] })
        const { unmount } = renderAt('/instructions/INS-1/usage')
        expect(await screen.findByText('Not used in a chat yet')).toBeInTheDocument()
        unmount()
        queryClient.clear()

        ;(instructionService.getInstructionUsage as jest.Mock).mockRejectedValueOnce(new Error('500'))
        renderAt('/instructions/INS-1/usage')
        expect(await screen.findByText("Couldn't load the usage.")).toBeInTheDocument()
    })
})
