// Uses Web Crypto PBKDF2-SHA256 instead of bcryptjs to stay within Workers CPU/memory budgets.

const PBKDF2_ALGORITHM = 'PBKDF2';
const HASH_ALGORITHM = 'SHA-256';
const ITERATIONS = 100_000;
const KEY_LENGTH_BYTES = 32;
const SALT_LENGTH_BYTES = 16;
const HASH_PREFIX = 'pbkdf2:sha256:';

export function bytesToHex(bytes: Uint8Array): string {
    return Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
}

export function hexToBytes(hex: string): Uint8Array | null {
    if (!hex || typeof hex !== 'string' || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) {
        return null;
    }
    try {
        const bytes = new Uint8Array(hex.length / 2);
        for (let i = 0; i < hex.length; i += 2) {
            const val = parseInt(hex.slice(i, i + 2), 16);
            if (Number.isNaN(val)) {
                return null;
            }
            bytes[i / 2] = val;
        }
        return bytes;
    } catch {
        return null;
    }
}

// Constant-time comparison to prevent timing attacks.
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) {
        return false;
    }
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
        diff |= a[i] ^ b[i];
    }
    return diff === 0;
}

async function deriveKey(
    password: string,
    salt: Uint8Array,
    iterations: number,
    keyLengthBytes: number
): Promise<Uint8Array> {
    const encoder = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
        'raw',
        encoder.encode(password),
        { name: PBKDF2_ALGORITHM },
        false,
        ['deriveBits']
    );

    const derivedBits = await crypto.subtle.deriveBits(
        {
            name: PBKDF2_ALGORITHM,
            salt,
            iterations,
            hash: HASH_ALGORITHM
        },
        keyMaterial,
        keyLengthBytes * 8
    );

    return new Uint8Array(derivedBits);
}

export async function hashPassword(password: string): Promise<string> {
    if (!password || typeof password !== 'string') {
        throw new Error('Password must be a non-empty string');
    }
    const salt = new Uint8Array(SALT_LENGTH_BYTES);
    crypto.getRandomValues(salt);
    const derivedKey = await deriveKey(password, salt, ITERATIONS, KEY_LENGTH_BYTES);
    return `${HASH_PREFIX}${ITERATIONS}:${bytesToHex(salt)}:${bytesToHex(derivedKey)}`;
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
    if (!password || !storedHash || typeof password !== 'string' || typeof storedHash !== 'string') {
        return false;
    }

    try {
        const parts = storedHash.split(':');
        if (parts.length !== 5 || parts[0] !== 'pbkdf2' || parts[1] !== 'sha256') {
            return false;
        }

        const iterations = parseInt(parts[2], 10);
        if (Number.isNaN(iterations) || iterations <= 0 || iterations > 1_000_000) {
            return false;
        }

        const salt = hexToBytes(parts[3]);
        const expectedHash = hexToBytes(parts[4]);

        if (!salt || !expectedHash || salt.length === 0 || expectedHash.length === 0) {
            return false;
        }

        const derivedKey = await deriveKey(password, salt, iterations, expectedHash.length);
        return timingSafeEqual(derivedKey, expectedHash);
    } catch (e) {
        console.warn('[Crypto] verifyPassword encountered corrupted hash or derivation failure:', e);
        return false;
    }
}
