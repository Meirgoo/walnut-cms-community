import { Hono } from 'hono';
import type { AppHonoEnv } from '../../engine';
import {
    getPagesListData,
    findPagesListBundle,
    getPageEditorInitData,
    findNodeById,
    findLatestActiveVersion,
    findEntityVersions,
    getTranslationGroupsData,
    findSchemasBySite,
    findDatasetCollectionsBySite,
    getAdminLocale,
    buildLocalizedRoutePath,
    parseJson,
    isFeatureEnabled,
    t
} from '../../engine';
import { PagesListPage, PageRow } from '../pages/PagesList';
import { PageEditorPage } from '../pages/PageEditor';
import {
    getAdminRouteContext,
    parseNodeMetadata,
    extractNodeFolder,
    runAdminPipeline,
    handleSaveNode,
    createDeleteRouteHandler,
    createBatchSoftDeleteHandler,
    createExportSelectedHandler,
    createBatchImportHandler
} from './common';

export const pagesRouter = new Hono<AppHonoEnv>();

pagesRouter.get('/', async (c) => {
    const activeSiteId = c.get('siteId') || 'site_default';
    const tDbStart = performance.now();
    const {
        pages,
        templates,
        trashCount,
        sites,
        themeComponents,
        datasetCollections,
        datasetSchemas,
        siteTaxonomy,
        recentMedia,
        externalExtensions,
        slotQuotas
    } = await findPagesListBundle(c.env.DB, activeSiteId);
    c.header('Server-Timing', `db;dur=${(performance.now() - tDbStart).toFixed(2)}`);
    const ctx = await getAdminRouteContext(c, sites);

    const pageMap = new Map<string, any>(pages.map(p => [p.id, p]));

    const computePageRoute = (p: any): string => {
        const raw = (p.slug || '').trim();
        if (raw === '/' || raw === 'index') return '/';
        const segments: string[] = [];
        let curr: any = p;
        const visited = new Set<string>();
        while (curr && !visited.has(curr.id)) {
            visited.add(curr.id);
            const s = (curr.slug || '').trim().replace(/^\/+|\/+$/g, '');
            if (s && s !== 'index') segments.unshift(s);
            curr = curr.parent_id ? pageMap.get(curr.parent_id) : null;
        }
        return segments.length ? `/${segments.join('/')}` : '/';
    };

    const activeSite = sites.find((s: any) => s.id === activeSiteId) || sites[0];
    const defaultLocale = activeSite?.default_locale || 'zh-CN';

    const pageRows: PageRow[] = pages.map(p => {
        const metaObj = parseNodeMetadata(p.metadata);
        const tplId = metaObj.template_page_id || metaObj.template_id || metaObj.template_slug || '';
        const tplNode = templates.find(t => t.id === tplId || t.slug === tplId)
            || pages.find(tp => tp.id === tplId || tp.slug === tplId);
        const tplLabel = tplNode ? tplNode.title : '-';
        const pageType = metaObj.page_type || 'single';
        const pageLocale = p.locale || defaultLocale;
        const baseRoute = computePageRoute(p);
        const normRoute = pageType === 'template'
            ? baseRoute
            : buildLocalizedRoutePath(baseRoute, pageLocale, defaultLocale);

        return {
            id: p.id,
            slug: p.slug,
            route_path: normRoute,
            title: p.title,
            page_type: pageType,
            template_title: tplLabel,
            locale: pageLocale,
            status: p.status,
            folder: extractNodeFolder(metaObj, p.slug),
            translation_group_id: p.translation_group_id || metaObj.translation_group_id || undefined,
            updated_at: p.updated_at
        };
    });

    return c.html(
        <PagesListPage
            pages={pageRows}
            templates={templates}
            themeComponents={themeComponents}
            datasetCollections={datasetCollections}
            datasetSchemas={datasetSchemas}
            siteTaxonomy={siteTaxonomy}
            recentMedia={recentMedia}
            externalExtensions={externalExtensions}
            slotQuotas={slotQuotas}
            trashCount={trashCount}
            {...ctx}
        />
    );
});

pagesRouter.get('/new', async (c) => {
    const ctx = await getAdminRouteContext(c);
    const tgId = c.req.query('translation_group_id') || '';
    const sourceId = c.req.query('source_id') || '';
    const targetLocale = c.req.query('locale') || '';

    const [initData, translationGroups, sourceNode, sourceVer] = await Promise.all([
        getPageEditorInitData(ctx.db, ctx.activeSiteId),
        getTranslationGroupsData(ctx.db, ctx.activeSiteId),
        sourceId ? findNodeById(ctx.db, sourceId, undefined, ctx.activeSiteId) : Promise.resolve(null),
        sourceId ? findLatestActiveVersion(ctx.db, sourceId) : Promise.resolve(null)
    ]);

    const srcMeta = sourceNode ? parseNodeMetadata(sourceNode.metadata) : {};
    const initialMeta: Record<string, any> = {
        ...(srcMeta.template_page_id ? { template_page_id: srcMeta.template_page_id } : {}),
        ...(srcMeta.page_type ? { page_type: srcMeta.page_type } : {}),
        ...(tgId ? { translation_group_id: tgId } : {})
    };
    const initialContentRaw = sourceVer?.content_raw || (Array.isArray(srcMeta.blocks) ? JSON.stringify(srcMeta.blocks) : '[]');
    const peerTranslations = tgId
        ? initData.existingPages
            .filter((p: any) => (p.translation_group_id || parseNodeMetadata(p.metadata).translation_group_id) === tgId)
            .map((p: any) => ({ id: p.id, title: p.title, slug: p.slug, locale: p.locale || 'zh-CN' }))
        : [];

    return c.html(
        <PageEditorPage
            node={{
                type: 'page',
                locale: targetLocale || (sourceNode?.locale === 'zh-CN' ? 'en-US' : 'zh-CN'),
                summary: '',
                content_raw: initialContentRaw,
                metadata: JSON.stringify(initialMeta)
            }}
            isEdit={false}
            templateSinglePages={initData.templatePages}
            translationGroups={translationGroups}
            peerTranslations={peerTranslations}
            {...initData}
            {...ctx}
        />
    );
});

pagesRouter.get('/edit/:id', async (c) => {
    const id = c.req.param('id');
    const ctx = await getAdminRouteContext(c);

    const pageNode = await findNodeById(ctx.db, id, undefined, ctx.activeSiteId);
    if (!pageNode) return c.redirect('/admin/pages');
    const [latestVer, versions, initData, translationGroups] = await Promise.all([
        findLatestActiveVersion(ctx.db, id),
        findEntityVersions(ctx.db, 'page', id),
        getPageEditorInitData(ctx.db, ctx.activeSiteId, id),
        getTranslationGroupsData(ctx.db, ctx.activeSiteId)
    ]);

    const curMeta = parseNodeMetadata(pageNode.metadata);
    const tgId = (pageNode as any).translation_group_id || curMeta.translation_group_id || '';
    const peerTranslations = tgId
        ? initData.existingPages
            .filter((p: any) => p.id !== id && (p.translation_group_id || parseNodeMetadata(p.metadata).translation_group_id) === tgId)
            .map((p: any) => ({ id: p.id, title: p.title, slug: p.slug, locale: p.locale || 'zh-CN' }))
        : [];

    return c.html(
        <PageEditorPage
            node={pageNode}
            latestVersion={latestVer}
            versions={versions}
            isEdit={true}
            templateSinglePages={initData.templatePages}
            translationGroups={translationGroups}
            peerTranslations={peerTranslations}
            {...initData}
            {...ctx}
        />
    );
});

pagesRouter.post('/api/save', handleSaveNode);

pagesRouter.post('/api/set-default-template', async (c) => {
    const formData = await c.req.parseBody();
    const siteId = (formData.site_id as string) || c.get('siteId') || '';
    const templateId = (formData.template_id as string) || '';
    const templateSlug = (formData.template_slug as string) || '';
    const locale = getAdminLocale(c);

    if (!siteId) return c.json({ success: false, error: t(locale, 'common.missing_site_id') }, 400);

    await runAdminPipeline(c, 'PAGE_SET_DEFAULT_TEMPLATE', { siteId, templateId, templateSlug });
    return c.json({ success: true, message: t(locale, 'pages.default_template_set') });
});

pagesRouter.delete('/api/delete/:id', createDeleteRouteHandler('PAGE_DELETE'));

pagesRouter.post('/api/batch-delete', createBatchSoftDeleteHandler());

pagesRouter.get('/api/bulk-landing-options', async (c) => {
    if (!isFeatureEnabled('bulkLanding', c.env)) return c.notFound();
    const ctx = await getAdminRouteContext(c);
    const [{ pages }, schemas, collections] = await Promise.all([
        getPagesListData(ctx.db, ctx.activeSiteId),
        findSchemasBySite(ctx.db, ctx.activeSiteId),
        findDatasetCollectionsBySite(ctx.db, ctx.activeSiteId)
    ]);

    const masters: Array<{ id: string; title: string; slug: string }> = [];
    const blueprints: Array<{ id: string; title: string; slug: string }> = [];
    for (const p of pages) {
        const meta = parseNodeMetadata(p.metadata);
        if (meta.page_type !== 'template') continue;
        const blks = Array.isArray(meta.blocks) ? meta.blocks : parseJson<any[]>((p as any).content_raw, []);
        const hasSlot = Array.isArray(blks) && blks.some((b: any) => b && (b.component === '@slot:page_content' || b.component === 'slot:page_content' || b.id === '@slot:page_content'));
        const item = { id: p.id, title: p.title, slug: p.slug };
        if (hasSlot) masters.push(item);
        else blueprints.push(item);
    }

    const dsSlugSet = new Map<string, string>();
    for (const col of collections || []) {
        if (col.slug) dsSlugSet.set(col.slug, col.name || col.slug);
    }
    for (const s of schemas || []) {
        if (s.slug && !dsSlugSet.has(s.slug)) dsSlugSet.set(s.slug, s.title || s.slug);
    }
    const datasetCollections = Array.from(dsSlugSet.entries()).map(([slug, title]) => ({ slug, title }));

    return c.json({ success: true, masters, blueprints, datasets: datasetCollections });
});

pagesRouter.post('/api/bulk-landing', async (c) => {
    if (!isFeatureEnabled('bulkLanding', c.env)) return c.notFound();
    const siteId = c.get('siteId') || 'site_default';

    try {
        const body = await c.req.json();
        const result = await runAdminPipeline(c, 'BULK_LANDING_GENERATE', {
            siteId,
            templatePageId: body.templatePageId || body.template_page_id,
            masterTemplateId: body.masterTemplateId || body.master_template_id,
            blueprintPageId: body.blueprintPageId || body.blueprint_page_id,
            datasetSchemaSlug: body.datasetSchemaSlug || body.dataset_schema_slug,
            folder: body.folder,
            parentId: body.parentId || body.parent_id || null,
            locale: body.locale,
            status: body.status || 'published',
            slugPattern: body.slugPattern || body.slug_pattern,
            titlePattern: body.titlePattern || body.title_pattern,
            summaryPattern: body.summaryPattern || body.summary_pattern,
            contentTemplate: body.contentTemplate || body.content_template,
            variablesList: body.variablesList || body.variables_list || [],
            skipConflicts: body.skipConflicts !== false
        });

        return c.json({ success: true, data: result, ...result });
    } catch (err: any) {
        const msg = String(err?.message || 'Failed to generate bulk landing pages');
        const status = msg.includes('LICENSE_') || msg.includes('ACTION_NOT_REGISTERED') || msg.includes('UNAUTHORIZED') ? 403 : 400;
        return c.json({ success: false, error: msg }, status);
    }
});

pagesRouter.get('/api/export-selected', createExportSelectedHandler('page'));
pagesRouter.post('/api/batch-import', createBatchImportHandler('page'));
