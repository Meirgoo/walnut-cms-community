import type { D1PreparedStatement } from '@cloudflare/workers-types';
import type { WalnutPlugin, HookContext, ArticleStatus } from '../types';
import { nanoId } from '../kernel';
import { isValidRedirectTarget, sanitizeRedirectTarget } from '../core/utils';
import {
    normalizeRoutePath,
    removeEntityFromSiteRoutes,
    rebuildSiteSitemapRoute,
    purgeEdgeAndZoneCache,
    findNodeSiteAndSlug,
    buildSoftDeleteNodeStatements,
    getSiteSettingsString,
    buildUpdateSiteSettingsOnlyStatement,
    assertSiteRouteUnique,
    buildUpsertSiteRouteStatement,
    buildDeleteOtherSiteRoutesStatement,
    buildDeleteEntitySiteRoutesStatement,
    buildMarkHomeAndSitemapRoutesDirtyStatement,
    buildMarkSitemapRouteDirtyStatement,
    buildMarkAllNonRedirectSiteRoutesDirtyStatement,
    buildTouchSiteUpdatedAtStatement,
    findPageSlugById,
    findPageForVcs,
    findLatestPageVersion,
    findMaxEntityVersionNumber,
    buildUpdatePageMetadataOnlyStatement,
    buildUpdatePageVersionSnapshotStatement,
    buildInsertPageVersionStatement,
    buildUpdatePageWithVersionStatement,
    buildDeleteSoftDeletedPageDuplicatesStatement,
    buildInsertPageStatement,
    findPublishedTheme,
    invalidateSiteMemoryCache
} from '../core/dal';
import {
    resolveActiveSiteId,
    assertSiteAdmin,
    normalizeEntitySlug,
    syncSavedEntityCacheAfterHook,
    SaveEntityPayload,
    SaveEntityResult,
    SaveNodePayload,
    SaveNodeResult
} from './common.helper';

export interface SetDefaultTemplatePayload {
    siteId: string;
    templateId: string;
}

import { parseJson } from '../core/utils';

export function stripDisallowedBlockCustomJs(blocks: any[], allowCustomJsSlugs: Set<string>): boolean {
    if (!Array.isArray(blocks) || blocks.length === 0) return false;
    let stripped = false;
    for (const block of blocks) {
        if (!block || typeof block !== 'object') continue;
        const compSlug = String(block.component || block.componentSlug || block.componentType || block.type || '').trim().toLowerCase();
        if (allowCustomJsSlugs.has(compSlug)) continue;
        if ('custom_js' in block) {
            delete block.custom_js;
            stripped = true;
        }
        if (block.props && typeof block.props === 'object' && 'custom_js' in block.props) {
            delete block.props.custom_js;
            stripped = true;
        }
        if (block.data && typeof block.data === 'object' && 'custom_js' in block.data) {
            delete block.data.custom_js;
            stripped = true;
        }
    }
    return stripped;
}

export async function persistPageWithVcs(
    ctx: HookContext<SaveEntityPayload, SaveEntityResult>
): Promise<SaveEntityResult> {
    const { dal, data, user } = ctx;
    const siteId = await resolveActiveSiteId(dal, data.siteId || ctx.siteId);
    await assertSiteAdmin(dal, siteId, user);

    const authorId = user?.id || 'admin';
    const isEdit = !!(data.isEdit && data.id);
    const pageId = data.id || nanoId('page');
    const locale = data.locale || ctx.locale || 'zh-CN';
    const status: ArticleStatus = data.status || 'published';
    const summary = data.summary || '';
    const contentRaw = data.contentRaw || '[]';
    const commitMessage = (data.commitMessage || '').trim();

    const pageType = data.metadata?.page_type || 'single';
    const isTemplatePage = pageType === 'template';
    const isRedirectPage = pageType === 'redirect';
    if (isRedirectPage && data.metadata?.redirect_url && !isValidRedirectTarget(data.metadata.redirect_url)) {
        throw new Error('INVALID_REDIRECT_URL');
    }

    const isPageContentSlotBlock = (b: any) =>
        b && typeof b === 'object' && (b.component === '@slot:page_content' || b.component === 'slot:page_content' || b.id === '@slot:page_content');

    const metaObj: Record<string, any> = { ...(data.metadata || {}) };
    const parsedBlocks = parseJson<any>(contentRaw, null);
    let effectiveContentRaw = contentRaw;
    if (Array.isArray(parsedBlocks)) {
        const filtered = isTemplatePage ? parsedBlocks : parsedBlocks.filter((b: any) => !isPageContentSlotBlock(b));
        metaObj.blocks = filtered;
        if (!isTemplatePage && filtered.length !== parsedBlocks.length) {
            effectiveContentRaw = JSON.stringify(filtered);
        }
    } else if (parsedBlocks && Array.isArray(parsedBlocks.blocks)) {
        metaObj.blocks = isTemplatePage ? parsedBlocks.blocks : parsedBlocks.blocks.filter((b: any) => !isPageContentSlotBlock(b));
    } else if (!Array.isArray(metaObj.blocks)) {
        metaObj.blocks = [];
    } else if (!isTemplatePage) {
        metaObj.blocks = metaObj.blocks.filter((b: any) => !isPageContentSlotBlock(b));
    }

    // Strip custom_js unless the component explicitly opts in via allow_custom_js === true in the active theme.
    const hasIncomingCustomJs = Array.isArray(metaObj.blocks) && metaObj.blocks.some((b: any) =>
        b && typeof b === 'object' && (b.custom_js !== undefined || b.props?.custom_js !== undefined || b.data?.custom_js !== undefined)
    );
    if (hasIncomingCustomJs) {
        const theme = await findPublishedTheme(dal.db, siteId);
        const allowCustomJsSlugs = new Set<string>();
        const themeComps: any[] = theme?.metadata?.components || theme?.metadata?.componentNodes || [];
        for (const comp of themeComps) {
            const cMeta = parseJson<Record<string, any>>(comp?.metadata, {});
            if (comp?.allow_custom_js === true || cMeta?.allow_custom_js === true) {
                const s = String(comp.slug || comp.type || cMeta.slug || cMeta.type || '').trim().toLowerCase();
                if (s) allowCustomJsSlugs.add(s);
            }
        }
        if (stripDisallowedBlockCustomJs(metaObj.blocks, allowCustomJsSlugs)) {
            if (Array.isArray(parsedBlocks)) {
                effectiveContentRaw = JSON.stringify(metaObj.blocks);
            } else if (parsedBlocks && typeof parsedBlocks === 'object' && Array.isArray(parsedBlocks.blocks)) {
                parsedBlocks.blocks = metaObj.blocks;
                effectiveContentRaw = JSON.stringify(parsedBlocks);
            }
        }
    }

    const metadataStr = JSON.stringify(metaObj);
    const parentId = data.parentId !== undefined ? (data.parentId || null) : null;

    let title = (data.title || '').trim() || 'Untitled Page';
    const slug = normalizeEntitySlug(data.slug, 'page');

    let parentSlug: string | null = null;
    if (parentId) {
        parentSlug = await findPageSlugById(dal.db, parentId);
    }

    const routePath = normalizeRoutePath(slug, parentSlug);

    if (!isTemplatePage) {
        await assertSiteRouteUnique(dal.db, siteId, routePath, isEdit ? pageId : null, ctx.locale || locale);
    }

    const pageMeta = data.metadata || {};
    const pageTemplateId = pageMeta.template_id || pageMeta.template_slug || null;
    const pageSchemaSlug = pageMeta.schema_slug || null;

    const buildPageRouteStmts = (): D1PreparedStatement[] => {
        const nowIso = new Date().toISOString();
        const stmts: D1PreparedStatement[] = [
            buildDeleteOtherSiteRoutesStatement(dal.db, siteId, pageId, routePath)
        ];
        if (!isTemplatePage && status === 'published') {
            stmts.push(
                buildUpsertSiteRouteStatement(dal.db, {
                    siteId,
                    path: routePath,
                    entityType: isRedirectPage ? 'redirect' : 'page',
                    entityId: pageId,
                    locale,
                    title,
                    renderedHtml: null,
                    statusCode: isRedirectPage ? (parseInt(data.metadata?.redirect_code) || 301) : 200,
                    redirectTarget: isRedirectPage ? sanitizeRedirectTarget(data.metadata?.redirect_url) : null,
                    isDirty: isRedirectPage ? 0 : 1,
                    changefreq: routePath === '/' ? 'daily' : 'weekly',
                    priority: routePath === '/' ? 1.0 : 0.6,
                    templateId: pageTemplateId,
                    schemaSlug: pageSchemaSlug
                })
            );
        } else {
            stmts.push(
                buildDeleteEntitySiteRoutesStatement(dal.db, siteId, pageId)
            );
        }

        if (isTemplatePage) {
            stmts.push(buildMarkAllNonRedirectSiteRoutesDirtyStatement(dal.db, siteId, nowIso));
        } else if (routePath !== '/') {
            stmts.push(buildMarkHomeAndSitemapRoutesDirtyStatement(dal.db, siteId, nowIso));
        } else {
            stmts.push(buildMarkSitemapRouteDirtyStatement(dal.db, siteId, nowIso));
        }
        stmts.push(buildTouchSiteUpdatedAtStatement(dal.db, siteId, nowIso));
        return stmts;
    };

    const makeResult = (verId: string, verNum: number, unchanged: boolean, isEditMode: boolean): SaveEntityResult => ({
        id: pageId,
        nodeId: pageId,
        versionId: verId,
        versionNumber: verNum,
        isEdit: isEditMode,
        unchanged,
        siteId,
        slug: isTemplatePage ? slug : routePath,
        title,
        type: 'page',
        locale,
        status
    });

    if (isEdit) {
        const existing = await findPageForVcs(dal.db, pageId);
        if (existing) {
            const latestVer = await findLatestPageVersion(dal.db, pageId);

            const existingMetaStr = typeof existing.metadata === 'string' ? existing.metadata : JSON.stringify(existing.metadata || {});
            const isTitleUnchanged = existing.title === title;
            const isSlugUnchanged = existing.slug === slug;
            const isParentUnchanged = (existing.parent_id || null) === parentId;
            const isStatusUnchanged = existing.status === status;
            const isSummaryUnchanged = (existing.summary || '') === summary;
            const isMetaUnchanged = existingMetaStr === metadataStr;

            if (latestVer) {
                const isContentUnchanged = (latestVer.content_raw || '') === effectiveContentRaw;

                if (isContentUnchanged && isTitleUnchanged && isSlugUnchanged && isParentUnchanged && isStatusUnchanged && isSummaryUnchanged && isMetaUnchanged) {
                    return makeResult(latestVer.id, latestVer.version_number, true, true);
                }

                if (isContentUnchanged) {
                    await dal.batch([
                        buildUpdatePageMetadataOnlyStatement(dal.db, {
                            title,
                            slug,
                            parentId,
                            locale,
                            status,
                            summary,
                            metadataStr,
                            pageId
                        }),
                        buildUpdatePageVersionSnapshotStatement(dal.db, {
                            title,
                            summary,
                            metadataSnapshot: metadataStr,
                            versionId: latestVer.id
                        }),
                        ...buildPageRouteStmts()
                    ]);
                    invalidateSiteMemoryCache(siteId);
                    return makeResult(latestVer.id, latestVer.version_number, false, true);
                }

                const maxVer = await findMaxEntityVersionNumber(dal.db, 'page_versions', 'page_id', pageId);
                const nextVersionNumber = Math.max(latestVer.version_number, maxVer) + 1;
                const newVersionId = nanoId('ver');
                const nowIso = new Date().toISOString();

                await dal.batch([
                    buildInsertPageVersionStatement(dal.db, {
                        id: newVersionId,
                        pageId,
                        versionNumber: nextVersionNumber,
                        title,
                        summary,
                        contentRaw: effectiveContentRaw,
                        metadataSnapshot: metadataStr,
                        commitMessage: commitMessage || `Page snapshot v${nextVersionNumber}`,
                        authorId,
                        createdAt: nowIso
                    }),
                    buildUpdatePageWithVersionStatement(dal.db, {
                        title,
                        slug,
                        parentId,
                        locale,
                        status,
                        summary,
                        metadataStr,
                        versionId: newVersionId,
                        pageId
                    }),
                    ...buildPageRouteStmts()
                ]);
                invalidateSiteMemoryCache(siteId);

                return makeResult(newVersionId, nextVersionNumber, false, true);
            }
        }
    }

    const newVersionId = nanoId('ver');
    const nowIso = new Date().toISOString();
    const publishedAt = status === 'published' ? nowIso : null;

    await dal.batch([
        buildDeleteSoftDeletedPageDuplicatesStatement(dal.db, siteId, slug, locale, parentId),
        buildInsertPageStatement(dal.db, {
            id: pageId,
            siteId,
            slug,
            parentId,
            locale,
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
        buildInsertPageVersionStatement(dal.db, {
            id: newVersionId,
            pageId,
            versionNumber: 1,
            title,
            summary,
            contentRaw: effectiveContentRaw,
            metadataSnapshot: metadataStr,
            commitMessage: commitMessage || 'Initial page snapshot',
            authorId,
            createdAt: nowIso
        }),
        ...buildPageRouteStmts()
    ]);
    invalidateSiteMemoryCache(siteId);

    return makeResult(newVersionId, 1, false, false);
}

export const pagePlugin: WalnutPlugin = {
    name: 'page',
    version: '2.2.0',

    setup(engine) {
        engine.tapBefore<SaveNodePayload>('PAGE_SAVE', (ctx) => {
            ctx.data.type = 'page';
        });

        engine.registerService<SaveNodePayload, SaveNodeResult>('PAGE_SAVE', async (ctx) => {
            return await persistPageWithVcs(ctx);
        });

        engine.tapAfter<SaveNodePayload, SaveNodeResult>('PAGE_SAVE', async (ctx) => {
            await syncSavedEntityCacheAfterHook(ctx);
        });

        engine.registerService<{ id: string }, { success: boolean; siteId?: string; slug?: string }>(
            'PAGE_DELETE',
            async (ctx) => {
                const pageId = ctx.data.id;
                const node = await findNodeSiteAndSlug(ctx.dal.db, pageId);

                await ctx.dal.batch(buildSoftDeleteNodeStatements(ctx.dal.db, pageId, 'page'));

                return {
                    success: true,
                    siteId: node?.site_id,
                    slug: node?.slug
                };
            }
        );

        engine.tapAfter<{ id: string }, { success: boolean; siteId?: string; slug?: string }>(
            'PAGE_DELETE',
            async (ctx) => {
                if (ctx.result?.siteId) {
                    const sId = ctx.result.siteId;
                    await removeEntityFromSiteRoutes(ctx.dal.db, sId, ctx.data.id);
                    await purgeEdgeAndZoneCache(ctx.dal.db, sId, ['/', '/sitemap.xml']);
                    const site = await ctx.dal.findSiteById(sId);
                    if (site) {
                        await rebuildSiteSitemapRoute(ctx.dal.db, site, ctx.host);
                    }
                }
            }
        );

        engine.tapBefore<SetDefaultTemplatePayload>('PAGE_SET_DEFAULT_TEMPLATE', (ctx) => {
            if (!ctx.data.siteId) {
                throw new Error('MISSING_SITE_ID');
            }
        });

        engine.registerService<SetDefaultTemplatePayload, { success: boolean }>(
            'PAGE_SET_DEFAULT_TEMPLATE',
            async (ctx) => {
                const { siteId, templateId } = ctx.data;
                const settingsStr = await getSiteSettingsString(ctx.dal.db, siteId);
                const settings = parseJson<Record<string, any>>(settingsStr, {});

                settings.default_template_page_id = templateId;
                await ctx.dal.batch([
                    buildUpdateSiteSettingsOnlyStatement(ctx.dal.db, siteId, JSON.stringify(settings))
                ]);

                return { success: true };
            }
        );
    }
};
