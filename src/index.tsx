import { Hono } from 'hono';
import type { ScheduledEvent, ExecutionContext } from '@cloudflare/workers-types';
import type { AppHonoEnv } from './engine';
import { commercialPlugins } from './commercial';
import {
    DAL,
    TaskPlugin,
    visitorApp,
    apiApp,
    resolveSiteWithMemoryCache,
    loadAdminLocales,
    handleSpecialRouteFallback,
    getSharedPluginEngine,
    coreServicePlugins,
    DEFAULT_DEV_HOST,
    ServerTimingRecorder,
    recoverZombieRunningTasks,
    hasDueOrScheduledWork,
    extractClientIp,
    getCookieValue,
    sanitizeHostHeader,
    isLocalDevCFAccessBypassEnabled
} from './engine';

const app = new Hono<AppHonoEnv>();

const pluginEngine = getSharedPluginEngine();
pluginEngine.registerPlugins(coreServicePlugins);
pluginEngine.registerPlugins(commercialPlugins);

// Registered before global middleware to serve static assets with zero D1 queries.
const serveStaticAsset = async (c: any) => {
    const assets = c.env?.ASSETS;
    if (assets) {
        const reqHeaders = new Headers(c.req.raw.headers);
        reqHeaders.delete('if-none-match');
        reqHeaders.delete('if-modified-since');

        const cleanReq = new Request(c.req.raw.url, {
            method: c.req.method,
            headers: reqHeaders
        });

        const res = await assets.fetch(cleanReq);
        if (res.status !== 404) {
            const newHeaders = new Headers(res.headers);
            newHeaders.set('Cache-Control', 'public, max-age=31536000, immutable');
            return new Response(res.body, {
                status: res.status,
                statusText: res.statusText,
                headers: newHeaders
            });
        }
    }
    return c.notFound();
};

app.get('/shared/*', serveStaticAsset);
app.get('/admin/js/*', serveStaticAsset);

const serveR2MediaAsset = async (c: any, r2Key: string) => {
    if (r2Key.includes('\0') || r2Key.includes('%00')) {
        return c.text('Bad Request: Invalid path characters', 400);
    }

    let decoded = r2Key;
    try {
        decoded = decodeURIComponent(r2Key);
    } catch {
        return c.text('Bad Request: Malformed URI encoding', 400);
    }

    if (decoded.includes('\0')) {
        return c.text('Bad Request: Invalid path characters', 400);
    }

    const segments = decoded.split(/[/\\]+/).filter(Boolean);
    if (segments.some(seg => seg === '..' || seg === '.')) {
        return c.text('Forbidden: Directory traversal attempt detected', 403);
    }

    const cleanKey = segments.join('/');

    // Restrict R2 reads to content/ and theme/ prefixes to prevent leaking snapshots, backups, or root objects.
    if (!cleanKey.startsWith('content/') && !cleanKey.startsWith('theme/')) {
        return c.text('Forbidden: Access outside allowed asset root is prohibited', 403);
    }

    const bucket = c.env?.BUCKET;
    if (!bucket) {
        return c.text('R2 Storage Not Configured', 500);
    }

    const object = await bucket.get(cleanKey);
    if (!object) {
        return c.notFound();
    }

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set('etag', object.httpEtag);
    headers.set('Cache-Control', 'public, max-age=31536000, immutable');
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");

    return new Response(object.body, {
        headers,
        status: 200,
    });
};

app.get('/content/*', (c) => serveR2MediaAsset(c, c.req.path.replace(/^\//, '')));
app.get('/theme/*', (c) => serveR2MediaAsset(c, c.req.path.replace(/^\//, '')));

let taskPluginInstance: TaskPlugin | null = null;

app.use('*', async (c, next) => {
    const tTotalStart = performance.now();
    const timing = new ServerTimingRecorder();
    c.set('serverTiming' as any, timing);
    (globalThis as any).__CF_ENV__ = c.env;

    const url = new URL(c.req.url);

    // Reject unauthenticated admin/API requests before loading admin modules or querying D1.
    const rawPathname = url.pathname;
    const cookieStr = c.req.header('cookie') || '';
    const sessionToken = getCookieValue(cookieStr, 'walnut_session');
    const hasValidFormatSession = Boolean(sessionToken && sessionToken.length >= 16);
    const cfJwtHeader = c.req.header('cf-access-jwt-assertion') || c.req.header('Cf-Access-Jwt-Assertion');
    const hasCfAccess = Boolean(((c.env as any)?.CF_ACCESS_TEAM_NAME && cfJwtHeader) || isLocalDevCFAccessBypassEnabled(c));

    if (rawPathname === '/api/quick-actions/state') {
        const rawHost = (c.req.header('host') || url.host || '').toLowerCase();
        const isLocalDevProbe = (c.env as any)?.ENVIRONMENT !== 'production' && (rawHost.startsWith('localhost') || rawHost.startsWith('127.0.0.1'));
        const hasDevAuth = isLocalDevProbe && (c.req.header('X-Walnut-Dev-Auth') === 'admin' || url.searchParams.get('__walnut_dev_auth') === 'admin');
        if (!hasValidFormatSession && !hasCfAccess && !hasDevAuth) {
            return c.json({ authenticated: false });
        }
    }

    const isAdminPath = rawPathname === '/admin' || rawPathname.startsWith('/admin/');
    const isApiAdminPath = rawPathname === '/api/admin' || rawPathname.startsWith('/api/admin/');
    if (isAdminPath || isApiAdminPath) {
        const isPublicAdminAuthPath =
            rawPathname === '/admin/login' ||
            rawPathname === '/admin/api/login' ||
            rawPathname.startsWith('/admin/setup') ||
            rawPathname.startsWith('/admin/switch-locale');
        if (!isPublicAdminAuthPath) {
            const authHeader = c.req.header('authorization') || '';
            const hasBearer = authHeader.startsWith('Bearer ') && authHeader.length > 16;

            if (!hasValidFormatSession && !hasCfAccess && !(isApiAdminPath && hasBearer)) {
                if (isApiAdminPath) {
                    return c.json({ success: false, error: 'Unauthorized' }, 401);
                }
                return c.redirect('/admin/login', 302);
            }
        }
    }

    const host = sanitizeHostHeader(c.req.header('host') || url.host || DEFAULT_DEV_HOST);
    c.set('host', host);

    const LOCALE_PREFIX_MAP: Record<string, string> = {
        'en': 'en-US',
        'en-US': 'en-US',
        'zh': 'zh-CN',
        'zh-CN': 'zh-CN'
    };
    const pathParts = url.pathname.split('/').filter(Boolean);
    let locale = 'zh-CN';
    let actualPath = url.pathname;

    if (pathParts.length > 0 && LOCALE_PREFIX_MAP[pathParts[0]]) {
        locale = LOCALE_PREFIX_MAP[pathParts[0]];
        actualPath = '/' + pathParts.slice(1).join('/');
        if (actualPath === '') actualPath = '/';
    }

    c.set('locale', locale);
    c.set('actualPath', actualPath);

    const clientIp = extractClientIp(c);
    const isWriteEndpoint = c.req.method !== 'GET' && c.req.method !== 'HEAD';
    if (pluginEngine && typeof (pluginEngine as any).checkFirewall === 'function') {
        const firewallResult = await (pluginEngine as any).checkFirewall(clientIp, isWriteEndpoint, url, c.env, c.req.raw.headers);
        if (!firewallResult.allowed) {
            return c.text(firewallResult.reason || 'Forbidden', (firewallResult.status || 403) as any);
        }
    }

    if (!url.pathname.startsWith('/shared') && !url.pathname.startsWith('/admin/js')) {
        try {
            (c.env as any)?.PAGE_METRICS?.writeDataPoint?.({
                blobs: [
                    host,
                    actualPath,
                    c.req.header('cf-ipcountry') || 'XX',
                    (c.req.header('user-agent') || '').slice(0, 100),
                    (c.req.header('referer') || '').slice(0, 100)
                ],
                doubles: [200, 1],
                indexes: [host]
            });
        } catch {}
    }

    const isAdminRoute = url.pathname.startsWith('/admin');
    const isQuickActionsState = url.pathname === '/api/quick-actions/state';
    const isApiRoute = url.pathname.startsWith('/api') && !isQuickActionsState;
    const hasSessionOrAccess = hasValidFormatSession || hasCfAccess;

    // Defer i18n dictionary loading unless serving an authenticated admin route, login, or setup.
    if (isAdminRoute && (hasSessionOrAccess || url.pathname === '/admin/login' || url.pathname.startsWith('/admin/setup'))) {
        await loadAdminLocales(c.env);
    }

    // Skip site D1 lookup and JSON.parse on anonymous visitor GET/* so visitorApp can hit caches.default first.
    const db = c.env.DB;
    if (db && (isApiRoute || (isAdminRoute && hasSessionOrAccess))) {
        const tSiteStart = performance.now();
        try {
            const site = await resolveSiteWithMemoryCache(db, host);
            if (site) {
                c.set('siteId', site.id);
                c.set('tenantId', site.tenant_id);
                c.set('siteDomain', site.primary_domain);
                c.set('site' as any, site);
                if (site.license_key) {
                    c.set('licenseKey' as any, site.license_key);
                }
            }
        } catch {}
        timing.add('site', performance.now() - tSiteStart);
    }

    c.set('dal', new DAL({
        DB: c.env.DB,
        BUCKET: c.env.BUCKET,
        BUCKET_BACKUP: (c.env as any).BUCKET_BACKUP
    }));
    c.set('pluginEngine', pluginEngine);

    await next();

    timing.add('total', performance.now() - tTotalStart);
    const stHeader = timing.header();
    if (stHeader && c.res) {
        try {
            const existing = c.res.headers.get('Server-Timing');
            c.res.headers.set('Server-Timing', existing ? `${existing}, ${stHeader}` : stHeader);
        } catch {}
    }
});

let cachedAdminWrapper: Hono<AppHonoEnv> | null = null;
const dispatchAdminApp = async (c: any) => {
    if (!cachedAdminWrapper) {
        const { adminApp } = await import('./admin');
        const wrapper = new Hono<AppHonoEnv>();
        wrapper.route('/admin', adminApp);
        cachedAdminWrapper = wrapper;
    }
    let execCtx: any;
    try { execCtx = c.executionCtx; } catch { execCtx = undefined; }
    return cachedAdminWrapper.fetch(c.req.raw, c.env, execCtx);
};
app.all('/admin', dispatchAdminApp);
app.all('/admin/*', dispatchAdminApp);
app.route('/api', apiApp);
app.route('/', visitorApp);

app.onError(async (err, c) => {
    console.error('[Global App Error]', err);

    const url = new URL(c.req.url);
    if (url.pathname.startsWith('/admin')) {
        return c.text(`Admin Error (500): ${err.message || 'Internal Server Error'}`, 500);
    }
    if (url.pathname.startsWith('/api')) {
        return c.json({ success: false, error: err.message || 'Internal Server Error' }, 500);
    }

    const site = c.get('site' as any) as any;
    const locale = c.get('locale') || 'zh-CN';
    let execCtx: any;
    try { execCtx = c.executionCtx; } catch { execCtx = undefined; }
    return handleSpecialRouteFallback(c, site, 500, locale, execCtx, c.env?.DB);
});

export { app };
export default {
    fetch: app.fetch,
    scheduled: async (event: ScheduledEvent, env: any, ctx: ExecutionContext) => {
        const db = env?.DB;
        if (!db) return;
        const nowMs = Date.now();
        const nowIso = new Date(nowMs).toISOString();
        const zombieCutoffIso = new Date(nowMs - 2 * 60_000).toISOString();

        await recoverZombieRunningTasks(db, zombieCutoffIso);

        // Bail out before instantiating TaskPlugin when no scheduled tasks or posts are due.
        const hasWork = await hasDueOrScheduledWork(db, nowIso);
        if (!hasWork) return;

        if (!taskPluginInstance) {
            taskPluginInstance = new TaskPlugin();
        }
        await taskPluginInstance.handleScheduled(
            event,
            {
                DB: env.DB,
                BUCKET: env.BUCKET,
                BUCKET_BACKUP: env.BUCKET_BACKUP,
                AI: env.AI,
                CF_ZONE_ID: env.CF_ZONE_ID,
                CF_API_TOKEN: env.CF_API_TOKEN
            },
            ctx,
            getSharedPluginEngine()
        );
    }
};
