import { Hono } from 'hono';
import type { AppHonoEnv } from '../../engine';
import {
    findSchemasBySite,
    findSchemaBySlug,
    findDatasetsListBundle,
    findDatasetById,
    findEntityVersions,
    findDatasetsByIdsForExport,
    findDatasetCollectionById,
    findDatasetCollectionBySlug,
    findDatasetCollectionsByIdsForExport,
    findDatasetsByCollectionId,
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
    const { collections, datasets, schemas, trashCount, sites } = await findDatasetsListBundle(c.env.DB, activeSiteId);
    c.header('Server-Timing', `db;dur=${(performance.now() - tDbStart).toFixed(2)}`);
    const ctx = await getAdminRouteContext(c, sites);

    return c.html(
        <DatasetListPage
            collections={collections || []}
            datasets={datasets || []}
            schemas={schemas || []}
            trashCount={trashCount}
            {...ctx}
        />
    );
});

datasetRouter.post('/api/collections/create', async (c) => {
    const siteId = c.get('siteId') || 'site_default';
    try {
        const body = await c.req.json();
        const result = await runAdminPipeline(
            c,
            'DATASET_COLLECTION_CREATE',
            {
                siteId,
                name: String(body.name || '').trim(),
                slug: String(body.slug || '').trim().toLowerCase(),
                schemaKey: String(body.schema_key || body.schemaKey || '').trim(),
                description: String(body.description || '').trim()
            },
            siteId
        );
        return c.json({ success: true, data: result });
    } catch (e: any) {
        return c.json({ success: false, error: e.message }, 400);
    }
});

datasetRouter.post('/api/collections/update', async (c) => {
    const siteId = c.get('siteId') || 'site_default';
    try {
        const body = await c.req.json();
        const result = await runAdminPipeline(
            c,
            'DATASET_COLLECTION_META_SAVE',
            {
                siteId,
                id: String(body.id || '').trim(),
                name: String(body.name || '').trim(),
                slug: body.slug ? String(body.slug).trim().toLowerCase() : undefined,
                description: body.description !== undefined ? String(body.description) : undefined
            },
            siteId
        );
        return c.json({ success: true, data: result });
    } catch (e: any) {
        return c.json({ success: false, error: e.message }, 400);
    }
});

datasetRouter.post('/api/collections/batch-delete', async (c) => {
    const siteId = c.get('siteId') || 'site_default';
    try {
        const body = await c.req.json();
        const ids = Array.isArray(body.ids) ? body.ids.filter(Boolean) : [];
        const result = await runAdminPipeline(
            c,
            'DATASET_COLLECTION_DELETE',
            { siteId, ids },
            siteId
        );
        return c.json({ success: true, data: result });
    } catch (e: any) {
        return c.json({ success: false, error: e.message }, 400);
    }
});

datasetRouter.delete('/api/collections/:id', async (c) => {
    const siteId = c.get('siteId') || 'site_default';
    const id = c.req.param('id');
    try {
        await runAdminPipeline(
            c,
            'DATASET_COLLECTION_DELETE',
            { siteId, ids: [id] },
            siteId
        );
        c.header('HX-Refresh', 'true');
        return c.text('OK');
    } catch (e: any) {
        return c.json({ success: false, error: e.message }, 400);
    }
});

datasetRouter.get('/api/collections/export-selected', async (c) => {
    const db = c.env.DB;
    const siteId = c.get('siteId') || 'site_default';
    const idsQuery = c.req.query('ids') || '';
    const ids = idsQuery.split(',').filter(Boolean);
    if (ids.length === 0) return c.text('No collections selected', 400);

    const cols = await findDatasetCollectionsByIdsForExport(db, ids, siteId);
    const payload = await Promise.all(cols.map(async (col) => {
        const items = await findDatasetsByCollectionId(db, siteId, col.id);
        return {
            id: col.id,
            slug: col.slug,
            name: col.name,
            schema_key: col.schema_key,
            items: items.map(d => {
                const meta = parseNodeMetadata(d.metadata);
                return { id: d.id, slug: d.slug, title: d.title, summary: d.summary, sort_order: Number(d.sort_order) || 0, fields: meta.fields || meta };
            })
        };
    }));

    c.header('Content-Type', 'application/json; charset=utf-8');
    c.header('Content-Disposition', `attachment; filename="dataset-collections-${Date.now()}.json"`);
    return c.json(payload);
});

async function resolveCollectionFromParam(c: any) {
    const ctx = await getAdminRouteContext(c);
    const ref = decodeURIComponent(c.req.param('collectionRef') || '');
    const col = (await findDatasetCollectionById(ctx.db, ref, ctx.activeSiteId))
        || (await findDatasetCollectionBySlug(ctx.db, ctx.activeSiteId, ref));
    return { ctx, col };
}

datasetRouter.get('/collection/:collectionRef', async (c) => {
    const { ctx, col } = await resolveCollectionFromParam(c);
    if (!col) return c.redirect('/admin/datasets');

    const [items, schemaItem] = await Promise.all([
        findDatasetsByCollectionId(ctx.db, ctx.activeSiteId, col.id),
        findSchemaBySlug(ctx.db, ctx.activeSiteId, col.schema_key)
    ]);

    return c.html(
        <DatasetCollectionEditorPage
            collection={col}
            schemaSlug={col.schema_key}
            schemaItem={schemaItem}
            datasets={items}
            {...ctx}
        />
    );
});

datasetRouter.post('/api/collection-save', async (c) => {
    const siteId = c.get('siteId') || 'site_default';
    try {
        const body = await c.req.json();
        const collectionId = String(body.collection_id || '').trim() || undefined;
        const schemaSlug = String(body.schema_slug || '').trim();
        const rows = Array.isArray(body.rows) ? body.rows : [];
        const deletedIds = Array.isArray(body.deleted_ids) ? body.deleted_ids : [];
        const locale = getAdminLocale(c);
        const i18n = getAdminI18nSlice(locale, 'datasets');

        if (!collectionId && !schemaSlug) {
            return c.json({ success: false, error: i18n.datasets.error_title_schema_required }, 400);
        }
        if (rows.length > 15 || deletedIds.length > 15) {
            return c.json({ success: false, code: 'BATCH_LIMIT_EXCEEDED', error: 'Maximum 15 items per batch' }, 422);
        }

        const result = await runAdminPipeline(
            c,
            'DATASET_COLLECTION_SAVE',
            { siteId, collectionId, schemaSlug, rows, deletedIds },
            siteId
        );
        return c.json({ success: true, data: result });
    } catch (e: any) {
        return c.json({ success: false, error: e.message }, 400);
    }
});

datasetRouter.get('/api/export-collection/:collectionRef', async (c) => {
    const { ctx, col } = await resolveCollectionFromParam(c);
    if (!col) return c.json({ error: 'Collection not found' }, 404);

    const items = await findDatasetsByCollectionId(ctx.db, ctx.activeSiteId, col.id);
    const filtered = items.map(d => {
        const meta = parseNodeMetadata(d.metadata);
        return {
            id: d.id,
            slug: d.slug,
            title: d.title,
            summary: d.summary,
            sort_order: Number(d.sort_order) || 0,
            fields: meta.fields || meta
        };
    });

    return c.json({ collection_id: col.id, slug: col.slug, schema_key: col.schema_key, items: filtered });
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

    const dataset = await findDatasetById(ctx.db, id, ctx.activeSiteId);
    if (!dataset) return c.redirect('/admin/datasets');

    const targetSiteId = c.get('siteId') || dataset.site_id || ctx.activeSiteId;
    const [schemas, versions] = await Promise.all([
        findSchemasBySite(ctx.db, targetSiteId),
        findEntityVersions(ctx.db, 'dataset', id)
    ]);
    const meta = parseNodeMetadata(dataset.metadata);

    const schemaSlug = dataset.schema_slug || meta.schema_slug || '';

    return c.html(
        <DatasetEditorPage
            dataset={dataset}
            schemas={schemas || []}
            versions={versions || []}
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
        const sortOrder = body.sort_order !== undefined ? (Number(body.sort_order) || 0) : 0;
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
                sortOrder: number;
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
                sortOrder,
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
    const locale = getAdminLocale(c);
    const i18n = getAdminI18nSlice(locale, 'datasets');

    try {
        const body = await c.req.json();
        const collectionId = String(body.collection_id || '').trim() || undefined;
        const schemaSlug = (body.schema_slug || '').trim();
        const onConflict = body.on_conflict === 'skip' ? 'skip' : 'error';
        const items = Array.isArray(body.items)
            ? body.items
            : (body && !Array.isArray(body) && body.items && Array.isArray(body.items.items) ? body.items.items : null);

        if ((!collectionId && !schemaSlug) || !Array.isArray(items) || items.length === 0) {
            return c.json({ success: false, error: i18n.datasets.error_import_empty }, 400);
        }
        if (items.length > 15) {
            return c.json({ success: false, code: 'BATCH_LIMIT_EXCEEDED', error: 'Maximum 15 items per batch' }, 422);
        }

        const { count, skippedCount } = await runAdminPipeline<
            { siteId: string; collectionId?: string; schemaSlug?: string; onConflict: 'error' | 'skip'; items: any[] },
            { count: number; skippedCount: number; success: boolean }
        >(
            c,
            'DATASET_BATCH_IMPORT',
            { siteId, collectionId, schemaSlug, onConflict, items },
            siteId
        );

        return c.json({ success: true, count, skippedCount });
    } catch (err: any) {
        const msg = String(err?.message || '');
        if (msg.includes('DATASET_SLUG_CONFLICT')) {
            return c.json({ success: false, code: 'DATASET_SLUG_CONFLICT', error: i18n.datasets.error_slug_conflict }, 409);
        }
        return c.json({ success: false, error: msg }, 400);
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
            sort_order: Number(r.sort_order) || 0,
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

