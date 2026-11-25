import type { D1Database } from '@cloudflare/workers-types';
import type { Site, AuthenticatedUser, ThemeComponentManifest } from '../types';
import { SeoPlugin } from '../services';
import { ENGINE_CORE_VERSION, getSharedPluginEngine, createHookContext } from '../kernel';
import { renderTemplate, fetchAsset } from './template';
import { renderFallbackErrorHtml, resolveSiteBrandInfo, normalizeRoutePath } from '../core/dal';
import { buildAbsoluteUrl, resolveEffectiveDomain } from '../core/url';
import { sanitizeRedirectTarget, sanitizeHexColor, isSiteAdminUser } from '../core/utils';
import { getInlineI18nScript, buildLocalizedRoutePath, normalizeLocaleCode } from '../core/i18n';
import {
    findPublishedNodeBySlug,
    findLatestActiveVersion,
    findPublishedThemeBundle,
    getPeerTranslationLinks,
    findNodeById,
    findSiteRouteByPath,
    findTranslatedTemplatePage,
    findPageSlugById,
    findSiteMemberRole,
    isRestrictedAccess
} from '../core/dal';
import {
    EXT_ISLAND_SLUG_RE,
    isPageContentPlaceholder,
    isExtIslandPlaceholder,
    buildSafeExtIslandSrc,
    resolveThemeAssetUrl,
    resolveWikiTargetsForMarkdown,
    findComponentInMap,
    renderBlockItem,
    extractBlocksFromNode,
    type PrecomputedArticleData
} from './block-renderer';
export { resolveThemeAssetUrl, extractBlocksFromNode };
import {
    escapeHtmlAttr,
    safeJsonStringify,
    sanitizeUrlAttr,
    renderMarkdownToHtml,
    processThemeMarkdownComponents
} from './markdown-parser';
import { resolveApiProtocolValue } from './api-protocol';

export {
    escapeHtmlAttr,
    safeJsonStringify,
    sanitizeUrlAttr,
    renderMarkdownToHtml,
    processThemeMarkdownComponents,
    resolveApiProtocolValue
};
import {
    resolveBuiltinSiteFields,
    resolveBuiltinPageFields,
    buildTemplateScope,
    applyBlockFieldMap,
    type BuiltinRenderContext
} from './field-mapping';

const seoPlugin = new SeoPlugin();

const DEFAULT_LAYOUT_SKELETON = `{{edge_head}}\n{{slot:header:1}}\n{{slot:subnav:2}}\n{{slot:main}}\n{{slot:sidebar:3}}\n{{slot:footer:1}}\n{{edge_foot}}`;

function parseMeta(val: unknown): Record<string, any> {
    if (!val) return {};
    if (typeof val === 'object') return val as Record<string, any>;
    try {
        return JSON.parse(val as string) || {};
    } catch {
        return {};
    }
}

function isTemplateNode(node: any): boolean {
    if (!node || node.type !== 'page') return false;
    return parseMeta(node.metadata).page_type === 'template';
}

type DynamicRenderResult = {
    html: string;
    status: number;
    redirectUrl?: string;
    entityId?: string;
    entityType?: string;
    title?: string;
    dependencies?: string[];
    robots?: string;
    passwordRequired?: boolean;
    noCache?: boolean;
    translationGroupId?: string;
};

async function resolveVisitorNodeWithGates(
    db: D1Database,
    site: Site,
    rawPath: string,
    host: string,
    locale: string,
    user?: AuthenticatedUser,
    isPreview = false,
    verifyPasswordUnlock?: (nodeId: string, accessPassword: string) => Promise<boolean>,
    renderOptions?: { requestPath?: string; hasExplicitLocalePrefix?: boolean }
): Promise<
    | { earlyResult: DynamicRenderResult }
    | {
        matchedNode: any;
        matchedVersion: any;
        matchedNodeMeta: Record<string, any>;
        isPasswordProtected: boolean;
        isRestrictedNode: boolean;
        canonicalLocalizedPath: string;
        cleanSlug: string;
        routePath: string;
        siteDefaultLocale: string;
    }
> {
    const isHomePage = rawPath === '/' || rawPath === '';
    const cleanSlug = rawPath.replace(/^\/+|\/+$/g, '').replace(/^(article|page)\//, '');
    const routePath = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
    const siteDefaultLocale = site.default_locale || 'zh-CN';
    const localizedLookupPath = buildLocalizedRoutePath(routePath, locale || siteDefaultLocale, siteDefaultLocale);

    let matchedNode: any = null;
    let matchedVersion: any = null;

    try {
        const routeRow = await findSiteRouteByPath(db, site.id, localizedLookupPath);
        if (routeRow && routeRow.entity_id && routeRow.entity_id !== 'home' && normalizeLocaleCode(routeRow.locale || siteDefaultLocale) === normalizeLocaleCode(locale || siteDefaultLocale)) {
            matchedNode = await findNodeById(db, routeRow.entity_id, routeRow.entity_type as any);
            if (matchedNode && (matchedNode.deleted_at || (!isPreview && (matchedNode.status !== 'published' || isTemplateNode(matchedNode))))) {
                matchedNode = null;
            }
            if (matchedNode) {
                matchedVersion = await findLatestActiveVersion(db, matchedNode.id);
            }
        }
    } catch {}

    if (!matchedNode) {
        if (!isHomePage) {
            matchedNode = await findPublishedNodeBySlug(db, site.id, cleanSlug, locale, 'all');
            if (isTemplateNode(matchedNode) && !isPreview) matchedNode = null;
        } else {
            const rootPage = await findPublishedNodeBySlug(db, site.id, '/', locale, 'all');
            if (rootPage && (!isTemplateNode(rootPage) || isPreview)) matchedNode = rootPage;
        }
    }

    let isPasswordProtected = false;
    let isRestrictedNode = false;
    if (matchedNode) {
        const nodeMeta = parseMeta(matchedNode.metadata);
        const vis = String(matchedNode.visibility || 'public').toLowerCase();
        const accessPerm = String(nodeMeta.access_permission || 'public').toLowerCase();
        isRestrictedNode = isRestrictedAccess(vis, nodeMeta);

        if (vis === 'api_only' && !isPreview) {
            matchedNode = null;
        } else if ((vis === 'private' || accessPerm === 'admin_only') && !isPreview) {
            const isAdmin = Boolean(
                user && isSiteAdminUser(user)
                && (user.global_role === 'superadmin' || (await findSiteMemberRole(db, site.id, user.id)) === 'admin')
            );
            if (!isAdmin) {
                return { earlyResult: { html: renderFallbackErrorHtml(403 as any, site.name, locale), status: 403, noCache: true } };
            }
        } else if (accessPerm === 'members_only' && !isPreview && !user) {
            return { earlyResult: { html: renderFallbackErrorHtml(403 as any, site.name, locale), status: 403, noCache: true } };
        } else if (vis === 'password' || accessPerm === 'password_protected') {
            isPasswordProtected = true;
            const expectedPw = String(nodeMeta.access_password || '');
            const unlocked = (isPreview && Boolean(user))
                || (verifyPasswordUnlock ? await verifyPasswordUnlock(matchedNode.id, expectedPw) : false);
            if (!unlocked) {
                return {
                    earlyResult: {
                        html: '',
                        status: 200,
                        passwordRequired: true,
                        noCache: true,
                        entityId: matchedNode.id,
                        entityType: matchedNode.type || 'article',
                        title: matchedNode.title || ''
                    }
                };
            }
        }
    }

    if (matchedNode && !matchedVersion) {
        matchedVersion = await findLatestActiveVersion(db, matchedNode.id);
    }

    if (matchedNode && matchedNode.type === 'page') {
        const pageMeta = parseMeta(matchedNode.metadata);
        if (pageMeta.page_type === 'redirect') {
            return {
                earlyResult: {
                    html: '',
                    status: parseInt(pageMeta.redirect_code) || 301,
                    redirectUrl: sanitizeRedirectTarget(pageMeta.redirect_url),
                    entityId: matchedNode.id,
                    entityType: 'redirect',
                    title: matchedNode.title
                }
            };
        }
    }

    if (!matchedNode) {
        const errCode = cleanSlug === '500' ? 500 : (cleanSlug === '503' || cleanSlug === 'maintenance') ? 503 : 404;
        if (errCode === 404 && cleanSlug !== '404') {
            try {
                const c404 = await findPublishedNodeBySlug(db, site.id, '404');
                if (c404 && !isTemplateNode(c404)) {
                    const res = await renderDynamicVisitorPage(db, site, '/404', host, locale, user);
                    if (res.html) return { earlyResult: { html: res.html, status: 404 } };
                }
            } catch {}
        }
        return { earlyResult: { html: renderFallbackErrorHtml(errCode as any, site.name, locale), status: errCode } };
    }

    const matchedParentSlug = (matchedNode.type === 'page' && matchedNode.parent_id)
        ? await findPageSlugById(db, matchedNode.parent_id)
        : null;
    const nodeBarePath = matchedNode.type === 'page'
        ? normalizeRoutePath(matchedNode.slug, matchedParentSlug)
        : normalizeRoutePath(matchedNode.slug);
    const nodeLocale = matchedNode.locale || locale || siteDefaultLocale;
    const canonicalLocalizedPath = buildLocalizedRoutePath(nodeBarePath, nodeLocale, siteDefaultLocale);
    const incomingRequestPath = renderOptions?.requestPath ? normalizeRoutePath(renderOptions.requestPath) : routePath;
    const isSpecialErrorSlug = ['404', '500', '503', 'maintenance'].includes(cleanSlug);

    // Redirect mismatched or redundant default-locale prefixes so each node resolves to a single canonical URL.
    const isLocaleMismatch = normalizeLocaleCode(nodeLocale) !== normalizeLocaleCode(siteDefaultLocale);
    const hasRedundantDefaultPrefix = Boolean(renderOptions?.hasExplicitLocalePrefix) && !isLocaleMismatch;
    if (
        !isPreview
        && !isSpecialErrorSlug
        && !isTemplateNode(matchedNode)
        && (isLocaleMismatch || hasRedundantDefaultPrefix)
        && incomingRequestPath !== canonicalLocalizedPath
    ) {
        return {
            earlyResult: {
                html: '',
                status: 301,
                redirectUrl: canonicalLocalizedPath,
                noCache: true
            }
        };
    }

    return {
        matchedNode,
        matchedVersion,
        matchedNodeMeta: parseMeta(matchedNode.metadata),
        isPasswordProtected,
        isRestrictedNode,
        canonicalLocalizedPath,
        cleanSlug,
        routePath,
        siteDefaultLocale
    };
}

function buildComponentLookupMap(componentNodeList: any[]): Map<string, ThemeComponentManifest> {
    const componentMap = new Map<string, ThemeComponentManifest>();
    for (const comp of componentNodeList || []) {
        const cMeta = parseMeta(comp.metadata);
        const slug = comp.slug || comp.type || cMeta.slug || cMeta.type;
        const name = comp.title || comp.name || cMeta.title || cMeta.name || slug;
        const templateHtml = comp.template_html || cMeta.template_html || comp.templateHtml || cMeta.templateHtml || comp.template || cMeta.template || '';
        const rawSlots = comp.slots || cMeta.slots || (comp.slot ? [comp.slot] : (cMeta.slot ? [cMeta.slot] : ['main']));
        const slots = Array.isArray(rawSlots) && rawSlots.length > 0 ? rawSlots : ['main'];
        const merged: ThemeComponentManifest = {
            ...cMeta,
            ...comp,
            slug,
            type: slug,
            name,
            slots,
            template_html: templateHtml,
            templateHtml
        };
        if (slug) {
            componentMap.set(slug, merged);
            componentMap.set(slug.toLowerCase(), merged);
            componentMap.set(slug.replace(/[-_]/g, '').toLowerCase(), merged);
        }
        if (name) componentMap.set(name, merged);
    }
    return componentMap;
}

async function resolveBoundTemplateAndBlocks(
    db: D1Database,
    site: Site,
    matchedNode: any,
    matchedVersion: any,
    matchedNodeMeta: Record<string, any>,
    themeTemplates: any[],
    requestLocale: string,
    siteDefaultLocale: string
): Promise<{ targetTemplateNode: any | null; templateBlocks: any[]; ownBlocks: any[] }> {
    const findTemplateByIdOrSlug = async (id: string): Promise<any | null> => {
        if (!id) return null;
        const dbNode = await findNodeById(db, id);
        if (dbNode) {
            return (dbNode.site_id === site.id && dbNode.status === 'published' && !dbNode.deleted_at) ? dbNode : null;
        }
        const bySlug = await findPublishedNodeBySlug(db, site.id, id, requestLocale);
        if (bySlug && bySlug.site_id === site.id && bySlug.status === 'published' && !bySlug.deleted_at) {
            return bySlug;
        }
        return themeTemplates.find(t => t.id === id || t.slug === id) || null;
    };

    const ownBlocks = extractBlocksFromNode(matchedNode, matchedVersion);
    const tplId = matchedNodeMeta.template_page_id || matchedNodeMeta.template_id || matchedNodeMeta.template_slug || '';
    let targetTemplateNode: any = tplId ? await findTemplateByIdOrSlug(tplId) : null;
    if (!targetTemplateNode && matchedNode.type === 'article') {
        targetTemplateNode = themeTemplates.find(t => t.slug?.includes('article')) || null;
    }
    if (!targetTemplateNode && site.settings?.default_template_page_id) {
        targetTemplateNode = await findTemplateByIdOrSlug(site.settings.default_template_page_id);
    }

    // Automatically switch bound template pages to the matching translation-group peer for requestLocale, falling back cleanly if absent.
    if (targetTemplateNode && targetTemplateNode.type === 'page') {
        const tplMeta = parseMeta(targetTemplateNode.metadata);
        const tplLocaleNorm = normalizeLocaleCode(targetTemplateNode.locale || tplMeta.locale || siteDefaultLocale).toLowerCase();
        const reqLocaleNorm = normalizeLocaleCode(requestLocale).toLowerCase();
        const tplTransGroupId = targetTemplateNode.translation_group_id || tplMeta.translation_group_id || '';
        if (tplTransGroupId && tplLocaleNorm !== reqLocaleNorm) {
            const translatedTpl = await findTranslatedTemplatePage(db, site.id, tplTransGroupId, requestLocale);
            if (translatedTpl) targetTemplateNode = translatedTpl;
        }
    }

    if (targetTemplateNode && targetTemplateNode.id === matchedNode.id) {
        targetTemplateNode = null;
    }

    let templateBlocks: any[] = [];
    if (targetTemplateNode) {
        const tplVer = targetTemplateNode.id ? await findLatestActiveVersion(db, targetTemplateNode.id) : null;
        templateBlocks = extractBlocksFromNode(targetTemplateNode, tplVer);
    }

    return { targetTemplateNode, templateBlocks, ownBlocks };
}

async function resolveActivePublicExtensionsMap(
    db: D1Database,
    siteId: string,
    siteSettingsObj: Record<string, any>,
    env?: any
): Promise<Map<string, any>> {
    const activeExtMap = new Map<string, any>();
    const pluginEngine = getSharedPluginEngine();
    if ((typeof __BUILD_EDITION__ === 'undefined' || __BUILD_EDITION__ !== 'community')
        && pluginEngine.hasService('WORKER_BRIDGE_RESOLVE_PUBLIC')
        && Array.isArray(siteSettingsObj.external_workers)
        && siteSettingsObj.external_workers.length > 0) {
        try {
            const extRes = await pluginEngine.runPipeline<{ siteId?: string }, { workers?: any[] }>(createHookContext({
                action: 'WORKER_BRIDGE_RESOLVE_PUBLIC',
                data: { siteId },
                env: env || { DB: db },
                siteId
            }));
            for (const w of (extRes?.workers || [])) {
                const wSlug = String(w?.slug || '').trim().toLowerCase();
                if (wSlug && EXT_ISLAND_SLUG_RE.test(wSlug)) activeExtMap.set(wSlug, w);
            }
        } catch {
            // Fail closed when license is missing or expired so unlicensed/community sites emit zero extension islands or scripts.
        }
    }
    return activeExtMap;
}

function finalizeDocumentHtml(opts: {
    layoutHtml: string;
    site: Site;
    themeNode: any;
    themeMeta: Record<string, any>;
    themeSlug: string;
    siteSettingsObj: Record<string, any>;
    matchedNode: any;
    builtinContext: BuiltinRenderContext;
    blocksMeta: Array<{ id: string; component: string; slot: string; props: Record<string, any> }>;
    hasScopedBlockJs: boolean;
    seoHeaders: string;
    routePath: string;
    locale: string;
    isPreview: boolean;
    activeExtMap: Map<string, any>;
}): string {
    const {
        site, themeNode, themeMeta, themeSlug, siteSettingsObj, matchedNode,
        builtinContext, blocksMeta, hasScopedBlockJs, seoHeaders, routePath,
        locale, isPreview, activeExtMap
    } = opts;
    const builtinSite = builtinContext.site;
    const builtinPage = builtinContext.page;
    const themeRoot = `/theme/${themeSlug}`;
    const toThemeUrl = (p: string) => resolveThemeAssetUrl(p, themeRoot);
    const assetVer = encodeURIComponent(`${themeMeta.version || ENGINE_CORE_VERSION}_${themeNode?.updated_at || ''}`);
    const withAssetVer = (u: string) => (u.includes('?') ? `${u}&v=${assetVer}` : `${u}?v=${assetVer}`);
    const styleSet = new Set<string>([...(themeMeta.global_assets?.styles || []), themeMeta.assets?.css].filter(Boolean).map(toThemeUrl));
    const scriptSet = new Set<string>([...(themeMeta.global_assets?.scripts || []), themeMeta.assets?.js].filter(Boolean).map(toThemeUrl));

    // Emit <link rel="stylesheet"> so browsers cache declared theme CSS across navigations instead of re-downloading inline blobs.
    const styleTags = Array.from(styleSet).map(href => `<link rel="stylesheet" href="${withAssetVer(href)}" />`).join('\n    ');
    const scriptTags = Array.from(scriptSet).map(src => `<script src="${withAssetVer(src)}" defer></script>`).join('\n    ');
    const customCss = themeMeta.custom_css ? `<style>${String(themeMeta.custom_css).replace(/<\/style>/gi, '<\\/style>')}</style>` : '';
    const customJs = themeMeta.custom_js ? `<script>${String(themeMeta.custom_js).replace(/<\/script>/gi, '<\\/script>')}</script>` : '';

    const blocksMap: Record<string, any> = {};
    for (const b of blocksMeta) blocksMap[b.id] = b;

    const rawColorSchemes = Array.isArray(themeMeta.color_schemes)
        ? themeMeta.color_schemes.filter((s: unknown): s is 'light' | 'dark' => s === 'light' || s === 'dark')
        : [];
    const colorSchemes = Array.from(new Set(rawColorSchemes.length > 0 ? rawColorSchemes : ['light', 'dark']));

    const lightPrimary = sanitizeHexColor(siteSettingsObj.primary_color ?? siteSettingsObj.appearance?.primary_color);
    const darkPrimaryRaw = sanitizeHexColor(siteSettingsObj.primary_color_dark ?? siteSettingsObj.appearance?.primary_color_dark);
    const siteVarsStyleTag = lightPrimary
        ? `<style id="edge-site-vars">:root{--edge-primary:${lightPrimary};}html.dark{--edge-primary:${darkPrimaryRaw || lightPrimary};}</style>`
        : (darkPrimaryRaw ? `<style id="edge-site-vars">html.dark{--edge-primary:${darkPrimaryRaw};}</style>` : '');

    const frontendContextScript = `<script>window.__EDGE__ = ${safeJsonStringify({
        site: { id: site.id, name: site.name, locale },
        route: { path: routePath, type: matchedNode?.type || 'page', targetId: matchedNode?.id || null },
        color_schemes: colorSchemes,
        powered_by: builtinSite.powered_by,
        blocks: blocksMeta,
        blocksMap
    })};</script>`;

    const inlineI18nTag = 'WALNUT_INLINE_I18N_PLACEHOLDER';

    // Inject synchronously in <head> only when at least one active block renders custom_js, avoiding defer timing races and adding 0 bytes to static pages.
    const edgeMountScript = hasScopedBlockJs
        ? `\n    <script>(function(){if(window.__edgeMount)return;var c=new WeakMap();function clean(el){if(!el)return;var s=c.get(el);if(s){s.forEach(function(fn){try{fn();}catch(e){}});c.delete(el);}if(el.querySelectorAll){el.querySelectorAll('[data-block-id],[data-edge-comp]').forEach(function(n){var cs=c.get(n);if(cs){cs.forEach(function(fn){try{fn();}catch(e){}});c.delete(n);}});}}document.addEventListener('htmx:beforeCleanupElement',function(e){clean(e&&e.detail?e.detail.elt:null);});window.__edgeMount=function(scriptEl,fn){if(typeof fn!=='function')return;var el=scriptEl||document.currentScript;var root=el&&el.closest?(el.closest('[data-block-id],[data-edge-comp]')||el.parentElement):null;if(!root)return;var $=function(q){return root.querySelector(q);};var $$=function(q){return Array.from(root.querySelectorAll(q));};var onCleanup=function(cb){if(typeof cb!=='function')return;var s=c.get(root);if(!s){s=new Set();c.set(root,s);}s.add(cb);};try{fn(root,$,$$,onCleanup);}catch(err){console.error('[edgeMount]',err);}};})();</script>`
        : '';

    const buildHeadAssetsBlock = (seoBlock: string) => [
        seoBlock,
        siteVarsStyleTag,
        styleTags,
        `<script src="/shared/htmx.min.js?v=${assetVer}" defer></script>`,
        inlineI18nTag,
        `${frontendContextScript}${edgeMountScript}`,
        `<script src="/shared/theme-init.js?v=${assetVer}"></script>`,
        customCss
    ].filter(Boolean).join('\n    ');

    const walnutHeadHtml = `<meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    ${buildHeadAssetsBlock(seoHeaders)}`;

    const extFooterScripts = Array.from(activeExtMap.values())
        .filter((w: any) => w.inject_frontend_script === true)
        .map((w: any) => `<script src="/ext/${escapeHtmlAttr(String(w.slug).trim().toLowerCase())}/embed.js" defer></script>`)
        .join('\n    ');

    const walnutFootHtml = `<script src="/shared/visitor.js?v=${assetVer}" defer></script>
    <script>(function(){try{if(localStorage.getItem('edge_admin_hint')!=='1')return;}catch(e){return;}function load(){var s=document.createElement('script');s.src='/shared/quick-actions.js?v=${assetVer}';s.async=true;document.body.appendChild(s);}if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',load);}else{load();}})();</script>
    ${scriptTags}
    ${customJs}${extFooterScripts ? `\n    ${extFooterScripts}` : ''}`;

    let layoutHtml = opts.layoutHtml;
    if (layoutHtml.includes('{{edge_head}}')) {
        layoutHtml = layoutHtml.replace('{{edge_head}}', () => walnutHeadHtml);
    } else if (/<head[^>]*>([\s\S]*?)<\/head>/i.test(layoutHtml)) {
        layoutHtml = layoutHtml.replace(/<head([^>]*)>([\s\S]*?)<\/head>/i, (_full, attrs, inner) => {
            if (/<\s*(title|meta)\b/i.test(inner)) {
                const dedupedSeo = /<\s*title\b/i.test(inner) ? seoHeaders.replace(/<title>[\s\S]*?<\/title>\s*/i, '') : seoHeaders;
                return `<head${attrs}>${inner}\n    ${buildHeadAssetsBlock(dedupedSeo)}\n</head>`;
            }
            return `<head${attrs}>${inner}\n${walnutHeadHtml}</head>`;
        });
    }

    if (layoutHtml.includes('{{edge_foot}}')) {
        layoutHtml = layoutHtml.replace('{{edge_foot}}', () => walnutFootHtml);
    } else if (/<\/body>/i.test(layoutHtml)) {
        layoutHtml = layoutHtml.replace(/<\/body>/i, () => `${walnutFootHtml}\n</body>`);
    }

    let fullHtml = renderTemplate(layoutHtml, buildTemplateScope(builtinContext), true).trim();
    const isTplPreview = isPreview && isTemplateNode(matchedNode);
    fullHtml = fullHtml.replace(/\{\{([a-zA-Z0-9_.-]+)\}\}/g, (_m, key) =>
        isTplPreview ? `<code data-edge-unresolved>{{${key}}}</code>` : ''
    );
    const docLang = escapeHtmlAttr(builtinPage.locale || locale || site.default_locale || 'zh-CN');
    const missingLangRe = new RegExp('<' + 'html(?![^>]*\\blang=)', 'i');
    const emptyLangRe = new RegExp('(<' + 'html[^>]*\\blang=)(["\'])\\s*\\2', 'i');
    if (missingLangRe.test(fullHtml)) {
        fullHtml = fullHtml.replace(new RegExp('<' + 'html\\b', 'i'), (m) => `${m} lang="${docLang}"`);
    } else if (emptyLangRe.test(fullHtml)) {
        fullHtml = fullHtml.replace(emptyLangRe, `$1"${docLang}"`);
    }
    const siteBrand = resolveSiteBrandInfo(site);
    const brandReplacement = siteBrand.hasStickyWhitelabel
        ? (siteBrand.systemTitle || siteBrand.effectiveWhitelabel?.brand_name)
        : undefined;
    const actualInlineScript = getInlineI18nScript(
        locale,
        themeMeta?.locales?.[locale] || {},
        brandReplacement
    );
    fullHtml = fullHtml.replace(/WALNUT_INLINE_I18N_PLACEHOLDER/g, () => actualInlineScript);

    // Server-side omission guard: append minimal attribution only when enabled and no rendered <a> targets powered_by.url.
    if (builtinSite.powered_by.enabled) {
        const escapedPbUrl = builtinSite.powered_by.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const htmlNoScripts = fullHtml.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
        if (!new RegExp(`href=["']${escapedPbUrl}\\/?["']`, 'i').test(htmlNoScripts)) {
            const fallbackAttr = `<div data-edge-powered-by style="text-align:center;padding:12px 16px;font-size:12px;opacity:.75"><a href="${builtinSite.powered_by.url}" target="_blank" rel="noopener noreferrer">${builtinSite.powered_by.label}</a></div>`;
            fullHtml = /<\/body>/i.test(fullHtml)
                ? fullHtml.replace(/<\/body>/i, (m) => `${fallbackAttr}\n${m}`)
                : `${fullHtml}\n${fallbackAttr}`;
        }
    }
    return fullHtml;
}

export async function renderDynamicVisitorPage(
    db: D1Database,
    site: Site,
    rawPath: string,
    host: string,
    locale: string,
    user?: AuthenticatedUser,
    isPreview = false,
    verifyPasswordUnlock?: (nodeId: string, accessPassword: string) => Promise<boolean>,
    renderOptions?: { requestPath?: string; hasExplicitLocalePrefix?: boolean; env?: any }
): Promise<DynamicRenderResult> {
    const resolved = await resolveVisitorNodeWithGates(db, site, rawPath, host, locale, user, isPreview, verifyPasswordUnlock, renderOptions);
    if ('earlyResult' in resolved) return resolved.earlyResult;

    const {
        matchedNode, matchedVersion, matchedNodeMeta, isPasswordProtected,
        isRestrictedNode, canonicalLocalizedPath, cleanSlug, routePath, siteDefaultLocale
    } = resolved;

    const collectedDeps = new Set<string>();
    const { themeNode, templates: themeTemplates, components: componentNodeList } = await findPublishedThemeBundle(db, site.id);
    const themeMeta = parseMeta(themeNode?.metadata);
    const componentMap = buildComponentLookupMap(componentNodeList || []);
    const requestLocale = matchedNode ? (matchedNode.locale || locale || siteDefaultLocale) : (locale || siteDefaultLocale);

    const { targetTemplateNode, templateBlocks, ownBlocks } = await resolveBoundTemplateAndBlocks(
        db, site, matchedNode, matchedVersion, matchedNodeMeta, themeTemplates, requestLocale, siteDefaultLocale
    );

    const nodeType = matchedNode?.type || 'page';
    const isArticleLike = nodeType === 'article' || nodeType === 'micro';
    const rawArticleMarkdown = isArticleLike ? (matchedVersion?.content_raw || '') : '';
    const wikiTargetPathMap = isArticleLike
        ? await resolveWikiTargetsForMarkdown(db, site.id, rawArticleMarkdown, requestLocale, siteDefaultLocale)
        : undefined;
    const mdThemeMeta = { ...(themeMeta || {}), ...(site.settings || {}) };
    const renderedArticleHtml = isArticleLike
        ? processThemeMarkdownComponents(rawArticleMarkdown, mdThemeMeta, {
            currentLocale: requestLocale,
            defaultLocale: siteDefaultLocale,
            targetPathMap: wikiTargetPathMap
        })
        : '';

    let peerTranslationList: Array<{ locale: string; url: string; isCurrent: boolean }> = [];
    let translationsJson = '[]';
    const hreflangLinks: Array<{ locale: string; url: string }> = [];
    const transGroupId = matchedNode?.translation_group_id || matchedNodeMeta.translation_group_id;
    const effectiveHost = resolveEffectiveDomain(site.primary_domain, host);
    if (transGroupId) {
        const peerLinks = await getPeerTranslationLinks(db, site.id, matchedNode.id, effectiveHost, siteDefaultLocale);
        if (peerLinks.length > 1) {
            peerTranslationList = peerLinks.map((p: { url: string; isCurrent: boolean; locale: string }) => ({
                locale: escapeHtmlAttr(p.locale),
                url: sanitizeUrlAttr(p.url),
                isCurrent: Boolean(p.isCurrent)
            }));
            translationsJson = JSON.stringify(peerLinks);
            const seenHreflang = new Set<string>();
            for (const p of peerLinks as Array<{ locale: string; url: string }>) {
                if (p.locale && !seenHreflang.has(p.locale)) {
                    seenHreflang.add(p.locale);
                    hreflangLinks.push({ locale: p.locale, url: buildAbsoluteUrl(p.url, effectiveHost) });
                }
            }
            const defaultPeer = peerLinks.find((p: { locale: string }) => normalizeLocaleCode(p.locale) === normalizeLocaleCode(siteDefaultLocale)) || peerLinks[0];
            if (defaultPeer) hreflangLinks.push({ locale: 'x-default', url: buildAbsoluteUrl(defaultPeer.url, effectiveHost) });
        }
    }

    const targetNodeData = matchedNode ? { node: matchedNode, version: matchedVersion || undefined } : null;
    const themeSlug = themeNode?.slug || (site as any).theme_id || '';
    const builtinSite = resolveBuiltinSiteFields(site, host, themeSlug);
    const builtinPage = resolveBuiltinPageFields(targetNodeData, routePath, host, locale, site, renderedArticleHtml);
    const builtinContext: BuiltinRenderContext = { site: builtinSite, page: builtinPage };
    const themeLocalesObj = (themeMeta?.locales && typeof themeMeta.locales === 'object') ? themeMeta.locales : {};
    const precomputedArticleData: PrecomputedArticleData = {
        renderedArticleHtml,
        rawArticleMarkdown,
        translations: peerTranslationList,
        translationsJson,
        themeLocaleDict: themeLocalesObj[builtinPage.locale] || themeLocalesObj[locale] || themeLocalesObj['zh-CN'] || {},
        markdownThemeMeta: mdThemeMeta,
        requestLocale,
        siteDefaultLocale,
        publicAssetsDomain: renderOptions?.env?.PUBLIC_ASSETS_DOMAIN
    };

    let layoutHtml: string = themeMeta.layout_html || DEFAULT_LAYOUT_SKELETON;
    if (!themeMeta.layout_html && themeMeta.layout_file) {
        const fileContent = await fetchAsset(`/theme/${themeSlug}/${themeMeta.layout_file.replace(/^\/+/, '')}`);
        if (fileContent) layoutHtml = fileContent;
    }

    const slotQuotas = new Map<string, number>([['header', 1], ['footer', 1], ['sidebar', 3], ['main', Infinity]]);
    const slotTagRegex = /\{\{slot:([a-zA-Z0-9_-]+)(?::(\d+))?\}\}/g;
    let slotMatch: RegExpExecArray | null;
    while ((slotMatch = slotTagRegex.exec(layoutHtml)) !== null) {
        slotQuotas.set(slotMatch[1], slotMatch[2] !== undefined ? Math.max(0, parseInt(slotMatch[2], 10)) : Infinity);
    }

    const resolveBlockSlot = (blk: any): string => {
        if (isPageContentPlaceholder(blk)) return 'main';
        if (blk?.target_slot && typeof blk.target_slot === 'string') return blk.target_slot;
        if (blk?.slot && typeof blk.slot === 'string') return blk.slot;
        const cSlug = String(blk?.component || blk?.componentSlug || blk?.componentType || blk?.type || '');
        const cMeta = findComponentInMap(cSlug, componentMap);
        return (cMeta && Array.isArray(cMeta.slots) && cMeta.slots.length > 0) ? cMeta.slots[0] : 'main';
    };

    const tplBySlot = new Map<string, any[]>();
    for (const b of templateBlocks) {
        const s = resolveBlockSlot(b);
        tplBySlot.set(s, [...(tplBySlot.get(s) || []), b]);
    }
    const ownBySlot = new Map<string, any[]>();
    for (const b of ownBlocks) {
        if (isPageContentPlaceholder(b)) continue;
        const s = resolveBlockSlot(b);
        ownBySlot.set(s, [...(ownBySlot.get(s) || []), b]);
    }

    const siteSettingsObj = parseMeta(site.settings);
    const activeExtMap = await resolveActivePublicExtensionsMap(db, site.id, siteSettingsObj, renderOptions?.env);
    const allSlotNames = new Set<string>([...slotQuotas.keys(), ...tplBySlot.keys(), ...ownBySlot.keys()]);
    const renderedSlots = new Map<string, string>();
    const blocksMeta: Array<{ id: string; component: string; slot: string; props: Record<string, any> }> = [];
    let totalRenderedBlocks = 0;
    let hasScopedBlockJs = false;
    let globalIdx = 0;

    for (const slotName of allSlotNames) {
        const maxQuota = slotQuotas.get(slotName) ?? Infinity;
        const tplList = tplBySlot.get(slotName) || [];
        const ownList = ownBySlot.get(slotName) || [];
        // Enqueue template blocks before page blocks so fixed-quota slots preserve template chrome; main requires @slot:page_content when bound to a template.
        const mergedQueue = (slotName === 'main' && targetTemplateNode && templateBlocks.length > 0)
            ? (tplList.some(b => isPageContentPlaceholder(b))
                ? tplList.flatMap(b => isPageContentPlaceholder(b) ? ownList : [b]).slice(0, maxQuota)
                : tplList.slice(0, maxQuota))
            : [...tplList, ...ownList].slice(0, maxQuota);

        const slotHtmlParts: string[] = [];
        for (const block of mergedQueue) {
            if (isPageContentPlaceholder(block)) continue;
            const compSlug = String(block.component || block.componentSlug || block.componentType || block.type || '').toLowerCase();
            const blockId = String(block.id || `blk_${globalIdx++}_${compSlug.replace(/[^a-zA-Z0-9_-]/g, '_')}`);
            const rawBlockProps = (block.props && typeof block.props === 'object')
                ? block.props
                : (block.data && typeof block.data === 'object' ? block.data : {});

            if (isExtIslandPlaceholder(block)) {
                const extSlug = String(rawBlockProps.slug || '').trim().toLowerCase();
                const safeSrc = activeExtMap.has(extSlug) ? buildSafeExtIslandSrc(extSlug, rawBlockProps.path, rawBlockProps.params) : null;
                if (!safeSrc) continue;
                blocksMeta.push({ id: blockId, component: '@ext:island', slot: slotName, props: { slug: extSlug, path: safeSrc } });
                slotHtmlParts.push(`<div class="edge-ext-island" data-edge-ext-src="${escapeHtmlAttr(safeSrc)}" data-edge-ext-slug="${escapeHtmlAttr(extSlug)}"></div>`);
                totalRenderedBlocks++;
                continue;
            }

            const { html: renderedHtml, hasCustomJs } = await renderBlockItem(block, blockId, componentMap, db, site.id, cleanSlug, precomputedArticleData, builtinContext, collectedDeps);
            if (!renderedHtml) continue;
            if (hasCustomJs) hasScopedBlockJs = true;
            const { custom_js: _omitCustomJs, powered_by: _omitPb, translations: _omitTr, translations_json: _omitTrJson, ...publicBlockProps } = rawBlockProps;
            blocksMeta.push({ id: blockId, component: compSlug, slot: slotName, props: publicBlockProps });
            slotHtmlParts.push(renderedHtml);
            totalRenderedBlocks++;
        }
        renderedSlots.set(slotName, slotHtmlParts.join('\n'));
    }

    const mainSlotHtml = (renderedSlots.get('main') || '').trim();
    if ((totalRenderedBlocks === 0 || !mainSlotHtml) && (renderedArticleHtml || builtinPage.title)) {
        renderedSlots.set('main', (isArticleLike && renderedArticleHtml)
            ? `<div data-edge-fallback><h1>${escapeHtmlAttr(builtinPage.title)}</h1><div>${renderedArticleHtml}</div></div>`
            : `<div data-edge-fallback><h1>${escapeHtmlAttr(builtinPage.title)}</h1>${builtinPage.summary ? `<p>${escapeHtmlAttr(builtinPage.summary)}</p>` : ''}</div>`);
    }

    layoutHtml = layoutHtml.replace(/\{\{slot:([a-zA-Z0-9_-]+)(?::\d+)?\}\}/g, (_m, sName) => renderedSlots.get(sName) || '');
    const selfPeer = peerTranslationList.find(p => p.isCurrent);
    const seoMetadata = seoPlugin.assembleSeoMetadata(site, targetNodeData?.node, {
        currentUrl: buildAbsoluteUrl(selfPeer?.url || canonicalLocalizedPath, effectiveHost),
        rawContent: isArticleLike ? (targetNodeData?.version?.content_raw || '') : undefined,
        pageNode: targetTemplateNode || undefined,
        authorName: matchedNodeMeta.author || (matchedNode as any)?.author || site.name
    });
    const seoHeaders = seoPlugin.serializeSeoHeaders(site, seoMetadata, hreflangLinks, builtinPage.locale || locale);

    const fullHtml = finalizeDocumentHtml({
        layoutHtml, site, themeNode, themeMeta, themeSlug, siteSettingsObj,
        matchedNode, builtinContext, blocksMeta, hasScopedBlockJs, seoHeaders,
        routePath, locale, isPreview, activeExtMap
    });

    const isTplPreview = isPreview && isTemplateNode(matchedNode);
    const finalStatus = cleanSlug === '404' ? 404 : (cleanSlug === '500' ? 500 : (cleanSlug === '503' || cleanSlug === 'maintenance' ? 503 : 200));

    return {
        html: fullHtml,
        status: finalStatus,
        entityId: matchedNode.id,
        entityType: matchedNode.type || 'page',
        title: matchedNode.title,
        dependencies: Array.from(collectedDeps),
        robots: (isPasswordProtected || isRestrictedNode || isTplPreview) ? 'noindex, nofollow' : seoMetadata.robots,
        noCache: isPasswordProtected || isRestrictedNode || isTplPreview,
        translationGroupId: transGroupId || undefined
    };
}
