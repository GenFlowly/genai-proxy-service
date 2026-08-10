import { NotesModel } from '../models/encoding.models'
import { HttpMethod } from '../constants/http'

import { config } from '../config/env'

const API_URL = `${config.backend.baseUrl}/api/v1/notes`;

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

export async function saveNote(
    note: NotesModel,
    token: string
): Promise<void> {
    const payload = {
        client: 'genai-react-app',
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
    })

    if (!response.ok) {
        throw new Error(`Failed to save note: ${response.status} ${response.statusText}`)
    }
}
