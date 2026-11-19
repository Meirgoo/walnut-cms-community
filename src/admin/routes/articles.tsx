import { Hono } from 'hono';
import type { AppHonoEnv } from '../../engine';
import {
    findArticlesListBundle,
    findNewArticleEditorDependencies,
    findNodeById,
    getContentEditorInitData,
    findPublishedTheme,
    parseJson,
    getTranslationGroupsData,
    getAdminLocale,
    t
} from '../../engine';
import { ArtifactListPage, ArticleRow } from '../pages/ArtifactList';
import { ContentEditorPage } from '../pages/ContentEditor';
import {
    getAdminRouteContext,
    parseNodeMetadata,
    extractNodeFolder,
    renderStatusBadge,
    runAdminPipeline,
    handleSaveNode,
    createDeleteRouteHandler,
    createBatchSoftDeleteHandler,
    createBatchFolderHandler,
    createExportSelectedHandler,
    createBatchImportHandler
} from './common';

export const articlesRouter = new Hono<AppHonoEnv>();

articlesRouter.get('/trash', (c) => {
    const search = new URL(c.req.url).search || '';
    return c.redirect(`/admin/trash${search}`);
});

articlesRouter.get('/', async (c) => {
    const activeSiteId = c.get('siteId') || 'site_default';
    const tDbStart = performance.now();
    const { articles: nodes, trashCount, sites } = await findArticlesListBundle(c.env.DB, activeSiteId);
    c.header('Server-Timing', `db;dur=${(performance.now() - tDbStart).toFixed(2)}`);
    const ctx = await getAdminRouteContext(c, sites);

    const articleRows: ArticleRow[] = nodes.map(node => {
        const metaObj = parseNodeMetadata(node.metadata);
        return {
            id: node.id,
            slug: node.slug,
            type: node.type,
            title: node.title,
            locale: node.locale || 'zh-CN',
            maturity: node.maturity,
            status: node.status,
            tags: metaObj.tags || metaObj.keywords || [],
            folder: extractNodeFolder(metaObj, node.slug),
            translation_group_id: node.translation_group_id || undefined,
            translation_group_name: node.translation_group_name || undefined,
            updated_at: node.updated_at
        };
    });

    return c.html(
        <ArtifactListPage
            nodes={articleRows}
            trashCount={trashCount}
            {...ctx}
        />
    );
});

articlesRouter.get('/new/:type', async (c) => {
    const ctx = await getAdminRouteContext(c);
    const type = c.req.param('type');

    const [deps, theme] = await Promise.all([
        findNewArticleEditorDependencies(ctx.db, ctx.activeSiteId),
        findPublishedTheme(ctx.db, ctx.activeSiteId)
    ]);
    const themeMeta = parseJson<Record<string, any>>(theme?.metadata, {});

    return c.html(
        <ContentEditorPage
            type={type || 'article'}
            node={{ type: (type as any) || 'article' }}
            isEdit={false}
            peerTranslations={[]}
            mdComponents={themeMeta.md_components || {}}
            {...deps}
            {...ctx}
        />
    );
});

articlesRouter.get('/edit/:id', async (c) => {
    const id = c.req.param('id');
    const ctx = await getAdminRouteContext(c);

    const node = await findNodeById(ctx.db, id);
    if (!node) return c.redirect('/admin/articles');

    const [deps, theme] = await Promise.all([
        getContentEditorInitData(ctx.db, ctx.activeSiteId, node),
        findPublishedTheme(ctx.db, ctx.activeSiteId)
    ]);
    const themeMeta = parseJson<Record<string, any>>(theme?.metadata, {});

    return c.html(
        <ContentEditorPage
            type={node.type || 'article'}
            node={node}
            isEdit={true}
            mdComponents={themeMeta.md_components || {}}
            {...deps}
            {...ctx}
        />
    );
});

articlesRouter.post('/api/save', handleSaveNode);

articlesRouter.delete('/api/delete/:id', createDeleteRouteHandler('CONTENT_DELETE'));

articlesRouter.delete('/api/version/:id', async (c) => {
    const versionId = c.req.param('id');
    const nodeId = c.req.query('node_id') || '';

    try {
        await runAdminPipeline(c, 'VERSION_DELETE', { nodeId, versionId });
        return c.body(null, 200);
    } catch (err: any) {
        return c.html(await renderStatusBadge(err.message, 'text-red-500'), 400);
    }
});

articlesRouter.post('/api/batch-soft-delete', createBatchSoftDeleteHandler());
articlesRouter.post('/api/batch-delete', createBatchSoftDeleteHandler());

articlesRouter.post('/api/batch-folder', createBatchFolderHandler());

articlesRouter.get('/api/translation-groups', async (c) => c.json({ groups: await getTranslationGroupsData(c.env.DB, c.get('siteId') || '') }));

articlesRouter.post('/api/translation-groups/create', async (c) => {
    const siteId = c.get('siteId') || '';
    const name = String((await c.req.parseBody()).name || '').trim();
    if (!name) return c.json({ success: false, error: t(getAdminLocale(c), 'editor.group_name_required') }, 400);
    const { id } = await runAdminPipeline<any, { id: string }>(c, 'TRANSLATION_GROUP_CREATE', { siteId, name });
    return c.json({ success: true, group: { id, name } });
});

articlesRouter.delete('/api/translation-groups/delete/:id', async (c) => {
    await runAdminPipeline(c, 'TRANSLATION_GROUP_DELETE', { siteId: c.get('siteId') || '', groupId: c.req.param('id') });
    return c.json({ success: true });
});

articlesRouter.post('/api/translation-groups/join', async (c) => {
    const body = await c.req.parseBody();
    if (!body.node_id || !body.group_id) return c.json({ success: false, error: t(getAdminLocale(c), 'common.missing_params') }, 400);
    await runAdminPipeline(c, 'TRANSLATION_GROUP_JOIN', { nodeId: body.node_id, groupId: body.group_id });
    return c.json({ success: true });
});

articlesRouter.post('/api/translation-groups/leave', async (c) => {
    const body = await c.req.parseBody();
    if (!body.node_id) return c.json({ success: false, error: t(getAdminLocale(c), 'common.missing_params') }, 400);
    await runAdminPipeline(c, 'TRANSLATION_GROUP_LEAVE', { nodeId: body.node_id });
    return c.json({ success: true });
});

articlesRouter.get('/api/export-selected', createExportSelectedHandler('article'));
articlesRouter.post('/api/batch-import', createBatchImportHandler('article'));

articlesRouter.post('/api/save-chunk', async (c) => {
    const siteId = c.get('siteId') || 'site_default';
    try {
        const body = await c.req.json();
        const res = await runAdminPipeline<any, { id: string; versionId: string; chunkMode: string }>(c, 'ARTICLE_CHUNK_SAVE', {
            siteId,
            articleId: body.articleId || body.id,
            versionId: body.versionId,
            chunkMode: body.chunkMode || 'init',
            chunkText: String(body.chunkText || ''),
            title: body.title,
            slug: body.slug,
            summary: body.summary,
            locale: body.locale,
            status: body.status
        });
        return c.json({ success: true, ...res });
    } catch (err: any) {
        return c.json({ success: false, error: err?.message || 'Chunk save failed' }, 400);
    }
});
