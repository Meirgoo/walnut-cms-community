import type { D1PreparedStatement } from '@cloudflare/workers-types';
import { hashPassword, verifyPassword } from '../core/auth';
import { vaultEncrypt } from '../core/crypto';
import { sanitizeHexColor } from '../core/utils';
import { nanoId } from '../kernel';
import {
    type IPluginEngine,
    type WalnutPlugin,
    type HookContext,
    type MediaAsset,
    type SiteSettings,
    type SiteRole,
    type AuthenticatedUser
} from '../types';
import {
    markSiteRoutesDirty,
    markRoutesDirtyByDependency,
    invalidateSiteMemoryCache,
    buildCreateSiteStatement,
    buildUpdateSiteSettingsStatement,
    buildInsertMediaAssetStatement,
    buildSoftDeleteMediaAssetStatement,
    buildRenameMediaAssetStatement,
    buildUpdateMediaAssetMetadataStatement,
    findMediaAssetById,
    getMediaR2Key,
    buildCreateUserStatement,
    buildAddSiteMemberStatement,
    buildUpdateUserStatement,
    buildUpdateUserPasswordStatement,
    findUserById,
    findUserMetadataById,
    buildUpdateUserMetadataStatement,
    buildUpsertSiteMemberRoleStatement,
    buildDeleteSiteMemberStatement,
    buildDeleteUserStatement,
    findUserForAuth,
    findSiteMemberRole
} from '../core/dal';
import { assertSiteAdmin } from './common.helper';

export interface CreateSiteParams {
    name: string;
    primaryDomain: string;
    description?: string;
    defaultLocale?: string;
    isMediaBedOnly?: number;
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
    siteMode?: 'standard' | 'media_bed' | 'maintenance';
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
    isMediaBedOnly?: number;
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

export interface UploadMediaActionParams {
    file: File;
    siteId: string;
    uploaderId?: string;
    publicAssetsDomain?: string;
}

export interface BatchRenameItem {
    id: string;
    newName: string;
}

export interface CreateUserActionParams {
    siteId: string;
    username: string;
    email: string;
    passwordPlain: string;
    role: SiteRole;
    globalRole?: 'user' | 'superadmin';
}

export interface EditUserActionParams {
    userId: string;
    username: string;
    email: string;
    globalRole: string;
    siteId: string;
    role: SiteRole;
    newPassword?: string;
}

export interface LoginContextResult {
    success: boolean;
    user?: AuthenticatedUser;
    error?: string;
}

export const SystemServicePlugin: WalnutPlugin = {
    name: 'walnut:service-system',
    version: '1.0.0',
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
                        isMediaBedOnly: params.isMediaBedOnly || 0,
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
                const isMediaBedOnly = params.siteMode === 'media_bed' || params.isMediaBedOnly === 1 ? 1 : 0;
                const isMaintenance = params.siteMode === 'maintenance' || params.maintenanceMode === 1 ? 1 : 0;

                const existingSite = await ctx.dal.findSiteById(params.siteId);
                let existingSettings: Record<string, any> = {};
                if (existingSite && existingSite.settings) {
                    try {
                        existingSettings = typeof existingSite.settings === 'string' ? JSON.parse(existingSite.settings) : existingSite.settings;
                    } catch {}
                }

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
                    timezone: params.timezone || existingSettings.timezone || 'Asia/Shanghai',
                    logo_url: params.logoUrl || '',
                    favicon_url: params.faviconUrl || '',
                    title_template: params.titleTemplate || `%s - ${params.name || 'Site'}`,
                    theme_name: params.themeName || '',
                    site_mode: params.siteMode || (isMediaBedOnly ? 'media_bed' : (isMaintenance ? 'maintenance' : 'standard')),
                    sitemap_domain: params.sitemapDomain || '',
                    license_key: params.licenseKey ? params.licenseKey : existingSettings.license_key,
                    primary_color: validPrimaryColor,
                    primary_color_dark: validPrimaryColorDark,
                    seo: {
                        ...(existingSettings.seo || {}),
                        og_image: params.ogImage || '',
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
                        maintenance_mode: isMaintenance,
                        is_media_bed_only: isMediaBedOnly
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

                const updateStmt = buildUpdateSiteSettingsStatement(ctx.dal.db, {
                    siteId: params.siteId,
                    name: params.name || existingSite?.name || 'Default Site',
                    primaryDomain: params.primaryDomain || existingSite?.primary_domain || 'localhost',
                    defaultLocale: params.defaultLocale || existingSite?.default_locale || 'zh-CN',
                    isMediaBedOnly,
                    licenseKey: params.licenseKey ? params.licenseKey : undefined,
                    settingsJson,
                    robotsTxt: robotsTxtValue
                });
                await ctx.dal.batch([updateStmt]);

                await markSiteRoutesDirty(ctx.dal.db, params.siteId);
                invalidateSiteMemoryCache(params.siteId);

                return {
                    success: true,
                    siteId: params.siteId,
                    settings: settingsObj
                };
            }
        );

        engine.registerService<UploadMediaActionParams, MediaAsset>('MEDIA_UPLOAD', async (ctx) => {
            const params = ctx.data;
            await assertSiteAdmin(ctx.dal, params.siteId || ctx.siteId || 'site_default', ctx.user);
            const bucket = ctx.dal.bucket;
            if (!bucket) {
                throw new Error('R2 Bucket not configured');
            }

            const uploaderId = params.uploaderId || ctx.user?.id || 'admin';
            const originalName = params.file.name || 'image.png';
            const ext = originalName.split('.').pop()?.toLowerCase() || 'png';
            const nanoid = nanoId();
            const year = new Date().getFullYear();
            const month = String(new Date().getMonth() + 1).padStart(2, '0');

            const r2Path = `content/sites/${params.siteId}/${year}/${month}/${nanoid}.${ext}`;
            const fileBuffer = await params.file.arrayBuffer();

            await bucket.put(r2Path, fileBuffer, {
                httpMetadata: { contentType: params.file.type }
            });

            const publicDomain = params.publicAssetsDomain || ctx.env.PUBLIC_ASSETS_DOMAIN;
            const publicUrl = publicDomain ? `${publicDomain.replace(/\/+$/, '')}/${r2Path}` : `/${r2Path}`;
            const mediaId = `media_${nanoid}`;
            const nowIso = new Date().toISOString();

            const assetRecord: MediaAsset = {
                id: mediaId,
                site_id: params.siteId,
                file_name: originalName,
                file_size: params.file.size,
                mime_type: params.file.type,
                r2_key: r2Path,
                public_url: publicUrl,
                is_public: 1,
                uploader_id: uploaderId,
                created_at: nowIso
            };

            await ctx.dal.batch([
                buildInsertMediaAssetStatement(ctx.dal.db, {
                    id: mediaId,
                    siteId: params.siteId,
                    fileName: originalName,
                    fileSize: params.file.size,
                    mimeType: params.file.type,
                    r2Key: r2Path,
                    publicUrl,
                    uploaderId,
                    createdAt: nowIso
                })
            ]);

            return assetRecord;
        });

        engine.registerService<{ id: string }, { success: boolean }>('MEDIA_DELETE', async (ctx) => {
            const siteId = ctx.siteId || 'site_default';
            await assertSiteAdmin(ctx.dal, siteId, ctx.user);
            const mediaId = ctx.data.id;
            const asset = await findMediaAssetById(ctx.dal.db, mediaId);
            if (asset && asset.site_id !== siteId && ctx.user?.global_role !== 'superadmin') {
                throw new Error('FORBIDDEN_CROSS_SITE_ACCESS');
            }
            const r2Key = asset?.r2_key || await getMediaR2Key(ctx.dal.db, mediaId);
            if (r2Key && ctx.dal.bucket) {
                try {
                    await ctx.dal.bucket.delete(r2Key);
                } catch {}
            }
            await ctx.dal.batch([
                buildSoftDeleteMediaAssetStatement(ctx.dal.db, mediaId)
            ]);
            return { success: true };
        });

        engine.registerService<{ items: BatchRenameItem[] }, { count: number; success: boolean }>(
            'MEDIA_BATCH_RENAME',
            async (ctx) => {
                await assertSiteAdmin(ctx.dal, ctx.siteId || 'site_default', ctx.user);
                const items = ctx.data.items || [];
                if (items.length === 0) return { success: true, count: 0 };
                if (items.length > 15) throw new Error('BATCH_LIMIT_EXCEEDED');

                const updates = items
                    .filter(i => i.id && i.newName && i.newName.trim())
                    .map(i => ({ id: i.id, newName: i.newName.trim() }));

                const statements = updates.map(item =>
                    buildRenameMediaAssetStatement(ctx.dal.db, item.id, item.newName)
                );

                if (statements.length > 0) {
                    await ctx.dal.batch(statements);
                }

                return { success: true, count: updates.length };
            }
        );

        engine.tapBefore('MEDIA_UPDATE', async (ctx) => {
            await assertSiteAdmin(ctx.dal, ctx.siteId || 'site_default', ctx.user);
        });

        engine.registerService<
            {
                id: string;
                fileName?: string;
                title?: string;
                alt?: string;
                folder?: string;
                isPublic?: boolean;
            },
            { success: boolean; asset?: MediaAsset }
        >('MEDIA_UPDATE', async (ctx) => {
            const siteId = ctx.siteId || 'site_default';
            const mediaId = ctx.data.id;
            const existing = await findMediaAssetById(ctx.dal.db, mediaId);
            if (!existing) throw new Error('Media asset not found');
            if (existing.site_id !== siteId && ctx.user?.global_role !== 'superadmin') {
                throw new Error('FORBIDDEN_CROSS_SITE_ACCESS');
            }

            let prevMeta: Record<string, any> = {};
            try {
                prevMeta = existing.metadata ? JSON.parse(String(existing.metadata)) : {};
            } catch {}

            const nextMeta: Record<string, any> = {
                ...prevMeta,
                ...(ctx.data.title !== undefined ? { title: String(ctx.data.title).trim() } : {}),
                ...(ctx.data.alt !== undefined ? { alt: String(ctx.data.alt).trim() } : {}),
                ...(ctx.data.folder !== undefined ? { folder: String(ctx.data.folder).trim() } : {})
            };

            const nextFileName = ctx.data.fileName !== undefined && ctx.data.fileName.trim()
                ? ctx.data.fileName.trim()
                : existing.file_name;
            const nextIsPublic = ctx.data.isPublic !== undefined ? (ctx.data.isPublic ? 1 : 0) : ((existing as any).is_public ?? 1);

            await ctx.dal.batch([
                buildUpdateMediaAssetMetadataStatement(ctx.dal.db, {
                    id: mediaId,
                    fileName: nextFileName,
                    metadataStr: JSON.stringify(nextMeta),
                    isPublic: nextIsPublic
                })
            ]);

            const updated = await findMediaAssetById(ctx.dal.db, mediaId);
            return { success: true, asset: updated || undefined };
        });

        const markMediaDepDirty = async (ctx: HookContext<any>) => {
            const siteId = ctx.data?.siteId || ctx.siteId || 'site_default';
            await markRoutesDirtyByDependency(ctx.dal.db, siteId, ['media:*'], []);
        };
        for (const mediaAct of ['MEDIA_UPLOAD', 'MEDIA_UPDATE', 'MEDIA_DELETE', 'MEDIA_BATCH_RENAME', 'MEDIA_BATCH_DELETE']) {
            engine.tapAfter(mediaAct, markMediaDepDirty);
        }

        engine.registerService<CreateUserActionParams, { success: boolean; userId: string }>(
            'USER_CREATE',
            async (ctx) => {
                const params = ctx.data;
                await assertSiteAdmin(ctx.dal, params.siteId || ctx.siteId || 'site_default', ctx.user);
                if (params.globalRole === 'superadmin' && ctx.user?.global_role !== 'superadmin') {
                    throw new Error('FORBIDDEN_PRIVILEGE_ESCALATION');
                }
                const userId = nanoId('u');
                const memberId = nanoId('sm');
                const passwordHash = await hashPassword(params.passwordPlain);
                const globalRole = params.globalRole || 'user';

                await ctx.dal.batch([
                    buildCreateUserStatement(ctx.dal.db, {
                        id: userId,
                        email: params.email.trim(),
                        username: params.username.trim(),
                        passwordHash,
                        globalRole
                    }),
                    buildAddSiteMemberStatement(ctx.dal.db, {
                        id: memberId,
                        siteId: params.siteId,
                        userId,
                        role: params.role || 'visitor'
                    })
                ]);

                return { success: true, userId };
            }
        );

        engine.tapBefore<EditUserActionParams>('USER_UPDATE', async (ctx) => {
            const targetSiteId = ctx.data?.siteId || ctx.siteId || 'site_default';
            await assertSiteAdmin(ctx.dal, targetSiteId, ctx.user);
            if (ctx.user?.global_role !== 'superadmin') {
                if (ctx.data?.globalRole === 'superadmin') {
                    throw new Error('FORBIDDEN_PRIVILEGE_ESCALATION');
                }
                const targetUser = await findUserById(ctx.dal.db, ctx.data?.userId);
                if (targetUser?.global_role === 'superadmin') {
                    throw new Error('FORBIDDEN_PRIVILEGE_ESCALATION');
                }
                const memberRole = await findSiteMemberRole(ctx.dal.db, targetSiteId, ctx.data?.userId);
                if (!memberRole) {
                    throw new Error('FORBIDDEN_CROSS_SITE_ACCESS');
                }
            }
        });

        engine.registerService<EditUserActionParams, { success: boolean }>('USER_UPDATE', async (ctx) => {
            const params = ctx.data;
            const nowIso = new Date().toISOString();
            const batchList: D1PreparedStatement[] = [];

            if (params.newPassword && params.newPassword.length >= 6) {
                const passwordHash = await hashPassword(params.newPassword);
                batchList.push(
                    buildUpdateUserStatement(
                        ctx.dal.db,
                        params.userId,
                        params.username,
                        params.email,
                        params.globalRole,
                        passwordHash,
                        nowIso
                    )
                );
            } else {
                batchList.push(
                    buildUpdateUserStatement(
                        ctx.dal.db,
                        params.userId,
                        params.username,
                        params.email,
                        params.globalRole,
                        null,
                        nowIso
                    )
                );
            }

            batchList.push(
                buildUpsertSiteMemberRoleStatement(
                    ctx.dal.db,
                    nanoId('sm'),
                    params.siteId,
                    params.userId,
                    params.role
                )
            );

            await ctx.dal.batch(batchList);
            return { success: true };
        });

        engine.registerService<{ id: string }, { success: boolean }>('USER_DELETE', async (ctx) => {
            const siteId = ctx.siteId || 'site_default';
            await assertSiteAdmin(ctx.dal, siteId, ctx.user);
            const userId = ctx.data.id;
            if (ctx.user?.global_role !== 'superadmin') {
                const role = await findSiteMemberRole(ctx.dal.db, siteId, userId);
                if (!role) throw new Error('FORBIDDEN_CROSS_SITE_ACCESS');
            }
            await ctx.dal.batch([
                buildDeleteSiteMemberStatement(ctx.dal.db, userId),
                buildDeleteUserStatement(ctx.dal.db, userId)
            ]);
            return { success: true };
        });

        engine.registerService<{ userIds: string[] }, { count: number; success: boolean }>(
            'USER_BATCH_DELETE',
            async (ctx) => {
                const siteId = ctx.siteId || 'site_default';
                await assertSiteAdmin(ctx.dal, siteId, ctx.user);
                const userIds = ctx.data.userIds || [];
                if (userIds.length > 15) throw new Error('BATCH_LIMIT_EXCEEDED');
                const statements: D1PreparedStatement[] = [];
                for (const uid of userIds) {
                    if (ctx.user?.global_role !== 'superadmin') {
                        const role = await findSiteMemberRole(ctx.dal.db, siteId, uid);
                        if (!role) throw new Error('FORBIDDEN_CROSS_SITE_ACCESS');
                    }
                    statements.push(
                        buildDeleteSiteMemberStatement(ctx.dal.db, uid),
                        buildDeleteUserStatement(ctx.dal.db, uid)
                    );
                }
                if (statements.length > 0) {
                    await ctx.dal.batch(statements);
                }
                return { count: (ctx.data.userIds || []).length, success: true };
            }
        );

        const assertSelfOrSuperAdmin = (ctx: HookContext<{ userId?: string }>) => {
            if (!ctx.user) throw new Error('UNAUTHENTICATED');
            if (ctx.user.id !== ctx.data?.userId && ctx.user.global_role !== 'superadmin') {
                throw new Error('FORBIDDEN_USER_ACCESS');
            }
        };

        engine.tapBefore('USER_PASSWORD_CHANGE', assertSelfOrSuperAdmin);

        engine.registerService<{ userId: string; newPasswordHash: string }, { success: boolean }>(
            'USER_PASSWORD_CHANGE',
            async (ctx) => {
                await ctx.dal.batch([
                    buildUpdateUserPasswordStatement(ctx.dal.db, ctx.data.userId, ctx.data.newPasswordHash)
                ]);
                return { success: true };
            }
        );

        engine.tapBefore('USER_PREFERENCES_SAVE', assertSelfOrSuperAdmin);

        engine.registerService<{ userId: string; timezone?: string; editor_split_mode?: string; list_page_size?: number }, { success: boolean; metadata: Record<string, any> }>(
            'USER_PREFERENCES_SAVE',
            async (ctx) => {
                const existing = await findUserMetadataById(ctx.dal.db, ctx.data.userId);
                const merged = {
                    ...existing,
                    timezone: ctx.data.timezone ?? existing.timezone ?? 'auto',
                    editor_split_mode: ctx.data.editor_split_mode ?? existing.editor_split_mode ?? 'split',
                    list_page_size: ctx.data.list_page_size ?? existing.list_page_size ?? 20
                };
                await ctx.dal.batch([
                    buildUpdateUserMetadataStatement(ctx.dal.db, ctx.data.userId, JSON.stringify(merged))
                ]);
                return { success: true, metadata: merged };
            }
        );

        engine.registerService<{ usernameOrEmail: string; passwordPlain: string }, LoginContextResult>(
            'AUTH_LOGIN',
            async (ctx) => {
                try {
                    const identifier = ctx.data.usernameOrEmail;
                    const user = await findUserForAuth(ctx.dal.db, identifier);

                    if (!user || !user.password_hash) {
                        return { success: false, error: 'USER_NOT_FOUND_OR_NO_PASSWORD' };
                    }

                    const isValid = await verifyPassword(ctx.data.passwordPlain, user.password_hash);
                    if (!isValid) {
                        return { success: false, error: 'INVALID_CREDENTIALS' };
                    }

                    return {
                        success: true,
                        user: {
                            id: user.id,
                            email: user.email,
                            username: user.username,
                            global_role: user.global_role,
                            auth_provider: 'password'
                        }
                    };
                } catch (e: any) {
                    return { success: false, error: e.message || 'LOGIN_ERROR' };
                }
            }
        );

        engine.registerService<{ userId?: string }, { success: boolean }>('AUTH_LOGOUT', async () => {
            return { success: true };
        });
    }
};
