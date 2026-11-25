import type { D1Database } from '@cloudflare/workers-types';
import { buildLocalizedRoutePath } from '../core/i18n';
import { queryNodesWithFilters, queryDatasetsWithJson1Filter, queryPublicMediaAssets, findSchemasBySite, findSiteById } from '../core/dal';

export interface FeedItem {
    kind: 'article' | 'micro' | 'dataset';
    type_label: string;
    date: string;
    title: string;
    summary: string;
    content_html?: string;
    content_raw?: string;
    url: string;
    badge: string;
    created_at: string;
    id?: string;
    folder?: string;
    progress?: string;
    locale?: string;
    tags?: any;
    visibility?: string;
    cover_image_url?: string;
    author?: string;
    published_at?: string;
    updated_at?: string;
    seo?: {
        title?: string;
        description?: string;
        og_image?: string;
        keywords?: any;
    };
}

function parseTimestampMs(val: unknown): number {
    if (!val) return 0;
    const raw = String(val).trim();
    const iso = raw.includes('T') || raw.endsWith('Z') ? raw : raw.replace(' ', 'T') + 'Z';
    const ts = Date.parse(iso);
    return Number.isNaN(ts) ? (Date.parse(raw) || 0) : ts;
}

function parseFeedSources(params: URLSearchParams): {
    includeArticles: boolean;
    includeMicros: boolean;
    datasetSchemas: Array<string | undefined>;
} {
    const rawTypes = (params.get('types') || '').trim();
    const extraDatasets = [params.get('dataset'), params.get('datasets')]
        .filter(Boolean)
        .join(',')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);

    const tokens = rawTypes
        ? rawTypes.split(',').map(s => s.trim()).filter(Boolean)
        : (extraDatasets.length > 0 ? [] : ['article', 'micro']);

    let includeArticles = false;
    let includeMicros = false;
    const schemaSet = new Set<string>();
    let includeAllDatasets = false;

    for (const token of tokens) {
        const lower = token.toLowerCase();
        if (lower === 'article' || lower === 'articles') {
            includeArticles = true;
        } else if (lower === 'micro' || lower === 'micros') {
            includeMicros = true;
        } else if (lower.startsWith('dataset:')) {
            const schema = token.slice('dataset:'.length).trim();
            if (schema) schemaSet.add(schema);
            else includeAllDatasets = true;
        } else if (lower === 'dataset' || lower === 'datasets') {
            includeAllDatasets = true;
        }
    }

    for (const s of extraDatasets) {
        schemaSet.add(s);
    }

    const datasetSchemas: Array<string | undefined> = includeAllDatasets
        ? [undefined]
        : Array.from(schemaSet);

    return { includeArticles, includeMicros, datasetSchemas };
}

export async function queryAggregatedFeed(
    db: D1Database,
    siteId: string,
    params: URLSearchParams,
    pageLocale?: string,
    excludeApiOnly = false
): Promise<FeedItem[]> {
    const limit = Math.max(1, Math.min(100, Number(params.get('limit')) || 20));
    const page = Math.max(1, Number(params.get('page')) || 1);
    const offset = params.get('offset') !== null
        ? Math.max(0, Number(params.get('offset')) || 0)
        : (page - 1) * limit;
    const perSourceLimit = Math.min(100, offset + limit);

    const folder = params.get('folder') || undefined;
    const tag = params.get('tag') || undefined;
    const rawLocaleParam = params.get('locale');
    const resolvedLocale = rawLocaleParam === 'all'
        ? undefined
        : (rawLocaleParam && rawLocaleParam !== 'auto' ? rawLocaleParam : (pageLocale || undefined));
    const site = await findSiteById(db, siteId).catch(() => null);
    const siteDefaultLocale = site?.default_locale || 'zh-CN';

    const { includeArticles, includeMicros, datasetSchemas } = parseFeedSources(params);
    const tasks: Array<Promise<FeedItem[]>> = [];

    if (includeArticles) {
        tasks.push(
            queryNodesWithFilters(db, {
                siteId,
                folder,
                locale: resolvedLocale,
                tag,
                type: 'article',
                status: 'published',
                excludeApiOnly,
                limit: perSourceLimit,
                offset: 0
            }, false).then((res) => (res.nodes || []).map((r: any) => {
                const meta = (r.metadata && typeof r.metadata === 'object') ? r.metadata : {};
                const sortTime = String(r.published_at || r.created_at || r.updated_at || '');
                const createdAt = String(r.created_at || sortTime);
                const cleanSlug = String(r.slug || '').replace(/^\/+/, '');
                const isApiOnly = r.visibility === 'api_only';
                return {
                    kind: 'article' as const,
                    type_label: 'Article',
                    date: sortTime.slice(0, 10),
                    title: String(r.title || ''),
                    summary: String(r.summary || ''),
                    url: isApiOnly ? '' : buildLocalizedRoutePath(cleanSlug ? `/${cleanSlug}` : '/', r.locale || pageLocale || siteDefaultLocale, siteDefaultLocale),
                    badge: String(r.folder || meta.folder || r.maturity || ''),
                    created_at: createdAt,
                    id: r.id,
                    folder: r.folder || meta.folder || '',
                    locale: r.locale || '',
                    tags: meta.tags || [],
                    visibility: r.visibility || 'public',
                    cover_image_url: r.cover_image_url || meta.og_image || '',
                    author: meta.author || '',
                    published_at: r.published_at || sortTime,
                    updated_at: r.updated_at || sortTime,
                    seo: {
                        title: meta.seo_title || r.title || '',
                        description: meta.seo_description || r.summary || '',
                        og_image: meta.og_image || r.cover_image_url || '',
                        keywords: meta.keywords || meta.tags || []
                    }
                };
            }))
        );
    }

    if (includeMicros) {
        tasks.push(
            queryNodesWithFilters(db, {
                siteId,
                folder,
                locale: resolvedLocale,
                tag,
                type: 'micro',
                status: 'published',
                excludeApiOnly,
                limit: perSourceLimit,
                offset: 0
            }, false).then((res) => (res.nodes || []).map((r: any) => {
                const meta = (r.metadata && typeof r.metadata === 'object') ? r.metadata : {};
                const sortTime = String(r.published_at || r.created_at || r.updated_at || '');
                const createdAt = String(r.created_at || sortTime);
                return {
                    kind: 'micro' as const,
                    type_label: 'Micro',
                    date: sortTime.slice(0, 10),
                    title: String(r.title || ''),
                    summary: String(r.content_raw || r.summary || ''),
                    content_raw: String(r.content_raw || ''),
                    content_html: String(r.content_html || ''),
                    url: '',
                    badge: String(r.progress || meta.folder || ''),
                    created_at: createdAt,
                    id: r.id,
                    folder: r.folder || meta.folder || '',
                    progress: r.progress || '',
                    locale: r.locale || '',
                    tags: meta.tags || [],
                    visibility: r.visibility || 'public',
                    author: meta.author || '',
                    published_at: r.published_at || sortTime,
                    updated_at: r.updated_at || sortTime
                };
            }))
        );
    }

    if (datasetSchemas.length > 0) {
        const siteSchemas = await findSchemasBySite(db, siteId).catch(() => []);
        const apiOnlySchemaSet = new Set(siteSchemas.filter((s: any) => s.api_only).map((s: any) => s.slug));
        for (const schemaSlug of datasetSchemas) {
            if (schemaSlug && apiOnlySchemaSet.has(schemaSlug)) continue;
            tasks.push(
                queryDatasetsWithJson1Filter(
                    db,
                    siteId,
                    schemaSlug,
                    folder ? { folder } : undefined,
                    perSourceLimit,
                    0,
                    true,
                    true
                ).then((res) => (res.items || []).filter((r: any) => !apiOnlySchemaSet.has(r.schema_slug)).map((r: any) => {
                    let metaObj: Record<string, any> = {};
                    try { metaObj = typeof r.metadata === 'string' ? JSON.parse(r.metadata) : (r.metadata || {}); } catch {}
                    const fieldsObj = (metaObj.fields && typeof metaObj.fields === 'object') ? metaObj.fields : {};
                    const createdAt = String(r.created_at || r.updated_at || '');
                    return {
                        kind: 'dataset' as const,
                        type_label: String(r.schema_slug || schemaSlug || 'Dataset'),
                        date: createdAt.slice(0, 10),
                        title: String(r.title || fieldsObj.title || ''),
                        summary: String(r.summary || fieldsObj.summary || fieldsObj.description || ''),
                        url: String(fieldsObj.url || fieldsObj.site_url || fieldsObj.repo_url || ''),
                        badge: String(fieldsObj.badge || fieldsObj.metrics || fieldsObj.category || fieldsObj.status_badge || r.schema_slug || ''),
                        created_at: createdAt,
                        id: r.id,
                        folder: String(fieldsObj.folder || metaObj.folder || '')
                    };
                }))
            );
        }
    }

    if (tasks.length === 0) return [];
    const groups = await Promise.all(tasks);
    const merged = groups.flat();
    merged.sort((a, b) => {
        const aTime = a.published_at || a.created_at;
        const bTime = b.published_at || b.created_at;
        const diff = parseTimestampMs(bTime) - parseTimestampMs(aTime);
        if (diff !== 0) return diff;
        return String(bTime || '').localeCompare(String(aTime || ''));
    });

    return merged.slice(offset, offset + limit);
}

// Resolves @api: bindings through sanitized public-only DAL queries (published/public rows only).
export async function resolveApiProtocolValue(
    rawVal: string,
    db: D1Database,
    siteId: string,
    pageLocale?: string,
    publicAssetsDomain?: string
): Promise<any[] | null> {
    const trimmed = rawVal.trim();
    const match = trimmed.match(/^@api:(dataset|datasets|micro|micros|article|articles|media|medias|feed|feeds)(?::(.*))?$/i);
    if (!match) return null;
    const kind = match[1].toLowerCase();
    const rest = (match[2] || '').trim();
    const queryStr = rest.includes('=')
        ? rest.replace(/^\?/, '')
        : (rest ? `id=${encodeURIComponent(rest)}` : '');
    const params = new URLSearchParams(queryStr);

    if (kind === 'feed' || kind === 'feeds') {
        return await queryAggregatedFeed(db, siteId, params, pageLocale, true);
    }

    const limit = Math.max(1, Math.min(100, Number(params.get('limit')) || 20));
    const page = Math.max(1, Number(params.get('page')) || 1);
    const offset = params.get('offset') !== null
        ? Math.max(0, Number(params.get('offset')) || 0)
        : (page - 1) * limit;

    if (kind === 'media' || kind === 'medias') {
        return await queryPublicMediaAssets(db, siteId, {
            id: params.get('id') || undefined,
            mime: params.get('mime') || params.get('type') || undefined,
            folder: params.get('folder') || undefined,
            limit,
            offset,
            publicAssetsDomain
        });
    }

    if (kind === 'dataset' || kind === 'datasets') {
        const targetSlug = params.get('collection') || params.get('collection_slug') || params.get('schema') || params.get('schema_slug') || (!rest.includes('=') && rest ? rest : undefined);
        const siteSchemas = await findSchemasBySite(db, siteId).catch(() => []);
        const apiOnlySchemaSet = new Set(siteSchemas.filter((s: any) => s.api_only).map((s: any) => s.slug));
        if (targetSlug && apiOnlySchemaSet.has(targetSlug)) {
            return [];
        }
        const sortMode = (params.get('sort') || 'order').trim().toLowerCase() === 'latest' ? 'latest' : 'order';
        const filters: Record<string, string> = {};
        params.forEach((v, k) => {
            if (!['collection', 'collection_slug', 'schema', 'schema_slug', 'limit', 'offset', 'page', 'site_id', 'sort'].includes(k) && /^[a-zA-Z0-9_]{1,64}$/.test(k)) {
                if (!(k === 'id' && !rest.includes('=') && rest)) {
                    filters[k] = v;
                }
            }
        });
        const res = await queryDatasetsWithJson1Filter(
            db,
            siteId,
            targetSlug,
            Object.keys(filters).length > 0 ? filters : undefined,
            limit,
            offset,
            true,
            true,
            sortMode
        );
        return (res.items || (res as any).data || []).filter((r: any) => !apiOnlySchemaSet.has(r.schema_slug)).map((r: any) => {
            let metaObj: Record<string, any> = {};
            try { metaObj = typeof r.metadata === 'string' ? JSON.parse(r.metadata) : (r.metadata || {}); } catch {}
            const fieldsObj = (metaObj.fields && typeof metaObj.fields === 'object') ? metaObj.fields : {};
            return {
                ...metaObj,
                ...fieldsObj,
                ...r,
                summary: r.summary || metaObj.summary || fieldsObj.summary || ''
            };
        });
    }

    const targetType = (kind === 'micro' || kind === 'micros') ? 'micro' : 'article';
    const progVal = params.get('progress') || params.get('maturity') || undefined;
    const rawLocaleParam = params.get('locale');
    const resolvedLocale = rawLocaleParam === 'all'
        ? undefined
        : (rawLocaleParam && rawLocaleParam !== 'auto' ? rawLocaleParam : (pageLocale || undefined));

    const res = await queryNodesWithFilters(db, {
        siteId,
        id: params.get('id') || undefined,
        slug: params.get('slug') || undefined,
        progress: progVal,
        maturity: progVal,
        folder: params.get('folder') || undefined,
        locale: resolvedLocale,
        type: targetType,
        status: 'published',
        excludeApiOnly: true,
        tag: params.get('tag') || undefined,
        page,
        limit,
        offset
    }, false);
    if (targetType === 'micro') {
        return res.nodes || [];
    }
    const site = await findSiteById(db, siteId).catch(() => null);
    const siteDefaultLocale = site?.default_locale || 'zh-CN';
    return (res.nodes || []).map((r: any) => {
        const cleanSlug = String(r.slug || '').replace(/^\/+/, '');
        return {
            ...r,
            url: r.url !== undefined ? r.url : buildLocalizedRoutePath(cleanSlug ? `/${cleanSlug}` : '/', r.locale || pageLocale || siteDefaultLocale, siteDefaultLocale)
        };
    });
}
