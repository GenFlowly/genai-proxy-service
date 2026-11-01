import { NotesModel } from '../models/encoding.models'
import { HttpMethod } from '../constants/http'

import { config } from '../config/env'
import {
    loadNotesCache,
    saveNotesCache,
} from '../components/widgets/SidebarWidgets/SavedNotesWidget/notesCache'

const API_URL = `${config.backend.baseUrl}/api/v1/notes`;

/**
 * Write-through into the cached saved-notes list, together with the
 * successful mutation — call sites never mirror it ad hoc. Only an existing
 * cache is patched: fabricating a list from one note would paint it as the
 * customer's complete set on the next mount.
 */
function patchNotesCache(patch: (cached: SavedNote[]) => SavedNote[]): void {
    const customerId = localStorage.getItem('customerId')
    if (!customerId) return
    const cached = loadNotesCache(customerId)
    if (cached) saveNotesCache(customerId, patch(cached))
}

export interface SavedNote {
    noteKey: string
    noteValue: string
    title: string
    createdAt: string
    updatedAt: string
}

export async function getNotes(token: string): Promise<SavedNote[]> {
    const response = await fetch(API_URL, {
        method: HttpMethod.GET,
        headers: {
            Authorization: `Bearer ${token}`,
        },
    })

    if (!response.ok) {
        throw new Error(`Failed to fetch notes: ${response.status} ${response.statusText}`)
    }

    const data = await response.json()
    return data.notes ?? []
}

export interface SaveNoteOptions {
    // false skips the embedding pipeline on the server (intermediate autosaves);
    // the final save of an editing session sends true
    encode?: boolean
    // true lets the request outlive the page (flush on tab close)
    keepalive?: boolean
}

export interface SaveNoteResult {
    // The note's effective title: the one already set, or one the server
    // generated during this save; null while the note has no real title
    title: string | null
}

export async function saveNote(
    note: NotesModel,
    token: string,
    options: SaveNoteOptions = {}
): Promise<SaveNoteResult> {
    const payload = {
        client: 'genai-react-app',
        encode: options.encode ?? true,
        data: {
            note_key: note.noteKey,
            note_value: note.noteValue,
            title: note.title,
            created_at: note.createdAt,
        }
    }

    const response = await fetch(API_URL, {
        method: HttpMethod.POST,
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
        keepalive: options.keepalive ?? false,
    })

    if (!response.ok) {
        throw new Error(`Failed to save note: ${response.status} ${response.statusText}`)
    }

    let title: string | null = null
    try {
        const data = await response.json()
        title = data?.title ?? null
    } catch {
        // Tolerate empty response bodies
    }

    if (note.noteKey) {
        const noteKey = note.noteKey
        const now = new Date().toISOString()
        const effectiveTitle = title ?? note.title ?? ''
        patchNotesCache(cached => {
            const exists = cached.some(n => n.noteKey === noteKey)
            if (exists) {
                return cached.map(n =>
                    n.noteKey === noteKey
                        ? { ...n, noteValue: note.noteValue, title: effectiveTitle, updatedAt: now }
                        : n
                )
            }
            return [
                {
                    noteKey,
                    noteValue: note.noteValue,
                    title: effectiveTitle,
                    createdAt: note.createdAt || now,
                    updatedAt: now,
                },
                ...cached,
            ]
        })
    }

    return { title }
}

export async function deleteNote(token: string, noteKey: string): Promise<void> {
    const response = await fetch(`${API_URL}/${encodeURIComponent(noteKey)}`, {
        method: HttpMethod.DELETE,
        headers: {
            Authorization: `Bearer ${token}`,
        },
    })

    if (!response.ok) {
        throw new Error(`Failed to delete note: ${response.status} ${response.statusText}`)
    }

    patchNotesCache(cached => cached.filter(n => n.noteKey !== noteKey))
}
