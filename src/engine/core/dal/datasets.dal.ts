import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import type { Dataset, DatasetCollection } from '../../types';
import { findPublishedTheme } from './themes.dal';
import { findSiteById } from './sites.dal';
import { parseJson } from '../utils';
import { findMaxEntityVersionNumberByType, buildInsertEntityVersionStatement } from './versions.dal';

export function mergeSiteAndThemeSchemas(themeSchemas: any[], siteSettings: any): any[] {
    const merged: any[] = [];
    const idxByKey = new Map<string, number>();
    const add = (s: any, forceCustom = false) => {
        if (!s || typeof s !== 'object') return;
        const key = String(s.slug || s.type || '').trim();
        if (!key) return;
        const existingIdx = idxByKey.get(key);
        if (existingIdx !== undefined) {
            // Allow siteSettings.custom_schemas overrides (e.g. appended fields) to extend theme schemas without flipping is_custom.
            if (forceCustom) {
                merged[existingIdx] = { ...merged[existingIdx], ...s, is_custom: merged[existingIdx].is_custom };
            }
            return;
        }
        idxByKey.set(key, merged.length);
        const isCustom = forceCustom || s.is_custom === true || s.source === 'custom';
        merged.push({ ...s, is_custom: isCustom });
    };
    (Array.isArray(themeSchemas) ? themeSchemas : []).forEach((s) => add(s, false));
    const custom = Array.isArray(siteSettings?.custom_schemas) ? siteSettings.custom_schemas : [];
    custom.forEach((s: any) => add(s, true));
    return merged;
}

export interface ThemeSchemaItem {
    id: string;
    site_id: string;
    slug: string;
    title: string;
    summary?: string;
    metadata?: any;
    fields?: any[];
}

export function extractSchemaFields(schemaItem: any): any[] {
    if (!schemaItem) return [];

    const meta = parseJson<Record<string, any>>(schemaItem.metadata, {});
    const candidateList = [
        schemaItem.fields,
        meta?.fields,
        meta?.schema?.fields,
        schemaItem.schema?.fields,
        meta?.metadata?.fields
    ];
    for (const cand of candidateList) {
        if (Array.isArray(cand) && cand.length > 0) {
            return cand;
        }
    }

    const propsObj = schemaItem.properties || meta?.properties || schemaItem.schema?.properties || meta?.schema?.properties;
    if (propsObj && typeof propsObj === 'object' && !Array.isArray(propsObj)) {
        const requiredList: string[] = Array.isArray(schemaItem.required || meta?.required || schemaItem.schema?.required)
            ? (schemaItem.required || meta?.required || schemaItem.schema?.required)
            : [];
        return Object.entries(propsObj).map(([key, prop]: [string, any]) => ({
            key,
            label: prop.title || prop.label || key,
            type: prop.type === 'boolean' ? 'boolean' : (prop.format === 'uri' ? 'url' : (prop.type === 'number' || prop.type === 'integer' ? 'number' : (prop.type === 'string' && prop.enum ? 'select' : 'text'))),
            required: requiredList.includes(key),
            placeholder: prop.description || '',
            default: prop.default,
            options: prop.enum ? prop.enum.map((v: any) => ({ value: v, label: v })) : undefined
        }));
    }

    return [];
}

export async function findSchemaBySlug(
    db: D1Database,
    siteId: string,
    schemaSlug: string
): Promise<ThemeSchemaItem | null> {
    const [theme, site] = await Promise.all([findPublishedTheme(db, siteId), findSiteById(db, siteId)]);
    const themeSchemas: any[] = theme?.metadata?.schemas || theme?.metadata?.schemaNodes || [];
    const siteSettings = parseJson<Record<string, any>>(site?.settings, {});
    const schemas = mergeSiteAndThemeSchemas(themeSchemas, siteSettings);
    const found = schemas.find((s: any) => s.slug === schemaSlug || s.type === schemaSlug);
    if (!found) return null;
    return {
        id: found.id || `schema_${found.slug || found.type}`,
        site_id: siteId,
        slug: found.slug || found.type,
        title: found.name || found.title || found.slug,
        summary: found.description || found.summary || '',
        metadata: found,
        fields: extractSchemaFields(found)
    };
}

export async function findDatasetById(
    db: D1Database,
    id: string,
    siteId?: string
): Promise<Dataset | null> {
    if (siteId) {
        return (await db.prepare(
            `SELECT * FROM datasets WHERE id = ? AND site_id = ? AND deleted_at IS NULL LIMIT 1`
        ).bind(id, siteId).first<Dataset>()) || null;
    }
    return (await db.prepare(
        `SELECT * FROM datasets WHERE id = ? AND deleted_at IS NULL LIMIT 1`
    ).bind(id).first<Dataset>()) || null;
}

export async function findLatestDatasetVersionNumber(
    db: D1Database,
    datasetId: string
): Promise<number | null> {
    const maxVer = await findMaxEntityVersionNumberByType(db, 'dataset', datasetId);
    return maxVer > 0 ? maxVer : null;
}

export async function findDatasetSlugConflict(
    db: D1Database,
    siteId: string,
    collectionId: string,
    slug: string,
    excludeId?: string
): Promise<boolean> {
    const normCol = collectionId || '';
    const sql = excludeId
        ? `SELECT id FROM datasets WHERE site_id = ? AND collection_id = ? AND slug = ? AND id != ? LIMIT 1`
        : `SELECT id FROM datasets WHERE site_id = ? AND collection_id = ? AND slug = ? LIMIT 1`;
    const row = excludeId
        ? await db.prepare(sql).bind(siteId, normCol, slug, excludeId).first<{ id: string }>()
        : await db.prepare(sql).bind(siteId, normCol, slug).first<{ id: string }>();
    return Boolean(row);
}

export const getLatestDatasetVersionNumber = findLatestDatasetVersionNumber;

export async function findDatasetsBySite(
    db: D1Database,
    siteId: string
): Promise<Dataset[]> {
    const { results } = await db.prepare(`
        SELECT * FROM datasets 
        WHERE site_id = ? AND deleted_at IS NULL
        ORDER BY updated_at DESC
    `).bind(siteId).all<Dataset>();
    return results || [];
}

export async function findPublishedDatasetsBySchema(
    db: D1Database,
    siteId: string,
    schemaSlug: string,
    limit: number = 20
): Promise<Array<{ id: string; slug: string; title: string; summary: string; metadata: string }>> {
    const { results } = await db.prepare(
        `SELECT id, slug, title, summary, metadata FROM datasets WHERE site_id = ? AND schema_slug = ? AND status = 'published' AND deleted_at IS NULL ORDER BY created_at DESC LIMIT ?`
    ).bind(siteId, schemaSlug, limit).all<{ id: string; slug: string; title: string; summary: string; metadata: string }>();
    return results || [];
}

export async function findDatasetCollectionsBySite(
    db: D1Database,
    siteId: string
): Promise<DatasetCollection[]> {
    const { results } = await db.prepare(`
        SELECT dc.*,
               COUNT(d.id) as item_count,
               COALESCE(MAX(d.updated_at), dc.updated_at) as latest_updated_at
        FROM dataset_collections dc
        LEFT JOIN datasets d ON d.collection_id = dc.id AND d.site_id = dc.site_id AND d.deleted_at IS NULL
        WHERE dc.site_id = ? AND dc.deleted_at IS NULL
        GROUP BY dc.id
        ORDER BY latest_updated_at DESC, dc.created_at DESC
    `).bind(siteId).all<DatasetCollection>();
    return results || [];
}

export async function findDatasetCollectionById(
    db: D1Database,
    id: string,
    siteId?: string
): Promise<DatasetCollection | null> {
    if (siteId) {
        return (await db.prepare(
            `SELECT * FROM dataset_collections WHERE id = ? AND site_id = ? AND deleted_at IS NULL LIMIT 1`
        ).bind(id, siteId).first<DatasetCollection>()) || null;
    }
    return (await db.prepare(
        `SELECT * FROM dataset_collections WHERE id = ? AND deleted_at IS NULL LIMIT 1`
    ).bind(id).first<DatasetCollection>()) || null;
}

export async function findDatasetCollectionBySlug(
    db: D1Database,
    siteId: string,
    slug: string
): Promise<DatasetCollection | null> {
    return (await db.prepare(
        `SELECT * FROM dataset_collections WHERE site_id = ? AND slug = ? AND deleted_at IS NULL LIMIT 1`
    ).bind(siteId, slug).first<DatasetCollection>()) || null;
}

export async function findDatasetsByCollectionId(
    db: D1Database,
    siteId: string,
    collectionId: string
): Promise<Dataset[]> {
    const { results } = await db.prepare(`
        SELECT * FROM datasets
        WHERE site_id = ? AND collection_id = ? AND deleted_at IS NULL
        ORDER BY sort_order DESC, updated_at DESC, created_at DESC
    `).bind(siteId, collectionId).all<Dataset>();
    return results || [];
}

export async function findDatasetCollectionsByIdsForExport(
    db: D1Database,
    ids: string[],
    siteId: string
): Promise<DatasetCollection[]> {
    if (!ids || ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    const { results } = await db.prepare(`
        SELECT * FROM dataset_collections WHERE id IN (${placeholders}) AND site_id = ? AND deleted_at IS NULL
    `).bind(...ids, siteId).all<DatasetCollection>();
    return results || [];
}

export async function findDatasetsListBundle(
    db: D1Database,
    siteId: string
): Promise<{ collections: DatasetCollection[]; datasets: Dataset[]; schemas: ThemeSchemaItem[]; trashCount: number; sites: any[] }> {
    const [colRes, dsRes, trashRes, themeRes, sitesRes] = await db.batch([
        db.prepare(`
            SELECT dc.*,
                   COUNT(d.id) as item_count,
                   COALESCE(MAX(d.updated_at), dc.updated_at) as latest_updated_at
            FROM dataset_collections dc
            LEFT JOIN datasets d ON d.collection_id = dc.id AND d.site_id = dc.site_id AND d.deleted_at IS NULL
            WHERE dc.site_id = ? AND dc.deleted_at IS NULL
            GROUP BY dc.id
            ORDER BY latest_updated_at DESC, dc.created_at DESC
        `).bind(siteId),
        db.prepare(`SELECT * FROM datasets WHERE site_id = ? AND deleted_at IS NULL ORDER BY sort_order DESC, updated_at DESC`).bind(siteId),
        db.prepare(`
            SELECT COUNT(DISTINCT d.id) as total
            FROM datasets d
            LEFT JOIN entity_versions v ON v.entity_type = 'dataset' AND v.entity_id = d.id
            WHERE d.site_id = ? AND (d.deleted_at IS NOT NULL OR v.deleted_at IS NOT NULL)
        `).bind(siteId),
        db.prepare(`
            SELECT t.metadata FROM themes t
            LEFT JOIN sites s ON s.id = ?
            WHERE t.deleted_at IS NULL
            ORDER BY CASE WHEN t.id = s.theme_id OR t.slug = s.theme_id THEN 1 WHEN t.site_id = ? AND t.is_active = 1 THEN 2 WHEN t.is_active = 1 THEN 3 ELSE 4 END ASC, t.updated_at DESC
            LIMIT 1
        `).bind(siteId, siteId),
        db.prepare(`SELECT * FROM sites WHERE status = 'active' ORDER BY created_at ASC`)
    ]);
    const collections = (colRes.results || []) as DatasetCollection[];
    const datasets = (dsRes.results || []) as Dataset[];
    const trashCount = Number((trashRes.results?.[0] as { total?: number } | undefined)?.total || 0);
    const themeRow = (themeRes.results?.[0] as any) || null;
    const currentSiteRow = (sitesRes.results || []).find((s: any) => s.id === siteId) as any;
    const siteSettings = parseJson<Record<string, any>>(currentSiteRow?.settings, {});
    let themeSchemas: any[] = [];
    if (themeRow?.metadata) {
        try {
            const meta = typeof themeRow.metadata === 'string' ? JSON.parse(themeRow.metadata) : themeRow.metadata;
            themeSchemas = meta?.schemas || meta?.schemaNodes || [];
        } catch {}
    }
    const schemas: ThemeSchemaItem[] = mergeSiteAndThemeSchemas(themeSchemas, siteSettings).map((s: any) => ({
        id: s.id || `schema_${s.slug || s.type}`,
        site_id: siteId,
        slug: s.slug || s.type,
        title: s.name || s.title || s.slug,
        summary: s.description || s.summary || '',
        metadata: s,
        fields: extractSchemaFields(s)
    }));
    return { collections, datasets, schemas, trashCount, sites: sitesRes.results || [] };
}

export async function findSchemasBySite(
    db: D1Database,
    siteId: string
): Promise<ThemeSchemaItem[]> {
    const [theme, site] = await Promise.all([findPublishedTheme(db, siteId), findSiteById(db, siteId)]);
    const themeSchemas: any[] = theme?.metadata?.schemas || theme?.metadata?.schemaNodes || [];
    const siteSettings = parseJson<Record<string, any>>(site?.settings, {});
    const schemas = mergeSiteAndThemeSchemas(themeSchemas, siteSettings);
    return schemas.map((s: any) => ({
        id: s.id || `schema_${s.slug || s.type}`,
        site_id: siteId,
        slug: s.slug || s.type,
        title: s.name || s.title || s.slug,
        summary: s.description || s.summary || '',
        api_only: Boolean(s.api_only),
        metadata: s,
        fields: extractSchemaFields(s)
    }));
}

export async function findDatasetsByIdsForExport(
    db: D1Database,
    ids: string[],
    siteId?: string
): Promise<Dataset[]> {
    if (!ids || ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    if (siteId) {
        const { results } = await db.prepare(`
            SELECT * FROM datasets WHERE id IN (${placeholders}) AND site_id = ? AND deleted_at IS NULL
        `).bind(...ids, siteId).all<Dataset>();
        return results || [];
    }
    const { results } = await db.prepare(`
        SELECT * FROM datasets WHERE id IN (${placeholders}) AND deleted_at IS NULL
    `).bind(...ids).all<Dataset>();
    return results || [];
}

export async function queryDatasetsJson1FromDb(
    db: D1Database,
    whereSql: string,
    bindValues: any[],
    limit: number,
    offset: number,
    sortMode: 'order' | 'latest' = 'order'
): Promise<{ items: Dataset[]; total: number }> {
    const countRow = await db.prepare(`SELECT count(*) as total FROM datasets WHERE ${whereSql}`).bind(...bindValues).first<{ total: number }>();
    const total = countRow?.total || 0;
    const orderClause = sortMode === 'latest'
        ? 'ORDER BY updated_at DESC, created_at DESC'
        : 'ORDER BY sort_order DESC, updated_at DESC, created_at DESC';

    const querySql = `
        SELECT id, site_id, schema_slug, slug, title, summary, metadata, status, sort_order, updated_at, created_at
        FROM datasets
        WHERE ${whereSql}
        ${orderClause}
        LIMIT ? OFFSET ?
    `;
    const { results } = await db.prepare(querySql).bind(...bindValues, limit, offset).all<Dataset>();

    return {
        items: results || [],
        total
    };
}

export async function queryDatasetsWithJson1Filter(
    db: D1Database,
    siteId: string,
    schemaSlug?: string,
    filters?: Record<string, string>,
    limit = 50,
    offset = 0,
    onlyPublished = false,
    excludeApiOnly = false,
    sortMode: 'order' | 'latest' = 'order'
): Promise<{ items: Dataset[]; total: number }> {
    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 50));
    const safeOffset = Math.max(0, Number(offset) || 0);
    const whereParts: string[] = ["site_id = ?", "deleted_at IS NULL"];
    const bindValues: any[] = [siteId];

    if (onlyPublished) {
        whereParts.push(excludeApiOnly ? "status = 'published'" : "(status = 'published' OR status = 'api_only')");
    }

    if (schemaSlug) {
        const matchedCollection = await findDatasetCollectionBySlug(db, siteId, schemaSlug);
        if (matchedCollection) {
            if (excludeApiOnly) {
                const schemaItem = await findSchemaBySlug(db, siteId, matchedCollection.schema_key);
                if (schemaItem && (schemaItem.metadata?.api_only || (schemaItem as any).api_only)) {
                    return { items: [], total: 0 };
                }
            }
            whereParts.push("(collection_id = ? OR ((collection_id IS NULL OR collection_id = '') AND schema_slug = ?))");
            bindValues.push(matchedCollection.id, matchedCollection.slug);
        } else {
            // Fallback for uncollected legacy rows; never leaks items bound to a different collection.
            whereParts.push("schema_slug = ? AND (collection_id IS NULL OR collection_id = '')");
            bindValues.push(schemaSlug);
        }
    }

    if (filters) {
        for (const [key, value] of Object.entries(filters)) {
            if (!/^[a-zA-Z0-9_]{1,64}$/.test(key)) {
                throw new Error(`SECURITY_INVALID_FILTER_KEY: Illegal dataset filter field name "${key}"`);
            }
            if (key === 'id') {
                whereParts.push(`id = ?`);
                bindValues.push(value);
            } else if (key === 'collection_id') {
                whereParts.push(`collection_id = ?`);
                bindValues.push(value);
            } else if (key === 'slug') {
                whereParts.push(`slug = ?`);
                bindValues.push(value);
            } else if (key === 'schema_slug') {
                whereParts.push(`schema_slug = ?`);
                bindValues.push(value);
            } else {
                whereParts.push(`json_extract(metadata, '$.fields.${key}') = ?`);
                bindValues.push(value);
            }
        }
    }

    return await queryDatasetsJson1FromDb(db, whereParts.join(' AND '), bindValues, safeLimit, safeOffset, sortMode);
}

export function buildUpdateDatasetStatement(
    db: D1Database,
    params: {
        id: string;
        siteId?: string;
        title: string;
        summary?: string;
        metadataStr: string;
        currentVersionId: string;
        status?: string;
        sortOrder?: number;
    }
): D1PreparedStatement {
    const sortVal = params.sortOrder !== undefined && Number.isFinite(params.sortOrder)
        ? Math.trunc(params.sortOrder)
        : null;
    if (params.siteId) {
        return db.prepare(`
            UPDATE datasets 
            SET title = ?, summary = ?, metadata = ?, current_version_id = ?, status = COALESCE(?, status), sort_order = COALESCE(?, sort_order), updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND site_id = ?
        `).bind(params.title, params.summary || '', params.metadataStr, params.currentVersionId, params.status ?? null, sortVal, params.id, params.siteId);
    }
    return db.prepare(`
        UPDATE datasets 
        SET title = ?, summary = ?, metadata = ?, current_version_id = ?, status = COALESCE(?, status), sort_order = COALESCE(?, sort_order), updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
    `).bind(params.title, params.summary || '', params.metadataStr, params.currentVersionId, params.status ?? null, sortVal, params.id);
}

export function buildInsertDatasetCollectionStatement(
    db: D1Database,
    params: {
        id: string;
        siteId: string;
        slug: string;
        name: string;
        schemaKey: string;
        description?: string;
    }
): D1PreparedStatement {
    return db.prepare(`
        INSERT INTO dataset_collections (id, site_id, slug, name, schema_key, description, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).bind(params.id, params.siteId, params.slug, params.name, params.schemaKey, params.description || '');
}

export function buildUpdateDatasetCollectionStatement(
    db: D1Database,
    params: {
        id: string;
        siteId: string;
        name: string;
        slug?: string;
        description?: string;
    }
): D1PreparedStatement {
    return db.prepare(`
        UPDATE dataset_collections
        SET name = ?, slug = COALESCE(?, slug), description = COALESCE(?, description), updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND site_id = ? AND deleted_at IS NULL
    `).bind(params.name, params.slug ?? null, params.description ?? null, params.id, params.siteId);
}

export function buildSoftDeleteDatasetCollectionStatement(
    db: D1Database,
    siteId: string,
    collectionId: string
): D1PreparedStatement {
    return db.prepare(`UPDATE dataset_collections SET deleted_at = CURRENT_TIMESTAMP WHERE id = ? AND site_id = ?`).bind(collectionId, siteId);
}

export function buildSoftDeleteDatasetsByCollectionStatement(
    db: D1Database,
    siteId: string,
    collectionId: string
): D1PreparedStatement {
    return db.prepare(`UPDATE datasets SET deleted_at = CURRENT_TIMESTAMP WHERE collection_id = ? AND site_id = ? AND deleted_at IS NULL`).bind(collectionId, siteId);
}

export function buildInsertDatasetStatement(
    db: D1Database,
    params: {
        id: string;
        siteId: string;
        collectionId?: string | null;
        schemaSlug: string;
        schemaId?: string;
        slug: string;
        title: string;
        summary?: string;
        metadataStr: string;
        currentVersionId: string;
        status: string;
        sortOrder?: number;
        curatorId?: string | null;
    }
): D1PreparedStatement {
    const sortVal = params.sortOrder !== undefined && Number.isFinite(params.sortOrder)
        ? Math.trunc(params.sortOrder)
        : 0;
    return db.prepare(`
        INSERT INTO datasets (id, site_id, collection_id, schema_slug, slug, title, summary, metadata, status, sort_order, curator_id, current_version_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).bind(
        params.id,
        params.siteId,
        params.collectionId || '',
        params.schemaSlug,
        params.slug,
        params.title,
        params.summary || '',
        params.metadataStr,
        params.status,
        sortVal,
        params.curatorId || null,
        params.currentVersionId
    );
}

export function buildInsertDatasetVersionStatement(
    db: D1Database,
    params: {
        id: string;
        siteId?: string;
        datasetId: string;
        versionNumber: number;
        title?: string;
        summary?: string;
        contentRaw?: string;
        metadataStr: string;
        commitMessage?: string;
        authorId?: string | null;
    }
): D1PreparedStatement {
    return buildInsertEntityVersionStatement(db, {
        id: params.id,
        siteId: params.siteId || 'site_default',
        entityType: 'dataset',
        entityId: params.datasetId,
        versionNumber: params.versionNumber,
        title: params.title || 'Dataset Item',
        summary: params.summary || '',
        contentRaw: params.contentRaw || '',
        metadataSnapshot: params.metadataStr,
        commitMessage: params.commitMessage || 'Update dataset version',
        authorId: params.authorId || null
    });
}

export function buildSoftDeleteDatasetStatement(
    db: D1Database,
    datasetId: string,
    siteId?: string
): D1PreparedStatement {
    return siteId
        ? db.prepare(`UPDATE datasets SET deleted_at = CURRENT_TIMESTAMP WHERE id = ? AND site_id = ?`).bind(datasetId, siteId)
        : db.prepare(`UPDATE datasets SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(datasetId);
}

export async function countActiveSchemaDependents(
    db: D1Database,
    siteId: string,
    schemaSlug: string
): Promise<number> {
    if (!schemaSlug) return 0;
    const [colRes, itemRes] = await db.batch([
        db.prepare(`SELECT COUNT(*) as total FROM dataset_collections WHERE site_id = ? AND schema_key = ? AND deleted_at IS NULL`).bind(siteId, schemaSlug),
        db.prepare(`SELECT COUNT(*) as total FROM datasets WHERE site_id = ? AND schema_slug = ? AND deleted_at IS NULL`).bind(siteId, schemaSlug)
    ]);
    const cols = Number((colRes?.results?.[0] as { total?: number } | undefined)?.total || 0);
    const items = Number((itemRes?.results?.[0] as { total?: number } | undefined)?.total || 0);
    return cols + items;
}
