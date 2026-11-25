import type { WalnutPlugin, HookContext, ArticleStatus } from '../types';
import { nanoId } from '../kernel';
import {
    markSiteRoutesDirty,
    markRoutesDirtyByDependency,
    findNodeSiteAndSlug,
    buildSoftDeleteNodeStatements,
    findMicroForVcs,
    findLatestMicroVersion,
    findMaxEntityVersionNumber,
    buildUpdateMicroMetadataOnlyStatement,
    buildInsertMicroVersionStatement,
    buildUpdateMicroWithVersionStatement,
    buildInsertMicroStatement,
    findPublishedTheme,
    invalidateSiteMemoryCache
} from '../core/dal';
import { processThemeMarkdownComponents } from '../render/markdown-parser';
import {
    resolveActiveSiteId,
    assertSiteAdmin,
    normalizePublishedAtInput,
    syncWikiRelationsBatch,
    syncSavedEntityCacheAfterHook,
    SaveEntityPayload,
    SaveEntityResult,
    SaveNodePayload,
    SaveNodeResult
} from './common.helper';

export async function persistMicroWithVcs(
    ctx: HookContext<SaveEntityPayload, SaveEntityResult>
): Promise<SaveEntityResult> {
    const { dal, data, user } = ctx;
    const siteId = await resolveActiveSiteId(dal, data.siteId || ctx.siteId);
    await assertSiteAdmin(dal, siteId, user);
    const authorId = user?.id || 'admin';
    const isEdit = !!(data.isEdit && data.id);
    const microId = data.id || nanoId('micro');
    const locale = data.locale || ctx.locale || 'zh-CN';
    const rawProg = data.progress !== undefined ? data.progress : data.maturity;
    const progress = typeof rawProg === 'string' ? (rawProg.trim() === 'none' ? '' : rawProg.trim()) : '';
    const visibility = data.visibility || 'public';
    const status: ArticleStatus = data.status || 'published';
    const contentRaw = data.contentRaw || '';
    const commitMessage = (data.commitMessage || '').trim();
    const metadataStr = JSON.stringify(data.metadata || {});

    const [siteRow, theme] = await Promise.all([
        dal.findSiteById(siteId).catch(() => null),
        findPublishedTheme(dal.db, siteId).catch(() => null)
    ]);
    const siteDefaultLocale = siteRow?.default_locale || 'zh-CN';
    const contentHtml = processThemeMarkdownComponents(contentRaw, theme?.metadata, {
        currentLocale: locale,
        defaultLocale: siteDefaultLocale
    });

    let title = (data.title || '').trim();
    if (!title) {
        title = contentRaw ? contentRaw.slice(0, 30).replace(/[\r\n#*`]/g, '').trim() || 'Micro Memo' : 'Micro Memo';
    }

    let slug = (data.slug || '').trim().replace(/^\/+|\/+$/g, '').replace(/\/+/g, '/').toLowerCase();
    if (!slug) {
        slug = nanoId('micro', 8);
    }

    const makeResult = (verId: string, verNum: number, unchanged: boolean, isEditMode: boolean): SaveEntityResult => ({
        id: microId,
        nodeId: microId,
        versionId: verId,
        versionNumber: verNum,
        isEdit: isEditMode,
        unchanged,
        siteId,
        slug,
        title,
        type: 'micro',
        locale,
        status
    });

    if (isEdit) {
        const existing = await findMicroForVcs(dal.db, microId);
        if (existing && existing.site_id !== siteId) {
            throw new Error('FORBIDDEN_CROSS_SITE_ACCESS');
        }
        const latestVer = existing ? await findLatestMicroVersion(dal.db, microId) : null;

        if (existing && latestVer) {
            const explicitPublishedAt = normalizePublishedAtInput(data.publishedAt ?? data.published_at, existing.published_at);
            const isContentUnchanged = (latestVer.content_raw || '') === contentRaw;
            const isTitleUnchanged = existing.title === title;
            const isSlugUnchanged = existing.slug === slug;
            const existingProg = (existing.progress || existing.maturity || '').trim();
            const normExistingProg = existingProg === 'none' ? '' : existingProg;
            const isProgressUnchanged = normExistingProg === progress;
            const isStatusUnchanged = existing.status === status;
            const isVisibilityUnchanged = (existing.visibility || 'public') === visibility;
            const isLocaleUnchanged = (existing.locale || 'zh-CN') === locale;
            const existingMetaStr = typeof existing.metadata === 'string' ? existing.metadata : JSON.stringify(existing.metadata || {});
            const isMetaUnchanged = existingMetaStr === metadataStr;
            const isPublishedAtUnchanged = explicitPublishedAt === undefined || (existing.published_at || null) === explicitPublishedAt;

            if (isContentUnchanged && isTitleUnchanged && isSlugUnchanged && isProgressUnchanged && isStatusUnchanged && isVisibilityUnchanged && isLocaleUnchanged && isMetaUnchanged && isPublishedAtUnchanged) {
                return makeResult(latestVer.id, latestVer.version_number, true, true);
            }

            if (isContentUnchanged) {
                await dal.batch([
                    buildUpdateMicroMetadataOnlyStatement(dal.db, {
                        title,
                        slug,
                        locale,
                        progress,
                        status,
                        visibility,
                        metadataStr,
                        publishedAt: explicitPublishedAt,
                        microId,
                        siteId
                    })
                ]);
                invalidateSiteMemoryCache(siteId);
                return makeResult(latestVer.id, latestVer.version_number, false, true);
            }

            const maxVer = await findMaxEntityVersionNumber(dal.db, 'micro', microId);
            const nextVersionNumber = Math.max(latestVer.version_number, maxVer) + 1;
            const newVersionId = nanoId('ver');
            const nowIso = new Date().toISOString();

            await dal.batch([
                buildInsertMicroVersionStatement(dal.db, {
                    id: newVersionId,
                    siteId,
                    microId,
                    versionNumber: nextVersionNumber,
                    title,
                    contentRaw,
                    contentRendered: contentHtml,
                    metadataSnapshot: metadataStr,
                    commitMessage: commitMessage || `Snapshot v${nextVersionNumber}`,
                    authorId,
                    createdAt: nowIso
                }),
                buildUpdateMicroWithVersionStatement(dal.db, {
                    title,
                    slug,
                    locale,
                    progress,
                    status,
                    visibility,
                    contentRaw,
                    contentHtml,
                    metadataStr,
                    publishedAt: explicitPublishedAt,
                    versionId: newVersionId,
                    microId,
                    siteId
                })
            ]);

            await syncWikiRelationsBatch(dal, siteId, microId, 'micro', contentRaw, locale);

            return makeResult(newVersionId, nextVersionNumber, false, true);
        }
    }

    const newVersionId = nanoId('ver');
    const nowIso = new Date().toISOString();
    const explicitPublishedAt = normalizePublishedAtInput(data.publishedAt ?? data.published_at);
    const publishedAt = explicitPublishedAt ?? (status === 'published' ? nowIso : null);

    await dal.batch([
        buildInsertMicroStatement(dal.db, {
            id: microId,
            siteId,
            slug,
            locale,
            progress,
            status,
            visibility,
            title,
            contentRaw,
            contentHtml,
            metadataStr,
            currentVersionId: newVersionId,
            curatorId: authorId,
            publishedAt,
            createdAt: nowIso,
            updatedAt: nowIso
        }),
        buildInsertMicroVersionStatement(dal.db, {
            id: newVersionId,
            siteId,
            microId,
            versionNumber: 1,
            title,
            contentRaw,
            contentRendered: contentHtml,
            metadataSnapshot: metadataStr,
            commitMessage: commitMessage || 'Initial memo snapshot',
            authorId,
            createdAt: nowIso
        })
    ]);

    await syncWikiRelationsBatch(dal, siteId, microId, 'micro', contentRaw);

    return makeResult(newVersionId, 1, false, false);
}

export const microPlugin: WalnutPlugin = {
    name: 'micro',
    setup(engine) {
        engine.tapBefore<SaveNodePayload>('MICRO_SAVE', (ctx) => {
            ctx.data.type = 'micro';
            const rawProg = ctx.data.progress !== undefined ? ctx.data.progress : ctx.data.maturity;
            const progress = typeof rawProg === 'string' ? (rawProg.trim() === 'none' ? '' : rawProg.trim()) : '';
            ctx.data.progress = progress;
            ctx.data.maturity = progress as any;
            if (!ctx.data.slug) {
                ctx.data.slug = `micro-${Date.now().toString(36)}`;
            }
        });

        engine.registerService<SaveNodePayload, SaveNodeResult>('MICRO_SAVE', async (ctx) => {
            return await persistMicroWithVcs(ctx);
        });

        engine.tapAfter<SaveNodePayload, SaveNodeResult>('MICRO_SAVE', async (ctx) => {
            await syncSavedEntityCacheAfterHook(ctx);
        });

        engine.registerService<{ id: string; siteId?: string }, { success: boolean; siteId?: string; slug?: string }>(
            'MICRO_DELETE',
            async (ctx) => {
                const microId = ctx.data.id;
                const siteId = ctx.data?.siteId || ctx.siteId || 'site_default';
                await assertSiteAdmin(ctx.dal, siteId, ctx.user);
                const isSuper = ctx.user?.global_role === 'superadmin';
                const node = await findNodeSiteAndSlug(ctx.dal.db, microId, isSuper ? undefined : siteId);
                if (!node) throw new Error('FORBIDDEN_CROSS_SITE_ACCESS');

                await ctx.dal.batch(buildSoftDeleteNodeStatements(ctx.dal.db, microId, 'micro', node.site_id));

                return {
                    success: true,
                    siteId: node.site_id,
                    slug: node.slug
                };
            }
        );

        engine.tapAfter<{ id: string }, { success: boolean; siteId?: string; slug?: string }>(
            'MICRO_DELETE',
            async (ctx) => {
                if (ctx.result?.siteId) {
                    await markRoutesDirtyByDependency(ctx.dal.db, ctx.result.siteId, ['micro:*'], ['/']);
                }
            }
        );
    }
};

export const MicroPlugin = microPlugin;
