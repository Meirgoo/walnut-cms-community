import { Hono, type Context } from 'hono';
import type { AppHonoEnv } from '../../engine';
import { getAdminLocale, getAdminI18nSlice, t, isFeatureEnabled } from '../../engine';
import { SettingsPage } from '../pages/Settings';
import { SiteWizardPage } from '../pages/SiteWizard';
import { getAdminRouteContext, runAdminPipeline, renderStatusBadge, parseJson } from './common';

const sitesRouter = new Hono<AppHonoEnv>();
const settingsRouter = new Hono<AppHonoEnv>();

const errJson = (c: Context, e: any, def: string, extra = {}) => {
    const msg = String(e?.message || def);
    const status = msg.includes('LICENSE_') || msg.includes('UNAUTHORIZED') || msg.includes('ACTION_NOT_REGISTERED') ? 403 : 400;
    return c.json({ success: false, error: msg, ...extra }, status);
};

sitesRouter.get('/new', async (c) => {
    const ctx = await getAdminRouteContext(c);
    if (!ctx.isSuperAdmin) return c.redirect('/admin');

    let backupSnapshots: Array<{ key: string; label?: string }> = [];
    if (ctx.canUseFeature?.('cms:site_cloner')) {
        try {
            const bucket = c.env.BACKUP_BUCKET || c.env.BUCKET;
            if (bucket) {
                const [snapListed, legacyListed] = await Promise.all([
                    bucket.list({ prefix: 'database-snapshots/', limit: 30 }),
                    bucket.list({ prefix: 'backups/', limit: 30 })
                ]);
                const seen = new Set<string>();
                const combined = [...(snapListed?.objects || []), ...(legacyListed?.objects || [])]
                    .filter((o: any) => {
                        if (!o?.key || seen.has(o.key)) return false;
                        seen.add(o.key);
                        return true;
                    })
                    .sort((a: any, b: any) => {
                        const ta = a.uploaded ? new Date(a.uploaded).getTime() : 0;
                        const tb = b.uploaded ? new Date(b.uploaded).getTime() : 0;
                        return tb - ta;
                    })
                    .slice(0, 30);
                backupSnapshots = combined.map((o: any) => ({
                    key: o.key,
                    label: o.key.split('/').pop() || o.key
                }));
            }
        } catch {}
    }

    return c.html(<SiteWizardPage {...ctx} backupSnapshots={backupSnapshots} />);
});

const handleCreateSite = async (c: Context<AppHonoEnv>) => {
    const { user, isSuperAdmin } = await getAdminRouteContext(c);
    if (!isSuperAdmin && user?.global_role !== 'superadmin') return c.redirect('/admin');

    const form = await c.req.parseBody();
    const name = String(form['name'] || '').trim();
    const primaryDomain = String(form['primary_domain'] || '').trim().toLowerCase();
    if (!name || !primaryDomain) return c.redirect('/admin/sites/new');

    const initMode = String(form['init_mode'] || 'preset').trim();

    try {
        let newSiteId = '';
        if (initMode === 'clone' || initMode === 'snapshot') {
            const cloneRes = await runAdminPipeline<any, { newSiteId: string; success: boolean }>(c, 'SITE_CLONE', {
                sourceSiteId: initMode === 'clone' ? String(form['source_site_id'] || '').trim() : undefined,
                sourceBackupKey: initMode === 'snapshot' ? String(form['source_backup_key'] || '').trim() : undefined,
                newSiteName: name,
                newPrimaryDomain: primaryDomain,
                cloneNodes: true,
                cloneThemesAndPages: initMode === 'snapshot' ? true : form['clone_themes_pages'] === '1',
                cloneDatasets: initMode === 'snapshot' ? true : form['clone_datasets'] === '1',
                cloneContent: initMode === 'snapshot' ? true : form['clone_content'] === '1',
                cleanFeatures: true
            });
            newSiteId = cloneRes.newSiteId;
        } else {
            const created = await runAdminPipeline<any, { siteId: string; success: boolean }>(c, 'SITE_CREATE', {
                name,
                primaryDomain,
                description: String(form['description'] || '').trim(),
                defaultLocale: String(form['default_locale'] || 'zh-CN').trim(),
                siteMode: form['site_mode'] === 'internal' ? 'internal' : 'standard',
                sitemapDomain: String(form['sitemap_domain'] || '').trim() || primaryDomain
            });
            newSiteId = created.siteId;
        }

        c.header('Set-Cookie', `edge_active_site=${newSiteId}; Path=/; SameSite=Lax; Max-Age=2592000`);
        if (c.req.path.endsWith('/api/create') || c.req.header('HX-Request')) {
            c.header('HX-Redirect', '/admin');
            return c.json({ success: true, siteId: newSiteId }, 200);
        }
        return c.redirect('/admin');
    } catch (e: any) {
        return c.html(e?.message || 'Site creation failed', 400);
    }
};

sitesRouter.post('/create', handleCreateSite);
sitesRouter.post('/api/create', handleCreateSite);

settingsRouter.get('/', async (c) => {
    const ctx = await getAdminRouteContext(c);
    if (ctx.user && ctx.user.site_role === 'visitor' && !ctx.isSuperAdmin && ctx.user.global_role !== 'superadmin') {
        return c.redirect('/admin');
    }

    const activeSite = (ctx.siteId ? ctx.sites.find(s => s.id === ctx.siteId) : ctx.sites[0]) || ctx.sites[0];
    if (activeSite) {
        const parsed = parseJson<Record<string, any>>(activeSite.settings, {});
        if (parsed.cf_api_token) parsed.cf_api_token = '******';
        activeSite.settings = parsed;
    }

    return c.html(<SettingsPage site={activeSite} {...ctx} />);
});

settingsRouter.post('/api/save', async (c) => {
    const f = await c.req.parseBody();
    const locale = getAdminLocale(c);
    const str = (key: string, def = '') => String(f[key] || def).trim();

    const p: Record<string, any> = { siteId: f.site_id as string };
    const textKeys = ['name', 'subtitle', 'primaryDomain', 'logoUrl', 'faviconUrl', 'copyright', 'sitemapDomain', 'titleTemplate', 'description', 'ogImage', 'robotsTxt', 'footerLinks', 'googleAnalyticsId', 'footerScripts', 'licenseKey', 'formWebhookUrl', 'cfZoneId', 'cfApiToken'];
    for (const k of textKeys) {
        p[k] = str(k.replace(/[A-Z]/g, l => `_${l.toLowerCase()}`));
    }
    p.defaultLocale = str('default_locale', 'zh-CN');
    p.timezone = str('timezone', '+08:00');
    p.robotsControl = str('robots_control', 'index, follow');
    p.themeMode = f.theme_mode || 'system';
    if ('primary_color' in f) p.primaryColor = str('primary_color');
    if ('primary_color_dark' in f) p.primaryColorDark = str('primary_color_dark');
    p.brandColor = str('brand_color') || str('primary_color') || '#10b981';
    p.maintenanceMode = f.maintenance_mode === '1' ? 1 : 0;
    p.ogUseFirstImage = f.og_use_first_image === '1' || f.og_use_first_image === 'true';
    const rawMode = str('site_mode');
    p.siteMode = (rawMode === 'internal' || rawMode === 'maintenance' || p.maintenanceMode === 1) ? 'internal' : 'standard';
    p.internalStatus = Number(f.internal_status || 503);
    p.internalRedirectUrl = str('internal_redirect_url');
    p.internalPageTitle = str('internal_page_title');
    p.internalPageMessage = str('internal_page_message');
    p.whitelabel = {
        brand_name: str('wl_brand_name') || str('wl_system_title'),
        system_title: str('wl_system_title') || str('wl_brand_name'),
        provider_name: str('wl_provider_name'),
        logo_url: str('wl_logo_url'),
        favicon_url: str('wl_favicon_url'),
        login_banner_url: str('wl_login_banner_url'),
        support_url: str('wl_support_url'),
        copyright: str('wl_copyright'),
        copyright_text: str('wl_copyright'),
        ...(f.wl_hide_powered_by === '1' || f.wl_hide_powered_by === 'true' ? { hide_powered_by: true, remove_powered_by: true } : {})
    };
    if (f.verify_license_key) {
        p.verify_license_key = str('verify_license_key');
    }

    try {
        await runAdminPipeline(c, 'SITE_UPDATE', p, p.siteId);
        const i18n = getAdminI18nSlice(locale, 'settings');
        return c.html(await renderStatusBadge(i18n.save_success || i18n.settings?.save_success || 'Saved', 'text-green-600'));
    } catch (e: any) {
        return c.html(await renderStatusBadge(e.message || 'Error', 'text-red-600'));
    }
});

const apiCall = (action: string, getParams: (c: Context<AppHonoEnv>, siteId: string) => Promise<any> | any, failMsg: string, transform?: (res: any, body?: any, locale?: string) => any) => async (c: Context<AppHonoEnv>) => {
    const siteId = c.get('siteId') || 'site_default';
    const locale = getAdminLocale(c);
    try {
        const params = await getParams(c, siteId);
        const result = await runAdminPipeline(c, action, params, siteId);
        return c.json({ success: true, data: result, ...result, ...(transform ? transform(result, params, locale) : {}) });
    } catch (e: any) {
        return errJson(c, e, failMsg);
    }
};

settingsRouter.post('/api/backup', apiCall('D1_SNAPSHOT_EXPORT', (_c, siteId) => ({ siteId, backupTag: `site-${siteId}` }), 'Failed to backup snapshot', (r, _p, loc) => ({
    backupKey: r.backupKey, sizeBytes: r.sizeBytes,
    message: t(loc || 'zh-CN', 'settings.backup_success_msg', { backupKey: r.backupKey, sizeKb: Math.round(r.sizeBytes / 1024) })
})));

settingsRouter.get('/api/backups', apiCall('D1_SNAPSHOT_LIST', (_c, siteId) => ({ siteId }), 'Failed to list backups'));

settingsRouter.post('/api/clone', async (c) => {
    const siteId = c.get('siteId') || 'site_default';
    const locale = getAdminLocale(c);
    try {
        const body = await c.req.parseBody();
        const newSiteName = String(body['new_site_name'] || '').trim();
        const newPrimaryDomain = String(body['new_primary_domain'] || '').trim().toLowerCase();
        if (!newSiteName || !newPrimaryDomain) return c.json({ success: false, error: t(locale, 'errors.missing_required_fields') }, 400);

        const result = await runAdminPipeline<any, any>(c, 'SITE_CLONE', {
            sourceSiteId: siteId,
            sourceBackupKey: String(body['source_backup_key'] || '').trim() || undefined,
            newSiteName,
            newPrimaryDomain,
            cloneNodes: body['clone_nodes'] !== '0',
            cleanFeatures: body['clean_features'] !== '0'
        }, siteId);

        return c.json({
            success: true,
            data: { ...result, domain: newPrimaryDomain, sourceMode: body['source_backup_key'] ? 'r2_snapshot' : 'live_d1' },
            newSiteId: result.newSiteId,
            clonedNodesCount: result.clonedNodesCount,
            message: t(locale, 'settings.clone_success_msg', { siteName: newSiteName, count: result.clonedNodesCount })
        });
    } catch (e: any) {
        return errJson(c, e, 'Failed to clone site');
    }
});

settingsRouter.post('/api/traffic-sync', async (c, next) => {
    if (!isFeatureEnabled('trafficAnalytics', c.env)) return c.notFound();
    await next();
}, apiCall('TRAFFIC_SYNC', async (c, siteId) => {
    const body = await c.req.json().catch(() => ({}));
    return { siteId, zoneId: body.cfZoneId || body.zoneId || body.cf_zone_id, cfApiToken: body.cfApiToken || body.cf_api_token };
}, 'Failed to sync traffic'));

settingsRouter.get('/api/traffic-metrics', async (c, next) => {
    if (!isFeatureEnabled('trafficAnalytics', c.env)) return c.notFound();
    await next();
}, apiCall('TRAFFIC_QUERY', (c, siteId) => ({ siteId, limit: Number(c.req.query('limit') || 14) }), 'Failed to query traffic metrics'));

settingsRouter.post('/api/client-delivery-export', apiCall('CLIENT_DELIVERY_EXPORT', async (c, siteId) => {
    const body = await c.req.json().catch(() => ({}));
    return {
        siteId: body.siteId || siteId,
        clientLicenseKey: body.clientLicenseKey || body.client_license_key || '',
        brandName: body.brandName || body.brand_name || '',
        supportUrl: body.supportUrl || body.support_url || ''
    };
}, 'Failed to export client delivery package'));

settingsRouter.get('/api/tokens', apiCall('API_TOKEN_LIST', (_c, siteId) => ({ siteId }), 'Failed to list API tokens'));
settingsRouter.post('/api/tokens/generate', apiCall('API_TOKEN_GENERATE', async (c, siteId) => {
    const body = await c.req.json().catch(() => ({}));
    return {
        siteId: body.siteId || siteId,
        name: body.name,
        scopes: Array.isArray(body.scopes) ? body.scopes : ['nodes:read', 'datasets:read'],
        expiresInDays: body.expiresInDays ?? null
    };
}, 'Failed to generate API token'));
settingsRouter.delete('/api/tokens/:id', apiCall('API_TOKEN_REVOKE', (c, siteId) => ({
    id: c.req.param('id'),
    siteId
}), 'Failed to revoke API token'));

export { settingsRouter, sitesRouter };

