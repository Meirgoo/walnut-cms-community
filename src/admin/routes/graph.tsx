import { Hono } from 'hono';
import type { AppHonoEnv } from '../../engine';
import { findSiteImpactAnalysisGraph, recompileDirtySiteRoutes, isFeatureEnabled } from '../../engine';
import { AdminWikiGraphPage, WikiRelationItem, WikiNodeItem } from '../pages/AdminWikiGraph';
import { getAdminRouteContext, runAdminPipeline } from './common';

export const graphRouter = new Hono<AppHonoEnv>();

graphRouter.use('*', async (c, next) => {
    if (!isFeatureEnabled('topology', c.env)) {
        return c.notFound();
    }
    await next();
});

const handleGraphPage = async (c: any) => {
    const ctx = await getAdminRouteContext(c);
    const { nodes, relations } = await findSiteImpactAnalysisGraph(ctx.db, ctx.activeSiteId);

    const wikiNodes: WikiNodeItem[] = (nodes || []).map((n: any) => ({
        id: n.id,
        slug: n.slug,
        title: n.title,
        type: n.type,
        layer: n.layer,
        level: n.level,
        path: n.path,
        status: n.status,
        maturity: n.maturity,
        summary: n.summary,
        heat: n.heat || 0,
        is_dirty: Boolean(n.is_dirty),
        entity_type: n.entity_type || null,
        entity_id: n.entity_id || null,
        created_at: n.created_at || null
    }));

    const wikiRelations: WikiRelationItem[] = (relations || []).map((r: any) => ({
        source_id: r.source_id,
        source_title: r.source_title,
        source_slug: r.source_slug,
        source_type: r.source_type,
        target_id: r.target_id || undefined,
        target_slug: r.target_slug,
        target_title: r.target_title,
        target_type: r.target_type,
        relation_type: r.relation_type
    }));

    return c.html(
        <AdminWikiGraphPage
            nodes={wikiNodes}
            relations={wikiRelations}
            {...ctx}
        />
    );
};

graphRouter.get('/', handleGraphPage);
graphRouter.get('/wiki', handleGraphPage);
graphRouter.get('/impact', handleGraphPage);

graphRouter.post('/api/recompile', async (c) => {
    const ctx = await getAdminRouteContext(c);
    const res = await recompileDirtySiteRoutes(ctx.db, ctx.activeSiteId, 50);
    return c.json({
        success: true,
        compiledCount: res.compiledCount || 0,
        syncedCount: res.syncedCount || 0
    });
});

graphRouter.get('/api/pro-insights', async (c) => {
    const ctx = await getAdminRouteContext(c);
    try {
        const result = await runAdminPipeline<{ siteId: string }, any>(
            c,
            'TOPOLOGY_PRO_INSIGHTS',
            { siteId: ctx.activeSiteId },
            ctx.activeSiteId
        );
        return c.json(result);
    } catch {
        return c.json({ success: false, translationGaps: {}, assemblyChains: {}, routeTraffic: {}, total7dRequests: 0 });
    }
});

graphRouter.post('/api/pro-action', async (c) => {
    const ctx = await getAdminRouteContext(c);
    const body = await c.req.json().catch(() => ({})) as Record<string, any>;
    const allowedActions = new Set(['TOPOLOGY_CREATE_TRANSLATION', 'TOPOLOGY_MOUNT_NAV', 'TOPOLOGY_TRASH_ORPHAN']);
    if (!body.action || !allowedActions.has(body.action)) {
        return c.json({ success: false, error: 'Unsupported topology action' }, 400);
    }
    try {
        const result = await runAdminPipeline(
            c,
            body.action,
            { ...body, siteId: ctx.activeSiteId },
            ctx.activeSiteId
        );
        return c.json(result);
    } catch (err: any) {
        return c.json({ success: false, error: err?.message || 'Action failed' }, 403);
    }
});
