import React from 'react'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route } from 'react-router'
import MemoryHistoryPage from '../../pages/MemoryPage/MemoryHistoryPage'
import MemoryInferencePage from '../../pages/MemoryPage/MemoryInferencePage'
import { queryClient } from '../../queryClient'
import { memoriesCache } from '../../services/memoriesService'
import { FakeMemoryApi, memory, renderMemoryRoutes } from './MemoryPage/memoryTestKit'
import inference from '../fixtures/memoryInferenceRun.json'

const mockFetch = jest.fn()
jest.mock('../../utils/apiUtils', () => ({ fetchWithRetry: (...args: unknown[]) => mockFetch(...args) }))
jest.mock('../../components/navbar/Navbar', () => () => <div data-testid="navbar" />)
jest.mock('../../context/AuthContext', () => ({
    useAuth: () => ({ isAuthenticated: true, customerId: 'CU1', getAccessTokenSilently: jest.fn().mockResolvedValue('tok') }),
}))
jest.mock('../../context/ToastContext', () => ({ useToast: () => ({ showToast: jest.fn() }) }))
jest.mock('../../hooks/useResponsiveBreakpoints', () => ({
    useResponsiveBreakpoints: () => ({ width: 1280, height: 900, isMobile: false, isNarrow: false }),
}))
jest.mock('../../hooks/useVendorDisplayNames', () => ({
    useVendorDisplayNames: () => (id: string) => ({ OPENAI: 'OpenAI', CLAUDE: 'Anthropic' } as Record<string, string>)[id] ?? id,
}))

const MEMORY_ID = inference.memory.memoryId
const RUN_ID = inference.run.runId
let api: FakeMemoryApi
let inferenceStatus = 200

function renderAt(path: string) {
    return renderMemoryRoutes(path, (
        <>
            <Route path="/memory" element={<div data-testid="list-page" />} />
            <Route path="/memory/:memoryId" element={<div data-testid="detail-page" />} />
            <Route path="/memory/:memoryId/history" element={<MemoryHistoryPage />} />
            <Route path="/memory/:memoryId/inference/:runId" element={<MemoryInferencePage />} />
            <Route path="/chat/:conversationId" element={<div data-testid="chat-page" />} />
        </>
    ))
}

beforeEach(() => {
    queryClient.clear()
    memoriesCache.clear()
    inferenceStatus = 200
    api = new FakeMemoryApi()
    api.memories = [memory(MEMORY_ID, inference.memory.text)]
    api.changes[MEMORY_ID] = [{
        changeId: 'c1', type: 'LEARNED', createdAt: '2026-11-22T14:32:05Z', version: 1, text: inference.memory.text,
        sourceType: 'CONVERSATION', conversationId: inference.run.conversationId!, messageId: 'U5',
        conversationTitle: inference.conversationTitle, conversationAvailable: true, runId: RUN_ID,
    }]
    mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
        if (decodeURIComponent(new URL(url).pathname).endsWith(`/memories/${MEMORY_ID}/inference/${RUN_ID}`)) {
            return inferenceStatus === 200
                ? { ok: true, status: 200, statusText: 'OK', json: async () => inference }
                : { ok: false, status: inferenceStatus, statusText: 'Error', json: async () => ({ error: 'Memory not found' }) }
        }
        return api.handle(url, init)
    })
})

const path = `/memory/${encodeURIComponent(MEMORY_ID)}/inference/${encodeURIComponent(RUN_ID)}`

test('the page tells the run as a story with its facts', async () => {
    renderAt(path)

    expect(await screen.findByText('Triggered when the turn finished')).toBeInTheDocument()
    expect(screen.getByText(/answered by 2 AIs \(OpenAI, Anthropic\)/)).toBeInTheDocument()
    expect(screen.getByTestId('memory-inference-run')).toHaveTextContent('gpt-5.4 on your OpenAI key')
    expect(screen.getByTestId('memory-inference-source')).toHaveTextContent('iOS App Growth Strategy for Paygo')
})

test('Open conversation goes to the chat', async () => {
    renderAt(path)

    await userEvent.click(await screen.findByTestId('memory-inference-open-conversation'))
    expect(await screen.findByTestId('chat-page')).toBeInTheDocument()
})

test('a run that was never recorded says so', async () => {
    inferenceStatus = 404
    renderAt(path)

    expect(await screen.findByText("This run wasn't recorded, or the memory doesn't exist anymore.")).toBeInTheDocument()
})

test('a change made by a run links its history row to the run', async () => {
    renderAt(`/memory/${encodeURIComponent(MEMORY_ID)}/history`)

    const link = await screen.findByTestId('timeline-inference-c1')
    expect(link).toHaveTextContent('How it was inferred')
    await userEvent.click(link)
    await waitFor(() => expect(screen.getByTestId('memory-inference-page')).toBeInTheDocument())
})
