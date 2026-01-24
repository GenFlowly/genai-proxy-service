import { CacheManager } from '../../utils/cache';

describe('CacheManager', () => {
    let cache: CacheManager;
    const prefix = 'test_cache_';

    beforeEach(() => {
        localStorage.clear();
        jest.clearAllMocks();
        cache = new CacheManager({ prefix, ttlMs: 1000 });
    });

    test('Validation: set, get, delete', () => {
        cache.set('key1', { foo: 'bar' });
        expect(cache.get('key1')).toEqual({ foo: 'bar' });
        expect(cache.has('key1')).toBe(true);

        cache.delete('key1');
        expect(cache.get('key1')).toBeNull();
        expect(cache.has('key1')).toBe(false);
    });

    test('Expiry', async () => {
        jest.useFakeTimers();
        cache.set('expired', 'data');

        jest.advanceTimersByTime(1100); // 1.1s > 1s TTL

        expect(cache.get('expired')).toBeNull();
        // Should have deleted it internally
        expect(localStorage.getItem(prefix + 'expired')).toBeNull();

        jest.useRealTimers();
    });

    test('Clear and DeleteByPrefix', () => {
        cache.set('a', 1);
        cache.set('b', 2);
        localStorage.setItem('other_pref', 'keep');

        // Delete by prefix (internal method exposed publicly on class?)
        // The method is `deleteByPrefix` looking at code.
        cache.deleteByPrefix('a');
        // Logic: searchPrefix = prefix + 'a' -> 'test_cache_a'
        // 'a' key -> 'test_cache_a'. Should be deleted.
        // 'b' key -> 'test_cache_b'. Should stay?

        expect(cache.get('a')).toBeNull();
        expect(cache.get('b')).toBe(2);

        cache.clear();
        expect(cache.get('b')).toBeNull();
        expect(localStorage.getItem('other_pref')).toBe('keep');
    });

    test('Stats', () => {
        cache.set('1', 'x'); // len 1 + overhead JSON
        // {"data":"x","timestamp":...} -> len approx 30-40
        const stats = cache.getStats();
        expect(stats.count).toBe(1);
        expect(stats.size).toBeGreaterThan(0);
    });

    test('Error Handling: localStorage throws (set)', () => {
        const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => { });
        jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Quota'); });

        cache.set('fail', 'data');
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to save'), expect.any(Error));
        consoleSpy.mockRestore();
    });

    test('Error Handling: localStorage throws (get)', () => {
        cache.set('ok', 'data');
        const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => { });
        jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('Read Error'); });

        expect(cache.get('ok')).toBeNull();
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to read'), expect.any(Error));
        consoleSpy.mockRestore();
    });

    test('Error Handling: localStorage throws (delete)', () => {
        const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => { });
        jest.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('Del Error'); });

        cache.delete('fail');
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to delete'), expect.any(Error));

        // deleteByPrefix error
        cache.deleteByPrefix('x');
        expect(consoleSpy).toHaveBeenCalled(); // keys() might succeed, removeItem fail in loop

        // clear error
        cache.clear();
        expect(consoleSpy).toHaveBeenCalled();

        consoleSpy.mockRestore();
    });

    test('Error Handling: JSON Parse error', () => {
        const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => { });
        // Mock getItem to return invalid JSON directly
        const getItemSpy = jest.spyOn(Storage.prototype, 'getItem').mockReturnValue('{ invalid json');

        const badKey = 'bad';
        // cache.get calls getItem. It should receive the invalid string.

        expect(cache.get(badKey)).toBeNull();

        // Should have thrown SyntaxError inside -> caught -> logged
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to read'), expect.any(Error));

        getItemSpy.mockRestore();
        consoleSpy.mockRestore();
    });
});
