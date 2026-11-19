import type { D1Database } from '@cloudflare/workers-types';
import { queryNodesWithFilters, queryDatasetsWithJson1Filter, queryPublicMediaAssets } from '../core/dal';

export interface FeedItem {
    kind: 'article' | 'micro' | 'dataset';
    type_label: string;
    date: string;
    title: string;
    summary: string;
    url: string;
    badge: string;
    created_at: string;
    id?: string;
    folder?: string;
    progress?: string;
    locale?: string;
    tags?: any;
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
    pageLocale?: string
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
        : (rawLocaleParam === 'auto' ? (pageLocale || undefined) : (rawLocaleParam || undefined));

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
                limit: perSourceLimit,
                offset: 0
            }, false).then((res) => (res.nodes || []).map((r: any) => {
                const meta = (r.metadata && typeof r.metadata === 'object') ? r.metadata : {};
                const createdAt = String(r.created_at || r.published_at || r.updated_at || '');
                const cleanSlug = String(r.slug || '').replace(/^\/+/, '');
                return {
                    kind: 'article' as const,
                    type_label: 'Article',
                    date: createdAt.slice(0, 10),
                    title: String(r.title || ''),
                    summary: String(r.summary || ''),
                    url: cleanSlug ? `/${cleanSlug}` : '/',
                    badge: String(r.folder || meta.folder || r.maturity || ''),
                    created_at: createdAt,
                    id: r.id,
                    folder: r.folder || meta.folder || '',
                    locale: r.locale || '',
                    tags: meta.tags || []
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
                limit: perSourceLimit,
                offset: 0
            }, false).then((res) => (res.nodes || []).map((r: any) => {
                const meta = (r.metadata && typeof r.metadata === 'object') ? r.metadata : {};
                const createdAt = String(r.created_at || r.published_at || r.updated_at || '');
                return {
                    kind: 'micro' as const,
                    type_label: 'Micro',
                    date: createdAt.slice(0, 10),
                    title: String(r.title || ''),
                    summary: String(r.content_raw || r.summary || ''),
                    url: '',
                    badge: String(r.progress || meta.folder || ''),
                    created_at: createdAt,
                    id: r.id,
                    folder: r.folder || meta.folder || '',
                    progress: r.progress || '',
                    locale: r.locale || '',
                    tags: meta.tags || []
                };
            }))
        );
    }

    for (const schemaSlug of datasetSchemas) {
        tasks.push(
            queryDatasetsWithJson1Filter(
                db,
                siteId,
                schemaSlug,
                folder ? { folder } : undefined,
                perSourceLimit,
                0,
                true
            ).then((res) => (res.items || []).map((r: any) => {
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

    if (tasks.length === 0) return [];
    const groups = await Promise.all(tasks);
    const merged = groups.flat();
    merged.sort((a, b) => {
        const diff = parseTimestampMs(b.created_at) - parseTimestampMs(a.created_at);
        if (diff !== 0) return diff;
        return String(b.created_at || '').localeCompare(String(a.created_at || ''));
    });

    return merged.slice(offset, offset + limit);
}

// Resolves @api: bindings through sanitized public-only DAL queries (published/public rows only).
export async function resolveApiProtocolValue(
    rawVal: string,
    db: D1Database,
    siteId: string,
    pageLocale?: string
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
        return await queryAggregatedFeed(db, siteId, params, pageLocale);
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
            offset
        });
    }

    if (kind === 'dataset' || kind === 'datasets') {
        const schemaSlug = params.get('schema') || params.get('schema_slug') || undefined;
        const filters: Record<string, string> = {};
        params.forEach((v, k) => {
            if (!['schema', 'schema_slug', 'limit', 'offset', 'page', 'site_id'].includes(k) && /^[a-zA-Z0-9_]{1,64}$/.test(k)) {
                filters[k] = v;
            }
        });
        const res = await queryDatasetsWithJson1Filter(
            db,
            siteId,
            schemaSlug,
            Object.keys(filters).length > 0 ? filters : undefined,
            limit,
            offset,
            true
        );
        return (res.items || (res as any).data || []).map((r: any) => {
            const metaObj = (r.metadata && typeof r.metadata === 'object') ? r.metadata : {};
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
    const resolvedLocale = targetType === 'micro'
        ? (rawLocaleParam === 'all' ? undefined : (rawLocaleParam && rawLocaleParam !== 'auto' ? rawLocaleParam : (pageLocale || undefined)))
        : (rawLocaleParam || undefined);

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
        tag: params.get('tag') || undefined,
        page,
        limit,
        offset
    }, false);
    return res.nodes || [];
}
