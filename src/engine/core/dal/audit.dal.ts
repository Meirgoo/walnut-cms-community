import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';

export interface AuditLogRowWithUser {
    id: string;
    site_id?: string;
    user_id?: string;
    username?: string;
    action: string;
    details?: string;
    ip_address?: string;
    status: string;
    created_at: string;
}

export interface InsertAuditLogParams {
    id: string;
    siteId?: string | null;
    userId: string;
    action: string;
    details?: string;
    ipAddress?: string;
    status: string;
}

export function buildInsertAuditLogStatement(
    db: D1Database,
    params: InsertAuditLogParams
): D1PreparedStatement {
    return db.prepare(`
        INSERT INTO audit_logs (id, site_id, user_id, action, details, ip_address, status)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(
        params.id,
        params.siteId || null,
        params.userId,
        params.action,
        params.details || null,
        params.ipAddress || '127.0.0.1',
        params.status
    );
}

export async function queryAuditLogsWithUsers(
    db: D1Database,
    siteId: string,
    limit = 100
): Promise<AuditLogRowWithUser[]> {
    const { results } = await db.prepare(`
        SELECT a.*, u.username
        FROM audit_logs a
        LEFT JOIN users u ON u.id = a.user_id
        WHERE a.site_id = ? OR a.site_id IS NULL
        ORDER BY a.created_at DESC
        LIMIT ?
    `).bind(siteId, limit).all<AuditLogRowWithUser>();
    return results || [];
}

export async function findWebhookDispatchLogs(
    db: D1Database,
    siteId: string,
    limit = 100
): Promise<Array<{
    id: string;
    site_id: string;
    action: string;
    details: string;
    ip_address: string;
    status: string;
    created_at: string;
}>> {
    const { results } = await db.prepare(`
        SELECT id, site_id, action, details, ip_address, status, created_at 
        FROM audit_logs 
        WHERE site_id = ? AND action = 'WEBHOOK_DISPATCH' 
        ORDER BY created_at DESC 
        LIMIT ?
    `).bind(siteId, limit).all<{
        id: string;
        site_id: string;
        action: string;
        details: string;
        ip_address: string;
        status: string;
        created_at: string;
    }>();
    return results || [];
}

export async function findRecentUserAuditLogs(
    db: D1Database,
    siteId: string,
    userId: string,
    limit = 5
): Promise<Array<{ id: string; action: string; status: string; ip_address?: string; created_at: string }>> {
    const { results } = await db.prepare(`
        SELECT id, action, status, ip_address, created_at
        FROM audit_logs
        WHERE (site_id = ? OR site_id IS NULL) AND user_id = ?
        ORDER BY created_at DESC
        LIMIT ?
    `).bind(siteId, userId, limit).all<{ id: string; action: string; status: string; ip_address?: string; created_at: string }>();
    return results || [];
}
