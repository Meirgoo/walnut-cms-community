import type { D1PreparedStatement } from '@cloudflare/workers-types';
import type { WalnutPlugin, HookContext } from '../types';
import {
    ThemeComponentManifestZod,
    markSiteRoutesDirty,
    nanoId
} from '../index';
import {
    buildUpsertThemeStatement,
    buildInsertThemeVersionStatement,
    buildUpdateThemeMetadataStatement,
    buildCreateThemeStatement,
    buildUpdateThemeInfoStatement,
    buildActivateThemeStatements,
    buildActivateThemeBySlugStatements,
    findLatestThemeBySite,
    findPublishedTheme,
    findThemeById,
    findThemeVersions,
    countActiveThemesBySite,
    buildSoftDeleteThemeStatement,
    buildRestoreThemeStatement,
    buildPurgeThemeStatements,
    buildRollbackThemeStatement,
    findThemeVersionByIdOrNumber,
    findThemeRawById,
    checkThemeSlugExists
} from '../core/dal';
import { findSiteById } from '../core/dal';
import {
    encryptRepoToken,
    decryptRepoToken
} from '../core/crypto';
import {
    fetchRepoThemeData
} from './theme-repo';

import { assertAdminUser } from './common.helper';

import {
    computeCodeHash,
    clearConflict,
    resetComp,
    getSiteId,
    makeThemeMeta,
    makeThemeUpsertBatch,
    mergeThemeComponentsThreeWay,
    syncRepoAssetsToR2
} from "./theme-sync.helper";

export {
    computeCodeHash,
    mergeThemeComponentsThreeWay
};

export const themePlugin: WalnutPlugin = {
    name: 'theme',
    version: '1.0.0',

    setup(engine) {
        [
            'THEME_IMPORT', 'THEME_CHUNK_INIT', 'THEME_CHUNK_ASSET', 'THEME_CHUNK_BLOCKS', 'THEME_CHUNK_FINISH',
            'THEME_REPO_IMPORT', 'THEME_UPDATE', 'THEME_ROLLBACK', 'THEME_ACTIVATE', 'THEME_SWITCH',
            'THEME_DELETE', 'THEME_RESTORE', 'THEME_PURGE', 'TEMPLATE_DELETE', 'COMPONENT_DELETE',
            'THEME_CREATE', 'THEME_FORK', 'THEME_UPDATE_METADATA', 'THEME_COMPONENT_CREATE', 'THEME_COMPONENT_UPDATE',
            'THEME_COMPONENT_ACCEPT_UPSTREAM', 'THEME_COMPONENT_DISMISS_CONFLICT'
        ].forEach(act => engine.tapBefore(act, assertAdminUser));

        engine.registerService<{ pkg: Record<string, any> }, { themeNodeId: string; success: boolean }>(
            'THEME_IMPORT',
            async (ctx) => {
                const siteId = ctx.siteId || 'site_default';
                const authorId = ctx.user?.id || 'admin';
                const pkg: Record<string, any> = ctx.data.pkg || {};

                const themeSlug = pkg.slug || pkg.id || `theme-${Date.now().toString(36)}`;
                const themeTitle = pkg.name || pkg.title || 'Untitled Theme';
                const themeSummary = pkg.description || pkg.summary || '';
                const fullPkgMetadata = makeThemeMeta(pkg, {
                    id: themeSlug,
                    global_assets: pkg.global_assets || {
                        styles: pkg.assets?.css ? [pkg.assets.css] : [],
                        scripts: pkg.assets?.js ? [pkg.assets.js] : []
                    },
                    custom_css: pkg.assets?.custom_css || '',
                    custom_js: pkg.assets?.custom_js || '',
                    js_cdn: pkg.assets?.js_cdn || pkg.themeNode?.metadata?.js_cdn || [],
                    md_components: pkg.md_components || pkg.themeNode?.metadata?.md_components || {},
                    ...(pkg.themeNode?.metadata || {})
                });

                const metadataStr = JSON.stringify(fullPkgMetadata);
                const themeId = nanoId('theme', 10);
                const versionId = `ver_${themeId}_1`;

                await ctx.dal.batch(makeThemeUpsertBatch(
                    ctx.dal.db,
                    { id: themeId, siteId, slug: themeSlug, name: themeTitle, author: pkg.author, version: String(pkg.version || '1.0.0'), description: themeSummary, previewImage: pkg.preview_image || pkg.previewImage || '', metadataJson: metadataStr, versionId },
                    { id: versionId, versionTag: String(pkg.version || '1.0.0'), metadataSnapshot: metadataStr, authorId }
                ));

                await markSiteRoutesDirty(ctx.dal.db, siteId);

                return { themeNodeId: themeId, success: true };
            }
        );

        engine.registerService<
            {
                siteId: string;
                themeSlug: string;
                themeTitle: string;
                themeSummary: string;
                metadataJson: string;
            },
            { themeNodeId: string; success: boolean }
        >('THEME_CHUNK_INIT', async (ctx) => {
            const params = ctx.data;
            const themeNodeId = `theme_${params.themeSlug.replace(/[^a-zA-Z0-9_]/g, '_')}`;
            const versionId = `ver_${themeNodeId}_1`;

            await ctx.dal.batch([
                buildUpsertThemeStatement(ctx.dal.db, {
                    id: themeNodeId,
                    siteId: params.siteId,
                    slug: params.themeSlug,
                    name: params.themeTitle,
                    description: params.themeSummary,
                    metadataJson: params.metadataJson,
                    currentVersionId: versionId
                }),
                buildInsertThemeVersionStatement(ctx.dal.db, {
                    id: versionId,
                    themeId: themeNodeId,
                    versionNumber: 1,
                    versionTag: '1.0.0',
                    metadataSnapshot: params.metadataJson,
                    commitMessage: 'Chunked theme import',
                    authorId: ctx.user?.id || 'admin'
                })
            ]);

            return { themeNodeId, success: true };
        });

        engine.registerService<
            {
                themeSlug: string;
                relPath: string;
                content: string;
                isBase64?: boolean;
                contentType?: string;
            },
            { r2Key: string; success: boolean }
        >('THEME_CHUNK_ASSET', async (ctx) => {
            const { themeSlug, relPath, content, isBase64, contentType } = ctx.data;
            const bucket = ctx.dal.bucket;
            const backupBucket = ctx.dal.backupBucket;
            const cleanPath = relPath.replace(/^\/+/, '');

            // Confine R2 storage to static assets under assets/; keep HTML/JSON manifests in D1 only.
            if (!cleanPath.startsWith('assets/') || /\.(html|json)$/i.test(cleanPath)) {
                return { r2Key: '', success: true, skipped: true } as any;
            }

            const r2Key = `theme/${themeSlug}/${cleanPath}`;

            if (bucket && typeof bucket.put === 'function') {
                let fileData: Uint8Array | string = content;
                if (isBase64) {
                    const binaryStr = atob(content);
                    const bytes = new Uint8Array(binaryStr.length);
                    for (let i = 0; i < binaryStr.length; i++) {
                        bytes[i] = binaryStr.charCodeAt(i);
                    }
                    fileData = bytes;
                }

                const mime = contentType || (cleanPath.endsWith('.css') ? 'text/css' : (cleanPath.endsWith('.js') ? 'application/javascript' : 'application/octet-stream'));
                await bucket.put(r2Key, fileData, {
                    httpMetadata: { contentType: mime }
                });

                if (backupBucket && typeof backupBucket.put === 'function') {
                    ctx.executionCtx?.waitUntil(
                        backupBucket.put(r2Key, fileData, {
                            httpMetadata: { contentType: mime }
                        })
                    );
                }
            }

            return { r2Key, success: true };
        });

        engine.registerService<
            {
                siteId: string;
                components?: any[];
                templates?: any[];
                schemas?: any[];
            },
            { count: number; success: boolean }
        >('THEME_CHUNK_BLOCKS', async (ctx) => {
            const params = ctx.data;
            const siteId = params.siteId;
            const theme = await findLatestThemeBySite(ctx.dal.db, siteId);

            let count = 0;
            if (theme) {
                let meta: any;
                try {
                    meta = typeof theme.metadata === 'string' ? JSON.parse(theme.metadata) : (theme.metadata || {});
                } catch {
                    meta = {};
                }

                const upsertItems = (existing: any[], incoming: any[], getKey: (x: any) => string, parse?: (x: any) => any) => {
                    for (const item of incoming) {
                        const data = parse ? parse(item) : item;
                        if (!data) continue;
                        const key = getKey(data);
                        const idx = existing.findIndex((x: any) => getKey(x) === key);
                        if (idx >= 0) existing[idx] = data; else existing.push(data);
                        count++;
                    }
                    return existing;
                };

                if (params.components?.length) {
                    meta.components = upsertItems(meta.components || meta.componentNodes || [], params.components, c => c.slug || c.type, c => {
                        const parsed = ThemeComponentManifestZod.safeParse(c);
                        return parsed.success ? parsed.data : null;
                    });
                }
                if (params.templates?.length) {
                    meta.templates = upsertItems(meta.templates || meta.templateNodes || [], params.templates, t => t.slug || t.key || '');
                }
                if (params.schemas?.length) {
                    meta.schemas = upsertItems(meta.schemas || meta.schemaNodes || [], params.schemas, s => s.slug || s.type || '');
                }

                await ctx.dal.batch([
                    buildUpdateThemeMetadataStatement(ctx.dal.db, theme.id, JSON.stringify(meta))
                ]);
            }

            return { count, success: true };
        });

        engine.registerService<
            {
                siteId: string;
                themeSlug: string;
                activate?: boolean;
            },
            { success: boolean }
        >('THEME_CHUNK_FINISH', async (ctx) => {
            const params = ctx.data;
            const themeNodeId = `theme_${params.themeSlug.replace(/[^a-zA-Z0-9_]/g, '_')}`;
            const statements: D1PreparedStatement[] = [];

            if (params.activate) {
                statements.push(
                    ...buildActivateThemeBySlugStatements(ctx.dal.db, params.siteId, params.themeSlug, themeNodeId)
                );
            }

            if (statements.length > 0) {
                await ctx.dal.batch(statements);
            }
            await markSiteRoutesDirty(ctx.dal.db, params.siteId);
            return { success: true };
        });

        engine.tapBefore('THEME_REPO_IMPORT', (ctx) => {
            if (!ctx.data?.repoUrl || !ctx.data.repoUrl.trim()) {
                throw new Error('REPO_URL_REQUIRED');
            }
        });

        engine.registerService<
            {
                siteId?: string;
                repoUrl: string;
                branch?: string;
                token?: string;
                activate?: boolean;
                fetchFn?: typeof fetch;
            },
            { success: boolean; themeId: string; themeNodeId: string; version: string }
        >('THEME_REPO_IMPORT', async (ctx) => {
            const siteId = getSiteId(ctx);
            const authorId = ctx.user?.id || 'admin';
            const envSecret = ctx.env.SESSION_SECRET || 'walnut_default_session_secret_2026';

            let encryptedToken: string | undefined;
            let tokenIv: string | undefined;
            const rawToken = ctx.data.token?.trim();
            if (rawToken) {
                const encResult = await encryptRepoToken(rawToken, envSecret);
                encryptedToken = encResult.encryptedToken;
                tokenIv = encResult.tokenIv;
            }

            const repoData = await fetchRepoThemeData({
                repoUrl: ctx.data.repoUrl,
                branch: ctx.data.branch,
                token: rawToken,
                fetchFn: ctx.data.fetchFn
            });

            const manifest = repoData.manifest;
            const themeSlug = manifest.id || `theme-${Date.now().toString(36)}`;
            const themeTitle = manifest.name || 'Untitled Theme';
            const themeSummary = manifest.description || '';
            const versionTag = manifest.version || '1.0.0';

            await syncRepoAssetsToR2(ctx.dal, themeSlug, repoData.assets, ctx.executionCtx);

            const themeMetadata = makeThemeMeta(manifest, {
                id: themeSlug,
                version: versionTag,
                tokens: repoData.tokens,
                templates: repoData.templates,
                components: repoData.components,
                schemas: repoData.schemas,
                repo_config: {
                    ...repoData.repoConfig,
                    encrypted_token: encryptedToken || undefined,
                    token_iv: tokenIv || undefined
                }
            });

            const metadataJson = JSON.stringify(themeMetadata);
            const themeId = `theme_${themeSlug.replace(/[^a-zA-Z0-9_]/g, '_')}`;
            const versionId = `ver_${themeId}_1`;

            const statements: D1PreparedStatement[] = makeThemeUpsertBatch(
                ctx.dal.db,
                { id: themeId, siteId, slug: themeSlug, name: themeTitle, author: manifest.author, version: versionTag, description: themeSummary, previewImage: manifest.preview_image || '', metadataJson, versionId },
                { id: versionId, versionNumber: 1, versionTag, metadataSnapshot: metadataJson, commitMessage: `[Repo Import] Initial import from ${repoData.repoConfig.url}`, authorId }
            );

            if (ctx.data.activate) {
                statements.push(...buildActivateThemeStatements(ctx.dal.db, siteId, themeId));
            }

            await ctx.dal.batch(statements);
            if (ctx.data.activate) {
                await markSiteRoutesDirty(ctx.dal.db, siteId);
            }

            return {
                success: true,
                themeId,
                themeNodeId: themeId,
                version: versionTag
            };
        });

        engine.tapBefore('THEME_UPDATE', (ctx) => {
            if (!ctx.data?.themeId) {
                throw new Error('THEME_ID_REQUIRED');
            }
        });

        engine.registerService<
            { siteId?: string; themeId: string; force?: boolean; fetchFn?: typeof fetch; repoUrl?: string; token?: string },
            { success: boolean; updated: boolean; alreadyLatest?: boolean; version: string; versionNumber?: number }
        >('THEME_UPDATE', async (ctx) => {
            const siteId = getSiteId(ctx);
            const themeId = ctx.data.themeId;
            const envSecret = ctx.env.SESSION_SECRET || 'walnut_default_session_secret_2026';
            const authorId = ctx.user?.id || 'admin';

            const theme = await findThemeById(ctx.dal.db, themeId, siteId);
            if (!theme) {
                throw new Error('THEME_NOT_FOUND');
            }

            const repoConfig = theme.metadata?.repo_config;
            if (!repoConfig || !repoConfig.url) {
                throw new Error('THEME_NOT_A_REPO');
            }

            // Clear stored credentials and require token re-auth when repo URL changes to prevent token exfiltration.
            let plaintextToken: string | undefined;
            if (ctx.data.repoUrl && ctx.data.repoUrl.trim() && ctx.data.repoUrl.trim() !== repoConfig.url) {
                if (!ctx.data.token) {
                    repoConfig.url = ctx.data.repoUrl.trim();
                    delete repoConfig.encrypted_token;
                    delete repoConfig.token_iv;
                    await buildUpdateThemeMetadataStatement(ctx.dal.db, themeId, JSON.stringify(theme.metadata)).run();
                    throw new Error('TOKEN_REAUTH_REQUIRED');
                }
                repoConfig.url = ctx.data.repoUrl.trim();
                plaintextToken = ctx.data.token;
            } else if (ctx.data.token) {
                plaintextToken = ctx.data.token;
            } else if (repoConfig.encrypted_token && repoConfig.token_iv) {
                plaintextToken = await decryptRepoToken(repoConfig.encrypted_token, repoConfig.token_iv, envSecret);
            }

            const repoData = await fetchRepoThemeData({
                repoUrl: repoConfig.url,
                branch: repoConfig.branch,
                token: plaintextToken,
                fetchFn: ctx.data.fetchFn
            });

            const newVersionTag = repoData.manifest.version || '1.0.0';

            const sameCommit = Boolean(repoConfig.commit_hash && repoData.commitHash && repoConfig.commit_hash === repoData.commitHash);
            if (!ctx.data.force && theme.version === newVersionTag && (!repoData.commitHash || sameCommit)) {
                return {
                    success: true,
                    updated: false,
                    alreadyLatest: true,
                    version: theme.version
                };
            }

            await syncRepoAssetsToR2(ctx.dal, theme.slug, repoData.assets, ctx.executionCtx);

            const versions = await findThemeVersions(ctx.dal.db, theme.id);
            const nextVersionNumber = versions.length > 0 ? Math.max(...versions.map(v => v.version_number)) + 1 : 2;
            const newVersionId = `ver_${theme.id}_${nextVersionNumber}`;

            const localComponents = theme.metadata?.components || [];
            const upstreamComponents = repoData.components || [];
            const compMergeResult = await mergeThemeComponentsThreeWay(localComponents, upstreamComponents, newVersionTag);

            const localTemplates = theme.metadata?.templates || [];
            const upstreamTemplates = repoData.templates || [];
            const tplMergeResult = await mergeThemeComponentsThreeWay(localTemplates, upstreamTemplates, newVersionTag);

            const updatedMetadata = {
                ...theme.metadata,
                ...repoData.manifest,
                version: newVersionTag,
                tokens: repoData.tokens || theme.metadata?.tokens || {},
                templates: tplMergeResult.components,
                components: compMergeResult.components,
                schemas: repoData.schemas || theme.metadata?.schemas || [],
                repo_config: {
                    ...repoConfig,
                    last_synced_at: new Date().toISOString(),
                    commit_hash: repoData.commitHash || undefined
                }
            };
            const updatedMetadataJson = JSON.stringify(updatedMetadata);

            await ctx.dal.batch(makeThemeUpsertBatch(
                ctx.dal.db,
                { id: theme.id, siteId, slug: theme.slug, name: repoData.manifest.name || theme.name, author: repoData.manifest.author || theme.author, version: newVersionTag, description: repoData.manifest.description || theme.description || '', previewImage: repoData.manifest.preview_image || theme.preview_image || '', metadataJson: updatedMetadataJson, versionId: newVersionId },
                { id: newVersionId, versionNumber: nextVersionNumber, versionTag: newVersionTag, metadataSnapshot: updatedMetadataJson, commitMessage: `[Repo Update] Updated to version ${newVersionTag}`, authorId }
            ));

            await markSiteRoutesDirty(ctx.dal.db, siteId);

            return {
                success: true,
                updated: true,
                version: newVersionTag,
                versionNumber: nextVersionNumber
            };
        });

        engine.tapBefore('THEME_ROLLBACK', (ctx) => {
            if (!ctx.data?.themeId || (!ctx.data?.targetVersionId && !ctx.data?.targetVersionNumber)) {
                throw new Error('ROLLBACK_PARAM_REQUIRED');
            }
        });

        engine.registerService<
            { siteId?: string; themeId: string; targetVersionId?: string; targetVersionNumber?: number },
            { success: boolean; themeId: string; rolledBackToVersion: string }
        >('THEME_ROLLBACK', async (ctx) => {
            const siteId = getSiteId(ctx);
            const themeId = ctx.data.themeId;

            const theme = await findThemeById(ctx.dal.db, themeId, siteId);
            if (!theme) {
                throw new Error('THEME_NOT_FOUND');
            }

            const targetVersion = await findThemeVersionByIdOrNumber(ctx.dal.db, theme.id, ctx.data.targetVersionId, ctx.data.targetVersionNumber);
            if (!targetVersion) {
                throw new Error('VERSION_NOT_FOUND');
            }

            const rollbackTag = targetVersion.version_tag || String(targetVersion.version_number);

            await ctx.dal.batch([
                buildRollbackThemeStatement(
                    ctx.dal.db,
                    theme.id,
                    targetVersion.metadata_snapshot,
                    rollbackTag,
                    targetVersion.id
                )
            ]);

            await markSiteRoutesDirty(ctx.dal.db, siteId);

            return {
                success: true,
                themeId: theme.id,
                rolledBackToVersion: rollbackTag
            };
        });

        const handleThemeSwitch = async (ctx: HookContext<{ themeId: string }>) => {
            const siteId = ctx.siteId || 'site_default';
            const themeId = ctx.data.themeId;

            const theme = await findThemeById(ctx.dal.db, themeId, siteId);
            if (!theme) {
                throw new Error('THEME_NOT_FOUND');
            }

            // Switch only the active theme pointer/flag; leave content, routes, and user settings untouched.
            await ctx.dal.batch(buildActivateThemeStatements(ctx.dal.db, siteId, theme.id));
            await markSiteRoutesDirty(ctx.dal.db, siteId);

            return { success: true, themeNodeId: theme.id };
        };

        engine.registerService<{ themeId: string }, { success: boolean; themeNodeId: string }>(
            'THEME_ACTIVATE',
            handleThemeSwitch
        );

        engine.registerService<{ themeId: string }, { success: boolean; themeNodeId: string }>(
            'THEME_SWITCH',
            handleThemeSwitch
        );

        engine.tapBefore('THEME_DELETE', (ctx) => {
            if (!ctx.data?.themeId) {
                throw new Error('THEME_ID_REQUIRED');
            }
        });

        engine.registerService<{ siteId?: string; themeId: string }, { success: boolean; themeId: string }>(
            'THEME_DELETE',
            async (ctx) => {
                const siteId = getSiteId(ctx);
                const themeId = ctx.data.themeId;

                const activeCount = await countActiveThemesBySite(ctx.dal.db, siteId);
                if (activeCount <= 1) {
                    throw new Error('CANNOT_DELETE_LAST_THEME');
                }

                const theme = await findThemeById(ctx.dal.db, themeId, siteId);
                if (!theme) {
                    throw new Error('THEME_NOT_FOUND');
                }

                const site = await findSiteById(ctx.dal.db, siteId);

                const isCurrentlyActive = theme.is_active === 1 ||
                    site?.theme_id === theme.id ||
                    site?.theme_id === theme.slug;

                if (isCurrentlyActive) {
                    throw new Error('CANNOT_DELETE_ACTIVE_THEME');
                }

                await ctx.dal.batch([
                    buildSoftDeleteThemeStatement(ctx.dal.db, theme.id, siteId)
                ]);

                return { success: true, themeId: theme.id };
            }
        );

        engine.registerService<{ siteId?: string; themeId: string }, { success: boolean; themeId: string }>(
            'THEME_RESTORE',
            async (ctx) => {
                const siteId = getSiteId(ctx);
                const themeId = ctx.data.themeId;

                await ctx.dal.batch([
                    buildRestoreThemeStatement(ctx.dal.db, themeId, siteId)
                ]);

                return { success: true, themeId };
            }
        );

        engine.registerService<{ siteId?: string; themeId: string }, { success: boolean; themeId: string }>(
            'THEME_PURGE',
            async (ctx) => {
                const siteId = getSiteId(ctx);
                const themeId = ctx.data.themeId;

                const row = await findThemeRawById(ctx.dal.db, themeId, siteId);

                if (!row) {
                    throw new Error('THEME_NOT_FOUND');
                }
                if (!row.deleted_at) {
                    throw new Error('PURGE_ONLY_IN_TRASH');
                }

                await ctx.dal.batch(buildPurgeThemeStatements(ctx.dal.db, themeId, siteId));

                return { success: true, themeId };
            }
        );

        const deleteThemeMetaItem = async (ctx: any, keys: string[], targetId: string) => {
            const siteId = ctx.data.siteId || ctx.siteId || '';
            const theme = await findPublishedTheme(ctx.dal.db, siteId);
            if (theme) {
                const meta = typeof theme.metadata === 'string' ? JSON.parse(theme.metadata) : (theme.metadata || {});
                const primaryKey = keys[0];
                const list = (meta[primaryKey] || meta[keys[1]] || []).filter(
                    (x: any) => !keys.some(k => x[k] === targetId || x.id === targetId || x.slug === targetId)
                );
                meta[primaryKey] = list;
                await ctx.dal.batch([buildUpdateThemeMetadataStatement(ctx.dal.db, theme.id, JSON.stringify(meta))]);
                if (siteId) await markSiteRoutesDirty(ctx.dal.db, siteId);
            }
            return { success: true };
        };
        engine.registerService<{ siteId: string; templateId: string }, { success: boolean }>('TEMPLATE_DELETE', (ctx) => deleteThemeMetaItem(ctx, ['templates', 'templateNodes', 'key'], ctx.data.templateId));
        engine.registerService<{ siteId: string; componentId: string }, { success: boolean }>('COMPONENT_DELETE', (ctx) => deleteThemeMetaItem(ctx, ['components', 'componentNodes', 'type'], ctx.data.componentId));

        async function assertThemeSlugAvailable(db: any, siteId: string, slug: string) {
            const exists = await checkThemeSlugExists(db, siteId, slug);
            if (exists) throw new Error('SLUG_EXISTS');
        }

        async function persistNewTheme(ctx: HookContext<any>, siteId: string, slug: string, name: string, author: string, desc: string, meta: any, commitMsg: string) {
            const newThemeId = nanoId('theme', 10);
            const initialVersionId = `ver_${newThemeId}_1`;
            const metaJson = JSON.stringify(meta);
            await ctx.dal.batch([
                buildInsertThemeVersionStatement(ctx.dal.db, {
                    id: initialVersionId, themeId: newThemeId, versionNumber: 1, versionTag: '1.0.0', metadataSnapshot: metaJson, commitMessage: commitMsg, authorId: ctx.user?.id || 'admin'
                }),
                buildCreateThemeStatement(ctx.dal.db, {
                    id: newThemeId, siteId, slug, name, author, version: '1.0.0', description: desc, metadataJson: metaJson, currentVersionId: initialVersionId
                })
            ]);
            return { id: newThemeId, site_id: siteId, slug, name, version: '1.0.0', metadata: meta };
        }

        engine.tapBefore('THEME_CREATE', (ctx) => {
            if (!ctx.data?.name || !ctx.data?.slug) throw new Error('THEME_FIELDS_REQUIRED');
        });
        engine.registerService<{
            siteId?: string; name: string; slug: string; author?: string; description?: string;
        }, { success: boolean; theme: any }>('THEME_CREATE', async (ctx) => {
            const siteId = getSiteId(ctx);
            const cleanSlug = ctx.data.slug.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-');
            await assertThemeSlugAvailable(ctx.dal.db, siteId, cleanSlug);

            const starterMetadata = {
                name: ctx.data.name.trim(), slug: cleanSlug, version: '1.0.0',
                author: ctx.data.author?.trim() || ctx.user?.username || 'Admin',
                description: ctx.data.description?.trim() || '',
                templates: [], components: [], tokens: {}, schemas: []
            };

            const theme = await persistNewTheme(ctx, siteId, cleanSlug, ctx.data.name.trim(), starterMetadata.author, starterMetadata.description, starterMetadata, 'Initial release (1.0.0)');
            return { success: true, theme };
        });

        engine.tapBefore('THEME_FORK', (ctx) => {
            if (!ctx.data?.sourceThemeId || !ctx.data?.name || !ctx.data?.slug) {
                throw new Error('THEME_FORK_FIELDS_REQUIRED');
            }
        });
        engine.registerService<{
            siteId?: string; sourceThemeId: string; name: string; slug: string; author?: string; description?: string;
        }, { success: boolean; theme: any }>('THEME_FORK', async (ctx) => {
            const siteId = getSiteId(ctx);
            const cleanSlug = ctx.data.slug.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-');

            const sourceTheme = await findThemeById(ctx.dal.db, ctx.data.sourceThemeId, siteId);
            if (!sourceTheme) throw new Error('THEME_NOT_FOUND');
            await assertThemeSlugAvailable(ctx.dal.db, siteId, cleanSlug);

            const forkMetadata = JSON.parse(JSON.stringify(sourceTheme.metadata || {}));
            forkMetadata.name = ctx.data.name.trim();
            forkMetadata.slug = cleanSlug;
            forkMetadata.version = '1.0.0';
            forkMetadata.author = ctx.data.author?.trim() || ctx.user?.username || sourceTheme.author || 'Admin';
            forkMetadata.description = ctx.data.description !== undefined ? ctx.data.description : (sourceTheme.description || '');
            forkMetadata.forked_from = sourceTheme.id;
            forkMetadata.forked_from_slug = sourceTheme.slug;
            forkMetadata.forked_at = new Date().toISOString();
            delete forkMetadata.repo_config;

            const bucket = ctx.dal.bucket;
            if (bucket && typeof (bucket as any).list === 'function') {
                try {
                    const sourcePrefix = `theme/${sourceTheme.slug}/`;
                    const listed = await (bucket as any).list({ prefix: sourcePrefix });
                    for (const obj of listed.objects || []) {
                        const relPath = obj.key.slice(sourcePrefix.length);
                        const sourceObj = await bucket.get(obj.key);
                        if (sourceObj) {
                            await bucket.put(`theme/${cleanSlug}/${relPath}`, await sourceObj.arrayBuffer(), {
                                httpMetadata: { contentType: sourceObj.httpMetadata?.contentType || 'text/plain' }
                            });
                        }
                    }
                } catch {}
            }

            const theme = await persistNewTheme(ctx, siteId, cleanSlug, ctx.data.name.trim(), forkMetadata.author, forkMetadata.description, forkMetadata, `Fork from [${sourceTheme.name}] (${sourceTheme.slug})`);
            return { success: true, theme };
        });

        engine.tapBefore('THEME_UPDATE_METADATA', (ctx) => {
            if (!ctx.data?.themeId) throw new Error('THEME_ID_REQUIRED');
        });
        engine.registerService<{
            siteId?: string;
            themeId: string;
            name?: string;
            slug?: string;
            author?: string;
            description?: string;
        }, { success: boolean; theme: any }>('THEME_UPDATE_METADATA', async (ctx) => {
            const siteId = getSiteId(ctx);
            const theme = await findThemeById(ctx.dal.db, ctx.data.themeId, siteId);
            if (!theme) {
                throw new Error('THEME_NOT_FOUND');
            }

            const meta = typeof theme.metadata === 'string' ? JSON.parse(theme.metadata) : (theme.metadata || {});
            if (ctx.data.name) meta.name = ctx.data.name.trim();
            if (ctx.data.author) meta.author = ctx.data.author.trim();
            if (ctx.data.description !== undefined) meta.description = ctx.data.description;
            if (ctx.data.slug) meta.slug = ctx.data.slug.trim().toLowerCase();
            if ((ctx.data as any).layout_html !== undefined) meta.layout_html = (ctx.data as any).layout_html;

            const metaJson = JSON.stringify(meta);
            await ctx.dal.batch([
                buildUpdateThemeInfoStatement(ctx.dal.db, {
                    id: theme.id,
                    siteId,
                    name: ctx.data.name?.trim(),
                    slug: ctx.data.slug?.trim().toLowerCase(),
                    author: ctx.data.author?.trim(),
                    description: ctx.data.description,
                    metadataJson: metaJson
                })
            ]);

            await markSiteRoutesDirty(ctx.dal.db, siteId);

            return { success: true, theme: { ...theme, ...ctx.data, metadata: meta } };
        });

        async function mutateThemeComponent(
            ctx: HookContext<any>,
            fn: (targetComp: any, comps: any[], meta: any) => any,
            requireExisting = true
        ) {
            const siteId = getSiteId(ctx);
            const theme = await findThemeById(ctx.dal.db, ctx.data.themeId, siteId);
            if (!theme) throw new Error('THEME_NOT_FOUND');
            const meta = typeof theme.metadata === 'string' ? JSON.parse(theme.metadata) : (theme.metadata || {});
            const comps: any[] = meta.components || meta.componentNodes || [];
            const key = (ctx.data.slug || '').trim().toLowerCase();
            const targetComp = comps.find((c: any) => (c.slug || c.type || c.id || c.metadata?.slug || c.metadata?.type || '').toLowerCase() === key);
            if (requireExisting && !targetComp) throw new Error('COMPONENT_NOT_FOUND');
            const res = await fn(targetComp, comps, meta);
            meta.components = comps;
            await ctx.dal.batch([buildUpdateThemeMetadataStatement(ctx.dal.db, theme.id, JSON.stringify(meta))]);
            await markSiteRoutesDirty(ctx.dal.db, siteId);
            return res;
        }

        engine.tapBefore('THEME_COMPONENT_CREATE', (ctx) => {
            if (!ctx.data?.themeId || !ctx.data?.slug || !ctx.data?.name) {
                throw new Error('COMPONENT_FIELDS_REQUIRED');
            }
        });
        engine.registerService<{
            siteId?: string;
            themeId: string;
            slug: string;
            name: string;
            summary?: string;
            templateHtml: string;
            category?: string;
            icon?: string;
        }, { success: boolean; component: any }>('THEME_COMPONENT_CREATE', async (ctx) => {
            return mutateThemeComponent(ctx, async (_, comps) => {
                const key = ctx.data.slug.trim().toLowerCase();
                if (comps.some((c: any) => (c.slug || c.type) === key)) {
                    throw new Error('COMPONENT_EXISTS');
                }
                const code = ctx.data.templateHtml || '';
                const codeHash = await computeCodeHash(code);
                const rawSlots = Array.isArray((ctx.data as any).slots) && (ctx.data as any).slots.length > 0
                    ? (ctx.data as any).slots.map(String)
                    : ((ctx.data as any).slot ? [String((ctx.data as any).slot)] : ['main']);
                const allowCustomJs = (ctx.data as any).allow_custom_js === true;
                const defaultProps = { ...((ctx.data as any).default_props || {}) };
                if (!allowCustomJs) delete defaultProps.custom_js;
                const newComp = {
                    slug: key,
                    type: key,
                    name: ctx.data.name.trim(),
                    summary: ctx.data.summary?.trim() || '',
                    slots: rawSlots,
                    allow_custom_js: allowCustomJs,
                    template_html: code,
                    template: code,
                    default_props: defaultProps,
                    props_schema: (ctx.data as any).props_schema || {},
                    category: ctx.data.category || 'custom',
                    icon: ctx.data.icon || 'widgets',
                    base_hash: codeHash,
                    local_hash: codeHash,
                    modified_locally: false,
                    upstream_conflict: false,
                    created_at: new Date().toISOString()
                };
                comps.push(newComp);
                return { success: true, component: newComp };
            }, false);
        });

        ['THEME_COMPONENT_UPDATE', 'THEME_COMPONENT_ACCEPT_UPSTREAM', 'THEME_COMPONENT_DISMISS_CONFLICT'].forEach(act => {
            engine.tapBefore(act, (ctx) => {
                if (!ctx.data?.themeId || !ctx.data?.slug) throw new Error('COMPONENT_FIELDS_REQUIRED');
            });
        });

        engine.registerService<{
            siteId?: string;
            themeId: string;
            slug: string;
            name?: string;
            summary?: string;
            templateHtml?: string;
        }, { success: boolean; component: any }>('THEME_COMPONENT_UPDATE', async (ctx) => {
            return mutateThemeComponent(ctx, async (targetComp) => {
                if (ctx.data.templateHtml !== undefined) {
                    const newCode = ctx.data.templateHtml;
                    const newHash = await computeCodeHash(newCode);
                    if (!targetComp.base_hash) {
                        targetComp.base_hash = targetComp.local_hash || newHash;
                    }
                    if (newHash !== targetComp.base_hash) {
                        targetComp.modified_locally = true;
                    }
                    targetComp.template_html = newCode;
                    targetComp.template = newCode;
                    targetComp.local_hash = newHash;
                    if (targetComp.metadata && typeof targetComp.metadata === 'object') {
                        targetComp.metadata.template_html = newCode;
                    }
                }
                if (ctx.data.name !== undefined) targetComp.name = ctx.data.name.trim();
                if (ctx.data.summary !== undefined) targetComp.summary = ctx.data.summary.trim();
                if ((ctx.data as any).category !== undefined) targetComp.category = String((ctx.data as any).category).trim();
                if ((ctx.data as any).icon !== undefined) targetComp.icon = String((ctx.data as any).icon).trim();
                if (Array.isArray((ctx.data as any).slots) && (ctx.data as any).slots.length > 0) {
                    targetComp.slots = (ctx.data as any).slots.map(String);
                }
                if ((ctx.data as any).allow_custom_js !== undefined) {
                    targetComp.allow_custom_js = (ctx.data as any).allow_custom_js === true;
                }
                if ((ctx.data as any).default_props && typeof (ctx.data as any).default_props === 'object') {
                    targetComp.default_props = { ...(ctx.data as any).default_props };
                }
                if (targetComp.allow_custom_js !== true) {
                    delete targetComp.custom_js;
                    if (targetComp.default_props && typeof targetComp.default_props === 'object') {
                        delete targetComp.default_props.custom_js;
                    }
                }
                if ((ctx.data as any).props_schema && typeof (ctx.data as any).props_schema === 'object') {
                    targetComp.props_schema = (ctx.data as any).props_schema;
                }
                return { success: true, component: targetComp };
            });
        });

        engine.registerService<{ siteId?: string; themeId: string; slug: string }, { success: boolean; component: any }>('THEME_COMPONENT_ACCEPT_UPSTREAM', (ctx) =>
            mutateThemeComponent(ctx, async (targetComp) => {
                if (targetComp.upstream_template) {
                    const uCode = targetComp.upstream_template;
                    resetComp(targetComp, uCode, await computeCodeHash(uCode), false);
                } else clearConflict(targetComp);
                return { success: true, component: targetComp };
            })
        );

        engine.registerService<{ siteId?: string; themeId: string; slug: string }, { success: boolean; component: any }>('THEME_COMPONENT_DISMISS_CONFLICT', (ctx) =>
            mutateThemeComponent(ctx, (targetComp) => {
                clearConflict(targetComp);
                return { success: true, component: targetComp };
            })
        );
    }
};
