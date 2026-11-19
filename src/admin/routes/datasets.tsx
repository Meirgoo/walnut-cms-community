import { Hono } from 'hono';
import type { AppHonoEnv } from '../../engine';
import {
    findDatasetsBySite,
    findSchemasBySite,
    findDatasetsListBundle,
    findDatasetById,
    findDatasetsByIdsForExport,
    getAdminLocale,
    getAdminI18nSlice
} from '../../engine';
import { DatasetListPage } from '../pages/DatasetList';
import { DatasetEditorPage } from '../pages/DatasetEditor';
import { DatasetCollectionEditorPage } from '../pages/DatasetCollectionEditor';
import { getAdminRouteContext, runAdminPipeline, parseNodeMetadata } from './common';

const datasetRouter = new Hono<AppHonoEnv>();

datasetRouter.get('/', async (c) => {
    const activeSiteId = c.get('siteId') || 'site_default';
    const tDbStart = performance.now();
    const { datasets, schemas, sites } = await findDatasetsListBundle(c.env.DB, activeSiteId);
    c.header('Server-Timing', `db;dur=${(performance.now() - tDbStart).toFixed(2)}`);
    const ctx = await getAdminRouteContext(c, sites);

    return c.html(
        <DatasetListPage
            datasets={datasets || []}
            schemas={schemas || []}
            {...ctx}
        />
    );
});

datasetRouter.get('/collection/:schemaSlug', async (c) => {
    const ctx = await getAdminRouteContext(c);
    const schemaSlug = decodeURIComponent(c.req.param('schemaSlug') || '');
    const [allDatasets, schemas] = await Promise.all([
        findDatasetsBySite(ctx.db, ctx.activeSiteId),
        findSchemasBySite(ctx.db, ctx.activeSiteId)
    ]);

    const schemaItem = (schemas || []).find((s: any) => s.slug === schemaSlug);
    const filtered = (allDatasets || []).filter(d => {
        const meta = parseNodeMetadata(d.metadata);
        return (d.schema_slug || meta.schema_slug || 'default') === schemaSlug;
    });

    return c.html(
        <DatasetCollectionEditorPage
            schemaSlug={schemaSlug}
            schemaItem={schemaItem}
            datasets={filtered}
            {...ctx}
        />
    );
});

datasetRouter.post('/api/collection-save', async (c) => {
    const siteId = c.get('siteId') || 'site_default';
    try {
        const body = await c.req.json();
        const schemaSlug = String(body.schema_slug || '').trim();
        const rows = Array.isArray(body.rows) ? body.rows : [];
        const deletedIds = Array.isArray(body.deleted_ids) ? body.deleted_ids : [];
        const locale = getAdminLocale(c);
        const i18n = getAdminI18nSlice(locale, 'datasets');

        if (!schemaSlug) {
            return c.json({ success: false, error: i18n.datasets.error_title_schema_required }, 400);
        }
        if (rows.length > 15 || deletedIds.length > 15) {
            return c.json({ success: false, code: 'BATCH_LIMIT_EXCEEDED', error: 'Maximum 15 items per batch' }, 422);
        }

        const result = await runAdminPipeline(
            c,
            'DATASET_COLLECTION_SAVE',
            { siteId, schemaSlug, rows, deletedIds },
            siteId
        );
        return c.json({ success: true, data: result });
    } catch (e: any) {
        return c.json({ success: false, error: e.message }, 400);
    }
});

datasetRouter.get('/api/export-collection/:schemaSlug', async (c) => {
    const ctx = await getAdminRouteContext(c);
    const schemaSlug = decodeURIComponent(c.req.param('schemaSlug') || '');
    const allDatasets = await findDatasetsBySite(ctx.db, ctx.activeSiteId);
    const filtered = (allDatasets || []).filter(d => {
        const meta = parseNodeMetadata(d.metadata);
        return (d.schema_slug || meta.schema_slug || 'default') === schemaSlug;
    }).map(d => {
        const meta = parseNodeMetadata(d.metadata);
        return {
            id: d.id,
            slug: d.slug,
            title: d.title,
            summary: d.summary,
            fields: meta.fields || meta
        };
    });

    return c.json({ schema_slug: schemaSlug, items: filtered });
});

datasetRouter.get('/new', async (c) => {
    const ctx = await getAdminRouteContext(c);
    const schemaSlugQuery = c.req.query('schema') || '';
    const schemas = await findSchemasBySite(ctx.db, ctx.activeSiteId);
    const targetSchemaSlug = schemaSlugQuery || (schemas && schemas[0]?.slug) || '';

    return c.html(
        <DatasetEditorPage
            schemas={schemas || []}
            selectedSchemaSlug={targetSchemaSlug}
            {...ctx}
        />
    );
});

datasetRouter.get('/edit/:id', async (c) => {
    const ctx = await getAdminRouteContext(c);
    const id = c.req.param('id');

    const dataset = await findDatasetById(ctx.db, id);
    if (!dataset) return c.redirect('/admin/datasets');

    const targetSiteId = c.get('siteId') || dataset.site_id || ctx.activeSiteId;
    const schemas = await findSchemasBySite(ctx.db, targetSiteId);
    const meta = parseNodeMetadata(dataset.metadata);

    const schemaSlug = dataset.schema_slug || meta.schema_slug || '';

    return c.html(
        <DatasetEditorPage
            dataset={dataset}
            schemas={schemas || []}
            selectedSchemaSlug={schemaSlug}
            {...ctx}
        />
    );
});

datasetRouter.post('/api/save', async (c) => {
    const siteId = c.get('siteId') || 'site_default';

    try {
        const body = await c.req.json();
        const datasetId = body.dataset_id || undefined;
        const schemaSlug = (body.schema_slug || '').trim();
        const title = (body.title || '').trim();
        const summary = (body.summary || '').trim();
        const dataFields = body.fields || {};
        const commitMessage = (body.commit_message || '').trim();
        const locale = getAdminLocale(c);
        const i18n = getAdminI18nSlice(locale, 'datasets');

        if (!schemaSlug || !title) {
            return c.json({ success: false, error: i18n.datasets.error_title_schema_required }, 400);
        }

        const result = await runAdminPipeline<
            {
                id?: string;
                siteId: string;
                schemaSlug: string;
                title: string;
                summary: string;
                data: Record<string, any>;
                commitMessage: string;
            },
            { id: string; success: boolean; versionNumber: number }
        >(
            c,
            'DATASET_SAVE',
            {
                id: datasetId,
                siteId,
                schemaSlug,
                title,
                summary,
                data: dataFields,
                commitMessage
            },
            siteId
        );

        return c.json({ success: true, id: result.id, version: result.versionNumber });
    } catch (err: any) {
        return c.json({ success: false, error: err.message }, 400);
    }
});

datasetRouter.delete('/api/delete/:id', async (c) => {
    const id = c.req.param('id');
    const siteId = c.get('siteId') || 'site_default';

    await runAdminPipeline<{ id: string }, { success: boolean }>(
        c,
        'DATASET_DELETE',
        { id },
        siteId
    );

    c.header('HX-Refresh', 'true');
    return c.text('OK');
});

datasetRouter.post('/api/batch-import', async (c) => {
    const siteId = c.get('siteId') || 'site_default';

    try {
        const body = await c.req.json();
        const schemaSlug = (body.schema_slug || '').trim();
        const items = body.items;
        const locale = getAdminLocale(c);
        const i18n = getAdminI18nSlice(locale, 'datasets');

        if (!schemaSlug || !Array.isArray(items) || items.length === 0) {
            return c.json({ success: false, error: i18n.datasets.error_import_empty }, 400);
        }
        if (items.length > 15) {
            return c.json({ success: false, code: 'BATCH_LIMIT_EXCEEDED', error: 'Maximum 15 items per batch' }, 422);
        }

        const { count } = await runAdminPipeline<
            { siteId: string; schemaSlug: string; items: any[] },
            { count: number; success: boolean }
        >(
            c,
            'DATASET_BATCH_IMPORT',
            { siteId, schemaSlug, items },
            siteId
        );

        return c.json({ success: true, count });
    } catch (err: any) {
        return c.json({ success: false, error: err.message }, 400);
    }
});

datasetRouter.get('/api/export-selected', async (c) => {
    const db = c.env.DB;
    const siteId = c.get('siteId') || 'site_default';
    const idsQuery = c.req.query('ids') || '';
    const ids = idsQuery.split(',').filter(Boolean);

    if (ids.length === 0) {
        return c.text('No items selected', 400);
    }

    const results = await findDatasetsByIdsForExport(db, ids, siteId);

    const exportData = (results || []).map(r => {
        const meta = parseNodeMetadata(r.metadata);
        return {
            id: r.id,
            title: r.title,
            summary: r.summary,
            schema_slug: meta.schema_slug,
            fields: meta.fields || {},
            created_at: r.created_at,
            updated_at: r.updated_at
        };
    });

    c.header('Content-Type', 'application/json; charset=utf-8');
    c.header('Content-Disposition', `attachment; filename="datasets-export-${Date.now()}.json"`);
    return c.json(exportData);
});

export { datasetRouter };

