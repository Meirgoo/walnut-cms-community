import type { D1Database } from '@cloudflare/workers-types';
import type { Site, AuthenticatedUser, ThemeComponentManifest } from '../types';
import { SeoPlugin } from '../services';
import { ENGINE_CORE_VERSION } from '../kernel';
import { renderTemplate, fetchAsset } from './template';
import { renderFallbackErrorHtml, resolveSiteBrandInfo } from '../core/dal';
import { buildAbsoluteUrl, resolveEffectiveDomain } from '../core/url';
import { sanitizeRedirectTarget, sanitizeHexColor } from '../core/utils';
import { getInlineI18nScript } from '../core/i18n';
import {
    findPublishedNodeBySlug,
    findLatestActiveVersion,
    findPublishedThemeBundle,
    getPeerTranslationLinks,
    findNodeById,
    findSiteRouteByPath,
    fetchLatestNodesForVisitor,
    findPublishedDatasetsBySchema,
    getNodeBacklinks
} from '../core/dal';
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
    type BuiltinRenderContext
} from './field-mapping';

const seoPlugin = new SeoPlugin();

const DEFAULT_LAYOUT_SKELETON = `{{walnut_head}}\n{{slot:header:1}}\n{{slot:subnav:2}}\n{{slot:main}}\n{{slot:sidebar:3}}\n{{slot:footer:1}}\n{{walnut_foot}}`;

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

function isPageContentPlaceholder(block: any): boolean {
    if (!block || typeof block !== 'object') return false;
    const comp = String(block.component || block.componentSlug || block.componentType || block.type || block.id || '').trim();
    return comp === '@slot:page_content' || comp === 'slot:page_content';
}

// Precomputed once per page to avoid repeated Markdown parsing and N+1 DB queries inside block loops.
interface PrecomputedArticleData {
    renderedArticleHtml: string;
    rawArticleMarkdown: string;
    translations: Array<{ locale: string; url: string; isCurrent: boolean }>;
    translationsJson: string;
    themeLocaleDict?: Record<string, any>;
}

// Prefix relative theme asset keys with /theme/{slug} while preserving absolute, data/blob, anchor, and template values.
const ASSET_KEY_RE = /(logo|image|img|src|avatar|cover|banner|favicon|poster)/i;
const NON_RELATIVE_RE = /^(\/|[a-z][a-z0-9+.-]*:|#|\{\{)/i;

export function resolveThemeAssetUrl(value: string, base: string): string {
    const v = value.trim();
    if (!v || !base || NON_RELATIVE_RE.test(v)) return value;
    return `${base.replace(/\/+$/, '')}/${v.replace(/^\.?\/+/, '')}`;
}

function resolveThemeAssetProps(props: Record<string, any>, base: string): void {
    for (const [key, val] of Object.entries(props)) {
        if (typeof val === 'string' && ASSET_KEY_RE.test(key)) {
            props[key] = resolveThemeAssetUrl(val, base);
        } else if (Array.isArray(val)) {
            for (const item of val) {
                if (item && typeof item === 'object') resolveThemeAssetProps(item, base);
            }
        }
    }
}

function findComponentInMap(compSlug: string, map: Map<string, ThemeComponentManifest>): ThemeComponentManifest | undefined {
    if (!compSlug) return undefined;

    const exact = map.get(compSlug);
    if (exact) return exact;

    const lower = compSlug.toLowerCase();
    const lowerMatch = map.get(lower);
    if (lowerMatch) return lowerMatch;

    const clean = lower.replace(/[-_]/g, '');
    const cleanMatch = map.get(clean);
    if (cleanMatch) return cleanMatch;

    const stripped = lower.replace(/^[a-z0-9]+[-_]/, '');
    if (stripped) {
        return map.get(stripped) || map.get(stripped.replace(/[-_]/g, ''));
    }

    return undefined;
}

function injectBlockIdToHtml(html: string, blockId: string): string {
    if (!html || !blockId) return html;
    if (html.includes('data-block-id=')) return html;

    const trimmed = html.trim();
    const tagMatch = trimmed.match(/^((?:<!--[\s\S]*?-->\s*)*<[a-zA-Z0-9-]+)([\s>])/i);
    if (tagMatch) {
        return trimmed.replace(
            /^((?:<!--[\s\S]*?-->\s*)*<[a-zA-Z0-9-]+)([\s>])/i,
            `$1 data-block-id="${blockId}"$2`
        );
    }
    return `<div data-block-id="${blockId}">${trimmed}</div>`;
}

function collectApiDep(raw: string, deps?: Set<string>): void {
    if (!deps || !raw) return;
    const m = raw.trim().match(/^@api:(dataset|datasets|micro|micros|article|articles|feed|feeds|media|medias)(?::([^\s]*))?/i);
    if (!m) return;
    const kind = m[1].toLowerCase();
    const rest = (m[2] || '').trim();
    if (kind.startsWith('feed')) {
        deps.add('feed:*');
        const params = new URLSearchParams(rest.includes('=') ? rest.replace(/^\?/, '') : '');
        const rawTypes = (params.get('types') || '').trim();
        const extraDs = [params.get('dataset'), params.get('datasets')].filter(Boolean).join(',');
        const tokens = rawTypes
            ? rawTypes.split(',').map(s => s.trim()).filter(Boolean)
            : (extraDs ? [] : ['article', 'micro']);
        for (const t of tokens) {
            const lower = t.toLowerCase();
            if (lower === 'article' || lower === 'articles') deps.add('article:*');
            else if (lower === 'micro' || lower === 'micros') deps.add('micro:*');
            else if (lower.startsWith('dataset:')) {
                const dsSlug = t.slice('dataset:'.length).trim();
                deps.add(dsSlug ? `dataset:${dsSlug}` : 'dataset:*');
            } else if (lower === 'dataset' || lower === 'datasets') {
                deps.add('dataset:*');
            }
        }
        for (const ds of extraDs.split(',').map(s => s.trim()).filter(Boolean)) {
            deps.add(`dataset:${ds}`);
        }
        return;
    }
    if (kind.startsWith('dataset')) {
        if (rest.includes('=')) {
            const params = new URLSearchParams(rest.replace(/^\?/, ''));
            const schema = (params.get('schema') || params.get('schema_slug') || '').trim();
            deps.add(schema ? `dataset:${schema}` : 'dataset:*');
        } else {
            const slugPart = rest.split('?')[0].trim();
            deps.add(slugPart ? `dataset:${slugPart}` : 'dataset:*');
        }
    } else if (kind.startsWith('micro')) {
        deps.add('micro:*');
    } else if (kind.startsWith('media')) {
        deps.add('media:*');
    } else if (kind.startsWith('article')) {
        deps.add('article:*');
    }
}

async function renderBlockItem(
    block: any,
    blockId: string,
    componentMap: Map<string, ThemeComponentManifest>,
    db: D1Database,
    siteId: string,
    cleanSlug: string,
    precomputed: PrecomputedArticleData,
    builtinContext: BuiltinRenderContext,
    collectedDeps?: Set<string>
): Promise<{ html: string; hasCustomJs: boolean }> {
    if (!block || typeof block !== 'object') return { html: '', hasCustomJs: false };
    const compSlug = block.component || block.componentSlug || block.componentType || block.type || '';
    if (!compSlug) return { html: '', hasCustomJs: false };

    const compMeta = findComponentInMap(compSlug, componentMap);
    const tplHtml = compMeta?.template_html || compMeta?.templateHtml || '';
    if (!compMeta || !tplHtml) {
        return { html: '', hasCustomJs: false };
    }

    const rawProps = (block.props && typeof block.props === 'object')
        ? block.props
        : (block.data && typeof block.data === 'object' ? block.data : {});

    // Preserve explicit empty strings ("") from user props; only apply defaults when undefined.
    const defaultProps: Record<string, any> = {};
    if (Array.isArray(compMeta.ui_schema)) {
        for (const field of compMeta.ui_schema) {
            if (field && field.key && field.default !== undefined) {
                defaultProps[field.key] = field.default;
            }
        }
    }
    if (compMeta.default_props && typeof compMeta.default_props === 'object') {
        Object.assign(defaultProps, compMeta.default_props);
    }

    const mergedProps: Record<string, any> = { ...defaultProps };
    for (const [k, v] of Object.entries(rawProps)) {
        if (v !== undefined) {
            mergedProps[k] = v;
        }
    }

    for (const [propKey, propVal] of Object.entries(mergedProps)) {
        if (typeof propVal === 'string' && propVal.trim().startsWith('@api:')) {
            if (['title', 'subtitle', 'gallery_subtitle', 'feed_subtitle', 'section_subtitle', 'heading', 'text', 'label', 'description', 'summary'].includes(propKey)) {
                continue;
            }
            try {
                collectApiDep(propVal, collectedDeps);
                const resolvedList = await resolveApiProtocolValue(propVal, db, siteId, builtinContext?.page?.locale);
                if (resolvedList !== null) {
                    mergedProps[propKey] = resolvedList;
                    if (!Array.isArray(mergedProps.items)) {
                        mergedProps.items = resolvedList;
                    }
                }
            } catch (e) {
                console.warn(`[DynamicRenderer] @api protocol resolve failed (${propVal}):`, e);
                mergedProps[propKey] = [];
            }
        }
    }

    let pipelineData: any = null;
    const ds = block.dataSource || block.data_source
        || (block.pipeline ? (typeof block.pipeline === 'string' ? { pipelineName: block.pipeline } : { pipelineName: block.pipeline.name || block.pipeline.pipeline, params: block.pipeline.params }) : null)
        || (compMeta as any).dataSource || (compMeta as any).data_source
        || ((compMeta as any).pipeline ? (typeof (compMeta as any).pipeline === 'string' ? { pipelineName: (compMeta as any).pipeline } : { pipelineName: (compMeta as any).pipeline.name || (compMeta as any).pipeline.pipeline, params: (compMeta as any).pipeline.params }) : null);

    const pipelineName = typeof ds === 'string' ? ds : (ds?.pipelineName || ds?.name || ds?.pipeline);
    if (typeof pipelineName === 'string' && pipelineName.trim().startsWith('@api:')) {
        try {
            collectApiDep(pipelineName, collectedDeps);
            pipelineData = await resolveApiProtocolValue(pipelineName, db, siteId, builtinContext?.page?.locale);
        } catch (e) {
            console.warn(`[DynamicRenderer] @api dataSource error (${pipelineName}):`, e);
        }
    } else if (pipelineName === 'fetch_latest_nodes') {
        if (collectedDeps) {
            collectedDeps.add('article:*');
            collectedDeps.add('micro:*');
        }
        const limit = ds?.params?.limit || 10;
        pipelineData = await fetchLatestNodesForVisitor(db, siteId, limit);
    } else if (pipelineName === 'fetch_datasets') {
        const schemaSlug = ds?.params?.schema_slug || ds?.params?.schema || 'showcase';
        if (collectedDeps) collectedDeps.add(`dataset:${schemaSlug}`);
        const limit = ds?.params?.limit || 12;
        const results = await findPublishedDatasetsBySchema(db, siteId, schemaSlug, limit);
        pipelineData = (results || []).map((r: any) => {
            let metaObj: any = {};
            try { metaObj = typeof r.metadata === 'string' ? JSON.parse(r.metadata) : (r.metadata || {}); } catch {}
            return {
                ...metaObj,
                id: r.id,
                slug: r.slug,
                title: r.title,
                summary: r.summary || metaObj.summary || ''
            };
        });
    } else if (pipelineName === 'fetch_backlinks') {
        pipelineData = await getNodeBacklinks(db, siteId, cleanSlug);
    }

    if (Array.isArray(pipelineData)) {
        if (!Array.isArray(rawProps.items) || rawProps.items.length === 0) {
            mergedProps.items = pipelineData;
        }
        if (pipelineName === 'fetch_backlinks' && (!Array.isArray(rawProps.backlinks) || rawProps.backlinks.length === 0)) {
            mergedProps.backlinks = pipelineData;
        }
    }

    const themeAssetsBase = builtinContext?.site?.assetsBase || '';
    resolveThemeAssetProps(mergedProps, themeAssetsBase);

    const baseExtra: Record<string, any> = {
        translations: precomputed.translations,
        translations_json: precomputed.translationsJson,
        i18n: precomputed.themeLocaleDict || {},
        _i18n: precomputed.themeLocaleDict || {}
    };

    const allowCustomJs = compMeta.allow_custom_js === true;
    delete mergedProps.custom_js;
    let mountScriptTag = '';
    if (allowCustomJs && typeof rawProps.custom_js === 'string' && rawProps.custom_js.trim()) {
        // Strip optional wrapper <script> tags so editors accept either bare JS or tagged snippets cleanly.
        const jsBody = rawProps.custom_js.trim()
            .replace(/^<script\b[^>]*>/i, '')
            .replace(/<\/script\s*>$/i, '')
            .trim()
            .replace(/<\/script>/gi, '<\\/script>');
        if (jsBody) {
            mountScriptTag = `<script>window.__walnutMount(document.currentScript,function(root,$,$$,onCleanup){${jsBody}\n})</script>`;
        }
    }

    // Order mergedProps after baseExtra so explicit "" overrides globals, while protecting reserved content/i18n/powered_by data.
    const blockScope = buildTemplateScope(builtinContext, {
        ...baseExtra,
        ...mergedProps,
        custom_js: '',
        powered_by: builtinContext.site.powered_by,
        translations: precomputed.translations,
        translations_json: precomputed.translationsJson,
        ...(precomputed.renderedArticleHtml ? {
            content: precomputed.renderedArticleHtml,
            content_html: precomputed.renderedArticleHtml,
            content_raw: precomputed.rawArticleMarkdown
        } : {})
    });

    const blockHtml = renderTemplate(tplHtml, blockScope, true);
    let finalBlockHtml = injectBlockIdToHtml(blockHtml.trim(), blockId);
    if (mountScriptTag) {
        // Use a replacer function because user JS contains "$" and "$$" which String.replace treats as special patterns.
        finalBlockHtml = /<\/[a-zA-Z0-9-]+\s*>$/.test(finalBlockHtml)
            ? finalBlockHtml.replace(/(<\/[a-zA-Z0-9-]+\s*>)$/, (_m, closeTag) => `${mountScriptTag}${closeTag}`)
            : `${finalBlockHtml}${mountScriptTag}`;
    }
    return {
        html: finalBlockHtml,
        hasCustomJs: mountScriptTag.length > 0
    };
}

// Require every element to carry a valid component identifier so plain prose JSON is never treated as blocks.
export function extractBlocksFromNode(node: any, version?: any): any[] {
    if (!node) return [];

    const isValidBlockArray = (arr: any): arr is any[] => {
        return Array.isArray(arr) && arr.length > 0 && arr.every(
            item => item && typeof item === 'object' && (item.component || item.componentSlug || item.componentType || item.type || item.id === '@slot:page_content')
        );
    };

    const candidates = [
        version?.content_raw,
        node.content_raw
    ];

    for (const raw of candidates) {
        if (typeof raw === 'string' && raw.trim().startsWith('[')) {
            try {
                const parsed = JSON.parse(raw.trim());
                if (isValidBlockArray(parsed)) return parsed;
                if (parsed && isValidBlockArray(parsed.blocks)) return parsed.blocks;
            } catch {}
        }
    }

    try {
        const meta = typeof node.metadata === 'string' ? JSON.parse(node.metadata) : (node.metadata || {});
        if (isValidBlockArray(meta.blocks)) return meta.blocks;
        if (meta.content && isValidBlockArray(meta.content.blocks)) return meta.content.blocks;
    } catch {}

    if (isValidBlockArray(node.blocks)) return node.blocks;

    return [];
}

export async function renderDynamicVisitorPage(
    db: D1Database,
    site: Site,
    rawPath: string,
    host: string,
    locale: string,
    user?: AuthenticatedUser,
    isPreview = false
): Promise<{ html: string; status: number; redirectUrl?: string; entityId?: string; entityType?: string; title?: string; dependencies?: string[] }> {
    const collectedDeps = new Set<string>();
    if (site.is_media_bed_only === 1 && (rawPath === '/' || rawPath === '')) {
        return {
            html: `<div data-walnut-media-bed><h1>${escapeHtmlAttr(site.name)}</h1>${user ? `<p><a href="/admin/media">&rarr; Media</a></p>` : ''}</div>`,
            status: 200
        };
    }

    const isHomePage = rawPath === '/' || rawPath === '';
    const cleanSlug = rawPath.replace(/^\/+|\/+$/g, '').replace(/^(article|page)\//, '');
    const routePath = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;

    let matchedNode: any = null;
    let matchedVersion: any = null;

    try {
        const routeRow = await findSiteRouteByPath(db, site.id, routePath);

        if (routeRow && routeRow.entity_id && routeRow.entity_id !== 'home') {
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
            matchedNode = await findPublishedNodeBySlug(db, site.id, cleanSlug);
            if (isTemplateNode(matchedNode) && !isPreview) matchedNode = null;
        } else {
            const rootPage = await findPublishedNodeBySlug(db, site.id, '/');
            if (rootPage && (!isTemplateNode(rootPage) || isPreview)) matchedNode = rootPage;
        }
    }
    if (matchedNode && !matchedVersion) {
        matchedVersion = await findLatestActiveVersion(db, matchedNode.id);
    }

    if (matchedNode && matchedNode.type === 'page') {
        const pageMeta = parseMeta(matchedNode.metadata);
        if (pageMeta.page_type === 'redirect') {
            const targetRedirectUrl = sanitizeRedirectTarget(pageMeta.redirect_url);
            const redirectCode = parseInt(pageMeta.redirect_code) || 301;
            return {
                html: '',
                status: redirectCode,
                redirectUrl: targetRedirectUrl,
                entityId: matchedNode.id,
                entityType: 'redirect',
                title: matchedNode.title
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
                    if (res.html) return { html: res.html, status: 404 };
                }
            } catch {}
        }
        return { html: renderFallbackErrorHtml(errCode as any, site.name, locale), status: errCode };
    }

    const { themeNode, templates: themeTemplates, components: componentNodeList } = await findPublishedThemeBundle(db, site.id);

    const themeMeta = parseMeta(themeNode?.metadata);

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
        if (name) {
            componentMap.set(name, merged);
        }
    }

    let targetTemplateNode: any = null;
    let templateBlocks: any[] = [];
    let ownBlocks: any[] = [];

    const findTemplateByIdOrSlug = async (id: string): Promise<any | null> =>
        !id ? null : (await findNodeById(db, id) || await findPublishedNodeBySlug(db, site.id, id) || themeTemplates.find(t => t.id === id || t.slug === id));

    if (matchedNode) {
        const nodeMeta = parseMeta(matchedNode.metadata);

        ownBlocks = extractBlocksFromNode(matchedNode, matchedVersion);
        const tplId = nodeMeta.template_page_id || nodeMeta.template_id || nodeMeta.template_slug || '';

        if (tplId) {
            targetTemplateNode = await findTemplateByIdOrSlug(tplId);
        }
        if (!targetTemplateNode && matchedNode.type === 'article') {
            targetTemplateNode = themeTemplates.find(t => t.slug?.includes('article')) || null;
        }
        if (!targetTemplateNode && site.settings?.default_template_page_id) {
            targetTemplateNode = await findTemplateByIdOrSlug(site.settings.default_template_page_id);
        }

        if (targetTemplateNode && targetTemplateNode.id === matchedNode.id) {
            targetTemplateNode = null;
        }

        if (targetTemplateNode) {
            const tplVer = targetTemplateNode.id ? await findLatestActiveVersion(db, targetTemplateNode.id) : null;
            templateBlocks = extractBlocksFromNode(targetTemplateNode, tplVer);
        }
    }

    const nodeType = matchedNode?.type || 'page';
    const isArticleLike = nodeType === 'article' || nodeType === 'micro';
    const rawArticleMarkdown = isArticleLike ? (matchedVersion?.content_raw || '') : '';
    const renderedArticleHtml = isArticleLike
        ? processThemeMarkdownComponents(rawArticleMarkdown, { ...(themeMeta || {}), ...(site.settings || {}) })
        : '';

    let peerTranslationList: Array<{ locale: string; url: string; isCurrent: boolean }> = [];
    let translationsJson = '[]';
    let hreflangLinks: Array<{ locale: string; url: string }> = [];

    const matchedNodeMeta = parseMeta(matchedNode?.metadata);
    const transGroupId = matchedNode?.translation_group_id || matchedNodeMeta.translation_group_id;
    if (transGroupId) {
        const effectiveHost = resolveEffectiveDomain(site.primary_domain, host);
        const peerLinks = await getPeerTranslationLinks(db, site.id, matchedNode.id, effectiveHost);
        if (peerLinks.length > 1) {
            peerTranslationList = peerLinks.map((p: { url: string; isCurrent: boolean; locale: string }) => ({
                locale: escapeHtmlAttr(p.locale),
                url: sanitizeUrlAttr(p.url),
                isCurrent: Boolean(p.isCurrent)
            }));
            translationsJson = JSON.stringify(peerLinks);
            hreflangLinks = peerLinks.map((p: { locale: string; url: string }) => ({
                locale: p.locale,
                url: buildAbsoluteUrl(p.url, effectiveHost)
            }));
        }
    }

    const targetNodeData = matchedNode ? { node: matchedNode, version: matchedVersion || undefined } : null;
    const themeSlug = themeNode?.slug || (site as any).theme_id || 'univers';
    const builtinSite = resolveBuiltinSiteFields(site, host, themeSlug);
    const builtinPage = resolveBuiltinPageFields(targetNodeData, routePath, host, locale, site, renderedArticleHtml);
    const builtinContext: BuiltinRenderContext = { site: builtinSite, page: builtinPage };

    const themeLocalesObj = (themeMeta?.locales && typeof themeMeta.locales === 'object') ? themeMeta.locales : {};
    const themeLocaleDict = themeLocalesObj[builtinPage.locale] || themeLocalesObj[locale] || themeLocalesObj['zh-CN'] || {};

    const precomputedArticleData: PrecomputedArticleData = {
        renderedArticleHtml,
        rawArticleMarkdown,
        translations: peerTranslationList,
        translationsJson,
        themeLocaleDict
    };

    let layoutHtml: string = themeMeta.layout_html || DEFAULT_LAYOUT_SKELETON;

    if (!themeMeta.layout_html && themeMeta.layout_file) {
        const fileContent = await fetchAsset(`/theme/${themeSlug}/${themeMeta.layout_file.replace(/^\/+/, '')}`);
        if (fileContent) layoutHtml = fileContent;
    }

    const slotQuotas = new Map<string, number>([
        ['header', 1],
        ['footer', 1],
        ['sidebar', 3],
        ['main', Infinity]
    ]);

    const slotTagRegex = /\{\{slot:([a-zA-Z0-9_-]+)(?::(\d+))?\}\}/g;
    let slotMatch: RegExpExecArray | null;
    while ((slotMatch = slotTagRegex.exec(layoutHtml)) !== null) {
        const sName = slotMatch[1];
        const sMax = slotMatch[2] !== undefined ? Math.max(0, parseInt(slotMatch[2], 10)) : Infinity;
        slotQuotas.set(sName, sMax);
    }

    const resolveBlockSlot = (blk: any): string => {
        if (isPageContentPlaceholder(blk)) return 'main';
        if (blk?.target_slot && typeof blk.target_slot === 'string') return blk.target_slot;
        if (blk?.slot && typeof blk.slot === 'string') return blk.slot;
        const cSlug = String(blk?.component || blk?.componentSlug || blk?.componentType || blk?.type || '');
        const cMeta = findComponentInMap(cSlug, componentMap);
        if (cMeta && Array.isArray(cMeta.slots) && cMeta.slots.length > 0) {
            return cMeta.slots[0];
        }
        return 'main';
    };

    const tplBySlot = new Map<string, any[]>();
    for (const b of templateBlocks) {
        const s = resolveBlockSlot(b);
        if (!tplBySlot.has(s)) tplBySlot.set(s, []);
        tplBySlot.get(s)!.push(b);
    }

    const ownBySlot = new Map<string, any[]>();
    for (const b of ownBlocks) {
        if (isPageContentPlaceholder(b)) continue;
        const s = resolveBlockSlot(b);
        if (!ownBySlot.has(s)) ownBySlot.set(s, []);
        ownBySlot.get(s)!.push(b);
    }

    const allSlotNames = new Set<string>([
        ...slotQuotas.keys(),
        ...tplBySlot.keys(),
        ...ownBySlot.keys()
    ]);

    const renderedSlots = new Map<string, string>();
    const blocksMeta: Array<{ id: string; component: string; slot: string; props: Record<string, any> }> = [];
    let totalRenderedBlocks = 0;
    let hasScopedBlockJs = false;
    let globalIdx = 0;

    for (const slotName of allSlotNames) {
        const maxQuota = slotQuotas.get(slotName) ?? Infinity;
        const tplList = tplBySlot.get(slotName) || [];
        const ownList = ownBySlot.get(slotName) || [];

        let mergedQueue: any[];
        if (slotName === 'main') {
            if (targetTemplateNode && templateBlocks.length > 0) {
                const hasPageContentSlot = tplList.some(b => isPageContentPlaceholder(b));
                if (hasPageContentSlot) {
                    mergedQueue = tplList.flatMap(b => isPageContentPlaceholder(b) ? ownList : [b]).slice(0, maxQuota);
                } else {
                    // Omitting @slot:page_content locks the main slot to template blocks only.
                    mergedQueue = tplList.slice(0, maxQuota);
                }
            } else {
                mergedQueue = ownList.slice(0, maxQuota);
            }
        } else {
            // Enqueue template blocks before page blocks in fixed-quota slots so template elements are never evicted by page blocks.
            mergedQueue = [...tplList, ...ownList].slice(0, maxQuota);
        }

        const slotHtmlParts: string[] = [];
        for (const block of mergedQueue) {
            if (isPageContentPlaceholder(block)) continue;
            const compSlug = String(block.component || block.componentSlug || block.componentType || block.type || '').toLowerCase();
            const blockId = String(block.id || `blk_${globalIdx++}_${compSlug.replace(/[^a-zA-Z0-9_-]/g, '_')}`);

            const { html: renderedHtml, hasCustomJs } = await renderBlockItem(block, blockId, componentMap, db, site.id, cleanSlug, precomputedArticleData, builtinContext, collectedDeps);
            if (!renderedHtml) continue;
            if (hasCustomJs) hasScopedBlockJs = true;

            const rawBlockProps = (block.props && typeof block.props === 'object')
                ? block.props
                : (block.data && typeof block.data === 'object' ? block.data : {});
            const { custom_js: _omitCustomJs, powered_by: _omitPb, translations: _omitTr, translations_json: _omitTrJson, ...publicBlockProps } = rawBlockProps;
            blocksMeta.push({
                id: blockId,
                component: compSlug,
                slot: slotName,
                props: publicBlockProps
            });
            slotHtmlParts.push(renderedHtml);
            totalRenderedBlocks++;
        }

        renderedSlots.set(slotName, slotHtmlParts.join('\n'));
    }

    if (totalRenderedBlocks === 0) {
        if (isArticleLike && renderedArticleHtml) {
            renderedSlots.set('main', `<div data-walnut-fallback><h1>${escapeHtmlAttr(builtinPage.title)}</h1><div>${renderedArticleHtml}</div></div>`);
        } else {
            renderedSlots.set('main', `<div data-walnut-fallback><h1>${escapeHtmlAttr(builtinPage.title)}</h1>${builtinPage.summary ? `<p>${escapeHtmlAttr(builtinPage.summary)}</p>` : ''}</div>`);
        }
    }

    layoutHtml = layoutHtml.replace(/\{\{slot:([a-zA-Z0-9_-]+)(?::\d+)?\}\}/g, (_m, sName) => {
        return renderedSlots.get(sName) || '';
    });

    const isArticleNode = matchedNode?.type === 'article' || matchedNode?.type === 'micro';
    const effectiveHost = resolveEffectiveDomain(site.primary_domain, host);
    const seoMetadata = seoPlugin.assembleSeoMetadata(site, targetNodeData?.node, {
        currentUrl: buildAbsoluteUrl(routePath, effectiveHost),
        rawContent: isArticleNode ? (targetNodeData?.version?.content_raw || '') : undefined,
        pageNode: targetTemplateNode || undefined
    });
    const seoHeaders = seoPlugin.serializeSeoHeaders(site, seoMetadata, hreflangLinks);

    const themeRoot = `/theme/${themeSlug}`;
    const toThemeUrl = (p: string) => resolveThemeAssetUrl(p, themeRoot);
    const assetVer = encodeURIComponent(String(themeMeta.version || ENGINE_CORE_VERSION));
    const withAssetVer = (u: string) => (u.includes('?') ? `${u}&v=${assetVer}` : `${u}?v=${assetVer}`);
    const styleSet = new Set<string>([...(themeMeta.global_assets?.styles || []), themeMeta.assets?.css].filter(Boolean).map(toThemeUrl));
    const scriptSet = new Set<string>([...(themeMeta.global_assets?.scripts || []), themeMeta.assets?.js].filter(Boolean).map(toThemeUrl));

    // Emit <link rel="stylesheet"> so browsers cache declared theme CSS across navigations instead of re-downloading inline blobs.
    const styleTags = Array.from(styleSet).map(href => `<link rel="stylesheet" href="${withAssetVer(href)}" />`).join('\n    ');
    const scriptTags = Array.from(scriptSet).map(src => `<script src="${withAssetVer(src)}" defer></script>`).join('\n    ');
    const customCss = themeMeta.custom_css ? `<style>${String(themeMeta.custom_css).replace(/<\/style>/gi, '<\\/style>')}</style>` : '';
    const customJs = themeMeta.custom_js ? `<script>${String(themeMeta.custom_js).replace(/<\/script>/gi, '<\\/script>')}</script>` : '';

    // Highlight unresolved placeholders only during template preview; strip them on live visitor pages.
    const isTplPreview = isPreview && isTemplateNode(matchedNode);
    layoutHtml = layoutHtml.replace(/\{\{([a-zA-Z0-9_.-]+)\}\}/g, (m, key) => {
        if (key === 'walnut_head' || key === 'walnut_foot') return m;
        return isTplPreview
            ? `<code data-walnut-unresolved>{{${key}}}</code>`
            : '';
    });

    const blocksMap: Record<string, any> = {};
    for (const b of blocksMeta) {
        blocksMap[b.id] = b;
    }

    const rawColorSchemes = Array.isArray(themeMeta.color_schemes)
        ? themeMeta.color_schemes.filter((s: unknown): s is 'light' | 'dark' => s === 'light' || s === 'dark')
        : [];
    const colorSchemes = Array.from(new Set(rawColorSchemes.length > 0 ? rawColorSchemes : ['light', 'dark']));

    const siteSettingsObj = parseMeta(site.settings);
    const lightPrimary = sanitizeHexColor(siteSettingsObj.primary_color ?? siteSettingsObj.appearance?.primary_color);
    const darkPrimaryRaw = sanitizeHexColor(siteSettingsObj.primary_color_dark ?? siteSettingsObj.appearance?.primary_color_dark);
    const siteVarsStyleTag = lightPrimary
        ? `<style id="walnut-site-vars">:root{--walnut-primary:${lightPrimary};}html.dark{--walnut-primary:${darkPrimaryRaw || lightPrimary};}</style>`
        : (darkPrimaryRaw ? `<style id="walnut-site-vars">html.dark{--walnut-primary:${darkPrimaryRaw};}</style>` : '');

    const frontendContextScript = `<script>window.__WALNUT__ = ${safeJsonStringify({
        site: { id: site.id, name: site.name, locale },
        route: { path: routePath, type: matchedNode?.type || 'page', targetId: matchedNode?.id || null },
        color_schemes: colorSchemes,
        powered_by: builtinSite.powered_by,
        blocks: blocksMeta,
        blocksMap
    })};</script>`;

    const inlineI18nTag = 'WALNUT_INLINE_I18N_PLACEHOLDER';

    // Inject synchronously in <head> only when at least one active block renders custom_js, avoiding defer timing races and adding 0 bytes to static pages.
    const walnutMountScript = hasScopedBlockJs
        ? `\n    <script>(function(){if(window.__walnutMount)return;var c=new WeakMap();function clean(el){if(!el)return;var s=c.get(el);if(s){s.forEach(function(fn){try{fn();}catch(e){}});c.delete(el);}if(el.querySelectorAll){el.querySelectorAll('[data-block-id],[data-walnut-comp]').forEach(function(n){var cs=c.get(n);if(cs){cs.forEach(function(fn){try{fn();}catch(e){}});c.delete(n);}});}}document.addEventListener('htmx:beforeCleanupElement',function(e){clean(e&&e.detail?e.detail.elt:null);});window.__walnutMount=function(scriptEl,fn){if(typeof fn!=='function')return;var el=scriptEl||document.currentScript;var root=el&&el.closest?(el.closest('[data-block-id],[data-walnut-comp]')||el.parentElement):null;if(!root)return;var $=function(q){return root.querySelector(q);};var $$=function(q){return Array.from(root.querySelectorAll(q));};var onCleanup=function(cb){if(typeof cb!=='function')return;var s=c.get(root);if(!s){s=new Set();c.set(root,s);}s.add(cb);};try{fn(root,$,$$,onCleanup);}catch(err){console.error('[walnutMount]',err);}};})();</script>`
        : '';

    const siteVarsLine = siteVarsStyleTag ? `\n    ${siteVarsStyleTag}` : '';
    const walnutHeadHtml = `<meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    ${seoHeaders}${siteVarsLine}
    ${styleTags}
    <script src="/shared/htmx.min.js?v=${assetVer}" defer></script>
    ${inlineI18nTag}
    ${frontendContextScript}${walnutMountScript}
    <script src="/shared/theme-init.js?v=${assetVer}"></script>
    ${customCss}`;

    const walnutFootHtml = `<script src="/shared/visitor.js?v=${assetVer}" defer></script>
    <script>(function(){try{if(localStorage.getItem('walnut_admin_hint')!=='1')return;}catch(e){return;}function load(){var s=document.createElement('script');s.src='/shared/quick-actions.js?v=${assetVer}';s.async=true;document.body.appendChild(s);}if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',load);}else{load();}})();</script>
    ${scriptTags}
    ${customJs}`;

    if (layoutHtml.includes('{{walnut_head}}')) {
        layoutHtml = layoutHtml.replace('{{walnut_head}}', () => walnutHeadHtml);
    } else if (/<head[^>]*>([\s\S]*?)<\/head>/i.test(layoutHtml)) {
        layoutHtml = layoutHtml.replace(/<head([^>]*)>([\s\S]*?)<\/head>/i, (full, attrs, inner) => {
            if (/<\s*(title|meta)\b/i.test(inner)) {
                const dedupedSeo = /<\s*title\b/i.test(inner) ? seoHeaders.replace(/<title>[\s\S]*?<\/title>\s*/i, '') : seoHeaders;
                return `<head${attrs}>${inner}\n${dedupedSeo}${siteVarsStyleTag ? `\n${siteVarsStyleTag}` : ''}\n${styleTags}\n<script src="/shared/htmx.min.js?v=${assetVer}" defer></script>\n${inlineI18nTag}\n${frontendContextScript}${walnutMountScript}\n<script src="/shared/theme-init.js?v=${assetVer}"></script>\n${customCss}</head>`;
            }
            return `<head${attrs}>${inner}\n${walnutHeadHtml}</head>`;
        });
    }

    if (layoutHtml.includes('{{walnut_foot}}')) {
        layoutHtml = layoutHtml.replace('{{walnut_foot}}', () => walnutFootHtml);
    } else if (/<\/body>/i.test(layoutHtml)) {
        layoutHtml = layoutHtml.replace(/<\/body>/i, () => `${walnutFootHtml}\n</body>`);
    }

    let fullHtml = renderTemplate(layoutHtml, buildTemplateScope(builtinContext), true).trim();
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
        const hasRenderedLink = new RegExp(`href=["']${escapedPbUrl}\\/?["']`, 'i').test(htmlNoScripts);
        if (!hasRenderedLink) {
            const fallbackAttr = `<div data-walnut-powered-by style="text-align:center;padding:12px 16px;font-size:12px;opacity:.75"><a href="${builtinSite.powered_by.url}" target="_blank" rel="noopener noreferrer">${builtinSite.powered_by.label}</a></div>`;
            fullHtml = /<\/body>/i.test(fullHtml)
                ? fullHtml.replace(/<\/body>/i, (m) => `${fallbackAttr}\n${m}`)
                : `${fullHtml}\n${fallbackAttr}`;
        }
    }

    const finalStatus = cleanSlug === '404' ? 404 : (cleanSlug === '500' ? 500 : (cleanSlug === '503' || cleanSlug === 'maintenance' ? 503 : 200));

    return {
        html: fullHtml,
        status: finalStatus,
        entityId: matchedNode.id,
        entityType: matchedNode.type || 'page',
        title: matchedNode.title,
        dependencies: Array.from(collectedDeps)
    };
}
