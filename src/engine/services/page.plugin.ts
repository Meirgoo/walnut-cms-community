import type { D1PreparedStatement } from '@cloudflare/workers-types';
import type { WalnutPlugin, HookContext, ArticleStatus } from '../types';
import { nanoId } from '../kernel';
import { buildLocalizedRoutePath } from '../core/i18n';
import { isValidRedirectTarget, sanitizeRedirectTarget } from '../core/utils';
import {
    normalizeRoutePath,
    removeEntityFromSiteRoutes,
    markTranslationGroupPeersDirty,
    rebuildSiteSitemapRoute,
    purgeEdgeAndZoneCache,
    findNodeSiteAndSlug,
    buildSoftDeleteNodeStatements,
    getSiteSettingsString,
    buildUpdateSiteSettingsOnlyStatement,
    assertSiteRouteUnique,
    assertAliasRoutesAvailable,
    buildUpsertSiteRouteStatement,
    buildDeleteOtherSiteRoutesStatement,
    buildDeleteEntitySiteRoutesStatement,
    buildMarkHomeAndSitemapRoutesDirtyStatement,
    buildMarkSitemapRouteDirtyStatement,
    buildMarkAllNonRedirectSiteRoutesDirtyStatement,
    buildTouchSiteUpdatedAtStatement,
    findPageSlugById,
    findActivePagesHierarchyBySite,
    findPageForVcs,
    findLatestPageVersion,
    findMaxEntityVersionNumber,
    findActiveTemplateDependents,
    isRestrictedAccess,
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
    normalizePublishedAtInput,
    normalizeAliasesList,
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
    const siteRow = await dal.findSiteById(siteId);
    const siteDefaultLocale = siteRow?.default_locale || 'zh-CN';
    const locale = data.locale || siteDefaultLocale;
    const status: ArticleStatus = data.status || 'published';
    const summary = data.summary || '';
    const contentRaw = data.contentRaw || '[]';
    const commitMessage = (data.commitMessage || '').trim();

    const pageType = data.metadata?.page_type || 'single';
    const isTemplatePage = pageType === 'template';
    const isRedirectPage = pageType === 'redirect';
    const accessPerm = String(data.metadata?.access_permission || 'public').toLowerCase();
    const rawVisibility = String(data.visibility || '').trim().toLowerCase();
    const visibility = (rawVisibility && rawVisibility !== 'public')
        ? rawVisibility
        : (accessPerm === 'password_protected' ? 'password' : ((accessPerm === 'admin_only' || accessPerm === 'members_only') ? 'private' : 'public'));
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

    const parentId = data.parentId !== undefined ? (data.parentId || '') : '';

    let title = (data.title || '').trim() || 'Untitled Page';
    const slug = normalizeEntitySlug(data.slug, 'page');

    let parentSlug: string | null = null;
    if (parentId) {
        parentSlug = await findPageSlugById(dal.db, parentId);
    }

    const routePath = normalizeRoutePath(slug, parentSlug);
    const localizedPath = !isTemplatePage
        ? await assertSiteRouteUnique(dal.db, siteId, routePath, isEdit ? pageId : null, locale, siteDefaultLocale)
        : routePath;

    const normalizedAliases = (!isTemplatePage && !isRedirectPage)
        ? normalizeAliasesList(metaObj.aliases, localizedPath)
        : [];
    if (normalizedAliases.length > 0) {
        metaObj.aliases = normalizedAliases;
        await assertAliasRoutesAvailable(dal.db, siteId, normalizedAliases, isEdit ? pageId : null);
    } else {
        delete metaObj.aliases;
    }

    const metadataStr = JSON.stringify(metaObj);
    const pageMeta = metaObj;
    const pageTemplateId = pageMeta.template_id || pageMeta.template_slug || null;
    const pageSchemaSlug = pageMeta.schema_slug || null;
    const isPageRestricted = isRestrictedAccess(visibility, metaObj);

    const buildPageRouteStmts = (): D1PreparedStatement[] => {
        const nowIso = new Date().toISOString();
        const isLiveRoute = !isTemplatePage && status === 'published' && !isPageRestricted;
        const keepPaths = (isLiveRoute && !isRedirectPage) ? [localizedPath, ...normalizedAliases] : [localizedPath];
        const stmts: D1PreparedStatement[] = [
            buildDeleteOtherSiteRoutesStatement(dal.db, siteId, pageId, keepPaths)
        ];
        if (isLiveRoute) {
            stmts.push(
                buildUpsertSiteRouteStatement(dal.db, {
                    siteId,
                    path: localizedPath,
                    entityType: isRedirectPage ? 'redirect' : 'page',
                    entityId: pageId,
                    locale,
                    translationGroupId: pageMeta.translation_group_id || null,
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
            if (!isRedirectPage) {
                for (const aliasPath of normalizedAliases) {
                    stmts.push(
                        buildUpsertSiteRouteStatement(dal.db, {
                            siteId,
                            path: aliasPath,
                            entityType: 'redirect',
                            entityId: pageId,
                            locale,
                            translationGroupId: pageMeta.translation_group_id || null,
                            title,
                            renderedHtml: null,
                            statusCode: 301,
                            redirectTarget: localizedPath,
                            isDirty: 0
                        })
                    );
                }
            }
        } else {
            stmts.push(
                buildDeleteEntitySiteRoutesStatement(dal.db, siteId, pageId)
            );
        }

        if (isTemplatePage) {
            stmts.push(buildMarkAllNonRedirectSiteRoutesDirtyStatement(dal.db, siteId, nowIso));
        } else if (localizedPath !== '/') {
            stmts.push(buildMarkHomeAndSitemapRoutesDirtyStatement(dal.db, siteId, nowIso));
        } else {
            stmts.push(buildMarkSitemapRouteDirtyStatement(dal.db, siteId, nowIso));
        }
        stmts.push(buildTouchSiteUpdatedAtStatement(dal.db, siteId, nowIso));
        return stmts;
    };

    const makeResult = (
        verId: string,
        verNum: number,
        unchanged: boolean,
        isEditMode: boolean,
        extra?: { extraDirtyPaths?: string[]; extraPurgePaths?: string[]; oldTranslationGroupId?: string | null }
    ): SaveEntityResult => ({
        id: pageId,
        nodeId: pageId,
        versionId: verId,
        versionNumber: verNum,
        isEdit: isEditMode,
        unchanged,
        siteId,
        slug: isTemplatePage ? slug : localizedPath,
        title,
        type: 'page',
        locale,
        status,
        translationGroupId: pageMeta.translation_group_id || null,
        oldTranslationGroupId: extra?.oldTranslationGroupId ?? null,
        extraDirtyPaths: extra?.extraDirtyPaths,
        extraPurgePaths: extra?.extraPurgePaths,
        isTemplate: isTemplatePage
    });

    if (isEdit) {
        const existing = await findPageForVcs(dal.db, pageId);
        if (existing && existing.site_id !== siteId) {
            throw new Error('FORBIDDEN_CROSS_SITE_ACCESS');
        }
        if (existing) {
            const latestVer = await findLatestPageVersion(dal.db, pageId);

            const existingMetaStr = typeof existing.metadata === 'string' ? existing.metadata : JSON.stringify(existing.metadata || {});
            const existingMetaObj = parseJson<Record<string, any>>(existingMetaStr, {});
            const oldTgId = existing.translation_group_id || existingMetaObj.translation_group_id || null;
            const isTitleUnchanged = existing.title === title;
            const isSlugUnchanged = existing.slug === slug;
            const isLocaleUnchanged = (existing.locale || 'zh-CN') === locale;
            const isParentUnchanged = (existing.parent_id || '') === parentId;
            const isStatusUnchanged = existing.status === status;
            const isVisibilityUnchanged = (existing.visibility || 'public') === visibility;
            const isSummaryUnchanged = (existing.summary || '') === summary;
            const isMetaUnchanged = existingMetaStr === metadataStr;

            // Collect self old path + full descendant subtree cascade when slug/parent/locale/status/visibility change.
            const buildHierarchyCascade = async (): Promise<{
                stmts: D1PreparedStatement[];
                dirtyPaths: string[];
                purgePaths: string[];
            }> => {
                const stmts: D1PreparedStatement[] = [];
                const purgeSet = new Set<string>();
                const dirtySet = new Set<string>();
                if (isSlugUnchanged && isParentUnchanged && isLocaleUnchanged && isStatusUnchanged && isVisibilityUnchanged) {
                    return { stmts, dirtyPaths: [], purgePaths: [] };
                }
                const oldParentPath = existing.parent_id ? await findPageSlugById(dal.db, existing.parent_id) : null;
                const oldSelfBare = normalizeRoutePath(existing.slug, oldParentPath);
                const oldSelfLoc = buildLocalizedRoutePath(oldSelfBare, existing.locale || siteDefaultLocale, siteDefaultLocale);
                if (oldSelfLoc !== localizedPath || status !== 'published' || isPageRestricted) {
                    purgeSet.add(oldSelfLoc);
                }

                if (!isSlugUnchanged || !isParentUnchanged || !isStatusUnchanged) {
                    const allPages = await findActivePagesHierarchyBySite(dal.db, siteId);
                    const byId = new Map(allPages.map(p => [p.id, p]));
                    const childrenMap = new Map<string, typeof allPages>();
                    for (const p of allPages) {
                        if (p.parent_id) {
                            const arr = childrenMap.get(p.parent_id) || [];
                            arr.push(p);
                            childrenMap.set(p.parent_id, arr);
                        }
                    }

                    const resolveNodeBare = (nodeId: string, useNewSelf: boolean): string => {
                        const segs: string[] = [];
                        let cur: string | null = nodeId;
                        const seen = new Set<string>();
                        while (cur && !seen.has(cur)) {
                            seen.add(cur);
                            const row: { slug: string; parent_id: string | null; status: string } | undefined = cur === pageId && useNewSelf
                                ? { slug, parent_id: parentId, status }
                                : byId.get(cur);
                            if (!row) break;
                            if (cur !== nodeId && row.status !== 'published') break;
                            const clean = String(row.slug || '').replace(/^\/+|\/+$/g, '');
                            if (clean && clean !== 'index') segs.unshift(clean);
                            cur = row.parent_id;
                        }
                        return segs.length > 0 ? `/${segs.join('/')}` : '/';
                    };

                    const queue = [...(childrenMap.get(pageId) || [])];
                    const seenDesc = new Set<string>([pageId]);
                    while (queue.length > 0) {
                        const desc = queue.shift()!;
                        if (seenDesc.has(desc.id)) continue;
                        seenDesc.add(desc.id);
                        for (const child of childrenMap.get(desc.id) || []) queue.push(child);

                        const descMeta = parseJson<Record<string, any>>(desc.metadata, {});
                        if (descMeta.page_type === 'template') continue;
                        const descLocale = desc.locale || siteDefaultLocale;
                        const oldDescPath = buildLocalizedRoutePath(resolveNodeBare(desc.id, false), descLocale, siteDefaultLocale);
                        const newDescPath = buildLocalizedRoutePath(resolveNodeBare(desc.id, true), descLocale, siteDefaultLocale);
                        purgeSet.add(oldDescPath);
                        if (desc.status === 'published' && !isRestrictedAccess(desc.visibility, descMeta)) {
                            const isRedir = descMeta.page_type === 'redirect';
                            stmts.push(buildDeleteOtherSiteRoutesStatement(dal.db, siteId, desc.id, newDescPath));
                            stmts.push(buildUpsertSiteRouteStatement(dal.db, {
                                siteId,
                                path: newDescPath,
                                entityType: isRedir ? 'redirect' : 'page',
                                entityId: desc.id,
                                locale: descLocale,
                                translationGroupId: desc.translation_group_id || descMeta.translation_group_id || null,
                                title: desc.title || 'Untitled Page',
                                renderedHtml: null,
                                statusCode: isRedir ? (parseInt(descMeta.redirect_code) || 301) : 200,
                                redirectTarget: isRedir ? sanitizeRedirectTarget(descMeta.redirect_url) : null,
                                isDirty: isRedir ? 0 : 1
                            }));
                            dirtySet.add(newDescPath);
                            purgeSet.add(newDescPath);
                        } else {
                            stmts.push(buildDeleteEntitySiteRoutesStatement(dal.db, siteId, desc.id));
                        }
                    }
                }
                return { stmts, dirtyPaths: Array.from(dirtySet), purgePaths: Array.from(purgeSet) };
            };

            if (latestVer) {
                const isContentUnchanged = (latestVer.content_raw || '') === effectiveContentRaw;
                const explicitPublishedAt = normalizePublishedAtInput(data.publishedAt ?? data.published_at, existing.published_at || null);
                const isPublishedAtUnchanged = !explicitPublishedAt || explicitPublishedAt === (existing.published_at || '');
                const oldAliases = normalizeAliasesList(existingMetaObj.aliases);
                const aliasPurgePaths = Array.from(new Set([...oldAliases, ...normalizedAliases]));

                if (isContentUnchanged && isTitleUnchanged && isSlugUnchanged && isLocaleUnchanged && isParentUnchanged && isStatusUnchanged && isVisibilityUnchanged && isSummaryUnchanged && isMetaUnchanged && isPublishedAtUnchanged) {
                    return makeResult(latestVer.id, latestVer.version_number, true, true);
                }

                const cascade = await buildHierarchyCascade();
                const allPurgePaths = Array.from(new Set([...cascade.purgePaths, ...aliasPurgePaths]));

                if (isContentUnchanged) {
                    await dal.batch([
                        buildUpdatePageMetadataOnlyStatement(dal.db, {
                            title,
                            slug,
                            parentId,
                            locale,
                            translationGroupId: pageMeta.translation_group_id || null,
                            status,
                            visibility,
                            summary,
                            metadataStr,
                            publishedAt: explicitPublishedAt ?? null,
                            pageId,
                            siteId
                        }),
                        buildUpdatePageVersionSnapshotStatement(dal.db, {
                            title,
                            summary,
                            metadataSnapshot: metadataStr,
                            versionId: latestVer.id
                        }),
                        ...buildPageRouteStmts(),
                        ...cascade.stmts
                    ]);
                    invalidateSiteMemoryCache(siteId);
                    return makeResult(latestVer.id, latestVer.version_number, false, true, {
                        extraDirtyPaths: cascade.dirtyPaths,
                        extraPurgePaths: allPurgePaths,
                        oldTranslationGroupId: oldTgId
                    });
                }

                const maxVer = await findMaxEntityVersionNumber(dal.db, 'page', pageId);
                const nextVersionNumber = Math.max(latestVer.version_number, maxVer) + 1;
                const newVersionId = nanoId('ver');
                const nowIso = new Date().toISOString();

                await dal.batch([
                    buildInsertPageVersionStatement(dal.db, {
                        id: newVersionId,
                        siteId,
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
                        translationGroupId: pageMeta.translation_group_id || null,
                        status,
                        visibility,
                        summary,
                        metadataStr,
                        versionId: newVersionId,
                        publishedAt: explicitPublishedAt ?? null,
                        pageId,
                        siteId
                    }),
                    ...buildPageRouteStmts(),
                    ...cascade.stmts
                ]);
                invalidateSiteMemoryCache(siteId);

                return makeResult(newVersionId, nextVersionNumber, false, true, {
                    extraDirtyPaths: cascade.dirtyPaths,
                    extraPurgePaths: allPurgePaths,
                    oldTranslationGroupId: oldTgId
                });
            }
        }
    }

    const newVersionId = nanoId('ver');
    const nowIso = new Date().toISOString();
    const publishedAt = normalizePublishedAtInput(data.publishedAt ?? data.published_at) || (status === 'published' ? nowIso : null);

    await dal.batch([
        buildDeleteSoftDeletedPageDuplicatesStatement(dal.db, siteId, slug, locale, parentId),
        buildInsertPageStatement(dal.db, {
            id: pageId,
            siteId,
            slug,
            parentId,
            locale,
            status,
            visibility,
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
            siteId,
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

        engine.registerService<{ id: string; siteId?: string }, { success: boolean; siteId?: string; slug?: string; isTemplate?: boolean; translationGroupId?: string | null; localizedPath?: string }>(
            'PAGE_DELETE',
            async (ctx) => {
                const pageId = ctx.data.id;
                const scopeSiteId = await resolveActiveSiteId(ctx.dal, ctx.data?.siteId || ctx.siteId);
                await assertSiteAdmin(ctx.dal, scopeSiteId, ctx.user);
                const isSuper = ctx.user?.global_role === 'superadmin';
                const node = await findNodeSiteAndSlug(ctx.dal.db, pageId, isSuper ? undefined : scopeSiteId);
                if (!node) throw new Error('FORBIDDEN_CROSS_SITE_ACCESS');
                const pageRow = await findPageForVcs(ctx.dal.db, pageId, node.site_id);
                const pageMeta = parseJson<Record<string, any>>(pageRow?.metadata, {});
                const isTemplate = pageMeta.page_type === 'template';
                if (isTemplate) {
                    const deps = await findActiveTemplateDependents(ctx.dal.db, node.site_id, pageId, node.slug);
                    if (deps.isDefaultTemplate || deps.referencingPageCount > 0) {
                        throw new Error('TEMPLATE_IN_USE_CANNOT_DELETE');
                    }
                }
                const site = await ctx.dal.findSiteById(node.site_id);
                const siteDefaultLocale = site?.default_locale || 'zh-CN';
                const parentPath = pageRow?.parent_id ? await findPageSlugById(ctx.dal.db, pageRow.parent_id) : null;
                const localizedPath = buildLocalizedRoutePath(normalizeRoutePath(node.slug, parentPath), pageRow?.locale || siteDefaultLocale, siteDefaultLocale);
                const translationGroupId = pageMeta.translation_group_id || null;

                await ctx.dal.batch(buildSoftDeleteNodeStatements(ctx.dal.db, pageId, 'page', node.site_id));

                return {
                    success: true,
                    siteId: node.site_id,
                    slug: node.slug,
                    isTemplate,
                    translationGroupId,
                    localizedPath
                };
            }
        );

        engine.tapAfter<{ id: string }, { success: boolean; siteId?: string; slug?: string; isTemplate?: boolean; translationGroupId?: string | null; localizedPath?: string }>(
            'PAGE_DELETE',
            async (ctx) => {
                if (ctx.result?.siteId) {
                    const sId = ctx.result.siteId;
                    const peerPaths = await markTranslationGroupPeersDirty(ctx.dal.db, sId, ctx.data.id, ctx.result.translationGroupId);
                    await removeEntityFromSiteRoutes(ctx.dal.db, sId, ctx.data.id);
                    if (ctx.result.isTemplate) {
                        await buildMarkAllNonRedirectSiteRoutesDirtyStatement(ctx.dal.db, sId).run();
                    }
                    await purgeEdgeAndZoneCache(
                        ctx.dal.db,
                        sId,
                        [ctx.result.localizedPath || '/', ...peerPaths, '/', '/sitemap.xml'],
                        { purgeEverything: Boolean(ctx.result.isTemplate) }
                    );
                    const site = await ctx.dal.findSiteById(sId);
                    if (site) {
                        await rebuildSiteSitemapRoute(ctx.dal.db, site, ctx.host);
                    }
                }
            }
        );

        engine.tapBefore<SetDefaultTemplatePayload>('PAGE_SET_DEFAULT_TEMPLATE', async (ctx) => {
            if (!ctx.data.siteId) {
                throw new Error('MISSING_SITE_ID');
            }
            await assertSiteAdmin(ctx.dal, ctx.data.siteId, ctx.user);
        });

        engine.registerService<SetDefaultTemplatePayload, { success: boolean }>(
            'PAGE_SET_DEFAULT_TEMPLATE',
            async (ctx) => {
                const { siteId, templateId } = ctx.data;
                const settingsStr = await getSiteSettingsString(ctx.dal.db, siteId);
                const settings = parseJson<Record<string, any>>(settingsStr, {});

                settings.default_template_page_id = templateId;
                await ctx.dal.batch([
                    buildUpdateSiteSettingsOnlyStatement(ctx.dal.db, siteId, JSON.stringify(settings)),
                    buildMarkAllNonRedirectSiteRoutesDirtyStatement(ctx.dal.db, siteId)
                ]);
                invalidateSiteMemoryCache(siteId);

                return { success: true };
            }
        );

        engine.tapAfter<SetDefaultTemplatePayload, { success: boolean }>(
            'PAGE_SET_DEFAULT_TEMPLATE',
            async (ctx) => {
                if (ctx.data?.siteId) {
                    await purgeEdgeAndZoneCache(ctx.dal.db, ctx.data.siteId, ['/', '/sitemap.xml'], { purgeEverything: true });
                }
            }
        );
    }
};
