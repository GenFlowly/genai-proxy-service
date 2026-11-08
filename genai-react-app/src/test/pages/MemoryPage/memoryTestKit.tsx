import React from 'react'
import { render } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { QueryClientProvider } from '@tanstack/react-query'
import { queryClient } from '../../../queryClient'
import { EdgeSwipeProvider } from '../../../context/EdgeSwipeContext'
import { LayoutProvider } from '../../../context/LayoutContext'
import { CustomerMemory, MemoryChange, MemoryUsagePage } from '../../../models/memory.models'

export const PROJECTS = [
    { projectId: 'PRJa', name: 'Market research', createdAt: 't', updatedAt: 't' },
    { projectId: 'PRJb', name: 'Client dashboard', createdAt: 't', updatedAt: 't' },
]

export function memory(id: string, text: string, overrides: Partial<CustomerMemory> = {}): CustomerMemory {
    return {
        memoryId: id,
        text,
        kind: 'CORE',
        category: 'work',
        sourceType: 'CONVERSATION',
        createdAt: '2026-10-01T10:00:00Z',
        updatedAt: '2026-10-01T10:00:00Z',
        placements: [{ projectId: null, kind: 'CORE' }],
        version: 1,
        tracked: true,
        hitCount: 0,
        ...overrides,
    }
}

export interface FakeCall {
    method: string
    path: string
    query: URLSearchParams
    body: any
}

/**
 * An in-memory stand-in for the memory API behind fetchWithRetry, recording
 * every call. Paths are decoded, so "MEM%23x" reads as "MEM#x".
 */
export class FakeMemoryApi {
    memories: CustomerMemory[] = []
    changes: Record<string, MemoryChange[]> = {}
    usage: Record<string, MemoryUsagePage[]> = {}
    calls: FakeCall[] = []
    failList = false
    refuseWith: number | null = null

    handle = async (url: string, init: RequestInit = {}) => {
        const parsed = new URL(url)
        const method = (init.method ?? 'GET').toUpperCase()
        const path = decodeURIComponent(parsed.pathname.replace(/^\/api\/v1/, ''))
        const body = init.body ? JSON.parse(String(init.body)) : undefined
        this.calls.push({ method, path, query: parsed.searchParams, body })
        const ok = (data: unknown) => ({ ok: true, status: 200, statusText: 'OK', json: async () => data })
        const fail = (status: number) => ({ ok: false, status, statusText: 'Error', json: async () => ({ error: `status ${status}` }) })

        if (path === '/projects') return ok({ projects: PROJECTS })
        if (path === '/memories' && method === 'GET') return this.failList ? fail(500) : ok({ memories: this.memories })
        if (path === '/memories' && method === 'POST') {
            const created = memory('MEM#new', body.text, {
                sourceType: 'USER',
                category: null,
                placements: [{ projectId: body.projectId, kind: body.kind }],
                kind: body.kind,
            })
            this.memories = [created, ...this.memories]
            return ok({ memory: created })
        }
        if (path === '/memories' && method === 'DELETE') {
            const deleted = this.memories.length
            this.memories = []
            return ok({ deleted })
        }
        const match = path.match(/^\/memories\/(MEM#[^/]+)(?:\/(move|copy|usage))?$/)
        if (!match) return fail(404)
        if (this.refuseWith && method !== 'GET') return fail(this.refuseWith)
        const [, id, action] = match
        const current = this.memories.find(m => m.memoryId === id)
        if (!current) return fail(404)
        const replace = (next: CustomerMemory) => {
            this.memories = this.memories.map(m => (m.memoryId === id ? next : m))
            return ok({ memory: next })
        }
        if (action === 'usage') {
            const pages = this.usage[id] ?? [{ items: [], total: current.hitCount }]
            const index = parsed.searchParams.get('cursor') ? Number(parsed.searchParams.get('cursor')) : 0
            return ok(pages[index])
        }
        if (action === 'move') {
            const target = { projectId: body.toProjectId, kind: body.kind }
            const placements = body.toProjectId == null || body.fromProjectId == null
                ? [target]
                : [...current.placements.filter(p => p.projectId !== body.fromProjectId && p.projectId !== body.toProjectId), target]
            return replace({ ...current, placements, kind: placements[0].kind })
        }
        if (action === 'copy') {
            return replace({ ...current, placements: [...current.placements, { projectId: body.toProjectId, kind: body.kind }] })
        }
        if (method === 'GET') {
            const changes = this.changes[id] ?? [
                { changeId: 'c1', type: 'LEARNED', createdAt: current.createdAt, version: 1, text: current.text },
            ]
            return ok({
                memory: current,
                versions: changes.filter(c => c.version != null).sort((a, b) => (b.version ?? 0) - (a.version ?? 0)),
                changes: [...changes].reverse(),
            })
        }
        if (method === 'PUT') {
            if (body.baseVersion !== current.version) return fail(409)
            return replace({ ...current, text: body.text, version: current.version + 1 })
        }
        if (method === 'DELETE') {
            const projectId = parsed.searchParams.get('projectId')
            if (projectId && current.placements.length > 1) {
                replace({ ...current, placements: current.placements.filter(p => p.projectId !== projectId) })
                return ok({ status: 'success', deleted: false })
            }
            this.memories = this.memories.filter(m => m.memoryId !== id)
            return ok({ status: 'success', deleted: true })
        }
        return fail(405)
    }

    last(method: string): FakeCall | undefined {
        return [...this.calls].reverse().find(call => call.method === method)
    }
}

function LocationProbe() {
    const location = useLocation()
    return <div data-testid="location">{location.pathname + location.search}</div>
}

/** Renders the memory routes at [path] with the app's query client and a real layout context. */
export function renderMemoryRoutes(path: string, routes: React.ReactElement) {
    return render(
        <QueryClientProvider client={queryClient}>
            <MemoryRouter initialEntries={[path]}>
                <LayoutProvider>
                    <EdgeSwipeProvider>
                        <Routes>{routes}</Routes>
                        <LocationProbe />
                    </EdgeSwipeProvider>
                </LayoutProvider>
            </MemoryRouter>
        </QueryClientProvider>
    )
}
