import { DEFAULT_DEV_HOST, normalizeHostKey } from './url';

export function parseJson<T>(raw: unknown, fallback: T): T {
    if (raw === undefined || raw === null || raw === '') return fallback;
    if (typeof raw !== 'string') return raw as T;
    try {
        return JSON.parse(raw) as T;
    } catch {
        return fallback;
    }
}

export function getCookieValue(cookieHeader: string | undefined, name: string): string | null {
    if (!cookieHeader) return null;
    const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;\\s]+)`));
    return match && match[1] ? match[1] : null;
}

export function extractClientIp(c: { req: { header: (k: string) => string | undefined } }): string {
    const cfIp = c.req.header('cf-connecting-ip')?.trim();
    if (cfIp) return cfIp;
    const host = (c.req.header('host') || '').toLowerCase();
    // Ignore untrusted X-Forwarded-For so non-CF callers cannot spoof 127.0.0.1 to bypass rate limits.
    if (!c.req.header('x-forwarded-for') && (host.startsWith('localhost') || host.startsWith('127.0.0.1'))) {
        return '127.0.0.1';
    }
    return 'unverified';
}

export function isSiteAdminUser(user: any): boolean {
    return Boolean(user && (user.global_role === 'superadmin' || user.site_role === 'admin'));
}

export function escapeHtml(str: string): string {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export function escapeHtmlAttr(str: string): string {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\b(on[a-z]+)\s*=/gi, '$1&#61;');
}

export function isValidRedirectTarget(rawUrl: unknown): boolean {
    if (typeof rawUrl !== 'string') return false;
    const trimmed = rawUrl.replace(/[\x00-\x1f\x7f]+/g, '').trim();
    if (!trimmed) return false;
    if (trimmed.startsWith('//') || trimmed.startsWith('/\\')) return false;
    if (/^(?:javascript|vbscript|data|blob):/i.test(trimmed)) return false;
    return trimmed.startsWith('/') || /^https?:\/\//i.test(trimmed);
}

export function sanitizeRedirectTarget(rawUrl: unknown, fallback = '/'): string {
    if (typeof rawUrl !== 'string') return fallback;
    const trimmed = rawUrl.replace(/[\x00-\x1f\x7f]+/g, '').trim();
    return isValidRedirectTarget(trimmed) ? trimmed : fallback;
}

const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

export function sanitizeHexColor(raw: unknown): string {
    if (typeof raw !== 'string') return '';
    const trimmed = raw.trim();
    return HEX_COLOR_RE.test(trimmed) ? trimmed : '';
}

export function escapeXml(unsafe: string): string {
    if (!unsafe) return '';
    return String(unsafe)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

export function isPreviewRequest(c: { req: { query: (k: string) => string | undefined; header: (k: string) => string | undefined } }): boolean {
    const q = c.req.query('edge_preview');
    return Boolean(
        q === '1' ||
        q === 'true' ||
        c.req.query('preview') === '1' ||
        c.req.header('x-edge-preview') === '1' ||
        c.req.header('x-edge-preview') === '1' ||
        c.req.header('sec-fetch-dest') === 'iframe' ||
        (c.req.header('referer') || '').includes('edge_preview=1')
    );
}

export function verifySameOriginRequest(
    c: { req: { header: (k: string) => string | undefined }; get?: (k: string) => any },
    fallbackHost: string = DEFAULT_DEV_HOST
): { valid: boolean; error?: string } {
    const secFetchSite = c.req.header('sec-fetch-site');
    if (secFetchSite === 'cross-site') {
        return { valid: false, error: 'Forbidden: Cross-site requests are strictly prohibited' };
    }
    const origin = c.req.header('origin');
    const targetHost = normalizeHostKey((c.get ? c.get('host') : undefined) || c.req.header('host') || fallbackHost);
    if (origin) {
        try {
            const originHost = normalizeHostKey(new URL(origin).host);
            if (originHost !== targetHost) {
                return { valid: false, error: 'Forbidden: Origin mismatch' };
            }
        } catch {
            return { valid: false, error: 'Forbidden: Invalid Origin header' };
        }
    }
    return { valid: true };
}

export class ServerTimingRecorder {
    private readonly entries: string[] = [];

    public add(name: string, durationMs: number): void {
        const clean = name.replace(/[^a-zA-Z0-9_-]/g, '');
        if (!clean) return;
        this.entries.push(`${clean};dur=${Math.max(0, durationMs).toFixed(2)}`);
    }

    public header(): string {
        return this.entries.join(', ');
    }
}
