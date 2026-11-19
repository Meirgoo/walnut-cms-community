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
    invalidateSiteMemoryCache
} from '../core/dal';
import {
    resolveActiveSiteId,
    assertSiteAdmin,
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
        const latestVer = await findLatestMicroVersion(dal.db, microId);

        if (existing && latestVer) {
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

            if (isContentUnchanged && isTitleUnchanged && isSlugUnchanged && isProgressUnchanged && isStatusUnchanged && isVisibilityUnchanged && isLocaleUnchanged && isMetaUnchanged) {
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
                        microId
                    })
                ]);
                invalidateSiteMemoryCache(siteId);
                return makeResult(latestVer.id, latestVer.version_number, false, true);
            }

            const maxVer = await findMaxEntityVersionNumber(dal.db, 'micro_versions', 'micro_id', microId);
            const nextVersionNumber = Math.max(latestVer.version_number, maxVer) + 1;
            const newVersionId = nanoId('ver');
            const nowIso = new Date().toISOString();

            await dal.batch([
                buildInsertMicroVersionStatement(dal.db, {
                    id: newVersionId,
                    microId,
                    versionNumber: nextVersionNumber,
                    title,
                    contentRaw,
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
                    metadataStr,
                    versionId: newVersionId,
                    microId
                })
            ]);

            await syncWikiRelationsBatch(dal, siteId, microId, 'micro', contentRaw);

            return makeResult(newVersionId, nextVersionNumber, false, true);
        }
    }

    const newVersionId = nanoId('ver');
    const nowIso = new Date().toISOString();

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
            metadataStr,
            currentVersionId: newVersionId,
            curatorId: authorId,
            publishedAt: nowIso,
            createdAt: nowIso,
            updatedAt: nowIso
        }),
        buildInsertMicroVersionStatement(dal.db, {
            id: newVersionId,
            microId,
            versionNumber: 1,
            title,
            contentRaw,
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
    version: '2.2.0',

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

        engine.registerService<{ id: string }, { success: boolean; siteId?: string; slug?: string }>(
            'MICRO_DELETE',
            async (ctx) => {
                const microId = ctx.data.id;
                const node = await findNodeSiteAndSlug(ctx.dal.db, microId);

                await ctx.dal.batch(buildSoftDeleteNodeStatements(ctx.dal.db, microId, 'micro'));

                return {
                    success: true,
                    siteId: node?.site_id,
                    slug: node?.slug
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
