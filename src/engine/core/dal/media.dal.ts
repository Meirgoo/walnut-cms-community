import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import type { MediaAsset } from '../../types';
import { applyPublicAssetDomain } from '../url';

export function buildInsertMediaAssetStatement(
    db: D1Database,
    asset: {
        id: string;
        siteId: string;
        uploaderId?: string | null;
        fileName: string;
        fileSize: number;
        mimeType: string;
        r2Key: string;
        publicUrl: string;
        createdAt?: string;
    }
): D1PreparedStatement {
    const nowIso = asset.createdAt || new Date().toISOString();
    return db.prepare(`
        INSERT INTO media_assets (
            id, site_id, file_name, file_size, mime_type, r2_key, public_url, uploader_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
        asset.id,
        asset.siteId,
        asset.fileName,
        asset.fileSize,
        asset.mimeType,
        asset.r2Key,
        asset.publicUrl,
        asset.uploaderId || null,
        nowIso
    );
}

export function buildSoftDeleteMediaAssetStatement(
    db: D1Database,
    mediaId: string,
    siteId?: string
): D1PreparedStatement {
    return siteId
        ? db.prepare(`UPDATE media_assets SET deleted_at = CURRENT_TIMESTAMP WHERE id = ? AND site_id = ?`).bind(mediaId, siteId)
        : db.prepare(`UPDATE media_assets SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(mediaId);
}

export function buildRestoreMediaAssetStatement(
    db: D1Database,
    mediaId: string,
    siteId?: string
): D1PreparedStatement {
    return siteId
        ? db.prepare(`UPDATE media_assets SET deleted_at = NULL WHERE id = ? AND site_id = ?`).bind(mediaId, siteId)
        : db.prepare(`UPDATE media_assets SET deleted_at = NULL WHERE id = ?`).bind(mediaId);
}

export function buildHardDeleteMediaAssetStatement(
    db: D1Database,
    mediaId: string,
    siteId?: string
): D1PreparedStatement {
    return siteId
        ? db.prepare(`DELETE FROM media_assets WHERE id = ? AND site_id = ?`).bind(mediaId, siteId)
        : db.prepare(`DELETE FROM media_assets WHERE id = ?`).bind(mediaId);
}

export function buildRenameMediaAssetStatement(
    db: D1Database,
    mediaId: string,
    newName: string,
    siteId?: string
): D1PreparedStatement {
    return siteId
        ? db.prepare(`UPDATE media_assets SET file_name = ? WHERE id = ? AND site_id = ?`).bind(newName, mediaId, siteId)
        : db.prepare(`UPDATE media_assets SET file_name = ? WHERE id = ?`).bind(newName, mediaId);
}

export function buildUpdateMediaAssetMetadataStatement(
    db: D1Database,
    params: {
        id: string;
        siteId?: string;
        fileName: string;
        metadataStr: string;
        isPublic: number;
    }
): D1PreparedStatement {
    return params.siteId
        ? db.prepare(`UPDATE media_assets SET file_name = ?, metadata = ?, is_public = ? WHERE id = ? AND site_id = ? AND deleted_at IS NULL`).bind(params.fileName, params.metadataStr, params.isPublic, params.id, params.siteId)
        : db.prepare(`UPDATE media_assets SET file_name = ?, metadata = ?, is_public = ? WHERE id = ? AND deleted_at IS NULL`).bind(params.fileName, params.metadataStr, params.isPublic, params.id);
}

export async function findMediaAssetById(
    db: D1Database,
    mediaId: string,
    siteId?: string
): Promise<MediaAsset | null> {
    if (siteId) {
        return (await db.prepare(
            `SELECT * FROM media_assets WHERE id = ? AND site_id = ? AND deleted_at IS NULL LIMIT 1`
        ).bind(mediaId, siteId).first<MediaAsset>()) || null;
    }
    return (await db.prepare(
        `SELECT * FROM media_assets WHERE id = ? AND deleted_at IS NULL LIMIT 1`
    ).bind(mediaId).first<MediaAsset>()) || null;
}

export async function findMediaAssetByIdAnyState(
    db: D1Database,
    mediaId: string,
    siteId?: string
): Promise<MediaAsset | null> {
    if (siteId) {
        return (await db.prepare(
            `SELECT * FROM media_assets WHERE id = ? AND site_id = ? LIMIT 1`
        ).bind(mediaId, siteId).first<MediaAsset>()) || null;
    }
    return (await db.prepare(
        `SELECT * FROM media_assets WHERE id = ? LIMIT 1`
    ).bind(mediaId).first<MediaAsset>()) || null;
}

export async function findMediaAssetsBySite(
    db: D1Database,
    siteId: string
): Promise<MediaAsset[]> {
    const { results } = await db.prepare(`
        SELECT * FROM media_assets WHERE site_id = ? AND deleted_at IS NULL ORDER BY created_at DESC
    `).bind(siteId).all<MediaAsset>();
    return results || [];
}

export async function findMediaAssetsForPicker(
    db: D1Database,
    siteId: string,
    limit = 50
): Promise<Array<{ id: string; file_name: string; public_url: string; mime_type: string; created_at: string }>> {
    const { results } = await db.prepare(`
        SELECT id, file_name, public_url, mime_type, created_at 
        FROM media_assets 
        WHERE site_id = ? AND deleted_at IS NULL 
        ORDER BY created_at DESC 
        LIMIT ?
    `).bind(siteId, limit).all<{ id: string; file_name: string; public_url: string; mime_type: string; created_at: string }>();
    return results || [];
}

export async function getMediaR2Key(db: D1Database, mediaId: string): Promise<string | null> {
    const asset = await db.prepare(
        `SELECT r2_key FROM media_assets WHERE id = ? LIMIT 1`
    ).bind(mediaId).first<{ r2_key: string }>();
    return asset?.r2_key || null;
}

export async function queryPublicMediaAssets(
    db: D1Database,
    siteId: string,
    params: {
        id?: string;
        mime?: string;
        folder?: string;
        limit?: number;
        offset?: number;
        publicAssetsDomain?: string;
    } = {}
): Promise<Array<Record<string, any>>> {
    const whereParts = ['site_id = ?', 'is_public = 1', 'deleted_at IS NULL'];
    const bindVals: any[] = [siteId];

    if (params.id) {
        whereParts.push('id = ?');
        bindVals.push(String(params.id).trim());
    }
    if (params.mime) {
        whereParts.push('mime_type LIKE ?');
        bindVals.push(`${String(params.mime).trim()}%`);
    }
    if (params.folder) {
        whereParts.push(`json_extract(metadata, '$.folder') = ?`);
        bindVals.push(String(params.folder).trim());
    }

    const limit = Math.max(1, Math.min(100, Number(params.limit) || 20));
    const offset = Math.max(0, Number(params.offset) || 0);

    const { results } = await db.prepare(`
        SELECT id, file_name, file_size, mime_type, public_url, metadata, created_at
        FROM media_assets
        WHERE ${whereParts.join(' AND ')}
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?
    `).bind(...bindVals, limit, offset).all<any>();

    return (results || []).map((r) => {
        let metaObj: Record<string, any> = {};
        if (typeof r.metadata === 'string') {
            try { metaObj = JSON.parse(r.metadata) || {}; } catch {}
        } else if (r.metadata && typeof r.metadata === 'object') {
            metaObj = r.metadata;
        }
        const assetUrl = applyPublicAssetDomain(r.public_url, params.publicAssetsDomain);
        return {
            ...metaObj,
            id: r.id,
            file_name: r.file_name,
            title: metaObj.title || r.file_name,
            summary: metaObj.summary || metaObj.alt || r.file_name,
            file_size: r.file_size,
            mime_type: r.mime_type,
            public_url: assetUrl,
            url: assetUrl,
            image_url: assetUrl,
            folder: metaObj.folder || '',
            metadata: metaObj,
            created_at: r.created_at
        };
    });
}
