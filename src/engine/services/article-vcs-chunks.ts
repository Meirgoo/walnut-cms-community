import type { IPluginEngine, HookContext } from '../types';
import { nanoId } from '../kernel';
import { buildLocalizedRoutePath } from '../core/i18n';
import {
    normalizeRoutePath,
    markTranslationGroupPeersDirty,
    rebuildSiteSitemapRoute,
    markSiteRoutesDirty,
    markRoutesDirtyByDependency,
    purgeEdgeAndZoneCache,
    findPageSlugById,
    findNodeSiteAndSlug,
    findNodeById,
    findNodeTranslationInfo,
    findPeerTranslationNodes,
    findInboundRelationSourcePaths,
    findEntityVersionById,
    buildSoftDeleteVersionStatements,
    buildRestoreVersionStatements,
    buildHardDeleteVersionStatements,
    buildDeleteTranslationGroupStatements,
    buildJoinTranslationGroupStatement,
    buildLeaveTranslationGroupStatement,
    saveArticleChunkInPlace,
    findLatestArticleVersion,
    invalidateQueryCache
} from '../core/dal';
import { requireScopedSiteAdmin, syncWikiRelationsBatch } from './common.helper';
import { parseJson } from '../core/utils';

export function registerArticleVcsAndChunkServices(engine: IPluginEngine): void {
    engine.registerService<
        { nodeId: string; versionId: string; siteId?: string },
        { success: boolean; remainingCount: number }
    >('VERSION_DELETE', async (ctx) => {
        const scopeSiteId = await requireScopedSiteAdmin(ctx);
        const isSuper = ctx.user?.global_role === 'superadmin';
        const { versionId } = ctx.data;
        await ctx.dal.batch(buildSoftDeleteVersionStatements(ctx.dal.db, versionId, isSuper ? undefined : scopeSiteId));
        return { success: true, remainingCount: 1 };
    });

    engine.registerService<{ nodeId: string; versionId: string; siteId?: string }, { success: boolean; siteId: string; nodeId: string }>(
        'VERSION_RESTORE',
        async (ctx) => {
            const scopeSiteId = await requireScopedSiteAdmin(ctx);
            const isSuper = ctx.user?.global_role === 'superadmin';
            const { nodeId, versionId } = ctx.data;
            const verRow = await findEntityVersionById(ctx.dal.db, versionId, isSuper ? undefined : scopeSiteId);
            if (!verRow) throw new Error('VERSION_NOT_FOUND');
            const resolvedNodeId = nodeId || verRow.entity_id;
            if (resolvedNodeId && !isSuper) {
                const node = await findNodeSiteAndSlug(ctx.dal.db, resolvedNodeId, scopeSiteId);
                if (!node) throw new Error('FORBIDDEN_CROSS_SITE_ACCESS');
            }
            await ctx.dal.batch(buildRestoreVersionStatements(ctx.dal.db, versionId, resolvedNodeId, isSuper ? undefined : scopeSiteId, verRow));
            return { success: true, siteId: verRow.site_id || scopeSiteId, nodeId: resolvedNodeId };
        }
    );

    engine.tapAfter<{ nodeId: string; versionId: string; siteId?: string }, { success: boolean; siteId: string; nodeId: string }>(
        'VERSION_RESTORE',
        async (ctx) => {
            if (!ctx.result?.success || !ctx.result.nodeId) return;
            const sId = ctx.result.siteId;
            const node = await findNodeById(ctx.dal.db, ctx.result.nodeId);
            if (!node) return;
            if (node.type === 'dataset') {
                invalidateQueryCache(sId);
                await markRoutesDirtyByDependency(ctx.dal.db, sId, ['dataset:*'], ['/']);
                await purgeEdgeAndZoneCache(ctx.dal.db, sId, ['/']);
                return;
            }
            const meta = parseJson<Record<string, any>>(node.metadata, {});
            const tgId = (node as any).translation_group_id || meta.translation_group_id || null;
            const peerPaths = await markTranslationGroupPeersDirty(ctx.dal.db, sId, node.id, tgId ? [tgId] : undefined);
            const site = await ctx.dal.findSiteById(sId);
            const defaultLoc = site?.default_locale || 'zh-CN';
            const parentSlug = (node.type === 'page' && node.parent_id) ? await findPageSlugById(ctx.dal.db, node.parent_id) : null;
            const selfPath = buildLocalizedRoutePath(normalizeRoutePath(node.slug, parentSlug), node.locale || defaultLoc, defaultLoc);
            const depKey = node.type === 'micro' ? 'micro:*' : (node.type === 'page' ? 'page:*' : 'article:*');
            await markRoutesDirtyByDependency(ctx.dal.db, sId, [depKey], [selfPath, '/', '/sitemap.xml']);
            await purgeEdgeAndZoneCache(ctx.dal.db, sId, [selfPath, ...peerPaths, '/', '/sitemap.xml']);
        }
    );

    engine.registerService<{ versionId: string; siteId?: string }, { success: boolean }>(
        'VERSION_HARD_DELETE',
        async (ctx) => {
            const scopeSiteId = await requireScopedSiteAdmin(ctx);
            const isSuper = ctx.user?.global_role === 'superadmin';
            await ctx.dal.batch(buildHardDeleteVersionStatements(ctx.dal.db, ctx.data.versionId, isSuper ? undefined : scopeSiteId));
            return { success: true };
        }
    );

    engine.registerService<
        { siteId: string; name: string },
        { id: string; name: string; success: boolean }
    >('TRANSLATION_GROUP_CREATE', async (ctx) => {
        await requireScopedSiteAdmin(ctx);
        const id = nanoId('tg', 8);
        return { id, name: ctx.data.name, success: true };
    });

    engine.registerService<{ siteId: string; groupId: string }, { success: boolean; siteId: string; affectedPaths: string[] }>(
        'TRANSLATION_GROUP_DELETE',
        async (ctx) => {
            const siteId = await requireScopedSiteAdmin(ctx);
            const peers = await findPeerTranslationNodes(ctx.dal.db, siteId, ctx.data.groupId);
            const site = await ctx.dal.findSiteById(siteId);
            const defLoc = site?.default_locale || 'zh-CN';
            const affectedPaths = peers.map(p => buildLocalizedRoutePath(normalizeRoutePath(p.slug), p.locale || defLoc, defLoc));
            await ctx.dal.batch(buildDeleteTranslationGroupStatements(ctx.dal.db, ctx.data.groupId, siteId));
            return { success: true, siteId, affectedPaths };
        }
    );

    engine.tapAfter<{ siteId: string; groupId: string }, { success: boolean; siteId: string; affectedPaths: string[] }>(
        'TRANSLATION_GROUP_DELETE',
        async (ctx) => {
            if (!ctx.result?.success || !ctx.result.affectedPaths?.length) return;
            await markSiteRoutesDirty(ctx.dal.db, ctx.result.siteId, ctx.result.affectedPaths);
            await purgeEdgeAndZoneCache(ctx.dal.db, ctx.result.siteId, ctx.result.affectedPaths);
        }
    );

    const syncTranslationGroupMembership = async (
        ctx: HookContext<{ nodeId: string; groupId?: string; siteId?: string }, { success: boolean; siteId: string; oldTranslationGroupId: string | null }>,
        mode: 'join' | 'leave'
    ) => {
        const siteId = await requireScopedSiteAdmin(ctx);
        const isSuper = ctx.user?.global_role === 'superadmin';
        if (!isSuper) {
            const node = await findNodeSiteAndSlug(ctx.dal.db, ctx.data.nodeId, siteId);
            if (!node) throw new Error('FORBIDDEN_CROSS_SITE_ACCESS');
        }
        const prevInfo = await findNodeTranslationInfo(ctx.dal.db, ctx.data.nodeId);
        const scope = isSuper ? undefined : siteId;
        const stmt = mode === 'join'
            ? buildJoinTranslationGroupStatement(ctx.dal.db, ctx.data.nodeId, ctx.data.groupId || '', scope)
            : buildLeaveTranslationGroupStatement(ctx.dal.db, ctx.data.nodeId, scope);
        await ctx.dal.batch([stmt]);
        return { success: true, siteId, oldTranslationGroupId: prevInfo?.translation_group_id ?? null };
    };

    const markTranslationGroupMembershipDirty = async (
        ctx: HookContext<{ nodeId: string; groupId?: string }, { success: boolean; siteId: string; oldTranslationGroupId: string | null }>
    ) => {
        if (!ctx.result?.success) return;
        const sId = ctx.result.siteId;
        const tgIds = [ctx.result.oldTranslationGroupId, ctx.data.groupId].filter((v): v is string => !!v);
        const peerPaths = await markTranslationGroupPeersDirty(ctx.dal.db, sId, ctx.data.nodeId, tgIds.length ? tgIds : undefined);
        const node = await findNodeById(ctx.dal.db, ctx.data.nodeId);
        const paths = [...peerPaths];
        if (node && !node.deleted_at && node.status === 'published') {
            const site = await ctx.dal.findSiteById(sId);
            const defLoc = site?.default_locale || 'zh-CN';
            paths.push(buildLocalizedRoutePath(normalizeRoutePath(node.slug), node.locale || defLoc, defLoc));
        }
        if (paths.length > 0) {
            await markSiteRoutesDirty(ctx.dal.db, sId, paths);
            await purgeEdgeAndZoneCache(ctx.dal.db, sId, paths);
        }
    };

    engine.registerService<{ nodeId: string; groupId: string; siteId?: string }, { success: boolean; siteId: string; oldTranslationGroupId: string | null }>(
        'TRANSLATION_GROUP_JOIN',
        (ctx) => syncTranslationGroupMembership(ctx, 'join')
    );
    engine.tapAfter('TRANSLATION_GROUP_JOIN', markTranslationGroupMembershipDirty);

    engine.registerService<{ nodeId: string; siteId?: string }, { success: boolean; siteId: string; oldTranslationGroupId: string | null }>(
        'TRANSLATION_GROUP_LEAVE',
        (ctx) => syncTranslationGroupMembership(ctx, 'leave')
    );
    engine.tapAfter('TRANSLATION_GROUP_LEAVE', markTranslationGroupMembershipDirty);

    engine.registerService<any, any>(
        'ARTICLE_CHUNK_SAVE',
        async (ctx) => {
            const siteId = await requireScopedSiteAdmin(ctx);
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
        if (ctx.result?.chunkMode === 'commit') {
            const sId = ctx.result.siteId || ctx.data?.siteId || ctx.siteId || 'site_default';
            const site = await ctx.dal.findSiteById(sId);
            const latestVer = await findLatestArticleVersion(ctx.dal.db, ctx.result.id);
            const finalLocale = ctx.data?.locale || site?.default_locale || 'zh-CN';
            if (latestVer) {
                await syncWikiRelationsBatch(ctx.dal, sId, ctx.result.id, 'article', latestVer.content_raw || '', finalLocale);
            }
            const tgIds = [ctx.result.oldTranslationGroupId, ctx.result.translationGroupId].filter((v): v is string => !!v);
            const peerPaths = await markTranslationGroupPeersDirty(ctx.dal.db, sId, ctx.result.id, tgIds.length > 0 ? tgIds : undefined);
            const inboundPaths = await findInboundRelationSourcePaths(ctx.dal.db, sId, ctx.result.id, ctx.data?.slug ? [ctx.data.slug] : [], site?.default_locale || 'zh-CN');
            const oldLocPath = ctx.result.oldLocalizedPath && ctx.result.oldLocalizedPath !== ctx.result.localizedPath
                ? [ctx.result.oldLocalizedPath]
                : [];
            const extraPaths = Array.from(new Set([...peerPaths, ...inboundPaths, ...oldLocPath]));
            if (extraPaths.length > 0) {
                await markSiteRoutesDirty(ctx.dal.db, sId, extraPaths);
                await purgeEdgeAndZoneCache(ctx.dal.db, sId, extraPaths);
            }
            if (site) {
                await rebuildSiteSitemapRoute(ctx.dal.db, site, ctx.host);
            }
        }
    });
}
