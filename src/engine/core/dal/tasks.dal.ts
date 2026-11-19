import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import type { ScheduledTask, TaskType } from '../../types';
import { purgeEdgeAndZoneCache } from './cache-index.dal';

export async function findTasksBySite(
    db: D1Database,
    siteId: string
): Promise<ScheduledTask[]> {
    const { results } = await db.prepare(`
        SELECT * FROM scheduled_tasks 
        WHERE site_id = ? OR site_id IS NULL
        ORDER BY created_at DESC
    `).bind(siteId).all<ScheduledTask>();
    return results || [];
}

export interface DueTaskItem {
    id: string;
    site_id?: string;
    task_type: string;
    schedule_type?: string;
    interval_preset?: string;
    payload?: string;
    cron_interval_minutes: number;
}

export async function findTaskById(
    db: D1Database,
    taskId: string
): Promise<DueTaskItem | null> {
    const row = await db.prepare(`
        SELECT id, site_id, task_type, schedule_type, interval_preset, payload, cron_interval_minutes
        FROM scheduled_tasks
        WHERE id = ?
    `).bind(taskId).first<DueTaskItem>();
    return row || null;
}

export async function findDueTasks(
    db: D1Database,
    nowIso: string,
    limit = 10
): Promise<DueTaskItem[]> {
    const { results } = await db.prepare(`
        SELECT id, site_id, task_type, schedule_type, interval_preset, payload, cron_interval_minutes 
        FROM scheduled_tasks 
        WHERE status = 'pending' AND next_run_at <= ?
        LIMIT ?
    `).bind(nowIso, limit).all<DueTaskItem>();
    return results || [];
}

export function buildUpdateTaskRunningStatement(
    db: D1Database,
    taskId: string
): D1PreparedStatement {
    return db.prepare(`
        UPDATE scheduled_tasks 
        SET status = 'running', last_run_at = CURRENT_TIMESTAMP 
        WHERE id = ?
    `).bind(taskId);
}

export function buildUpdateTaskCompletedStatement(
    db: D1Database,
    taskId: string,
    lastResult?: string
): D1PreparedStatement {
    return db.prepare(`
        UPDATE scheduled_tasks 
        SET status = 'completed', last_run_at = CURRENT_TIMESTAMP, last_result = ?
        WHERE id = ?
    `).bind(lastResult || null, taskId);
}

export function buildRescheduleTaskStatement(
    db: D1Database,
    taskId: string,
    nextRunAtIso: string,
    lastResult?: string
): D1PreparedStatement {
    return db.prepare(`
        UPDATE scheduled_tasks 
        SET status = 'pending', next_run_at = ?, last_run_at = CURRENT_TIMESTAMP, last_result = ?
        WHERE id = ?
    `).bind(nextRunAtIso, lastResult || null, taskId);
}

export function buildTriggerTaskNowStatement(
    db: D1Database,
    taskId: string
): D1PreparedStatement {
    return db.prepare(`
        UPDATE scheduled_tasks 
        SET next_run_at = CURRENT_TIMESTAMP, status = 'pending' 
        WHERE id = ?
    `).bind(taskId);
}

export function buildDeleteTaskStatement(
    db: D1Database,
    taskId: string
): D1PreparedStatement {
    return db.prepare(`
        DELETE FROM scheduled_tasks 
        WHERE id = ?
    `).bind(taskId);
}

export interface SaveTaskDalParams {
    id: string;
    siteId?: string;
    taskType: TaskType | string;
    scheduleType?: 'once' | 'recurring';
    intervalPreset?: string;
    payloadJson: string;
    cronIntervalMinutes: number;
    nextRunAt: string;
}

export function buildInsertTaskStatement(
    db: D1Database,
    params: SaveTaskDalParams
): D1PreparedStatement {
    return db.prepare(`
        INSERT INTO scheduled_tasks (id, site_id, task_type, schedule_type, interval_preset, payload, cron_interval_minutes, next_run_at, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')
    `).bind(
        params.id,
        params.siteId || null,
        params.taskType,
        params.scheduleType || 'recurring',
        params.intervalPreset || 'custom',
        params.payloadJson,
        params.cronIntervalMinutes,
        params.nextRunAt
    );
}

export function buildUpdateTaskStatement(
    db: D1Database,
    params: SaveTaskDalParams
): D1PreparedStatement {
    return db.prepare(`
        UPDATE scheduled_tasks 
        SET site_id = ?, task_type = ?, schedule_type = ?, interval_preset = ?, payload = ?, cron_interval_minutes = ?, next_run_at = ?, status = 'pending'
        WHERE id = ?
    `).bind(
        params.siteId || null,
        params.taskType,
        params.scheduleType || 'recurring',
        params.intervalPreset || 'custom',
        params.payloadJson,
        params.cronIntervalMinutes,
        params.nextRunAt,
        params.id
    );
}

export function buildPublishNodesByIdStatements(
    db: D1Database,
    nodeId: string
): D1PreparedStatement[] {
    return [
        db.prepare(`
            UPDATE articles 
            SET status = 'published', published_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP 
            WHERE id = ?
        `).bind(nodeId),
        db.prepare(`
            UPDATE pages 
            SET status = 'published', published_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP 
            WHERE id = ?
        `).bind(nodeId)
    ];
}

export async function executePublishDueArticles(
    db: D1Database,
    siteId: string
): Promise<number> {
    const updateRes = await db.prepare(`
        UPDATE articles 
        SET status = 'published', updated_at = CURRENT_TIMESTAMP 
        WHERE site_id = ? AND status = 'draft' AND published_at IS NOT NULL AND published_at <= CURRENT_TIMESTAMP
    `).bind(siteId).run();
    return updateRes.meta.changes || 0;
}

export function buildUnpublishNodesByIdStatements(
    db: D1Database,
    nodeId: string
): D1PreparedStatement[] {
    return [
        db.prepare(`
            UPDATE articles
            SET status = 'draft', updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `).bind(nodeId),
        db.prepare(`
            UPDATE pages
            SET status = 'draft', updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `).bind(nodeId),
        db.prepare(`DELETE FROM site_routes WHERE entity_id = ?`).bind(nodeId)
    ];
}

export async function executeUnpublishDueContent(
    db: D1Database,
    siteId: string,
    nowIso: string = new Date().toISOString()
): Promise<number> {
    const batchRes = await db.batch([
        db.prepare(`
            SELECT id, slug FROM articles
            WHERE site_id = ? AND status = 'published' AND deleted_at IS NULL
              AND json_extract(metadata, '$.unpublish_at') IS NOT NULL
              AND json_extract(metadata, '$.unpublish_at') <= ?
        `).bind(siteId, nowIso),
        db.prepare(`
            SELECT id, slug FROM pages
            WHERE site_id = ? AND status = 'published' AND deleted_at IS NULL
              AND json_extract(metadata, '$.unpublish_at') IS NOT NULL
              AND json_extract(metadata, '$.unpublish_at') <= ?
        `).bind(siteId, nowIso)
    ]);

    const dueArts = (batchRes[0]?.results || []) as Array<{ id: string; slug: string }>;
    const duePages = (batchRes[1]?.results || []) as Array<{ id: string; slug: string }>;
    const rows = [...dueArts, ...duePages];
    if (rows.length === 0) return 0;

    const stmts = [
        ...rows.flatMap(r => buildUnpublishNodesByIdStatements(db, r.id)),
        db.prepare(`
            UPDATE site_routes SET is_dirty = 1, rendered_html = NULL, version = version + 1, updated_at = ?
            WHERE site_id = ? AND path IN ('/', '/sitemap.xml', '/feed.xml', '/feed.json')
        `).bind(nowIso, siteId)
    ];
    await db.batch(stmts);
    const affectedPaths = [
        ...rows.map(r => (r.slug === '/' ? '/' : `/${String(r.slug || '').replace(/^\/+/, '')}`)),
        '/', '/sitemap.xml', '/feed.xml', '/feed.json'
    ];
    await purgeEdgeAndZoneCache(db, siteId, affectedPaths);
    return rows.length;
}

export function buildCleanupSoftDeletedEntitiesStatements(
    db: D1Database,
    cutoffIso: string
): D1PreparedStatement[] {
    return [
        db.prepare(`DELETE FROM articles WHERE deleted_at IS NOT NULL AND deleted_at <= ?`).bind(cutoffIso),
        db.prepare(`DELETE FROM micros WHERE deleted_at IS NOT NULL AND deleted_at <= ?`).bind(cutoffIso),
        db.prepare(`DELETE FROM pages WHERE deleted_at IS NOT NULL AND deleted_at <= ?`).bind(cutoffIso),
        db.prepare(`DELETE FROM article_versions WHERE deleted_at IS NOT NULL AND deleted_at <= ?`).bind(cutoffIso),
        db.prepare(`DELETE FROM micro_versions WHERE deleted_at IS NOT NULL AND deleted_at <= ?`).bind(cutoffIso),
        db.prepare(`DELETE FROM page_versions WHERE deleted_at IS NOT NULL AND deleted_at <= ?`).bind(cutoffIso)
    ];
}

// Mark tasks stuck in 'running' past the cutoff as failed (typically due to Worker CPU timeouts).
export async function recoverZombieRunningTasks(
    db: D1Database,
    zombieCutoffIso: string,
    reason = 'Execution timeout (suspected edge CPU limit)'
): Promise<number> {
    try {
        const res = await db.prepare(`
            UPDATE scheduled_tasks
            SET status = 'failed', last_result = ?
            WHERE status = 'running' AND COALESCE(last_run_at, created_at) <= ?
        `).bind(reason, zombieCutoffIso).run();
        return res.meta?.changes || 0;
    } catch {
        return 0;
    }
}

// Lightweight probe to skip loading heavy task modules when no work is due.
export async function hasDueOrScheduledWork(
    db: D1Database,
    nowIso: string
): Promise<boolean> {
    try {
        const [dueTask, dueArt] = await db.batch([
            db.prepare(`SELECT 1 FROM scheduled_tasks WHERE status IN ('pending', 'active', 'scheduled') AND (next_run_at IS NULL OR next_run_at <= ?) LIMIT 1`).bind(nowIso),
            db.prepare(`SELECT 1 FROM articles WHERE status = 'scheduled' AND published_at <= ? LIMIT 1`).bind(nowIso)
        ]);
        return Boolean((dueTask.results && dueTask.results.length > 0) || (dueArt.results && dueArt.results.length > 0));
    } catch {
        return false;
    }
}

export async function countFailedTasks(
    db: D1Database,
    siteId: string
): Promise<number> {
    try {
        const row = await db.prepare(
            `SELECT COUNT(*) as total FROM scheduled_tasks WHERE (site_id = ? OR site_id IS NULL) AND status = 'failed'`
        ).bind(siteId).first<{ total: number }>();
        return Number(row?.total || 0);
    } catch {
        return 0;
    }
}

// Batch user, role, and failed-task queries into a single D1 round-trip.
export async function findQuickActionStateBatch(
    db: D1Database,
    userId: string,
    siteId: string
): Promise<{ user: any | null; siteRole: string | null; failedTasksCount: number }> {
    try {
        const [uRes, mRes, fRes] = await db.batch([
            db.prepare(`SELECT id, username, email, global_role FROM users WHERE id = ? LIMIT 1`).bind(userId),
            db.prepare(`SELECT role FROM site_members WHERE site_id = ? AND user_id = ? LIMIT 1`).bind(siteId, userId),
            db.prepare(`SELECT COUNT(*) as total FROM scheduled_tasks WHERE (site_id = ? OR site_id IS NULL) AND status = 'failed'`).bind(siteId)
        ]);
        const user = (uRes.results?.[0] as any) || null;
        const siteRole = (mRes.results?.[0] as any)?.role || null;
        const failedTasksCount = Number((fRes.results?.[0] as any)?.total || 0);
        return { user, siteRole, failedTasksCount };
    } catch {
        return { user: null, siteRole: null, failedTasksCount: 0 };
    }
}
