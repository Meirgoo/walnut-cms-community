import { Hono, type Context } from 'hono';
import type { AppHonoEnv, MediaAsset } from '../../engine';
import { findMediaAssetsBySite, findMediaAssetsForPicker, getAdminLocale, t } from '../../engine';
import { MediaListPage } from '../pages/MediaList';
import { getAdminRouteContext, runAdminPipeline } from './common';

const mediaRouter = new Hono<AppHonoEnv>();

mediaRouter.get('/', async (c) => {
    const ctx = await getAdminRouteContext(c);
    const siteIdFromQuery = c.req.query('site_id');
    const matchedSite = siteIdFromQuery ? ctx.sites.find(s => s.id === siteIdFromQuery) : undefined;
    if (siteIdFromQuery && !matchedSite && !ctx.isSuperAdmin) {
        return c.text('Forbidden', 403);
    }
    const activeSite = matchedSite || ctx.activeSite;
    const activeSiteId = activeSite?.id || ctx.siteId || 'site_default';

    const assets = await findMediaAssetsBySite(ctx.db, activeSiteId);

    return c.html(
        <MediaListPage
            assets={assets}
            {...ctx}
        />
    );
});

mediaRouter.get('/api/list', async (c) => {
    const db = c.env.DB;
    const siteId = c.get('siteId') || '';
    const assets = await findMediaAssetsForPicker(db, siteId, 50);
    return c.json({ success: true, assets });
});

mediaRouter.delete('/api/delete/:id', async (c) => {
    const id = c.req.param('id');
    try {
        await runAdminPipeline<{ id: string }, { success: boolean }>(c, 'MEDIA_DELETE', { id });
        return c.body(null, 200);
    } catch (err: any) {
        console.error('Delete media action error:', err);
        return c.body(null, 500);
    }
});

mediaRouter.post('/api/update/:id', async (c) => {
    const id = c.req.param('id');
    try {
        const body = await c.req.json();
        const result = await runAdminPipeline<
            { id: string; fileName?: string; title?: string; alt?: string; folder?: string; isPublic?: boolean },
            { success: boolean; asset?: MediaAsset }
        >(c, 'MEDIA_UPDATE', {
            id,
            fileName: body.file_name,
            title: body.title,
            alt: body.alt,
            folder: body.folder,
            isPublic: body.is_public !== undefined ? Boolean(body.is_public) : undefined
        });
        return c.json({ success: true, asset: result.asset });
    } catch (err: any) {
        return c.json({ success: false, error: err.message || 'Update failed' }, 400);
    }
});

mediaRouter.post('/api/upload', async (c) => {
    const ctx = await getAdminRouteContext(c);
    const reqSiteId = c.req.query('site_id');
    const targetSiteId = (ctx.isSuperAdmin && reqSiteId) ? reqSiteId : (ctx.activeSite?.id || ctx.siteId || 'site_default');

    try {
        const formData = await c.req.formData();
        const files: File[] = [];

        for (const [, val] of formData.entries()) {
            if (val instanceof File && val.size > 0) {
                files.push(val);
            }
        }

        const locale = ctx.locale;
        if (files.length === 0) {
            return c.json({ error: t(locale, 'errors.no_files') }, 400);
        }

        const uploadedAssets: MediaAsset[] = [];
        for (const file of files) {
            const asset = await runAdminPipeline<
                { file: File; siteId: string; uploaderId?: string },
                MediaAsset
            >(
                c,
                'MEDIA_UPLOAD',
                { file, siteId: targetSiteId, uploaderId: ctx.user?.id },
                targetSiteId
            );
            uploadedAssets.push(asset);
        }

        return c.json({ success: true, count: uploadedAssets.length, assets: uploadedAssets });
    } catch (err: any) {
        console.error('[MediaUpload Error]', err);
        return c.json({ error: err.message || t(ctx.locale, 'common.error') }, 500);
    }
});

mediaRouter.post('/api/batch-rename', async (c) => {
    try {
        const body = await c.req.json();
        const items = Array.isArray(body?.items) ? body.items : [];
        if (items.length === 0) return c.json({ success: true, count: 0 });
        if (items.length > 15) return c.json({ success: false, code: 'BATCH_LIMIT_EXCEEDED', error: 'Maximum 15 items per batch' }, 422);

        const result = await runAdminPipeline<
            { items: { id: string; newName: string }[] },
            { count: number; success: boolean }
        >(c, 'MEDIA_BATCH_RENAME', { items });

        return c.json(result);
    } catch (err: any) {
        return c.json({ success: false, error: err?.message || 'Batch rename failed' }, err?.message?.includes('UNAUTHORIZED') ? 403 : 400);
    }
});

export { mediaRouter };

