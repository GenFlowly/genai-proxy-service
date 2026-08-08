import { saveNote } from '../../services/saveNotesService';
import { HttpMethod } from '../../constants/http';
import { NotesModel } from '../../models/encoding.models';

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
            'https://pzf0twaaq5.execute-api.us-east-1.amazonaws.com/development/encode-notes',
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
});
