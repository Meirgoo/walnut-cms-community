import type { Context } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { fetchAsset, setGlobalLocaleResolver } from '../render';
import { isSecureContext } from './url';

export type AdminTranslationDict = Record<string, any>;

// Loaded dynamically from env.ASSETS to keep locale dictionaries out of the Worker JS bundle.
export const ADMIN_LOCALES: Record<string, AdminTranslationDict> = {
    'zh-CN': {},
    'en-US': {},
};

export const SUPPORTED_LOCALES: Record<string, string> = {
    'zh-CN': '🇨🇳 简体中文',
    'en-US': '🇺🇸 English'
};

export function renderLocaleOptions(selectedLocale: string): string {
    return Object.entries(SUPPORTED_LOCALES)
        .map(([val, label]) => `<option value="${val}" ${val === selectedLocale ? 'selected' : ''}>${label}</option>`)
        .join('');
}

export const ADMIN_LOCALE_COOKIE = 'walnut_admin_locale';

export async function loadAdminLocales(env?: any): Promise<void> {
    const targetEnv = env || (typeof globalThis !== 'undefined' && (globalThis as any).__CF_ENV__);
    for (const lang of ['zh-CN', 'en-US'] as const) {
        if (!ADMIN_LOCALES[lang] || Object.keys(ADMIN_LOCALES[lang]).length === 0) {
            const raw = await fetchAsset(`/locales/${lang}.json`, targetEnv);
            if (raw) {
                try {
                    ADMIN_LOCALES[lang] = JSON.parse(raw);
                } catch (e) {
                    console.warn(`[loadAdminLocales] Failed to parse ${lang}.json:`, e);
                }
            }
        }
    }
}

export function getAdminLocale(c: Context): string {
    const cookieLocale = getCookie(c, ADMIN_LOCALE_COOKIE);
    if (cookieLocale && (cookieLocale === 'zh-CN' || cookieLocale === 'en-US' || ADMIN_LOCALES[cookieLocale])) {
        return cookieLocale;
    }
    return 'zh-CN';
}

export function setAdminLocaleCookie(c: Context, locale: string): void {
    const isHttps = isSecureContext(c);
    setCookie(c, ADMIN_LOCALE_COOKIE, locale, {
        path: '/',
        secure: isHttps,
        sameSite: 'Lax',
        maxAge: 60 * 60 * 24 * 7,
    });
}

function ensureNodeSyncFallback(locale: string) {
    const proc = typeof globalThis !== 'undefined' ? (globalThis as any).process : undefined;
    if (proc && proc.versions?.node) {
        try {
            const fs = (globalThis as any).require ? (globalThis as any).require('fs') : undefined;
            const path = (globalThis as any).require ? (globalThis as any).require('path') : undefined;
            if (fs && path) {
                const targetLocale = locale || 'zh-CN';
                if (!ADMIN_LOCALES[targetLocale] || Object.keys(ADMIN_LOCALES[targetLocale]).length === 0) {
                    const filePath = path.resolve(proc.cwd(), `public/locales/${targetLocale}.json`);
                    if (fs.existsSync(filePath)) {
                        ADMIN_LOCALES[targetLocale] = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
                    }
                }
            }
        } catch {}
    }
}

export function t(locale: string, path: string, params?: Record<string, any>): string {
    if (!ADMIN_LOCALES['zh-CN'] || Object.keys(ADMIN_LOCALES['zh-CN']).length === 0) {
        ensureNodeSyncFallback('zh-CN');
    }
    if (locale && (!ADMIN_LOCALES[locale] || Object.keys(ADMIN_LOCALES[locale]).length === 0)) {
        ensureNodeSyncFallback(locale);
    }

    const dict = ADMIN_LOCALES[locale] || ADMIN_LOCALES['zh-CN'] || {};
    const parts = path.split('.');
    let current: any = dict;

    for (const part of parts) {
        if (current && typeof current === 'object' && part in current) {
            current = current[part];
        } else {
            let fallback: any = ADMIN_LOCALES['zh-CN'] || {};
            for (const fPart of parts) {
                if (fallback && typeof fallback === 'object' && fPart in fallback) {
                    fallback = fallback[fPart];
                } else {
                    return path;
                }
            }
            current = fallback;
            break;
        }
    }

    if (typeof current !== 'string') {
        return path;
    }

    if (params) {
        return current.replace(/\{(\w+)\}/g, (_, key) => {
            return params[key] !== undefined ? String(params[key]) : `{${key}}`;
        });
    }

    return current;
}

export function getAdminI18nSlice(locale: string = 'zh-CN', sectionOrSections?: string | string[]): Record<string, any> {
    if (!ADMIN_LOCALES['zh-CN'] || Object.keys(ADMIN_LOCALES['zh-CN']).length === 0) {
        ensureNodeSyncFallback('zh-CN');
    }
    if (locale && (!ADMIN_LOCALES[locale] || Object.keys(ADMIN_LOCALES[locale]).length === 0)) {
        ensureNodeSyncFallback(locale);
    }

    const dict = ADMIN_LOCALES[locale] || ADMIN_LOCALES['zh-CN'] || {};
    const sanitizeDictObj = (obj: Record<string, any>): Record<string, any> => {
        const out: Record<string, any> = {};
        for (const [k, v] of Object.entries(obj)) {
            if (typeof v === 'string' && k !== 'preview_prompt' && (v.includes('<') || v.includes('>') || v.includes('"'))) {
                out[k] = v
                    .replace(/&(?!(?:amp|lt|gt|quot|#39);)/g, '&amp;')
                    .replace(/</g, '&lt;')
                    .replace(/>/g, '&gt;')
                    .replace(/"/g, '&quot;');
            } else {
                out[k] = v;
            }
        }
        return out;
    };

    const common = sanitizeDictObj(dict.common || {});
    const nav = sanitizeDictObj(dict.nav || {});

    const slice: Record<string, any> = {
        locale,
        common,
        nav,
        ...common,
        ...nav,
    };

    const sections = Array.isArray(sectionOrSections)
        ? sectionOrSections
        : (sectionOrSections ? [sectionOrSections] : []);

    const namespaceDicts: Record<string, Record<string, any>> = {
        common,
        nav
    };

    for (const sec of sections) {
        const rawSecDict = dict[sec];
        if (rawSecDict && typeof rawSecDict === 'object') {
            const secDict = sanitizeDictObj(rawSecDict);
            namespaceDicts[sec] = secDict;
            for (const [k, v] of Object.entries(secDict)) {
                slice[`${sec}_${k}`] = v;
                // Avoid flattening keys that match top-level namespace names (e.g. nav.pages overwriting pages).
                if (!(k in dict)) {
                    slice[k] = v;
                }
            }
        }
    }

    // Re-bind namespace objects last so flattened string keys cannot overwrite them.
    for (const [sec, sDict] of Object.entries(namespaceDicts)) {
        slice[sec] = sDict;
    }

    slice.t = (path: string, params?: Record<string, any>) => t(locale, path, params);
    slice.format = (str: string, params: Record<string, any>) => {
        return (str || '').replace(/\{(\w+)\}/g, (_, k) => params[k] !== undefined ? String(params[k]) : `{${k}}`);
    };

    return slice;
}

// Omit SSR-only namespaces (like nav) to keep the client HTML payload small.
export function getClientJsI18nSlice(
    locale: string = 'zh-CN',
    extraSections: string[] = []
): Record<string, any> {
    if (!ADMIN_LOCALES['zh-CN'] || Object.keys(ADMIN_LOCALES['zh-CN']).length === 0) {
        ensureNodeSyncFallback('zh-CN');
    }
    if (locale && (!ADMIN_LOCALES[locale] || Object.keys(ADMIN_LOCALES[locale]).length === 0)) {
        ensureNodeSyncFallback(locale);
    }
    const dict = ADMIN_LOCALES[locale] || ADMIN_LOCALES['zh-CN'] || {};
    const clientDict: Record<string, any> = {
        common: dict.common || {},
        preview: dict.preview || {},
        quick_actions: dict.quick_actions || {}
    };
    if (dict.settings?.theme_switched_toast) {
        clientDict.settings = { theme_switched_toast: dict.settings.theme_switched_toast };
    }
    for (const sec of extraSections) {
        if (sec && sec !== 'nav' && dict[sec] && typeof dict[sec] === 'object') {
            clientDict[sec] = dict[sec];
        }
    }
    return clientDict;
}

// Inline JSON script avoids extra network round-trips and prevents FOUC.
export function getInlineI18nScript(
    locale = 'zh-CN',
    clientSlice?: Record<string, any>,
    brandReplacement?: string
): string {
    const full = ADMIN_LOCALES[locale] || ADMIN_LOCALES['zh-CN'] || {};
    const base: Record<string, any> = { common: full.common || {} };
    if (clientSlice) {
        for (const [k, v] of Object.entries(clientSlice)) {
            if (v && typeof v === 'object' && !Array.isArray(v) && k !== 'nav' && k !== 't' && k !== 'format') {
                base[k] = v;
            }
        }
    }
    let json = JSON.stringify(base).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/\//g, '\\u002f');
    if (brandReplacement) json = json.replace(/Walnut CMS|Walnut/g, brandReplacement);
    return `<script id="walnut-i18n-dict" type="application/json">${json}</script>`;
}

setGlobalLocaleResolver((loc: string, key: string) => {
    if (key.includes('.')) {
        const val = t(loc, key);
        return val !== key ? val : undefined;
    }
    const dict = ADMIN_LOCALES[loc] || ADMIN_LOCALES['zh-CN'] || {};
    return dict[key] ?? dict.common?.[key] ?? dict.nav?.[key];
});

export interface TimezoneOption {
    value: string;
    labelZh: string;
    labelEn: string;
}

export const SUPPORTED_TIMEZONES: TimezoneOption[] = ([
    ['Asia/Shanghai', '🇨🇳 (UTC+8) 北京 / 上海', '🇨🇳 (UTC+8) Beijing / Shanghai'],
    ['Asia/Hong_Kong', '🇭🇰 (UTC+8) 香港', '🇭🇰 (UTC+8) Hong Kong'],
    ['Asia/Taipei', '🇹🇼 (UTC+8) 台北', '🇹🇼 (UTC+8) Taipei'],
    ['Asia/Singapore', '🇸🇬 (UTC+8) 新加坡', '🇸🇬 (UTC+8) Singapore'],
    ['Asia/Tokyo', '🇯🇵 (UTC+9) 东京', '🇯🇵 (UTC+9) Tokyo'],
    ['UTC', '🌐 (UTC+0) 协调世界时 UTC', '🌐 (UTC+0) Coordinated Universal Time'],
    ['Europe/London', '🇬🇧 (UTC+0/+1) 伦敦', '🇬🇧 (UTC+0/+1) London'],
    ['Europe/Paris', '🇫🇷 (UTC+1/+2) 巴黎 / 柏林', '🇫🇷 (UTC+1/+2) Paris / Berlin'],
    ['America/New_York', '🇺🇸 (UTC-5/-4) 纽约 (美东)', '🇺🇸 (UTC-5/-4) New York (EDT/EST)'],
    ['America/Chicago', '🇺🇸 (UTC-6/-5) 芝加哥 (美中)', '🇺🇸 (UTC-6/-5) Chicago (CDT/CST)'],
    ['America/Los_Angeles', '🇺🇸 (UTC-8/-7) 洛杉矶 (美西)', '🇺🇸 (UTC-8/-7) Los Angeles (PDT/PST)'],
    ['Australia/Sydney', '🇦🇺 (UTC+10/+11) 悉尼', '🇦🇺 (UTC+10/+11) Sydney']
] as const).map(([value, labelZh, labelEn]) => ({ value, labelZh, labelEn }));

export function getSiteTimezone(site?: any | null): string {
    if (!site) return 'Asia/Shanghai';
    let settings = site.settings;
    if (typeof settings === 'string') {
        try {
            settings = JSON.parse(settings);
        } catch {
            settings = {};
        }
    }
    return (settings && settings.timezone) || 'Asia/Shanghai';
}

export function getUserTimezone(user?: any | null, site?: any | null): string {
    if (user) {
        let meta = user.metadata;
        if (typeof meta === 'string') {
            try {
                meta = JSON.parse(meta);
            } catch {
                meta = {};
            }
        }
        if (meta && typeof meta === 'object' && meta.timezone) {
            return String(meta.timezone);
        }
    }
    return getSiteTimezone(site);
}

export function formatTimezoneOffsetLabel(timeZone = 'Asia/Shanghai'): string {
    try {
        const now = new Date();
        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone,
            timeZoneName: 'shortOffset'
        }).formatToParts(now);
        const tzPart = parts.find(p => p.type === 'timeZoneName')?.value || '';
        if (tzPart.startsWith('GMT')) {
            const offset = tzPart.slice(3);
            return offset ? `UTC${offset}` : 'UTC+0';
        }
        return tzPart || 'UTC+8';
    } catch {
        return 'UTC+8';
    }
}

// SQLite CURRENT_TIMESTAMP emits naive UTC strings; append 'Z' when no timezone offset is present.
export function parseUtcDate(dateStrOrNum?: string | number | Date | null): Date | null {
    if (!dateStrOrNum) return null;
    if (dateStrOrNum instanceof Date) return isNaN(dateStrOrNum.getTime()) ? null : dateStrOrNum;
    if (typeof dateStrOrNum === 'number') {
        const d = new Date(dateStrOrNum);
        return isNaN(d.getTime()) ? null : d;
    }
    const raw = String(dateStrOrNum).trim();
    if (!raw) return null;
    if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(?:\.\d+)?)?$/.test(raw)) {
        const d = new Date(raw.replace(' ', 'T') + 'Z');
        if (!isNaN(d.getTime())) return d;
    }
    const d = new Date(raw);
    return isNaN(d.getTime()) ? null : d;
}

export function formatSiteDateTime(
    dateStrOrNum?: string | number | Date | null,
    locale = 'zh-CN',
    timeZone = 'Asia/Shanghai'
): string {
    if (!dateStrOrNum) return '';
    try {
        const d = parseUtcDate(dateStrOrNum);
        if (!d) return String(dateStrOrNum);
        return new Intl.DateTimeFormat(locale, {
            timeZone: timeZone || 'Asia/Shanghai',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false
        }).format(d);
    } catch {
        const d = parseUtcDate(dateStrOrNum);
        return d ? d.toLocaleString(locale) : String(dateStrOrNum);
    }
}

