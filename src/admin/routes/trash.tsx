import { Hono } from 'hono';
import type { AppHonoEnv } from '../../engine';
import { getTrashListData, normalizeTrashCategory } from '../../engine';
import { TrashListPage } from '../pages/TrashList';
import {
    getAdminRouteContext,
    renderStatusBadge,
    parseNodeIds,
    runAdminPipeline,
    createDeleteRouteHandler
} from './common';

export const trashRouter = new Hono<AppHonoEnv>();

trashRouter.get('/', async (c) => {
    const ctx = await getAdminRouteContext(c);
    const activeTab = normalizeTrashCategory(c.req.query('tab'));

    const { groups, articleCount, pageCount, microCount, datasetCount } = await getTrashListData(ctx.db, ctx.activeSiteId);

    return c.html(
        <TrashListPage
            groups={groups}
            {...ctx}
            activeTab={activeTab}
            articleCount={articleCount}
            pageCount={pageCount}
            microCount={microCount}
            datasetCount={datasetCount}
        />
    );
});

const handleRestore = (action: string, getPayload: (c: any) => any) => async (c: any) => {
    try {
        await runAdminPipeline(c, action, getPayload(c));
        c.header('HX-Refresh', 'true');
        return c.body(null, 200);
    } catch (err: any) {
        return c.html(await renderStatusBadge(err.message, 'text-red-500'), 500);
    }
};

trashRouter.post('/api/restore/:id', handleRestore('CONTENT_RESTORE', c => ({ id: c.req.param('id') })));

trashRouter.post('/api/restore-version/:versionId', handleRestore('VERSION_RESTORE', c => ({ nodeId: c.req.query('node_id') || '', versionId: c.req.param('versionId') })));

async function parseTrashBatchIds(c: any): Promise<string[]> {
    const ct = c.req.header('content-type') || '';
    if (ct.includes('application/json')) {
        const body = await c.req.json().catch(() => ({})) as Record<string, any>;
        return parseNodeIds(body.ids || body.node_ids);
    }
    const formData = await c.req.parseBody().catch(() => ({})) as Record<string, any>;
    return parseNodeIds(formData.node_ids || formData.ids);
}

trashRouter.post('/api/batch-restore', async (c) => {
    const nodeIds = await parseTrashBatchIds(c);
    if (!nodeIds.length) return c.json({ success: false, error: 'No items selected' }, 400);
    if (nodeIds.length > 15) return c.json({ success: false, code: 'BATCH_LIMIT_EXCEEDED', error: 'Maximum 15 items per batch' }, 422);

    try {
        await runAdminPipeline(c, 'CONTENT_BATCH_RESTORE', { nodeIds });
        return c.json({ success: true, count: nodeIds.length });
    } catch (err: any) {
        return c.json({ error: err.message }, 500);
    }
});

trashRouter.delete('/api/hard-delete/:id', createDeleteRouteHandler('CONTENT_PURGE'));

trashRouter.delete('/api/hard-delete-version/:versionId', async (c) => {
    try {
        await runAdminPipeline(c, 'VERSION_HARD_DELETE', { versionId: c.req.param('versionId') });
        return c.body(null, 200);
    } catch {
        return c.body(null, 500);
    }
});

trashRouter.post('/api/batch-hard-delete', async (c) => {
    const nodeIds = await parseTrashBatchIds(c);
    if (!nodeIds.length) return c.json({ success: false, error: 'No items selected' }, 400);
    if (nodeIds.length > 15) return c.json({ success: false, code: 'BATCH_LIMIT_EXCEEDED', error: 'Maximum 15 items per batch' }, 422);

    try {
        await runAdminPipeline(c, 'CONTENT_BATCH_HARD_DELETE', { nodeIds });
        return c.json({ success: true, count: nodeIds.length });
    } catch (err: any) {
        return c.json({ error: err.message }, 500);
    }
});

trashRouter.post('/api/empty', async (c) => {
    const siteId = c.get('siteId') || '';
    const category = normalizeTrashCategory(c.req.query('category'));

    try {
        await runAdminPipeline(c, 'TRASH_EMPTY', { siteId, category });
        const target = `/admin/trash?tab=${category}`;
        if (c.req.header('HX-Request')) {
            c.header('HX-Redirect', target);
            return c.body(null, 200);
        }
        return c.redirect(target);
    } catch (err: any) {
        return c.html(await renderStatusBadge(err.message, 'text-red-500'), 500);
    }
});
