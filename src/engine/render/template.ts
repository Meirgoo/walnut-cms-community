import { formatSafeLocaleDate, buildLocalizedRoutePath } from '../core/i18n';

let globalLocaleResolver: ((locale: string, key: string) => any) | null = null;
export function setGlobalLocaleResolver(fn: ((locale: string, key: string) => any) | null): void {
    globalLocaleResolver = fn;
}

export function sweepTemplateVariables(html: string): string {
    if (!html || typeof html !== 'string') return '';
    return html.replace(/\{\{\{?[#/]?[\w@.-]+(?:\s+[\w@.-]+)?\}?\}\}/g, '');
}

function resolvePath(obj: Record<string, any>, path: string): any {
    if (!obj) return undefined;
    if (path in obj) return obj[path];
    const parts = path.split('.');
    if (parts.length > 1) {
        let curr: any = obj;
        for (const part of parts) {
            if (curr && typeof curr === 'object' && part in curr) {
                curr = curr[part];
            } else {
                return undefined;
            }
        }
        return curr;
    }
    for (const sub of Object.values(obj)) {
        if (sub && typeof sub === 'object' && !Array.isArray(sub) && path in sub) {
            return sub[path];
        }
    }
    return undefined;
}

function expandLoopItemScope(parentValues: Record<string, any>, item: any, idx: number): Record<string, any> {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
        let metaObj: Record<string, any> = {};
        if (typeof item.metadata === 'string') {
            try { metaObj = JSON.parse(item.metadata) || {}; } catch {}
        } else if (item.metadata && typeof item.metadata === 'object') {
            metaObj = item.metadata;
        }
        const fieldsObj = (metaObj.fields && typeof metaObj.fields === 'object') ? metaObj.fields : {};
        const itemSlug = String(item.slug || '');
        const siteDefaultLocale = String(parentValues.site?.default_locale || parentValues.default_locale || 'zh-CN');
        const targetLocale = String(item.locale || parentValues.locale || parentValues.page?.locale || siteDefaultLocale);
        const itemUrl = item.url !== undefined
            ? item.url
            : (item.href !== undefined
                ? item.href
                : (item.type === 'micro' || item.kind === 'micro' ? '' : (itemSlug ? (itemSlug.startsWith('/') ? itemSlug : buildLocalizedRoutePath(itemSlug, targetLocale, siteDefaultLocale)) : '')));
        const itemText = item.text || item.label || item.title || item.name || itemSlug || '';
        const itemLocale = String(parentValues.locale || 'zh-CN');
        const publishedDate = item.published_date || (item.published_at ? formatSafeLocaleDate(item.published_at, itemLocale) : '');
        const rawProg = item.progress !== undefined ? item.progress : (metaObj.progress !== undefined ? metaObj.progress : (item.maturity || metaObj.maturity || ''));
        const itemProgress = (rawProg && rawProg !== 'none') ? String(rawProg).trim() : '';
        const itemFolder = item.folder || metaObj.folder || fieldsObj.folder || '';
        const resolvedTitle = item.title !== undefined ? item.title : (item.text || item.label || item.name || '');
        return {
            ...parentValues,
            ...metaObj,
            ...fieldsObj,
            ...item,
            url: itemUrl,
            href: itemUrl,
            text: itemText,
            label: item.label || itemText,
            title: resolvedTitle,
            description: item.description || item.summary || '',
            summary: item.summary || item.description || '',
            published_date: publishedDate,
            maturity: item.maturity || metaObj.maturity || 'none',
            progress: itemProgress,
            folder: itemFolder,
            this: { ...metaObj, ...fieldsObj, ...item, url: itemUrl, text: itemText, progress: itemProgress, folder: itemFolder },
            '@index': idx,
            index: idx
        };
    }
    return {
        ...parentValues,
        this: item,
        '@index': idx,
        index: idx
    };
}

function renderBalancedIf(
    tpl: string,
    values: Record<string, any>,
    sweep: boolean,
    i18nSlice?: Record<string, any>
): string {
    const openTag = '{{#if ';
    let startIndex = tpl.indexOf(openTag);
    if (startIndex === -1) return tpl;

    let result = '';
    let curr = 0;

    while (curr < tpl.length) {
        startIndex = tpl.indexOf(openTag, curr);
        if (startIndex === -1) {
            result += tpl.slice(curr);
            break;
        }

        result += tpl.slice(curr, startIndex);

        const tagClose = tpl.indexOf('}}', startIndex);
        if (tagClose === -1) {
            result += tpl.slice(startIndex);
            break;
        }

        const condKey = tpl.slice(startIndex + openTag.length, tagClose).trim();
        let depth = 1;
        let scan = tagClose + 2;
        let elseIndex = -1;

        while (scan < tpl.length && depth > 0) {
            const nextOpen = tpl.indexOf('{{#if ', scan);
            const nextClose = tpl.indexOf('{{/if}}', scan);
            const nextElse = tpl.indexOf('{{else}}', scan);

            let nextEvent = -1;
            let eventType: 'open' | 'close' | 'else' = 'close';

            if (nextClose !== -1) {
                nextEvent = nextClose;
                eventType = 'close';
            }
            if (nextOpen !== -1 && (nextEvent === -1 || nextOpen < nextEvent)) {
                nextEvent = nextOpen;
                eventType = 'open';
            }
            if (nextElse !== -1 && depth === 1 && (nextEvent === -1 || nextElse < nextEvent)) {
                nextEvent = nextElse;
                eventType = 'else';
            }

            if (nextEvent === -1) break;

            if (eventType === 'open') {
                depth++;
                scan = nextOpen + 6;
            } else if (eventType === 'close') {
                depth--;
                if (depth === 0) {
                    const condVal = resolvePath(values, condKey);
                    const isTruthy = Array.isArray(condVal)
                        ? condVal.length > 0
                        : Boolean(condVal !== undefined && condVal !== null && condVal !== '' && condVal !== false && condVal !== 'false' && condVal !== '0');

                    if (elseIndex !== -1) {
                        const thenPart = tpl.slice(tagClose + 2, elseIndex);
                        const elsePart = tpl.slice(elseIndex + 8, nextEvent);
                        result += isTruthy
                            ? renderTemplate(thenPart, values, sweep, i18nSlice)
                            : renderTemplate(elsePart, values, sweep, i18nSlice);
                    } else {
                        const innerBody = tpl.slice(tagClose + 2, nextEvent);
                        result += isTruthy ? renderTemplate(innerBody, values, sweep, i18nSlice) : '';
                    }

                    curr = nextEvent + 7;
                    break;
                }
                scan = nextClose + 7;
            } else if (eventType === 'else') {
                elseIndex = nextElse;
                scan = nextElse + 8;
            }
        }

        if (depth > 0) {
            result += tpl.slice(startIndex);
            break;
        }
    }

    return result;
}

export function renderTemplate(
    tpl: string,
    values: Record<string, any> = {},
    sweepOrSlice: boolean | Record<string, any> = true,
    maybeSlice?: Record<string, any>
): string {
    if (!tpl || typeof tpl !== 'string') return '';

    let sweep = true;
    let i18nSlice: Record<string, any> | undefined = undefined;

    if (typeof sweepOrSlice === 'boolean') {
        sweep = sweepOrSlice;
        i18nSlice = maybeSlice || values._i18n || values.i18nSlice || values.__i18n;
    } else if (typeof sweepOrSlice === 'object' && sweepOrSlice !== null) {
        sweep = true;
        i18nSlice = sweepOrSlice;
    } else {
        i18nSlice = maybeSlice || values._i18n || values.i18nSlice || values.__i18n;
    }

    let processedTpl = tpl;
    if (processedTpl.includes('{{#each ')) {
        processedTpl = processedTpl.replace(/\{\{#each\s+([\w.-]+)\}\}([\s\S]*?)\{\{\/each\}\}/g, (_match, listKey, innerBody) => {
            let rawList = resolvePath(values, listKey);
            if (typeof rawList === 'string' && rawList.trim().startsWith('[')) {
                try { rawList = JSON.parse(rawList); } catch {}
            }
            if (!Array.isArray(rawList) || rawList.length === 0) {
                return '';
            }
            return rawList.map((item, idx) => {
                const itemScope = expandLoopItemScope(values, item, idx);
                return renderTemplate(innerBody, itemScope, sweep, i18nSlice);
            }).join('\n');
        });
    }

    if (processedTpl.includes('{{#if ')) {
        processedTpl = renderBalancedIf(processedTpl, values, sweep, i18nSlice);
    }

    processedTpl = processedTpl.replace(/\{\{\{([\w@.-]+)\}\}\}/g, (match, key) => {
        let val = resolvePath(values, key);
        if (val === undefined || val === null) {
            return sweep ? '' : match;
        }
        return typeof val === 'object' ? '' : String(val);
    });

    const escapeI18nHtml = (str: string) => str
        .replace(/&(?!(?:amp|lt|gt|quot|#39);)/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');

    let result = processedTpl.replace(/\{\{([\w@.-]+)\}\}/g, (match, key) => {
        let val = resolvePath(values, key);
        let fromI18n = false;
        if (val === undefined || val === null) {
            if (i18nSlice && typeof i18nSlice === 'object') {
                val = resolvePath(i18nSlice, key);
                if (val === undefined || val === null) {
                    for (const ns of Object.keys(i18nSlice)) {
                        const sub = i18nSlice[ns];
                        if (sub && typeof sub === 'object' && key in sub) {
                            val = sub[key];
                            break;
                        }
                    }
                }
                if (val !== undefined && val !== null) {
                    fromI18n = true;
                }
            }
        } else if (i18nSlice && typeof i18nSlice === 'object' && key in i18nSlice && val === i18nSlice[key]) {
            fromI18n = true;
        }

        if ((val === undefined || val === null) && globalLocaleResolver) {
            const loc = String(values.locale || (i18nSlice && i18nSlice.locale) || 'zh-CN');
            val = globalLocaleResolver(loc, key);
            if (val !== undefined && val !== null) {
                fromI18n = true;
            }
        }

        if (val !== undefined && val !== null) {
            if (typeof val === 'object') {
                return '';
            }
            const strVal = String(val);
            if (fromI18n && !key.endsWith('preview_prompt')) {
                return escapeI18nHtml(strVal);
            }
            return strVal;
        }
        return sweep ? '' : match;
    });

    if (sweep) {
        result = sweepTemplateVariables(result);
    }

    return result;
}

// Read static assets via env.ASSETS (with local fs fallback) to keep them out of the Worker JS bundle.
const assetCache = new Map<string, string>();

export async function fetchAsset(assetPath: string, env?: any): Promise<string> {
    const cleanPath = assetPath.startsWith('/') ? assetPath : `/${assetPath}`;
    if (assetCache.has(cleanPath)) {
        return assetCache.get(cleanPath)!;
    }

    let content = '';
    const isThemePath = cleanPath.startsWith('/theme/');

    if (isThemePath) {
        const bucket = env?.BUCKET || (typeof globalThis !== 'undefined' && (globalThis as any).__CF_ENV__?.BUCKET);
        if (bucket && typeof bucket.get === 'function') {
            try {
                const obj = await bucket.get(cleanPath.slice(1));
                if (obj) content = await obj.text();
            } catch (e) {
                console.warn(`[fetchAsset] R2 bucket read failed for ${cleanPath}:`, e);
            }
        }
    } else {
        const assets = env?.ASSETS || (typeof globalThis !== 'undefined' && (globalThis as any).__CF_ENV__?.ASSETS);
        if (assets && typeof assets.fetch === 'function') {
            try {
                const assetUrl = new URL(cleanPath, 'https://walnut-assets.local');
                const res = await assets.fetch(new Request(assetUrl.toString()));
                if (res.ok) {
                    content = await res.text();
                }
            } catch (e) {
                console.warn(`[fetchAsset] Worker env.ASSETS fetch failed for ${cleanPath}:`, e);
            }
        }
    }

    const proc = (globalThis as unknown as { process?: { cwd?: () => string } }).process;
    if (!content && typeof proc?.cwd === 'function') {
        try {
            // @ts-ignore
            const fs = await import('node:fs');
            // @ts-ignore
            const path = await import('node:path');
            const localFile = isThemePath
                ? path.join(proc.cwd(), 'themes', cleanPath.slice('/theme/'.length))
                : path.join(proc.cwd(), 'public', cleanPath);
            if (fs.existsSync(localFile)) {
                content = fs.readFileSync(localFile, 'utf8');
            }
        } catch (_) {}
    }

    if (content) {
        assetCache.set(cleanPath, content);
    }

    return content;
}
