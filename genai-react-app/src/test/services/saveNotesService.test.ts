import { saveNote, getNotes } from '../../services/saveNotesService';
import { HttpMethod } from '../../constants/http';
import { NotesModel } from '../../models/encoding.models';
import { config } from '../../config/env';

describe('saveNotesService', () => {
    const mockToken = 'mock-token';
    const mockNote: NotesModel = {
        noteKey: 'key-1',
        noteValue: 'value-1',
        title: 'Title 1',
        createdAt: '2023-01-01',
        client: 'genai-react-app',
    };

    beforeEach(() => {
        jest.clearAllMocks();
        global.fetch = jest.fn();
    });

    test('saveNote calls fetch with correct parameters', async () => {
        (global.fetch as jest.Mock).mockResolvedValue({
            ok: true,
        });

        await saveNote(mockNote, mockToken);

        expect(global.fetch).toHaveBeenCalledWith(
            `${config.backend.baseUrl}/api/v1/notes`,
            expect.objectContaining({
                method: HttpMethod.POST,
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${mockToken}`,
                },
                body: JSON.stringify({
                    client: 'genai-react-app',
                    data: {
                        note_key: mockNote.noteKey,
                        note_value: mockNote.noteValue,
                        title: mockNote.title,
                        created_at: mockNote.createdAt,
                    },
                }),
            })
        );
    });

    test('saveNote throws error when response is not ok', async () => {
        (global.fetch as jest.Mock).mockResolvedValue({
            ok: false,
            status: 500,
            statusText: 'Internal Server Error',
        });

        await expect(saveNote(mockNote, mockToken)).rejects.toThrow(
            'Failed to save note: 500 Internal Server Error'
        );
    });

    test('getNotes fetches and returns the notes array', async () => {
        const notes = [
            { noteKey: 'k1', noteValue: 'v1', title: 'T1', createdAt: '2026-08-01', updatedAt: '2026-08-01' },
        ];
        (global.fetch as jest.Mock).mockResolvedValue({
            ok: true,
            json: jest.fn().mockResolvedValue({ notes }),
        });

        const result = await getNotes(mockToken);

        expect(global.fetch).toHaveBeenCalledWith(
            `${config.backend.baseUrl}/api/v1/notes`,
            expect.objectContaining({
                method: HttpMethod.GET,
                headers: {
                    Authorization: `Bearer ${mockToken}`,
                },
            })
        );
        expect(result).toEqual(notes);
    });

    test('getNotes returns empty array when notes field is missing', async () => {
        (global.fetch as jest.Mock).mockResolvedValue({
            ok: true,
            json: jest.fn().mockResolvedValue({}),
        });

        const result = await getNotes(mockToken);

        expect(result).toEqual([]);
    });

    test('getNotes throws error when response is not ok', async () => {
        (global.fetch as jest.Mock).mockResolvedValue({
            ok: false,
            status: 403,
            statusText: 'Forbidden',
        });

        await expect(getNotes(mockToken)).rejects.toThrow(
            'Failed to fetch notes: 403 Forbidden'
        );
    });
});
