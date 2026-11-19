import type { D1Database } from '@cloudflare/workers-types';
import { getSystemMetaValue, setSystemMetaValue } from '../dal';
import { COMMERCIAL_BUNDLE_ENC, LICENSE_PUBLIC_KEY_SPKI } from './commercial-bundle.enc';

const OBFUSCATION_FACTOR = 'walnut-cms-hkdf-core-salt-v2.2-fixed-factor';
const subKeyCache = new Map<string, CryptoKey>();

export type SubKeyPurpose = 'session' | 'vault' | 'webhook';

// Auto-persist a generated salt in system_meta when SESSION_SECRET is unset so derived keys remain stable across restarts.
export async function getRootSecret(env?: Record<string, any>, db?: D1Database): Promise<string> {
    const envSecret = env?.SESSION_SECRET;
    if (typeof envSecret === 'string' && envSecret.trim()) {
        return envSecret.trim();
    }
    if (db) {
        try {
            const existingSalt = await getSystemMetaValue(db, 'system_salt');
            if (existingSalt) return existingSalt;
            const newSalt = crypto.randomUUID();
            await setSystemMetaValue(db, 'system_salt', newSalt);
            return newSalt;
        } catch {}
    }
    return (env?.AUTHER_KEY_PUBLIC || env?.CF_ACCOUNT_ID || 'walnut_fallback_root_secret_2026');
}

// Derive purpose-isolated HKDF subkeys so session, vault, and webhook secrets never share key material.
export async function deriveSubKey(
    purpose: SubKeyPurpose,
    env?: Record<string, any>,
    db?: D1Database
): Promise<CryptoKey> {
    const root = await getRootSecret(env, db);
    const cacheKey = `${purpose}:${root}`;
    const cached = subKeyCache.get(cacheKey);
    if (cached) return cached;

    const enc = new TextEncoder();
    const baseKey = await crypto.subtle.importKey(
        'raw',
        enc.encode(root),
        'HKDF',
        false,
        ['deriveKey']
    );

    const isVault = purpose === 'vault';
    const derived = await crypto.subtle.deriveKey(
        {
            name: 'HKDF',
            hash: 'SHA-256',
            salt: enc.encode(OBFUSCATION_FACTOR),
            info: enc.encode(`walnut:subkey:${purpose}`)
        },
        baseKey,
        isVault ? { name: 'AES-GCM', length: 256 } : { name: 'HMAC', hash: 'SHA-256', length: 256 },
        false,
        isVault ? ['encrypt', 'decrypt'] : ['sign', 'verify']
    );

    subKeyCache.set(cacheKey, derived);
    return derived;
}

// Bind ciphertext to siteId:fieldName via AEAD additionalData to prevent cross-tenant or cross-field tampering.
export async function vaultEncrypt(
    plaintext: string,
    siteId: string,
    fieldName: string,
    env?: Record<string, any>,
    db?: D1Database
): Promise<string> {
    if (!plaintext || plaintext.startsWith('enc:v1:')) return plaintext;
    const key = await deriveSubKey('vault', env, db);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const enc = new TextEncoder();
    const additionalData = enc.encode(`${siteId}:${fieldName}`);
    const cipherBuf = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData },
        key,
        enc.encode(plaintext)
    );
    const ivBase64 = btoa(String.fromCharCode(...iv));
    const cipherBase64 = btoa(String.fromCharCode(...new Uint8Array(cipherBuf)));
    return `enc:v1:${ivBase64}:${cipherBase64}`;
}

// Transparently pass through legacy plaintext values lacking the enc:v1: prefix.
export async function vaultDecrypt(
    ciphertext: string,
    siteId: string,
    fieldName: string,
    env?: Record<string, any>,
    db?: D1Database
): Promise<string> {
    if (!ciphertext || !ciphertext.startsWith('enc:v1:')) return ciphertext;
    const parts = ciphertext.split(':');
    if (parts.length !== 4) return ciphertext;
    try {
        const iv = Uint8Array.from(atob(parts[2]), c => c.charCodeAt(0));
        const data = Uint8Array.from(atob(parts[3]), c => c.charCodeAt(0));
        const key = await deriveSubKey('vault', env, db);
        const additionalData = new TextEncoder().encode(`${siteId}:${fieldName}`);
        const plainBuf = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv, additionalData },
            key,
            data
        );
        return new TextDecoder().decode(plainBuf);
    } catch {
        return '';
    }
}

export interface CommercialVfsBundle {
    ui: {
        js: Record<string, string>;
        modals: Record<string, string>;
        pages: Record<string, string>;
        snippets: Record<string, string>;
    };
    manifests: Record<string, any>;
}

let cachedCommercialVfs: CommercialVfsBundle | null = null;
let cachedVfsTokenFingerprint: string | null = null;

function decodeB64UrlBytes(input: string): Uint8Array {
    const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
    const padLen = (4 - (normalized.length % 4)) % 4;
    const raw = atob(normalized + '='.repeat(padLen));
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) {
        bytes[i] = raw.charCodeAt(i);
    }
    return bytes;
}

function decodeB64UrlText(input: string): string {
    return new TextDecoder().decode(decodeB64UrlBytes(input));
}

function normalizeVfsKey(name: string, defaultExt: string): string {
    const clean = String(name || '').replace(/^\/+/, '').trim();
    if (!clean) return '';
    return clean.includes('.') ? clean : `${clean}${defaultExt}`;
}

// Verify Ed25519 signature, decrypt VFS bundle with payload CEK, and cache in memory by token fingerprint.
export async function unlockCommercialVfs(
    licenseToken?: string | null,
    publicKeySpkiB64?: string | null,
    encryptedBundle?: string | null
): Promise<CommercialVfsBundle | null> {
    const token = typeof licenseToken === 'string' ? licenseToken.trim() : '';
    const bundleEnc = typeof encryptedBundle === 'string' && encryptedBundle.trim()
        ? encryptedBundle.trim()
        : COMMERCIAL_BUNDLE_ENC;

    if (!token || !token.includes('.') || !bundleEnc || !bundleEnc.includes('.')) {
        return null;
    }

    const fingerprint = `${token}:${bundleEnc.slice(0, 32)}`;
    if (cachedCommercialVfs && cachedVfsTokenFingerprint === fingerprint) {
        return cachedCommercialVfs;
    }

    try {
        const [payloadB64, signatureB64] = token.split('.');
        if (!payloadB64 || !signatureB64) return null;

        const spkiB64 = (publicKeySpkiB64 && publicKeySpkiB64.trim()) || LICENSE_PUBLIC_KEY_SPKI;
        if (!spkiB64) return null;

        const pubBytes = decodeB64UrlBytes(spkiB64);
        const rawPubKey = pubBytes.length === 44 ? pubBytes.slice(12) : pubBytes;
        const verifyKey = await crypto.subtle.importKey(
            'raw',
            rawPubKey,
            { name: 'Ed25519' },
            false,
            ['verify']
        );

        const sigBytes = decodeB64UrlBytes(signatureB64);
        const enc = new TextEncoder();
        const payloadRaw = decodeB64UrlText(payloadB64);

        const isValid =
            (await crypto.subtle.verify({ name: 'Ed25519' }, verifyKey, sigBytes, enc.encode(payloadB64))) ||
            (await crypto.subtle.verify({ name: 'Ed25519' }, verifyKey, sigBytes, enc.encode(payloadRaw)));

        if (!isValid) return null;

        const payload = JSON.parse(payloadRaw) as { cek?: string };
        if (!payload?.cek || typeof payload.cek !== 'string') {
            return null;
        }

        const [ivB64, cipherTagB64] = bundleEnc.split('.');
        if (!ivB64 || !cipherTagB64) return null;

        const cekBytes = decodeB64UrlBytes(payload.cek);
        const ivBytes = decodeB64UrlBytes(ivB64);
        const cipherTagBytes = decodeB64UrlBytes(cipherTagB64);

        const aesKey = await crypto.subtle.importKey(
            'raw',
            cekBytes,
            { name: 'AES-GCM' },
            false,
            ['decrypt']
        );
        const plainBuf = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: ivBytes },
            aesKey,
            cipherTagBytes
        );

        const plainBytes = new Uint8Array(plainBuf);
        let decodedJson: string;
        if (plainBytes.length >= 2 && plainBytes[0] === 0x1f && plainBytes[1] === 0x8b) {
            const ds = new DecompressionStream('gzip');
            const decompressedStream = new Blob([plainBytes]).stream().pipeThrough(ds);
            decodedJson = await new Response(decompressedStream).text();
        } else {
            decodedJson = new TextDecoder().decode(plainBytes);
        }

        const parsedVfs = JSON.parse(decodedJson) as CommercialVfsBundle;
        if (!parsedVfs || typeof parsedVfs !== 'object' || !parsedVfs.ui) {
            return null;
        }

        cachedCommercialVfs = parsedVfs;
        cachedVfsTokenFingerprint = fingerprint;
        return cachedCommercialVfs;
    } catch {
        return null;
    }
}

export function isCommercialVfsUnlocked(): boolean {
    return cachedCommercialVfs !== null;
}

export function clearCommercialVfsCache(): void {
    cachedCommercialVfs = null;
    cachedVfsTokenFingerprint = null;
}

export function setCommercialVfsForTest(bundle: CommercialVfsBundle | null, fingerprint = 'test-vfs'): void {
    cachedCommercialVfs = bundle;
    cachedVfsTokenFingerprint = bundle ? fingerprint : null;
}

export function getCommercialSnippet(name: string): string {
    if (!cachedCommercialVfs?.ui?.snippets) return '';
    const key = normalizeVfsKey(name, '.html');
    return cachedCommercialVfs.ui.snippets[key] || '';
}

export function getCommercialPage(name: string): string {
    if (!cachedCommercialVfs?.ui?.pages) return '';
    const key = normalizeVfsKey(name, '.html');
    return cachedCommercialVfs.ui.pages[key] || '';
}

export function getCommercialModal(name: string): string {
    if (!cachedCommercialVfs?.ui?.modals) return '';
    const key = normalizeVfsKey(name, '.html');
    return cachedCommercialVfs.ui.modals[key] || '';
}

export function getCommercialJs(name: string): string {
    if (!cachedCommercialVfs?.ui?.js) return '';
    const key = normalizeVfsKey(name, '.js');
    return cachedCommercialVfs.ui.js[key] || '';
}

export function getCommercialManifest<T = any>(key: string): T | null {
    if (!cachedCommercialVfs?.manifests) return null;
    const val = cachedCommercialVfs.manifests[key];
    return val !== undefined ? (val as T) : null;
}
