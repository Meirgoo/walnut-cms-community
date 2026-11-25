import type { D1PreparedStatement } from '@cloudflare/workers-types';
import type { WalnutPlugin, HookContext, ArticleMaturity, ArticleStatus } from '../types';
import { nanoId } from '../kernel';
import { buildLocalizedRoutePath } from '../core/i18n';
import {
    normalizeRoutePath,
    removeEntityFromSiteRoutes,
    markTranslationGroupPeersDirty,
    rebuildSiteSitemapRoute,
    assertSiteRouteUnique,
    assertAliasRoutesAvailable,
    buildUpsertSiteRouteStatement,
    buildDeleteOtherSiteRoutesStatement,
    buildDeleteEntitySiteRoutesStatement,
    buildMarkHomeAndSitemapRoutesDirtyStatement,
    buildMarkAllNonRedirectSiteRoutesDirtyStatement,
    buildTouchSiteUpdatedAtStatement,
    markSiteRoutesDirty,
    markRoutesDirtyByDependency,
    purgeEdgeAndZoneCache,
    findPageSlugById,
    findNodeSiteAndSlug,
    findNodeById,
    findNodeMetadataById,
    findLatestArticleVersion,
    findActiveTemplateDependents,
    findInboundRelationSourcePaths,
    isRestrictedAccess,
    findLatestVersionIdsForNode,
    findRestoredNodeById,
    findDeletedItemIdsForEmptyTrash,
    findMaxEntityVersionNumber,
    normalizeTrashCategory,
    buildSoftDeleteNodeStatements,
    buildRestoreNodeStatements,
    buildHardDeleteNodeStatements,
    buildHardDeleteDeletedVersionsForEntityStatements,
    buildCleanupOrphanedDeletedDatasetCollectionsStatement,
    buildMoveNodeFolderStatements,
    findArticleForVcs,
    buildUpdateArticleMetadataOnlyStatement,
    buildInsertArticleVersionStatement,
    buildUpdateArticleWithVersionStatement,
    buildInsertArticleStatement,
    invalidateSiteMemoryCache,
    invalidateQueryCache
} from '../core/dal';
import {
    requireScopedSiteAdmin,
    normalizeEntitySlug,
    normalizePublishedAtInput,
    normalizeAliasesList,
    syncWikiRelationsBatch,
    syncSavedEntityCacheAfterHook,
    SaveEntityPayload,
    SaveEntityResult,
    SaveNodePayload,
    SaveNodeResult
} from './common.helper';
import { parseJson } from '../core/utils';
import { registerArticleVcsAndChunkServices } from './article-vcs-chunks';

async function resolveNodeLocalizedRoutePath(
    dal: any,
    siteId: string,
    entityType: string,
    slug: string,
    locale?: string | null,
    parentId?: string | null
): Promise<string> {
    const site = await dal.findSiteById(siteId);
    const siteDefaultLocale = site?.default_locale || 'zh-CN';
    const parentPath = (entityType === 'page' && parentId) ? await findPageSlugById(dal.db, parentId) : null;
    return buildLocalizedRoutePath(normalizeRoutePath(slug, parentPath), locale || siteDefaultLocale, siteDefaultLocale);
}

export async function persistArticleWithVcs(
    ctx: HookContext<SaveEntityPayload, SaveEntityResult>
): Promise<SaveEntityResult> {
    const { dal, data, user } = ctx;
    const siteId = await requireScopedSiteAdmin(ctx, data.siteId);

    const authorId = user?.id || 'admin';
    const isEdit = !!(data.isEdit && data.id);
    const articleId = data.id || nanoId('art');
    const siteRow = await dal.findSiteById(siteId);
    const siteDefaultLocale = siteRow?.default_locale || 'zh-CN';
    const locale = data.locale || siteDefaultLocale;
    const maturity: ArticleMaturity = data.maturity || 'none';
    const status: ArticleStatus = data.status || 'published';
    const visibility = data.visibility || 'public';
    const summary = data.summary || '';
    const contentRaw = data.contentRaw || '';
    const commitMessage = (data.commitMessage || '').trim();
    const rawMetaObj: Record<string, any> = { ...(data.metadata || {}) };
    if (visibility === 'password' && !String(rawMetaObj.access_password || '').trim()) {
        rawMetaObj.access_password = String(Math.floor(100000 + Math.random() * 900000));
    }
    const metadataStr = JSON.stringify(rawMetaObj);

    let title = (data.title || '').trim() || 'Untitled Article';
    const slug = normalizeEntitySlug(data.slug, 'article');
    const routePath = normalizeRoutePath(slug);

    const localizedPath = await assertSiteRouteUnique(dal.db, siteId, routePath, isEdit ? articleId : null, locale, siteDefaultLocale);
    const normalizedAliases = normalizeAliasesList(rawMetaObj.aliases, localizedPath);
    if (normalizedAliases.length > 0) {
        rawMetaObj.aliases = normalizedAliases;
        await assertAliasRoutesAvailable(dal.db, siteId, normalizedAliases, isEdit ? articleId : null);
    } else {
        delete rawMetaObj.aliases;
    }
    const finalMetadataStr = JSON.stringify(rawMetaObj);

    const articleMeta = rawMetaObj;
    const articleTemplateId = articleMeta.template_id || articleMeta.template_slug || null;
    const articleSchemaSlug = articleMeta.schema_slug || null;

    const buildArticleRouteStmts = (targetTgId: string | null): D1PreparedStatement[] => {
        const nowIso = new Date().toISOString();
        const isPublicPublished = status === 'published' && visibility === 'public';
        const keepPaths = isPublicPublished ? [localizedPath, ...normalizedAliases] : [localizedPath];
        const stmts: D1PreparedStatement[] = [
            buildDeleteOtherSiteRoutesStatement(dal.db, siteId, articleId, keepPaths)
        ];
        if (isPublicPublished) {
            stmts.push(
                buildUpsertSiteRouteStatement(dal.db, {
                    siteId,
                    path: localizedPath,
                    entityType: 'article',
                    entityId: articleId,
                    locale,
                    translationGroupId: targetTgId,
                    title,
                    renderedHtml: null,
                    statusCode: 200,
                    isDirty: 1,
                    changefreq: 'weekly',
                    priority: 0.8,
                    templateId: articleTemplateId,
                    schemaSlug: articleSchemaSlug
                })
            );
            for (const aliasPath of normalizedAliases) {
                stmts.push(
                    buildUpsertSiteRouteStatement(dal.db, {
                        siteId,
                        path: aliasPath,
                        entityType: 'redirect',
                        entityId: articleId,
                        locale,
                        translationGroupId: targetTgId,
                        title,
                        renderedHtml: null,
                        statusCode: 301,
                        redirectTarget: localizedPath,
                        isDirty: 0
                    })
                );
            }
        } else {
            stmts.push(
                buildDeleteEntitySiteRoutesStatement(dal.db, siteId, articleId)
            );
        }
        stmts.push(
            buildMarkHomeAndSitemapRoutesDirtyStatement(dal.db, siteId, nowIso),
            buildTouchSiteUpdatedAtStatement(dal.db, siteId, nowIso)
        );
        return stmts;
    };

    const makeResult = (
        verId: string,
        verNum: number,
        unchanged: boolean,
        isEditMode: boolean,
        extra?: { extraDirtyPaths?: string[]; extraPurgePaths?: string[]; oldTranslationGroupId?: string | null; translationGroupId?: string | null }
    ): SaveEntityResult => ({
        id: articleId,
        nodeId: articleId,
        versionId: verId,
        versionNumber: verNum,
        isEdit: isEditMode,
        unchanged,
        siteId,
        slug: localizedPath,
        title,
        type: 'article',
        locale,
        status,
        extraDirtyPaths: extra?.extraDirtyPaths,
        extraPurgePaths: extra?.extraPurgePaths,
        oldTranslationGroupId: extra?.oldTranslationGroupId ?? null,
        translationGroupId: extra?.translationGroupId ?? null
    });

    if (isEdit) {
        const existing = await findArticleForVcs(dal.db, articleId);
        if (existing && existing.site_id !== siteId) {
            throw new Error('FORBIDDEN_CROSS_SITE_ACCESS');
        }
        const latestVer = existing ? await findLatestArticleVersion(dal.db, articleId) : null;

        if (existing && latestVer) {
            const explicitPublishedAt = normalizePublishedAtInput(data.publishedAt ?? data.published_at, existing.published_at);
            const isContentUnchanged = (latestVer.content_raw || '') === contentRaw;
            const isTitleUnchanged = existing.title === title;
            const isSlugUnchanged = existing.slug === slug;
            const isLocaleUnchanged = (existing.locale || 'zh-CN') === locale;
            const isSummaryUnchanged = (existing.summary || '') === summary;
            const isMaturityUnchanged = (existing.maturity || 'none') === maturity;
            const existingMetaStr = typeof existing.metadata === 'string' ? existing.metadata : JSON.stringify(existing.metadata || {});
            const isMetaUnchanged = existingMetaStr === finalMetadataStr;
            const isStatusUnchanged = existing.status === status;
            const isVisibilityUnchanged = (existing.visibility || 'public') === visibility;
            const targetTgId = data.translationGroupId !== undefined ? (data.translationGroupId || null) : (existing.translation_group_id || null);
            const isTgUnchanged = (existing.translation_group_id || null) === targetTgId;
            const isPublishedAtUnchanged = explicitPublishedAt === undefined || (existing.published_at || null) === explicitPublishedAt;

            if (isContentUnchanged && isTitleUnchanged && isSlugUnchanged && isLocaleUnchanged && isSummaryUnchanged && isMaturityUnchanged && isMetaUnchanged && isStatusUnchanged && isVisibilityUnchanged && isTgUnchanged && isPublishedAtUnchanged) {
                return makeResult(latestVer.id, latestVer.version_number, true, true);
            }

            const oldTgId = existing.translation_group_id || parseJson<Record<string, any>>(existingMetaStr, {}).translation_group_id || null;
            const oldAliases = normalizeAliasesList(parseJson<Record<string, any>>(existingMetaStr, {}).aliases);
            const oldLocalizedPath = buildLocalizedRoutePath(normalizeRoutePath(existing.slug), existing.locale || siteDefaultLocale, siteDefaultLocale);
            const changedAliasPaths = Array.from(new Set([...oldAliases, ...normalizedAliases]));
            const changedSelfPath = Array.from(new Set([
                ...((!isSlugUnchanged || !isLocaleUnchanged || !isStatusUnchanged || !isVisibilityUnchanged) && oldLocalizedPath !== localizedPath
                    ? [oldLocalizedPath]
                    : (status !== 'published' || visibility !== 'public' ? [oldLocalizedPath] : [])),
                ...changedAliasPaths
            ]));

            if (isContentUnchanged) {
                await dal.batch([
                    buildUpdateArticleMetadataOnlyStatement(dal.db, {
                        title,
                        slug,
                        locale,
                        translationGroupId: targetTgId,
                        maturity,
                        status,
                        visibility,
                        summary,
                        metadataStr: finalMetadataStr,
                        publishedAt: explicitPublishedAt,
                        articleId,
                        siteId
                    }),
                    ...buildArticleRouteStmts(targetTgId)
                ]);
                invalidateSiteMemoryCache(siteId);
                if (!isTitleUnchanged || !isSlugUnchanged) {
                    await syncWikiRelationsBatch(dal, siteId, articleId, 'article', contentRaw, locale);
                }
                const inboundDirtyPaths = (!isSlugUnchanged || !isStatusUnchanged || !isVisibilityUnchanged || !isTitleUnchanged)
                    ? await findInboundRelationSourcePaths(dal.db, siteId, articleId, [existing.slug, existing.title, slug, title], siteDefaultLocale)
                    : undefined;
                return makeResult(latestVer.id, latestVer.version_number, false, true, {
                    extraDirtyPaths: inboundDirtyPaths,
                    extraPurgePaths: changedSelfPath,
                    oldTranslationGroupId: oldTgId,
                    translationGroupId: targetTgId
                });
            }

            const maxVer = await findMaxEntityVersionNumber(dal.db, 'article', articleId);
            const nextVersionNumber = Math.max(latestVer.version_number, maxVer) + 1;
            const newVersionId = nanoId('ver');
            const nowIso = new Date().toISOString();

            await dal.batch([
                buildInsertArticleVersionStatement(dal.db, {
                    id: newVersionId,
                    siteId,
                    articleId,
                    versionNumber: nextVersionNumber,
                    title,
                    summary,
                    contentRaw,
                    metadataSnapshot: finalMetadataStr,
                    commitMessage: commitMessage || `Version v${nextVersionNumber}`,
                    authorId,
                    createdAt: nowIso
                }),
                buildUpdateArticleWithVersionStatement(dal.db, {
                    title,
                    slug,
                    locale,
                    translationGroupId: targetTgId,
                    maturity,
                    status,
                    visibility,
                    summary,
                    metadataStr: finalMetadataStr,
                    publishedAt: explicitPublishedAt,
                    versionId: newVersionId,
                    articleId,
                    siteId
                }),
                ...buildArticleRouteStmts(targetTgId)
            ]);
            invalidateSiteMemoryCache(siteId);

            await syncWikiRelationsBatch(dal, siteId, articleId, 'article', contentRaw, locale);
            const inboundDirtyPaths = (!isSlugUnchanged || !isStatusUnchanged || !isVisibilityUnchanged || !isTitleUnchanged)
                ? await findInboundRelationSourcePaths(dal.db, siteId, articleId, [existing.slug, existing.title, slug, title], siteDefaultLocale)
                : undefined;

            return makeResult(newVersionId, nextVersionNumber, false, true, {
                extraDirtyPaths: inboundDirtyPaths,
                extraPurgePaths: changedSelfPath,
                oldTranslationGroupId: oldTgId,
                translationGroupId: targetTgId
            });
        }
    }

    const newVersionId = nanoId('ver');
    const nowIso = new Date().toISOString();
    const explicitPublishedAt = normalizePublishedAtInput(data.publishedAt ?? data.published_at);
    const publishedAt = explicitPublishedAt ?? (status === 'published' ? nowIso : null);
    const initialTgId = data.translationGroupId || null;

    await dal.batch([
        buildInsertArticleStatement(dal.db, {
            id: articleId,
            siteId,
            slug,
            locale,
            translationGroupId: initialTgId,
            maturity,
            status,
            visibility,
            title,
            summary,
            metadataStr: finalMetadataStr,
            currentVersionId: newVersionId,
            curatorId: authorId,
            publishedAt,
            createdAt: nowIso,
            updatedAt: nowIso
        }),
        buildInsertArticleVersionStatement(dal.db, {
            id: newVersionId,
            siteId,
            articleId,
            versionNumber: 1,
            title,
            summary,
            contentRaw,
            metadataSnapshot: finalMetadataStr,
            commitMessage: commitMessage || 'Initial release',
            authorId,
            createdAt: nowIso
        }),
        ...buildArticleRouteStmts(initialTgId)
    ]);
    invalidateSiteMemoryCache(siteId);

    await syncWikiRelationsBatch(dal, siteId, articleId, 'article', contentRaw, locale);
    const inboundDirtyPaths = await findInboundRelationSourcePaths(dal.db, siteId, articleId, [slug, title], siteDefaultLocale);

    return makeResult(newVersionId, 1, false, false, {
        extraDirtyPaths: inboundDirtyPaths,
        translationGroupId: initialTgId
    });
}

export const articlePlugin: WalnutPlugin = {
    name: 'article',
    setup(engine) {
        for (const action of ['ARTICLE_SAVE', 'NODE_SAVE'] as const) {
            engine.registerService<SaveNodePayload, SaveNodeResult>(action, async (ctx) => {
                return await persistArticleWithVcs(ctx);
            });

            engine.tapAfter<SaveNodePayload, SaveNodeResult>(action, async (ctx) => {
                await syncSavedEntityCacheAfterHook(ctx);
            });
        }

        for (const action of ['CONTENT_DELETE', 'NODE_DELETE'] as const) {
            engine.registerService<{ id: string; siteId?: string }, { success: boolean; siteId?: string; slug?: string; type?: string; localizedPath?: string; translationGroupId?: string | null; isTemplate?: boolean }>(
                action,
                async (ctx) => {
                    const nodeId = ctx.data.id;
                    const scopeSiteId = await requireScopedSiteAdmin(ctx);
                    const isSuper = ctx.user?.global_role === 'superadmin';
                    const node = await findNodeSiteAndSlug(ctx.dal.db, nodeId, isSuper ? undefined : scopeSiteId);
                    if (!node) throw new Error('FORBIDDEN_CROSS_SITE_ACCESS');
                    const entityType = node.type || 'article';
                    const existingNode = await findNodeById(ctx.dal.db, nodeId, entityType, node.site_id);
                    const nodeMeta = parseJson<Record<string, any>>(existingNode?.metadata, {});
                    const isTemplate = entityType === 'page' && nodeMeta.page_type === 'template';
                    if (isTemplate) {
                        const deps = await findActiveTemplateDependents(ctx.dal.db, node.site_id, nodeId, node.slug);
                        if (deps.isDefaultTemplate || deps.referencingPageCount > 0) {
                            throw new Error('TEMPLATE_IN_USE_CANNOT_DELETE');
                        }
                    }
                    const localizedPath = await resolveNodeLocalizedRoutePath(ctx.dal, node.site_id, entityType, node.slug, existingNode?.locale, existingNode?.parent_id);
                    const translationGroupId = existingNode?.translation_group_id || nodeMeta.translation_group_id || null;
                    await ctx.dal.batch(buildSoftDeleteNodeStatements(ctx.dal.db, nodeId, entityType, node.site_id));

                    return {
                        success: true,
                        siteId: node.site_id,
                        slug: node.slug,
                        type: entityType,
                        localizedPath,
                        translationGroupId,
                        isTemplate
                    };
                }
            );

            engine.tapAfter<{ id: string }, { success: boolean; siteId?: string; slug?: string; type?: string; localizedPath?: string; translationGroupId?: string | null; isTemplate?: boolean }>(
                action,
                async (ctx) => {
                    if (ctx.result?.siteId) {
                        const sId = ctx.result.siteId;
                        const site = await ctx.dal.findSiteById(sId);
                        const peerPaths = await markTranslationGroupPeersDirty(ctx.dal.db, sId, ctx.data.id, ctx.result.translationGroupId);
                        const inboundPaths = await findInboundRelationSourcePaths(ctx.dal.db, sId, ctx.data.id, ctx.result.slug ? [ctx.result.slug] : [], site?.default_locale || 'zh-CN');
                        await removeEntityFromSiteRoutes(ctx.dal.db, sId, ctx.data.id);
                        const depKey = ctx.result.type === 'micro' ? 'micro:*' : 'article:*';
                        await markRoutesDirtyByDependency(ctx.dal.db, sId, [depKey], ['/', '/sitemap.xml', '/feed.xml', '/feed.json']);
                        if (inboundPaths.length > 0) {
                            await markSiteRoutesDirty(ctx.dal.db, sId, inboundPaths);
                        }
                        if (ctx.result.isTemplate) {
                            await buildMarkAllNonRedirectSiteRoutesDirtyStatement(ctx.dal.db, sId).run();
                        }
                        const normSlugPath = ctx.result.localizedPath || (ctx.result.slug !== undefined ? normalizeRoutePath(ctx.result.slug) : '/');
                        await purgeEdgeAndZoneCache(ctx.dal.db, sId, [normSlugPath, ...peerPaths, ...inboundPaths, '/', '/sitemap.xml', '/feed.xml', '/feed.json'], { purgeEverything: Boolean(ctx.result.isTemplate) });
                        if (site) {
                            await rebuildSiteSitemapRoute(ctx.dal.db, site, ctx.host);
                        }
                    }
                }
            );
        }

        engine.registerService<
            { nodeIds: string[]; siteId?: string },
            { success: boolean; count: number; removedNodes: Array<{ id: string; site_id: string; slug: string; localizedPath?: string; translationGroupId?: string | null; type: string; isTemplate?: boolean }> }
        >('NODE_BATCH_SOFT_DELETE', async (ctx) => {
            const scopeSiteId = await requireScopedSiteAdmin(ctx);
            const isSuper = ctx.user?.global_role === 'superadmin';
            const nodeIds = Array.isArray(ctx.data.nodeIds) ? ctx.data.nodeIds : [];
            if (nodeIds.length === 0) {
                return { success: true, count: 0, removedNodes: [] };
            }

            const removedNodes: Array<{ id: string; site_id: string; slug: string; localizedPath?: string; translationGroupId?: string | null; type: string; isTemplate?: boolean }> = [];
            const statements: D1PreparedStatement[] = [];

            for (const id of nodeIds) {
                const node = await findNodeSiteAndSlug(ctx.dal.db, id, isSuper ? undefined : scopeSiteId);
                if (!node) throw new Error('FORBIDDEN_CROSS_SITE_ACCESS');
                const entityType = node.type || 'article';
                const existingNode = await findNodeById(ctx.dal.db, id, entityType, node.site_id);
                const nodeMeta = parseJson<Record<string, any>>(existingNode?.metadata, {});
                let isTemplate = false;
                if (entityType === 'page' && nodeMeta.page_type === 'template') {
                    isTemplate = true;
                    const deps = await findActiveTemplateDependents(ctx.dal.db, node.site_id, id, node.slug);
                    if (deps.isDefaultTemplate || deps.referencingPageCount > 0) {
                        throw new Error('TEMPLATE_IN_USE_CANNOT_DELETE');
                    }
                }
                const localizedPath = await resolveNodeLocalizedRoutePath(ctx.dal, node.site_id, entityType, node.slug, existingNode?.locale, existingNode?.parent_id);
                const translationGroupId = existingNode?.translation_group_id || nodeMeta.translation_group_id || null;
                removedNodes.push({ id, site_id: node.site_id, slug: node.slug, localizedPath, translationGroupId, type: entityType, isTemplate });
                statements.push(...buildSoftDeleteNodeStatements(ctx.dal.db, id, entityType, node.site_id));
                statements.push(buildDeleteEntitySiteRoutesStatement(ctx.dal.db, node.site_id, id));
            }

            await ctx.dal.batch(statements);
            return { success: true, count: nodeIds.length, removedNodes };
        });

        engine.tapAfter<
            { nodeIds: string[] },
            { success: boolean; count: number; removedNodes: Array<{ id: string; site_id: string; slug: string; localizedPath?: string; translationGroupId?: string | null; type: string; isTemplate?: boolean }> }
        >('NODE_BATCH_SOFT_DELETE', async (ctx) => {
            const sitePaths = new Map<string, Set<string>>();
            const siteTypes = new Map<string, Set<string>>();
            const templateSites = new Set<string>();
            const inboundItemsBySite = new Map<string, Array<{ id: string; slug: string; tgId?: string | null }>>();
            for (const node of ctx.result?.removedNodes ?? []) {
                if (!sitePaths.has(node.site_id)) sitePaths.set(node.site_id, new Set(['/', '/sitemap.xml', '/feed.xml', '/feed.json']));
                if (!siteTypes.has(node.site_id)) siteTypes.set(node.site_id, new Set());
                if (!inboundItemsBySite.has(node.site_id)) inboundItemsBySite.set(node.site_id, []);
                if (node.localizedPath) sitePaths.get(node.site_id)!.add(node.localizedPath);
                else if (node.slug) sitePaths.get(node.site_id)!.add(normalizeRoutePath(node.slug));
                siteTypes.get(node.site_id)!.add(node.type);
                inboundItemsBySite.get(node.site_id)!.push({ id: node.id, slug: node.slug, tgId: node.translationGroupId });
                if (node.isTemplate) templateSites.add(node.site_id);
            }
            for (const [siteId, paths] of sitePaths) {
                const site = await ctx.dal.findSiteById(siteId);
                const types = siteTypes.get(siteId)!;
                const deps = [
                    ...(types.has('micro') ? ['micro:*'] : []),
                    ...(types.has('article') ? ['article:*'] : [])
                ];
                if (deps.length > 0) {
                    await markRoutesDirtyByDependency(ctx.dal.db, siteId, deps, ['/']);
                }
                for (const item of inboundItemsBySite.get(siteId) || []) {
                    const peerPaths = await markTranslationGroupPeersDirty(ctx.dal.db, siteId, item.id, item.tgId);
                    peerPaths.forEach(p => paths.add(p));
                    const inPaths = await findInboundRelationSourcePaths(ctx.dal.db, siteId, item.id, item.slug ? [item.slug] : [], site?.default_locale || 'zh-CN');
                    inPaths.forEach(p => paths.add(p));
                }
                if (templateSites.has(siteId)) {
                    await buildMarkAllNonRedirectSiteRoutesDirtyStatement(ctx.dal.db, siteId).run();
                } else {
                    await markSiteRoutesDirty(ctx.dal.db, siteId, Array.from(paths));
                }
                await purgeEdgeAndZoneCache(ctx.dal.db, siteId, Array.from(paths), { purgeEverything: templateSites.has(siteId) });
                if (site) {
                    await rebuildSiteSitemapRoute(ctx.dal.db, site, ctx.host);
                }
            }
        });

        engine.tapBefore<{ nodeIds: string[]; folder: string }>('NODE_BATCH_MOVE_FOLDER', (ctx) => {
            if (!Array.isArray(ctx.data.nodeIds) || ctx.data.nodeIds.length === 0) {
                throw new Error('NO_NODES_SELECTED');
            }
        });

        engine.registerService<
            { nodeIds: string[]; folder: string; siteId?: string },
            { success: boolean; count: number; folder: string }
        >('NODE_BATCH_MOVE_FOLDER', async (ctx) => {
            const scopeSiteId = await requireScopedSiteAdmin(ctx);
            const isSuper = ctx.user?.global_role === 'superadmin';
            const { nodeIds, folder } = ctx.data;
            const statements: D1PreparedStatement[] = [];

            for (const nid of nodeIds) {
                const node = await findNodeMetadataById(ctx.dal.db, nid, isSuper ? undefined : scopeSiteId);
                if (!node) throw new Error('FORBIDDEN_CROSS_SITE_ACCESS');
                const metaObj = parseJson<Record<string, any>>(node.metadata, {});
                metaObj.folder = folder;
                statements.push(...buildMoveNodeFolderStatements(ctx.dal.db, nid, JSON.stringify(metaObj), isSuper ? undefined : scopeSiteId));
            }

            if (statements.length > 0) {
                await ctx.dal.batch(statements);
            }

            return { success: true, count: nodeIds.length, folder };
        });

        for (const action of ['CONTENT_RESTORE', 'NODE_RESTORE'] as const) {
            engine.registerService<{ id: string; siteId?: string }, { success: boolean; restoredNode?: any }>(
                action,
                async (ctx) => {
                    const nodeId = ctx.data.id;
                    const scopeSiteId = await requireScopedSiteAdmin(ctx);
                    const isSuper = ctx.user?.global_role === 'superadmin';
                    const existing = await findRestoredNodeById(ctx.dal.db, nodeId, isSuper ? undefined : scopeSiteId);
                    if (!existing) throw new Error('FORBIDDEN_CROSS_SITE_ACCESS');
                    const activeVersions = await findLatestVersionIdsForNode(ctx.dal.db, nodeId);

                    await ctx.dal.batch(buildRestoreNodeStatements(ctx.dal.db, nodeId, activeVersions, existing.type, existing.site_id));
                    const restoredNode = await findRestoredNodeById(ctx.dal.db, nodeId, existing.site_id);

                    return { success: true, restoredNode };
                }
            );

            engine.tapAfter<{ id: string }, { success: boolean; restoredNode?: any }>(
                action,
                async (ctx) => {
                    const node = ctx.result?.restoredNode;
                    if (!node || node.status !== 'published') return;
                    if (node.type === 'micro') {
                        await markRoutesDirtyByDependency(ctx.dal.db, node.site_id, ['micro:*'], ['/', '/feed.xml', '/feed.json']);
                        await purgeEdgeAndZoneCache(ctx.dal.db, node.site_id, ['/', '/feed.xml', '/feed.json']);
                        return;
                    }
                    const nodeMeta = parseJson<Record<string, any>>(node.metadata, {});
                    if (node.type === 'dataset') {
                        invalidateQueryCache(node.site_id);
                        const keys = nodeMeta.schema_slug ? [`dataset:${nodeMeta.schema_slug}`, 'dataset:*'] : ['dataset:*'];
                        await markRoutesDirtyByDependency(ctx.dal.db, node.site_id, keys, ['/']);
                        await purgeEdgeAndZoneCache(ctx.dal.db, node.site_id, ['/']);
                        return;
                    }
                    if (node.type === 'page' && nodeMeta.page_type === 'template') return;
                    const tgId = node.translation_group_id || nodeMeta.translation_group_id || null;
                    const peerPaths = await markTranslationGroupPeersDirty(ctx.dal.db, node.site_id, node.id, tgId);
                    if (isRestrictedAccess(node.visibility, nodeMeta)) {
                        await purgeEdgeAndZoneCache(ctx.dal.db, node.site_id, [...peerPaths]);
                        return;
                    }
                    let rawRoute = node.slug;
                    if (node.type === 'page' && node.parent_id) {
                        const parentSlug = await findPageSlugById(ctx.dal.db, node.parent_id);
                        if (parentSlug) {
                            rawRoute = `${parentSlug.replace(/^\/+|\/+$/g, '')}/${String(node.slug || '').replace(/^\/+|\/+$/g, '')}`;
                        }
                    }
                    const normPath = normalizeRoutePath(rawRoute);
                    const site = await ctx.dal.findSiteById(node.site_id);
                    const siteDefaultLocale = site?.default_locale || 'zh-CN';
                    const nodeLocale = node.locale || siteDefaultLocale;
                    const localizedPath = buildLocalizedRoutePath(normPath, nodeLocale, siteDefaultLocale);
                    const isRedirect = node.type === 'page' && nodeMeta.page_type === 'redirect';
                    await ctx.dal.batch([
                        buildUpsertSiteRouteStatement(ctx.dal.db, {
                            siteId: node.site_id,
                            path: localizedPath,
                            entityType: isRedirect ? 'redirect' : node.type,
                            entityId: node.id,
                            locale: nodeLocale,
                            translationGroupId: tgId,
                            title: node.title || 'Untitled',
                            renderedHtml: null,
                            statusCode: isRedirect ? (parseInt(nodeMeta.redirect_code) || 301) : 200,
                            redirectTarget: isRedirect ? (nodeMeta.redirect_url || '/') : null,
                            isDirty: isRedirect ? 0 : 1
                        })
                    ]);
                    if (node.type === 'article') {
                        await markRoutesDirtyByDependency(ctx.dal.db, node.site_id, ['article:*'], ['/']);
                    }
                    const inboundPaths = await findInboundRelationSourcePaths(ctx.dal.db, node.site_id, node.id, [node.slug, node.title].filter(Boolean), siteDefaultLocale);
                    if (inboundPaths.length > 0) {
                        await markSiteRoutesDirty(ctx.dal.db, node.site_id, inboundPaths);
                    }
                    await purgeEdgeAndZoneCache(ctx.dal.db, node.site_id, [localizedPath, ...peerPaths, ...inboundPaths, '/', '/sitemap.xml', '/feed.xml', '/feed.json']);
                    if (site) {
                        await rebuildSiteSitemapRoute(ctx.dal.db, site, ctx.host);
                    }
                }
            );
        }

        engine.registerService<{ nodeIds: string[]; siteId?: string }, { success: boolean; count: number; restoredNodes: any[] }>(
            'CONTENT_BATCH_RESTORE',
            async (ctx) => {
                const scopeSiteId = await requireScopedSiteAdmin(ctx);
                const isSuper = ctx.user?.global_role === 'superadmin';
                const nodeIds = Array.isArray(ctx.data.nodeIds) ? ctx.data.nodeIds : [];
                if (nodeIds.length === 0) {
                    return { success: true, count: 0, restoredNodes: [] };
                }

                const statements: D1PreparedStatement[] = [];
                const targetIds: Array<{ id: string; siteId: string }> = [];
                for (const id of nodeIds) {
                    const existing = await findRestoredNodeById(ctx.dal.db, id, isSuper ? undefined : scopeSiteId);
                    if (!existing) throw new Error('FORBIDDEN_CROSS_SITE_ACCESS');
                    statements.push(...buildRestoreNodeStatements(ctx.dal.db, id, {}, existing.type, existing.site_id));
                    targetIds.push({ id, siteId: existing.site_id });
                }

                await ctx.dal.batch(statements);
                const restoredNodes: any[] = [];
                for (const item of targetIds) {
                    const r = await findRestoredNodeById(ctx.dal.db, item.id, item.siteId);
                    if (r) restoredNodes.push(r);
                }
                return { success: true, count: nodeIds.length, restoredNodes };
            }
        );

        engine.tapAfter<{ nodeIds: string[] }, { success: boolean; count: number; restoredNodes: any[] }>(
            'CONTENT_BATCH_RESTORE',
            async (ctx) => {
                const nodes = ctx.result?.restoredNodes || [];
                const bySite = new Map<string, any[]>();
                for (const n of nodes) {
                    if (!n || n.status !== 'published') continue;
                    const list = bySite.get(n.site_id) || [];
                    list.push(n);
                    bySite.set(n.site_id, list);
                }
                for (const [siteId, list] of bySite) {
                    const site = await ctx.dal.findSiteById(siteId);
                    const defaultLoc = site?.default_locale || 'zh-CN';
                    const depKeys = new Set<string>();
                    const dirtyPaths = new Set<string>(['/', '/sitemap.xml', '/feed.xml', '/feed.json']);
                    const routeStmts: D1PreparedStatement[] = [];
                    for (const node of list) {
                        if (node.type === 'micro') {
                            depKeys.add('micro:*');
                            continue;
                        }
                        if (node.type === 'dataset') {
                            depKeys.add('dataset:*');
                            invalidateQueryCache(siteId);
                            continue;
                        }
                        if (node.type === 'article') depKeys.add('article:*');
                        const nodeMeta = parseJson<Record<string, any>>(node.metadata, {});
                        if (node.type === 'page' && nodeMeta.page_type === 'template') continue;
                        const tgId = node.translation_group_id || nodeMeta.translation_group_id || null;
                        const peers = await markTranslationGroupPeersDirty(ctx.dal.db, siteId, node.id, tgId);
                        peers.forEach(p => dirtyPaths.add(p));
                        if (isRestrictedAccess(node.visibility, nodeMeta)) continue;
                        const parentSlug = (node.type === 'page' && node.parent_id) ? await findPageSlugById(ctx.dal.db, node.parent_id) : null;
                        const normPath = normalizeRoutePath(node.slug, parentSlug);
                        const locPath = buildLocalizedRoutePath(normPath, node.locale || defaultLoc, defaultLoc);
                        const isRedir = node.type === 'page' && nodeMeta.page_type === 'redirect';
                        routeStmts.push(buildUpsertSiteRouteStatement(ctx.dal.db, {
                            siteId,
                            path: locPath,
                            entityType: isRedir ? 'redirect' : node.type,
                            entityId: node.id,
                            locale: node.locale || defaultLoc,
                            translationGroupId: tgId,
                            title: node.title || 'Untitled',
                            renderedHtml: null,
                            statusCode: isRedir ? (parseInt(nodeMeta.redirect_code) || 301) : 200,
                            redirectTarget: isRedir ? (nodeMeta.redirect_url || '/') : null,
                            isDirty: isRedir ? 0 : 1
                        }));
                        dirtyPaths.add(locPath);
                    }
                    if (routeStmts.length > 0) await ctx.dal.batch(routeStmts);
                    if (depKeys.size > 0) await markRoutesDirtyByDependency(ctx.dal.db, siteId, Array.from(depKeys), ['/']);
                    await purgeEdgeAndZoneCache(ctx.dal.db, siteId, Array.from(dirtyPaths));
                    if (site) await rebuildSiteSitemapRoute(ctx.dal.db, site, ctx.host);
                }
            }
        );

        engine.registerService<{ id: string; siteId?: string }, { success: boolean; siteId?: string; slug?: string; type?: string }>(
            'CONTENT_PURGE',
            async (ctx) => {
                const nodeId = ctx.data.id;
                const scopeSiteId = await requireScopedSiteAdmin(ctx);
                const isSuper = ctx.user?.global_role === 'superadmin';
                const node = await findNodeSiteAndSlug(ctx.dal.db, nodeId, isSuper ? undefined : scopeSiteId);
                if (!node) throw new Error('FORBIDDEN_CROSS_SITE_ACCESS');

                const stmts = buildHardDeleteNodeStatements(ctx.dal.db, nodeId, node.type, node.site_id);
                if (node.type === 'dataset') {
                    stmts.push(buildCleanupOrphanedDeletedDatasetCollectionsStatement(ctx.dal.db, node.site_id));
                }
                await ctx.dal.batch(stmts);
                return { success: true, siteId: node.site_id, slug: node.slug, type: node.type };
            }
        );

        engine.tapAfter<{ id: string }, { success: boolean; siteId?: string; slug?: string; type?: string }>(
            'CONTENT_PURGE',
            async (ctx) => {
                if (ctx.result?.siteId) {
                    const sId = ctx.result.siteId;
                    if (ctx.result.type === 'dataset') {
                        invalidateQueryCache(sId);
                        await markRoutesDirtyByDependency(ctx.dal.db, sId, ['dataset:*'], ['/']);
                        await purgeEdgeAndZoneCache(ctx.dal.db, sId, ['/']);
                        return;
                    }
                    const peerPaths = await markTranslationGroupPeersDirty(ctx.dal.db, sId, ctx.data.id);
                    await removeEntityFromSiteRoutes(ctx.dal.db, sId, ctx.data.id);
                    const normSlugPath = ctx.result.slug !== undefined ? normalizeRoutePath(ctx.result.slug) : '/';
                    await purgeEdgeAndZoneCache(ctx.dal.db, sId, [normSlugPath, ...peerPaths, '/', '/sitemap.xml']);
                    const site = await ctx.dal.findSiteById(sId);
                    if (site) {
                        await rebuildSiteSitemapRoute(ctx.dal.db, site, ctx.host);
                    }
                }
            }
        );

        engine.registerService<{ nodeIds: string[]; siteId?: string }, { success: boolean; count: number }>(
            'CONTENT_BATCH_HARD_DELETE',
            async (ctx) => {
                const scopeSiteId = await requireScopedSiteAdmin(ctx);
                const isSuper = ctx.user?.global_role === 'superadmin';
                const nodeIds = Array.isArray(ctx.data.nodeIds) ? ctx.data.nodeIds : [];
                if (nodeIds.length === 0) {
                    return { success: true, count: 0 };
                }

                const statements: D1PreparedStatement[] = [];
                for (const id of nodeIds) {
                    const node = await findNodeSiteAndSlug(ctx.dal.db, id, isSuper ? undefined : scopeSiteId);
                    if (!node) throw new Error('FORBIDDEN_CROSS_SITE_ACCESS');
                    statements.push(...buildHardDeleteNodeStatements(ctx.dal.db, id, node.type, node.site_id));
                }

                await ctx.dal.batch(statements);
                return { success: true, count: nodeIds.length };
            }
        );

        engine.registerService<{ siteId: string; category: string }, { success: boolean }>(
            'TRASH_EMPTY',
            async (ctx) => {
                const siteId = await requireScopedSiteAdmin(ctx);
                const category = normalizeTrashCategory(ctx.data.category);

                const { fullyDeletedIds, softDeletedVersionOnlyIds } = await findDeletedItemIdsForEmptyTrash(ctx.dal.db, siteId, category);
                const statements: D1PreparedStatement[] = [];
                for (const id of fullyDeletedIds) {
                    statements.push(...buildHardDeleteNodeStatements(ctx.dal.db, id, category, siteId));
                    if (category === 'article' || category === 'page') {
                        statements.push(buildDeleteEntitySiteRoutesStatement(ctx.dal.db, siteId, id));
                    }
                }
                for (const id of softDeletedVersionOnlyIds) {
                    statements.push(...buildHardDeleteDeletedVersionsForEntityStatements(ctx.dal.db, category, id, siteId));
                }
                if (category === 'dataset') {
                    statements.push(buildCleanupOrphanedDeletedDatasetCollectionsStatement(ctx.dal.db, siteId));
                }

                for (let i = 0; i < statements.length; i += 50) {
                    await ctx.dal.batch(statements.slice(i, i + 50));
                }
                if (category === 'dataset') {
                    invalidateQueryCache(siteId);
                    await markRoutesDirtyByDependency(ctx.dal.db, siteId, ['dataset:*'], ['/']);
                }
                return { success: true };
            }
        );

        registerArticleVcsAndChunkServices(engine);
    }
};
