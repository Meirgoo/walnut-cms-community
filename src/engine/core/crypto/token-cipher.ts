// Encrypts third-party repo PATs with AES-256-GCM before D1 persistence so raw tokens are never stored in plaintext.

export function uint8ArrayToBase64(bytes: Uint8Array): string {
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

export function base64ToUint8Array(b64: string): Uint8Array {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

export async function deriveTokenAesKey(sessionSecret: string): Promise<CryptoKey> {
    const enc = new TextEncoder();
    const normalizedSecret = (sessionSecret || 'edge_default_session_secret_2026').trim();
    const keyMaterial = await crypto.subtle.digest('SHA-256', enc.encode(normalizedSecret));
    return await crypto.subtle.importKey(
        'raw',
        keyMaterial,
        { name: 'AES-GCM' },
        false,
        ['encrypt', 'decrypt']
    );
}

export async function encryptRepoToken(
    token: string,
    sessionSecret: string
): Promise<{ encryptedToken: string; tokenIv: string }> {
    if (!token || !token.trim()) {
        throw new Error('TOKEN_EMPTY');
    }
    const key = await deriveTokenAesKey(sessionSecret);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const enc = new TextEncoder();
    const encryptedBuffer = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        key,
        enc.encode(token.trim())
    );

    return {
        encryptedToken: uint8ArrayToBase64(new Uint8Array(encryptedBuffer)),
        tokenIv: uint8ArrayToBase64(iv)
    };
}

export async function decryptRepoToken(
    encryptedToken: string,
    tokenIv: string,
    sessionSecret: string
): Promise<string> {
    if (!encryptedToken || !tokenIv) {
        throw new Error('TOKEN_CIPHER_PARAM_MISSING');
    }
    const key = await deriveTokenAesKey(sessionSecret);
    const iv = base64ToUint8Array(tokenIv);
    const ciphertextBytes = base64ToUint8Array(encryptedToken);

    try {
        const decryptedBuffer = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv },
            key,
            ciphertextBytes
        );
        return new TextDecoder().decode(decryptedBuffer);
    } catch {
        throw new Error('TOKEN_DECRYPT_FAILED');
    }
}
