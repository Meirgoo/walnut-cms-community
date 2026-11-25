import { nanoId } from '../kernel';
import {
    type IPluginEngine,
    type HookContext,
    type MediaAsset
} from '../types';
import {
    markRoutesDirtyByDependency,
    purgeEdgeAndZoneCache,
    invalidateQueryCache,
    buildInsertMediaAssetStatement,
    buildSoftDeleteMediaAssetStatement,
    buildRestoreMediaAssetStatement,
    buildHardDeleteMediaAssetStatement,
    buildRenameMediaAssetStatement,
    buildUpdateMediaAssetMetadataStatement,
    findMediaAssetById,
    findMediaAssetByIdAnyState,
    getMediaR2Key
} from '../core/dal';
import { assertSiteAdmin } from './common.helper';

export interface UploadMediaActionParams {
    file: File;
    siteId: string;
    uploaderId?: string;
    publicAssetsDomain?: string;
}

export interface BatchRenameItem {
    id: string;
    newName: string;
}

export function registerMediaServices(engine: IPluginEngine): void {
    engine.registerService<UploadMediaActionParams, MediaAsset>('MEDIA_UPLOAD', async (ctx) => {
        const params = ctx.data;
        await assertSiteAdmin(ctx.dal, params.siteId || ctx.siteId || 'site_default', ctx.user);
        const bucket = ctx.dal.bucket;
        if (!bucket) {
            throw new Error('R2 Bucket not configured');
        }

        const uploaderId = params.uploaderId || ctx.user?.id || 'admin';
        const originalName = params.file.name || 'image.png';
        const ext = originalName.split('.').pop()?.toLowerCase() || 'png';
        const nanoid = nanoId();
        const year = new Date().getFullYear();
        const month = String(new Date().getMonth() + 1).padStart(2, '0');

        const r2Path = `content/sites/${params.siteId}/${year}/${month}/${nanoid}.${ext}`;
        const fileBuffer = await params.file.arrayBuffer();

        await bucket.put(r2Path, fileBuffer, {
            httpMetadata: { contentType: params.file.type }
        });

        const publicUrl = `/${r2Path}`;
        const mediaId = `media_${nanoid}`;
        const nowIso = new Date().toISOString();

        const assetRecord: MediaAsset = {
            id: mediaId,
            site_id: params.siteId,
            file_name: originalName,
            file_size: params.file.size,
            mime_type: params.file.type,
            r2_key: r2Path,
            public_url: publicUrl,
            is_public: 1,
            uploader_id: uploaderId,
            created_at: nowIso
        };

        await ctx.dal.batch([
            buildInsertMediaAssetStatement(ctx.dal.db, {
                id: mediaId,
                siteId: params.siteId,
                fileName: originalName,
                fileSize: params.file.size,
                mimeType: params.file.type,
                r2Key: r2Path,
                publicUrl,
                uploaderId,
                createdAt: nowIso
            })
        ]);

        return assetRecord;
    });

    const runMediaLifecycleAction = async (
        ctx: HookContext<{ id: string; siteId?: string }, { success: boolean; siteId?: string; r2Key?: string; publicUrl?: string }>,
        mode: 'delete' | 'restore' | 'purge'
    ) => {
        const siteId = ctx.data?.siteId || ctx.siteId || 'site_default';
        await assertSiteAdmin(ctx.dal, siteId, ctx.user);
        const mediaId = ctx.data.id;
        const isSuper = ctx.user?.global_role === 'superadmin';
        const scopeSiteId = isSuper ? undefined : siteId;
        const asset = mode === 'delete'
            ? await findMediaAssetById(ctx.dal.db, mediaId, scopeSiteId)
            : await findMediaAssetByIdAnyState(ctx.dal.db, mediaId, scopeSiteId);
        if (!asset) {
            throw new Error('FORBIDDEN_CROSS_SITE_ACCESS');
        }
        let r2Key = asset.r2_key || undefined;
        if (mode === 'purge') {
            r2Key = asset.r2_key || await getMediaR2Key(ctx.dal.db, mediaId) || undefined;
            if (r2Key && ctx.dal.bucket) {
                try {
                    await ctx.dal.bucket.delete(r2Key);
                } catch {}
            }
        }
        const stmt = mode === 'delete'
            ? buildSoftDeleteMediaAssetStatement(ctx.dal.db, mediaId, scopeSiteId)
            : (mode === 'restore'
                ? buildRestoreMediaAssetStatement(ctx.dal.db, mediaId, scopeSiteId)
                : buildHardDeleteMediaAssetStatement(ctx.dal.db, mediaId, scopeSiteId));
        await ctx.dal.batch([stmt]);
        return {
            success: true,
            siteId: asset.site_id,
            r2Key,
            publicUrl: asset.public_url || undefined
        };
    };

    engine.registerService<{ id: string; siteId?: string }, { success: boolean; siteId?: string; r2Key?: string; publicUrl?: string }>(
        'MEDIA_DELETE',
        (ctx) => runMediaLifecycleAction(ctx, 'delete')
    );
    engine.registerService<{ id: string; siteId?: string }, { success: boolean; siteId?: string; r2Key?: string; publicUrl?: string }>(
        'MEDIA_RESTORE',
        (ctx) => runMediaLifecycleAction(ctx, 'restore')
    );
    engine.registerService<{ id: string; siteId?: string }, { success: boolean; siteId?: string; r2Key?: string; publicUrl?: string }>(
        'MEDIA_PURGE',
        (ctx) => runMediaLifecycleAction(ctx, 'purge')
    );

    engine.registerService<{ items: BatchRenameItem[] }, { count: number; success: boolean }>(
        'MEDIA_BATCH_RENAME',
        async (ctx) => {
            const siteId = ctx.siteId || 'site_default';
            await assertSiteAdmin(ctx.dal, siteId, ctx.user);
            const isSuper = ctx.user?.global_role === 'superadmin';
            const items = ctx.data.items || [];
            if (items.length === 0) return { success: true, count: 0 };
            if (items.length > 15) throw new Error('BATCH_LIMIT_EXCEEDED');

            const updates = items
                .filter(i => i.id && i.newName && i.newName.trim())
                .map(i => ({ id: i.id, newName: i.newName.trim() }));

            const statements = updates.map(item =>
                buildRenameMediaAssetStatement(ctx.dal.db, item.id, item.newName, isSuper ? undefined : siteId)
            );

            if (statements.length > 0) {
                await ctx.dal.batch(statements);
            }

            return { success: true, count: updates.length };
        }
    );

    engine.tapBefore('MEDIA_UPDATE', async (ctx) => {
        await assertSiteAdmin(ctx.dal, ctx.siteId || 'site_default', ctx.user);
    });

    engine.registerService<
        {
            id: string;
            fileName?: string;
            title?: string;
            alt?: string;
            folder?: string;
            isPublic?: boolean;
        },
        { success: boolean; asset?: MediaAsset }
    >('MEDIA_UPDATE', async (ctx) => {
        const siteId = ctx.siteId || 'site_default';
        const mediaId = ctx.data.id;
        const existing = await findMediaAssetById(ctx.dal.db, mediaId);
        if (!existing) throw new Error('Media asset not found');
        if (existing.site_id !== siteId && ctx.user?.global_role !== 'superadmin') {
            throw new Error('FORBIDDEN_CROSS_SITE_ACCESS');
        }

        let prevMeta: Record<string, any> = {};
        try {
            prevMeta = existing.metadata ? JSON.parse(String(existing.metadata)) : {};
        } catch {}

        const nextMeta: Record<string, any> = {
            ...prevMeta,
            ...(ctx.data.title !== undefined ? { title: String(ctx.data.title).trim() } : {}),
            ...(ctx.data.alt !== undefined ? { alt: String(ctx.data.alt).trim() } : {}),
            ...(ctx.data.folder !== undefined ? { folder: String(ctx.data.folder).trim() } : {})
        };

        const nextFileName = ctx.data.fileName !== undefined && ctx.data.fileName.trim()
            ? ctx.data.fileName.trim()
            : existing.file_name;
        const nextIsPublic = ctx.data.isPublic !== undefined ? (ctx.data.isPublic ? 1 : 0) : ((existing as any).is_public ?? 1);

        await ctx.dal.batch([
            buildUpdateMediaAssetMetadataStatement(ctx.dal.db, {
                id: mediaId,
                fileName: nextFileName,
                metadataStr: JSON.stringify(nextMeta),
                isPublic: nextIsPublic
            })
        ]);

        const updated = await findMediaAssetById(ctx.dal.db, mediaId);
        return { success: true, asset: updated || undefined };
    });

    const markMediaDepDirty = async (ctx: HookContext<any, any>) => {
        const assetObj = ctx.result?.asset || ctx.result;
        const resolvedSiteId = assetObj?.site_id || ctx.result?.siteId || ctx.data?.siteId || ctx.siteId || 'site_default';
        invalidateQueryCache(resolvedSiteId);
        await markRoutesDirtyByDependency(ctx.dal.db, resolvedSiteId, ['media:*'], []);

        const mediaPaths = new Set<string>();
        const addUrlOrKey = (raw?: string | null) => {
            const v = String(raw || '').trim();
            if (!v) return;
            if (v.startsWith('http://') || v.startsWith('https://')) {
                try {
                    mediaPaths.add(new URL(v).pathname);
                } catch {}
                return;
            }
            mediaPaths.add(v.startsWith('/') ? v : `/${v}`);
        };
        addUrlOrKey(assetObj?.r2_key);
        addUrlOrKey(assetObj?.r2Key);
        addUrlOrKey(assetObj?.public_url);
        addUrlOrKey(assetObj?.publicUrl);
        if (mediaPaths.size > 0) {
            await purgeEdgeAndZoneCache(ctx.dal.db, resolvedSiteId, Array.from(mediaPaths));
        }
    };
    for (const mediaAct of ['MEDIA_UPLOAD', 'MEDIA_UPDATE', 'MEDIA_DELETE', 'MEDIA_RESTORE', 'MEDIA_PURGE', 'MEDIA_BATCH_RENAME', 'MEDIA_BATCH_DELETE']) {
        engine.tapAfter(mediaAct, markMediaDepDirty);
    }
}
