import type { D1Database } from '@cloudflare/workers-types';
import type { Site } from '../../types';
import { resolveSiteBrandInfo } from './sites.dal';
import { loadPublishedPageParentResolver } from './pages.dal';
import { buildLocalizedRoutePath, normalizeLocaleCode } from '../i18n';
import { buildAbsoluteUrl, resolveEffectiveDomain } from '../url';
import { parseJson, escapeXml } from '../utils';
import { isRestrictedAccess } from './content-common';
import { normalizeRoutePath } from './route-fallback.dal';
import { buildUpsertSiteRouteStatement, getOrBuildSiteCacheIndex, type SiteCacheIndex } from './cache-index.dal';

const escapeCdata = (val?: string | null): string =>
    String(val || '').replace(/\]\]>/g, ']]]]><![CDATA[>');

export async function rebuildSiteSitemapRoute(
    db: D1Database,
    site: Site,
    host?: string,
    existingIndex?: SiteCacheIndex
): Promise<string> {
    const index = existingIndex || await getOrBuildSiteCacheIndex(db, undefined, site.id);
    const targetHost = resolveEffectiveDomain(site.primary_domain, host);
    const xml = renderRichSitemapXml(index, site, targetHost);

    const upsertSitemapStmt = buildUpsertSiteRouteStatement(db, {
        id: `sr_${site.id}_sitemap`,
        siteId: site.id,
        path: '/sitemap.xml',
        entityType: 'sitemap',
        entityId: 'sitemap',
        locale: site.default_locale || 'zh-CN',
        title: 'Sitemap XML',
        renderedHtml: xml,
        statusCode: 200,
        isDirty: 0,
        changefreq: 'daily',
        priority: 1.0
    });

    await upsertSitemapStmt.run();
    return xml;
}

export function renderRichSitemapXml(
    index: SiteCacheIndex,
    site: Site,
    host: string
): string {
    const domain = resolveEffectiveDomain(site.primary_domain, host);
    const entries = Object.values(index);
    const xmlUrlNodes: string[] = [];

    for (const item of entries) {
        if (item.path === '/sitemap.xml') continue;
        const normPath = normalizeRoutePath(item.path);
        const loc = buildAbsoluteUrl(normPath, domain);
        const lastmod = item.updated_at ? item.updated_at.split('T')[0].split(' ')[0] : new Date().toISOString().split('T')[0];
        const changefreq = item.changefreq || 'weekly';
        const priority = (item.priority !== undefined ? item.priority : 0.8).toFixed(1);

        const siteDefaultLocale = site.default_locale || 'zh-CN';
        const defaultPeer = item.translations?.find(t => normalizeLocaleCode(t.locale) === normalizeLocaleCode(siteDefaultLocale));
        const xDefaultHref = normalizeLocaleCode(item.locale || siteDefaultLocale) === normalizeLocaleCode(siteDefaultLocale)
            ? loc
            : (defaultPeer ? buildAbsoluteUrl(normalizeRoutePath(defaultPeer.path), domain) : loc);
        const xhtmlLinks = (item.translations && item.translations.length > 0)
            ? [
                `    <xhtml:link rel="alternate" hreflang="${escapeXml(item.locale || siteDefaultLocale)}" href="${escapeXml(loc)}" />`,
                ...item.translations.map(t => `    <xhtml:link rel="alternate" hreflang="${escapeXml(t.locale)}" href="${escapeXml(buildAbsoluteUrl(normalizeRoutePath(t.path), domain))}" />`),
                `    <xhtml:link rel="alternate" hreflang="x-default" href="${escapeXml(xDefaultHref)}" />`
            ]
            : [];

        const imageNodes = (item.images || []).map(img =>
            `    <image:image>\n      <image:loc>${escapeXml(buildAbsoluteUrl(img.loc, domain))}</image:loc>${img.title ? `\n      <image:title>${escapeXml(img.title)}</image:title>` : ''}\n    </image:image>`
        );

        xmlUrlNodes.push(`  <url>\n    <loc>${escapeXml(loc)}</loc>\n    <lastmod>${lastmod}</lastmod>\n    <changefreq>${changefreq}</changefreq>\n    <priority>${priority}</priority>\n${xhtmlLinks.join('\n')}${imageNodes.length ? (xhtmlLinks.length ? '\n' : '') + imageNodes.join('\n') : ''}\n  </url>`);
    }

    return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"\n        xmlns:xhtml="http://www.w3.org/1999/xhtml"\n        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">\n${xmlUrlNodes.join('\n')}\n</urlset>`.trim();
}

export async function rebuildSiteFeedRoute(
    db: D1Database,
    site: Site,
    host: string,
    format: 'xml' | 'json',
    routePath?: string,
    targetLocale?: string
): Promise<string> {
    const domain = resolveEffectiveDomain(site.primary_domain, host);
    const defaultLocale = site.default_locale || 'zh-CN';
    const feedLocale = normalizeLocaleCode(targetLocale || defaultLocale) || defaultLocale;
    const isDefaultFeedLocale = normalizeLocaleCode(feedLocale) === normalizeLocaleCode(defaultLocale);
    const siteUrl = buildAbsoluteUrl(buildLocalizedRoutePath('/', feedLocale, defaultLocale), domain);
    const feedPath = routePath || buildLocalizedRoutePath(format === 'xml' ? '/feed.xml' : '/feed.json', feedLocale, defaultLocale);
    const feedUrl = buildAbsoluteUrl(feedPath, domain);

    const localeCondition = isDefaultFeedLocale
        ? `(a.locale = ? OR a.locale IS NULL)`
        : `a.locale = ?`;
    const nowIso = new Date().toISOString();
    const querySql = `
        SELECT a.id, a.slug, a.title, a.summary, a.published_at, a.updated_at,
               av.content_rendered, av.content_raw
        FROM articles a
        LEFT JOIN entity_versions av ON a.current_version_id = av.id AND av.entity_type = 'article'
        WHERE a.site_id = ?
          AND a.status = 'published'
          AND (a.visibility = 'public' OR a.visibility IS NULL)
          AND (a.published_at IS NULL OR REPLACE(a.published_at, ' ', 'T') <= ?)
          AND a.deleted_at IS NULL
          AND (a.metadata NOT LIKE '%"robots":"noindex%' OR a.metadata IS NULL)
          AND ${localeCondition}
        ORDER BY COALESCE(a.published_at, a.updated_at) DESC
        LIMIT 20
    `;
    const { results } = await db.prepare(querySql).bind(site.id, nowIso, feedLocale).all<{
        id: string;
        slug: string;
        title: string;
        summary: string;
        published_at: string;
        updated_at: string;
        content_rendered?: string;
        content_raw?: string;
    }>();

    const items = results || [];
    let body = '';
    if (format === 'json') {
        body = JSON.stringify({
            version: 'https://jsonfeed.org/version/1.1',
            title: site.name || resolveSiteBrandInfo(site).brandName,
            home_page_url: siteUrl,
            feed_url: feedUrl,
            language: feedLocale,
            items: items.map(it => ({
                id: it.id,
                url: buildAbsoluteUrl(buildLocalizedRoutePath(it.slug, feedLocale, defaultLocale), domain),
                title: it.title || '',
                summary: it.summary || '',
                content_html: it.content_rendered || it.content_raw || '',
                date_published: it.published_at || it.updated_at
            }))
        }, null, 2);
    } else {
        const rssItems = items.map(it => {
            const link = buildAbsoluteUrl(buildLocalizedRoutePath(it.slug, feedLocale, defaultLocale), domain);
            const fullHtml = it.content_rendered || it.content_raw || it.summary || '';
            return [
                '<item>',
                `<title>${escapeXml(it.title)}</title>`,
                `<link>${escapeXml(link)}</link>`,
                `<guid isPermaLink="true">${escapeXml(link)}</guid>`,
                `<pubDate>${new Date(it.published_at || it.updated_at || Date.now()).toUTCString()}</pubDate>`,
                `<description><![CDATA[${escapeCdata(it.summary || '')}]]></description>`,
                `<content:encoded><![CDATA[${escapeCdata(fullHtml)}]]></content:encoded>`,
                '</item>'
            ].join('');
        }).join('');
        const siteDesc = (site as any)?.settings?.site_description || (site as any)?.settings?.description || '';
        body = `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>${escapeXml(site.name || resolveSiteBrandInfo(site).brandName)}</title><link>${escapeXml(siteUrl)}</link><description>${escapeXml(siteDesc)}</description><language>${escapeXml(feedLocale)}</language><lastBuildDate>${new Date().toUTCString()}</lastBuildDate><atom:link href="${escapeXml(feedUrl)}" rel="self" type="application/rss+xml" />${rssItems}</channel></rss>`;
    }

    try {
        await buildUpsertSiteRouteStatement(db, {
            siteId: site.id,
            path: feedPath,
            entityType: 'page',
            title: format === 'xml' ? 'RSS Feed' : 'JSON Feed',
            renderedHtml: body,
            statusCode: 200,
            isDirty: 0,
            changefreq: 'hourly',
            priority: 0.3
        }).run();
    } catch {}
    return body;
}

export async function rebuildSiteLlmTxtRoute(
    db: D1Database,
    site: Site,
    host: string,
    routePath: '/llm.txt' | '/llms.txt' = '/llm.txt'
): Promise<string> {
    const domain = resolveEffectiveDomain(site.primary_domain, host);
    const siteDefaultLocale = site.default_locale || 'zh-CN';
    const nowIso = new Date().toISOString();
    const [pagesRes, articlesRes] = await db.batch([
        db.prepare(`
            SELECT id, slug, parent_id, locale, visibility, title, summary, metadata
            FROM pages
            WHERE site_id = ? AND status = 'published' AND (visibility = 'public' OR visibility IS NULL) AND (published_at IS NULL OR REPLACE(published_at, ' ', 'T') <= ?) AND deleted_at IS NULL
            ORDER BY updated_at DESC
            LIMIT 50
        `).bind(site.id, nowIso),
        db.prepare(`
            SELECT slug, locale, visibility, title, summary, metadata
            FROM articles
            WHERE site_id = ? AND status = 'published' AND (visibility = 'public' OR visibility IS NULL) AND (published_at IS NULL OR REPLACE(published_at, ' ', 'T') <= ?) AND deleted_at IS NULL
            ORDER BY COALESCE(published_at, updated_at) DESC
            LIMIT 50
        `).bind(site.id, nowIso)
    ]);

    const pages = ((pagesRes?.results || []) as Array<{ id: string; slug: string; parent_id?: string | null; locale?: string | null; visibility?: string | null; title: string; summary?: string; metadata?: string }>)
        .filter((p) => {
            const pMeta = parseJson<Record<string, any>>(p.metadata, {});
            const pType = pMeta.page_type;
            return pType !== 'template' && pType !== 'redirect' && !isRestrictedAccess(p.visibility, pMeta);
        });
    const articles = ((articlesRes?.results || []) as Array<{ slug: string; locale?: string | null; visibility?: string | null; title: string; summary?: string; metadata?: string }>)
        .filter((a) => !isRestrictedAccess(a.visibility, a.metadata));
    const siteDesc = (site as any)?.settings?.site_description || (site as any)?.settings?.description || '';

    const lines: string[] = [`# ${site.name || resolveSiteBrandInfo(site).brandName}`];
    if (siteDesc) lines.push('', `> ${String(siteDesc).replace(/\r?\n/g, ' ').trim()}`);

    const formatEntry = (slug: string, title: string, summary?: string, itemLocale?: string | null, parentSlug?: string | null) => {
        const bareNorm = normalizeRoutePath(slug, parentSlug);
        const localized = buildLocalizedRoutePath(bareNorm, itemLocale || siteDefaultLocale, siteDefaultLocale);
        const url = buildAbsoluteUrl(localized, domain);
        const cleanSummary = String(summary || '').replace(/\r?\n/g, ' ').trim();
        return cleanSummary ? `- [${title || bareNorm || 'Home'}](${url}): ${cleanSummary}` : `- [${title || bareNorm || 'Home'}](${url})`;
    };

    if (pages.length > 0) {
        const resolveParent = await loadPublishedPageParentResolver(db, site.id, pages.some(p => Boolean(p.parent_id)));
        const pageLines = pages.map((p) => {
            const parentPath = p.parent_id ? resolveParent(p.parent_id) : null;
            return formatEntry(p.slug, p.title, p.summary, p.locale, parentPath);
        });
        lines.push('', '## Pages', ...pageLines);
    }
    if (articles.length > 0) {
        lines.push('', '## Articles', ...articles.map((a) => formatEntry(a.slug, a.title, a.summary, a.locale)));
    }
    lines.push(
        '',
        '## Feeds & Sitemap',
        `- [RSS Feed](${buildAbsoluteUrl('/rss.xml', domain)})`,
        `- [JSON Feed](${buildAbsoluteUrl('/feed.json', domain)})`,
        `- [Sitemap](${buildAbsoluteUrl('/sitemap.xml', domain)})`
    );

    const body = lines.join('\n') + '\n';
    try {
        await buildUpsertSiteRouteStatement(db, {
            siteId: site.id,
            path: routePath,
            entityType: 'page',
            title: 'LLM Site Index',
            renderedHtml: body,
            statusCode: 200,
            isDirty: 0,
            changefreq: 'daily',
            priority: 0.3
        }).run();
    } catch {}
    return body;
}
