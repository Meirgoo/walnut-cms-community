import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';

export type VersionEntityType = 'article' | 'micro' | 'page' | 'theme' | 'dataset';

export interface EntityVersionRow {
    id: string;
    site_id: string;
    entity_type: VersionEntityType;
    entity_id: string;
    version_number: number;
    version_tag?: string | null;
    title: string;
    summary?: string | null;
    content_raw: string;
    content_rendered?: string | null;
    metadata_snapshot?: string | null;
    commit_message?: string | null;
    author_id?: string | null;
    created_at: string;
    deleted_at?: string | null;
}

export async function findLatestEntityVersionByType(
    db: D1Database,
    entityType: VersionEntityType,
    entityId: string
): Promise<EntityVersionRow | null> {
    return await db.prepare(
        `SELECT * FROM entity_versions WHERE entity_type = ? AND entity_id = ? AND deleted_at IS NULL ORDER BY version_number DESC LIMIT 1`
    ).bind(entityType, entityId).first<EntityVersionRow>() ?? null;
}

export async function findMaxEntityVersionNumberByType(
    db: D1Database,
    entityType: VersionEntityType,
    entityId: string
): Promise<number> {
    const row = await db.prepare(
        `SELECT COALESCE(MAX(version_number), 0) as max_ver FROM entity_versions WHERE entity_type = ? AND entity_id = ?`
    ).bind(entityType, entityId).first<{ max_ver: number }>();
    return Number(row?.max_ver || 0);
}

export async function findEntityVersions(
    db: D1Database,
    entityType: VersionEntityType,
    entityId: string
): Promise<EntityVersionRow[]> {
    const { results } = await db.prepare(
        `SELECT * FROM entity_versions WHERE entity_type = ? AND entity_id = ? AND deleted_at IS NULL ORDER BY version_number DESC`
    ).bind(entityType, entityId).all<EntityVersionRow>();
    return results || [];
}

export async function findEntityVersionById(
    db: D1Database,
    versionId: string,
    siteId?: string
): Promise<EntityVersionRow | null> {
    const sql = siteId
        ? `SELECT * FROM entity_versions WHERE id = ? AND site_id = ? LIMIT 1`
        : `SELECT * FROM entity_versions WHERE id = ? LIMIT 1`;
    return (siteId
        ? await db.prepare(sql).bind(versionId, siteId).first<EntityVersionRow>()
        : await db.prepare(sql).bind(versionId).first<EntityVersionRow>()) ?? null;
}

export async function findEntityVersionByIdOrNumber(
    db: D1Database,
    entityType: VersionEntityType,
    entityId: string,
    versionId?: string,
    versionNumber?: number
): Promise<EntityVersionRow | null> {
    const query = versionId
        ? `SELECT * FROM entity_versions WHERE entity_type = ? AND entity_id = ? AND id = ? LIMIT 1`
        : `SELECT * FROM entity_versions WHERE entity_type = ? AND entity_id = ? AND version_number = ? LIMIT 1`;
    return await db.prepare(query).bind(entityType, entityId, versionId ?? versionNumber).first<EntityVersionRow>() ?? null;
}

export function buildInsertEntityVersionStatement(
    db: D1Database,
    params: {
        id: string;
        siteId?: string;
        entityType: VersionEntityType;
        entityId: string;
        versionNumber: number;
        versionTag?: string | null;
        title?: string;
        summary?: string | null;
        contentRaw?: string;
        contentRendered?: string;
        metadataSnapshot?: string | null;
        commitMessage?: string | null;
        authorId?: string | null;
        createdAt?: string;
        ignoreConflict?: boolean;
        upsertContentOnConflict?: boolean;
    }
): D1PreparedStatement {
    const conflictClause = params.upsertContentOnConflict
        ? ` ON CONFLICT(id) DO UPDATE SET content_raw = excluded.content_raw`
        : (params.ignoreConflict ? ` ON CONFLICT(id) DO NOTHING` : '');
    const createdExpr = params.createdAt ? '?' : 'CURRENT_TIMESTAMP';
    const sql = `
        INSERT INTO entity_versions (
            id, site_id, entity_type, entity_id, version_number, version_tag,
            title, summary, content_raw, content_rendered, metadata_snapshot, commit_message, author_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${createdExpr})${conflictClause}
    `;
    const vals: any[] = [
        params.id,
        params.siteId || 'site_default',
        params.entityType,
        params.entityId,
        params.versionNumber || 1,
        params.versionTag ?? null,
        params.title ?? '',
        params.summary ?? '',
        params.contentRaw ?? '',
        params.contentRendered ?? '',
        params.metadataSnapshot ?? '{}',
        params.commitMessage ?? null,
        params.authorId ?? null
    ];
    if (params.createdAt) vals.push(params.createdAt);
    return db.prepare(sql).bind(...vals);
}

export function buildUpdateEntityVersionSnapshotStatement(
    db: D1Database,
    params: {
        versionId: string;
        title: string;
        summary?: string | null;
        metadataSnapshot: string;
    }
): D1PreparedStatement {
    return db.prepare(
        `UPDATE entity_versions SET title = ?, summary = ?, metadata_snapshot = ? WHERE id = ?`
    ).bind(params.title, params.summary ?? '', params.metadataSnapshot, params.versionId);
}

export function buildAppendEntityVersionContentStatement(
    db: D1Database,
    params: {
        versionId: string;
        entityType: VersionEntityType;
        entityId: string;
        chunkText: string;
        title?: string | null;
        summary?: string | null;
        metadataSnapshot?: string | null;
    }
): D1PreparedStatement {
    if (params.title === undefined && params.summary === undefined && params.metadataSnapshot === undefined) {
        return db.prepare(
            `UPDATE entity_versions SET content_raw = COALESCE(content_raw, '') || ? WHERE id = ? AND entity_type = ? AND entity_id = ?`
        ).bind(params.chunkText, params.versionId, params.entityType, params.entityId);
    }
    return db.prepare(
        `UPDATE entity_versions SET content_raw = COALESCE(content_raw, '') || ?, title = COALESCE(?, title), summary = COALESCE(?, summary), metadata_snapshot = COALESCE(?, metadata_snapshot) WHERE id = ? AND entity_type = ? AND entity_id = ?`
    ).bind(
        params.chunkText,
        params.title ?? null,
        params.summary ?? null,
        params.metadataSnapshot ?? null,
        params.versionId,
        params.entityType,
        params.entityId
    );
}
