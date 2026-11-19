import type { D1Database } from '@cloudflare/workers-types';

export * from './content.dal';
export * from './auth.dal';
export * from './media.dal';
export * from './sites.dal';
export * from './themes.dal';
export * from './datasets.dal';
export * from './cache-index.dal';
export * from './tasks.dal';
export * from './audit.dal';
export * from './tokens.dal';

// Bounded in-memory rate limiter to prevent spoofed IPs from exhausting Worker memory (OOM).
const MAX_RATE_LIMIT_ENTRIES = 2000;
const rateLimitStore = new Map<string, { count: number; resetAt: number }>();

export function checkQueryRateLimit(clientIdentifier: string, maxPerMinute = 60): boolean {
    const now = Date.now();
    const windowMs = 60 * 1000;
    const record = rateLimitStore.get(clientIdentifier);

    if (!record || now > record.resetAt) {
        if (!record && rateLimitStore.size >= MAX_RATE_LIMIT_ENTRIES) {
            for (const [k, v] of rateLimitStore.entries()) {
                if (now > v.resetAt) rateLimitStore.delete(k);
            }
            if (rateLimitStore.size >= MAX_RATE_LIMIT_ENTRIES) {
                const oldestKey = rateLimitStore.keys().next().value;
                if (oldestKey !== undefined) rateLimitStore.delete(oldestKey);
            }
        }
        rateLimitStore.set(clientIdentifier, { count: 1, resetAt: now + windowMs });
        return true;
    }

    if (record.count >= maxPerMinute) {
        return false;
    }

    record.count++;
    return true;
}

// Bounded in-memory query cache to protect against cache-busting OOM attacks.
export const MAX_QUERY_CACHE_ENTRIES = 500;
const queryCacheStore = new Map<string, { data: any; expiresAt: number }>();

export function getCachedQueryResult<T = any>(cacheKey: string): T | null {
    const entry = queryCacheStore.get(cacheKey);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
        queryCacheStore.delete(cacheKey);
        return null;
    }
    return entry.data as T;
}

export function setCachedQueryResult(cacheKey: string, data: any, ttlSeconds = 60): void {
    const now = Date.now();
    if (queryCacheStore.has(cacheKey)) {
        queryCacheStore.delete(cacheKey);
    } else if (queryCacheStore.size >= MAX_QUERY_CACHE_ENTRIES) {
        for (const [k, v] of queryCacheStore.entries()) {
            if (now > v.expiresAt) queryCacheStore.delete(k);
        }
        if (queryCacheStore.size >= MAX_QUERY_CACHE_ENTRIES) {
            const oldestKey = queryCacheStore.keys().next().value;
            if (oldestKey !== undefined) queryCacheStore.delete(oldestKey);
        }
    }
    queryCacheStore.set(cacheKey, {
        data,
        expiresAt: now + ttlSeconds * 1000
    });
}

export function invalidateQueryCache(siteId?: string): void {
    if (!siteId) {
        queryCacheStore.clear();
        return;
    }
    const prefixContent = `content:${siteId}:`;
    const prefixDataset = `datasets:${siteId}:`;
    for (const key of queryCacheStore.keys()) {
        if (key.startsWith(prefixContent) || key.startsWith(prefixDataset)) {
            queryCacheStore.delete(key);
        }
    }
}

export function getQueryCacheSize(): number {
    return queryCacheStore.size;
}

export async function isSystemInstalled(db: D1Database): Promise<boolean> {
    try {
        const meta = await db.prepare(`SELECT value FROM system_meta WHERE key = ?`).bind('installed').first<{ value: string }>();
        return !!(meta && meta.value === 'true');
    } catch {
        return false;
    }
}
