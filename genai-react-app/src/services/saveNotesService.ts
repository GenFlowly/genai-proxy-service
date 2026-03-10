import { NotesModel } from '../models/encoding.models'
import { HttpMethod } from '../constants/http'

// TODO remove Hardcoded API URL as requested
const API_URL = 'https://pzf0twaaq5.execute-api.us-east-1.amazonaws.com/development/encode'

export async function saveNote(
    note: NotesModel,
    token: string
): Promise<void> {
    const payload = {
        note_key: note.noteKey,
        note_value: note.noteValue,
        title: note.title,
        created_at: note.createdAt,
        client: note.client,
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
