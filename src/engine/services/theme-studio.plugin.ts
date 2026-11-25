import type { HookContext, IPluginEngine } from '../types';
import { markSiteRoutesDirty, nanoId } from '../index';
import {
    buildInsertThemeVersionStatement,
    buildCreateThemeStatement,
    buildUpdateThemeInfoStatement,
    buildUpdateThemeMetadataStatement,
    findThemeById,
    findSiteIdsUsingTheme,
    checkThemeSlugExists
} from '../core/dal';
import {
    computeCodeHash,
    clearConflict,
    resetComp,
    getSiteId
} from './theme-sync.helper';

export async function markThemeSitesDirty(db: any, themeId: string, themeSlug?: string, fallbackSiteId?: string): Promise<void> {
    const siteIds = await findSiteIdsUsingTheme(db, themeId, themeSlug);
    if (fallbackSiteId && !siteIds.includes(fallbackSiteId)) {
        siteIds.push(fallbackSiteId);
    }
    await Promise.all(siteIds.map((sid) => markSiteRoutesDirty(db, sid)));
}

async function assertThemeSlugAvailable(db: any, siteId: string, slug: string): Promise<void> {
    const exists = await checkThemeSlugExists(db, siteId, slug);
    if (exists) throw new Error('SLUG_EXISTS');
}

async function persistNewTheme(
    ctx: HookContext<any>,
    siteId: string,
    slug: string,
    name: string,
    author: string,
    desc: string,
    meta: any,
    commitMsg: string
) {
    const newThemeId = nanoId('theme', 10);
    const initialVersionId = `ver_${newThemeId}_1`;
    const metaJson = JSON.stringify(meta);
    await ctx.dal.batch([
        buildInsertThemeVersionStatement(ctx.dal.db, {
            id: initialVersionId,
            siteId,
            themeId: newThemeId,
            versionNumber: 1,
            versionTag: '1.0.0',
            metadataSnapshot: metaJson,
            commitMessage: commitMsg,
            authorId: ctx.user?.id || 'admin'
        }),
        buildCreateThemeStatement(ctx.dal.db, {
            id: newThemeId,
            siteId,
            slug,
            name,
            author,
            version: '1.0.0',
            description: desc,
            metadataJson: metaJson,
            currentVersionId: initialVersionId
        })
    ]);
    return { id: newThemeId, site_id: siteId, slug, name, version: '1.0.0', metadata: meta };
}

async function mutateThemeComponent(
    ctx: HookContext<any>,
    fn: (targetComp: any, comps: any[], meta: any) => any,
    requireExisting = true
) {
    const siteId = getSiteId(ctx);
    const theme = await findThemeById(ctx.dal.db, ctx.data.themeId, siteId);
    if (!theme) throw new Error('THEME_NOT_FOUND');
    const meta = typeof theme.metadata === 'string' ? JSON.parse(theme.metadata) : (theme.metadata || {});
    const comps: any[] = meta.components || meta.componentNodes || [];
    const key = (ctx.data.slug || '').trim().toLowerCase();
    const targetComp = comps.find((c: any) => (c.slug || c.type || c.id || c.metadata?.slug || c.metadata?.type || '').toLowerCase() === key);
    if (requireExisting && !targetComp) throw new Error('COMPONENT_NOT_FOUND');
    const res = await fn(targetComp, comps, meta);
    meta.components = comps;
    await ctx.dal.batch([buildUpdateThemeMetadataStatement(ctx.dal.db, theme.id, JSON.stringify(meta))]);
    await markThemeSitesDirty(ctx.dal.db, theme.id, theme.slug, siteId);
    return res;
}

export function registerThemeStudioServices(engine: IPluginEngine): void {
    engine.tapBefore('THEME_CREATE', (ctx) => {
        if (!ctx.data?.name || !ctx.data?.slug) throw new Error('THEME_FIELDS_REQUIRED');
    });
    engine.registerService<{
        siteId?: string; name: string; slug: string; author?: string; description?: string;
    }, { success: boolean; theme: any }>('THEME_CREATE', async (ctx) => {
        const siteId = getSiteId(ctx);
        const cleanSlug = ctx.data.slug.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-');
        await assertThemeSlugAvailable(ctx.dal.db, siteId, cleanSlug);

        const starterMetadata = {
            name: ctx.data.name.trim(), slug: cleanSlug, version: '1.0.0',
            author: ctx.data.author?.trim() || ctx.user?.username || 'Admin',
            description: ctx.data.description?.trim() || '',
            templates: [], components: [], tokens: {}, schemas: []
        };

        const theme = await persistNewTheme(ctx, siteId, cleanSlug, ctx.data.name.trim(), starterMetadata.author, starterMetadata.description, starterMetadata, 'Initial release (1.0.0)');
        return { success: true, theme };
    });

    engine.tapBefore('THEME_FORK', (ctx) => {
        if (!ctx.data?.sourceThemeId || !ctx.data?.name || !ctx.data?.slug) {
            throw new Error('THEME_FORK_FIELDS_REQUIRED');
        }
    });
    engine.registerService<{
        siteId?: string; sourceThemeId: string; name: string; slug: string; author?: string; description?: string;
    }, { success: boolean; theme: any }>('THEME_FORK', async (ctx) => {
        const siteId = getSiteId(ctx);
        const cleanSlug = ctx.data.slug.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-');

        const sourceTheme = await findThemeById(ctx.dal.db, ctx.data.sourceThemeId, siteId);
        if (!sourceTheme) throw new Error('THEME_NOT_FOUND');
        await assertThemeSlugAvailable(ctx.dal.db, siteId, cleanSlug);

        const forkMetadata = JSON.parse(JSON.stringify(sourceTheme.metadata || {}));
        forkMetadata.name = ctx.data.name.trim();
        forkMetadata.slug = cleanSlug;
        forkMetadata.version = '1.0.0';
        forkMetadata.author = ctx.data.author?.trim() || ctx.user?.username || sourceTheme.author || 'Admin';
        forkMetadata.description = ctx.data.description !== undefined ? ctx.data.description : (sourceTheme.description || '');
        forkMetadata.forked_from = sourceTheme.id;
        forkMetadata.forked_from_slug = sourceTheme.slug;
        forkMetadata.forked_at = new Date().toISOString();
        delete forkMetadata.repo_config;

        const bucket = ctx.dal.bucket;
        if (bucket && typeof (bucket as any).list === 'function') {
            try {
                const sourcePrefix = `theme/${sourceTheme.slug}/`;
                const listed = await (bucket as any).list({ prefix: sourcePrefix });
                for (const obj of listed.objects || []) {
                    const relPath = obj.key.slice(sourcePrefix.length);
                    const sourceObj = await bucket.get(obj.key);
                    if (sourceObj) {
                        await bucket.put(`theme/${cleanSlug}/${relPath}`, await sourceObj.arrayBuffer(), {
                            httpMetadata: { contentType: sourceObj.httpMetadata?.contentType || 'text/plain' }
                        });
                    }
                }
            } catch {}
        }

        const theme = await persistNewTheme(ctx, siteId, cleanSlug, ctx.data.name.trim(), forkMetadata.author, forkMetadata.description, forkMetadata, `Fork from [${sourceTheme.name}] (${sourceTheme.slug})`);
        return { success: true, theme };
    });

    engine.tapBefore('THEME_UPDATE_METADATA', (ctx) => {
        if (!ctx.data?.themeId) throw new Error('THEME_ID_REQUIRED');
    });
    engine.registerService<{
        siteId?: string;
        themeId: string;
        name?: string;
        slug?: string;
        author?: string;
        description?: string;
    }, { success: boolean; theme: any }>('THEME_UPDATE_METADATA', async (ctx) => {
        const siteId = getSiteId(ctx);
        const theme = await findThemeById(ctx.dal.db, ctx.data.themeId, siteId);
        if (!theme) {
            throw new Error('THEME_NOT_FOUND');
        }

        const meta = typeof theme.metadata === 'string' ? JSON.parse(theme.metadata) : (theme.metadata || {});
        if (ctx.data.name) meta.name = ctx.data.name.trim();
        if (ctx.data.author) meta.author = ctx.data.author.trim();
        if (ctx.data.description !== undefined) meta.description = ctx.data.description;
        if (ctx.data.slug) meta.slug = ctx.data.slug.trim().toLowerCase();
        if ((ctx.data as any).layout_html !== undefined) meta.layout_html = (ctx.data as any).layout_html;

        const metaJson = JSON.stringify(meta);
        await ctx.dal.batch([
            buildUpdateThemeInfoStatement(ctx.dal.db, {
                id: theme.id,
                siteId,
                name: ctx.data.name?.trim(),
                slug: ctx.data.slug?.trim().toLowerCase(),
                author: ctx.data.author?.trim(),
                description: ctx.data.description,
                metadataJson: metaJson
            })
        ]);

        await markThemeSitesDirty(ctx.dal.db, theme.id, theme.slug, siteId);

        return { success: true, theme: { ...theme, ...ctx.data, metadata: meta } };
    });

    engine.tapBefore('THEME_COMPONENT_CREATE', (ctx) => {
        if (!ctx.data?.themeId || !ctx.data?.slug || !ctx.data?.name) {
            throw new Error('COMPONENT_FIELDS_REQUIRED');
        }
    });
    engine.registerService<{
        siteId?: string;
        themeId: string;
        slug: string;
        name: string;
        summary?: string;
        templateHtml: string;
        category?: string;
        icon?: string;
    }, { success: boolean; component: any }>('THEME_COMPONENT_CREATE', async (ctx) => {
        return mutateThemeComponent(ctx, async (_, comps) => {
            const key = ctx.data.slug.trim().toLowerCase();
            if (comps.some((c: any) => (c.slug || c.type) === key)) {
                throw new Error('COMPONENT_EXISTS');
            }
            const code = ctx.data.templateHtml || '';
            const codeHash = await computeCodeHash(code);
            const rawSlots = Array.isArray((ctx.data as any).slots) && (ctx.data as any).slots.length > 0
                ? (ctx.data as any).slots.map(String)
                : ((ctx.data as any).slot ? [String((ctx.data as any).slot)] : ['main']);
            const allowCustomJs = (ctx.data as any).allow_custom_js === true;
            const defaultProps = { ...((ctx.data as any).default_props || {}) };
            if (!allowCustomJs) delete defaultProps.custom_js;
            const newComp = {
                slug: key,
                type: key,
                name: ctx.data.name.trim(),
                summary: ctx.data.summary?.trim() || '',
                slots: rawSlots,
                allow_custom_js: allowCustomJs,
                template_html: code,
                template: code,
                default_props: defaultProps,
                props_schema: (ctx.data as any).props_schema || {},
                ...(Array.isArray((ctx.data as any).data_slots) ? { data_slots: (ctx.data as any).data_slots } : {}),
                category: ctx.data.category || 'custom',
                icon: ctx.data.icon || 'widgets',
                base_hash: codeHash,
                local_hash: codeHash,
                modified_locally: false,
                upstream_conflict: false,
                created_at: new Date().toISOString()
            };
            comps.push(newComp);
            return { success: true, component: newComp };
        }, false);
    });

    ['THEME_COMPONENT_UPDATE', 'THEME_COMPONENT_ACCEPT_UPSTREAM', 'THEME_COMPONENT_DISMISS_CONFLICT'].forEach(act => {
        engine.tapBefore(act, (ctx) => {
            if (!ctx.data?.themeId || !ctx.data?.slug) throw new Error('COMPONENT_FIELDS_REQUIRED');
        });
    });

    engine.registerService<{
        siteId?: string;
        themeId: string;
        slug: string;
        name?: string;
        summary?: string;
        templateHtml?: string;
    }, { success: boolean; component: any }>('THEME_COMPONENT_UPDATE', async (ctx) => {
        return mutateThemeComponent(ctx, async (targetComp) => {
            if (ctx.data.templateHtml !== undefined) {
                const newCode = ctx.data.templateHtml;
                const newHash = await computeCodeHash(newCode);
                if (!targetComp.base_hash) {
                    targetComp.base_hash = targetComp.local_hash || newHash;
                }
                if (newHash !== targetComp.base_hash) {
                    targetComp.modified_locally = true;
                }
                targetComp.template_html = newCode;
                targetComp.template = newCode;
                targetComp.local_hash = newHash;
                if (targetComp.metadata && typeof targetComp.metadata === 'object') {
                    targetComp.metadata.template_html = newCode;
                }
            }
            if (ctx.data.name !== undefined) targetComp.name = ctx.data.name.trim();
            if (ctx.data.summary !== undefined) targetComp.summary = ctx.data.summary.trim();
            if ((ctx.data as any).category !== undefined) targetComp.category = String((ctx.data as any).category).trim();
            if ((ctx.data as any).icon !== undefined) targetComp.icon = String((ctx.data as any).icon).trim();
            if (Array.isArray((ctx.data as any).slots) && (ctx.data as any).slots.length > 0) {
                targetComp.slots = (ctx.data as any).slots.map(String);
            }
            if ((ctx.data as any).allow_custom_js !== undefined) {
                targetComp.allow_custom_js = (ctx.data as any).allow_custom_js === true;
            }
            if ((ctx.data as any).default_props && typeof (ctx.data as any).default_props === 'object') {
                targetComp.default_props = { ...(ctx.data as any).default_props };
            }
            if (targetComp.allow_custom_js !== true) {
                delete targetComp.custom_js;
                if (targetComp.default_props && typeof targetComp.default_props === 'object') {
                    delete targetComp.default_props.custom_js;
                }
            }
            if ((ctx.data as any).props_schema && typeof (ctx.data as any).props_schema === 'object') {
                targetComp.props_schema = (ctx.data as any).props_schema;
            }
            if (Array.isArray((ctx.data as any).data_slots)) {
                targetComp.data_slots = (ctx.data as any).data_slots;
            }
            return { success: true, component: targetComp };
        });
    });

    engine.registerService<{ siteId?: string; themeId: string; slug: string }, { success: boolean; component: any }>('THEME_COMPONENT_ACCEPT_UPSTREAM', (ctx) =>
        mutateThemeComponent(ctx, async (targetComp) => {
            if (targetComp.upstream_template) {
                const uCode = targetComp.upstream_template;
                resetComp(targetComp, uCode, await computeCodeHash(uCode), false);
            } else clearConflict(targetComp);
            return { success: true, component: targetComp };
        })
    );

    engine.registerService<{ siteId?: string; themeId: string; slug: string }, { success: boolean; component: any }>('THEME_COMPONENT_DISMISS_CONFLICT', (ctx) =>
        mutateThemeComponent(ctx, (targetComp) => {
            clearConflict(targetComp);
            return { success: true, component: targetComp };
        })
    );
}
