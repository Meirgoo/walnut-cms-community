import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import { normalizeLocaleCode } from '../i18n';
import { findPublishedTheme, extractThemeTemplatesFromTheme, extractThemeComponentsFromTheme } from './themes.dal';
import { findSiteById } from './sites.dal';
import { mergeSiteAndThemeSchemas, extractSchemaFields } from './datasets.dal';
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
import { buildUpdateEntityVersionSnapshotStatement } from './versions.dal';

export async function findPageSlugById(db: D1Database, pageId: string): Promise<string | null> {
    let currentId: string | null = pageId;
    const segments: string[] = [];
    const visited = new Set<string>();

    while (currentId && !visited.has(currentId)) {
        visited.add(currentId);
        const row: { slug: string; parent_id: string | null } | null = await db.prepare(
            `SELECT slug, parent_id FROM pages WHERE id = ? AND deleted_at IS NULL AND status = 'published' LIMIT 1`
        ).bind(currentId).first<{ slug: string; parent_id: string | null }>();
        if (!row || !row.slug) break;
        const cleanSlug = row.slug.replace(/^\/+|\/+$/g, '');
        if (cleanSlug && cleanSlug !== 'index') segments.unshift(cleanSlug);
        currentId = row.parent_id;
    }
    return segments.length > 0 ? segments.join('/') : null;
}

export function createPageParentPathResolver(
    pages: Array<{ id: string; slug: string; parent_id?: string | null }>
): (pageId?: string | null) => string | null {
    const pageMap = new Map<string, { slug: string; parent_id?: string | null }>();
    for (const p of pages) {
        pageMap.set(p.id, { slug: p.slug, parent_id: p.parent_id });
    }
    const memo = new Map<string, string | null>();
    const resolve = (pageId?: string | null, visited = new Set<string>()): string | null => {
        if (!pageId) return null;
        if (memo.has(pageId)) return memo.get(pageId)!;
        if (visited.has(pageId)) return null;
        visited.add(pageId);
        const page = pageMap.get(pageId);
        if (!page || !page.slug) {
            memo.set(pageId, null);
            return null;
        }
        const cleanSlug = page.slug.replace(/^\/+|\/+$/g, '');
        const selfSeg = cleanSlug && cleanSlug !== 'index' ? cleanSlug : '';
        const parentPath = page.parent_id ? resolve(page.parent_id, visited) : null;
        const full = [parentPath, selfSeg].filter(Boolean).join('/') || null;
        memo.set(pageId, full);
        return full;
    };
    return (pageId?: string | null) => resolve(pageId);
}

export async function loadPublishedPageParentResolver(
    db: D1Database,
    siteId: string,
    needed = true
): Promise<(pageId?: string | null) => string | null> {
    if (!needed) return () => null;
    const { results } = await db.prepare(
        `SELECT id, slug, parent_id FROM pages WHERE site_id = ? AND deleted_at IS NULL AND status = 'published'`
    ).bind(siteId).all<{ id: string; slug: string; parent_id: string | null }>();
    return createPageParentPathResolver(results || []);
}

export interface PageHierarchyRow {
    id: string;
    slug: string;
    parent_id: string | null;
    locale: string;
    translation_group_id?: string | null;
    status: string;
    visibility?: string | null;
    title: string;
    metadata?: string | null;
}

export async function findActivePagesHierarchyBySite(db: D1Database, siteId: string): Promise<PageHierarchyRow[]> {
    const { results } = await db.prepare(
        `SELECT id, slug, parent_id, locale, translation_group_id, status, visibility, title, metadata FROM pages WHERE site_id = ? AND deleted_at IS NULL`
    ).bind(siteId).all<PageHierarchyRow>();
    return results || [];
}

export const findPageForVcs = (db: D1Database, pageId: string, siteId?: string) =>
    findEntityForVcs(db, 'pages', pageId, siteId);

export const findLatestPageVersion = (db: D1Database, pageId: string) =>
    findLatestEntityVersion(db, 'page', pageId);

function resolvePageTranslationGroup(params: any): string | null {
    if (params.translationGroupId !== undefined) {
        return params.translationGroupId ? String(params.translationGroupId).trim() : null;
    }
    const meta = parseJson<Record<string, any>>(params.metadataStr, {});
    return meta?.translation_group_id ? String(meta.translation_group_id).trim() : null;
}

export function buildUpdatePageMetadataOnlyStatement(db: D1Database, params: any): D1PreparedStatement {
    return updStmt(
        db,
        'pages',
        'title = ?, slug = ?, parent_id = ?, locale = ?, translation_group_id = ?, status = ?, visibility = ?, summary = ?, metadata = ?, published_at = COALESCE(?, CASE WHEN ? = \'published\' AND published_at IS NULL THEN CURRENT_TIMESTAMP ELSE published_at END)',
        [params.title, params.slug, params.parentId || '', params.locale, resolvePageTranslationGroup(params), params.status, params.visibility || 'public', params.summary, params.metadataStr, params.publishedAt ?? null, params.status],
        params.pageId,
        params.siteId
    );
}

export function buildUpdatePageVersionSnapshotStatement(db: D1Database, params: any): D1PreparedStatement {
    return buildUpdateEntityVersionSnapshotStatement(db, params);
}

export function buildInsertPageVersionStatement(db: D1Database, params: any): D1PreparedStatement {
    return bindInsertVersion(db, 'page', params);
}

export function buildUpdatePageWithVersionStatement(db: D1Database, params: any): D1PreparedStatement {
    return updStmt(
        db,
        'pages',
        'title = ?, slug = ?, parent_id = ?, locale = ?, translation_group_id = ?, status = ?, visibility = ?, summary = ?, metadata = ?, current_version_id = ?, published_at = COALESCE(?, CASE WHEN ? = \'published\' AND published_at IS NULL THEN CURRENT_TIMESTAMP ELSE published_at END)',
        [params.title, params.slug, params.parentId || '', params.locale, resolvePageTranslationGroup(params), params.status, params.visibility || 'public', params.summary, params.metadataStr, params.versionId, params.publishedAt ?? null, params.status],
        params.pageId,
        params.siteId
    );
}

export async function findActiveTemplateDependents(
    db: D1Database,
    siteId: string,
    templateId: string,
    templateSlug?: string
): Promise<{ isDefaultTemplate: boolean; referencingPageCount: number }> {
    const site = await db.prepare(`SELECT settings FROM sites WHERE id = ? LIMIT 1`).bind(siteId).first<{ settings: string }>();
    const settings = parseJson<Record<string, any>>(site?.settings, {});
    const defaultTpl = String(settings.default_template_page_id || '');
    const isDefaultTemplate = Boolean(defaultTpl && (defaultTpl === templateId || (templateSlug && defaultTpl === templateSlug)));

    const { results } = await db.prepare(
        `SELECT id, metadata FROM pages WHERE site_id = ? AND id != ? AND deleted_at IS NULL`
    ).bind(siteId, templateId).all<{ id: string; metadata: string }>();
    let referencingPageCount = 0;
    for (const row of results || []) {
        const m = parseJson<Record<string, any>>(row.metadata, {});
        const refIds = [m.template_page_id, m.template_id, m.template_slug].filter(Boolean).map(String);
        if (refIds.includes(templateId) || (templateSlug && refIds.includes(templateSlug))) {
            referencingPageCount++;
        }
    }
    return { isDefaultTemplate, referencingPageCount };
}

export function buildDeleteSoftDeletedPageDuplicatesStatement(
    db: D1Database,
    siteId: string,
    slug: string,
    locale: string,
    parentId: string | null
): D1PreparedStatement {
    const normParent = parentId || '';
    return db.prepare(`DELETE FROM pages WHERE site_id = ? AND slug = ? AND locale = ? AND (parent_id = ? OR (? = '' AND parent_id IS NULL)) AND deleted_at IS NOT NULL`).bind(siteId, slug, locale, normParent, normParent);
}

export const buildInsertPageStatement = (db: D1Database, p: any) =>
    insEntity(db, 'pages', 'parent_id, locale, translation_group_id, ', [p.parentId || '', p.locale, resolvePageTranslationGroup(p)], p);

export interface PageAiSiteTaxonomy {
    articles: { total: number; folders: string[]; tags: string[] };
    micros: { total: number; folders: string[]; tags: string[]; progress: string[] };
}

const AI_SAMPLE_SYSTEM_KEYS = new Set([
    'id', 'site_id', 'collection_id', 'schema_slug', 'schema_id',
    'created_at', 'updated_at', 'deleted_at', 'current_version_id', 'curator_id', 'status'
]);

function truncateSampleValue(val: unknown): unknown {
    if (typeof val === 'string') {
        return val.length > 200 ? val.slice(0, 200) + '...' : val;
    }
    if (Array.isArray(val)) return val.slice(0, 5);
    return val;
}

function buildFlatSampleItem(row: any): Record<string, any> | null {
    if (!row) return null;
    const meta = parseJson<Record<string, any>>(row.metadata, {});
    const rawFields = (meta.fields && typeof meta.fields === 'object')
        ? meta.fields
        : ((meta.data && typeof meta.data === 'object') ? meta.data : meta);
    const flat: Record<string, any> = { title: String(row.title || '') };
    if (row.slug) flat.slug = String(row.slug);
    if (row.summary) flat.summary = truncateSampleValue(String(row.summary));
    if (rawFields && typeof rawFields === 'object') {
        for (const [k, v] of Object.entries(rawFields)) {
            if (!k || AI_SAMPLE_SYSTEM_KEYS.has(k) || k === 'title' || k === 'slug' || k === 'summary') continue;
            if (v !== undefined && v !== null) flat[k] = truncateSampleValue(v);
        }
    }
    return flat;
}

function buildTaxonomyAndDatasetStats(
    articleRows: any[],
    microRows: any[],
    colCountRows: any[],
    colSampleRows: any[]
): {
    siteTaxonomy: PageAiSiteTaxonomy;
    colItemCountMap: Map<string, number>;
    colSampleMap: Map<string, Record<string, any>>;
} {
    const pushUnique = (set: Set<string>, val: unknown, max = 30) => {
        if (set.size >= max || val === undefined || val === null) return;
        const s = String(val).trim();
        if (s) set.add(s);
    };
    const collectTags = (set: Set<string>, rawTags: unknown, max = 30) => {
        if (set.size >= max || !rawTags) return;
        const list = Array.isArray(rawTags)
            ? rawTags
            : (typeof rawTags === 'string' ? rawTags.split(',') : []);
        for (const t of list) {
            if (set.size >= max) break;
            pushUnique(set, t, max);
        }
    };

    const artFolders = new Set<string>();
    const artTags = new Set<string>();
    for (const r of articleRows || []) {
        const meta = parseJson<Record<string, any>>(r.metadata, {});
        pushUnique(artFolders, meta.folder);
        collectTags(artTags, meta.tags);
    }

    const microFolders = new Set<string>();
    const microTags = new Set<string>();
    const microProgress = new Set<string>();
    for (const r of microRows || []) {
        const meta = parseJson<Record<string, any>>(r.metadata, {});
        pushUnique(microFolders, meta.folder);
        collectTags(microTags, meta.tags);
        if (r.progress && r.progress !== 'none') pushUnique(microProgress, r.progress);
    }

    const colItemCountMap = new Map<string, number>();
    for (const r of colCountRows || []) {
        if (r?.collection_id) colItemCountMap.set(String(r.collection_id), Number(r.item_count || 0));
    }
    const colSampleMap = new Map<string, Record<string, any>>();
    for (const r of colSampleRows || []) {
        const cid = r?.collection_id ? String(r.collection_id) : '';
        if (!cid || colSampleMap.has(cid)) continue;
        const sample = buildFlatSampleItem(r);
        if (sample) colSampleMap.set(cid, sample);
    }

    return {
        siteTaxonomy: {
            articles: { total: (articleRows || []).length, folders: Array.from(artFolders), tags: Array.from(artTags) },
            micros: { total: (microRows || []).length, folders: Array.from(microFolders), tags: Array.from(microTags), progress: Array.from(microProgress) }
        },
        colItemCountMap,
        colSampleMap
    };
}

function extractPageContractResources(
    theme: any,
    siteRow: any,
    rawCollections: Array<{ id: string; slug: string; name: string; schema_key?: string }>,
    siteId: string,
    stats?: { colItemCountMap: Map<string, number>; colSampleMap: Map<string, Record<string, any>> }
) {
    const themeMeta = theme?.metadata || {};
    const templates = extractThemeTemplatesFromTheme(theme, siteId).map(t => toVirtualNode(t, 'template', siteId));
    const componentNodes = extractThemeComponentsFromTheme(theme, siteId).map(c => toVirtualNode(c, 'component', siteId));

    const rawThemeSchemas = Array.isArray(themeMeta.schemas)
        ? themeMeta.schemas
        : (Array.isArray(themeMeta.schemaNodes) ? themeMeta.schemaNodes : []);
    const siteSettings = parseJson<Record<string, any>>(siteRow?.settings, {});
    const mergedSchemas = mergeSiteAndThemeSchemas(rawThemeSchemas, siteSettings);
    const rawSchemaFieldMap = new Map(mergedSchemas.map((s) => [s.slug, extractSchemaFields(s)]));

    const schemaCountMap = new Map<string, number>();
    const schemaSampleMap = new Map<string, Record<string, any>>();
    const datasetCollections = rawCollections.map((col) => {
        const schemaKey = col.schema_key || '';
        const itemCount = stats?.colItemCountMap.get(col.id) || 0;
        const sampleItem = itemCount > 0 ? stats?.colSampleMap.get(col.id) : undefined;
        if (schemaKey) {
            schemaCountMap.set(schemaKey, (schemaCountMap.get(schemaKey) || 0) + itemCount);
            if (sampleItem && !schemaSampleMap.has(schemaKey)) {
                schemaSampleMap.set(schemaKey, sampleItem);
            }
        }
        return {
            id: col.id,
            slug: col.slug,
            name: col.name,
            schema_key: schemaKey,
            fields: schemaKey ? (rawSchemaFieldMap.get(schemaKey) || []) : [],
            item_count: itemCount,
            ...(sampleItem ? { sample_item: sampleItem } : {})
        };
    });

    const datasetSchemas = mergedSchemas.map((s) => {
        const count = schemaCountMap.get(s.slug) || 0;
        const sample = count > 0 ? schemaSampleMap.get(s.slug) : undefined;
        return {
            slug: s.slug,
            title: s.title || s.name || s.slug,
            is_custom: Boolean(s.is_custom),
            fields: extractSchemaFields(s),
            item_count: count,
            ...(sample ? { sample_item: sample } : {})
        };
    });

    const externalExtensions = (typeof __BUILD_EDITION__ === 'undefined' || __BUILD_EDITION__ !== 'community') && Array.isArray(siteSettings.external_workers)
        ? siteSettings.external_workers
            .filter((w: any) => w && w.is_active === true && w.allow_public_proxy === true && typeof w.slug === 'string' && w.slug.trim())
            .map((w: any) => ({ slug: String(w.slug).trim().toLowerCase(), name: String(w.name || w.slug).trim() }))
        : [];
    const slotQuotas: Record<string, number | null> = {};
    const rawLayout = String(themeMeta.layout_html || themeMeta.layoutHtml || '');
    const slotMatchRe = /\{\{slot:([a-zA-Z0-9_-]+)(?::(\d+))?\}\}/g;
    let slotM: RegExpExecArray | null;
    while ((slotM = slotMatchRe.exec(rawLayout)) !== null) {
        slotQuotas[slotM[1]] = slotM[2] ? Number(slotM[2]) : null;
    }

    return {
        themeMeta,
        templates,
        componentNodes,
        datasetCollections,
        datasetSchemas,
        externalExtensions,
        slotQuotas
    };
}

function buildAiTaxonomyQueries(db: D1Database, siteId: string) {
    return [
        db.prepare(`SELECT metadata FROM articles WHERE site_id = ? AND status = 'published' AND deleted_at IS NULL`).bind(siteId),
        db.prepare(`SELECT progress, metadata FROM micros WHERE site_id = ? AND status = 'published' AND deleted_at IS NULL`).bind(siteId),
        db.prepare(`SELECT collection_id, COUNT(*) as item_count FROM datasets WHERE site_id = ? AND deleted_at IS NULL AND collection_id != '' GROUP BY collection_id`).bind(siteId),
        db.prepare(`
            SELECT collection_id, slug, title, summary, metadata
            FROM (
                SELECT collection_id, slug, title, summary, metadata,
                       ROW_NUMBER() OVER (PARTITION BY collection_id ORDER BY sort_order DESC, updated_at DESC, created_at DESC) as rn
                FROM datasets
                WHERE site_id = ? AND deleted_at IS NULL AND collection_id != ''
            )
            WHERE rn = 1
        `).bind(siteId),
        db.prepare(`
            SELECT file_name, public_url, metadata
            FROM media_assets
            WHERE site_id = ? AND is_public = 1 AND deleted_at IS NULL AND mime_type LIKE 'image/%'
            ORDER BY created_at DESC
            LIMIT 8
        `).bind(siteId)
    ];
}

function mapRecentMediaRows(rows: any[]): Array<{ url: string; filename: string; alt: string }> {
    return (rows || []).filter(r => r && r.public_url).slice(0, 8).map((r: any) => {
        const meta = parseJson<Record<string, any>>(r.metadata, {});
        const filename = String(r.file_name || '');
        const alt = String(meta.alt || meta.summary || meta.title || filename).trim();
        return {
            url: String(r.public_url),
            filename,
            alt
        };
    });
}

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
    datasetCollections: Array<{ id: string; slug: string; name: string; schema_key: string; item_count?: number; sample_item?: Record<string, any>; fields: Array<{ key: string; label: string; type?: string }> }>;
    datasetSchemas: Array<{ slug: string; title: string; is_custom: boolean; item_count?: number; sample_item?: Record<string, any>; fields: Array<{ key: string; label: string; type?: string }> }>;
    siteTaxonomy: PageAiSiteTaxonomy;
    recentMedia: Array<{ url: string; filename: string; alt: string }>;
    externalExtensions: Array<{ slug: string; name: string }>;
    slotQuotas: Record<string, number | null>;
}> {
    const pageSql = `SELECT p.*, 'page' as type, v.content_raw FROM pages p LEFT JOIN entity_versions v ON v.id = p.current_version_id AND v.entity_type = 'page' WHERE p.site_id = ? ${excludePageId ? 'AND p.id != ?' : ''} AND p.deleted_at IS NULL ORDER BY p.updated_at DESC`;
    const pageBind = excludePageId ? [siteId, excludePageId] : [siteId];

    const [theme, siteRow, batchRes] = await Promise.all([
        findPublishedTheme(db, siteId),
        findSiteById(db, siteId),
        db.batch([
            db.prepare(pageSql).bind(...pageBind),
            db.prepare(`SELECT id, slug, name, schema_key FROM dataset_collections WHERE site_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC`).bind(siteId),
            ...buildAiTaxonomyQueries(db, siteId)
        ])
    ]);

    const existingPages = (batchRes[0]?.results || []) as any[];
    const rawCollections = (batchRes[1]?.results || []) as Array<{ id: string; slug: string; name: string; schema_key?: string }>;
    const stats = buildTaxonomyAndDatasetStats(
        batchRes[2]?.results || [],
        batchRes[3]?.results || [],
        batchRes[4]?.results || [],
        batchRes[5]?.results || []
    );
    const recentMedia = mapRecentMediaRows(batchRes[6]?.results || []);
    const resources = extractPageContractResources(theme, siteRow, rawCollections, siteId, stats);

    return {
        templates: resources.templates,
        existingPages: existingPages.map(p => mapContentEntityRow(p, 'page')),
        activeThemeId: theme?.id,
        activeThemeSlug: theme?.slug,
        activeThemeMeta: theme ? JSON.stringify(resources.themeMeta) : undefined,
        componentNodes: resources.componentNodes,
        datasetCollections: resources.datasetCollections,
        datasetSchemas: resources.datasetSchemas,
        siteTaxonomy: stats.siteTaxonomy,
        recentMedia,
        externalExtensions: resources.externalExtensions,
        slotQuotas: resources.slotQuotas
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
    datasetCollections: Array<{ id: string; slug: string; name: string; schema_key: string; item_count?: number; sample_item?: Record<string, any>; fields: Array<{ key: string; label: string; type?: string }> }>;
    datasetSchemas: Array<{ slug: string; title: string; is_custom: boolean; item_count?: number; sample_item?: Record<string, any>; fields: Array<{ key: string; label: string; type?: string }> }>;
    siteTaxonomy: PageAiSiteTaxonomy;
    recentMedia: Array<{ url: string; filename: string; alt: string }>;
    externalExtensions: Array<{ slug: string; name: string }>;
    slotQuotas: Record<string, number | null>;
}> {
    const {
        templates,
        existingPages,
        activeThemeId,
        activeThemeSlug,
        componentNodes,
        datasetCollections,
        datasetSchemas,
        siteTaxonomy,
        recentMedia,
        externalExtensions,
        slotQuotas
    } = await findPagesDataForEditor(db, siteId, excludePageId);

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
        themeComponents: componentNodes,
        datasetCollections,
        datasetSchemas,
        siteTaxonomy,
        recentMedia,
        externalExtensions,
        slotQuotas
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
): Promise<{
    pages: Array<Node & { templateTitle?: string }>;
    templates: Node[];
    trashCount: number;
    sites: any[];
    themeComponents: any[];
    datasetCollections: Array<{ id: string; slug: string; name: string; schema_key: string; item_count?: number; sample_item?: Record<string, any>; fields: Array<{ key: string; label: string; type?: string }> }>;
    datasetSchemas: Array<{ slug: string; title: string; is_custom: boolean; item_count?: number; sample_item?: Record<string, any>; fields: Array<{ key: string; label: string; type?: string }> }>;
    siteTaxonomy: PageAiSiteTaxonomy;
    recentMedia: Array<{ url: string; filename: string; alt: string }>;
    externalExtensions: Array<{ slug: string; name: string }>;
    slotQuotas: Record<string, number | null>;
}> {
    const [theme, batchRes] = await Promise.all([
        findPublishedTheme(db, siteId),
        db.batch([
            db.prepare(`
                SELECT p.*, 'page' as type, v.content_raw
                FROM pages p
                LEFT JOIN entity_versions v ON v.id = p.current_version_id AND v.entity_type = 'page'
                WHERE p.site_id = ? AND p.deleted_at IS NULL
                ORDER BY p.updated_at DESC
            `).bind(siteId),
            db.prepare(`
                SELECT COUNT(DISTINCT p.id) as total
                FROM pages p
                LEFT JOIN entity_versions v ON v.entity_type = 'page' AND v.entity_id = p.id
                WHERE p.site_id = ? AND (p.deleted_at IS NOT NULL OR v.deleted_at IS NOT NULL)
            `).bind(siteId),
            db.prepare(`SELECT * FROM sites WHERE status = 'active' ORDER BY created_at ASC`),
            db.prepare(`SELECT id, slug, name, schema_key FROM dataset_collections WHERE site_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC`).bind(siteId),
            ...buildAiTaxonomyQueries(db, siteId)
        ])
    ]);
    const pagesRes = batchRes[0];
    const trashRes = batchRes[1];
    const sitesRes = batchRes[2];
    const collectionsRes = batchRes[3];

    const allPages = (pagesRes.results || []).map((r: any) => mapContentEntityRow(r, 'page')) as Array<Node & { templateTitle?: string }>;
    const templates = allPages.filter((p: any) => {
        const meta = parseJson<Record<string, any>>(p.metadata, {});
        return meta?.page_type === 'template';
    });
    const tplTitleMap = new Map(templates.map(t => [t.id, t.title]));
    for (const p of allPages as any[]) {
        const meta = parseJson<Record<string, any>>(p.metadata, {});
        const tplId = meta?.template_id || meta?.template_page_id;
        if (tplId && tplTitleMap.has(tplId)) {
            p.templateTitle = tplTitleMap.get(tplId);
        }
    }
    const sites = sitesRes.results || [];
    const activeSite = sites.find((s: any) => s.id === siteId) || sites[0];
    const rawCollections = (collectionsRes?.results || []) as Array<{ id: string; slug: string; name: string; schema_key?: string }>;
    const stats = buildTaxonomyAndDatasetStats(
        batchRes[4]?.results || [],
        batchRes[5]?.results || [],
        batchRes[6]?.results || [],
        batchRes[7]?.results || []
    );
    const recentMedia = mapRecentMediaRows(batchRes[8]?.results || []);
    const resources = extractPageContractResources(theme, activeSite, rawCollections, siteId, stats);
    const trashCount = Number((trashRes.results?.[0] as { total?: number } | undefined)?.total || 0);
    return {
        pages: allPages,
        templates,
        trashCount,
        sites,
        themeComponents: resources.componentNodes,
        datasetCollections: resources.datasetCollections,
        datasetSchemas: resources.datasetSchemas,
        siteTaxonomy: stats.siteTaxonomy,
        recentMedia,
        externalExtensions: resources.externalExtensions,
        slotQuotas: resources.slotQuotas
    };
}

export async function findTranslatedTemplatePage(
    db: D1Database,
    siteId: string,
    translationGroupId: string,
    targetLocale: string
): Promise<Node | null> {
    if (!translationGroupId || !targetLocale) return null;
    const rows = await db.prepare(
        `SELECT *, 'page' as type FROM pages
         WHERE site_id = ?
           AND (translation_group_id = ? OR json_extract(metadata, '$.translation_group_id') = ?)
           AND json_extract(metadata, '$.page_type') = 'template'
           AND status = 'published'
           AND deleted_at IS NULL`
    ).bind(siteId, translationGroupId, translationGroupId).all<any>();
    const targetNorm = normalizeLocaleCode(targetLocale).toLowerCase();
    const match = (rows.results || []).find((r: any) =>
        normalizeLocaleCode(r.locale || '').toLowerCase() === targetNorm
    );
    return match ? mapContentEntityRow(match, 'page') : null;
}
