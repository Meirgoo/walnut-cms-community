import { normalizeLocaleCode } from '../core/i18n';
import { vaultEncrypt } from '../core/crypto';
import { sanitizeHexColor, isValidRedirectTarget, sanitizeRedirectTarget } from '../core/utils';
import { nanoId } from '../kernel';
import {
    type IPluginEngine,
    type WalnutPlugin,
    type SiteSettings
} from '../types';
import {
    markSiteRoutesDirty,
    rebuildFullSiteCacheIndex,
    rebuildSiteSitemapRoute,
    purgeEdgeAndZoneCache,
    invalidateSiteMemoryCache,
    invalidateQueryCache,
    buildCreateSiteStatement,
    buildAddSiteMemberStatement,
    buildUpdateSiteSettingsStatement,
    countAllSites,
    buildCascadeDeleteSiteStatements,
    deleteOptionalSiteScopedRows
} from '../core/dal';
import { registerMediaServices, type UploadMediaActionParams, type BatchRenameItem } from './media.plugin';
import {
    registerUsersAuthServices,
    type CreateUserActionParams,
    type EditUserActionParams,
    type LoginContextResult
} from './users-auth.plugin';

export type {
    UploadMediaActionParams,
    BatchRenameItem,
    CreateUserActionParams,
    EditUserActionParams,
    LoginContextResult
};

export interface CreateSiteParams {
    name: string;
    primaryDomain: string;
    description?: string;
    defaultLocale?: string;
    siteMode?: 'standard' | 'internal';
    sitemapDomain?: string;
}

export interface UpdateSiteSettingsParams {
    siteId: string;
    name: string;
    subtitle?: string;
    primaryDomain: string;
    logoUrl?: string;
    faviconUrl?: string;
    defaultLocale?: string;
    timezone?: string;
    copyright?: string;
    siteMode?: 'standard' | 'internal' | 'maintenance';
    internalStatus?: 503 | 404 | 301 | 302;
    internalRedirectUrl?: string;
    internalPageTitle?: string;
    internalPageMessage?: string;
    sitemapDomain?: string;
    titleTemplate?: string;
    description?: string;
    ogImage?: string;
    robotsControl?: string;
    robotsTxt?: string;
    themeMode?: 'system' | 'dark' | 'light';
    brandColor?: string;
    primaryColor?: string;
    primaryColorDark?: string;
    footerLinks?: string;
    googleAnalyticsId?: string;
    footerScripts?: string;
    maintenanceMode?: number;
    themeName?: string;
    licenseKey?: string;
    whitelabel?: Record<string, any>;
    quickActionShortcut?: string;
    formWebhookUrl?: string;
    cfZoneId?: string;
    cfApiToken?: string;
}

export interface UpdateSiteSettingsResult {
    success: boolean;
    siteId: string;
    settings: SiteSettings;
}

export { type DatasetFieldSchema, type SaveDatasetParams, validateDatasetPayload } from './dataset.plugin';

export const SystemServicePlugin: WalnutPlugin = {
    name: 'walnut:service-system',
    tier: 'community',

    setup(engine: IPluginEngine): void {
        engine.tapBefore<CreateSiteParams>('SITE_CREATE', (ctx) => {
            if (!ctx.user || ctx.user.global_role !== 'superadmin') {
                throw new Error('UNAUTHORIZED');
            }
        });

        engine.registerService<CreateSiteParams, { siteId: string; success: boolean }>(
            'SITE_CREATE',
            async (ctx) => {
                const params = ctx.data;
                const newSiteId = nanoId('site', 10);
                const nowIso = new Date().toISOString();

                const siteSettings = {
                    site_name: params.name,
                    description: params.description || '',
                    default_locale: params.defaultLocale || 'zh-CN',
                    site_mode: params.siteMode === 'internal' ? 'internal' : 'standard',
                    sitemap_domain: params.sitemapDomain || params.primaryDomain,
                    brand_color: '#10b981',
                    theme_mode: 'system',
                    seo: {
                        keywords: [params.name],
                        sitemap_domain: params.sitemapDomain || params.primaryDomain
                    }
                };

                const batchList: D1PreparedStatement[] = [
                    buildCreateSiteStatement(ctx.dal.db, {
                        id: newSiteId,
                        name: params.name,
                        primaryDomain: params.primaryDomain,
                        defaultLocale: params.defaultLocale || 'zh-CN',
                        settingsJson: JSON.stringify(siteSettings),
                        createdAt: nowIso
                    })
                ];

                if (ctx.user?.id) {
                    batchList.push(
                        buildAddSiteMemberStatement(ctx.dal.db, {
                            id: nanoId('sm', 8),
                            siteId: newSiteId,
                            userId: ctx.user.id,
                            role: 'admin'
                        })
                    );
                }

                await ctx.dal.batch(batchList);

                return { siteId: newSiteId, success: true };
            }
        );

        const purgeR2Prefix = async (bucket: any, prefix: string) => {
            if (!bucket || typeof bucket.list !== 'function') return;
            try {
                let cursor: string | undefined;
                do {
                    const listed = await bucket.list(cursor ? { prefix, cursor, limit: 500 } : { prefix, limit: 500 });
                    const keys = (listed?.objects || []).map((o: any) => o.key).filter(Boolean);
                    if (keys.length > 0 && typeof bucket.delete === 'function') {
                        await bucket.delete(keys);
                    }
                    cursor = listed?.truncated ? listed.cursor : undefined;
                } while (cursor);
            } catch {}
        };

        engine.registerService<
            { siteId?: string; id?: string },
            { success: boolean; siteId: string; siteSnapshot?: any }
        >('SITE_DELETE', async (ctx) => {
            if (!ctx.user || ctx.user.global_role !== 'superadmin') {
                throw new Error('FORBIDDEN_SUPERADMIN_REQUIRED');
            }
            const targetSiteId = String(ctx.data?.siteId || ctx.data?.id || ctx.siteId || '').trim();
            if (!targetSiteId) {
                throw new Error('SITE_NOT_FOUND');
            }
            const site = await ctx.dal.findSiteById(targetSiteId);
            if (!site) {
                throw new Error('SITE_NOT_FOUND');
            }
            const totalSites = await countAllSites(ctx.dal.db);
            if (totalSites <= 1) {
                throw new Error('CANNOT_DELETE_LAST_SITE');
            }

            const siteContentPrefix = `content/sites/${targetSiteId}/`;
            await Promise.all([
                purgeR2Prefix(ctx.dal.bucket, siteContentPrefix),
                purgeR2Prefix(ctx.dal.backupBucket, siteContentPrefix),
                purgeR2Prefix(ctx.dal.backupBucket, `backups/sites/${targetSiteId}/`)
            ]);

            await ctx.dal.batch(buildCascadeDeleteSiteStatements(ctx.dal.db, targetSiteId));
            await deleteOptionalSiteScopedRows(ctx.dal.db, targetSiteId);

            return { success: true, siteId: targetSiteId, siteSnapshot: site };
        });

        engine.tapAfter<
            { siteId?: string; id?: string },
            { success: boolean; siteId: string; siteSnapshot?: any }
        >('SITE_DELETE', async (ctx) => {
            if (!ctx.result?.success) return;
            const deletedSiteId = ctx.result.siteId;
            const snapshot = ctx.result.siteSnapshot;
            invalidateSiteMemoryCache(deletedSiteId);
            if (snapshot?.primary_domain) {
                invalidateSiteMemoryCache(snapshot.primary_domain);
            }
            invalidateQueryCache(deletedSiteId);
            await purgeEdgeAndZoneCache(ctx.dal.db, deletedSiteId, ['/'], {
                purgeEverything: true,
                siteOverride: snapshot ?? null,
                requestOrigin: snapshot?.primary_domain ? `https://${snapshot.primary_domain}` : undefined
            });
        });

        engine.tapBefore<UpdateSiteSettingsParams>('SITE_UPDATE', (ctx) => {
            if (!ctx.user) {
                throw new Error('UNAUTHENTICATED');
            }
            const isSuperAdmin = ctx.user.global_role === 'superadmin';
            const isSiteAdmin = ctx.user.site_role === 'admin' && ctx.siteId === ctx.data.siteId;
            if (!isSuperAdmin && !isSiteAdmin) {
                throw new Error('FORBIDDEN_SETTINGS_WRITE');
            }

            // Restrict global credentials (license key, Cloudflare API token) to superadmins.
            if (!isSuperAdmin) {
                if (ctx.data.licenseKey !== undefined && ctx.data.licenseKey !== '') {
                    throw new Error('FORBIDDEN_GLOBAL_CREDENTIAL');
                }
                if (ctx.data.cfApiToken !== undefined && ctx.data.cfApiToken !== '' && ctx.data.cfApiToken !== '******' && ctx.data.cfApiToken !== '••••••••') {
                    throw new Error('FORBIDDEN_GLOBAL_CREDENTIAL');
                }
            }
        });

        engine.registerService<UpdateSiteSettingsParams, UpdateSiteSettingsResult>(
            'SITE_UPDATE',
            async (ctx) => {
                const params = ctx.data;
                const resolvedMode: 'standard' | 'internal' = (params.siteMode === 'internal' || params.siteMode === 'maintenance' || params.maintenanceMode === 1)
                    ? 'internal'
                    : 'standard';

                const existingSite = await ctx.dal.findSiteById(params.siteId);
                let existingSettings: Record<string, any> = {};
                if (existingSite && existingSite.settings) {
                    try {
                        existingSettings = typeof existingSite.settings === 'string' ? JSON.parse(existingSite.settings) : existingSite.settings;
                    } catch {}
                }

                const rawInternalStatus = Number(params.internalStatus ?? existingSettings.internal?.status_code ?? 503);
                const internalStatus: 503 | 404 | 301 | 302 = ([503, 404, 301, 302].includes(rawInternalStatus) ? rawInternalStatus : 503) as 503 | 404 | 301 | 302;
                const rawRedirectUrl = params.internalRedirectUrl !== undefined
                    ? String(params.internalRedirectUrl).trim()
                    : String(existingSettings.internal?.redirect_url || '').trim();
                if ((internalStatus === 301 || internalStatus === 302) && rawRedirectUrl && !isValidRedirectTarget(rawRedirectUrl)) {
                    throw new Error('INVALID_REDIRECT_TARGET');
                }
                const internalRedirectUrl = rawRedirectUrl ? sanitizeRedirectTarget(rawRedirectUrl, '') : '';
                const internalPageTitle = params.internalPageTitle !== undefined
                    ? String(params.internalPageTitle).trim()
                    : String(existingSettings.internal?.title || '').trim();
                const internalPageMessage = params.internalPageMessage !== undefined
                    ? String(params.internalPageMessage).trim()
                    : String(existingSettings.internal?.message || '').trim();
                const isMaintenance = resolvedMode === 'internal' && internalStatus === 503 ? 1 : 0;

                const hasWhitelabelValues = (wl?: Record<string, any> | null) =>
                    Boolean(wl && typeof wl === 'object' && Object.values(wl).some(v => (typeof v === 'string' && v.trim().length > 0) || typeof v === 'boolean'));

                const effectiveWhitelabel = hasWhitelabelValues(params.whitelabel)
                    ? params.whitelabel
                    : undefined;

                // Preserve existing encrypted secrets when masked placeholders are submitted; encrypt new plaintext via vaultEncrypt.
                let finalCfApiToken = existingSettings.cf_api_token || '';
                if (params.cfApiToken !== undefined && params.cfApiToken !== '******' && params.cfApiToken !== '••••••••') {
                    finalCfApiToken = params.cfApiToken
                        ? await vaultEncrypt(params.cfApiToken, params.siteId, 'cf_api_token', ctx.env, ctx.dal.db)
                        : '';
                }

                let finalWebhookUrl = existingSettings.form_webhook_url || '';
                if (params.formWebhookUrl !== undefined && params.formWebhookUrl !== '******' && params.formWebhookUrl !== '••••••••') {
                    finalWebhookUrl = params.formWebhookUrl
                        ? await vaultEncrypt(params.formWebhookUrl, params.siteId, 'form_webhook_url', ctx.env, ctx.dal.db)
                        : '';
                }

                const preservedSettings: Record<string, any> = { ...existingSettings };
                delete preservedSettings.whitelabel;

                const validPrimaryColor = params.primaryColor !== undefined
                    ? sanitizeHexColor(params.primaryColor)
                    : sanitizeHexColor(existingSettings.primary_color ?? existingSettings.appearance?.primary_color);
                const validPrimaryColorDark = params.primaryColorDark !== undefined
                    ? sanitizeHexColor(params.primaryColorDark)
                    : sanitizeHexColor(existingSettings.primary_color_dark ?? existingSettings.appearance?.primary_color_dark);

                const settingsObj: SiteSettings = {
                    ...preservedSettings,
                    site_name: params.name,
                    subtitle: params.subtitle || '',
                    description: params.description || '',
                    copyright: params.copyright || '',
                    timezone: params.timezone || existingSettings.timezone || '+08:00',
                    logo_url: params.logoUrl || '',
                    favicon_url: params.faviconUrl || '',
                    title_template: params.titleTemplate || `%s - ${params.name || 'Site'}`,
                    theme_name: params.themeName || '',
                    site_mode: resolvedMode,
                    internal: {
                        status_code: internalStatus,
                        redirect_url: internalRedirectUrl,
                        title: internalPageTitle,
                        message: internalPageMessage
                    },
                    sitemap_domain: params.sitemapDomain || '',
                    license_key: params.licenseKey ? params.licenseKey : existingSettings.license_key,
                    primary_color: validPrimaryColor,
                    primary_color_dark: validPrimaryColorDark,
                    seo: {
                        ...(existingSettings.seo || {}),
                        og_image: params.ogImage || '',
                        og_use_first_image: Boolean((params as any).ogUseFirstImage),
                        google_site_verification: params.googleAnalyticsId || '',
                        ga_id: params.googleAnalyticsId || '',
                        robots: params.robotsControl || 'index, follow',
                        footer_scripts: params.footerScripts || '',
                        sitemap_domain: params.sitemapDomain || ''
                    },
                    appearance: {
                        ...(existingSettings.appearance || {}),
                        theme_mode: params.themeMode || 'system',
                        brand_color: validPrimaryColor || sanitizeHexColor(params.brandColor) || '#10b981',
                        primary_color: validPrimaryColor,
                        primary_color_dark: validPrimaryColorDark,
                        footer_links: params.footerLinks || ''
                    },
                    routing: {
                        maintenance_mode: isMaintenance
                    },
                    ...(effectiveWhitelabel ? { whitelabel: effectiveWhitelabel } : {}),
                    quick_action_shortcut: params.quickActionShortcut !== undefined
                        ? params.quickActionShortcut
                        : (existingSettings.quick_action_shortcut || 'alt+k,cmd+k'),
                    form_webhook_url: finalWebhookUrl,
                    cf_zone_id: params.cfZoneId !== undefined
                        ? params.cfZoneId
                        : (existingSettings.cf_zone_id || ''),
                    cf_api_token: finalCfApiToken,
                    webhooks: existingSettings.webhooks || []
                };

                const settingsJson = JSON.stringify(settingsObj);
                const robotsTxtValue = params.robotsTxt !== undefined ? params.robotsTxt : existingSite?.robots_txt || null;

                const prevDefaultLocale = normalizeLocaleCode(existingSite?.default_locale || 'zh-CN');
                const nextDefaultLocale = params.defaultLocale || existingSite?.default_locale || 'zh-CN';
                const isDefaultLocaleChanged = prevDefaultLocale !== normalizeLocaleCode(nextDefaultLocale);

                const updateStmt = buildUpdateSiteSettingsStatement(ctx.dal.db, {
                    siteId: params.siteId,
                    name: params.name || existingSite?.name || 'Default Site',
                    primaryDomain: params.primaryDomain || existingSite?.primary_domain || 'localhost',
                    defaultLocale: nextDefaultLocale,
                    licenseKey: params.licenseKey ? params.licenseKey : undefined,
                    settingsJson,
                    robotsTxt: robotsTxtValue
                });
                await ctx.dal.batch([updateStmt]);

                if (isDefaultLocaleChanged) {
                    // Recompute all localized route paths and invalidate precompiled HTML when the default locale prefix rule shifts.
                    await rebuildFullSiteCacheIndex(ctx.dal.db, undefined, params.siteId);
                    await markSiteRoutesDirty(ctx.dal.db, params.siteId);
                    const updatedSite = await ctx.dal.findSiteById(params.siteId);
                    if (updatedSite) {
                        await rebuildSiteSitemapRoute(ctx.dal.db, updatedSite, ctx.host);
                    }
                    await purgeEdgeAndZoneCache(ctx.dal.db, params.siteId, ['/', '/sitemap.xml']);
                } else {
                    await markSiteRoutesDirty(ctx.dal.db, params.siteId);
                }
                invalidateSiteMemoryCache(params.siteId);

                return {
                    success: true,
                    siteId: params.siteId,
                    settings: settingsObj
                };
            }
        );

        registerMediaServices(engine);
        registerUsersAuthServices(engine);
    }
};
