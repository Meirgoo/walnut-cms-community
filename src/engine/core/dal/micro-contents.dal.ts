import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import {
    Node,
    mapContentEntityRow,
    findEntityForVcs,
    findLatestEntityVersion,
    updStmt,
    bindInsertVersion,
    insStmt
} from './content-common';

export const findMicroForVcs = (db: D1Database, microId: string, siteId?: string) =>
    findEntityForVcs(db, 'micros', microId, siteId);

export const findLatestMicroVersion = (db: D1Database, microId: string) =>
    findLatestEntityVersion(db, 'micro', microId);

export function buildUpdateMicroMetadataOnlyStatement(db: D1Database, params: any): D1PreparedStatement {
    return updStmt(
        db,
        'micros',
        'title = ?, slug = ?, locale = ?, progress = ?, status = ?, visibility = ?, metadata = ?, published_at = COALESCE(?, CASE WHEN ? = \'published\' AND published_at IS NULL THEN CURRENT_TIMESTAMP ELSE published_at END)',
        [params.title, params.slug, params.locale || 'zh-CN', params.progress || '', params.status || 'published', params.visibility || 'public', params.metadataStr, params.publishedAt ?? null, params.status || 'published'],
        params.microId,
        params.siteId
    );
}

export function buildInsertMicroVersionStatement(db: D1Database, params: any): D1PreparedStatement {
    return bindInsertVersion(db, 'micro', params);
}

export function buildUpdateMicroWithVersionStatement(db: D1Database, params: any): D1PreparedStatement {
    return updStmt(
        db,
        'micros',
        'title = ?, slug = ?, locale = ?, progress = ?, status = ?, visibility = ?, content_raw = ?, content_html = ?, metadata = ?, current_version_id = ?, published_at = COALESCE(?, CASE WHEN ? = \'published\' AND published_at IS NULL THEN CURRENT_TIMESTAMP ELSE published_at END)',
        [params.title, params.slug, params.locale || 'zh-CN', params.progress || '', params.status || 'published', params.visibility || 'public', params.contentRaw, params.contentHtml || '', params.metadataStr, params.versionId, params.publishedAt ?? null, params.status || 'published'],
        params.microId,
        params.siteId
    );
}

export function buildInsertMicroStatement(db: D1Database, params: any): D1PreparedStatement {
    return insStmt(
        db,
        'micros',
        'id, site_id, slug, locale, progress, status, visibility, title, content_raw, content_html, metadata, current_version_id, curator_id, published_at, created_at, updated_at',
        [params.id, params.siteId, params.slug, params.locale, params.progress, params.status, params.visibility || 'public', params.title, params.contentRaw, params.contentHtml || '', params.metadataStr, params.currentVersionId, params.curatorId, params.publishedAt, params.createdAt, params.updatedAt]
    );
}

export async function findMicrosAndTrashCount(
    db: D1Database,
    siteId: string
): Promise<{ nodes: Node[]; trashCount: number }> {
    const [nodesRes, trashRes] = await db.batch([
        db.prepare(`
            SELECT m.id, m.slug, 'micro' as type, m.title, m.locale, m.progress, m.status, m.metadata, m.updated_at, mv.content_raw as content_raw
            FROM micros m
            LEFT JOIN entity_versions mv ON mv.id = m.current_version_id AND mv.entity_type = 'micro' AND mv.deleted_at IS NULL
            WHERE m.site_id = ? AND m.deleted_at IS NULL
            ORDER BY m.updated_at DESC
        `).bind(siteId),
        db.prepare(`
            SELECT COUNT(DISTINCT m.id) as count
            FROM micros m
            LEFT JOIN entity_versions v ON v.entity_type = 'micro' AND v.entity_id = m.id
            WHERE m.site_id = ? AND (m.deleted_at IS NOT NULL OR v.deleted_at IS NOT NULL)
        `).bind(siteId)
    ]);

    return {
        nodes: (nodesRes.results || []).map(r => mapContentEntityRow(r, 'micro')),
        trashCount: Number((trashRes.results?.[0] as any)?.count || 0)
    };
}

export const getMicrosListData = (db: D1Database, siteId: string) =>
    findMicrosAndTrashCount(db, siteId);
