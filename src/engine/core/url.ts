/**
 * Centralized URL & protocol resolution: generated HTML/redirects must use root-relative paths
 * except for sitemap, canonical, og:url/og:image, and hreflang links.
 */

export const DEFAULT_DEV_HOST = 'localhost:8787';

export function isLocalHost(host?: string | null): boolean {
  if (!host) return false;
  const cleanHost = host.trim().toLowerCase().split(':')[0];
  if (!cleanHost) return false;

  return (
    cleanHost === 'localhost' ||
    cleanHost === '127.0.0.1' ||
    cleanHost === '0.0.0.0' ||
    cleanHost === '::1' ||
    cleanHost === '[::1]' ||
    cleanHost.endsWith('.localhost') ||
    cleanHost.endsWith('.local') ||
    cleanHost.endsWith('.internal')
  );
}

// Strip/reject control chars and delimiters to prevent Host header, CRLF, XSS, and path-traversal injection.
export function sanitizeHostHeader(host?: string | null): string {
  if (!host) return '';
  const trimmed = host.trim();
  if (!trimmed || trimmed === '*') return '';
  const sanitized = trimmed.replace(/[\r\n\t\s<>"'`\\/]/g, '');
  if (!/^[a-zA-Z0-9.-]+(?::\d+)?$/.test(sanitized)) {
    return '';
  }
  return sanitized;
}

export function normalizeHostKey(host?: string | null): string {
  const clean = sanitizeHostHeader(host).toLowerCase().replace(/\.$/, '');
  if (!clean) return '';
  return clean.replace(/:(80|443)$/, '');
}

export function resolveEffectiveDomain(siteDomain?: string | null, reqHost?: string | null): string {
  const cleanSite = (siteDomain || '').trim();
  const cleanReq = sanitizeHostHeader(reqHost);

  if (!cleanSite || cleanSite === '*') {
    return cleanReq || DEFAULT_DEV_HOST;
  }

  // Self-heal newly deployed workers whose DB site domain is still localhost/loopback.
  if (isLocalHost(cleanSite) && cleanReq && !isLocalHost(cleanReq)) {
    return cleanReq;
  }

  const sanitizedSite = sanitizeHostHeader(cleanSite);
  if (sanitizedSite) {
    return sanitizedSite;
  }

  return cleanReq || DEFAULT_DEV_HOST;
}

export function resolveHostProtocol(
  host?: string | null,
  context?: { req?: { url?: string; header?: (name: string) => string | undefined } } | string | null
): 'http' | 'https' {
  const urlStr = typeof context === 'string' ? context : context?.req?.url;
  if (urlStr) {
    if (urlStr.startsWith('https://')) return 'https';
    if (urlStr.startsWith('http://')) return 'http';
  }

  if (typeof context === 'object' && context?.req?.header) {
    const protoHeader = context.req.header('x-forwarded-proto') || context.req.header('cf-visitor');
    if (protoHeader) {
      if (protoHeader.includes('https')) return 'https';
      if (protoHeader.includes('http')) return 'http';
    }
  }

  if (isLocalHost(host)) {
    return 'http';
  }

  return 'https';
}

export function resolveBaseUrl(
  host?: string | null,
  context?: { req?: { url?: string; header?: (name: string) => string | undefined } } | string | null
): string {
  const reqHost = typeof context === 'object' && context?.req?.header ? context.req.header('host') : undefined;
  const effectiveHost = resolveEffectiveDomain(host, reqHost);
  
  if (effectiveHost.startsWith('http://') || effectiveHost.startsWith('https://')) {
    return effectiveHost.replace(/\/+$/, '');
  }

  const protocol = resolveHostProtocol(effectiveHost, context);
  return `${protocol}://${effectiveHost}`;
}

export function buildAbsoluteUrl(
  pathOrUrl?: string | null,
  host?: string | null,
  context?: { req?: { url?: string; header?: (name: string) => string | undefined } } | string | null
): string {
  const reqHost = typeof context === 'object' && context?.req?.header ? context.req.header('host') : undefined;
  const effectiveHost = resolveEffectiveDomain(host, reqHost);

  if (!pathOrUrl || pathOrUrl.trim() === '') {
    return resolveBaseUrl(effectiveHost, context);
  }

  const trimmed = pathOrUrl.trim();
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return trimmed;
  }

  const baseUrl = resolveBaseUrl(effectiveHost, context);
  const normalizedPath = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return `${baseUrl}${normalizedPath}`;
}

// Neutralize protocol-relative URLs (//evil.com -> /evil.com) against open redirects.
export function ensureRelativePath(path?: string | null, fallback: string = '/'): string {
  if (!path) return fallback;
  const trimmed = path.trim();
  if (!trimmed) return fallback;

  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    try {
      const parsed = new URL(trimmed);
      return `${parsed.pathname}${parsed.search}${parsed.hash}` || fallback;
    } catch {
      return fallback;
    }
  }

  if (trimmed.startsWith('//')) {
    const sanitized = '/' + trimmed.replace(/^\/+/, '');
    return sanitized || fallback;
  }

  if (trimmed.startsWith('/')) {
    return trimmed;
  }

  return `/${trimmed}`;
}

export function isSecureContext(c?: { req?: { url?: string; header?: (name: string) => string | undefined } } | null): boolean {
  if (!c) return false;
  const url = c.req?.url;
  if (url && url.startsWith('https://')) return true;

  const forwardedProto = c.req?.header?.('x-forwarded-proto');
  if (forwardedProto && forwardedProto.toLowerCase().includes('https')) return true;

  const cfVisitor = c.req?.header?.('cf-visitor');
  return !!(cfVisitor && cfVisitor.includes('https'));
}

export function applyPublicAssetDomain(url: string, publicAssetsDomain?: string | null): string {
  const cleanDomain = String(publicAssetsDomain || '').trim().replace(/\/+$/, '');
  if (!cleanDomain || !url || !url.startsWith('/content/')) return url;
  return `${cleanDomain}${url}`;
}

export function applyPublicAssetDomainToHtml(html: string, publicAssetsDomain?: string | null): string {
  const cleanDomain = String(publicAssetsDomain || '').trim().replace(/\/+$/, '');
  if (!cleanDomain || !html || !html.includes('/content/')) return html;
  return html.replace(/((?:src|href|poster|content|data-src)\s*=\s*["']|url\(\s*["']?)(\/content\/)/gi, `$1${cleanDomain}$2`);
}
