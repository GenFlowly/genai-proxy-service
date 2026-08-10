import { renderHook, act } from '@testing-library/react';
import { useAutosave } from '../../hooks/useAutosave';

describe('useAutosave', () => {
    let save: jest.Mock;

    beforeEach(() => {
        jest.useFakeTimers();
        save = jest.fn().mockResolvedValue(undefined);
    });

    afterEach(() => {
        jest.useRealTimers();
        jest.clearAllMocks();
    });

    const advance = async (ms: number) => {
        await act(async () => {
            jest.advanceTimersByTime(ms);
        });
    };

    test('does not save before the debounce delay', async () => {
        const { rerender } = renderHook(
            ({ content }) => useAutosave({ content, save }),
            { initialProps: { content: '' } }
        );

        rerender({ content: 'hello' });
        await advance(1000);

        expect(save).not.toHaveBeenCalled();
    });

    test('saves without encoding after the debounce delay', async () => {
        const { rerender } = renderHook(
            ({ content }) => useAutosave({ content, save }),
            { initialProps: { content: '' } }
        );

        rerender({ content: 'hello' });
        await advance(1500);

        expect(save).toHaveBeenCalledTimes(1);
        expect(save).toHaveBeenCalledWith('hello', { encode: false, keepalive: false });
    });

    test('max-wait forces a save during continuous typing', async () => {
        const { rerender } = renderHook(
            ({ content }) => useAutosave({ content, save }),
            { initialProps: { content: '' } }
        );

        // Keep typing every second so the debounce never fires on its own
        let content = '';
        for (let i = 0; i < 8; i++) {
            content += 'x';
            rerender({ content });
            await advance(1000);
        }

        expect(save).toHaveBeenCalledTimes(1);
        expect(save.mock.calls[0][1]).toEqual({ encode: false, keepalive: false });
    });

    test('saves with encoding once typing goes idle', async () => {
        const { rerender } = renderHook(
            ({ content }) => useAutosave({ content, save }),
            { initialProps: { content: '' } }
        );

        rerender({ content: 'hello' });
        await advance(1500); // debounce save, encode=false
        await advance(8500); // idle threshold reached (10s after last change)

        expect(save).toHaveBeenCalledTimes(2);
        expect(save).toHaveBeenLastCalledWith('hello', { encode: true, keepalive: false });
    });

    test('skips the save when content is unchanged since the last save', async () => {
        const { rerender } = renderHook(
            ({ content }) => useAutosave({ content, save }),
            { initialProps: { content: 'same' } }
        );

        rerender({ content: 'same' });
        await advance(20000);

        expect(save).not.toHaveBeenCalled();
    });

    test('does not save while disabled', async () => {
        const { rerender } = renderHook(
            ({ content, enabled }) => useAutosave({ content, save, enabled }),
            { initialProps: { content: '', enabled: false } }
        );

        rerender({ content: 'hello', enabled: false });
        await advance(20000);

        expect(save).not.toHaveBeenCalled();
    });

    test('flush saves immediately with encoding', async () => {
        const { result, rerender } = renderHook(
            ({ content }) => useAutosave({ content, save }),
            { initialProps: { content: '' } }
        );

        rerender({ content: 'hello' });
        await act(async () => {
            result.current.flush();
        });

        expect(save).toHaveBeenCalledTimes(1);
        expect(save).toHaveBeenCalledWith('hello', { encode: true, keepalive: false });

        // Timers were cancelled: nothing else fires later
        await advance(20000);
        expect(save).toHaveBeenCalledTimes(1);
    });

    test('queues a single trailing save while one is in flight', async () => {
        let resolveFirst: () => void = () => {};
        save.mockImplementationOnce(
            () => new Promise<void>((resolve) => { resolveFirst = resolve; })
        );

        const { rerender } = renderHook(
            ({ content }) => useAutosave({ content, save }),
            { initialProps: { content: '' } }
        );

        rerender({ content: 'first' });
        await advance(1500);
        expect(save).toHaveBeenCalledTimes(1);

        // Two more edits while the first save hangs
        rerender({ content: 'second' });
        await advance(1500);
        rerender({ content: 'third' });
        await advance(1500);

        await act(async () => {
            resolveFirst();
        });

        // Only one trailing save, carrying the latest content
        expect(save).toHaveBeenCalledTimes(2);
        expect(save.mock.calls[1][0]).toBe('third');
    });

    test('reports error status and retries after a failed save', async () => {
        save.mockRejectedValueOnce(new Error('boom')).mockResolvedValue(undefined);

        const { result, rerender } = renderHook(
            ({ content }) => useAutosave({ content, save }),
            { initialProps: { content: '' } }
        );

        rerender({ content: 'hello' });
        await advance(1500);
        expect(result.current.status).toBe('error');

        await advance(5000);
        expect(save).toHaveBeenCalledTimes(2);
        expect(result.current.status).toBe('saved');
        expect(result.current.lastSavedAt).not.toBeNull();
    });

    test('reset drops pending work and rebaselines', async () => {
        const { result, rerender } = renderHook(
            ({ content }) => useAutosave({ content, save }),
            { initialProps: { content: '' } }
        );

        rerender({ content: 'draft' });
        await act(async () => {
            result.current.reset('loaded note');
        });
        rerender({ content: 'loaded note' });
        await advance(20000);

        expect(save).not.toHaveBeenCalled();
    });

    test('flushes with keepalive when the tab is hidden', async () => {
        const { rerender } = renderHook(
            ({ content }) => useAutosave({ content, save }),
            { initialProps: { content: '' } }
        );

        rerender({ content: 'hello' });
        await act(async () => {
            Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
            document.dispatchEvent(new Event('visibilitychange'));
        });

        expect(save).toHaveBeenCalledWith('hello', { encode: true, keepalive: true });
        Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    });
});
