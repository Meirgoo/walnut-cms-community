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

export const findMicroForVcs = (db: D1Database, microId: string) =>
    findEntityForVcs(db, 'micros', microId);

export const findLatestMicroVersion = (db: D1Database, microId: string) =>
    findLatestEntityVersion(db, 'micro_versions', 'micro_id', microId);

export function buildUpdateMicroMetadataOnlyStatement(db: D1Database, params: any): D1PreparedStatement {
    return updStmt(
        db,
        'micros',
        'title = ?, slug = ?, locale = ?, progress = ?, status = ?, visibility = ?, metadata = ?',
        [params.title, params.slug, params.locale || 'zh-CN', params.progress || '', params.status || 'published', params.visibility || 'public', params.metadataStr],
        params.microId
    );
}

export function buildInsertMicroVersionStatement(db: D1Database, params: any): D1PreparedStatement {
    return bindInsertVersion(db, 'micro_versions', 'micro_id', params);
}

export function buildUpdateMicroWithVersionStatement(db: D1Database, params: any): D1PreparedStatement {
    return updStmt(
        db,
        'micros',
        'title = ?, slug = ?, locale = ?, progress = ?, status = ?, visibility = ?, content_raw = ?, metadata = ?, current_version_id = ?',
        [params.title, params.slug, params.locale || 'zh-CN', params.progress || '', params.status || 'published', params.visibility || 'public', params.contentRaw, params.metadataStr, params.versionId],
        params.microId
    );
}

export function buildInsertMicroStatement(db: D1Database, params: any): D1PreparedStatement {
    return insStmt(
        db,
        'micros',
        'id, site_id, slug, locale, progress, status, visibility, title, content_raw, metadata, current_version_id, curator_id, published_at, created_at, updated_at',
        [params.id, params.siteId, params.slug, params.locale, params.progress, params.status, params.visibility || 'public', params.title, params.contentRaw, params.metadataStr, params.currentVersionId, params.curatorId, params.publishedAt, params.createdAt, params.updatedAt]
    );
}

export async function findMicrosAndTrashCount(
    db: D1Database,
    siteId: string
): Promise<{ nodes: Node[]; trashCount: number }> {
    const [nodesRes, trashRes] = await db.batch([
        db.prepare(`
            SELECT id, slug, 'micro' as type, title, locale, progress, status, metadata, updated_at
            FROM micros
            WHERE site_id = ? AND deleted_at IS NULL
            ORDER BY updated_at DESC
        `).bind(siteId),
        db.prepare(`
            SELECT COUNT(DISTINCT m.id) as count
            FROM micros m
            LEFT JOIN micro_versions v ON v.micro_id = m.id
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
