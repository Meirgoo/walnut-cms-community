import { Hono } from 'hono';
import type { AppHonoEnv } from '../../engine';
import {
    getMicrosListData,
    createHookContext,
    findNodeById,
    findLatestActiveVersion,
    getContentEditorInitData,
    findNewArticleEditorDependencies,
    findPublishedTheme,
    parseJson,
    t
} from '../../engine';
import { MicroListPage, MicroRow } from '../pages/MicroContentList';
import { ContentEditorPage } from '../pages/ContentEditor';
import {
    getAdminRouteContext,
    parseNodeMetadata,
    extractNodeFolder,
    handleSaveNode,
    createDeleteRouteHandler,
    createBatchSoftDeleteHandler,
    createExportSelectedHandler,
    createBatchImportHandler
} from './common';

export const microsRouter = new Hono<AppHonoEnv>();

microsRouter.get('/', async (c) => {
    const ctx = await getAdminRouteContext(c);
    const activeType = c.req.query('type') || 'all';

    const { nodes, trashCount } = await getMicrosListData(ctx.db, ctx.activeSiteId);

    const microRows: MicroRow[] = nodes.map(n => {
        const metaObj = parseNodeMetadata(n.metadata);
        return {
            ...n,
            summary: n.summary || '',
            folder: extractNodeFolder(metaObj, n.slug, '')
        };
    });

    return c.html(
        <MicroListPage
            micros={microRows}
            activeType={activeType}
            trashCount={trashCount}
            {...ctx}
        />
    );
});

microsRouter.get('/new', async (c) => {
    const ctx = await getAdminRouteContext(c);
    const [deps, theme] = await Promise.all([
        findNewArticleEditorDependencies(ctx.db, ctx.activeSiteId),
        findPublishedTheme(ctx.db, ctx.activeSiteId)
    ]);
    const themeMeta = parseJson<Record<string, any>>(theme?.metadata, {});

    return c.html(
        <ContentEditorPage
            type="micro"
            node={{ type: 'micro' }}
            isEdit={false}
            peerTranslations={[]}
            mdComponents={themeMeta.md_components || {}}
            {...deps}
            {...ctx}
        />
    );
});

microsRouter.get('/edit/:id', async (c) => {
    const id = c.req.param('id');
    const ctx = await getAdminRouteContext(c);

    const node = await findNodeById(ctx.db, id, 'micro', ctx.activeSiteId);
    if (!node) return c.redirect('/admin/micros');

    const deps = await getContentEditorInitData(ctx.db, ctx.activeSiteId, node);

    return c.html(
        <ContentEditorPage
            type="micro"
            node={node}
            isEdit={true}
            {...deps}
            {...ctx}
        />
    );
});

microsRouter.post('/api/save', handleSaveNode);

microsRouter.delete('/api/delete/:id', createDeleteRouteHandler('MICRO_DELETE'));

microsRouter.post('/api/batch-delete', createBatchSoftDeleteHandler());

microsRouter.post('/api/convert-to-article/:id', async (c) => {
    const id = c.req.param('id');
    const ctx = await getAdminRouteContext(c);
    const pluginEngine = c.get('pluginEngine');

    try {
        const node = await findNodeById(ctx.db, id, 'micro', ctx.activeSiteId);
        if (!node) {
            return c.json({ success: false, error: t(ctx.locale, 'editor.node_not_found') }, 404);
        }

        const latestVersion = await findLatestActiveVersion(ctx.db, node.id);
        const contentRaw = latestVersion?.content_raw || (node as any).content_raw || '';

        const metaObj = parseNodeMetadata(node.metadata);
        const folder = extractNodeFolder(metaObj, node.slug, 'article');

        const newSlug = `article-${Date.now().toString(36)}`;
        const createArticleCtx = createHookContext({
            action: 'ARTICLE_SAVE',
            data: {
                siteId: ctx.activeSiteId,
                slug: newSlug,
                type: 'article',
                locale: node.locale || 'zh-CN',
                title: node.title || t(ctx.locale, 'articles.untitled'),
                summary: '',
                contentRaw: contentRaw,
                progress: node.progress || node.maturity || '',
                maturity: node.progress || node.maturity || '',
                status: 'draft',
                folder,
                metadata: metaObj,
                commitMessage: 'Converted from micro to article draft',
                isEdit: false
            },
            c,
            siteId: ctx.activeSiteId
        });
        const articleResult = await pluginEngine.runPipeline(createArticleCtx);
        const newArticleId = articleResult?.node?.id || articleResult?.id;

        const updateMicroCtx = createHookContext({
            action: 'MICRO_SAVE',
            data: {
                id: node.id,
                siteId: ctx.activeSiteId,
                slug: node.slug,
                type: 'micro',
                locale: node.locale || 'zh-CN',
                title: node.title,
                contentRaw: contentRaw,
                progress: node.progress || node.maturity || '',
                maturity: (node.progress || node.maturity || '') as any,
                status: 'archived',
                folder,
                metadata: metaObj,
                commitMessage: 'Converted to article draft, original micro archived',
                isEdit: true
            },
            c,
            siteId: ctx.activeSiteId
        });
        await pluginEngine.runPipeline(updateMicroCtx);

        return c.json({ success: true, articleId: newArticleId });
    } catch (e: any) {
        console.error('Failed to convert micro to article:', e);
        return c.json({ success: false, error: e.message || t(ctx.locale, 'common.error') }, 500);
    }
});

microsRouter.get('/api/export-selected', createExportSelectedHandler('micro'));
microsRouter.post('/api/batch-import', createBatchImportHandler('micro'));
