import { ThemeManifestZod } from '../types';

export interface RepoConfig {
    url: string;
    type: 'github' | 'gitlab' | 'gitea' | 'custom';
    branch: string;
    encrypted_token?: string;
    token_iv?: string;
    last_synced_at?: string;
    commit_hash?: string;
}

export interface ParsedRepoInfo {
    host: string;
    owner: string;
    repo: string;
    branch: string;
    repoType: 'github' | 'gitlab' | 'gitea' | 'custom';
}

export interface RepoThemeAsset {
    file_path: string;
    content: string;
    is_base64: boolean;
    content_type?: string;
}

export interface RepoThemeData {
    manifest: any;
    tokens: Record<string, any>;
    assets: RepoThemeAsset[];
    components: any[];
    templates: any[];
    schemas: any[];
    commitHash?: string;
    repoConfig: RepoConfig;
}

export function scanThemeSecurityCode(content: string): { safe: boolean; matched?: string } {
    if (!content || typeof content !== 'string') return { safe: true };
    const dangerousPatterns = [
        { pattern: /\beval\s*\(/i, name: 'eval()' },
        { pattern: /\bnew\s+Function\s*\(/i, name: 'new Function()' },
        { pattern: /\bdocument\.cookie\b/i, name: 'document.cookie' },
        { pattern: /\bnavigator\.sendBeacon\s*\(/i, name: 'navigator.sendBeacon()' },
        { pattern: /\bwindow\.parent\b/i, name: 'window.parent' },
        { pattern: /\b__proto__\b/i, name: '__proto__ (prototype pollution)' },
        { pattern: /javascript\s*:/i, name: 'javascript: pseudo-protocol' }
    ];

    for (const item of dangerousPatterns) {
        if (item.pattern.test(content)) {
            return { safe: false, matched: item.name };
        }
    }
    return { safe: true };
}

export function assertThemeSafe(content: string, label: string): void {
    const sec = scanThemeSecurityCode(content);
    if (!sec.safe) {
        throw new Error(`SECURITY_THREAT_INTERCEPTED: ${label} contains hazardous code: ${sec.matched}`);
    }
}

export function parseGitRepoUrl(rawUrl: string, defaultBranch = 'main'): ParsedRepoInfo {
    const trimmed = rawUrl.trim().replace(/\.git\/?$/, '');
    let urlObj: URL;
    try {
        urlObj = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`);
    } catch {
        throw new Error('INVALID_REPO_URL');
    }

    const host = urlObj.hostname.toLowerCase();
    const parts = urlObj.pathname.split('/').filter(Boolean);

    if (parts.length < 2) {
        throw new Error('INVALID_REPO_URL');
    }

    const owner = parts[0];
    const repo = parts[1];
    let branch = defaultBranch;

    if (parts.length >= 4 && (parts[2] === 'tree' || parts[2] === 'src' || parts[2] === '-/tree')) {
        branch = parts.slice(3).join('/');
    }

    let repoType: 'github' | 'gitlab' | 'gitea' | 'custom';
    if (host.includes('github.com')) {
        repoType = 'github';
    } else if (host.includes('gitlab')) {
        repoType = 'gitlab';
    } else if (host.includes('gitea')) {
        repoType = 'gitea';
    } else {
        // Default custom hosts to GitHub-compatible REST API.
        repoType = 'github';
    }

    return { host, owner, repo, branch, repoType };
}

export interface FetchRepoOptions {
    repoUrl: string;
    branch?: string;
    token?: string;
    fetchFn?: typeof fetch;
}

export async function fetchRepoThemeData(options: FetchRepoOptions): Promise<RepoThemeData> {
    const fetchImpl = options.fetchFn || globalThis.fetch;
    const parsed = parseGitRepoUrl(options.repoUrl, options.branch || 'main');
    const { host, owner, repo, branch, repoType } = parsed;
    const token = options.token?.trim();
    let commitHash: string | undefined = undefined;

    const headers: Record<string, string> = {
        'User-Agent': 'Edge-Theme-Service/1.0'
    };

    if (token) {
        if (repoType === 'gitlab') {
            headers['PRIVATE-TOKEN'] = token;
        } else {
            headers['Authorization'] = `token ${token}`;
        }
    }

    async function fetchFileFromRepo(filePath: string): Promise<string | null> {
        const cleanPath = filePath.replace(/^\/+/, '');
        try {
            if (repoType === 'gitlab') {
                const projectId = encodeURIComponent(`${owner}/${repo}`);
                const url = `https://${host}/api/v4/projects/${projectId}/repository/files/${encodeURIComponent(cleanPath)}/raw?ref=${encodeURIComponent(branch)}`;
                const res = await fetchImpl(url, { headers });
                return res.ok ? await res.text() : null;
            }
            if (repoType === 'gitea') {
                const url = `https://${host}/api/v1/repos/${owner}/${repo}/raw/branch/${encodeURIComponent(branch)}/${cleanPath}`;
                const res = await fetchImpl(url, { headers });
                return res.ok ? await res.text() : null;
            }
            const url = `https://api.github.com/repos/${owner}/${repo}/contents/${cleanPath}?ref=${encodeURIComponent(branch)}`;
            const res = await fetchImpl(url, { headers: { ...headers, Accept: 'application/vnd.github.v3+json' } });
            if (!res.ok) return null;
            const data = await res.json() as any;
            if (data.content && data.encoding === 'base64') {
                return atob(data.content.replace(/\s+/g, ''));
            }
            if (data.download_url) {
                const rawRes = await fetchImpl(data.download_url, { headers });
                return await rawRes.text();
            }
            return null;
        } catch {
            return null;
        }
    }

    const manifestText = await fetchFileFromRepo('manifest.json');
    if (!manifestText) {
        throw new Error('MANIFEST_NOT_FOUND');
    }

    let manifestRaw: any;
    try {
        manifestRaw = JSON.parse(manifestText);
    } catch {
        throw new Error('INVALID_JSON');
    }

    const manifestParsed = ThemeManifestZod.safeParse(manifestRaw);
    if (!manifestParsed.success) {
        throw new Error(`INVALID_MANIFEST: Theme manifest validation failed: ${manifestParsed.error.issues.map(i => i.message).join(', ')}`);
    }
    const manifest = manifestParsed.data;

    const secName = scanThemeSecurityCode(`${manifest.name} ${manifest.description || ''}`);
    if (!secName.safe) {
        throw new Error(`SECURITY_THREAT_INTERCEPTED: Theme metadata contains hazardous code: ${secName.matched}`);
    }

    const fetchRawFile = fetchFileFromRepo;

    let tokens: Record<string, any> = {};
    const tokensContent = await fetchRawFile('tokens.json');
    if (tokensContent) {
        try {
            tokens = JSON.parse(tokensContent);
        } catch {}
    }

    const components: any[] = [];
    const rawComps = Array.isArray(manifest.components) ? manifest.components : (Array.isArray((manifest as any).blocks) ? (manifest as any).blocks : []);
    for (const comp of rawComps) {
        let tplHtml = comp.templateHtml || comp.template_html || comp.template || '';
        if (comp.template_path) {
            const loaded = await fetchRawFile(comp.template_path);
            if (loaded) tplHtml = loaded;
        }
        assertThemeSafe(tplHtml, `Component [${comp.name || comp.type}] template`);
        components.push({
            ...comp,
            slug: comp.slug || comp.type,
            templateHtml: tplHtml,
            template_html: tplHtml
        });
    }

    const templates: any[] = [];
    if (Array.isArray(manifest.templates)) {
        for (const tpl of manifest.templates) {
            if (!tpl || typeof tpl !== 'object') continue;
            let tplHtml = tpl.templateHtml || tpl.template_html || '';
            if (tpl.template_path) {
                const loaded = await fetchRawFile(tpl.template_path);
                if (loaded) tplHtml = loaded;
            }
            if (tplHtml) {
                assertThemeSafe(tplHtml, `Template [${tpl.name || tpl.slug || tpl.id}] `);
            }
            if (Array.isArray(tpl.blocks)) {
                assertThemeSafe(JSON.stringify(tpl.blocks), `Template [${tpl.name || tpl.slug || tpl.id}] blocks`);
            }
            templates.push({
                ...tpl,
                slug: tpl.slug || tpl.key || tpl.id,
                name: tpl.name || tpl.title || tpl.slug,
                ...(tplHtml ? { templateHtml: tplHtml } : {})
            });
        }
    }
    if (Array.isArray(manifest.layouts)) {
        for (const layout of manifest.layouts) {
            let lHtml = '';
            if (layout.template_path) {
                const loaded = await fetchRawFile(layout.template_path);
                if (loaded) lHtml = loaded;
            }
            assertThemeSafe(lHtml, `Page layout [${layout.name || layout.key}] `);
            templates.push({
                slug: layout.key,
                name: layout.name,
                metadata: { layout: layout.key, html: lHtml }
            });
        }
    }

    const schemas: any[] = [];
    if (Array.isArray(manifest.dataset_templates)) {
        for (const ds of manifest.dataset_templates) {
            let sData: any = {};
            if (ds.schema_binding) {
                const loaded = await fetchRawFile(ds.schema_binding);
                if (loaded) {
                    try { sData = JSON.parse(loaded); } catch {}
                }
            }
            schemas.push({
                slug: ds.type,
                name: ds.name,
                metadata: sData
            });
        }
    }

    const assets: RepoThemeAsset[] = [];
    const knownAssetPaths = new Set<string>();

    if (manifest.global_assets) {
        if (Array.isArray(manifest.global_assets.styles)) {
            manifest.global_assets.styles.forEach((p: string) => knownAssetPaths.add(p));
        }
        if (Array.isArray(manifest.global_assets.scripts)) {
            manifest.global_assets.scripts.forEach((p: string) => knownAssetPaths.add(p));
        }
    }

    for (const aPath of knownAssetPaths) {
        const cleanA = aPath.replace(/^\/+/, '');
        const content = await fetchRawFile(cleanA);
        if (content !== null) {
            assertThemeSafe(content, `Static asset [${cleanA}] `);
            assets.push({
                file_path: cleanA,
                content,
                is_base64: false,
                content_type: cleanA.endsWith('.css') ? 'text/css' : (cleanA.endsWith('.js') ? 'application/javascript' : 'text/plain')
            });
        }
    }

    return {
        manifest,
        tokens,
        assets,
        components,
        templates,
        schemas,
        commitHash,
        repoConfig: {
            url: options.repoUrl,
            type: repoType,
            branch,
            last_synced_at: new Date().toISOString()
        }
    };
}
