import { getPageConfig, PAGE_WIDGET_CONFIG, PageId } from '../../config/PageWidgetConfig';

describe('PageWidgetConfig', () => {
    test('getPageConfig returns correct config for CHAT_PAGE', () => {
        const config = getPageConfig('CHAT_PAGE');
        expect(config).toBeDefined();
        expect(config.pageId).toBe('CHAT_PAGE');
        expect(config.leftSidebar.length).toBeGreaterThan(0);
        expect(config.centerSection).toContain('CONVERSATION_LIST');
    });

    test('getPageConfig returns correct config for MEMORY_PAGE', () => {
        const config = getPageConfig('MEMORY_PAGE');
        expect(config).toBeDefined();
        expect(config.pageId).toBe('MEMORY_PAGE');
        expect(config.centerSection).toContain('NOTES_WIDGET');
    });

    test('getPageConfig returns default (CHAT_PAGE) for unknown ID (safety fallback)', () => {
        // Casting string to PageId to simulate invalid input if TS allows or dynamic usage
        const config = getPageConfig('UNKNOWN_ID' as PageId);
        expect(config).toBeDefined();
        // Assuming implementation defaults to first element or similar
        // Implementation: PAGE_WIDGET_CONFIG.find(c => c.pageId === pageId) || PAGE_WIDGET_CONFIG[0]
        expect(config.pageId).toBe('CHAT_PAGE');
    });
});
