import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import {
    Node,
    NodeVersion,
    parseJson,
    mapContentEntityRow,
    normalizePagination
} from './content-common';

export * from './content-common';
export * from './articles.dal';
export * from './pages.dal';
export * from './micro-contents.dal';
export * from './relations.dal';
export * from './trash.dal';
export * from './dashboard.dal';

export async function findNodeById(
    db: D1Database,
    id: string,
    entityType?: 'article' | 'page' | 'micro' | 'dataset',
    siteId?: string
): Promise<Node | null> {
    const siteFilter = siteId ? ' AND site_id = ?' : '';
    const bindArgs = siteId ? [id, siteId] : [id];
    const tableMap = { article: 'articles', page: 'pages', micro: 'micros', dataset: 'datasets' } as const;
    if (entityType) {
        const table = tableMap[entityType];
        const row = await db.prepare(`SELECT *, '${entityType}' as type FROM ${table} WHERE id = ?${siteFilter} LIMIT 1`).bind(...bindArgs).first<any>();
        return row ? mapContentEntityRow(row, entityType) : null;
    }
    for (const [table, type] of [['articles', 'article'], ['pages', 'page'], ['micros', 'micro'], ['datasets', 'dataset']] as const) {
        const row = await db.prepare(`SELECT *, '${type}' as type FROM ${table} WHERE id = ?${siteFilter} LIMIT 1`).bind(...bindArgs).first<any>();
        if (row) return mapContentEntityRow(row, type);
    }
    return null;
}

export async function findPublishedNodeBySlug(
    db: D1Database,
    siteId: string,
    slug: string,
    locale?: string,
    includePassword: boolean | 'all' = false
): Promise<Node | null> {
    const bareSlug = (slug || '').trim().replace(/^\/+|\/+$/g, '');
    const slashSlug = bareSlug ? `/${bareSlug}` : '/';
    const candidates = bareSlug === '' ? ['/', 'index', ''] : [bareSlug, slashSlug];
    const placeholders = candidates.map(() => '?').join(', ');
    const targets = [['pages', 'page'], ['articles', 'article'], ...(bareSlug ? [['micros', 'micro']] : [])] as const;
    const visClause = includePassword === 'all'
        ? `1=1`
        : (includePassword
            ? `(visibility = 'public' OR visibility IS NULL OR visibility = 'password')`
            : `(visibility = 'public' OR visibility IS NULL)`);
    const nowIso = new Date().toISOString();
    const pubGateClause = includePassword === 'all' ? '' : ` AND (published_at IS NULL OR REPLACE(published_at, ' ', 'T') <= ?)`;

    for (const [table, type] of targets) {
        const sql = locale
            ? `SELECT *, '${type}' as type FROM ${table} WHERE site_id = ? AND slug IN (${placeholders}) AND status = 'published' AND ${visClause}${pubGateClause} AND deleted_at IS NULL ORDER BY CASE WHEN locale = ? THEN 0 ELSE 1 END ASC LIMIT 1`
            : `SELECT *, '${type}' as type FROM ${table} WHERE site_id = ? AND slug IN (${placeholders}) AND status = 'published' AND ${visClause}${pubGateClause} AND deleted_at IS NULL LIMIT 1`;
        const bindArgs = includePassword === 'all'
            ? (locale ? [siteId, ...candidates, locale] : [siteId, ...candidates])
            : (locale ? [siteId, ...candidates, nowIso, locale] : [siteId, ...candidates, nowIso]);
        const row = await db.prepare(sql).bind(...bindArgs).first<any>();
        if (row) return mapContentEntityRow(row, type);
    }
    return null;
}

export async function findLatestActiveVersion(
    db: D1Database,
    nodeId: string
): Promise<NodeVersion | null> {
    return (await db.prepare(
        `SELECT id, entity_id as node_id, version_number, title, summary, content_raw, content_rendered, metadata_snapshot, commit_message, author_id, created_at, deleted_at
         FROM entity_versions
         WHERE entity_id = ? AND entity_type IN ('article', 'page', 'micro', 'dataset') AND deleted_at IS NULL
         ORDER BY version_number DESC LIMIT 1`
    ).bind(nodeId).first<any>()) || null;
}

export async function queryNodesWithFiltersFromDb(
    db: D1Database,
    params: {
        siteId: string;
        id?: string;
        slug?: string;
        maturity?: string;
        type?: string;
        status?: string;
        locale?: string;
        tag?: string;
        fields?: string[] | string;
        page?: number | string;
        limit?: number | string;
        offset?: number | string;
        excludeApiOnly?: boolean;
    },
    isAuthorizedUser = false
): Promise<{ nodes: Node[]; items: Node[]; total: number }> {
    const { siteId, type } = params;
    // Force published/public filters for unauthenticated callers to prevent draft enumeration via ?status=draft.
    const effectiveStatus = isAuthorizedUser ? (params.status || 'published') : 'published';
    const norm = normalizePagination({ page: params.page, limit: params.limit });
    const safeLimit = norm.limit;
    const safeOffset = params.offset !== undefined ? Math.max(0, Number(params.offset) || 0) : norm.offset;

    const isMicro = type === 'micro';
    const tableName = isMicro ? 'micros' : 'articles';
    const itemType = isMicro ? 'micro' : 'article';
    const whereParts: string[] = ['site_id = ?', 'status = ?', 'deleted_at IS NULL'];
    const bindVals: any[] = [siteId, effectiveStatus];

    if (!isAuthorizedUser) {
        whereParts.push(params.excludeApiOnly
            ? `(visibility = 'public' OR visibility IS NULL)`
            : `(visibility = 'public' OR visibility IS NULL OR visibility = 'api_only')`);
        whereParts.push(`(published_at IS NULL OR REPLACE(published_at, ' ', 'T') <= ?)`);
        bindVals.push(new Date().toISOString());
    }
    if (params.id) {
        whereParts.push('id = ?');
        bindVals.push(String(params.id).trim());
    }
    if (params.slug) {
        whereParts.push('slug = ?');
        bindVals.push(String(params.slug).trim());
    }
    const progVal = (params as any).progress || params.maturity;
    if (progVal) {
        whereParts.push(isMicro ? 'progress = ?' : 'maturity = ?');
        bindVals.push(String(progVal).trim());
    }
    if ((params as any).folder) {
        whereParts.push(`json_extract(metadata, '$.folder') = ?`);
        bindVals.push(String((params as any).folder).trim());
    }
    if (params.locale) {
        whereParts.push('locale = ?');
        bindVals.push(String(params.locale).trim());
    }
    if (params.tag) {
        whereParts.push(`json_extract(metadata, '$.tags') LIKE ?`);
        bindVals.push(`%${String(params.tag).trim()}%`);
    }

    const whereClause = whereParts.join(' AND ');
    const selectCols = isAuthorizedUser
        ? `t.*, '${itemType}' as type${isMicro ? '' : `, COALESCE(v.content_raw, '') as content_raw`}`
        : isMicro
            ? `t.id, t.site_id, t.slug, '${itemType}' as type, t.locale, t.status, t.visibility, t.title, t.content_raw, COALESCE(t.content_html, '') as content_html, t.progress, t.metadata, t.published_at, t.created_at, t.updated_at`
            : `t.id, t.site_id, t.slug, '${itemType}' as type, t.locale, t.status, t.visibility, t.title, t.summary, t.cover_image_url, t.maturity, t.metadata, t.published_at, t.created_at, t.updated_at, COALESCE(v.content_raw, '') as content_raw`;

    const qualifiedWhere = whereClause.replace(/\b(site_id|status|visibility|deleted_at|id|slug|progress|maturity|locale|metadata|published_at)\b/g, 't.$1');
    const joinClause = isMicro ? '' : `LEFT JOIN entity_versions v ON t.current_version_id = v.id AND v.entity_type = 'article'`;

    const [countBatch, listBatch] = await db.batch([
        db.prepare(`SELECT count(*) as total FROM ${tableName} t WHERE ${qualifiedWhere}`).bind(...bindVals),
        db.prepare(`SELECT ${selectCols} FROM ${tableName} t ${joinClause} WHERE ${qualifiedWhere} ORDER BY COALESCE(t.published_at, t.created_at) DESC, t.created_at DESC LIMIT ? OFFSET ?`).bind(...bindVals, safeLimit, safeOffset)
    ]);
    const countRow = (countBatch.results?.[0] as { total: number } | undefined) || null;
    const results = (listBatch.results || []) as any[];

    const nodes = (results || []).map(r => {
        const mapped = mapContentEntityRow(r, itemType) as any;
        if (!isAuthorizedUser) {
            delete mapped.curator_id;
            delete mapped.deleted_at;
        }
        return mapped as Node;
    });

    return {
        nodes,
        items: nodes,
        total: countRow?.total || 0
    };
}

export async function queryNodesWithFilters(
    db: D1Database,
    params: any,
    isAuthorizedUser?: boolean
) {
    return await queryNodesWithFiltersFromDb(db, params, !!isAuthorizedUser);
}

export async function fetchLatestNodesForVisitor(
    db: D1Database,
    siteId: string,
    limit: number,
    locale?: string
): Promise<Node[]> {
    const hasLocale = Boolean(locale && locale !== 'all');
    const nowIso = new Date().toISOString();
    const sql = hasLocale
        ? `
        SELECT id, slug, 'article' as type, locale, title, summary, cover_image_url, maturity, metadata, updated_at, published_at
        FROM articles
        WHERE site_id = ? AND status = 'published' AND (visibility = 'public' OR visibility IS NULL) AND (published_at IS NULL OR REPLACE(published_at, ' ', 'T') <= ?) AND deleted_at IS NULL AND locale = ?
        ORDER BY COALESCE(published_at, created_at) DESC, created_at DESC
        LIMIT ?
    `
        : `
        SELECT id, slug, 'article' as type, locale, title, summary, cover_image_url, maturity, metadata, updated_at, published_at
        FROM articles
        WHERE site_id = ? AND status = 'published' AND (visibility = 'public' OR visibility IS NULL) AND (published_at IS NULL OR REPLACE(published_at, ' ', 'T') <= ?) AND deleted_at IS NULL
        ORDER BY COALESCE(published_at, created_at) DESC, created_at DESC
        LIMIT ?
    `;
    const stmt = hasLocale ? db.prepare(sql).bind(siteId, nowIso, locale, limit) : db.prepare(sql).bind(siteId, nowIso, limit);
    const { results } = await stmt.all<any>();
    return (results || []).map(r => mapContentEntityRow(r, 'article'));
}

export async function findPublishedNodeAndVersionBySlug(
    db: D1Database,
    siteId: string,
    slug: string
): Promise<{ node: Node; version: NodeVersion } | null> {
    const node = await findPublishedNodeBySlug(db, siteId, slug);
    if (!node) return null;
    const version = await findLatestActiveVersion(db, node.id);
    if (!version) return null;
    return { node, version };
}

export async function findNodesByIdsForExport(
    db: D1Database,
    ids: string[],
    siteId?: string
): Promise<Array<Node & { content_raw?: string }>> {
    if (!ids || ids.length === 0) return [];
    const ph = ids.map(() => '?').join(',');
    const q = (t: string, type: string) => {
        const sql = `SELECT x.*, '${type}' as type, v.content_raw FROM ${t} x LEFT JOIN entity_versions v ON v.id = x.current_version_id AND v.entity_type = '${type}' WHERE x.id IN (${ph}) AND x.deleted_at IS NULL${siteId ? ' AND x.site_id = ?' : ''}`;
        return db.prepare(sql).bind(...(siteId ? [...ids, siteId] : ids)).all<any>();
    };
    const [a, p, m] = await Promise.all([
        q('articles', 'article'),
        q('pages', 'page'),
        q('micros', 'micro')
    ]);
    return [...(a.results || []), ...(p.results || []), ...(m.results || [])].map(r => mapContentEntityRow(r, r.type));
}

export interface SitemapContentNodeDto {
    slug: string;
    type: 'article' | 'page';
    updated_at: string;
    published_at?: string | null;
    metadata?: any;
}

export async function querySitemapContentNodes(
    db: D1Database,
    siteId: string,
    limit = 1000
): Promise<SitemapContentNodeDto[]> {
    const nowIso = new Date().toISOString();
    const { results } = await db.prepare(`
        SELECT slug, 'article' as type, updated_at, published_at, metadata
        FROM articles
        WHERE site_id = ? AND status = 'published' AND (visibility = 'public' OR visibility IS NULL) AND (published_at IS NULL OR REPLACE(published_at, ' ', 'T') <= ?) AND deleted_at IS NULL
        UNION ALL
        SELECT slug, 'page' as type, updated_at, published_at, metadata
        FROM pages
        WHERE site_id = ? AND status = 'published' AND (visibility = 'public' OR visibility IS NULL) AND (published_at IS NULL OR REPLACE(published_at, ' ', 'T') <= ?) AND deleted_at IS NULL
        ORDER BY updated_at DESC
        LIMIT ?
    `).bind(siteId, nowIso, siteId, nowIso, limit).all<any>();

    return (results || []).map(r => ({
        ...r,
        metadata: parseJson(r.metadata, {})
    })) as SitemapContentNodeDto[];
}

export async function findActiveNodeIdBySlugInTable(
    db: D1Database,
    table: 'articles' | 'pages' | 'micros',
    siteId: string,
    slug: string
): Promise<{ id: string } | null> {
    return await db.prepare(
        `SELECT id FROM ${table} WHERE site_id = ? AND slug = ? AND deleted_at IS NULL LIMIT 1`
    ).bind(siteId, slug).first<{ id: string }>();
}

export interface QuickActionSearchItem {
    id: string;
    title: string;
    slug: string;
    type: 'article' | 'page' | 'dataset';
    editUrl: string;
}

export async function searchQuickActionNodes(
    db: D1Database,
    siteId: string,
    query: string,
    limit = 12
): Promise<QuickActionSearchItem[]> {
    const pattern = `%${query}%`;
    const perGroupLimit = Math.max(3, Math.ceil(limit / 3));
    const [artRes, pageRes, dsRes] = await db.batch([
        db.prepare(
            `SELECT id, title, slug FROM articles WHERE site_id = ? AND deleted_at IS NULL AND (title LIKE ? OR slug LIKE ?) ORDER BY updated_at DESC LIMIT ?`
        ).bind(siteId, pattern, pattern, perGroupLimit),
        db.prepare(
            `SELECT id, title, slug FROM pages WHERE site_id = ? AND deleted_at IS NULL AND (title LIKE ? OR slug LIKE ?) ORDER BY updated_at DESC LIMIT ?`
        ).bind(siteId, pattern, pattern, perGroupLimit),
        db.prepare(
            `SELECT id, title, slug, schema_slug FROM datasets WHERE site_id = ? AND deleted_at IS NULL AND (title LIKE ? OR slug LIKE ? OR schema_slug LIKE ?) ORDER BY updated_at DESC LIMIT ?`
        ).bind(siteId, pattern, pattern, pattern, perGroupLimit)
    ]);

    const items: QuickActionSearchItem[] = [];
    for (const a of (artRes.results || []) as Array<{ id: string; title: string; slug: string }>) {
        items.push({ id: a.id, title: a.title, slug: `/${a.slug}`, type: 'article', editUrl: `/admin/articles/edit/${encodeURIComponent(a.id)}` });
    }
    for (const p of (pageRes.results || []) as Array<{ id: string; title: string; slug: string }>) {
        items.push({ id: p.id, title: p.title, slug: p.slug.startsWith('/') ? p.slug : `/${p.slug}`, type: 'page', editUrl: `/admin/pages/edit/${encodeURIComponent(p.id)}` });
    }
    for (const d of (dsRes.results || []) as Array<{ id: string; title: string; slug: string; schema_slug: string }>) {
        const sch = d.schema_slug || 'default';
        items.push({ id: d.id, title: d.title, slug: `${sch}/${d.slug}`, type: 'dataset', editUrl: `/admin/datasets/collection/${encodeURIComponent(sch)}` });
    }
    return items.slice(0, limit);
}

export async function findNodeSiteAndSlug(
    db: D1Database,
    nodeId: string,
    siteId?: string
): Promise<{ site_id: string; slug: string; type: 'article' | 'page' | 'micro' | 'dataset' } | null> {
    if (siteId) {
        return await db.prepare(`
            SELECT site_id, slug, 'article' as type FROM articles WHERE id = ? AND site_id = ?
            UNION ALL SELECT site_id, slug, 'page' as type FROM pages WHERE id = ? AND site_id = ?
            UNION ALL SELECT site_id, slug, 'micro' as type FROM micros WHERE id = ? AND site_id = ?
            UNION ALL SELECT site_id, slug, 'dataset' as type FROM datasets WHERE id = ? AND site_id = ? LIMIT 1
        `).bind(nodeId, siteId, nodeId, siteId, nodeId, siteId, nodeId, siteId).first<{ site_id: string; slug: string; type: 'article' | 'page' | 'micro' | 'dataset' }>();
    }
    return await db.prepare(`
        SELECT site_id, slug, 'article' as type FROM articles WHERE id = ?
        UNION ALL SELECT site_id, slug, 'page' as type FROM pages WHERE id = ?
        UNION ALL SELECT site_id, slug, 'micro' as type FROM micros WHERE id = ?
        UNION ALL SELECT site_id, slug, 'dataset' as type FROM datasets WHERE id = ? LIMIT 1
    `).bind(nodeId, nodeId, nodeId, nodeId).first<{ site_id: string; slug: string; type: 'article' | 'page' | 'micro' | 'dataset' }>();
}

export async function findNodeMetadataById(
    db: D1Database,
    nodeId: string,
    siteId?: string
): Promise<{ metadata?: string } | null> {
    if (siteId) {
        return await db.prepare(`
            SELECT metadata FROM articles WHERE id = ? AND site_id = ?
            UNION ALL SELECT metadata FROM pages WHERE id = ? AND site_id = ?
            UNION ALL SELECT metadata FROM micros WHERE id = ? AND site_id = ? LIMIT 1
        `).bind(nodeId, siteId, nodeId, siteId, nodeId, siteId).first<{ metadata?: string }>();
    }
    return await db.prepare(`
        SELECT metadata FROM articles WHERE id = ?
        UNION ALL SELECT metadata FROM pages WHERE id = ?
        UNION ALL SELECT metadata FROM micros WHERE id = ? LIMIT 1
    `).bind(nodeId, nodeId, nodeId).first<{ metadata?: string }>();
}

export async function findLatestVersionIdsForNode(
    db: D1Database,
    nodeId: string
): Promise<{ artVerId?: string | null; pageVerId?: string | null; microVerId?: string | null; datasetVerId?: string | null }> {
    const { results } = await db.prepare(
        `SELECT entity_type, id FROM entity_versions WHERE entity_id = ? AND entity_type IN ('article', 'page', 'micro', 'dataset') ORDER BY version_number DESC`
    ).bind(nodeId).all<{ entity_type: string; id: string }>();
    const map = new Map<string, string>();
    for (const r of results || []) {
        if (!map.has(r.entity_type)) map.set(r.entity_type, r.id);
    }
    return {
        artVerId: map.get('article') || null,
        pageVerId: map.get('page') || null,
        microVerId: map.get('micro') || null,
        datasetVerId: map.get('dataset') || null
    };
}

export async function findRestoredNodeById(
    db: D1Database,
    nodeId: string,
    siteId?: string
): Promise<any | null> {
    if (siteId) {
        return await db.prepare(`
            SELECT id, site_id, slug, status, title, locale, NULL as parent_id, metadata, 'article' as type FROM articles WHERE id = ? AND site_id = ?
            UNION ALL
            SELECT id, site_id, slug, status, title, locale, parent_id, metadata, 'page' as type FROM pages WHERE id = ? AND site_id = ?
            UNION ALL
            SELECT id, site_id, slug, status, title, locale, NULL as parent_id, metadata, 'micro' as type FROM micros WHERE id = ? AND site_id = ?
            UNION ALL
            SELECT id, site_id, slug, status, title, 'zh-CN' as locale, NULL as parent_id, metadata, 'dataset' as type FROM datasets WHERE id = ? AND site_id = ?
            LIMIT 1
        `).bind(nodeId, siteId, nodeId, siteId, nodeId, siteId, nodeId, siteId).first<any>();
    }
    return await db.prepare(`
        SELECT id, site_id, slug, status, title, locale, NULL as parent_id, metadata, 'article' as type FROM articles WHERE id = ?
        UNION ALL
        SELECT id, site_id, slug, status, title, locale, parent_id, metadata, 'page' as type FROM pages WHERE id = ?
        UNION ALL
        SELECT id, site_id, slug, status, title, locale, NULL as parent_id, metadata, 'micro' as type FROM micros WHERE id = ?
        UNION ALL
        SELECT id, site_id, slug, status, title, 'zh-CN' as locale, NULL as parent_id, metadata, 'dataset' as type FROM datasets WHERE id = ?
        LIMIT 1
    `).bind(nodeId, nodeId, nodeId, nodeId).first<any>();
}

export function buildMoveNodeFolderStatements(
    db: D1Database,
    nodeId: string,
    metadataJson: string,
    siteId?: string
): D1PreparedStatement[] {
    if (siteId) {
        return [
            db.prepare(`UPDATE articles SET metadata = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND site_id = ?`).bind(metadataJson, nodeId, siteId),
            db.prepare(`UPDATE pages SET metadata = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND site_id = ?`).bind(metadataJson, nodeId, siteId),
            db.prepare(`UPDATE micros SET metadata = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND site_id = ?`).bind(metadataJson, nodeId, siteId)
        ];
    }
    return [
        db.prepare(`UPDATE articles SET metadata = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(metadataJson, nodeId),
        db.prepare(`UPDATE pages SET metadata = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(metadataJson, nodeId),
        db.prepare(`UPDATE micros SET metadata = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(metadataJson, nodeId)
    ];
}
