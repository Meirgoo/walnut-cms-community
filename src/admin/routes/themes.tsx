import { Hono } from 'hono';
import { raw } from 'hono/html';
import type { AppHonoEnv } from '../../engine';
import {
    ThemeManifestZod,
    getThemesManagementData,
    getAdminLocale,
    findThemeById,
    findThemeVersions,
    fetchAsset,
    renderTemplate,
    scanThemeSecurityCode,
    t
} from '../../engine';
import { ThemesListPage } from '../pages/ThemesList';
import { AdminLayout } from '../layout';
import {
    getAdminRouteContext,
    renderStatusBadge,
    runAdminPipeline,
    parseJson
} from './common';

export const themesRouter = new Hono<AppHonoEnv>();

themesRouter.get('/', async (c) => {
    const ctx = await getAdminRouteContext(c);

    const { allThemes, deletedThemes, templateNodes, componentNodes, schemaNodes } = await getThemesManagementData(ctx.db, ctx.activeSiteId);
    const themeNode = (ctx.activeSite?.theme_id ? allThemes.find(th => th.id === ctx.activeSite.theme_id) : undefined) || allThemes[0] || undefined;

    return c.html(
        <ThemesListPage
            themeNode={themeNode}
            allThemes={allThemes}
            deletedThemes={deletedThemes}
            templateNodes={templateNodes}
            componentNodes={componentNodes}
            schemaNodes={schemaNodes}
            {...ctx}
        />
    );
});

themesRouter.post('/api/import', async (c) => {
    const siteId = c.get('siteId') || '';
    const locale = getAdminLocale(c);

    try {
        const body = await c.req.parseBody();
        let jsonStr = (body['theme_json'] as string || '').trim();
        const jsonFile = body['file'] as File;

        if (jsonFile && typeof jsonFile.text === 'function') {
            jsonStr = await jsonFile.text();
        }

        if (!jsonStr) {
            return c.html(await renderStatusBadge(t(locale, 'themes.invalid_json_file'), 'text-red-600'), 400);
        }

        const scanResult = scanThemeSecurityCode(jsonStr);
        if (!scanResult.safe) {
            return c.html(await renderStatusBadge(t(locale, 'themes.threat_intercepted', { threat: scanResult.matched || '' }), 'text-red-600'), 403);
        }

        const pkg = JSON.parse(jsonStr);
        await runAdminPipeline<
            { pkg: Record<string, any> },
            { themeNodeId: string; success: boolean }
        >(c, 'THEME_IMPORT', { pkg }, siteId);

        c.header('HX-Refresh', 'true');
        return c.html(await renderStatusBadge(t(locale, 'themes.import_success'), 'text-emerald-700'));
    } catch (e: any) {
        return c.html(await renderStatusBadge(t(locale, 'themes.import_failed', { reason: e.message || 'Error' }), 'text-red-600'), 400);
    }
});

const handleChunkApi = (c: any, fn: () => Promise<any>) => fn().then(res => c.json(res)).catch((e: any) => c.json({ error: e.message || 'CHUNK_ERROR' }, e.status || 500));

themesRouter.post('/api/chunk/init', (c) => handleChunkApi(c, async () => {
    const siteId = c.get('siteId') || '';
    const body = await c.req.json<any>();
    const manifestParsed = ThemeManifestZod.safeParse(body.manifest);
    if (!manifestParsed.success) throw { message: 'INVALID_MANIFEST', status: 400 };
    const manifest = manifestParsed.data;
    const scanName = scanThemeSecurityCode(manifest.name + (manifest.description || ''));
    if (!scanName.safe) throw { message: 'UNSAFE_THEME_CODE', status: 403 };

    const { themeNodeId } = await runAdminPipeline<
        { siteId: string; themeSlug: string; themeTitle: string; themeSummary: string; metadataJson: string },
        { themeNodeId: string; success: boolean }
    >(c, 'THEME_CHUNK_INIT', {
        siteId, themeSlug: manifest.id, themeTitle: manifest.name, themeSummary: manifest.description || '',
        metadataJson: JSON.stringify({ ...manifest, tokens: body.tokens || {} })
    }, siteId);
    return { success: true, themeId: manifest.id, themeNodeId };
}));

themesRouter.post('/api/chunk/asset', (c) => handleChunkApi(c, async () => {
    const body = await c.req.json<any>();
    const themeId = body.theme_id?.replace(/[^a-zA-Z0-9_-]/g, '') || 'theme';
    const cleanPath = (body.file_path || '').replace(/^\/+/, '').replace(/\.\./g, '');
    if (!cleanPath) throw { message: 'INVALID_PATH', status: 400 };

    // Only store static browser assets in R2; HTML templates and config JSON belong in D1.
    if (!cleanPath.startsWith('assets/') || /\.(html|json)$/i.test(cleanPath)) {
        return { success: true, path: cleanPath, skipped: true };
    }

    if (/\.(js|mjs|html|svg)$/i.test(cleanPath)) {
        const textToScan = body.is_base64 ? atob(body.content) : body.content;
        const scan = scanThemeSecurityCode(textToScan);
        if (!scan.safe) throw { message: 'UNSAFE_ASSET_CODE', status: 403 };
    }
    await runAdminPipeline(c, 'THEME_CHUNK_ASSET', { themeSlug: themeId, relPath: cleanPath, content: body.content, isBase64: body.is_base64, contentType: body.content_type });
    return { success: true, path: cleanPath };
}));

themesRouter.post('/api/chunk/blocks', (c) => handleChunkApi(c, async () => {
    const siteId = c.get('siteId') || '';
    const body = await c.req.json<any>();
    const { count } = await runAdminPipeline<
        { siteId: string; components?: any[]; templates?: any[]; schemas?: any[] },
        { count: number; success: boolean }
    >(c, 'THEME_CHUNK_BLOCKS', { siteId, components: body.components, templates: body.templates, schemas: body.schemas }, siteId);
    return { success: true, count };
}));

themesRouter.post('/api/chunk/finish', (c) => handleChunkApi(c, async () => {
    const siteId = c.get('siteId') || '';
    const body = await c.req.json<any>();
    await runAdminPipeline(c, 'THEME_CHUNK_FINISH', { siteId, themeSlug: body.theme_id, activate: body.activate }, siteId);
    return { success: true };
}));

// Escape non-ASCII characters as \uXXXX because HTTP headers (e.g. HX-Trigger) must be Latin-1 safe.
function asciiSafeJson(obj: any): string {
    return JSON.stringify(obj).replace(/[\u007f-\uffff]/g, (c) => '\\u' + ('0000' + c.charCodeAt(0).toString(16)).slice(-4));
}

async function handleThemeAction(
    c: any,
    action: string,
    dataOrGetter: Record<string, any> | ((siteId: string) => Record<string, any> | Promise<Record<string, any>>),
    successMsgOrKey: string,
    opts: { isKey?: boolean; emptyOnSuccess?: boolean; noRefresh?: boolean } = {}
) {
    const siteId = c.get('siteId') || '';
    const locale = getAdminLocale(c);
    try {
        const data = typeof dataOrGetter === 'function' ? await dataOrGetter(siteId) : dataOrGetter;
        await runAdminPipeline(c, action, data, siteId);
        if (opts.emptyOnSuccess) {
            return c.body(null, 200);
        }
        const msg = (opts.isKey ?? true) ? t(locale, successMsgOrKey) : successMsgOrKey;
        if (opts.noRefresh) {
            c.header('HX-Trigger', asciiSafeJson({ showToast: { message: msg, type: 'success' } }));
            return c.body(null, 200);
        }
        c.header('HX-Refresh', 'true');
        return c.html(await renderStatusBadge(msg, 'text-emerald-700'));
    } catch (e: any) {
        const failKey = (opts.isKey ?? true) ? successMsgOrKey.replace(/_success$/, '_failed') : '';
        const errMsg = failKey ? t(locale, failKey, { reason: e.message }) : (e.message || t(locale, 'common.error'));
        if (opts.noRefresh) {
            c.header('HX-Trigger', asciiSafeJson({ showToast: { message: errMsg, type: 'error' } }));
            return c.text(errMsg, 400);
        }
        return c.html(await renderStatusBadge(errMsg, 'text-red-600 text-xs'), 400);
    }
}

themesRouter.post('/api/activate/:id', (c) =>
    handleThemeAction(c, 'THEME_ACTIVATE', { themeId: c.req.param('id') }, 'themes.activate_success')
);

themesRouter.delete('/api/template/:id', (c) =>
    handleThemeAction(c, 'TEMPLATE_DELETE', (siteId) => ({ siteId, templateId: c.req.param('id') }), 'themes.delete_failed', { emptyOnSuccess: true })
);

themesRouter.delete('/api/component/:id', (c) =>
    handleThemeAction(c, 'COMPONENT_DELETE', (siteId) => ({ siteId, componentId: c.req.param('id') }), 'themes.delete_failed', { emptyOnSuccess: true })
);

themesRouter.post('/api/repo-import', async (c) => {
    const siteId = c.get('siteId') || '';
    const locale = getAdminLocale(c);
    try {
        const body = await c.req.json<any>();
        const result = await runAdminPipeline<
            { siteId?: string; repoUrl: string; branch?: string; token?: string; activate?: boolean },
            { success: boolean; themeId: string; themeNodeId: string; version: string }
        >(c, 'THEME_REPO_IMPORT', {
            siteId,
            repoUrl: body.repo_url || body.repoUrl,
            branch: body.branch,
            token: body.token,
            activate: !!body.activate
        }, siteId);

        c.header('HX-Refresh', 'true');
        return c.json(result);
    } catch (e: any) {
        return c.json({ error: e.message || t(locale, 'themes.import_failed', { reason: 'Error' }) }, 400);
    }
});

themesRouter.post('/api/update/:id', async (c) => {
    const siteId = c.get('siteId') || '';
    const themeId = c.req.param('id');
    const locale = getAdminLocale(c);
    try {
        const result = await runAdminPipeline<
            { siteId?: string; themeId: string; force?: boolean },
            { success: boolean; updated: boolean; alreadyLatest?: boolean; version: string; versionNumber?: number }
        >(c, 'THEME_UPDATE', { siteId, themeId, force: true }, siteId);

        c.header('HX-Refresh', 'true');
        const msg = result.alreadyLatest
            ? t(locale, 'themes.already_latest', { version: result.version })
            : t(locale, 'themes.update_success', { version: result.version });
        return c.html(await renderStatusBadge(msg, 'text-emerald-700'));
    } catch (e: any) {
        return c.html(await renderStatusBadge(t(locale, 'themes.update_failed', { reason: e.message }), 'text-red-600'), 400);
    }
});

themesRouter.post('/api/rollback/:id', (c) =>
    handleThemeAction(c, 'THEME_ROLLBACK', async (siteId) => {
        const body = (await c.req.parseBody().catch(() => ({}))) as Record<string, any>;
        return {
            siteId,
            themeId: c.req.param('id'),
            targetVersionId: (body['version_id'] as string) || c.req.query('version_id'),
            targetVersionNumber: body['version_number'] ? Number(body['version_number']) : undefined
        };
    }, 'themes.rollback_success')
);

const themeIdAction = (act: string, key: string) => (c: any) =>
    handleThemeAction(c, act, (siteId) => ({ siteId, themeId: c.req.param('id') }), key);

themesRouter.delete('/api/:id', themeIdAction('THEME_DELETE', 'themes.delete_success'));

themesRouter.post('/api/restore/:id', themeIdAction('THEME_RESTORE', 'themes.restore_success'));

themesRouter.delete('/api/purge/:id', themeIdAction('THEME_PURGE', 'themes.purge_success'));

themesRouter.get('/api/versions/:id', async (c) => {
    const ctx = await getAdminRouteContext(c);
    const themeId = c.req.param('id');
    const theme = await findThemeById(ctx.db, themeId, ctx.activeSiteId);
    if (!theme) return c.json({ error: t(ctx.locale, 'themes.theme_not_found_msg') }, 404);
    const versions = await findThemeVersions(ctx.db, theme.id);
    return c.json({ theme, versions });
});

const parseThemeBody = async (c: any, extra?: (b: any) => any) => {
    const b = (await c.req.parseBody().catch(() => ({}))) as Record<string, any>;
    return {
        name: b.name ? String(b.name) : undefined,
        slug: b.slug ? String(b.slug) : undefined,
        author: b.author !== undefined ? String(b.author) : undefined,
        description: b.description !== undefined ? String(b.description) : undefined,
        ...(extra ? extra(b) : {})
    };
};

themesRouter.post('/api/create', (c) =>
    handleThemeAction(c, 'THEME_CREATE', (siteId) => parseThemeBody(c, () => ({ siteId })), 'themes.create_success')
);

themesRouter.post('/api/fork', (c) =>
    handleThemeAction(c, 'THEME_FORK', (siteId) => parseThemeBody(c, (b) => ({ siteId, sourceThemeId: String(b.sourceThemeId || '') })), 'themes.fork_success')
);

themesRouter.post('/api/clone-template-page', async (c) => {
    const siteId = c.get('siteId') || 'site_default';
    const body = await c.req.parseBody();
    const sourceTemplateId = String(body['sourceTemplateId'] || '').trim();
    const title = String(body['title'] || '').trim();
    let slug = String(body['slug'] || '').trim().replace(/^\/+/, '');
    const summary = String(body['summary'] || '').trim();

    const ctx = await getAdminRouteContext(c);
    if (!title || !slug) {
        c.header('HX-Trigger', asciiSafeJson({ showToast: { message: t(ctx.locale, 'errors.missing_required_fields'), type: 'error' } }));
        return c.text(t(ctx.locale, 'errors.missing_required_fields'), 400);
    }
    const { allThemes } = await getThemesManagementData(ctx.db, ctx.activeSiteId || siteId);
    const cleanSourceId = sourceTemplateId.replace(/^template_/, '');

    let sourceTemplate: any = undefined;
    for (const th of allThemes) {
        const meta = parseJson<Record<string, any>>(th.metadata, {});
        const templates = meta.templates || meta.templateNodes || [];
        const match = templates.find((t: any) =>
            t.id === sourceTemplateId || t.slug === sourceTemplateId || t.key === sourceTemplateId ||
            t.id === cleanSourceId || t.slug === cleanSourceId || t.key === cleanSourceId
        );
        if (match) {
            sourceTemplate = match;
            break;
        }
    }

    const blocks = sourceTemplate?.blocks || sourceTemplate?.metadata?.blocks || [];
    const layout = sourceTemplate?.layout || sourceTemplate?.metadata?.layout || 'default';

    try {
        const result = await runAdminPipeline(c, 'PAGE_SAVE', {
            siteId: ctx.activeSiteId || siteId,
            slug,
            type: 'page',
            title,
            summary: summary || sourceTemplate?.summary || sourceTemplate?.description || '',
            contentRaw: JSON.stringify(blocks),
            status: 'published',
            metadata: {
                page_type: 'single',
                layout,
                blocks,
                og_title: title,
                og_description: summary,
            }
        });

        if (result && (result.success !== false && (result.id || result.nodeId || result.success))) {
            c.header('HX-Redirect', '/admin/pages');
            return c.text('OK');
        } else {
            const err = result?.error || 'PAGE_CLONE_FAILED';
            return c.text(err, 400);
        }
    } catch (e: any) {
        console.error('clone-template-page exception:', e);
        return c.text(e.message || 'Error', 500);
    }
});

themesRouter.post('/api/metadata/:id', (c) =>
    handleThemeAction(c, 'THEME_UPDATE_METADATA', (siteId) => parseThemeBody(c, () => ({ siteId, themeId: c.req.param('id') })), 'themes.update_success')
);
