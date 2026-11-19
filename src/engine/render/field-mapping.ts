import type { Site } from '../types';
import { renderTemplate, sweepTemplateVariables } from './template';
import { DEFAULT_DEV_HOST, buildAbsoluteUrl } from '../core/url';
import { resolveSiteBrandInfo } from '../core/dal/sites.dal';
import { t } from '../core/i18n';
import { escapeHtmlAttr } from '../core/utils';
import { sanitizeUrlAttr } from './markdown-parser';

export { renderTemplate, sweepTemplateVariables };

export interface PoweredByInfo {
    enabled: boolean;
    label: string;
    url: string;
}

export interface BuiltinSiteFields {
    name: string;
    slogan: string;
    description: string;
    logo: string;
    favicon: string;
    domain: string;
    copyright: string;
    email: string;
    socials: Array<{ name: string; url: string; icon?: string }>;
    assetsBase?: string;
    powered_by: PoweredByInfo;
}

export interface BuiltinPageFields {
    title: string;
    slug: string;
    path: string;
    url: string;
    summary: string;
    content: string;
    content_raw: string;
    published_date: string;
    updated_date: string;
    published_at: string;
    updated_at: string;
    author: string;
    curator_name: string;
    reading_time: string;
    cover_image: string;
    tags: string[];
    category: string;
    locale: string;
    year: number;
    type: string;
    status: string;
}

export interface BuiltinRenderContext {
    site: BuiltinSiteFields;
    page: BuiltinPageFields;
}

export function resolveBuiltinSiteFields(
    site: Site,
    host: string = DEFAULT_DEV_HOST,
    themeSlug: string = ''
): BuiltinSiteFields {
    let settings: any = {};
    if (typeof site.settings === 'string') {
        try { settings = JSON.parse(site.settings); } catch {}
    } else if (site.settings) {
        settings = site.settings;
    }

    const brandInfo = resolveSiteBrandInfo(site);
    const whitelabel = brandInfo.effectiveWhitelabel || settings.whitelabel || {};
    const appearance = settings.appearance || {};
    const currentYear = new Date().getFullYear();

    const rawName = site.name || brandInfo.brandName || 'Content Management System';
    const name = escapeHtmlAttr(rawName);
    const slogan = escapeHtmlAttr(settings.subtitle || settings.slogan || '');
    const description = escapeHtmlAttr(settings.description || settings.seo?.description || '');
    const logo = sanitizeUrlAttr(settings.logo_url || whitelabel.logo_url || '/shared/logo.svg');
    const favicon = sanitizeUrlAttr(settings.favicon_url || whitelabel.favicon_url || '/favicon.ico');
    const domain = escapeHtmlAttr(site.primary_domain || host || DEFAULT_DEV_HOST);

    const defaultCopyright = `© ${currentYear} ${rawName}. All rights reserved.`;
    const copyright = escapeHtmlAttr(settings.copyright || whitelabel.copyright_text || whitelabel.copyright || defaultCopyright);

    const email = escapeHtmlAttr(settings.contact_email || settings.email || settings.admin_email || `contact@${domain}`);

    const socials: Array<{ name: string; url: string; icon?: string }> = [];
    if (Array.isArray(settings.socials) && settings.socials.length > 0) {
        for (const item of settings.socials) {
            if (item && item.url) {
                socials.push({
                    name: escapeHtmlAttr(item.name || 'Link'),
                    url: sanitizeUrlAttr(item.url),
                    icon: item.icon || inferSocialIcon(item.name || item.url)
                });
            }
        }
    } else if (appearance.footer_links && typeof appearance.footer_links === 'string') {
        const lines = appearance.footer_links.split('\n').map((l: string) => l.trim()).filter(Boolean);
        for (const line of lines) {
            const parts = line.split('|').map((p: string) => p.trim());
            if (parts.length >= 2) {
                const label = parts[0];
                const link = parts[1];
                if (isSocialLink(link, label)) {
                    socials.push({
                        name: escapeHtmlAttr(label),
                        url: sanitizeUrlAttr(link),
                        icon: inferSocialIcon(label)
                    });
                }
            }
        }
    }

    const assetsBase = settings.assets_base || `/theme/${themeSlug}`;
    const hidePoweredBy = brandInfo.hidePoweredBy;
    const defaultPoweredBrand = brandInfo.poweredByBrand || t('zh-CN', 'common.powered_by_brand');
    const rawPoweredLabel = brandInfo.customPoweredBy
        ? String(brandInfo.customPoweredBy).replace(/<[^>]*>/g, '').trim()
        : `Powered by ${defaultPoweredBrand}`;
    const isThirdPartyWhitelabel = Boolean(brandInfo.poweredByBrand && !/walnut/i.test(brandInfo.poweredByBrand));
    // Keep canonical walnutcms.com for community/Walnut branding while avoiding brand leakage under third-party white-label.
    const rawPoweredUrl = brandInfo.supportUrl || (isThirdPartyWhitelabel ? '#powered-by' : 'https://walnutcms.com');
    const powered_by: PoweredByInfo = hidePoweredBy
        ? { enabled: false, label: '', url: '' }
        : {
            enabled: true,
            label: escapeHtmlAttr(rawPoweredLabel || `Powered by ${defaultPoweredBrand}`),
            url: sanitizeUrlAttr(rawPoweredUrl)
        };

    return {
        name,
        slogan,
        description,
        logo,
        favicon,
        domain,
        copyright,
        email,
        socials,
        assetsBase,
        powered_by
    };
}

export function resolveBuiltinPageFields(
    targetNodeData: { node?: any; version?: any } | null,
    rawPath: string,
    host: string,
    locale: string,
    site: Site,
    processedContent: string = ''
): BuiltinPageFields {
    const node = targetNodeData?.node;
    const version = targetNodeData?.version;

    let meta: Record<string, any> = {};
    if (node?.metadata) {
        meta = typeof node.metadata === 'string' ? (JSON.parse(node.metadata) || {}) : node.metadata;
    }

    const title = escapeHtmlAttr(node?.title || (rawPath === '/' ? site.name : 'Untitled'));
    const slug = escapeHtmlAttr(node?.slug || rawPath.replace(/^\//, '') || 'home');
    const path = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
    const url = buildAbsoluteUrl(path, host);

    const nodeType = node?.type || 'single';
    const isPageNode = nodeType === 'page' || nodeType === 'single' || nodeType === 'template' || nodeType === 'redirect';

    let summary = node?.summary || version?.summary || meta.description || '';
    if (typeof summary === 'string' && (summary.trim().startsWith('[{') || summary.trim() === '[]')) {
        summary = meta.description || '';
    }
    summary = escapeHtmlAttr(summary);

    const rawVerContent = version?.content_raw || '';
    const isJsonBlocks = isPageNode || (typeof rawVerContent === 'string' && (rawVerContent.trim().startsWith('[') || rawVerContent.trim().startsWith('{')));

    const content = isJsonBlocks ? '' : (processedContent || rawVerContent);
    const content_raw = isJsonBlocks ? '' : rawVerContent;

    const now = new Date();
    const publishedAtDate = node?.published_at ? new Date(node.published_at) : (node?.created_at ? new Date(node.created_at) : now);
    const updatedAtDate = node?.updated_at ? new Date(node.updated_at) : now;

    const effectiveLocale = node?.locale || meta.locale || locale || 'zh-CN';
    const published_date = publishedAtDate.toLocaleDateString(effectiveLocale);
    const updated_date = updatedAtDate.toLocaleDateString(effectiveLocale);
    const published_at = publishedAtDate.toISOString();
    const updated_at = updatedAtDate.toISOString();

    const brandInfoForAuthor = resolveSiteBrandInfo(site);
    const author = escapeHtmlAttr(meta.author || meta.author_name || brandInfoForAuthor.brandName || site.name || 'Editorial Team');
    const curator_name = author;

    // Approximate reading time at 300 chars/min.
    const rawLen = content_raw.length;
    const minutes = Math.max(1, Math.ceil(rawLen / 300));
    const reading_time = `${minutes} min read`;

    const rawCover = meta.cover_image || meta.og_image || meta.preview_image || '';
    const cover_image = rawCover ? sanitizeUrlAttr(rawCover) : '';
    const tags = Array.isArray(meta.tags)
        ? meta.tags.map((x: any) => escapeHtmlAttr(String(x)))
        : (typeof meta.tags === 'string' ? meta.tags.split(',').map((s: string) => escapeHtmlAttr(s.trim())) : []);
    const category = escapeHtmlAttr(meta.category || node?.type || 'General');

    const type = node?.type || 'single';
    const status = node?.status || 'published';
    const year = now.getFullYear();

    return {
        title,
        slug,
        path,
        url,
        summary,
        content,
        content_raw,
        published_date,
        updated_date,
        published_at,
        updated_at,
        author,
        curator_name,
        reading_time,
        cover_image,
        tags,
        category,
        locale: effectiveLocale,
        year,
        type,
        status
    };
}

export function buildTemplateScope(
    builtin: BuiltinRenderContext,
    extra: Record<string, any> = {}
): Record<string, any> {
    const { site, page } = builtin;

    return {
        site,
        page,

        site_name: site.name,
        slogan: site.slogan,
        site_slogan: site.slogan,
        site_description: site.description,
        headline: site.name,
        subheadline: site.slogan || site.description,
        brand_name: site.name,
        brand_description: site.description || site.slogan,
        logo: site.logo,
        logo_url: site.logo,
        favicon: site.favicon,
        favicon_url: site.favicon,
        domain: site.domain,
        site_domain: site.domain,
        copyright: site.copyright,
        contact_email: site.email,
        email: site.email,
        socials: site.socials,

        title: page.title,
        page_title: page.title,
        slug: page.slug,
        path: page.path,
        url: page.url,
        summary: page.summary,
        page_summary: page.summary,
        content: page.content,
        content_html: page.content,
        content_raw: page.content_raw,
        published_date: page.published_date,
        updated_date: page.updated_date,
        published_at: page.published_date,
        author: page.author,
        author_name: page.author,
        curator_name: page.curator_name,
        reading_time: page.reading_time,
        cover_image: page.cover_image,
        tags: page.tags,
        category: page.category,
        locale: page.locale,
        current_year: page.year,
        year: page.year,

        powered_by: site.powered_by,

        ...extra
    };
}

function isSocialLink(url: string, label: string): boolean {
    const lower = `${url} ${label}`.toLowerCase();
    return ['github', 'twitter', 'x.com', 'discord', 'telegram', 'youtube', 'bilibili', 'weibo', 'linkedin', 'facebook', 'instagram', 'mastodon'].some(k => lower.includes(k));
}

function inferSocialIcon(text: string): string {
    const lower = text.toLowerCase();
    if (lower.includes('github') || lower.includes('code')) return 'code';
    if (lower.includes('twitter') || lower.includes('x.com')) return 'chat';
    if (lower.includes('mail') || lower.includes('@')) return 'mail';
    if (lower.includes('youtube') || lower.includes('video')) return 'play_circle';
    if (lower.includes('doc') || lower.includes('book')) return 'menu_book';
    return 'share';
}
