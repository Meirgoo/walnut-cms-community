import { Hono } from 'hono';
import type { AppHonoEnv } from '../../engine';
import { DashboardPage } from '../pages/Dashboard';
import { getDashboardOverviewData, t, getUserTimezone } from '../../engine';
import { getAdminRouteContext } from './common';

const dashboardRouter = new Hono<AppHonoEnv>();

dashboardRouter.get('/', async (c) => {
    try {
        const ctx = await getAdminRouteContext(c);
        const activeSiteId = ctx.activeSite?.id || ctx.siteId || '';
        const siteName = ctx.activeSite?.name || t(ctx.locale, 'common.default_site');
        const timezone = getUserTimezone(ctx.currentUser, ctx.activeSite);

        const { stats, recentFeed, recentContent, recentSystem } = await getDashboardOverviewData(ctx.db, activeSiteId, siteName, ctx.locale, timezone);

        return c.html(
            <DashboardPage
                stats={stats}
                recentFeed={recentFeed}
                recentContent={recentContent}
                recentSystem={recentSystem}
                {...ctx}
            />
        );
    } catch (error) {
        console.error('Failed to load dashboard:', error);
        return c.text('Internal Server Error', 500);
    }
});

export { dashboardRouter };

