import { renderHook } from '@testing-library/react';
import { useWidgetResolver } from '../../hooks/useWidgetResolver';
import { WIDGET_REGISTRY } from '../../registry/WidgetRegistry';

// Mock the registry
jest.mock('../../registry/WidgetRegistry', () => ({
    WIDGET_REGISTRY: {
        'VISIBLE_WIDGET': {
            id: 'VISIBLE_WIDGET',
            component: () => 'Visible',
            isVisible: () => true
        },
        'HIDDEN_WIDGET': {
            id: 'HIDDEN_WIDGET',
            component: () => 'Hidden',
            isVisible: () => false
        },
        'NO_VISIBILITY_PROP_WIDGET': {
            id: 'NO_VISIBILITY_PROP_WIDGET',
            component: () => 'Always Visible'
        }
    }
}));

describe('useWidgetResolver', () => {
    test('resolves visible widgets', () => {
        const { result } = renderHook(() => useWidgetResolver(['VISIBLE_WIDGET']));
        expect(result.current).toHaveLength(1);
        expect(result.current[0].id).toBe('VISIBLE_WIDGET');
    });

    test('excludes hidden widgets', () => {
        const { result } = renderHook(() => useWidgetResolver(['HIDDEN_WIDGET']));
        expect(result.current).toHaveLength(0);
    });

    test('includes widgets without isVisible property', () => {
        const { result } = renderHook(() => useWidgetResolver(['NO_VISIBILITY_PROP_WIDGET']));
        expect(result.current).toHaveLength(1);
    });

    test('handles multiple widgets', () => {
        const { result } = renderHook(() => useWidgetResolver(['VISIBLE_WIDGET', 'HIDDEN_WIDGET', 'NO_VISIBILITY_PROP_WIDGET']));
        expect(result.current).toHaveLength(2);
        const ids = result.current.map(w => w.id);
        expect(ids).toContain('VISIBLE_WIDGET');
        expect(ids).toContain('NO_VISIBILITY_PROP_WIDGET');
        expect(ids).not.toContain('HIDDEN_WIDGET');
    });

    test('handles unknown IDs gracefully (logs warning but does not crash)', () => {
        const consoleSpy = jest.spyOn(console, 'warn').mockImplementation(() => { });
        const { result } = renderHook(() => useWidgetResolver(['UNKNOWN_ABC']));
        expect(result.current).toHaveLength(0);
        expect(consoleSpy).toHaveBeenCalled();
        consoleSpy.mockRestore();
    });
});
