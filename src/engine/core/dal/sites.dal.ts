import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import type { Site } from '../../types';
import { invalidateQueryCache } from './index';
import { isLocalHost, sanitizeHostHeader, normalizeHostKey } from '../url';
import { parseJson } from '../utils';

const siteMemoryCache = new Map<string, { site: Site; expiresAt: number }>();
let cachedOemSeal: Record<string, any> | null = null;
let cachedOemSealExpiresAt = 0;

export function peekLicenseOemFromKey(licenseKey?: string | null): {
    mode?: 'customizable' | 'enforced';
    require_key_to_modify?: boolean;
    hide_license_detail?: boolean;
    whitelabel?: Record<string, any>;
} | null {
    if (!licenseKey || typeof licenseKey !== 'string') return null;
    const parts = licenseKey.trim().split('.');
    const rawB64 = (parts.length === 4 && parts[0] === 'WLT')
        ? parts[2]
        : (parts.length === 2 ? parts[0] : null);
    if (!rawB64) return null;
    try {
        const b64 = rawB64.replace(/-/g, '+').replace(/_/g, '/');
        const pad = b64.length % 4;
        const padded = pad ? b64 + '='.repeat(4 - pad) : b64;
        const binaryStr = atob(padded);
        const bytes = new Uint8Array(binaryStr.length);
        for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
        const jsonStr = new TextDecoder().decode(bytes);
        const parsed = JSON.parse(jsonStr);
        if (parsed && parsed.oem && typeof parsed.oem === 'object') {
            return parsed.oem;
        }
    } catch {}
    return null;
}

export interface ResolvedSiteBrandInfo {
    brandName: string;
    systemTitle: string;
    providerName: string;
    copyrightText: string;
    logoUrl: string;
    faviconUrl: string;
    supportUrl: string;
    hidePoweredBy: boolean;
    customPoweredBy: string;
    poweredByBrand: string;
    oemMode?: 'customizable' | 'enforced';
    hideLicenseDetail: boolean;
    requireKeyToModify: boolean;
    hasStickyWhitelabel: boolean;
    effectiveWhitelabel: Record<string, any>;
}

export function resolveSiteBrandInfo(
    site?: Site | null,
    oemSealInput?: string | Record<string, any> | null
): ResolvedSiteBrandInfo {
    const settings: Record<string, any> = site?.settings
        ? (typeof site.settings === 'string' ? parseJson(site.settings, {}) : site.settings)
        : {};
    const licenseKey = (site as any)?.license_key || settings.license_key || '';
    const peekOem = peekLicenseOemFromKey(licenseKey);
    const peekWl = (peekOem?.whitelabel && typeof peekOem.whitelabel === 'object') ? peekOem.whitelabel : null;

    let sealWl: Record<string, any> | null = null;
    const rawSeal = oemSealInput ?? (site as any)?.__oem_seal ?? cachedOemSeal;
    if (rawSeal) {
        sealWl = typeof rawSeal === 'string' ? parseJson(rawSeal, null) : rawSeal;
    }

    const dbWl = (settings.whitelabel && typeof settings.whitelabel === 'object') ? settings.whitelabel : null;

    const effectiveWhitelabel: Record<string, any> = {};
    const layers = peekOem?.mode === 'enforced'
        ? [dbWl, sealWl, peekWl]
        : [sealWl, peekWl, dbWl];

    for (const layer of layers) {
        if (!layer || typeof layer !== 'object') continue;
        for (const [k, v] of Object.entries(layer)) {
            if (v !== undefined && v !== null && v !== '') {
                effectiveWhitelabel[k] = v;
            }
        }
    }

    const siteName = site?.name || settings.site_name || '';
    const wlBrand = effectiveWhitelabel.brand_name || effectiveWhitelabel.system_title || effectiveWhitelabel.provider_name || '';
    const hasStickyWhitelabel = Boolean(wlBrand || effectiveWhitelabel.logo_url || effectiveWhitelabel.copyright_text || effectiveWhitelabel.copyright);

    const brandName = wlBrand || siteName || 'Content Management System';
    const systemTitle = effectiveWhitelabel.system_title || effectiveWhitelabel.brand_name || (siteName ? `${siteName} Admin` : 'Content Management System');
    const providerName = effectiveWhitelabel.provider_name || effectiveWhitelabel.brand_name || effectiveWhitelabel.system_title || siteName || 'Content Management System';
    const copyrightText = effectiveWhitelabel.copyright_text || effectiveWhitelabel.copyright || settings.copyright || `Copyright ${new Date().getFullYear()} ${brandName}`;
    const logoUrl = effectiveWhitelabel.logo_url || settings.logo_url || '';
    const faviconUrl = effectiveWhitelabel.favicon_url || settings.favicon_url || '/favicon.ico';
    const supportUrl = effectiveWhitelabel.support_url || '';
    const hidePoweredBy = Boolean(effectiveWhitelabel.hide_powered_by || effectiveWhitelabel.remove_powered_by);
    const customPoweredBy = effectiveWhitelabel.custom_powered_by || '';
    const poweredByBrand = wlBrand;

    return {
        brandName,
        systemTitle,
        providerName,
        copyrightText,
        logoUrl,
        faviconUrl,
        supportUrl,
        hidePoweredBy,
        customPoweredBy,
        poweredByBrand,
        oemMode: peekOem?.mode,
        hideLicenseDetail: Boolean(peekOem?.hide_license_detail),
        requireKeyToModify: Boolean(peekOem?.require_key_to_modify),
        hasStickyWhitelabel,
        effectiveWhitelabel
    };
}

async function loadOemSeal(db: D1Database): Promise<Record<string, any> | null> {
    const now = Date.now();
    if (cachedOemSealExpiresAt > now) return cachedOemSeal;
    try {
        const raw = await getSystemMetaValue(db, 'oem_seal');
        cachedOemSeal = raw ? parseJson(raw, null) : null;
        cachedOemSealExpiresAt = now + 60000;
        return cachedOemSeal;
    } catch {
        return null;
    }
}

export function invalidateSiteMemoryCache(siteIdOrDomain?: string): void {
    invalidateQueryCache(siteIdOrDomain);
    cachedOemSeal = null;
    cachedOemSealExpiresAt = 0;
    if (!siteIdOrDomain) {
        siteMemoryCache.clear();
        return;
    }
    for (const [key, entry] of siteMemoryCache.entries()) {
        if (key === siteIdOrDomain || entry.site.id === siteIdOrDomain || entry.site.primary_domain === siteIdOrDomain) {
            siteMemoryCache.delete(key);
        }
    }
}

export async function resolveSiteWithMemoryCache(db: D1Database, host: string): Promise<Site | null> {
    try {
        const now = Date.now();
        const cacheKey = normalizeHostKey(host) || host;
        const cached = siteMemoryCache.get(cacheKey);
        if (cached && cached.expiresAt > now) {
            return cached.site;
        }

        let site = await findSiteByPrimaryDomain(db, cacheKey);

        // Fall back to wildcard '*' or default site so zero-config single-site deployments resolve.
        if (!site) {
            site = await findWildcardOrDefaultSite(db);
        }

        if (site) {
            site.settings = parseJson(site.settings, {});
            const seal = await loadOemSeal(db);
            if (seal) (site as any).__oem_seal = seal;
            siteMemoryCache.set(cacheKey, { site, expiresAt: now + 60000 });
            if (site.primary_domain) {
                const normDomain = normalizeHostKey(site.primary_domain) || site.primary_domain;
                siteMemoryCache.set(normDomain, { site, expiresAt: now + 60000 });
            }
        }
        return site;
    } catch {
        return null;
    }
}

export async function findActiveSites(db: D1Database): Promise<Site[]> {
    try {
        const { results } = await db.prepare(
            `SELECT * FROM sites WHERE status = 'active' ORDER BY created_at ASC`
        ).all<Site>();
        const seal = await loadOemSeal(db);
        const list = results || [];
        if (seal) {
            for (const s of list) (s as any).__oem_seal = seal;
        }
        return list;
    } catch {
        return [];
    }
}

export async function findSiteById(db: D1Database, siteId: string): Promise<Site | null> {
    try {
        const site = await db.prepare(
            `SELECT * FROM sites WHERE id = ? LIMIT 1`
        ).bind(siteId).first<Site>();
        if (site) {
            const seal = await loadOemSeal(db);
            if (seal) (site as any).__oem_seal = seal;
        }
        return site;
    } catch {
        return null;
    }
}

export async function findSiteByPrimaryDomain(db: D1Database, domain: string): Promise<Site | null> {
    try {
        const norm = normalizeHostKey(domain) || domain.trim().toLowerCase();
        const bareHost = norm.includes(':') ? norm.split(':')[0] : norm;
        if (bareHost !== norm) {
            return await db.prepare(
                `SELECT * FROM sites WHERE status = 'active' AND LOWER(primary_domain) IN (?, ?) ORDER BY CASE WHEN LOWER(primary_domain) = ? THEN 0 ELSE 1 END LIMIT 1`
            ).bind(norm, bareHost, norm).first<Site>();
        }
        return await db.prepare(
            `SELECT * FROM sites WHERE LOWER(primary_domain) = ? AND status = 'active' LIMIT 1`
        ).bind(norm).first<Site>();
    } catch {
        return null;
    }
}

export async function findWildcardOrDefaultSite(db: D1Database): Promise<Site | null> {
    try {
        const found = await db.prepare(
            `SELECT * FROM sites WHERE status = 'active' AND (primary_domain IN ('*', 'localhost', 'localhost:8787') OR id = 'site_default') ORDER BY CASE WHEN primary_domain = '*' THEN 0 WHEN primary_domain = 'localhost' THEN 1 ELSE 2 END LIMIT 1`
        ).first<Site>();
        if (found) return found;

        const activeList = await findActiveSites(db);
        if (activeList.length === 1) {
            return activeList[0];
        }
        return null;
    } catch {
        return null;
    }
}

export async function autoClaimSiteDomainIfEligible(db: D1Database, site: Site, host: string): Promise<boolean> {
    try {
        const cleanHost = sanitizeHostHeader(host).split(':')[0].toLowerCase();
        if (!cleanHost || isLocalHost(cleanHost)) return false;
        if (cleanHost.endsWith('.workers.dev') || cleanHost.endsWith('.pages.dev')) return false;

        const currentDomain = (site.primary_domain || '').trim().toLowerCase().split(':')[0];
        const isEligiblePlaceholder = currentDomain === '*' || currentDomain === 'localhost' || isLocalHost(currentDomain);
        if (!isEligiblePlaceholder) return false;

        await db.prepare(
            `UPDATE sites SET primary_domain = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
        ).bind(cleanHost, site.id).run();

        site.primary_domain = cleanHost;
        invalidateSiteMemoryCache();
        return true;
    } catch {
        return false;
    }
}

export async function findFirstActiveSite(db: D1Database): Promise<Site | null> {
    try {
        return await db.prepare(
            `SELECT * FROM sites WHERE status = 'active' LIMIT 1`
        ).first<Site>();
    } catch {
        return null;
    }
}

export async function getSiteSettingsString(db: D1Database, siteId: string): Promise<string | null> {
    try {
        const res = await db.prepare(
            `SELECT settings FROM sites WHERE id = ?`
        ).bind(siteId).first<{ settings?: string }>();
        return res?.settings || null;
    } catch {
        return null;
    }
}

export async function findSiteSettings(db: D1Database, siteId: string): Promise<Record<string, any>> {
    const raw = await getSiteSettingsString(db, siteId);
    if (!raw) return {};
    try {
        return JSON.parse(raw);
    } catch {
        return {};
    }
}

export function buildCreateSiteStatement(
    db: D1Database,
    site: {
        id: string;
        name: string;
        primaryDomain: string;
        defaultLocale: string;
        settingsJson: string;
        createdAt?: string;
    }
): D1PreparedStatement {
    const nowIso = site.createdAt || new Date().toISOString();
    return db.prepare(`
        INSERT INTO sites (id, name, primary_domain, default_locale, settings, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
    `).bind(
        site.id,
        site.name,
        site.primaryDomain,
        site.defaultLocale,
        site.settingsJson,
        nowIso,
        nowIso
    );
}

export function buildUpdateSiteSettingsStatement(
    db: D1Database,
    params: {
        siteId: string;
        name: string;
        primaryDomain: string;
        defaultLocale: string;
        licenseKey?: string;
        settingsJson: string;
        robotsTxt?: string | null;
    }
): D1PreparedStatement {
    return db.prepare(`
        UPDATE sites 
        SET name = ?, primary_domain = ?, default_locale = ?,
            license_key = COALESCE(?, license_key),
            settings = ?, robots_txt = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
    `).bind(
        params.name,
        params.primaryDomain,
        params.defaultLocale,
        params.licenseKey !== undefined ? params.licenseKey : null,
        params.settingsJson,
        params.robotsTxt ?? null,
        params.siteId
    );
}

export function buildSwitchSiteThemeStatement(
    db: D1Database,
    siteId: string,
    themeId: string
): D1PreparedStatement {
    return db.prepare(`
        UPDATE sites 
        SET theme_id = ?, updated_at = CURRENT_TIMESTAMP 
        WHERE id = ?
    `).bind(themeId, siteId);
}

export function buildDeleteSiteStatement(
    db: D1Database,
    siteId: string
): D1PreparedStatement {
    return db.prepare(`DELETE FROM sites WHERE id = ?`).bind(siteId);
}

export async function countAllSites(db: D1Database): Promise<number> {
    const row = await db.prepare(`SELECT COUNT(*) as total FROM sites`).first<{ total: number }>();
    return Number(row?.total || 0);
}

export function buildCascadeDeleteSiteStatements(
    db: D1Database,
    siteId: string
): D1PreparedStatement[] {
    // Delete child version rows before parent tables and the root site row.
    return [
        db.prepare(`DELETE FROM entity_versions WHERE site_id = ?`).bind(siteId),
        db.prepare(`DELETE FROM site_routes WHERE site_id = ?`).bind(siteId),
        db.prepare(`DELETE FROM content_relations WHERE site_id = ?`).bind(siteId),
        db.prepare(`DELETE FROM site_members WHERE site_id = ?`).bind(siteId),
        db.prepare(`DELETE FROM media_assets WHERE site_id = ?`).bind(siteId),
        db.prepare(`DELETE FROM scheduled_tasks WHERE site_id = ?`).bind(siteId),
        db.prepare(`DELETE FROM webhooks WHERE site_id = ?`).bind(siteId),
        db.prepare(`DELETE FROM api_tokens WHERE site_id = ?`).bind(siteId),
        db.prepare(`DELETE FROM dataset_collections WHERE site_id = ?`).bind(siteId),
        db.prepare(`DELETE FROM datasets WHERE site_id = ?`).bind(siteId),
        db.prepare(`DELETE FROM themes WHERE site_id = ?`).bind(siteId),
        db.prepare(`DELETE FROM pages WHERE site_id = ?`).bind(siteId),
        db.prepare(`DELETE FROM micros WHERE site_id = ?`).bind(siteId),
        db.prepare(`DELETE FROM articles WHERE site_id = ?`).bind(siteId),
        buildDeleteSiteStatement(db, siteId)
    ];
}

export async function deleteOptionalSiteScopedRows(
    db: D1Database,
    siteId: string
): Promise<void> {
    // Commercial tables may not be provisioned in community databases.
    const optionalTables = ['audit_logs', 'traffic_metrics', 'webhook_logs', 'ip_blocklist'] as const;
    for (const table of optionalTables) {
        try {
            await db.prepare(`DELETE FROM ${table} WHERE site_id = ?`).bind(siteId).run();
        } catch {}
    }
}

export function buildUpdateSiteSettingsOnlyStatement(
    db: D1Database,
    siteId: string,
    settingsJson: string
): D1PreparedStatement {
    return db.prepare(`UPDATE sites SET settings = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(settingsJson, siteId);
}

export async function getSystemMetaValue(db: D1Database, key: string): Promise<string | null> {
    const row = await db.prepare('SELECT value FROM system_meta WHERE key = ? LIMIT 1').bind(key).first<{ value: string }>();
    return row?.value ?? null;
}

export async function setSystemMetaValue(db: D1Database, key: string, value: string): Promise<void> {
    await db.prepare('INSERT OR REPLACE INTO system_meta (key, value) VALUES (?, ?)').bind(key, value).run();
}

export interface CoreWebhookRow {
    id: string;
    site_id: string;
    name: string;
    url: string;
    events: string;
    secret?: string | null;
    is_active: number;
    created_at?: string;
}

export async function findWebhooksBySite(db: D1Database, siteId: string): Promise<CoreWebhookRow[]> {
    try {
        const { results } = await db.prepare(
            `SELECT id, site_id, name, url, events, secret, is_active, created_at FROM webhooks WHERE site_id = ? ORDER BY created_at DESC`
        ).bind(siteId).all<CoreWebhookRow>();
        return results || [];
    } catch {
        return [];
    }
}

export function buildUpsertWebhookStatement(
    db: D1Database,
    row: { id: string; siteId: string; name: string; url: string; eventsJson: string; secret?: string | null; isActive: number }
): D1PreparedStatement {
    return db.prepare(`
        INSERT INTO webhooks (id, site_id, name, url, events, secret, is_active)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            url = excluded.url,
            events = excluded.events,
            secret = excluded.secret,
            is_active = excluded.is_active
    `).bind(row.id, row.siteId, row.name, row.url, row.eventsJson, row.secret || null, row.isActive);
}

export function buildDeleteWebhookStatement(db: D1Database, siteId: string, id: string): D1PreparedStatement {
    return db.prepare(`DELETE FROM webhooks WHERE id = ? AND site_id = ?`).bind(id, siteId);
}
