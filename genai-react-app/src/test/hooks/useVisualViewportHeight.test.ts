import { renderHook, act } from '@testing-library/react';
import { useVisualViewportHeight } from '../../hooks/useVisualViewportHeight';

type Listener = () => void;

// jsdom has no VisualViewport implementation, so we install a minimal mock
// that lets tests change the height and fire resize/scroll events
function createMockViewport(initialHeight: number) {
    const listeners: Record<string, Listener[]> = { resize: [], scroll: [] };
    return {
        height: initialHeight,
        offsetTop: 0,
        addEventListener: jest.fn((event: string, cb: Listener) => {
            listeners[event].push(cb);
        }),
        removeEventListener: jest.fn((event: string, cb: Listener) => {
            listeners[event] = listeners[event].filter(l => l !== cb);
        }),
        fire(event: 'resize' | 'scroll') {
            listeners[event].forEach(cb => cb());
        },
    };
}

function getVvh(): string {
    return document.documentElement.style.getPropertyValue('--vvh');
}

describe('useVisualViewportHeight Hook', () => {
    const originalVisualViewport = (window as any).visualViewport;

    beforeEach(() => {
        // The hook coalesces event bursts into one rAF; fake timers let
        // tests flush that frame deterministically
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
        (window as any).visualViewport = originalVisualViewport;
        document.documentElement.style.removeProperty('--vvh');
        document.documentElement.style.removeProperty('--vv-offset');
    });

    // Fires a viewport event and advances fake timers past the rAF frame
    // the hook schedules its style write in
    const fireAndFlush = (viewport: ReturnType<typeof createMockViewport>, event: 'resize' | 'scroll') => {
        act(() => {
            viewport.fire(event);
            jest.advanceTimersByTime(20);
        });
    };

    test('sets --vvh from visualViewport.height on mount', () => {
        (window as any).visualViewport = createMockViewport(660);

        renderHook(() => useVisualViewportHeight());

        expect(getVvh()).toBe('660px');
    });

    test('updates --vvh when the visual viewport resizes (keyboard open/close)', () => {
        const viewport = createMockViewport(660);
        (window as any).visualViewport = viewport;

        renderHook(() => useVisualViewportHeight());

        viewport.height = 340; // keyboard opened
        fireAndFlush(viewport, 'resize');
        expect(getVvh()).toBe('340px');

        viewport.height = 660; // keyboard closed
        fireAndFlush(viewport, 'resize');
        expect(getVvh()).toBe('660px');
    });

    test('updates --vvh on visual viewport scroll', () => {
        const viewport = createMockViewport(660);
        (window as any).visualViewport = viewport;

        renderHook(() => useVisualViewportHeight());

        viewport.height = 500;
        fireAndFlush(viewport, 'scroll');
        expect(getVvh()).toBe('500px');
    });

    test('re-reads the viewport on pageshow (bfcache restore fires no resize)', () => {
        const viewport = createMockViewport(660);
        (window as any).visualViewport = viewport;

        renderHook(() => useVisualViewportHeight());
        expect(getVvh()).toBe('660px');

        // Simulate coming back from bfcache with a different real viewport:
        // no visualViewport resize event fires, only window pageshow
        viewport.height = 740;
        act(() => {
            window.dispatchEvent(new Event('pageshow'));
            jest.advanceTimersByTime(20);
        });

        expect(getVvh()).toBe('740px');
    });

    test('removes listeners and the --vvh variable on unmount', () => {
        const viewport = createMockViewport(660);
        (window as any).visualViewport = viewport;

        const { unmount } = renderHook(() => useVisualViewportHeight());
        expect(getVvh()).toBe('660px');

        unmount();

        expect(getVvh()).toBe('');
        expect(viewport.removeEventListener).toHaveBeenCalledWith('resize', expect.any(Function));
        expect(viewport.removeEventListener).toHaveBeenCalledWith('scroll', expect.any(Function));
    });

    test('no-ops when visualViewport is unavailable', () => {
        (window as any).visualViewport = undefined;

        expect(() => renderHook(() => useVisualViewportHeight())).not.toThrow();
        expect(getVvh()).toBe('');
    });
});
