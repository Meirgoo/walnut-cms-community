import { Hono } from 'hono';
import { raw } from 'hono/html';
import { getCookie } from 'hono/cookie';
import type { AppHonoEnv } from '../engine';
import { AdminLayout } from './layout';
import { setupRouter } from './setup';
import { authRouter } from './routes/auth';
import { dashboardRouter } from './routes/dashboard';
import { articlesRouter } from './routes/articles';
import { pagesRouter } from './routes/pages';
import { themesRouter } from './routes/themes';
import { trashRouter } from './routes/trash';
import { graphRouter } from './routes/graph';
import { microsRouter } from './routes/micros';
import { schemasRouter } from './routes/schemas';
import { tasksRouter } from './routes/tasks';
import { usersRouter } from './routes/users';
import { auditRouter } from './routes/audit';
import { profileRouter } from './routes/profile';
import { logsRouter } from './routes/logs';
import { webhooksRouter } from './routes/webhooks';
import { mediaRouter } from './routes/media';
import { datasetRouter } from './routes/datasets';
import { settingsRouter, sitesRouter } from './routes/settings';
import { uploadRouter } from './routes/upload';
import { handleSaveNode, initAdminEngineContext, checkSystemInstalledCached, getAdminRouteContext } from './routes/common';
import {
    createHookContext,
    getSessionUserId,
    setAdminLocaleCookie,
    getAdminLocale,
    normalizeHostKey,
    isLocalHost,
    loadAdminLocales,
    extractCFAccessIdentity,
    resolveCurrentUser,
    findActiveSites,
    findSiteById,
    findSiteMemberRole,
    fetchAsset,
    renderTemplate,
    getAdminI18nSlice,
    ensureRelativePath,
    DEFAULT_DEV_HOST,
    resolveSiteWithMemoryCache,
    autoClaimSiteDomainIfEligible,
    isPreviewRequest,
    verifySameOriginRequest,
    getCommercialJs
} from '../engine';

const adminApp = new Hono<AppHonoEnv>();

adminApp.use('*', async (c, next) => {
    if (isPreviewRequest(c)) {
        return c.text('Forbidden: Admin workspace cannot be accessed within preview sandbox.', 403);
    }

    c.header('X-Frame-Options', 'DENY');
    c.header('Content-Security-Policy', "frame-ancestors 'none'");

    // Force full-page redirect when HTMX requests originate outside /admin (e.g. boosted public pages) to prevent injecting the admin shell into a public body.
    if (c.req.header('HX-Request')) {
        const hxCur = c.req.header('HX-Current-URL');
        if (c.req.header('HX-Boosted') === 'true' || (hxCur && !new URL(hxCur, 'http://l').pathname.startsWith('/admin'))) {
            c.header('HX-Redirect', c.req.url);
            return c.body(null, 200);
        }
    }

    await loadAdminLocales(c.env);
    c.header('Clear-Site-Data', '"cache"');
    c.header('Cache-Control', 'no-store, no-cache, must-revalidate');

    const cfIdentity = await extractCFAccessIdentity(c);
    if (cfIdentity?.email) {
        c.set('cfAccessEmail', cfIdentity.email);
    }

    await next();
});

adminApp.get('/switch-locale', async (c) => {
    const targetLocale = c.req.query('locale') || 'zh-CN';
    setAdminLocaleCookie(c, targetLocale);
    let redirectUrl = c.req.query('redirect') || c.req.header('referer') || '/admin';
    if (redirectUrl.includes('/switch-locale')) {
        redirectUrl = '/admin';
    }
    return c.redirect(ensureRelativePath(redirectUrl, '/admin'));
});

adminApp.route('/setup', setupRouter);

adminApp.use('*', async (c, next) => {
    const path = c.get('actualPath') || new URL(c.req.url).pathname;

    if (!path.startsWith('/admin/setup') && !path.startsWith('/admin/switch-locale')) {
        const isInstalled = await checkSystemInstalledCached(c.env.DB);
        if (!isInstalled) {
            return c.redirect('/admin/setup');
        }
    }

    let currentSiteId = c.get('siteId') || getCookie(c, 'walnut_active_site');
    let resolvedSite: any = c.get('site' as any);
    if (currentSiteId && !resolvedSite) {
        try {
            const byId = await findSiteById(c.env.DB, currentSiteId);
            if (byId && byId.status === 'active') {
                resolvedSite = byId;
            } else {
                currentSiteId = undefined;
            }
        } catch {}
    }
    if (!currentSiteId || !resolvedSite) {
        try {
            const host = c.get('host') || c.req.header('host') || DEFAULT_DEV_HOST;
            const matchedSite = await resolveSiteWithMemoryCache(c.env.DB, host);
            if (matchedSite) {
                currentSiteId = matchedSite.id;
                resolvedSite = matchedSite;
            } else {
                const activeSites = await findActiveSites(c.env.DB);
                if (activeSites && activeSites.length > 0) {
                    currentSiteId = activeSites[0].id;
                    resolvedSite = activeSites[0];
                }
            }
        } catch {}
    }
    if (currentSiteId) {
        c.set('siteId', currentSiteId);
    }
    if (resolvedSite) {
        c.set('site' as any, resolvedSite);
        if (resolvedSite.license_key && !c.get('licenseKey' as any)) {
            c.set('licenseKey' as any, resolvedSite.license_key);
        }
    }

    if (!c.get('cfAccessEmail')) {
        const cfIdentity = await extractCFAccessIdentity(c);
        if (cfIdentity?.email) {
            c.set('cfAccessEmail', cfIdentity.email);
        }
    }

    let user = c.get('user');
    if (!user) {
        const resolvedUser = await resolveCurrentUser(c);
        if (resolvedUser) {
            user = resolvedUser;
            c.set('user', user);
            c.set('isSuperAdmin', user.global_role === 'superadmin');
        }
    }

    const pluginEngine = initAdminEngineContext(c);
    if (pluginEngine.hasCommercialPlugins() && !path.startsWith('/admin/setup') && !path.startsWith('/admin/switch-locale')) {
        try {
            const licCtx = createHookContext({ action: 'LICENSE_READ', data: {}, c, siteId: currentSiteId });
            const licenseResult = await pluginEngine.runPipeline(licCtx);
            if (licenseResult) {
                c.set('licenseResult' as any, licenseResult);
            }
        } catch {
            // Fail closed: hasCommercialFeature returns false when license resolution fails.
        }
    }

    // Exempt media upload routes from the 512KB JSON/form body cap; media handlers enforce their own 25MB limit.
    const method = c.req.method.toUpperCase();
    if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(method)) {
        const isMediaUploadPath = path === '/admin/api/upload' || path === '/admin/media/api/upload';
        const contentLen = Number(c.req.header('content-length') || 0);
        if (!isMediaUploadPath && contentLen > 512 * 1024) {
            return c.json({ success: false, code: 'PAYLOAD_TOO_LARGE', error: 'Payload exceeds 512KB limit' }, 413);
        }
        const host = c.get('host') || c.req.header('host') || DEFAULT_DEV_HOST;

        if (path !== '/admin/api/login' && path !== '/admin/login' && !path.startsWith('/admin/setup') && !path.startsWith('/admin/switch-locale')) {
            const originCheck = verifySameOriginRequest(c, host);
            if (!originCheck.valid) {
                return c.json({ error: originCheck.error, code: 'CSRF_BLOCKED' }, 403);
            }

            const csrfHeader = c.req.header('X-Admin-CSRF-Token') || c.req.header('x-admin-csrf-token') || c.req.header('HX-Request');
            const isSameOrigin = c.req.header('sec-fetch-site') === 'same-origin';

            // Allow /admin/switch-site because native HTML form posts without JS/HTMX cannot set custom CSRF headers.
            if (!csrfHeader && !isSameOrigin && path !== '/admin/switch-site') {
                return c.json({
                    error: 'Forbidden: Missing required X-Admin-CSRF-Token or HX-Request header',
                    code: 'CSRF_BLOCKED'
                }, 403);
            }
        }
    }

    if (path.startsWith('/admin/setup') || path.startsWith('/admin/switch-locale') || path === '/admin/login' || path === '/admin/api/login') {
        return await next();
    }

    const sessionUserId = await getSessionUserId(c);
    if (!user && !sessionUserId) {
        return c.redirect('/admin/login');
    }

    if (path !== '/admin/logout' && user && user.global_role !== 'superadmin') {
        if (!user.site_role || user.site_role !== 'admin') {
            return c.text('Forbidden: You do not have administrator permissions for this site.', 403);
        }
    }

    if (resolvedSite) {
        const host = c.get('host') || c.req.header('host') || '';
        await autoClaimSiteDomainIfEligible(c.env.DB, resolvedSite, host);
    }

    await next();
});

adminApp.post('/switch-site', async (c) => {
    const db = c.env.DB;
    const user = c.get('user');
    let targetSiteId = '';
    try {
        const ct = c.req.header('content-type') || '';
        if (ct.includes('application/json')) {
            const body = await c.req.json();
            targetSiteId = String(body?.site_id || body?.siteId || '').trim();
        } else {
            const body = await c.req.parseBody();
            targetSiteId = String((body as any)?.site_id || (body as any)?.siteId || '').trim();
        }
    } catch {}

    if (!targetSiteId) {
        return c.redirect('/admin');
    }

    const targetSite = await findSiteById(db, targetSiteId);
    if (!targetSite || targetSite.status !== 'active') {
        return c.text('Site not found', 404);
    }

    if (user && user.global_role !== 'superadmin') {
        const role = await findSiteMemberRole(db, targetSiteId, user.id);
        if (role !== 'admin') {
            return c.text('Forbidden: You do not have administrator permissions for this site.', 403);
        }
    }

    c.header('Set-Cookie', `walnut_active_site=${targetSiteId}; Path=/; SameSite=Lax; Max-Age=2592000`);
    const currentHost = normalizeHostKey(c.get('host') || c.req.header('host') || '');
    const targetRawDomain = String(targetSite.primary_domain || '').trim();
    const targetNormHost = normalizeHostKey(targetRawDomain);
    let redirectTarget = '/admin';
    if (
        targetRawDomain
        && targetRawDomain !== '*'
        && !isLocalHost(targetRawDomain)
        && targetNormHost
        && targetNormHost !== currentHost
    ) {
        redirectTarget = `https://${targetRawDomain}/admin`;
    }
    if (c.req.header('HX-Request')) {
        c.header('HX-Redirect', redirectTarget);
        return c.text('OK', 200);
    }
    return c.redirect(redirectTarget);
});

adminApp.route('/', authRouter);
adminApp.route('/', dashboardRouter);

adminApp.route('/articles', articlesRouter);
adminApp.route('/pages', pagesRouter);
adminApp.route('/themes', themesRouter);
adminApp.route('/trash', trashRouter);
adminApp.route('/micros', microsRouter);
adminApp.route('/graph', graphRouter);
adminApp.route('/schemas', schemasRouter);

adminApp.route('/audit', auditRouter);
adminApp.route('/tasks', tasksRouter);
adminApp.route('/users', usersRouter);
adminApp.route('/profile', profileRouter);
adminApp.route('/media', mediaRouter);
adminApp.route('/datasets', datasetRouter);
adminApp.route('/settings', settingsRouter);
adminApp.route('/sites', sitesRouter);
adminApp.route('/logs', logsRouter);
adminApp.route('/webhooks', webhooksRouter);
adminApp.route('/api/upload', uploadRouter);

adminApp.get('/connect/:app', async (c) => {
    const appParam = (c.req.param('app') || 'grain').trim();
    if (appParam !== 'grain') {
        return c.notFound();
    }
    const ctx = await getAdminRouteContext(c);
    const i18n = getAdminI18nSlice(ctx.locale, 'connect');
    const tpl = await fetchAsset('/admin/pages/connect-epub.html');
    const rawCallback = (c.req.query('callback') || '').trim();
    const safeCallback = (rawCallback.startsWith('https://') || rawCallback.startsWith('http://localhost') || rawCallback.startsWith('http://127.0.0.1'))
        ? rawCallback
        : '';
    const htmlStr = renderTemplate(tpl, {
        site_id: ctx.activeSiteId,
        ecosystem_app: appParam,
        callback_url: safeCallback
    }, i18n);
    return c.html(
        <AdminLayout title={i18n.epub_title} {...ctx}>
            {raw(htmlStr)}
        </AdminLayout>
    );
});

adminApp.get('/commercial-assets/:file', async (c) => {
    const ctx = await getAdminRouteContext(c);
    const isCommercial = ctx.canUseFeature ? ctx.canUseFeature('cms:*') : false;
    if (!isCommercial) {
        return c.notFound();
    }
    const file = c.req.param('file') || '';
    const js = getCommercialJs(file);
    if (!js) {
        return c.notFound();
    }
    return c.body(js, 200, {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'private, no-cache, must-revalidate'
    });
});

adminApp.post('/api/save', handleSaveNode);

adminApp.all('*', async (c) => {
    const locale = getAdminLocale(c);
    const i18n = getAdminI18nSlice(locale, 'common');
    const notFoundTpl = await fetchAsset('/shared/not-found.html', c.env);
    return c.html(renderTemplate(notFoundTpl, {}, i18n), 404);
});

export { adminApp };
