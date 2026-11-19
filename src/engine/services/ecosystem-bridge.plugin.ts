import type { IPluginEngine, WalnutPlugin } from '../types';
import { createHookContext, nanoId } from '../kernel';
import {
    buildRotateEcosystemTokenStatements,
    computeTokenSha256,
    findRecentEcosystemContentBySourceId
} from '../core/dal';
import { assertSiteAdmin } from './common.helper';

export const ALLOWED_ECOSYSTEM_APPS = new Set(['grain']);
export const ECOSYSTEM_APP_HEADERS = ['X-Ecosystem-App', ['X', 'Walnut', 'Ecosystem', 'App'].join('-')] as const;

interface OneTimeCodeEntry {
    siteId: string;
    app: string;
    userId: string;
    expiresAt: number;
}

const ONE_TIME_CODE_TTL_MS = 60 * 1000;
const oneTimeCodeStore = new Map<string, OneTimeCodeEntry>();

function pruneExpiredCodes(): void {
    const now = Date.now();
    for (const [code, entry] of oneTimeCodeStore.entries()) {
        if (now > entry.expiresAt) {
            oneTimeCodeStore.delete(code);
        }
    }
}

export function issueEcosystemOneTimeCode(siteId: string, app: string, userId: string): { code: string; expiresInSeconds: number } {
    pruneExpiredCodes();
    const code = nanoId('wn_code_', 24);
    oneTimeCodeStore.set(code, {
        siteId,
        app,
        userId,
        expiresAt: Date.now() + ONE_TIME_CODE_TTL_MS
    });
    return { code, expiresInSeconds: 60 };
}

export function consumeEcosystemOneTimeCode(code: string, app?: string): OneTimeCodeEntry | null {
    pruneExpiredCodes();
    const entry = oneTimeCodeStore.get(code);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
        oneTimeCodeStore.delete(code);
        return null;
    }
    if (app && entry.app !== app) {
        return null;
    }
    oneTimeCodeStore.delete(code);
    return entry;
}

export interface LooseEcosystemSyncInput {
    siteId?: string;
    app: string;
    payload: Record<string, any>;
}

function normalizeLoosePayload(app: string, raw: Record<string, any>) {
    const target: 'micro' | 'article' = raw.target === 'article' || raw.mode === 'article' ? 'article' : 'micro';
    const rawTitle = typeof raw.title === 'string' && raw.title.trim()
        ? raw.title.trim()
        : (typeof raw.bookTitle === 'string' && raw.bookTitle.trim() ? raw.bookTitle.trim() : `Ecosystem Note (${app})`);
    const title = rawTitle.slice(0, 200);

    const sourceId = typeof raw.source_id === 'string' && raw.source_id.trim()
        ? raw.source_id.trim().slice(0, 128)
        : undefined;

    const rawTags: string[] = Array.isArray(raw.tags)
        ? raw.tags.filter((t: any) => typeof t === 'string' && t.trim()).map((t: string) => t.trim().slice(0, 40))
        : [];
    if (!rawTags.includes('ecosystem')) {
        rawTags.push('ecosystem');
    }

    const textCandidate = [raw.markdown, raw.content, raw.text, raw.note]
        .find((v) => typeof v === 'string' && v.trim().length > 0);

    let markdown = '';
    if (textCandidate) {
        markdown = String(textCandidate).trim().slice(0, 120000);
        if (Array.isArray(raw.highlights) && raw.highlights.length > 0) {
            const hlLines = raw.highlights
                .slice(0, 100)
                .filter((h: any) => h && typeof h.text === 'string' && h.text.trim())
                .map((h: any) => `> ${h.chapter ? `**[${h.chapter}]** ` : ''}${String(h.text).trim()}`);
            if (hlLines.length > 0) {
                markdown += '\n\n' + hlLines.join('\n\n');
            }
        }
    } else {
        markdown = '```json\n' + JSON.stringify(raw, null, 2).slice(0, 120000) + '\n```';
    }

    if (target === 'micro' && !markdown.includes('#ecosystem')) {
        markdown = `${markdown}\n\n#ecosystem`;
    }

    return { target, title, sourceId, tags: rawTags, markdown };
}

export const ecosystemBridgePlugin: WalnutPlugin = {
    name: 'ecosystem:bridge',
    version: '2.0.0',
    tier: 'community',

    setup(engine: IPluginEngine): void {
        engine.registerService<{ siteId?: string; app: string }, { success: boolean; code: string; expiresInSeconds: number; app: string }>(
            'ECOSYSTEM_ISSUE_CODE',
            async (ctx) => {
                if (!ctx.user) throw new Error('UNAUTHORIZED');
                const app = String(ctx.data?.app || 'grain').trim();
                if (!ALLOWED_ECOSYSTEM_APPS.has(app)) {
                    throw new Error('UNSUPPORTED_ECOSYSTEM_APP');
                }
                const siteId = ctx.data?.siteId || ctx.siteId || 'site_default';
                await assertSiteAdmin(ctx.dal, siteId, ctx.user);
                const issued = issueEcosystemOneTimeCode(siteId, app, ctx.user.id);
                return { success: true, app, ...issued };
            }
        );

        engine.registerService<{ code: string; app?: string }, { success: boolean; token: string; token_type: 'ecosystem'; siteId: string; app: string }>(
            'ECOSYSTEM_EXCHANGE_TOKEN',
            async (ctx) => {
                const code = String(ctx.data?.code || '').trim();
                const entry = consumeEcosystemOneTimeCode(code, ctx.data?.app);
                if (!entry) {
                    throw new Error('INVALID_OR_EXPIRED_CODE');
                }
                const tokenId = nanoId('eco', 16);
                const rawToken = nanoId('wn_eco_', 40);
                const tokenHash = await computeTokenSha256(rawToken);
                await ctx.dal.batch(
                    buildRotateEcosystemTokenStatements(ctx.dal.db, {
                        id: tokenId,
                        siteId: entry.siteId,
                        name: `Ecosystem (${entry.app})`,
                        tokenHash,
                        createdBy: entry.userId
                    })
                );
                return {
                    success: true,
                    token: rawToken,
                    token_type: 'ecosystem',
                    siteId: entry.siteId,
                    app: entry.app
                };
            }
        );

        engine.registerService<LooseEcosystemSyncInput, { success: boolean; target: 'micro' | 'article'; status: 'published' | 'draft'; entityId: string; overwritten: boolean }>(
            'ECOSYSTEM_LOOSE_SYNC',
            async (ctx) => {
                const { app, payload } = ctx.data;
                if (!ALLOWED_ECOSYSTEM_APPS.has(app)) {
                    throw new Error('FORBIDDEN_ECOSYSTEM_APP');
                }
                if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
                    throw new Error('INVALID_JSON_OBJECT');
                }

                const siteId = ctx.data.siteId || ctx.siteId || 'site_default';
                const parsed = normalizeLoosePayload(app, payload);

                let existing: { id: string; slug: string } | null = null;
                if (parsed.sourceId) {
                    existing = await findRecentEcosystemContentBySourceId(ctx.dal.db, siteId, parsed.target, parsed.sourceId);
                }

                const ecoMeta = {
                    eco_app: app,
                    ...(parsed.sourceId ? { eco_source_id: parsed.sourceId } : {}),
                    tags: parsed.tags
                };

                const actorUser = ctx.user || {
                    id: 'ecosystem:bridge',
                    username: `eco-${app}`,
                    email: `${app}@ecosystem.local`,
                    global_role: 'superadmin' as const,
                    site_role: 'admin' as const,
                    auth_provider: 'session' as const
                };

                if (parsed.target === 'micro') {
                    const microCtx = createHookContext({
                        action: 'MICRO_SAVE',
                        siteId,
                        env: ctx.env,
                        executionCtx: ctx.executionCtx,
                        dal: ctx.dal,
                        user: actorUser,
                        data: {
                            id: existing?.id,
                            isEdit: !!existing,
                            siteId,
                            title: parsed.title,
                            contentRaw: parsed.markdown,
                            status: 'published',
                            progress: 'seedling',
                            metadata: { ...ecoMeta, folder: 'ecosystem' }
                        }
                    });
                    const res: any = await engine.runPipeline(microCtx);
                    return {
                        success: true,
                        target: 'micro',
                        status: 'published',
                        entityId: res?.id || res?.microId || res?.nodeId || existing?.id || '',
                        overwritten: !!existing
                    };
                }

                // Force synced articles to unpublished drafts with auto-generated slugs so external bridges cannot hijack live routes.
                const autoSlug = existing?.slug || `eco-${app}-${Date.now().toString(36)}-${nanoId('', 6).toLowerCase()}`;
                const artCtx = createHookContext({
                    action: 'ARTICLE_SAVE',
                    siteId,
                    env: ctx.env,
                    executionCtx: ctx.executionCtx,
                    dal: ctx.dal,
                    user: actorUser,
                    data: {
                        id: existing?.id,
                        isEdit: !!existing,
                        siteId,
                        title: parsed.title,
                        slug: autoSlug,
                        contentRaw: parsed.markdown,
                        status: 'draft',
                        visibility: 'private',
                        metadata: { ...ecoMeta, folder: 'ecosystem' }
                    }
                });
                const res: any = await engine.runPipeline(artCtx);
                return {
                    success: true,
                    target: 'article',
                    status: 'draft',
                    entityId: res?.id || res?.articleId || res?.nodeId || existing?.id || '',
                    overwritten: !!existing
                };
            }
        );
    }
};
