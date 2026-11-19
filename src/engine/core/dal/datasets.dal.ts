import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import type { Dataset } from '../../types';
import { findPublishedTheme } from './themes.dal';
import { parseJson } from '../utils';

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
    const theme = await findPublishedTheme(db, siteId);
    if (!theme || !theme.metadata) return null;
    const schemas: any[] = theme.metadata.schemas || theme.metadata.schemaNodes || [];
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
    id: string
): Promise<Dataset | null> {
    return (await db.prepare(
        `SELECT * FROM datasets WHERE id = ? AND deleted_at IS NULL LIMIT 1`
    ).bind(id).first<Dataset>()) || null;
}

export async function findLatestDatasetVersionNumber(
    db: D1Database,
    datasetId: string
): Promise<number | null> {
    const res = await db.prepare(`
        SELECT MAX(version_number) as version_number FROM dataset_versions WHERE dataset_id = ?
    `).bind(datasetId).first<{ version_number: number | null }>();
    return res?.version_number ?? null;
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

export async function findDatasetsListBundle(
    db: D1Database,
    siteId: string
): Promise<{ datasets: Dataset[]; schemas: ThemeSchemaItem[]; sites: any[] }> {
    const [dsRes, themeRes, sitesRes] = await db.batch([
        db.prepare(`SELECT * FROM datasets WHERE site_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC`).bind(siteId),
        db.prepare(`
            SELECT t.metadata FROM themes t
            LEFT JOIN sites s ON s.id = ?
            WHERE t.deleted_at IS NULL AND (t.site_id = ? OR t.id = s.theme_id OR t.slug = s.theme_id OR t.site_id = 'site_default')
            ORDER BY CASE WHEN t.site_id = ? AND t.is_active = 1 THEN 1 WHEN t.id = s.theme_id OR t.slug = s.theme_id THEN 2 WHEN t.site_id = ? THEN 3 ELSE 4 END ASC, t.updated_at DESC
            LIMIT 1
        `).bind(siteId, siteId, siteId, siteId),
        db.prepare(`SELECT * FROM sites WHERE status = 'active' ORDER BY created_at ASC`)
    ]);
    const datasets = (dsRes.results || []) as Dataset[];
    const themeRow = (themeRes.results?.[0] as any) || null;
    let schemas: ThemeSchemaItem[] = [];
    if (themeRow?.metadata) {
        try {
            const meta = typeof themeRow.metadata === 'string' ? JSON.parse(themeRow.metadata) : themeRow.metadata;
            const rawSchemas: any[] = meta?.schemas || meta?.schemaNodes || [];
            schemas = rawSchemas.map((s: any) => ({
                id: s.id || `schema_${s.slug || s.type}`,
                site_id: siteId,
                slug: s.slug || s.type,
                title: s.name || s.title || s.slug,
                summary: s.description || s.summary || '',
                metadata: s,
                fields: extractSchemaFields(s)
            }));
        } catch {}
    }
    return { datasets, schemas, sites: sitesRes.results || [] };
}

export async function findSchemasBySite(
    db: D1Database,
    siteId: string
): Promise<ThemeSchemaItem[]> {
    const theme = await findPublishedTheme(db, siteId);
    if (!theme || !theme.metadata) return [];
    const schemas: any[] = theme.metadata.schemas || theme.metadata.schemaNodes || [];
    return schemas.map((s: any) => ({
        id: s.id || `schema_${s.slug || s.type}`,
        site_id: siteId,
        slug: s.slug || s.type,
        title: s.name || s.title || s.slug,
        summary: s.description || s.summary || '',
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
    offset: number
): Promise<{ items: Dataset[]; total: number }> {
    const countRow = await db.prepare(`SELECT count(*) as total FROM datasets WHERE ${whereSql}`).bind(...bindValues).first<{ total: number }>();
    const total = countRow?.total || 0;

    const querySql = `
        SELECT id, site_id, schema_slug, slug, title, summary, metadata, status, updated_at, created_at
        FROM datasets
        WHERE ${whereSql}
        ORDER BY updated_at DESC
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
    onlyPublished = false
): Promise<{ items: Dataset[]; total: number }> {
    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 50));
    const safeOffset = Math.max(0, Number(offset) || 0);
    const whereParts: string[] = ["site_id = ?", "deleted_at IS NULL"];
    const bindValues: any[] = [siteId];

    if (onlyPublished) {
        whereParts.push("status = 'published'");
    }

    if (schemaSlug) {
        whereParts.push("schema_slug = ?");
        bindValues.push(schemaSlug);
    }

    if (filters) {
        for (const [key, value] of Object.entries(filters)) {
            if (!/^[a-zA-Z0-9_]{1,64}$/.test(key)) {
                throw new Error(`SECURITY_INVALID_FILTER_KEY: Illegal dataset filter field name "${key}"`);
            }
            if (key === 'id') {
                whereParts.push(`id = ?`);
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

    return await queryDatasetsJson1FromDb(db, whereParts.join(' AND '), bindValues, safeLimit, safeOffset);
}

export function buildUpdateDatasetStatement(
    db: D1Database,
    params: {
        id: string;
        title: string;
        summary?: string;
        metadataStr: string;
        currentVersionId: string;
        status?: string;
    }
): D1PreparedStatement {
    return db.prepare(`
        UPDATE datasets 
        SET title = ?, summary = ?, metadata = ?, current_version_id = ?, status = COALESCE(?, status), updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
    `).bind(params.title, params.summary || '', params.metadataStr, params.currentVersionId, params.status ?? null, params.id);
}

export function buildInsertDatasetStatement(
    db: D1Database,
    params: {
        id: string;
        siteId: string;
        schemaSlug: string;
        schemaId?: string;
        slug: string;
        title: string;
        summary?: string;
        metadataStr: string;
        currentVersionId: string;
        status: string;
        curatorId?: string | null;
    }
): D1PreparedStatement {
    return db.prepare(`
        INSERT INTO datasets (id, site_id, schema_slug, slug, title, summary, metadata, status, curator_id, current_version_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).bind(
        params.id,
        params.siteId,
        params.schemaSlug,
        params.slug,
        params.title,
        params.summary || '',
        params.metadataStr,
        params.status,
        params.curatorId || null,
        params.currentVersionId
    );
}

export function buildInsertDatasetVersionStatement(
    db: D1Database,
    params: {
        id: string;
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
    return db.prepare(`
        INSERT INTO dataset_versions (id, dataset_id, version_number, title, summary, metadata_snapshot, commit_message, author_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).bind(
        params.id,
        params.datasetId,
        params.versionNumber,
        params.title || 'Dataset Item',
        params.summary || '',
        params.metadataStr,
        params.commitMessage || 'Update dataset version',
        params.authorId || null
    );
}

export function buildSoftDeleteDatasetStatement(
    db: D1Database,
    datasetId: string
): D1PreparedStatement {
    return db.prepare(`UPDATE datasets SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(datasetId);
}
