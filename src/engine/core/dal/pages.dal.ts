import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import { findPublishedTheme, extractThemeTemplatesFromTheme, extractThemeComponentsFromTheme } from './themes.dal';
import {
    Node,
    mapContentEntityRow,
    parseJson,
    toVirtualNode,
    findEntityForVcs,
    findLatestEntityVersion,
    updStmt,
    bindInsertVersion,
    insEntity
} from './content-common';

export async function findPageSlugById(db: D1Database, pageId: string): Promise<string | null> {
    let currentId: string | null = pageId;
    const segments: string[] = [];
    const visited = new Set<string>();

    while (currentId && !visited.has(currentId)) {
        visited.add(currentId);
        const row: { slug: string; parent_id: string | null } | null = await db.prepare(`SELECT slug, parent_id FROM pages WHERE id = ? LIMIT 1`).bind(currentId).first<{ slug: string; parent_id: string | null }>();
        if (!row || !row.slug) break;
        const cleanSlug = row.slug.replace(/^\/+|\/+$/g, '');
        if (cleanSlug && cleanSlug !== 'index') segments.unshift(cleanSlug);
        currentId = row.parent_id;
    }
    return segments.length > 0 ? segments.join('/') : null;
}

export const findPageForVcs = (db: D1Database, pageId: string) =>
    findEntityForVcs(db, 'pages', pageId);

export const findLatestPageVersion = (db: D1Database, pageId: string) =>
    findLatestEntityVersion(db, 'page_versions', 'page_id', pageId);

export function buildUpdatePageMetadataOnlyStatement(db: D1Database, params: any): D1PreparedStatement {
    return updStmt(
        db,
        'pages',
        'title = ?, slug = ?, parent_id = ?, locale = ?, status = ?, summary = ?, metadata = ?',
        [params.title, params.slug, params.parentId, params.locale, params.status, params.summary, params.metadataStr],
        params.pageId
    );
}

export function buildUpdatePageVersionSnapshotStatement(db: D1Database, params: any): D1PreparedStatement {
    return db.prepare(`UPDATE page_versions SET title = ?, summary = ?, metadata_snapshot = ? WHERE id = ?`).bind(
        params.title, params.summary, params.metadataSnapshot, params.versionId
    );
}

export function buildInsertPageVersionStatement(db: D1Database, params: any): D1PreparedStatement {
    return bindInsertVersion(db, 'page_versions', 'page_id', params);
}

export function buildUpdatePageWithVersionStatement(db: D1Database, params: any): D1PreparedStatement {
    return updStmt(
        db,
        'pages',
        'title = ?, slug = ?, parent_id = ?, locale = ?, status = ?, summary = ?, metadata = ?, current_version_id = ?',
        [params.title, params.slug, params.parentId, params.locale, params.status, params.summary, params.metadataStr, params.versionId],
        params.pageId
    );
}

export function buildDeleteSoftDeletedPageDuplicatesStatement(
    db: D1Database,
    siteId: string,
    slug: string,
    locale: string,
    parentId: string | null
): D1PreparedStatement {
    return db.prepare(`DELETE FROM pages WHERE site_id = ? AND slug = ? AND locale = ? AND (parent_id = ? OR (parent_id IS NULL AND ? IS NULL)) AND deleted_at IS NOT NULL`).bind(siteId, slug, locale, parentId, parentId);
}

export const buildInsertPageStatement = (db: D1Database, p: any) =>
    insEntity(db, 'pages', 'parent_id, locale, ', [p.parentId, p.locale], p);

export async function findPagesDataForEditor(
    db: D1Database,
    siteId: string,
    excludePageId?: string
): Promise<{
    templates: Node[];
    existingPages: Node[];
    activeThemeId?: string;
    activeThemeSlug?: string;
    activeThemeMeta?: string;
    componentNodes: Node[];
}> {
    const theme = await findPublishedTheme(db, siteId);
    const themeMeta = theme?.metadata || {};
    const templates = extractThemeTemplatesFromTheme(theme, siteId).map(t => toVirtualNode(t, 'template', siteId));
    const componentNodes = extractThemeComponentsFromTheme(theme, siteId).map(c => toVirtualNode(c, 'component', siteId));

    const pageSql = `SELECT p.*, 'page' as type, v.content_raw FROM pages p LEFT JOIN page_versions v ON v.id = p.current_version_id WHERE p.site_id = ? ${excludePageId ? 'AND p.id != ?' : ''} AND p.deleted_at IS NULL ORDER BY p.updated_at DESC`;
    const pageBind = excludePageId ? [siteId, excludePageId] : [siteId];
    const { results: existingPages } = await db.prepare(pageSql).bind(...pageBind).all<any>();

    return {
        templates,
        existingPages: (existingPages || []).map(p => mapContentEntityRow(p, 'page')),
        activeThemeId: theme?.id,
        activeThemeSlug: theme?.slug,
        activeThemeMeta: theme ? JSON.stringify(themeMeta) : undefined,
        componentNodes
    };
}

export async function getPageEditorInitData(
    db: D1Database,
    siteId: string,
    excludePageId?: string
): Promise<{
    templates: Node[];
    existingPages: Node[];
    templatePages: Node[];
    activeThemeId?: string;
    activeThemeSlug?: string;
    themeComponents: any[];
}> {
    const { templates, existingPages, activeThemeId, activeThemeSlug, componentNodes } = await findPagesDataForEditor(
        db,
        siteId,
        excludePageId
    );

    const templatePages = existingPages.filter((p) => {
        const meta = parseJson<Record<string, any>>(p.metadata, {});
        return meta.page_type === 'template' && (!excludePageId || p.id !== excludePageId);
    });

    return {
        templates,
        existingPages,
        templatePages,
        activeThemeId,
        activeThemeSlug,
        themeComponents: componentNodes
    };
}

export async function getPagesListData(
    db: D1Database,
    siteId: string
): Promise<{ pages: Array<Node & { templateTitle?: string }>; templates: Node[] }> {
    const { existingPages, templates } = await findPagesDataForEditor(db, siteId);
    return {
        pages: existingPages as Array<Node & { templateTitle?: string }>,
        templates
    };
}

export async function findPagesListBundle(
    db: D1Database,
    siteId: string
): Promise<{ pages: Array<Node & { templateTitle?: string }>; templates: Node[]; sites: any[] }> {
    const [pagesRes, sitesRes] = await db.batch([
        db.prepare(`
            SELECT p.*, 'page' as type
            FROM pages p
            WHERE p.site_id = ? AND p.deleted_at IS NULL
            ORDER BY p.updated_at DESC
        `).bind(siteId),
        db.prepare(`SELECT * FROM sites WHERE status = 'active' ORDER BY created_at ASC`)
    ]);
    const allPages = (pagesRes.results || []).map((r: any) => mapContentEntityRow(r, 'page')) as Array<Node & { templateTitle?: string }>;
    const templates = allPages.filter((p: any) => {
        const meta = typeof p.metadata === 'string' ? (() => { try { return JSON.parse(p.metadata); } catch { return {}; } })() : (p.metadata || {});
        return meta?.page_type === 'template';
    });
    const tplTitleMap = new Map(templates.map(t => [t.id, t.title]));
    for (const p of allPages as any[]) {
        const meta = typeof p.metadata === 'string' ? (() => { try { return JSON.parse(p.metadata); } catch { return {}; } })() : (p.metadata || {});
        const tplId = meta?.template_id;
        if (tplId && tplTitleMap.has(tplId)) {
            p.templateTitle = tplTitleMap.get(tplId);
        }
    }
    return { pages: allPages, templates, sites: sitesRes.results || [] };
}
