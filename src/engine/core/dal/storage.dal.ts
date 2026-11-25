import type { D1Database, R2Bucket } from '@cloudflare/workers-types';
import { getSystemMetaValue } from './sites.dal';
import { parseJson } from '../utils';

let lastObservedD1SizeBytes: number | null = null;

export function captureD1MetaSizeAfter(meta: unknown): number | null {
    const sizeAfter = (meta as any)?.size_after;
    if (typeof sizeAfter === 'number' && Number.isFinite(sizeAfter) && sizeAfter >= 0) {
        lastObservedD1SizeBytes = sizeAfter;
        return sizeAfter;
    }
    return null;
}

export function getLastObservedD1SizeBytes(): number | null {
    return lastObservedD1SizeBytes;
}

async function upsertSystemMeta(db: D1Database, key: string, value: string): Promise<void> {
    await db.prepare(
        `INSERT INTO system_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).bind(key, value).run();
}

/**
 * Probe current D1 database byte size using Cloudflare D1's `meta.size_after` field.
 */
export async function probeD1SizeBytes(db: D1Database): Promise<number> {
    let measured = 0;
    try {
        const res = await db.prepare(`SELECT COUNT(*) as cnt FROM system_meta`).run();
        const sizeAfter = captureD1MetaSizeAfter(res?.meta);
        if (sizeAfter !== null && sizeAfter > 0) {
            measured = sizeAfter;
        }
    } catch {}

    if (measured === 0) {
        try {
            const pageCountRow = await db.prepare(`PRAGMA page_count`).first<{ page_count: number }>();
            const pageSizeRow = await db.prepare(`PRAGMA page_size`).first<{ page_size: number }>();
            const pc = Number(pageCountRow?.page_count || 0);
            const ps = Number(pageSizeRow?.page_size || 0);
            if (pc > 0 && ps > 0) {
                measured = pc * ps;
                lastObservedD1SizeBytes = measured;
            }
        } catch {}
    }

    if (measured > 0) {
        try {
            await upsertSystemMeta(db, 'd1_size_bytes', String(measured));
        } catch {}
    }
    return measured;
}

export async function getMediaStorageSumBytes(db: D1Database): Promise<{ totalBytes: number; count: number }> {
    const row = await db.prepare(
        `SELECT COALESCE(SUM(file_size), 0) as total_bytes, COUNT(*) as total_count FROM media_assets WHERE deleted_at IS NULL`
    ).first<{ total_bytes: number; total_count: number }>();
    return {
        totalBytes: Number(row?.total_bytes || 0),
        count: Number(row?.total_count || 0)
    };
}

export async function recordR2BackupSize(
    db: D1Database,
    backupKey: string,
    sizeBytes: number
): Promise<void> {
    if (!backupKey || !Number.isFinite(sizeBytes) || sizeBytes < 0) return;
    try {
        const raw = await getSystemMetaValue(db, 'r2_backup_usage');
        const current = parseJson<{ files?: Record<string, number>; totalBytes?: number }>(raw, {});
        const files: Record<string, number> = (current.files && typeof current.files === 'object') ? { ...current.files } : {};
        files[backupKey] = Math.round(sizeBytes);
        const totalBytes = Object.values(files).reduce((acc, v) => acc + (Number(v) || 0), 0);
        await upsertSystemMeta(db, 'r2_backup_usage', JSON.stringify({
            files,
            totalBytes,
            updatedAt: new Date().toISOString()
        }));
    } catch {}
}

async function listBucketBytes(bucket?: R2Bucket): Promise<{ totalBytes: number; objectCount: number } | null> {
    if (!bucket || typeof bucket.list !== 'function') return null;
    let totalBytes = 0;
    let objectCount = 0;
    let cursor: string | undefined;
    for (let page = 0; page < 50; page++) {
        const res = await bucket.list({ cursor, limit: 1000 });
        for (const obj of res.objects || []) {
            totalBytes += Number(obj.size || 0);
            objectCount++;
        }
        if (!res.truncated || !res.cursor) break;
        cursor = res.cursor;
    }
    return { totalBytes, objectCount };
}

export interface StorageUsageSummary {
    d1SizeBytes: number;
    r2MediaBytes: number;
    r2MediaCount: number;
    r2PrimaryBytes: number;
    r2BackupBytes: number;
    r2TotalBytes: number;
    calibratedAt: string | null;
}

export async function calibrateStorageUsage(
    db: D1Database,
    primaryBucket?: R2Bucket,
    backupBucket?: R2Bucket
): Promise<StorageUsageSummary> {
    const [d1SizeBytes, mediaSum, primaryStats, backupStats] = await Promise.all([
        probeD1SizeBytes(db),
        getMediaStorageSumBytes(db),
        listBucketBytes(primaryBucket),
        listBucketBytes(backupBucket)
    ]);

    let r2BackupBytes = 0;
    if (backupStats) {
        r2BackupBytes = backupStats.totalBytes;
        try {
            await upsertSystemMeta(db, 'r2_backup_usage', JSON.stringify({
                files: {},
                totalBytes: r2BackupBytes,
                objectCount: backupStats.objectCount,
                updatedAt: new Date().toISOString()
            }));
        } catch {}
    } else {
        const rawBackup = await getSystemMetaValue(db, 'r2_backup_usage');
        const parsedBackup = parseJson<{ totalBytes?: number }>(rawBackup, {});
        r2BackupBytes = Number(parsedBackup.totalBytes || 0);
    }

    const r2PrimaryBytes = primaryStats ? primaryStats.totalBytes : mediaSum.totalBytes;
    const calibratedAt = new Date().toISOString();
    const summary: StorageUsageSummary = {
        d1SizeBytes,
        r2MediaBytes: mediaSum.totalBytes,
        r2MediaCount: mediaSum.count,
        r2PrimaryBytes,
        r2BackupBytes,
        r2TotalBytes: r2PrimaryBytes + r2BackupBytes,
        calibratedAt
    };

    try {
        await upsertSystemMeta(db, 'storage_usage_snapshot', JSON.stringify(summary));
    } catch {}

    return summary;
}

export async function getStorageUsageSummary(db: D1Database): Promise<StorageUsageSummary> {
    const [mediaSum, d1Raw, backupRaw, snapshotRaw] = await Promise.all([
        getMediaStorageSumBytes(db),
        getSystemMetaValue(db, 'd1_size_bytes'),
        getSystemMetaValue(db, 'r2_backup_usage'),
        getSystemMetaValue(db, 'storage_usage_snapshot')
    ]);

    const snapshot = parseJson<Partial<StorageUsageSummary>>(snapshotRaw, {});
    const backupMeta = parseJson<{ totalBytes?: number }>(backupRaw, {});
    const d1SizeBytes = lastObservedD1SizeBytes ?? Number(d1Raw || snapshot.d1SizeBytes || 0);
    const r2BackupBytes = Number(backupMeta.totalBytes ?? snapshot.r2BackupBytes ?? 0);
    const r2PrimaryBytes = Math.max(mediaSum.totalBytes, Number(snapshot.r2PrimaryBytes || 0));

    return {
        d1SizeBytes,
        r2MediaBytes: mediaSum.totalBytes,
        r2MediaCount: mediaSum.count,
        r2PrimaryBytes,
        r2BackupBytes,
        r2TotalBytes: r2PrimaryBytes + r2BackupBytes,
        calibratedAt: snapshot.calibratedAt || null
    };
}
