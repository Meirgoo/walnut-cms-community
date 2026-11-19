import type { WalnutPlugin, IPluginEngine, Site } from '../types';
import { buildAbsoluteUrl, resolveEffectiveDomain } from '../core/url';
import { escapeHtml } from '../core/utils';
import { safeJsonStringify } from '../render/markdown-parser';

export interface SeoTargetEntity {
    title?: string;
    summary?: string;
    metadata?: any;
    slug?: string;
    cover_image_url?: string;
    type?: string;
    published_at?: string;
    created_at?: string;
    updated_at?: string;
}

export interface HreflangLink {
    locale: string;
    url: string;
}

export interface SeoMetadataPayload {
    title: string;
    description: string;
    canonicalUrl: string;
    robots?: string;
    ogImage?: string;
    ogTitle?: string;
    ogDescription?: string;
    ogType?: 'website' | 'article';
    publishedTime?: string;
    modifiedTime?: string;
    authorName?: string;
    keywords?: string[];
    structuredData?: Record<string, any>;
    customMeta?: Record<string, string>;
}

export function extractSmartTdkFromContent(rawMarkdown: string): {
    extractedTitle?: string;
    extractedSummary?: string;
    extractedKeywords?: string[];
} {
    if (!rawMarkdown || typeof rawMarkdown !== 'string') {
        return {};
    }

    const cleanRaw = rawMarkdown.trim();

    // Cap extraction to the first 4,000 characters to avoid Workers CPU spikes on large articles.
    const sampleText = cleanRaw.slice(0, 4000);

    const headingMatch = sampleText.match(/^#{1,3}\s+(.+)$/m);
    const extractedTitle = headingMatch ? headingMatch[1].replace(/[*`_]/g, '').trim() : undefined;

    const cleanedText = sampleText
        .replace(/^#{1,6}\s+.*$/gm, '')
        .replace(/\[\[(?:[^\[\]\n|]+\|)?([^\[\]\n]+)\]\]/g, '$1')
        .replace(/!\[([^\[\]\n]*)\]\(([^)\n]*)\)/g, '')
        .replace(/\[([^\[\]\n]+)\]\(([^)\n]+)\)/g, '$1')
        .replace(/`{3}[\s\S]*?`{3}/g, '')
        .replace(/`([^`\n]+)`/g, '$1')
        .replace(/[*_~>#-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    const extractedSummary = cleanedText.length > 0
        ? (cleanedText.length > 160 ? cleanedText.slice(0, 160) + '...' : cleanedText)
        : undefined;

    const tagMatches = Array.from(sampleText.matchAll(/#([a-zA-Z0-9_\u4e00-\u9fa5-]+)/g));
    const extractedKeywords = tagMatches.length > 0
        ? Array.from(new Set(tagMatches.map(m => m[1].trim())))
        : undefined;

    return {
        extractedTitle,
        extractedSummary,
        extractedKeywords
    };
}

// Reject raw JSON arrays/objects so unparsed block payloads never leak into meta descriptions.
export function sanitizeDirtySeoText(raw?: string): string {
    if (!raw || typeof raw !== 'string') return '';
    const cleaned = raw.trim();
    if (cleaned.startsWith('[') || cleaned.startsWith('{')) return '';
    return cleaned;
}

function parseMeta(node?: Partial<SeoTargetEntity> | null): Record<string, any> {
    if (!node || !node.metadata) return {};
    try {
        return typeof node.metadata === 'string' ? JSON.parse(node.metadata) : node.metadata;
    } catch {
        return {};
    }
}

// Merge robots directives conservatively: noindex/nofollow at any layer overrides permissive defaults.
export function resolveMostRestrictiveRobots(...robotsList: Array<string | undefined>): string {
    let noindex = false;
    let nofollow = false;
    const additionalFlags = new Set<string>();

    for (const r of robotsList) {
        if (!r || typeof r !== 'string') continue;
        const lower = r.toLowerCase();
        if (lower.includes('noindex')) noindex = true;
        if (lower.includes('nofollow')) nofollow = true;
        if (lower.includes('noarchive')) additionalFlags.add('noarchive');
        if (lower.includes('nosnippet')) additionalFlags.add('nosnippet');
    }

    const indexPart = noindex ? 'noindex' : 'index';
    const followPart = nofollow ? 'nofollow' : 'follow';
    const resultParts = [indexPart, followPart, ...Array.from(additionalFlags)];
    return resultParts.join(', ');
}

export class SeoPlugin {
    // Precedence rules: content > page > site for TDK/canonical; most-restrictive wins for robots.
    public assembleSeoMetadata(
        site: Site,
        contentNode?: Partial<SeoTargetEntity> | null,
        optionsOrPage?: { currentUrl: string; rawContent?: string; pageNode?: Partial<SeoTargetEntity> } | Partial<SeoTargetEntity>,
        legacyOptions?: { currentUrl: string; rawContent?: string }
    ): SeoMetadataPayload {
        let pageNode: Partial<SeoTargetEntity> | undefined = undefined;
        let options: { currentUrl: string; rawContent?: string } | undefined = undefined;

        if (optionsOrPage && 'currentUrl' in optionsOrPage) {
            options = optionsOrPage as { currentUrl: string; rawContent?: string };
            pageNode = (optionsOrPage as any).pageNode;
        } else if (optionsOrPage) {
            pageNode = optionsOrPage as Partial<SeoTargetEntity>;
            options = legacyOptions;
        }

        const siteName = site.settings?.whitelabel?.brand_name || site.settings?.whitelabel?.system_title || site.name || 'Content Management System';
        const isArticle = contentNode?.type === 'article';

        const contentMeta = parseMeta(contentNode);
        const pageMeta = parseMeta(pageNode);
        const siteSeo = site.settings?.seo || {};

        const rawCandidate = options?.rawContent || (typeof contentNode?.summary === 'string' ? contentNode.summary : '');
        const isJsonPayload = typeof rawCandidate === 'string' && (rawCandidate.trim().startsWith('[') || rawCandidate.trim().startsWith('{'));
        const rawContent = (!isJsonPayload && isArticle) ? rawCandidate : '';
        const autoExtracted = extractSmartTdkFromContent(rawContent);

        const contentTitleCandidate = contentMeta.meta_title || contentMeta.seo_title || contentNode?.title || autoExtracted.extractedTitle;
        const pageTitleCandidate = pageMeta.meta_title || pageMeta.seo_title || pageNode?.title;
        const baseTitle = contentTitleCandidate || pageTitleCandidate;
        const titleTemplate = site.settings?.title_template || '%s - ' + siteName;

        const title = baseTitle
            ? (titleTemplate.includes('%s') ? titleTemplate.replace('%s', baseTitle) : `${baseTitle} - ${siteName}`)
            : (site.settings?.site_name || siteName);

        const contentDescCandidate = sanitizeDirtySeoText(contentMeta.meta_description || contentMeta.seo_description) || sanitizeDirtySeoText(contentNode?.summary) || autoExtracted.extractedSummary;
        const pageDescCandidate = sanitizeDirtySeoText(pageMeta.meta_description || pageMeta.seo_description) || sanitizeDirtySeoText(pageNode?.summary);
        const siteDescCandidate = sanitizeDirtySeoText(site.settings?.description || siteSeo.description) || siteName;
        const description = contentDescCandidate || pageDescCandidate || siteDescCandidate;

        let keywords: string[];
        const parseKeywords = (kw: any): string[] => {
            if (!kw) return [];
            if (Array.isArray(kw)) return kw.map(String).map(s => s.trim()).filter(Boolean);
            if (typeof kw === 'string') return kw.split(',').map(s => s.trim()).filter(Boolean);
            return [];
        };

        const contentKws = parseKeywords(contentMeta.meta_keywords || contentMeta.keywords);
        const pageKws = parseKeywords(pageMeta.meta_keywords || pageMeta.keywords);
        const autoKws = autoExtracted.extractedKeywords || [];
        const siteKws = parseKeywords(siteSeo.keywords);

        if (contentKws.length > 0) keywords = contentKws;
        else if (autoKws.length > 0) keywords = autoKws;
        else if (pageKws.length > 0) keywords = pageKws;
        else if (siteKws.length > 0) keywords = siteKws;
        else keywords = site.name ? [site.name] : ['Content', 'Blog'];

        const contentRobots = contentMeta.robots || contentMeta.meta_robots;
        const pageRobots = pageMeta.robots || pageMeta.meta_robots;
        const siteRobots = siteSeo.robots || site.settings?.robots_control;
        const robots = resolveMostRestrictiveRobots(contentRobots, pageRobots, siteRobots);

        let currentUrlHost: string | undefined;
        if (options?.currentUrl) {
            try { currentUrlHost = new URL(options.currentUrl).host; } catch {}
        }
        const effectiveHost = resolveEffectiveDomain(site.primary_domain, currentUrlHost);
        const contentCanonical = contentMeta.canonical_url || contentMeta.meta_canonical_url;
        const pageCanonical = pageMeta.canonical_url || pageMeta.meta_canonical_url;
        const defaultCanonical = options?.currentUrl || buildAbsoluteUrl('/', effectiveHost);
        const rawCanonical = contentCanonical || pageCanonical || defaultCanonical;
        const canonicalUrl = buildAbsoluteUrl(rawCanonical, effectiveHost);

        const rawOgImage = contentMeta.og_image || contentNode?.cover_image_url || pageMeta.og_image || siteSeo.og_image || '';
        const ogImage = rawOgImage ? buildAbsoluteUrl(rawOgImage, effectiveHost) : '';
        const ogTitle = contentMeta.og_title || pageMeta.og_title || baseTitle || siteName;
        const ogDescription = sanitizeDirtySeoText(contentMeta.og_description || pageMeta.og_description) || description;

        const structuredData: Record<string, any> = {
            "@context": "https://schema.org",
            "@type": isArticle ? "BlogPosting" : "WebSite",
            "name": title,
            "headline": baseTitle || title,
            "description": description,
            "url": canonicalUrl,
            "publisher": {
                "@type": "Organization",
                "name": siteName,
                ...(site.settings?.logo_url ? { "logo": { "@type": "ImageObject", "url": site.settings.logo_url } } : {})
            },
            ...(ogImage ? { "image": ogImage } : {}),
            ...(contentNode?.published_at || contentNode?.created_at ? { "datePublished": contentNode?.published_at || contentNode?.created_at } : {}),
            ...(contentNode?.updated_at ? { "dateModified": contentNode.updated_at } : {})
        };

        return {
            title,
            description,
            canonicalUrl,
            robots,
            ogImage,
            ogTitle,
            ogDescription,
            ogType: isArticle ? 'article' : 'website',
            publishedTime: contentNode?.published_at || contentNode?.created_at,
            modifiedTime: contentNode?.updated_at,
            keywords,
            structuredData
        };
    }

    public serializeSeoHeaders(
        site: Site,
        seo: SeoMetadataPayload,
        hreflangs?: HreflangLink[]
    ): string {
        const googleVerification = site.settings?.seo?.google_site_verification || site.settings?.google_analytics_id;

        const hreflangTags = (hreflangs || []).map(link => {
            return `<link rel="alternate" hreflang="${escapeHtml(link.locale || '')}" href="${escapeHtml(link.url || '')}" />`;
        }).join('\n    ');

        const jsonLd = seo.structuredData || {
            "@context": "https://schema.org",
            "@type": seo.ogType === 'article' ? "BlogPosting" : "WebSite",
            "name": seo.title,
            "headline": seo.title,
            "description": seo.description,
            "url": seo.canonicalUrl,
            ...(seo.ogImage ? { "image": seo.ogImage } : {})
        };
        const safeJsonLdStr = safeJsonStringify(jsonLd);
        const safeTitle = escapeHtml(seo.title || '');
        const safeDesc = escapeHtml(seo.description || '');
        const safeCanonical = escapeHtml(seo.canonicalUrl || '');
        const safeRobots = escapeHtml(seo.robots || '');
        const safeSiteName = escapeHtml(site.settings?.whitelabel?.brand_name || site.settings?.whitelabel?.system_title || site.name || 'Content Management System');
        const safeOgTitle = escapeHtml(seo.ogTitle || seo.title || '');
        const safeOgDesc = escapeHtml(seo.ogDescription || seo.description || '');
        const safeOgType = escapeHtml(seo.ogType || 'website');
        const safeOgImage = escapeHtml(seo.ogImage || '');
        const safePubTime = escapeHtml(seo.publishedTime || '');
        const safeKeywords = seo.keywords && seo.keywords.length > 0 ? escapeHtml(seo.keywords.join(', ')) : '';
        const safeGoogleVer = escapeHtml(googleVerification || '');

        return [
            `<title>${safeTitle}</title>`,
            `<meta name="description" content="${safeDesc}">`,
            `<link rel="canonical" href="${safeCanonical}">`,
            safeRobots && `<meta name="robots" content="${safeRobots}">`,
            safeKeywords && `<meta name="keywords" content="${safeKeywords}">`,
            hreflangTags,
            `<meta property="og:site_name" content="${safeSiteName}">`,
            `<meta property="og:title" content="${safeOgTitle}">`,
            `<meta property="og:description" content="${safeOgDesc}">`,
            `<meta property="og:url" content="${safeCanonical}">`,
            `<meta property="og:type" content="${safeOgType}">`,
            safeOgImage && `<meta property="og:image" content="${safeOgImage}">`,
            safePubTime && `<meta property="article:published_time" content="${safePubTime}">`,
            `<meta name="twitter:card" content="summary_large_image">`,
            `<meta name="twitter:title" content="${safeOgTitle}">`,
            `<meta name="twitter:description" content="${safeOgDesc}">`,
            safeOgImage && `<meta name="twitter:image" content="${safeOgImage}">`,
            safeGoogleVer && `<meta name="google-site-verification" content="${safeGoogleVer}">`,
            `<script type="application/ld+json">${safeJsonLdStr}</script>`
        ].filter(Boolean).join('\n');
    }
}

export const seoPlugin: WalnutPlugin = {
    name: 'seo:core',
    version: '1.0.0',
    tier: 'community',
    setup(_engine: IPluginEngine): void {}
};
