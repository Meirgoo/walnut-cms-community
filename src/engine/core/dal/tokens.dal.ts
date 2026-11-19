import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';

export type ApiTokenType = 'ecosystem' | 'ecosystem_epub' | 'commercial_pat';

export interface ApiTokenRow {
    id: string;
    site_id: string;
    name: string;
    token_hash: string;
    token_type: ApiTokenType | string;
    scopes: string;
    created_by?: string | null;
    expires_at?: string | null;
    last_used_at?: string | null;
    created_at: string;
}

export async function computeTokenSha256(rawToken: string): Promise<string> {
    const buf = new TextEncoder().encode(rawToken.trim());
    const hashBuf = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(hashBuf))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
}

export async function findApiTokenByHash(
    db: D1Database,
    tokenHash: string,
    siteId?: string
): Promise<ApiTokenRow | null> {
    if (siteId) {
        return (
            (await db
                .prepare(`SELECT * FROM api_tokens WHERE token_hash = ? AND (site_id = ? OR site_id = 'site_default') LIMIT 1`)
                .bind(tokenHash, siteId)
                .first<ApiTokenRow>()) || null
        );
    }
    return (
        (await db
            .prepare(`SELECT * FROM api_tokens WHERE token_hash = ? LIMIT 1`)
            .bind(tokenHash)
            .first<ApiTokenRow>()) || null
    );
}

export async function listApiTokensBySite(
    db: D1Database,
    siteId: string,
    tokenType?: ApiTokenType
): Promise<Omit<ApiTokenRow, 'token_hash'>[]> {
    const sql = tokenType
        ? `SELECT id, site_id, name, token_type, scopes, created_by, expires_at, last_used_at, created_at FROM api_tokens WHERE site_id = ? AND token_type = ? ORDER BY created_at DESC`
        : `SELECT id, site_id, name, token_type, scopes, created_by, expires_at, last_used_at, created_at FROM api_tokens WHERE site_id = ? ORDER BY created_at DESC`;
    const res = tokenType
        ? await db.prepare(sql).bind(siteId, tokenType).all<Omit<ApiTokenRow, 'token_hash'>>()
        : await db.prepare(sql).bind(siteId).all<Omit<ApiTokenRow, 'token_hash'>>();
    return res.results || [];
}

// Only one active ecosystem pairing token is permitted per site; rotating revokes prior tokens.
export function buildRotateEcosystemTokenStatements(
    db: D1Database,
    params: { id: string; siteId: string; name: string; tokenHash: string; createdBy: string }
): D1PreparedStatement[] {
    return [
        db.prepare(`DELETE FROM api_tokens WHERE site_id = ? AND token_type IN ('ecosystem', 'ecosystem_epub')`)
            .bind(params.siteId),
        db.prepare(
            `INSERT INTO api_tokens (id, site_id, name, token_hash, token_type, scopes, created_by, created_at)
             VALUES (?, ?, ?, ?, 'ecosystem', '["ecosystem:sync"]', ?, CURRENT_TIMESTAMP)`
        ).bind(params.id, params.siteId, params.name, params.tokenHash, params.createdBy)
    ];
}

export async function findRecentEcosystemContentBySourceId(
    db: D1Database,
    siteId: string,
    mode: 'micro' | 'article',
    sourceId: string
): Promise<{ id: string; slug: string } | null> {
    const table = mode === 'article' ? 'articles' : 'micros';
    const row = await db
        .prepare(
            `SELECT id, slug FROM ${table}
             WHERE site_id = ? AND deleted_at IS NULL
               AND json_extract(metadata, '$.eco_source_id') = ?
               AND created_at >= datetime('now', '-24 hours')
             ORDER BY created_at DESC LIMIT 1`
        )
        .bind(siteId, sourceId)
        .first<{ id: string; slug: string }>();
    return row || null;
}

export async function touchApiTokenLastUsed(db: D1Database, tokenId: string): Promise<void> {
    await db.prepare(`UPDATE api_tokens SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(tokenId).run();
}
