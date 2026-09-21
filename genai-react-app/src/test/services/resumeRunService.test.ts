import { resumeRun } from '../../services/resumeRunService';
import { endpoints } from '../../config/endpoints';
import { HttpMethod } from '../../constants/http';

describe('resumeRunService', () => {
    const realFetch = global.fetch;
    afterEach(() => { global.fetch = realFetch; });

    test('POSTs the reply and returns resumed=true', async () => {
        global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ resumed: true }) }) as any;
        const ok = await resumeRun('tok', 'r1', 'c1', { reply: 'yes' });
        expect(ok).toBe(true);
        expect(global.fetch).toHaveBeenCalledWith(
            endpoints.resumeRun('r1', 'c1'),
            expect.objectContaining({
                method: HttpMethod.POST,
                headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok' },
                body: JSON.stringify({ reply: 'yes' }),
            })
        );
    });

    test('returns false on a non-ok response', async () => {
        global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500 }) as any;
        expect(await resumeRun('t', 'r', 'c', {})).toBe(false);
    });

    test('returns false when resumed flag is not true', async () => {
        global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ resumed: false }) }) as any;
        expect(await resumeRun('t', 'r', 'c', {})).toBe(false);
    });

    test('returns true when an ok response body is not JSON', async () => {
        global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => { throw new Error('no json'); } }) as any;
        expect(await resumeRun('t', 'r', 'c', {})).toBe(true);
    });
});
