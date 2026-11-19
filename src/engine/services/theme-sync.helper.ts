import type { D1PreparedStatement } from '@cloudflare/workers-types';
import {
    buildUpsertThemeStatement,
    buildInsertThemeVersionStatement
} from '../core/dal';

export async function computeCodeHash(code: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(code || '');
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hashBuffer))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('')
        .slice(0, 16);
}

export const clearConflict = (c: any) => {
    c.upstream_conflict = false;
    delete c.upstream_template;
    delete c.upstream_version;
};

export const resetComp = (comp: any, code: string, hash: string, modified: boolean) => {
    comp.template_html = code;
    comp.template = code;
    comp.base_hash = hash;
    comp.local_hash = hash;
    comp.modified_locally = modified;
    clearConflict(comp);
};

export const getSiteId = (ctx: any) => ctx.data?.siteId || ctx.siteId || 'site_default';

export const makeThemeMeta = (m: any, extra: any = {}) => ({
    id: m.id || m.slug || '',
    version: String(m.version || '1.0.0'),
    author: m.author || 'Unknown',
    homepage: m.homepage || '',
    license: m.license || 'MIT',
    preview_image: m.preview_image || m.previewImage || '',
    layout_html: extra.layout_html || m.layout_html || '',
    color_schemes: Array.isArray(m.color_schemes) && m.color_schemes.length > 0 ? m.color_schemes : ['light', 'dark'],
    global_assets: m.global_assets || {},
    layouts: m.layouts || [],
    presets: m.presets || [],
    dataset_templates: m.dataset_templates || [],
    tokens: extra.tokens || m.tokens || {},
    templates: extra.templates || m.templates || m.templateNodes || [],
    components: extra.components || m.components || m.componentNodes || [],
    schemas: extra.schemas || m.schemas || m.schemaNodes || [],
    ...extra
});

export const makeThemeUpsertBatch = (
    db: any,
    th: { id: string; siteId: string; slug: string; name: string; author?: string; version: string; description?: string; previewImage?: string; metadataJson: string; versionId: string },
    ver: { id: string; versionNumber?: number; versionTag: string; metadataSnapshot: string; commitMessage?: string; authorId?: string }
): D1PreparedStatement[] => [
    buildInsertThemeVersionStatement(db, { id: ver.id, themeId: th.id, versionNumber: ver.versionNumber, versionTag: ver.versionTag, metadataSnapshot: ver.metadataSnapshot, commitMessage: ver.commitMessage, authorId: ver.authorId }),
    buildUpsertThemeStatement(db, { id: th.id, siteId: th.siteId, slug: th.slug, name: th.name, author: th.author || 'Unknown', version: th.version, description: th.description || '', previewImage: th.previewImage || '', metadataJson: th.metadataJson, currentVersionId: th.versionId })
];

// Three-way merge: auto-upgrade unmodified components, keep local-only edits, and stage upstream conflicts on dual edits.
export async function mergeThemeComponentsThreeWay(
    localComponents: any[],
    upstreamComponents: any[],
    newVersionTag: string
): Promise<{ components: any[]; conflictCount: number; upgradedCount: number; preservedCount: number }> {
    const merged: any[] = [];
    const localMap = new Map<string, any>();
    for (const c of localComponents || []) {
        const key = c.slug || c.type || c.key;
        if (key) localMap.set(key, c);
    }

    let conflictCount = 0;
    let upgradedCount = 0;
    let preservedCount = 0;

    for (const uComp of upstreamComponents || []) {
        const key = uComp.slug || uComp.type || uComp.key;
        if (!key) continue;
        const uCode = uComp.template_html || uComp.template || '';
        const uHash = await computeCodeHash(uCode);

        if (!localMap.has(key)) {
            const item = { ...uComp, slug: key };
            resetComp(item, uCode, uHash, false);
            merged.push(item);
            upgradedCount++;
        } else {
            const localComp = { ...localMap.get(key) };
            localMap.delete(key);
            const localCode = localComp.template_html || localComp.template || '';
            const currentLocalHash = await computeCodeHash(localCode);
            const baseHash = localComp.base_hash || currentLocalHash;
            const isLocalModified = localComp.modified_locally === true || currentLocalHash !== baseHash;
            const isUpstreamModified = uHash !== baseHash;

            if (!isLocalModified) {
                localComp.name = uComp.name || localComp.name;
                localComp.summary = uComp.summary || localComp.summary;
                resetComp(localComp, uCode, uHash, false);
                upgradedCount++;
            } else if (!isUpstreamModified) {
                localComp.modified_locally = true;
                localComp.upstream_conflict = false;
                delete localComp.upstream_template;
                delete localComp.upstream_version;
                preservedCount++;
            } else if (currentLocalHash === uHash) {
                resetComp(localComp, localCode, uHash, false);
                upgradedCount++;
            } else {
                localComp.modified_locally = true;
                localComp.upstream_conflict = true;
                localComp.upstream_template = uCode;
                localComp.upstream_version = newVersionTag;
                conflictCount++;
            }
            merged.push(localComp);
        }
    }

    for (const remainingLocal of localMap.values()) {
        merged.push(remainingLocal);
        preservedCount++;
    }

    return { components: merged, conflictCount, upgradedCount, preservedCount };
}

export async function syncRepoAssetsToR2(dal: any, themeSlug: string, assets: any[], executionCtx: any) {
    const bucket = dal.bucket;
    const backupBucket = dal.backupBucket;
    if (!bucket || typeof bucket.put !== 'function') return;
    for (const asset of assets) {
        const cleanPath = asset.file_path.replace(/^\/+/, '');
        const r2Key = `theme/${themeSlug}/${cleanPath}`;
        const mime = asset.content_type || (cleanPath.endsWith('.css') ? 'text/css' : (cleanPath.endsWith('.js') ? 'application/javascript' : 'text/plain'));
        await bucket.put(r2Key, asset.content, { httpMetadata: { contentType: mime } });
        if (backupBucket && typeof backupBucket.put === 'function') {
            executionCtx?.waitUntil(backupBucket.put(r2Key, asset.content, { httpMetadata: { contentType: mime } }));
        }
    }
}
