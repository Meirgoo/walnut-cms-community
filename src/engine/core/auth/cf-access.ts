import type { Context } from 'hono';

export interface CFAccessIdentity {
    email: string;
    sub?: string;
    name?: string;
    rawJwt?: string;
}

interface JwksCacheEntry {
    keys: Map<string, CryptoKey>;
    expiresAt: number;
}

// Cache CF Access JWKS in memory (1h TTL) to avoid per-request remote certificate fetches.
const certsCacheByDomain = new Map<string, JwksCacheEntry>();

function decodeBase64Url(str: string): string {
    let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
    while (base64.length % 4 !== 0) {
        base64 += '=';
    }
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder().decode(bytes);
}

function base64UrlToBytes(str: string): Uint8Array {
    let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
    while (base64.length % 4 !== 0) {
        base64 += '=';
    }
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

async function getOrCreateCryptoKey(certsUrl: string, kid: string): Promise<CryptoKey | null> {
    const now = Date.now();
    const cache = certsCacheByDomain.get(certsUrl);

    if (cache && cache.expiresAt > now && cache.keys.has(kid)) {
        return cache.keys.get(kid)!;
    }

    try {
        const resp = await fetch(certsUrl, {
            headers: { Accept: 'application/json' }
        });

        if (!resp.ok) {
            console.error(`[CF Access] Failed to fetch public key (${certsUrl}): HTTP ${resp.status}`);
            return null;
        }

        const data: any = await resp.json();
        if (!data || !Array.isArray(data.keys)) {
            console.error(`[CF Access] Invalid JWKS format (${certsUrl})`);
            return null;
        }

        const keysMap = new Map<string, CryptoKey>();
        for (const jwk of data.keys) {
            if (jwk.kid && jwk.kty === 'RSA') {
                try {
                    const cryptoKey = await crypto.subtle.importKey(
                        'jwk',
                        jwk,
                        {
                            name: 'RSASSA-PKCS1-v1_5',
                            hash: 'SHA-256'
                        },
                        false,
                        ['verify']
                    );
                    keysMap.set(jwk.kid, cryptoKey);
                } catch (importErr) {
                    console.warn(`[CF Access] Failed to import JWK (kid: ${jwk.kid}):`, importErr);
                }
            }
        }

        certsCacheByDomain.set(certsUrl, {
            keys: keysMap,
            expiresAt: now + 3600_000
        });

        return keysMap.get(kid) || null;
    } catch (err) {
        console.error(`[CF Access] Network error requesting JWKS certificates (${certsUrl}):`, err);
        return null;
    }
}

export async function verifyCFAccessJWT(
    jwt: string,
    teamDomain: string,
    expectedAud?: string
): Promise<any | null> {
    const parts = jwt.split('.');
    if (parts.length !== 3) {
        return null;
    }

    let header: any;
    let payload: any;
    try {
        header = JSON.parse(decodeBase64Url(parts[0]));
        payload = JSON.parse(decodeBase64Url(parts[1]));
    } catch {
        return null;
    }

    if (!header || header.alg !== 'RS256' || !header.kid) {
        console.warn('[CF Access] Invalid JWT Header or not RS256 algorithm');
        return null;
    }

    const domain = teamDomain.replace(/^https?:\/\//, '').replace(/\/+$/, '');
    const fullTeamDomain = domain.includes('.') ? domain : `${domain}.cloudflareaccess.com`;
    const certsUrl = `https://${fullTeamDomain}/cdn-cgi/access/certs`;

    const cryptoKey = await getOrCreateCryptoKey(certsUrl, header.kid);
    if (!cryptoKey) {
        console.warn(`[CF Access] No matching public key found at ${certsUrl} (kid: ${header.kid})`);
        return null;
    }

    try {
        const signedData = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
        const signature = base64UrlToBytes(parts[2]);

        const isValid = await crypto.subtle.verify(
            'RSASSA-PKCS1-v1_5',
            cryptoKey,
            signature,
            signedData
        );

        if (!isValid) {
            console.warn('[CF Access] JWT signature verification failed (Invalid Signature)');
            return null;
        }
    } catch (e) {
        console.warn('[CF Access] Signature verification exception:', e);
        return null;
    }

    // Allow 60s clock skew.
    const nowSec = Math.floor(Date.now() / 1000);
    if (typeof payload.exp === 'number' && payload.exp < nowSec - 60) {
        console.warn('[CF Access] JWT has expired');
        return null;
    }
    if (typeof payload.nbf === 'number' && payload.nbf > nowSec + 60) {
        console.warn('[CF Access] JWT is not yet active');
        return null;
    }

    if (expectedAud) {
        const aud = payload.aud;
        const isAudValid = Array.isArray(aud) ? aud.includes(expectedAud) : aud === expectedAud;
        if (!isAudValid) {
            console.warn('[CF Access] JWT AUD claim mismatch');
            return null;
        }
    }

    const expectedIss = `https://${fullTeamDomain}`;
    if (payload.iss && String(payload.iss).replace(/\/+$/, '') !== expectedIss) {
        console.warn('[CF Access] JWT issuer mismatch');
        return null;
    }

    return payload;
}

export function isLocalDevCFAccessBypassEnabled(c: Context<any>): boolean {
    if (c.env?.ENVIRONMENT !== 'development' || c.env?.ALLOW_INSECURE_DEV_CF_ACCESS !== 'true') {
        return false;
    }
    const host = String(c.get?.('host') || c.req.header('host') || '').toLowerCase();
    return host.startsWith('localhost') || host.startsWith('127.0.0.1');
}

/**
 * Verify CF Access RS256 JWT when CF_ACCESS_TEAM_NAME is set; local dev bypass requires ENVIRONMENT=development, ALLOW_INSECURE_DEV_CF_ACCESS=true, and localhost.
 */
export async function extractCFAccessIdentity(c: Context<any>): Promise<CFAccessIdentity | null> {
    const jwtAssertion = c.req.header('cf-access-jwt-assertion') || c.req.header('Cf-Access-Jwt-Assertion');
    const accessEmail = c.req.header('cf-access-authenticated-user-email') || c.req.header('Cf-Access-Authenticated-User-Email');

    if (isLocalDevCFAccessBypassEnabled(c)) {
        const devEmail = (accessEmail || String(c.env?.DEV_CF_ACCESS_EMAIL || 'admin@localhost')).trim();
        console.warn('[CF Access] Warning: ALLOW_INSECURE_DEV_CF_ACCESS is enabled for local debugging.');
        return {
            email: devEmail,
            sub: 'dev-sub',
            name: 'Dev User',
            rawJwt: jwtAssertion || ''
        };
    }

    if (!jwtAssertion && !accessEmail) {
        return null;
    }

    const teamName = c.env?.CF_ACCESS_TEAM_NAME;
    const expectedAud = c.env?.CF_ACCESS_AUD;

    if (teamName) {
        if (!jwtAssertion) {
            console.warn('[CF Access] Access denied: cf-access-authenticated-user-email present without valid JWT signature');
            return null;
        }

        const payload = await verifyCFAccessJWT(jwtAssertion, teamName, expectedAud);
        if (!payload || !payload.email) {
            return null;
        }

        return {
            email: payload.email,
            sub: payload.sub,
            name: payload.name || payload.common_name,
            rawJwt: jwtAssertion
        };
    }

    if (jwtAssertion || accessEmail) {
        console.warn('[CF Access] Rejected unverified CF Access header: CF_ACCESS_TEAM_NAME is not configured.');
    }
    return null;
}
