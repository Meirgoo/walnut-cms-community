import type { D1PreparedStatement } from '@cloudflare/workers-types';
import type { WalnutPlugin, HookContext, ArticleMaturity, ArticleStatus } from '../types';
import { nanoId } from '../kernel';
import {
    normalizeRoutePath,
    removeEntityFromSiteRoutes,
    rebuildSiteSitemapRoute,
    assertSiteRouteUnique,
    buildUpsertSiteRouteStatement,
    buildDeleteOtherSiteRoutesStatement,
    buildDeleteEntitySiteRoutesStatement,
    buildMarkHomeAndSitemapRoutesDirtyStatement,
    buildTouchSiteUpdatedAtStatement,
    markSiteRoutesDirty,
    markRoutesDirtyByDependency,
    purgeEdgeAndZoneCache,
    findPageSlugById,
    findNodeSiteAndSlug,
    findNodeMetadataById,
    findLatestVersionIdsForNode,
    findRestoredNodeById,
    findDeletedEntityIdsForEmptyTrash,
    findMaxEntityVersionNumber,
    buildSoftDeleteNodeStatements,
    buildRestoreNodeStatements,
    buildHardDeleteNodeStatements,
    buildSoftDeleteVersionStatements,
    buildRestoreVersionStatements,
    buildHardDeleteVersionStatements,
    buildMoveNodeFolderStatements,
    buildCreateTranslationGroupStatement,
    buildDeleteTranslationGroupStatements,
    buildJoinTranslationGroupStatement,
    buildLeaveTranslationGroupStatement,
    saveArticleChunkInPlace,
    findArticleForVcs,
    findLatestArticleVersion,
    buildUpdateArticleMetadataOnlyStatement,
    buildInsertArticleVersionStatement,
    buildUpdateArticleWithVersionStatement,
    buildInsertArticleStatement,
    invalidateSiteMemoryCache
} from '../core/dal';
import {
    resolveActiveSiteId,
    assertSiteAdmin,
    normalizeEntitySlug,
    syncWikiRelationsBatch,
    syncSavedEntityCacheAfterHook,
    SaveEntityPayload,
    SaveEntityResult,
    SaveNodePayload,
    SaveNodeResult
} from './common.helper';
import { parseJson } from '../core/utils';

export async function persistArticleWithVcs(
    ctx: HookContext<SaveEntityPayload, SaveEntityResult>
): Promise<SaveEntityResult> {
    const { dal, data, user } = ctx;
    const siteId = await resolveActiveSiteId(dal, data.siteId || ctx.siteId);
    await assertSiteAdmin(dal, siteId, user);

    const authorId = user?.id || 'admin';
    const isEdit = !!(data.isEdit && data.id);
    const articleId = data.id || nanoId('art');
    const locale = data.locale || ctx.locale || 'zh-CN';
    const maturity: ArticleMaturity = data.maturity || 'none';
    const status: ArticleStatus = data.status || 'published';
    const summary = data.summary || '';
    const contentRaw = data.contentRaw || '';
    const commitMessage = (data.commitMessage || '').trim();
    const metadataStr = JSON.stringify(data.metadata || {});

    let title = (data.title || '').trim() || 'Untitled Article';
    const slug = normalizeEntitySlug(data.slug, 'article');
    const routePath = normalizeRoutePath(slug);

    await assertSiteRouteUnique(dal.db, siteId, routePath, isEdit ? articleId : null, ctx.locale || locale);

    const articleMeta = data.metadata || {};
    const articleTemplateId = articleMeta.template_id || articleMeta.template_slug || null;
    const articleSchemaSlug = articleMeta.schema_slug || null;

    const buildArticleRouteStmts = (targetTgId: string | null): D1PreparedStatement[] => {
        const nowIso = new Date().toISOString();
        const stmts: D1PreparedStatement[] = [
            buildDeleteOtherSiteRoutesStatement(dal.db, siteId, articleId, routePath)
        ];
        if (status === 'published') {
            stmts.push(
                buildUpsertSiteRouteStatement(dal.db, {
                    siteId,
                    path: routePath,
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

    const makeResult = (verId: string, verNum: number, unchanged: boolean, isEditMode: boolean): SaveEntityResult => ({
        id: articleId,
        nodeId: articleId,
        versionId: verId,
        versionNumber: verNum,
        isEdit: isEditMode,
        unchanged,
        siteId,
        slug: routePath,
        title,
        type: 'article',
        locale,
        status
    });

    if (isEdit) {
        const existing = await findArticleForVcs(dal.db, articleId);
        const latestVer = await findLatestArticleVersion(dal.db, articleId);

        if (existing && latestVer) {
            const isContentUnchanged = (latestVer.content_raw || '') === contentRaw;
            const isTitleUnchanged = existing.title === title;
            const isSlugUnchanged = existing.slug === slug;
            const isLocaleUnchanged = (existing.locale || 'zh-CN') === locale;
            const isSummaryUnchanged = (existing.summary || '') === summary;
            const isMaturityUnchanged = (existing.maturity || 'none') === maturity;
            const existingMetaStr = typeof existing.metadata === 'string' ? existing.metadata : JSON.stringify(existing.metadata || {});
            const isMetaUnchanged = existingMetaStr === metadataStr;
            const isStatusUnchanged = existing.status === status;
            const targetTgId = data.translationGroupId !== undefined ? (data.translationGroupId || null) : (existing.translation_group_id || null);
            const isTgUnchanged = (existing.translation_group_id || null) === targetTgId;

            if (isContentUnchanged && isTitleUnchanged && isSlugUnchanged && isLocaleUnchanged && isSummaryUnchanged && isMaturityUnchanged && isMetaUnchanged && isStatusUnchanged && isTgUnchanged) {
                return makeResult(latestVer.id, latestVer.version_number, true, true);
            }

            if (isContentUnchanged) {
                await dal.batch([
                    buildUpdateArticleMetadataOnlyStatement(dal.db, {
                        title,
                        slug,
                        locale,
                        translationGroupId: targetTgId,
                        maturity,
                        status,
                        summary,
                        metadataStr,
                        articleId
                    }),
                    ...buildArticleRouteStmts(targetTgId)
                ]);
                invalidateSiteMemoryCache(siteId);
                if (!isTitleUnchanged || !isSlugUnchanged) {
                    await syncWikiRelationsBatch(dal, siteId, articleId, 'article', contentRaw);
                }
                return makeResult(latestVer.id, latestVer.version_number, false, true);
            }

            const maxVer = await findMaxEntityVersionNumber(dal.db, 'article_versions', 'article_id', articleId);
            const nextVersionNumber = Math.max(latestVer.version_number, maxVer) + 1;
            const newVersionId = nanoId('ver');
            const nowIso = new Date().toISOString();

            await dal.batch([
                buildInsertArticleVersionStatement(dal.db, {
                    id: newVersionId,
                    articleId,
                    versionNumber: nextVersionNumber,
                    title,
                    summary,
                    contentRaw,
                    metadataSnapshot: metadataStr,
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
                    summary,
                    metadataStr,
                    versionId: newVersionId,
                    articleId
                }),
                ...buildArticleRouteStmts(targetTgId)
            ]);
            invalidateSiteMemoryCache(siteId);

            await syncWikiRelationsBatch(dal, siteId, articleId, 'article', contentRaw);

            return makeResult(newVersionId, nextVersionNumber, false, true);
        }
    }

    const newVersionId = nanoId('ver');
    const nowIso = new Date().toISOString();
    const publishedAt = status === 'published' ? nowIso : null;
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
            title,
            summary,
            metadataStr,
            currentVersionId: newVersionId,
            curatorId: authorId,
            publishedAt,
            createdAt: nowIso,
            updatedAt: nowIso
        }),
        buildInsertArticleVersionStatement(dal.db, {
            id: newVersionId,
            articleId,
            versionNumber: 1,
            title,
            summary,
            contentRaw,
            metadataSnapshot: metadataStr,
            commitMessage: commitMessage || 'Initial release',
            authorId,
            createdAt: nowIso
        }),
        ...buildArticleRouteStmts(initialTgId)
    ]);
    invalidateSiteMemoryCache(siteId);

    await syncWikiRelationsBatch(dal, siteId, articleId, 'article', contentRaw);

    return makeResult(newVersionId, 1, false, false);
}

export const articlePlugin: WalnutPlugin = {
    name: 'article',
    version: '2.2.0',

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
            engine.registerService<{ id: string }, { success: boolean; siteId?: string; slug?: string; type?: string }>(
                action,
                async (ctx) => {
                    const nodeId = ctx.data.id;
                    const node = await findNodeSiteAndSlug(ctx.dal.db, nodeId);
                    const entityType = node?.type || 'article';
                    await ctx.dal.batch(buildSoftDeleteNodeStatements(ctx.dal.db, nodeId, entityType));

                    return {
                        success: true,
                        siteId: node?.site_id,
                        slug: node?.slug,
                        type: entityType
                    };
                }
            );

            engine.tapAfter<{ id: string }, { success: boolean; siteId?: string; slug?: string; type?: string }>(
                action,
                async (ctx) => {
                    if (ctx.result?.siteId) {
                        const sId = ctx.result.siteId;
                        await removeEntityFromSiteRoutes(ctx.dal.db, sId, ctx.data.id);
                        const depKey = ctx.result.type === 'micro' ? 'micro:*' : 'article:*';
                        await markRoutesDirtyByDependency(ctx.dal.db, sId, [depKey], ['/', '/sitemap.xml', '/feed.xml', '/feed.json']);
                        const normSlugPath = ctx.result.slug !== undefined ? normalizeRoutePath(ctx.result.slug) : '/';
                        await purgeEdgeAndZoneCache(ctx.dal.db, sId, [normSlugPath, '/', '/sitemap.xml', '/feed.xml', '/feed.json']);
                        const site = await ctx.dal.findSiteById(sId);
                        if (site) {
                            await rebuildSiteSitemapRoute(ctx.dal.db, site, ctx.host);
                        }
                    }
                }
            );
        }

        engine.registerService<
            { nodeIds: string[] },
            { success: boolean; count: number; removedNodes: Array<{ site_id: string; slug: string; type: string }> }
        >('NODE_BATCH_SOFT_DELETE', async (ctx) => {
            const nodeIds = Array.isArray(ctx.data.nodeIds) ? ctx.data.nodeIds : [];
            if (nodeIds.length === 0) {
                return { success: true, count: 0, removedNodes: [] };
            }

            const removedNodes: Array<{ site_id: string; slug: string; type: string }> = [];
            const statements: D1PreparedStatement[] = [];

            for (const id of nodeIds) {
                const node = await findNodeSiteAndSlug(ctx.dal.db, id);
                const entityType = node?.type || 'article';
                if (node) {
                    removedNodes.push({ site_id: node.site_id, slug: node.slug, type: entityType });
                }
                statements.push(...buildSoftDeleteNodeStatements(ctx.dal.db, id, entityType));
                statements.push(buildDeleteEntitySiteRoutesStatement(ctx.dal.db, node?.site_id || ctx.siteId || 'site_default', id));
            }

            await ctx.dal.batch(statements);
            return { success: true, count: nodeIds.length, removedNodes };
        });

        engine.tapAfter<
            { nodeIds: string[] },
            { success: boolean; count: number; removedNodes: Array<{ site_id: string; slug: string; type: string }> }
        >('NODE_BATCH_SOFT_DELETE', async (ctx) => {
            const sitePaths = new Map<string, Set<string>>();
            const siteTypes = new Map<string, Set<string>>();
            for (const node of ctx.result?.removedNodes ?? []) {
                if (!sitePaths.has(node.site_id)) sitePaths.set(node.site_id, new Set(['/', '/sitemap.xml', '/feed.xml', '/feed.json']));
                if (!siteTypes.has(node.site_id)) siteTypes.set(node.site_id, new Set());
                if (node.slug) sitePaths.get(node.site_id)!.add(normalizeRoutePath(node.slug));
                siteTypes.get(node.site_id)!.add(node.type);
            }
            for (const [siteId, paths] of sitePaths) {
                const types = siteTypes.get(siteId)!;
                const deps = [
                    ...(types.has('micro') ? ['micro:*'] : []),
                    ...(types.has('article') ? ['article:*'] : [])
                ];
                if (deps.length > 0) {
                    await markRoutesDirtyByDependency(ctx.dal.db, siteId, deps, ['/']);
                }
                await markSiteRoutesDirty(ctx.dal.db, siteId, ['/', '/sitemap.xml', '/feed.xml', '/feed.json']);
                await purgeEdgeAndZoneCache(ctx.dal.db, siteId, Array.from(paths));
                const site = await ctx.dal.findSiteById(siteId);
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
            { nodeIds: string[]; folder: string },
            { success: boolean; count: number; folder: string }
        >('NODE_BATCH_MOVE_FOLDER', async (ctx) => {
            const { nodeIds, folder } = ctx.data;
            const statements: D1PreparedStatement[] = [];

            for (const nid of nodeIds) {
                const node = await findNodeMetadataById(ctx.dal.db, nid);
                if (node) {
                    const metaObj = parseJson<Record<string, any>>(node.metadata, {});
                    metaObj.folder = folder;
                    statements.push(...buildMoveNodeFolderStatements(ctx.dal.db, nid, JSON.stringify(metaObj)));
                }
            }

            if (statements.length > 0) {
                await ctx.dal.batch(statements);
            }

            return { success: true, count: nodeIds.length, folder };
        });

        for (const action of ['CONTENT_RESTORE', 'NODE_RESTORE'] as const) {
            engine.registerService<{ id: string }, { success: boolean; restoredNode?: any }>(
                action,
                async (ctx) => {
                    const nodeId = ctx.data.id;
                    const activeVersions = await findLatestVersionIdsForNode(ctx.dal.db, nodeId);

                    await ctx.dal.batch(buildRestoreNodeStatements(ctx.dal.db, nodeId, activeVersions));
                    const restoredNode = await findRestoredNodeById(ctx.dal.db, nodeId);

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
                    if (node.type === 'page' && nodeMeta.page_type === 'template') return;
                    let rawRoute = node.slug;
                    if (node.type === 'page' && node.parent_id) {
                        const parentSlug = await findPageSlugById(ctx.dal.db, node.parent_id);
                        if (parentSlug) {
                            rawRoute = `${parentSlug.replace(/^\/+|\/+$/g, '')}/${String(node.slug || '').replace(/^\/+|\/+$/g, '')}`;
                        }
                    }
                    const normPath = normalizeRoutePath(rawRoute);
                    const isRedirect = node.type === 'page' && nodeMeta.page_type === 'redirect';
                    await ctx.dal.batch([
                        buildUpsertSiteRouteStatement(ctx.dal.db, {
                            siteId: node.site_id,
                            path: normPath,
                            entityType: isRedirect ? 'redirect' : node.type,
                            entityId: node.id,
                            locale: node.locale || 'zh-CN',
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
                    await purgeEdgeAndZoneCache(ctx.dal.db, node.site_id, [normPath, '/', '/sitemap.xml', '/feed.xml', '/feed.json']);
                    const site = await ctx.dal.findSiteById(node.site_id);
                    if (site) {
                        await rebuildSiteSitemapRoute(ctx.dal.db, site, ctx.host);
                    }
                }
            );
        }

        for (const action of ['CONTENT_BATCH_RESTORE', 'NODE_BATCH_RESTORE'] as const) {
            engine.registerService<{ nodeIds: string[] }, { success: boolean; count: number }>(
                action,
                async (ctx) => {
                    const nodeIds = Array.isArray(ctx.data.nodeIds) ? ctx.data.nodeIds : [];
                    if (nodeIds.length === 0) {
                        return { success: true, count: 0 };
                    }

                    const statements: D1PreparedStatement[] = [];
                    for (const id of nodeIds) {
                        statements.push(...buildRestoreNodeStatements(ctx.dal.db, id, {}));
                    }

                    await ctx.dal.batch(statements);
                    return { success: true, count: nodeIds.length };
                }
            );
        }

        for (const action of ['CONTENT_PURGE', 'NODE_PURGE', 'NODE_HARD_DELETE'] as const) {
            engine.registerService<{ id: string }, { success: boolean; siteId?: string; slug?: string }>(
                action,
                async (ctx) => {
                    const nodeId = ctx.data.id;
                    const node = await findNodeSiteAndSlug(ctx.dal.db, nodeId);

                    await ctx.dal.batch(buildHardDeleteNodeStatements(ctx.dal.db, nodeId));
                    return { success: true, siteId: node?.site_id, slug: node?.slug };
                }
            );

            engine.tapAfter<{ id: string }, { success: boolean; siteId?: string; slug?: string }>(
                action,
                async (ctx) => {
                    if (ctx.result?.siteId) {
                        const sId = ctx.result.siteId;
                        await removeEntityFromSiteRoutes(ctx.dal.db, sId, ctx.data.id);
                        const normSlugPath = ctx.result.slug !== undefined ? normalizeRoutePath(ctx.result.slug) : '/';
                        await purgeEdgeAndZoneCache(ctx.dal.db, sId, [normSlugPath, '/', '/sitemap.xml']);
                        const site = await ctx.dal.findSiteById(sId);
                        if (site) {
                            await rebuildSiteSitemapRoute(ctx.dal.db, site, ctx.host);
                        }
                    }
                }
            );
        }

        for (const action of ['CONTENT_BATCH_HARD_DELETE', 'NODE_BATCH_HARD_DELETE'] as const) {
            engine.registerService<{ nodeIds: string[] }, { success: boolean; count: number }>(
                action,
                async (ctx) => {
                    const nodeIds = Array.isArray(ctx.data.nodeIds) ? ctx.data.nodeIds : [];
                    if (nodeIds.length === 0) {
                        return { success: true, count: 0 };
                    }

                    const statements: D1PreparedStatement[] = [];
                    for (const id of nodeIds) {
                        statements.push(...buildHardDeleteNodeStatements(ctx.dal.db, id));
                    }

                    await ctx.dal.batch(statements);
                    return { success: true, count: nodeIds.length };
                }
            );
        }

        engine.registerService<{ siteId: string; category: string }, { success: boolean }>(
            'TRASH_EMPTY',
            async (ctx) => {
                const siteId = await resolveActiveSiteId(ctx.dal, ctx.data.siteId || ctx.siteId);
                const isMicroCategory = ctx.data.category === 'micro';

                const deletedIds = await findDeletedEntityIdsForEmptyTrash(ctx.dal.db, siteId, isMicroCategory);
                const statements: D1PreparedStatement[] = [];
                for (const id of deletedIds) {
                    statements.push(...buildHardDeleteNodeStatements(ctx.dal.db, id));
                }

                for (let i = 0; i < statements.length; i += 50) {
                    await ctx.dal.batch(statements.slice(i, i + 50));
                }
                return { success: true };
            }
        );

        engine.registerService<
            { nodeId: string; versionId: string },
            { success: boolean; remainingCount: number }
        >('VERSION_DELETE', async (ctx) => {
            const { versionId } = ctx.data;
            await ctx.dal.batch(buildSoftDeleteVersionStatements(ctx.dal.db, versionId));
            return { success: true, remainingCount: 1 };
        });

        engine.registerService<{ nodeId: string; versionId: string }, { success: boolean }>(
            'VERSION_RESTORE',
            async (ctx) => {
                const { nodeId, versionId } = ctx.data;
                await ctx.dal.batch(buildRestoreVersionStatements(ctx.dal.db, versionId, nodeId));
                return { success: true };
            }
        );

        engine.registerService<{ versionId: string }, { success: boolean }>(
            'VERSION_HARD_DELETE',
            async (ctx) => {
                await ctx.dal.batch(buildHardDeleteVersionStatements(ctx.dal.db, ctx.data.versionId));
                return { success: true };
            }
        );

        engine.registerService<
            { siteId: string; name: string },
            { id: string; name: string; success: boolean }
        >('TRANSLATION_GROUP_CREATE', async (ctx) => {
            const siteId = await resolveActiveSiteId(ctx.dal, ctx.data.siteId || ctx.siteId);
            const id = nanoId('tg', 8);
            await ctx.dal.batch([buildCreateTranslationGroupStatement(ctx.dal.db, id, siteId, ctx.data.name)]);
            return { id, name: ctx.data.name, success: true };
        });

        engine.registerService<{ siteId: string; groupId: string }, { success: boolean }>(
            'TRANSLATION_GROUP_DELETE',
            async (ctx) => {
                const siteId = await resolveActiveSiteId(ctx.dal, ctx.data.siteId || ctx.siteId);
                await ctx.dal.batch(buildDeleteTranslationGroupStatements(ctx.dal.db, ctx.data.groupId, siteId));
                return { success: true };
            }
        );

        engine.registerService<{ nodeId: string; groupId: string }, { success: boolean }>(
            'TRANSLATION_GROUP_JOIN',
            async (ctx) => {
                await ctx.dal.batch([buildJoinTranslationGroupStatement(ctx.dal.db, ctx.data.nodeId, ctx.data.groupId)]);
                return { success: true };
            }
        );

        engine.registerService<{ nodeId: string }, { success: boolean }>(
            'TRANSLATION_GROUP_LEAVE',
            async (ctx) => {
                await ctx.dal.batch([buildLeaveTranslationGroupStatement(ctx.dal.db, ctx.data.nodeId)]);
                return { success: true };
            }
        );

        engine.registerService<any, { id: string; versionId: string; chunkMode: string }>(
            'ARTICLE_CHUNK_SAVE',
            async (ctx) => {
                const siteId = await resolveActiveSiteId(ctx.dal, ctx.data?.siteId || ctx.siteId);
                await assertSiteAdmin(ctx.dal, siteId, ctx.user);
                const chunkText = String(ctx.data?.chunkText || '');
                // Strip <script> per ~40KB chunk rather than scanning the full document on commit so the event loop is not blocked.
                const cleanChunk = chunkText.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
                const articleId = String(ctx.data?.articleId || nanoId('art'));
                const versionId = String(ctx.data?.versionId || nanoId('ver'));
                const chunkMode = (ctx.data?.chunkMode || 'init') as 'init' | 'append' | 'commit';
                return await saveArticleChunkInPlace(ctx.dal.db, {
                    siteId,
                    articleId,
                    versionId,
                    chunkMode,
                    chunkText: cleanChunk,
                    title: ctx.data?.title,
                    slug: ctx.data?.slug,
                    summary: ctx.data?.summary,
                    locale: ctx.data?.locale,
                    status: ctx.data?.status,
                    authorId: ctx.user?.id || 'admin',
                    metadata: ctx.data?.metadata,
                    maturity: ctx.data?.maturity,
                    translationGroupId: ctx.data?.translationGroupId
                });
            }
        );

        engine.tapAfter<any, any>('ARTICLE_CHUNK_SAVE', async (ctx) => {
            if (ctx.result?.chunkMode === 'commit' && ctx.data?.siteId) {
                const site = await ctx.dal.findSiteById(ctx.data.siteId);
                if (site) {
                    await rebuildSiteSitemapRoute(ctx.dal.db, site, ctx.host);
                }
            }
        });
    }
};
