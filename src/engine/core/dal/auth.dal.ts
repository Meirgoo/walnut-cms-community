import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import type { User, SiteMember, SiteRole } from '../../types';

export function buildCreateUserStatement(
    db: D1Database,
    user: { id: string; username: string; email: string; passwordHash: string; globalRole: string }
): D1PreparedStatement {
    return db.prepare(`
        INSERT INTO users (id, username, email, password_hash, global_role)
        VALUES (?, ?, ?, ?, ?)
    `).bind(user.id, user.username, user.email, user.passwordHash, user.globalRole);
}

export function buildAddSiteMemberStatement(
    db: D1Database,
    member: { id: string; siteId: string; userId: string; role: SiteRole }
): D1PreparedStatement {
    return db.prepare(`
        INSERT INTO site_members (id, site_id, user_id, role)
        VALUES (?, ?, ?, ?)
    `).bind(member.id, member.siteId, member.userId, member.role);
}

export function buildUpdateUserStatement(
    db: D1Database,
    userId: string,
    username: string,
    email: string,
    globalRole: string,
    passwordHash?: string | null,
    updatedAtIso?: string
): D1PreparedStatement {
    const nowIso = updatedAtIso || new Date().toISOString();
    if (passwordHash) {
        return db.prepare(`
            UPDATE users
            SET username = ?, email = ?, global_role = ?, password_hash = ?, updated_at = ?
            WHERE id = ?
        `).bind(username, email, globalRole, passwordHash, nowIso, userId);
    }
    return db.prepare(`
        UPDATE users
        SET username = ?, email = ?, global_role = ?, updated_at = ?
        WHERE id = ?
    `).bind(username, email, globalRole, nowIso, userId);
}

export function buildUpsertSiteMemberRoleStatement(
    db: D1Database,
    memberId: string,
    siteId: string,
    userId: string,
    role: SiteRole
): D1PreparedStatement {
    return db.prepare(`
        INSERT INTO site_members (id, site_id, user_id, role)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(site_id, user_id) DO UPDATE SET role = excluded.role
    `).bind(memberId, siteId, userId, role);
}

export function buildUpdateUserPasswordStatement(
    db: D1Database,
    userId: string,
    passwordHash: string
): D1PreparedStatement {
    return db.prepare(`
        UPDATE users 
        SET password_hash = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
    `).bind(passwordHash, userId);
}

export async function findUserMetadataById(db: D1Database, userId: string): Promise<Record<string, any>> {
    try {
        const row = await db.prepare('SELECT value FROM system_meta WHERE key = ? LIMIT 1').bind(`user_pref:${userId}`).first<{ value?: string | null }>();
        if (!row?.value) return {};
        return JSON.parse(row.value) || {};
    } catch {
        return {};
    }
}

export function buildUpdateUserMetadataStatement(
    db: D1Database,
    userId: string,
    metadataJson: string
): D1PreparedStatement {
    return db.prepare(`
        INSERT INTO system_meta (key, value, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
    `).bind(`user_pref:${userId}`, metadataJson);
}

export function buildUpdateSiteMemberRoleStatement(
    db: D1Database,
    siteId: string,
    userId: string,
    role: SiteRole
): D1PreparedStatement {
    return db.prepare(`
        UPDATE site_members 
        SET role = ?
        WHERE site_id = ? AND user_id = ?
    `).bind(role, siteId, userId);
}

export function buildDeleteSiteMemberStatement(
    db: D1Database,
    userId: string
): D1PreparedStatement {
    return db.prepare(`DELETE FROM site_members WHERE user_id = ?`).bind(userId);
}

export function buildDeleteUserStatement(
    db: D1Database,
    userId: string
): D1PreparedStatement {
    return db.prepare(`DELETE FROM users WHERE id = ? AND global_role != 'superadmin'`).bind(userId);
}

export async function findUserByEmail(db: D1Database, email: string): Promise<User | null> {
    return await db.prepare(
        `SELECT id, email, username, global_role, avatar_url FROM users WHERE email = ? LIMIT 1`
    ).bind(email).first<User>();
}

export async function findUserById(db: D1Database, id: string): Promise<User | null> {
    return await db.prepare(
        `SELECT id, email, username, global_role, avatar_url FROM users WHERE id = ? LIMIT 1`
    ).bind(id).first<User>();
}

export async function findUserForAuth(db: D1Database, identifier: string): Promise<User | null> {
    return await db.prepare(
        `SELECT id, email, username, password_hash, global_role FROM users WHERE (email = ? OR username = ?) LIMIT 1`
    ).bind(identifier, identifier).first<User>();
}

export interface SessionUserRow extends User {
    site_role?: SiteRole | null;
    user_pref_json?: string | null;
}

export async function findSessionUserWithRole(
    db: D1Database,
    by: { id?: string; email?: string; identifier?: string },
    siteId?: string | null
): Promise<SessionUserRow | null> {
    let where = '';
    const params: unknown[] = [siteId || ''];
    if (by.id) {
        where = 'u.id = ?';
        params.push(by.id);
    } else if (by.email) {
        where = 'u.email = ?';
        params.push(by.email);
    } else if (by.identifier) {
        where = '(u.email = ? OR u.username = ?)';
        params.push(by.identifier, by.identifier);
    } else {
        return null;
    }
    return await db.prepare(
        `SELECT u.id, u.email, u.username, u.global_role, u.avatar_url, sm.role AS site_role, smeta.value AS user_pref_json
         FROM users u
         LEFT JOIN site_members sm ON sm.user_id = u.id AND sm.site_id = ?
         LEFT JOIN system_meta smeta ON smeta.key = ('user_pref:' || u.id)
         WHERE ${where}
         LIMIT 1`
    ).bind(...params).first<SessionUserRow>();
}

export async function findSiteMemberRole(
    db: D1Database,
    siteId: string,
    userId: string
): Promise<SiteRole | null> {
    const member = await db.prepare(
        `SELECT role FROM site_members WHERE site_id = ? AND user_id = ? LIMIT 1`
    ).bind(siteId, userId).first<SiteMember>();
    return member?.role || null;
}

export async function querySiteUsers(
    db: D1Database,
    siteId: string
): Promise<Array<User & { site_role: SiteRole }>> {
    const { results } = await db.prepare(`
        SELECT u.id, u.username, u.email, u.global_role, u.created_at, sm.role as site_role
        FROM users u
        INNER JOIN site_members sm ON sm.user_id = u.id AND sm.site_id = ?
        ORDER BY u.created_at DESC
    `).bind(siteId).all<User & { site_role: SiteRole }>();
    return results || [];
}

export async function getUserPasswordHash(
    db: D1Database,
    userId: string
): Promise<string | null> {
    const row = await db.prepare(
        `SELECT password_hash FROM users WHERE id = ? LIMIT 1`
    ).bind(userId).first<{ password_hash: string }>();
    return row?.password_hash || null;
}
