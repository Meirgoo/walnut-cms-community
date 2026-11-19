import type { WalnutPlugin, HookContext } from '../types';
import { nanoId } from '../kernel';
import {
    findPublishedTheme,
    findDatasetById,
    buildUpdateThemeMetadataStatement,
    findLatestDatasetVersionNumber,
    buildUpdateDatasetStatement,
    buildInsertDatasetStatement,
    buildInsertDatasetVersionStatement,
    buildSoftDeleteDatasetStatement,
    markRoutesDirtyByDependency,
    markSiteRoutesDirty
} from '../core/dal';
import { assertSiteAdmin } from './common.helper';

export interface DatasetFieldSchema {
    key: string;
    label: string;
    type: 'text' | 'number' | 'boolean' | 'select' | 'textarea' | 'json';
    required?: boolean;
    options?: Array<{ label: string; value: string }>;
    default?: any;
    placeholder?: string;
}

export interface SaveDatasetParams {
    id?: string;
    siteId: string;
    schemaSlug: string;
    schemaId?: string;
    title: string;
    summary?: string;
    data: Record<string, any>;
    status?: 'draft' | 'published';
    commitMessage?: string;
}

import { parseJson } from '../core/utils';

export function validateDatasetPayload(
    fieldsSchema: DatasetFieldSchema[],
    data: Record<string, any>
): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    for (const field of fieldsSchema) {
        const val = data[field.key];

        if (field.required && (val === undefined || val === null || val === '')) {
            errors.push(`Required field [${field.label || field.key}] cannot be empty`);
            continue;
        }

        if (val !== undefined && val !== null && val !== '') {
            if (field.type === 'number') {
                const num = Number(val);
                if (isNaN(num)) {
                    errors.push(`Field [${field.label || field.key}] must be a valid number`);
                }
            } else if (field.type === 'boolean') {
                if (typeof val !== 'boolean' && val !== 'true' && val !== 'false' && val !== 1 && val !== 0) {
                    errors.push(`Field [${field.label || field.key}] must be a boolean`);
                }
            }
        }
    }

    return {
        valid: errors.length === 0,
        errors
    };
}

async function persistSingleDatasetItem(
    ctx: HookContext,
    params: SaveDatasetParams
): Promise<{ id: string; success: boolean; versionNumber: number }> {
    const siteId = params.siteId || ctx.siteId || 'site_default';
    await assertSiteAdmin(ctx.dal, siteId, ctx.user);

    const authorId = ctx.user?.id || 'admin';
    const isEdit = !!params.id;
    const datasetId = params.id || nanoId('ds');
    const status = params.status || 'published';
    const slug = `dataset-${datasetId.replace('ds_', '')}`;

    const theme = await findPublishedTheme(ctx.dal.db, siteId);

    let schemaMeta: Record<string, any> = {};
    let schemaId = `schema_${params.schemaSlug}`;
    if (theme) {
        const meta = parseJson<any>(theme.metadata, {});
        const schemas: any[] = meta.schemas || meta.schemaNodes || [];
        const found = schemas.find((s: any) => s.slug === params.schemaSlug || s.type === params.schemaSlug);
        if (found) {
            schemaMeta = found;
            schemaId = found.id || schemaId;
        }
    }

    const fieldsSchema: DatasetFieldSchema[] = schemaMeta.fields || schemaMeta.schema?.fields || [];
    const checkRes = validateDatasetPayload(fieldsSchema, params.data);
    if (!checkRes.valid) {
        throw new Error(`CONTRACT_VIOLATION: ${checkRes.errors.join('; ')}`);
    }

    const metadataPayload = {
        schema_slug: params.schemaSlug,
        schema_id: schemaId,
        fields: params.data
    };
    const metadataStr = JSON.stringify(metadataPayload);
    const contentRaw = JSON.stringify(params.data, null, 2);

    const nextVer = isEdit ? (await findLatestDatasetVersionNumber(ctx.dal.db, datasetId) || 1) + 1 : 1;
    const verId = nanoId('ver');
    const verStmt = buildInsertDatasetVersionStatement(ctx.dal.db, {
        id: verId,
        datasetId,
        versionNumber: nextVer,
        contentRaw,
        metadataStr,
        commitMessage: params.commitMessage || (isEdit ? 'Update dataset version' : 'Initial item creation'),
        authorId
    });

    if (isEdit) {
        await ctx.dal.batch([
            buildUpdateDatasetStatement(ctx.dal.db, {
                id: datasetId,
                title: params.title,
                summary: params.summary || '',
                metadataStr,
                currentVersionId: verId,
                status: params.status
            }),
            verStmt
        ]);
        return { id: datasetId, success: true, versionNumber: nextVer };
    }

    await ctx.dal.batch([
        buildInsertDatasetStatement(ctx.dal.db, {
            id: datasetId,
            siteId,
            schemaSlug: params.schemaSlug,
            schemaId,
            slug,
            title: params.title,
            summary: params.summary || '',
            metadataStr,
            currentVersionId: verId,
            status
        }),
        verStmt
    ]);

    return { id: datasetId, success: true, versionNumber: 1 };
}

export const datasetPlugin: WalnutPlugin = {
    name: 'dataset',
    version: '2.2.0',

    setup(engine) {
        engine.registerService<SaveDatasetParams, { id: string; success: boolean; versionNumber: number }>(
            'DATASET_SAVE',
            async (ctx) => {
                return await persistSingleDatasetItem(ctx, ctx.data);
            }
        );

        engine.tapAfter<SaveDatasetParams, { id: string; success: boolean; versionNumber: number }>(
            'DATASET_SAVE',
            async (ctx) => {
                const siteId = ctx.data?.siteId || ctx.siteId || 'site_default';
                const slug = ctx.data?.schemaSlug;
                const keys = slug ? [`dataset:${slug}`, 'dataset:*'] : ['dataset:*'];
                await markRoutesDirtyByDependency(ctx.dal.db, siteId, keys, ['/']);
            }
        );

        engine.registerService<
            {
                siteId: string;
                schemaSlug: string;
                rows: Array<{ id?: string; title: string; summary?: string; fields: Record<string, any> }>;
                deletedIds?: string[];
            },
            { savedCount: number; deletedCount: number; success: boolean }
        >('DATASET_COLLECTION_SAVE', async (ctx) => {
            const siteId = ctx.data.siteId || ctx.siteId || 'site_default';
            await assertSiteAdmin(ctx.dal, siteId, ctx.user);

            const deletedIds = Array.isArray(ctx.data.deletedIds) ? ctx.data.deletedIds.filter(Boolean) : [];
            const rows = Array.isArray(ctx.data.rows) ? ctx.data.rows : [];
            if (rows.length > 15 || deletedIds.length > 15) {
                throw new Error('BATCH_LIMIT_EXCEEDED');
            }
            if (deletedIds.length > 0) {
                const delStmts = deletedIds.map(id => buildSoftDeleteDatasetStatement(ctx.dal.db, id));
                await ctx.dal.db.batch(delStmts);
            }

            let savedCount = 0;
            for (const row of rows) {
                const rowTitle = String(row.title || row.fields?.title || row.fields?.name || `Item #${savedCount + 1}`).trim();
                if (!rowTitle) continue;
                await persistSingleDatasetItem(ctx, {
                    id: row.id || undefined,
                    siteId,
                    schemaSlug: ctx.data.schemaSlug,
                    title: rowTitle,
                    summary: String(row.summary || row.fields?.summary || ''),
                    data: row.fields || {},
                    commitMessage: 'Batch collection save'
                });
                savedCount++;
            }

            return { savedCount, deletedCount: deletedIds.length, success: true };
        });

        engine.registerService<
            { siteId: string; schemaSlug: string; items: any[] },
            { count: number; success: boolean }
        >('DATASET_BATCH_IMPORT', async (ctx) => {
            const siteId = ctx.data.siteId || ctx.siteId || 'site_default';
            await assertSiteAdmin(ctx.dal, siteId, ctx.user);
            const items = Array.isArray(ctx.data.items) ? ctx.data.items : [];
            if (items.length > 15) {
                throw new Error('BATCH_LIMIT_EXCEEDED');
            }
            let successCount = 0;
            for (const item of items) {
                const itemTitle = item.title || item.name || `Imported Item #${successCount + 1}`;
                const itemFields = item.fields || item.data || item;
                await persistSingleDatasetItem(ctx, {
                    siteId,
                    schemaSlug: ctx.data.schemaSlug,
                    title: itemTitle,
                    summary: item.summary || '',
                    data: itemFields,
                    commitMessage: 'Bulk imported initial version'
                });
                successCount++;
            }
            return { count: successCount, success: true };
        });

        engine.registerService<{ id: string }, { success: boolean; schemaSlug?: string }>(
            'DATASET_DELETE',
            async (ctx) => {
                const siteId = ctx.siteId || 'site_default';
                await assertSiteAdmin(ctx.dal, siteId, ctx.user);
                const existing = await findDatasetById(ctx.dal.db, ctx.data.id);
                await ctx.dal.batch([
                    buildSoftDeleteDatasetStatement(ctx.dal.db, ctx.data.id)
                ]);
                return { success: true, schemaSlug: existing?.schema_slug };
            }
        );

        for (const dsAction of ['DATASET_COLLECTION_SAVE', 'DATASET_BATCH_IMPORT', 'DATASET_DELETE'] as const) {
            engine.tapAfter<any, any>(dsAction, async (ctx) => {
                const siteId = ctx.data?.siteId || ctx.siteId || 'site_default';
                const slug = ctx.data?.schemaSlug || ctx.result?.schemaSlug;
                const keys = slug ? [`dataset:${slug}`, 'dataset:*'] : ['dataset:*'];
                await markRoutesDirtyByDependency(ctx.dal.db, siteId, keys, ['/']);
            });
        }

        engine.registerService<
            { siteId: string; title: string; slug: string; summary: string; fields: any[] },
            { id: string; slug: string; success: boolean }
        >('SCHEMA_CREATE', async (ctx) => {
            const siteId = ctx.data.siteId || ctx.siteId || 'site_default';
            await assertSiteAdmin(ctx.dal, siteId, ctx.user);
            const schemaId = `schema_${ctx.data.slug.replace(/[^a-zA-Z0-9_]/g, '_')}`;

            const theme = await findPublishedTheme(ctx.dal.db, siteId);

            if (theme) {
                const meta = parseJson<any>(theme.metadata, {});
                const schemas: any[] = meta.schemas || meta.schemaNodes || [];
                const idx = schemas.findIndex((s: any) => s.slug === ctx.data.slug);
                const newSchema = {
                    slug: ctx.data.slug,
                    name: ctx.data.title,
                    description: ctx.data.summary,
                    schema: { fields: ctx.data.fields || [] }
                };
                if (idx >= 0) {
                    schemas[idx] = newSchema;
                } else {
                    schemas.push(newSchema);
                }
                meta.schemas = schemas;

                await ctx.dal.batch([
                    buildUpdateThemeMetadataStatement(ctx.dal.db, theme.id, JSON.stringify(meta))
                ]);
                await markSiteRoutesDirty(ctx.dal.db, siteId);
            }

            return { id: schemaId, slug: ctx.data.slug, success: true };
        });

        engine.registerService<{ siteId: string; schemaId: string }, { success: boolean }>(
            'SCHEMA_DELETE',
            async (ctx) => {
                const siteId = ctx.data.siteId || ctx.siteId || 'site_default';
                await assertSiteAdmin(ctx.dal, siteId, ctx.user);
                const theme = await findPublishedTheme(ctx.dal.db, siteId);

                if (theme) {
                    const meta = parseJson<any>(theme.metadata, {});
                    const schemas: any[] = (meta.schemas || meta.schemaNodes || []).filter(
                        (s: any) => (s.id !== ctx.data.schemaId && s.slug !== ctx.data.schemaId)
                    );
                    meta.schemas = schemas;

                    await ctx.dal.batch([
                        buildUpdateThemeMetadataStatement(ctx.dal.db, theme.id, JSON.stringify(meta))
                    ]);
                    await markSiteRoutesDirty(ctx.dal.db, siteId);
                }

                return { success: true };
            }
        );
    }
};
