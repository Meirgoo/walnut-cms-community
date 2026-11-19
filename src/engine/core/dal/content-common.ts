import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import type { ArticleVersion } from '../../types';

export interface ContentEntity {
    id: string;
    site_id: string;
    slug: string;
    type: string;
    locale: string;
    status: string;
    title: string;
    summary?: string | null;
    content_raw?: string;
    metadata?: any;
    current_version_id?: string | null;
    version_number?: number;
    updated_at: string;
    created_at?: string;
    published_at?: string | null;
    deleted_at?: string | null;
    progress?: string;
    maturity?: string;
    [key: string]: any;
}

export type Node = ContentEntity;
export type NodeVersion = ArticleVersion | any;
export type GardenMaturity = 'none' | 'seedling' | 'budding' | 'evergreen';

import { parseJson } from '../utils';
export { parseJson };

export function mapContentEntityRow(row: any, defaultType = 'article'): ContentEntity {
    if (!row) return row;
    const rawProg = row.progress !== undefined ? row.progress : row.maturity;
    const progress = (rawProg && rawProg !== 'none') ? String(rawProg).trim() : '';
    const metadata = parseJson<Record<string, any>>(row.metadata, {});
    return {
        ...row,
        type: row.type || defaultType,
        progress,
        maturity: progress,
        folder: row.folder || metadata.folder || '',
        metadata
    };
}

export function normalizePagination(params: { page?: number | string; limit?: number | string }): {
    page: number;
    limit: number;
    offset: number;
} {
    const page = Math.max(1, Number(params.page) || 1);
    const limit = Math.max(1, Math.min(100, Number(params.limit) || 20));
    const offset = (page - 1) * limit;
    return { page, limit, offset };
}

export const toVirtualNode = (item: any, type: string, siteId: string, keyField = 'slug'): Node => {
    const rawKey = item.slug || (keyField !== 'type' ? item[keyField] : undefined) || item.key || item.id || item.type || '';
    const slug = String(rawKey || `${type}_${Math.random().toString(36).slice(2, 8)}`);
    return {
        ...item,
        id: item.id || `${type}_${slug}`,
        site_id: siteId,
        slug,
        type,
        title: item.title || item.name || slug,
        summary: item.summary || item.description || '',
        status: 'published',
        visibility: 'public',
        metadata: item.metadata || item,
        curator_id: 'system',
        created_at: '',
        updated_at: '',
        locale: 'zh-CN'
    };
};

export const findEntityForVcs = (db: D1Database, table: string, id: string) =>
    db.prepare(`SELECT * FROM ${table} WHERE id = ? LIMIT 1`).bind(id).first<any>();

export const findLatestEntityVersion = (db: D1Database, verTable: string, fkCol: string, id: string) =>
    db.prepare(`SELECT * FROM ${verTable} WHERE ${fkCol} = ? AND deleted_at IS NULL ORDER BY version_number DESC LIMIT 1`).bind(id).first<any>();

export const findMaxEntityVersionNumber = async (db: D1Database, verTable: string, fkCol: string, id: string): Promise<number> => {
    const row = await db.prepare(`SELECT COALESCE(MAX(version_number), 0) as max_ver FROM ${verTable} WHERE ${fkCol} = ?`).bind(id).first<{ max_ver: number }>();
    return row?.max_ver || 0;
};

export const insStmt = (db: D1Database, table: string, cols: string, vals: any[]) =>
    db.prepare(`INSERT INTO ${table} (${cols}) VALUES (${vals.map(() => '?').join(', ')})`).bind(...vals);

export const updStmt = (db: D1Database, table: string, setClause: string, vals: any[], id: string) =>
    db.prepare(`UPDATE ${table} SET ${setClause}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(...vals, id);

export function bindInsertVersion(db: D1Database, table: string, fkCol: string, params: any): D1PreparedStatement {
    const fk = table === 'micro_versions' ? (params.microId || params.microContentId) : (params.articleId || params.pageId);
    if (table === 'micro_versions') {
        return insStmt(db, table, `id, ${fkCol}, version_number, title, content_raw, metadata_snapshot, commit_message, author_id, created_at`,
            [params.id, fk, params.versionNumber, params.title, params.contentRaw, params.metadataSnapshot, params.commitMessage, params.authorId, params.createdAt]);
    }
    return insStmt(db, table, `id, ${fkCol}, version_number, title, summary, content_raw, metadata_snapshot, commit_message, author_id, created_at`,
        [params.id, fk, params.versionNumber, params.title, params.summary, params.contentRaw, params.metadataSnapshot, params.commitMessage, params.authorId, params.createdAt]);
}

export const insEntity = (db: D1Database, tbl: string, midCols: string, midVals: any[], p: any) =>
    insStmt(db, tbl, `id, site_id, slug, ${midCols}status, visibility, title, summary, metadata, current_version_id, curator_id, published_at, created_at, updated_at`,
        [p.id, p.siteId, p.slug, ...midVals, p.status, 'public', p.title, p.summary, p.metadataStr, p.currentVersionId, p.curatorId, p.publishedAt, p.createdAt, p.updatedAt]);

export const ENTITY_TABLE_CONFIGS = [
    { type: 'article', table: 'articles', verTable: 'article_versions', fk: 'article_id' },
    { type: 'page', table: 'pages', verTable: 'page_versions', fk: 'page_id' },
    { type: 'micro', table: 'micros', verTable: 'micro_versions', fk: 'micro_id' }
] as const;
