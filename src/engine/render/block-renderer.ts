import type { D1Database } from '@cloudflare/workers-types';
import type { ThemeComponentManifest } from '../types';
import { renderTemplate } from './template';
import {
    fetchLatestNodesForVisitor,
    findPublishedDatasetsBySchema,
    getNodeBacklinks,
    resolveWikiLinkTargetsMap
} from '../core/dal';
import { resolveApiProtocolValue } from './api-protocol';
import { processThemeMarkdownComponents } from './markdown-parser';
import {
    buildTemplateScope,
    applyBlockFieldMap,
    type BuiltinRenderContext
} from './field-mapping';

// Precomputed once per page to avoid repeated Markdown parsing and N+1 DB queries inside block loops.
export interface PrecomputedArticleData {
    renderedArticleHtml: string;
    rawArticleMarkdown: string;
    translations: Array<{ locale: string; url: string; isCurrent: boolean }>;
    translationsJson: string;
    themeLocaleDict?: Record<string, any>;
    markdownThemeMeta?: Record<string, any>;
    requestLocale?: string;
    siteDefaultLocale?: string;
    publicAssetsDomain?: string;
}

export async function resolveWikiTargetsForMarkdown(
    db: D1Database,
    siteId: string,
    rawMarkdown: string,
    requestLocale?: string,
    siteDefaultLocale?: string
): Promise<Record<string, string> | undefined> {
    if (!rawMarkdown || !rawMarkdown.includes('[[')) return undefined;
    const rawMatches = Array.from(String(rawMarkdown).matchAll(/\[\[([^\[\]\n|]+)(?:\|[^\[\]\n]+)?\]\]/g))
        .map((m) => m[1].trim())
        .filter(t => t && !t.includes(':') && !t.includes('：'));
    if (rawMatches.length === 0) return undefined;
    const defaultLoc = siteDefaultLocale || 'zh-CN';
    const currentLoc = requestLocale || defaultLoc;
    return await resolveWikiLinkTargetsMap(db, siteId, rawMatches, currentLoc, defaultLoc).catch(() => undefined);
}

export function isPageContentPlaceholder(block: any): boolean {
    if (!block || typeof block !== 'object') return false;
    const comp = String(block.component || block.componentSlug || block.componentType || block.type || block.id || '').trim();
    return comp === '@slot:page_content' || comp === 'slot:page_content';
}

export const EXT_ISLAND_SLUG_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;

export function isExtIslandPlaceholder(block: any): boolean {
    if (!block || typeof block !== 'object') return false;
    const comp = String(block.component || block.componentSlug || block.componentType || block.type || '').trim();
    return comp === '@ext:island' || comp === 'ext:island';
}

// Force same-origin /ext/:slug/... paths so @ext:island cannot be turned into an open external fetch or XSS sink.
export function buildSafeExtIslandSrc(slug: string, rawPath: unknown, rawParams?: unknown): string | null {
    if (!EXT_ISLAND_SLUG_RE.test(slug)) return null;
    let p = typeof rawPath === 'string' ? rawPath.trim() : '';
    if (!p) p = '/widget';
    if (p.includes('://') || p.startsWith('//') || p.includes('..') || p.includes('\\') || p.includes('#') || /[<>"'\s\x00-\x1f]/.test(p)) {
        return null;
    }
    if (!p.startsWith('/')) p = '/' + p;
    const qIdx = p.indexOf('?');
    const pathOnly = qIdx >= 0 ? p.slice(0, qIdx) : p;
    const sp = new URLSearchParams(qIdx >= 0 ? p.slice(qIdx + 1) : '');
    if (typeof rawParams === 'string' && rawParams.trim()) {
        const trimmed = rawParams.trim();
        if (trimmed.startsWith('{')) {
            try {
                const obj = JSON.parse(trimmed);
                if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
                    for (const [k, v] of Object.entries(obj)) {
                        if (v !== undefined && v !== null) sp.set(k, String(v));
                    }
                }
            } catch {
                return null;
            }
        } else {
            const extra = new URLSearchParams(trimmed.startsWith('?') ? trimmed.slice(1) : trimmed);
            extra.forEach((v, k) => sp.set(k, v));
        }
    } else if (rawParams && typeof rawParams === 'object' && !Array.isArray(rawParams)) {
        for (const [k, v] of Object.entries(rawParams)) {
            if (v !== undefined && v !== null) sp.set(k, String(v));
        }
    }
    const qs = sp.toString();
    const fullSrc = `/ext/${slug}${pathOnly}${qs ? `?${qs}` : ''}`;
    if (!fullSrc.startsWith(`/ext/${slug}/`) || fullSrc.includes('//') || /[\s"'<>\\]/.test(fullSrc)) {
        return null;
    }
    return fullSrc;
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

export function findComponentInMap(compSlug: string, map: Map<string, ThemeComponentManifest>): ThemeComponentManifest | undefined {
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

export async function renderBlockItem(
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

    let hasDatasetApiBinding = false;
    const rawBlockFieldMap = (block.field_map && typeof block.field_map === 'object' && !Array.isArray(block.field_map))
        ? block.field_map
        : (rawProps.field_map && typeof rawProps.field_map === 'object' && !Array.isArray(rawProps.field_map)
            ? rawProps.field_map
            : (mergedProps.field_map && typeof mergedProps.field_map === 'object' && !Array.isArray(mergedProps.field_map) ? mergedProps.field_map : undefined));

    for (const [propKey, propVal] of Object.entries(mergedProps)) {
        if (typeof propVal === 'string' && propVal.trim().startsWith('@api:')) {
            if (['title', 'subtitle', 'gallery_subtitle', 'feed_subtitle', 'section_subtitle', 'heading', 'text', 'label', 'description', 'summary'].includes(propKey)) {
                continue;
            }
            if (/^@api:(dataset|datasets)(?::|$)/i.test(propVal.trim())) {
                hasDatasetApiBinding = true;
            }
            try {
                collectApiDep(propVal, collectedDeps);
                const resolvedList = await resolveApiProtocolValue(propVal, db, siteId, builtinContext?.page?.locale, precomputed.publicAssetsDomain);
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
        if (/^@api:(dataset|datasets)(?::|$)/i.test(pipelineName.trim())) {
            hasDatasetApiBinding = true;
        }
        try {
            collectApiDep(pipelineName, collectedDeps);
            pipelineData = await resolveApiProtocolValue(pipelineName, db, siteId, builtinContext?.page?.locale, precomputed.publicAssetsDomain);
        } catch (e) {
            console.warn(`[DynamicRenderer] @api dataSource error (${pipelineName}):`, e);
        }
    } else if (pipelineName === 'fetch_latest_nodes') {
        if (collectedDeps) {
            collectedDeps.add('article:*');
            collectedDeps.add('micro:*');
        }
        const limit = ds?.params?.limit || 10;
        const reqLocaleParam = ds?.params?.locale === 'all' ? undefined : (ds?.params?.locale || builtinContext?.page?.locale);
        if (collectedDeps && reqLocaleParam) {
            collectedDeps.add(`article:locale:${reqLocaleParam}`);
        }
        try {
            pipelineData = await fetchLatestNodesForVisitor(db, siteId, limit, reqLocaleParam);
        } catch (e) {
            console.warn('[DynamicRenderer] fetch_latest_nodes error:', e);
            pipelineData = [];
        }
    } else if (pipelineName === 'fetch_datasets') {
        hasDatasetApiBinding = true;
        const schemaSlug = ds?.params?.schema_slug || ds?.params?.schema || 'showcase';
        if (collectedDeps) collectedDeps.add(`dataset:${schemaSlug}`);
        const limit = ds?.params?.limit || 12;
        try {
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
        } catch (e) {
            console.warn('[DynamicRenderer] fetch_datasets error:', e);
            pipelineData = [];
        }
    } else if (pipelineName === 'fetch_backlinks') {
        try {
            pipelineData = await getNodeBacklinks(db, siteId, cleanSlug);
        } catch (e) {
            console.warn('[DynamicRenderer] fetch_backlinks error:', e);
            pipelineData = [];
        }
    }

    if (Array.isArray(pipelineData)) {
        if (!Array.isArray(rawProps.items) || rawProps.items.length === 0) {
            mergedProps.items = pipelineData;
        }
        if (pipelineName === 'fetch_backlinks' && (!Array.isArray(rawProps.backlinks) || rawProps.backlinks.length === 0)) {
            mergedProps.backlinks = pipelineData;
        }
    }

    if (hasDatasetApiBinding && Array.isArray(mergedProps.items) && rawBlockFieldMap) {
        mergedProps.items = applyBlockFieldMap(mergedProps.items, rawBlockFieldMap);
    }

    const themeAssetsBase = builtinContext?.site?.assetsBase || '';
    resolveThemeAssetProps(mergedProps, themeAssetsBase);

    const markdownFieldKeys = new Set<string>();
    const schemaFieldSources = [
        ...(Array.isArray(compMeta.ui_schema) ? compMeta.ui_schema : []),
        ...(Array.isArray((compMeta as any).fields) ? (compMeta as any).fields : []),
        ...(Array.isArray((compMeta as any).schema?.fields) ? (compMeta as any).schema.fields : [])
    ];
    for (const f of schemaFieldSources) {
        if (!f || typeof f !== 'object') continue;
        const fKey = f.key || f.name || f.id;
        if (fKey && (f.type === 'markdown' || f.widget === 'markdown')) {
            markdownFieldKeys.add(String(fKey));
        }
    }
    if (markdownFieldKeys.size > 0) {
        const mdLocale = precomputed.requestLocale || builtinContext?.page?.locale;
        const mdDefaultLocale = precomputed.siteDefaultLocale || builtinContext?.site?.default_locale || 'zh-CN';
        for (const mdKey of markdownFieldKeys) {
            const rawVal = mergedProps[mdKey];
            if (typeof rawVal === 'string' && rawVal.trim()) {
                const wikiMap = await resolveWikiTargetsForMarkdown(db, siteId, rawVal, mdLocale, mdDefaultLocale);
                mergedProps[mdKey] = processThemeMarkdownComponents(rawVal, precomputed.markdownThemeMeta, {
                    currentLocale: mdLocale,
                    defaultLocale: mdDefaultLocale,
                    targetPathMap: wikiMap
                });
            }
        }
    }

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
            mountScriptTag = `<script>window.__edgeMount(document.currentScript,function(root,$,$$,onCleanup){${jsBody}\n})</script>`;
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
        ...(precomputed.renderedArticleHtml && !markdownFieldKeys.has('content') ? {
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
