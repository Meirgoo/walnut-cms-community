import { Hono } from 'hono';
import type { AppHonoEnv } from '../../engine';
import { DashboardPage } from '../pages/Dashboard';
import { getDashboardOverviewData, findBrokenPageBlocksBySite, getStorageUsageSummary, recompileDirtySiteRoutes, t, getUserTimezone } from '../../engine';
import { getAdminRouteContext } from './common';

const dashboardRouter = new Hono<AppHonoEnv>();

dashboardRouter.get('/', async (c) => {
    try {
        const ctx = await getAdminRouteContext(c);
        const activeSiteId = ctx.activeSite?.id || ctx.siteId || '';
        const siteName = ctx.activeSite?.name || t(ctx.locale, 'common.default_site');
        const timezone = getUserTimezone(ctx.currentUser, ctx.activeSite);
        const hasR2Bucket = Boolean((c.env as any)?.BUCKET);

        const [{ stats, recentFeed, recentContent, recentSystem, actionAlerts }, brokenDiagnostic] = await Promise.all([
            getDashboardOverviewData(ctx.db, activeSiteId, siteName, ctx.locale, timezone, hasR2Bucket),
            findBrokenPageBlocksBySite(ctx.db, activeSiteId)
        ]);

        return c.html(
            <DashboardPage
                stats={stats}
                recentFeed={recentFeed}
                recentContent={recentContent}
                recentSystem={recentSystem}
                actionAlerts={actionAlerts}
                brokenDiagnostic={brokenDiagnostic}
                hasR2Bucket={hasR2Bucket}
                {...ctx}
            />
        );
    } catch (error) {
        console.error('Failed to load dashboard:', error);
        return c.text('Internal Server Error', 500);
    }
});

dashboardRouter.post('/api/rebuild-dirty-routes', async (c) => {
    try {
        const ctx = await getAdminRouteContext(c);
        const activeSiteId = ctx.activeSite?.id || ctx.siteId || 'site_default';
        const res = await recompileDirtySiteRoutes(ctx.db, activeSiteId, 50);
        return c.json({
            success: true,
            syncedCount: res.syncedCount,
            compiledCount: res.compiledCount,
            message: t(ctx.locale, 'dashboard.rebuild_success', { count: res.compiledCount })
        });
    } catch (error: any) {
        return c.json({ success: false, error: error?.message || 'Rebuild failed' }, 500);
    }
});

dashboardRouter.get('/api/storage-usage', async (c) => {
    const user = c.get('user');
    if (!user || user.global_role !== 'superadmin') {
        return c.json({ success: false, error: 'Forbidden' }, 403);
    }
    const summary = await getStorageUsageSummary(c.env.DB);
    return c.json({ success: true, data: summary });
});

export { dashboardRouter };

