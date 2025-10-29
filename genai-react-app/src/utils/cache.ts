interface CacheEntry<T> {
    data: T
    timestamp: number
}

export interface CacheOptions {
    ttlMs?: number // Time to live in milliseconds
    prefix?: string // Cache key prefix
}

const DEFAULT_TTL = 30 * 24 * 60 * 60 * 1000 // 30 days
const DEFAULT_PREFIX = 'cache_'

export class CacheManager {
    private ttl: number
    private prefix: string

    constructor(options: CacheOptions = {}) {
        this.ttl = options.ttlMs ?? DEFAULT_TTL
        this.prefix = options.prefix ?? DEFAULT_PREFIX
    }

    private getCacheKey(key: string): string {
        return `${this.prefix}${key}`
    }

    private isExpired(timestamp: number): boolean {
        return Date.now() - timestamp > this.ttl
    }

    set<T>(key: string, data: T): void {
        try {
            const cacheKey = this.getCacheKey(key)
            const entry: CacheEntry<T> = {
                data,
                timestamp: Date.now(),
            }
            localStorage.setItem(cacheKey, JSON.stringify(entry))
        } catch (err) {
            console.error(`Failed to save to cache (${key}):`, err)
        }
    }

    get<T>(key: string): T | null {
        try {
            const cacheKey = this.getCacheKey(key)
            const cached = localStorage.getItem(cacheKey)

            if (!cached) return null

            const entry: CacheEntry<T> = JSON.parse(cached)

            if (this.isExpired(entry.timestamp)) {
                this.delete(key)
                return null
            }

            return entry.data
        } catch (err) {
            console.error(`Failed to read from cache (${key}):`, err)
            return null
        }
    }

    delete(key: string): void {
        try {
            const cacheKey = this.getCacheKey(key)
            localStorage.removeItem(cacheKey)
        } catch (err) {
            console.error(`Failed to delete cache (${key}):`, err)
        }
    }

    deleteByPrefix(keyPrefix: string): void {
        try {
            const keys = Object.keys(localStorage)
            const searchPrefix = this.getCacheKey(keyPrefix)
            keys.forEach(key => {
                if (key.startsWith(searchPrefix)) {
                    localStorage.removeItem(key)
                }
            })
        } catch (err) {
            console.error(`Failed to delete cache with prefix (${keyPrefix}):`, err)
        }
    }

    clear(): void {
        try {
            const keys = Object.keys(localStorage)
            keys.forEach(key => {
                if (key.startsWith(this.prefix)) {
                    localStorage.removeItem(key)
                }
            })
        } catch (err) {
            console.error('Failed to clear cache:', err)
        }
    }

    has(key: string): boolean {
        return this.get(key) !== null
    }

    getStats(): { count: number; size: number } {
        try {
            const keys = Object.keys(localStorage)
            const cachedKeys = keys.filter(key => key.startsWith(this.prefix))
            let size = 0

            cachedKeys.forEach(key => {
                const item = localStorage.getItem(key)
                if (item) size += item.length
            })

            return { count: cachedKeys.length, size }
        } catch (err) {
            console.error('Failed to get cache stats:', err)
            return { count: 0, size: 0 }
        }
    }
}