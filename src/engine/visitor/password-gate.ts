import { t } from '../core/i18n';
import { escapeHtml } from '../core/utils';
import { fetchAsset, renderTemplate } from '../render/template';

const UNLOCK_TTL_MS = 24 * 60 * 60 * 1000;

function toHex(bytes: Uint8Array): string {
    return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqualStr(a: string, b: string): boolean {
    const enc = new TextEncoder();
    const ba = enc.encode(a);
    const bb = enc.encode(b);
    if (ba.length !== bb.length) return false;
    let diff = 0;
    for (let i = 0; i < ba.length; i++) {
        diff |= ba[i] ^ bb[i];
    }
    return diff === 0;
}

async function sha256Prefix(value: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return toHex(new Uint8Array(digest)).slice(0, 12);
}

async function signHmac(secret: string, payload: string): Promise<string> {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
        'raw',
        enc.encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
    );
    const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payload));
    return toHex(new Uint8Array(sig));
}

export function getUnlockCookieName(nodeId: string): string {
    return `edge_unlock_${nodeId.replace(/[^a-zA-Z0-9_]/g, '_')}`;
}

export function verifyPasswordMatch(input: string, expected: string): boolean {
    if (!expected) return false;
    return timingSafeEqualStr(input, expected);
}

export async function createUnlockToken(secret: string, nodeId: string, expectedPassword: string): Promise<string> {
    const exp = Date.now() + UNLOCK_TTL_MS;
    const pwDigest = await sha256Prefix(expectedPassword);
    const payload = `${nodeId}.${exp}.${pwDigest}`;
    const sig = await signHmac(secret, payload);
    return `${payload}.${sig}`;
}

export async function verifyUnlockToken(
    secret: string,
    token: string | undefined,
    nodeId: string,
    expectedPassword: string
): Promise<boolean> {
    if (!token || !expectedPassword) return false;
    const parts = token.split('.');
    if (parts.length !== 4) return false;
    const [tokenNodeId, expStr, pwDigest, sig] = parts;
    if (tokenNodeId !== nodeId) return false;
    const exp = Number(expStr);
    if (!Number.isFinite(exp) || Date.now() > exp) return false;

    const currentPwDigest = await sha256Prefix(expectedPassword);
    if (!timingSafeEqualStr(pwDigest, currentPwDigest)) return false;

    const expectedSig = await signHmac(secret, `${tokenNodeId}.${expStr}.${pwDigest}`);
    return timingSafeEqualStr(sig, expectedSig);
}

export async function renderPasswordGateHtml(opts: {
    siteName: string;
    primaryColor?: string;
    nodeId: string;
    targetPath: string;
    locale: string;
    hasError?: boolean;
    env?: any;
}): Promise<string> {
    const lang = escapeHtml(opts.locale || 'zh-CN');
    const siteName = escapeHtml(opts.siteName || 'Site');
    const accent = /^#[0-9a-fA-F]{3,8}$/.test(opts.primaryColor || '') ? opts.primaryColor! : '#B45309';
    const title = escapeHtml(t(opts.locale, 'editor.password_gate_title'));
    const desc = escapeHtml(t(opts.locale, 'editor.password_gate_desc'));
    const placeholder = escapeHtml(t(opts.locale, 'editor.password_gate_placeholder'));
    const submitLabel = escapeHtml(t(opts.locale, 'editor.password_gate_submit'));
    const errorHtml = opts.hasError ? `<p class="err">${escapeHtml(t(opts.locale, 'editor.password_gate_error'))}</p>` : '';

    const tpl = await fetchAsset('/shared/password-gate.html', opts.env);
    return renderTemplate(tpl, {
        lang,
        site_name: siteName,
        accent,
        title,
        desc,
        node_id: escapeHtml(opts.nodeId),
        target_path: escapeHtml(opts.targetPath),
        placeholder,
        error_html: errorHtml,
        submit_label: submitLabel
    });
}
