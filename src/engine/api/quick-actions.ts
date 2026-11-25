import { Hono } from 'hono';
import type { AppHonoEnv, Site } from '../types';
import { resolveCurrentUser, getSessionUserId, isLocalDevCFAccessBypassEnabled } from '../core/auth';
import { createHookContext, FEATURE_FLAGS, isFeatureEnabled } from '../kernel';
import { resolveSiteWithMemoryCache, findSiteById, resolveSiteBrandInfo } from '../core/dal';
import { findSiteMemberRole } from '../core/dal';
import { findDatasetById, searchQuickActionNodes, markSiteRoutesDirty, recompileDirtySiteRoutes, countFailedTasks, findQuickActionStateBatch } from '../core/dal';
import { t as translateLocale, loadAdminLocales, getAdminI18nSlice } from '../core/i18n';
import { DEFAULT_DEV_HOST } from '../core/url';
import { isPreviewRequest, verifySameOriginRequest, getCookieValue, isSiteAdminUser, parseJson } from '../core/utils';

export const quickActionsRouter = new Hono<AppHonoEnv>();

quickActionsRouter.use('*', async (c, next) => {
    const method = c.req.method.toUpperCase();
    if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(method)) {
        const check = verifySameOriginRequest(c, DEFAULT_DEV_HOST);
        if (!check.valid) {
            return c.json({ error: `CSRF Blocked: ${check.error?.replace('Forbidden: ', '')}`, code: 'CSRF_BLOCKED' }, 403);
        }
    }
    await next();
});

async function assertAuthorizedAdmin(c: any) {
    const user = await resolveCurrentUser(c);
    return isSiteAdminUser(user) ? user : null;
}

async function resolveScopedSiteId(c: any, user: any, requestedSiteId?: string | null): Promise<string | null> {
    const baseSiteId = c.get('siteId') || 'site_default';
    const targetSiteId = (requestedSiteId || '').trim() || baseSiteId;
    if (targetSiteId === baseSiteId || user?.global_role === 'superadmin') {
        return targetSiteId;
    }
    const db = c.env?.DB;
    if (!db) return null;
    const role = await findSiteMemberRole(db, targetSiteId, user.id);
    return role === 'admin' ? targetSiteId : null;
}

let cachedCmdAliasMap: Record<string, string> | null = null;
function getCachedCmdAliasMap(env?: any): Record<string, string> {
    if (!cachedCmdAliasMap) {
        cachedCmdAliasMap = {
            '/micro': `${translateLocale('zh-CN', 'quick_actions.record_micro')} ${translateLocale('en-US', 'quick_actions.record_micro')} micro`,
            '/new-article': `${translateLocale('zh-CN', 'quick_actions.cmd_new_article_label')} ${translateLocale('en-US', 'quick_actions.cmd_new_article_label')}`,
            '/new-page': `${translateLocale('zh-CN', 'quick_actions.cmd_new_page_label')} ${translateLocale('en-US', 'quick_actions.cmd_new_page_label')}`,
            '/upload': `${translateLocale('zh-CN', 'quick_actions.cmd_upload_label')} ${translateLocale('en-US', 'quick_actions.cmd_upload_label')}`,
            '/edit': `${translateLocale('zh-CN', 'quick_actions.jump_edit')} ${translateLocale('en-US', 'quick_actions.jump_edit')}`,
            '/purge-current-cache': `${translateLocale('zh-CN', 'quick_actions.cmd_purge_current_label')} ${translateLocale('en-US', 'quick_actions.cmd_purge_current_label')}`,
            '/copy-link': `${translateLocale('zh-CN', 'quick_actions.cmd_copy_link_label')} ${translateLocale('en-US', 'quick_actions.cmd_copy_link_label')}`,
            '/admin': `${translateLocale('zh-CN', 'quick_actions.nav_admin')} ${translateLocale('en-US', 'quick_actions.nav_admin')}`,
            '/articles': `${translateLocale('zh-CN', 'quick_actions.nav_articles')} ${translateLocale('en-US', 'quick_actions.nav_articles')}`,
            '/pages': `${translateLocale('zh-CN', 'quick_actions.cmd_pages_label')} ${translateLocale('en-US', 'quick_actions.cmd_pages_label')}`,
            '/datasets': `${translateLocale('zh-CN', 'quick_actions.cmd_datasets_label')} ${translateLocale('en-US', 'quick_actions.cmd_datasets_label')}`,
            '/themes': `${translateLocale('zh-CN', 'quick_actions.cmd_themes_label')} ${translateLocale('en-US', 'quick_actions.cmd_themes_label')}`,
            '/tasks': `${translateLocale('zh-CN', 'quick_actions.cmd_tasks_label')} ${translateLocale('en-US', 'quick_actions.cmd_tasks_label')}`,
            '/webhooks': `${translateLocale('zh-CN', 'quick_actions.cmd_webhooks_label')} ${translateLocale('en-US', 'quick_actions.cmd_webhooks_label')}`,
            '/settings': `${translateLocale('zh-CN', 'quick_actions.nav_settings')} ${translateLocale('en-US', 'quick_actions.nav_settings')}`,
            '/profile': `${translateLocale('zh-CN', 'quick_actions.nav_users')} ${translateLocale('en-US', 'quick_actions.nav_users')}`,
            '/purge-cache': `${translateLocale('zh-CN', 'quick_actions.cmd_purge_cache_label')} ${translateLocale('en-US', 'quick_actions.cmd_purge_cache_label')}`,
            '/export': `${translateLocale('zh-CN', 'quick_actions.cmd_export_label')} ${translateLocale('en-US', 'quick_actions.cmd_export_label')}`,
            '/theme': `${translateLocale('zh-CN', 'quick_actions.cmd_theme_toggle_label')} ${translateLocale('en-US', 'quick_actions.cmd_theme_toggle_label')} dark light`,
            '/backup': `${translateLocale('zh-CN', 'quick_actions.cmd_d1_export_label')} ${translateLocale('en-US', 'quick_actions.cmd_d1_export_label')}`,
            '/audit': `${translateLocale('zh-CN', 'quick_actions.cmd_audit_label')} ${translateLocale('en-US', 'quick_actions.cmd_audit_label')}`
        };
    }
    const out: Record<string, string> = { ...cachedCmdAliasMap };
    if (isFeatureEnabled('topology', env)) {
        out['/topology'] = `${translateLocale('zh-CN', 'quick_actions.cmd_topology_label')} ${translateLocale('en-US', 'quick_actions.cmd_topology_label')} graph wiki`;
    }
    if (isFeatureEnabled('bulkLanding', env)) {
        out['/bulk-landing'] = `${translateLocale('zh-CN', 'quick_actions.cmd_bulk_landing_label')} ${translateLocale('en-US', 'quick_actions.cmd_bulk_landing_label')}`;
    }
    return out;
}

const failedTasksCache = new Map<string, { count: number; expiresAt: number }>();

// Short-circuit anonymous requests with zero D1 queries and reuse short TTL caches for admins to stay within the Workers Free 10ms CPU budget.
quickActionsRouter.get('/state', async (c) => {
    if (isPreviewRequest(c)) {
        return c.json({ authenticated: false });
    }

    const cookieHeader = c.req.header('cookie') || '';
    const sessionToken = getCookieValue(cookieHeader, 'edge_session');
    const hasSession = Boolean(sessionToken && sessionToken.length >= 16);
    const hasCfAccess = Boolean(((c.env as any)?.CF_ACCESS_TEAM_NAME && (c.req.header('cf-access-jwt-assertion') || c.req.header('Cf-Access-Jwt-Assertion'))) || isLocalDevCFAccessBypassEnabled(c));
    const reqHost = (c.get('host') || c.req.header('host') || '').toLowerCase();
    const isLocalDevProbe = (c.env as any)?.ENVIRONMENT !== 'production' && (reqHost.startsWith('localhost') || reqHost.startsWith('127.0.0.1'));
    const hasDevAuth = isLocalDevProbe && (c.req.header('X-Edge-Dev-Auth') === 'admin' || c.req.query('__edge_dev_auth') === 'admin');
    if (!hasSession && !hasCfAccess && !hasDevAuth) {
        return c.json({ authenticated: false });
    }

    const db = c.env.DB;
    const host = c.get('host') || c.req.header('host') || DEFAULT_DEV_HOST;
    let site: Site | null = (c.get('site' as any) as Site | undefined) || null;
    if (!site && db) {
        try {
            const rawSiteCookie = getCookieValue(cookieHeader, 'edge_active_site');
            const activeSiteId = c.get('siteId') || (rawSiteCookie ? decodeURIComponent(rawSiteCookie) : '');
            if (activeSiteId) {
                site = await findSiteById(db, activeSiteId);
            }
            if (!site) {
                site = await resolveSiteWithMemoryCache(db, host);
            }
        } catch {}
    }

    const targetSiteId = site?.id || 'site_default';
    let user: any = null;
    let failedTasksCount = 0;

    if (hasSession && !hasCfAccess && db) {
        const sessionUid = await getSessionUserId(c);
        if (sessionUid) {
            const batch = await findQuickActionStateBatch(db, sessionUid, targetSiteId);
            if (batch.user && (batch.user.global_role === 'superadmin' || batch.siteRole === 'admin')) {
                user = { ...batch.user, site_role: batch.siteRole };
                failedTasksCount = batch.failedTasksCount;
                failedTasksCache.set(targetSiteId, { count: failedTasksCount, expiresAt: Date.now() + 10_000 });
            }
        }
    }

    if (!user) {
        user = await assertAuthorizedAdmin(c);
        if (!user) {
            return c.json({ authenticated: false });
        }
        const now = Date.now();
        const cachedFailed = failedTasksCache.get(targetSiteId);
        if (cachedFailed && cachedFailed.expiresAt > now) {
            failedTasksCount = cachedFailed.count;
        } else if (db) {
            failedTasksCount = await countFailedTasks(db, targetSiteId);
            failedTasksCache.set(targetSiteId, { count: failedTasksCount, expiresAt: now + 10_000 });
        }
    }

    const siteSettings = parseJson<Record<string, any>>(site?.settings, {});

    const userMeta = parseJson<Record<string, any>>(user?.metadata, {});
    const shortcut = userMeta.quick_action_shortcut || siteSettings.quick_action_shortcut || 'alt+k,cmd+k';
    const pluginEngine = c.get('pluginEngine');
    const isBuildCommunity = typeof __BUILD_EDITION__ !== 'undefined' && __BUILD_EDITION__ === 'community';
    const hasCommercialExt = !isBuildCommunity && Boolean(pluginEngine?.hasCommercialPlugins());
    const envAny = (c.env || {}) as Record<string, any>;
    const licenseKey = site?.license_key || envAny.WALNUT_LICENSE_KEY || envAny.LICENSE_KEY;
    const isLicensed = hasCommercialExt && Boolean(licenseKey);
    const licenseTier = isLicensed ? ((c.get('licenseResult' as any) as any)?.tier || 'agency') : 'community';
    const rawCommercialCommands = (isLicensed && pluginEngine) ? pluginEngine.getQuickActions(licenseTier) : [];
    const commercialCommands = rawCommercialCommands.filter((cmd: any) => {
        if (cmd.id === 'bulk-landing' && !isFeatureEnabled('bulkLanding', c.env)) return false;
        if (cmd.id === 'topology' && !isFeatureEnabled('topology', c.env)) return false;
        if (cmd.id === 'traffic-analytics' && !isFeatureEnabled('trafficAnalytics', c.env)) return false;
        return true;
    });

    await loadAdminLocales(c.env);
    const reqLocale = (c.get('locale') as string) || 'zh-CN';
    const qaSlice = getAdminI18nSlice(reqLocale, 'quick_actions');
    const navSlice = getAdminI18nSlice(reqLocale, 'nav');
    const siteBrand = site ? resolveSiteBrandInfo(site) : null;
    const brandName = siteBrand?.hasStickyWhitelabel ? (siteBrand.systemTitle || siteBrand.effectiveWhitelabel?.brand_name) : '';
    let i18nQuick: Record<string, any> = {
        quick_actions: qaSlice.quick_actions || {},
        nav: navSlice.nav || {}
    };
    if (brandName) {
        try {
            i18nQuick = JSON.parse(JSON.stringify(i18nQuick).replace(/Walnut Edge CMS|Walnut CMS|Walnut/g, brandName));
        } catch {}
    }

    return c.json({
        authenticated: true,
        isCommercial: isLicensed,
        user: {
            id: user.id,
            username: user.username,
            email: user.email,
            role: user.site_role || user.global_role
        },
        siteId: targetSiteId,
        shortcut,
        failedTasksCount,
        i18n: i18nQuick,
        bilingual_aliases: getCachedCmdAliasMap(c.env),
        commercial_commands: commercialCommands
    });
});

quickActionsRouter.get('/search', async (c) => {
    const user = await assertAuthorizedAdmin(c);
    if (!user) {
        return c.json({ error: 'Unauthorized' }, 403);
    }
    const db = c.env.DB;
    if (!db) {
        return c.json({ success: true, items: [] });
    }
    const q = (c.req.query('q') || '').trim();
    if (!q) {
        return c.json({ success: true, items: [] });
    }
    const siteId = await resolveScopedSiteId(c, user, c.req.query('siteId'));
    if (!siteId) {
        return c.json({ error: 'Forbidden' }, 403);
    }
    const items = await searchQuickActionNodes(db, siteId, q, 12);
    return c.json({ success: true, items });
});

quickActionsRouter.post('/purge-cache', async (c) => {
    const user = await assertAuthorizedAdmin(c);
    if (!user) {
        return c.json({ error: 'Unauthorized' }, 403);
    }
    const body = await c.req.json().catch(() => ({})) as { path?: string; siteId?: string };
    const siteId = await resolveScopedSiteId(c, user, body.siteId);
    if (!siteId) {
        return c.json({ error: 'Forbidden' }, 403);
    }
    const db = c.env.DB;
    let compiledCount = 0;
    if (db) {
        try {
            const dirtyPaths = body.path && body.path !== 'all' ? [body.path] : undefined;
            await markSiteRoutesDirty(db, siteId, dirtyPaths);
            const res = await recompileDirtySiteRoutes(db, siteId, 30);
            compiledCount = res.compiledCount || 0;
        } catch {
            // ignore non-fatal recompile errors
        }
    }
    return c.json({
        success: true,
        purgedPath: body.path || 'all',
        compiledCount
    });
});

async function runQuickActionPipeline(c: any, user: any, action: string, data: any, message: string) {
    const pluginEngine = c.get('pluginEngine');
    if (!pluginEngine) {
        return c.json({ error: 'PluginEngine unavailable' }, 500);
    }
    const siteId = data.siteId || c.get('siteId') || 'site_default';
    try {
        const txContext = createHookContext({
            action,
            data,
            c,
            user,
            siteId
        });
        const result = await pluginEngine.runPipeline(txContext);
        return c.json({ success: true, data: result, message });
    } catch (err: any) {
        console.error(`[QuickAction] Failed to execute ${action}:`, err);
        return c.json({ error: err.message || `Failed to execute ${action}` }, 500);
    }
}

quickActionsRouter.post('/micro', async (c) => {
    const user = await assertAuthorizedAdmin(c);
    if (!user) {
        return c.json({ error: 'Unauthorized: Admin privileges required' }, 403);
    }

    const body = await c.req.json().catch(() => ({}));
    const contentRaw = (body.contentRaw || body.content || '').trim();
    if (!contentRaw) {
        return c.json({ error: 'Content cannot be empty' }, 400);
    }

    const title = (body.title || '').trim() || contentRaw.slice(0, 30).split('\n')[0] || 'Flash Memo';
    const rawProg = body.progress !== undefined ? body.progress : body.maturity;
    const progress = typeof rawProg === 'string' ? (rawProg.trim() === 'none' ? '' : rawProg.trim()) : '';
    return runQuickActionPipeline(c, user, 'MICRO_SAVE', {
        title,
        contentRaw,
        progress,
        maturity: progress as any,
        visibility: body.visibility || 'public',
        type: 'micro',
        status: 'published',
        siteId: c.get('siteId') || body.siteId || 'site_default',
        commitMessage: 'Quick action flash memo'
    }, 'Micro content memo persisted with VCS version snapshot');
});

quickActionsRouter.get('/dataset-item/:id', async (c) => {
    const user = await assertAuthorizedAdmin(c);
    if (!user) {
        return c.json({ error: 'Unauthorized' }, 403);
    }

    const db = c.env.DB;
    if (!db) return c.json({ error: 'Database unavailable' }, 500);

    const id = c.req.param('id');
    const row = await findDatasetById(db, id);

    if (!row) {
        return c.json({ error: 'Dataset item not found' }, 404);
    }

    // Enforce multi-tenant isolation so site admins cannot read dataset items from other sites.
    if (user.global_role !== 'superadmin') {
        const memberRole = await findSiteMemberRole(db, row.site_id, user.id);
        if (memberRole !== 'admin') {
            return c.json({ error: 'Forbidden: Cross-tenant dataset access denied', code: 'FORBIDDEN_CROSS_TENANT' }, 403);
        }
    }

    let parsedMeta: any = {};
    try {
        parsedMeta = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata || {});
    } catch {}

    return c.json({
        success: true,
        item: {
            id: row.id,
            siteId: row.site_id,
            schemaSlug: row.schema_slug,
            title: row.title,
            summary: row.summary,
            fields: parsedMeta.fields || {},
            status: row.status
        }
    });
});

quickActionsRouter.post('/dataset-item', async (c) => {
    const user = await assertAuthorizedAdmin(c);
    if (!user) {
        return c.json({ error: 'Unauthorized: Admin privileges required' }, 403);
    }

    const body = await c.req.json().catch(() => ({}));
    const id = body.id || undefined;
    return runQuickActionPipeline(c, user, 'DATASET_SAVE', {
        id,
        siteId: c.get('siteId') || body.siteId || 'site_default',
        schemaSlug: body.schemaSlug || body.schema || 'general',
        title: (body.title || '').trim() || 'Untitled Item',
        summary: body.summary || '',
        data: body.data || body.fields || {},
        status: 'published',
        commitMessage: id ? 'Quick edit dataset item' : 'Quick add dataset item'
    }, 'Dataset atomically updated with version control');
});
