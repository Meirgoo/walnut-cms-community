import type { D1PreparedStatement } from '@cloudflare/workers-types';
import type { WalnutPlugin, HookContext } from '../types';
import { nanoId } from '../kernel';
import { t } from '../core/i18n';
import {
    findPublishedTheme,
    findSiteById,
    findDatasetById,
    findSchemaBySlug,
    extractSchemaFields,
    findDatasetCollectionById,
    findDatasetCollectionBySlug,
    buildInsertDatasetCollectionStatement,
    buildUpdateDatasetCollectionStatement,
    buildSoftDeleteDatasetCollectionStatement,
    buildSoftDeleteDatasetsByCollectionStatement,
    buildInsertAuditLogStatement,
    buildUpdateThemeMetadataStatement,
    buildUpdateSiteSettingsOnlyStatement,
    findMaxEntityVersionNumberByType,
    buildUpdateDatasetStatement,
    buildInsertDatasetStatement,
    buildInsertDatasetVersionStatement,
    buildSoftDeleteNodeStatements,
    findDatasetSlugConflict,
    countActiveSchemaDependents,
    markRoutesDirtyByDependency,
    markSiteRoutesDirty,
    invalidateQueryCache,
    purgeEdgeAndZoneCache
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
    collectionId?: string;
    schemaSlug?: string;
    schemaId?: string;
    slug?: string;
    title: string;
    summary?: string;
    data: Record<string, any>;
    stripEnvelopeKeys?: boolean;
    status?: 'draft' | 'published';
    sortOrder?: number;
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
    const rawSlug = String(params.slug || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/^-+|-+$/g, '');
    const slug = rawSlug || `dataset-${datasetId.replace('ds_', '')}`;

    let resolvedCollectionId: string = params.collectionId || '';
    let resolvedSchemaSlug = (params.schemaSlug || '').trim();

    if (resolvedCollectionId) {
        const col = await findDatasetCollectionById(ctx.dal.db, resolvedCollectionId, siteId);
        if (!col) throw new Error('DATASET_COLLECTION_NOT_FOUND');
        resolvedSchemaSlug = col.schema_key;
    } else if (resolvedSchemaSlug) {
        const col = await findDatasetCollectionBySlug(ctx.dal.db, siteId, resolvedSchemaSlug);
        if (col) {
            resolvedCollectionId = col.id;
            resolvedSchemaSlug = col.schema_key;
        }
    }

    if (!resolvedSchemaSlug) {
        throw new Error('SCHEMA_REQUIRED');
    }

    const schemaItem = await findSchemaBySlug(ctx.dal.db, siteId, resolvedSchemaSlug);
    const schemaId = schemaItem?.id || `schema_${resolvedSchemaSlug}`;
    const fieldsSchema: DatasetFieldSchema[] = schemaItem ? extractSchemaFields(schemaItem) : [];
    const checkRes = validateDatasetPayload(fieldsSchema, params.data);
    if (!checkRes.valid) {
        throw new Error(`CONTRACT_VIOLATION: ${checkRes.errors.join('; ')}`);
    }

    let cleanFields = params.data && typeof params.data === 'object' ? { ...params.data } : params.data;
    if (cleanFields && typeof cleanFields === 'object') {
        if (params.stripEnvelopeKeys) {
            // Strip top-level table and envelope columns so metadata.fields stays strictly custom data.
            const envelopeKeys = new Set([
                'id', 'slug', 'status', 'sort_order', 'schema_slug', 'schema_id', 'collection_id', 'site_id',
                'summary', 'title', 'name', 'created_at', 'updated_at', 'deleted_at',
                'current_version_id', 'curator_id'
            ]);
            cleanFields = Object.fromEntries(
                Object.entries(cleanFields).filter(([k]) => !envelopeKeys.has(k))
            );
        } else {
            delete cleanFields.sort_order;
        }
    }

    const metadataPayload = {
        collection_id: resolvedCollectionId,
        schema_slug: resolvedSchemaSlug,
        schema_id: schemaId,
        fields: cleanFields
    };
    const metadataStr = JSON.stringify(metadataPayload);
    const contentRaw = JSON.stringify(cleanFields, null, 2);

    const hasSlugConflict = await findDatasetSlugConflict(ctx.dal.db, siteId, resolvedCollectionId, slug, isEdit ? datasetId : undefined);
    if (hasSlugConflict) {
        throw new Error('DATASET_SLUG_CONFLICT');
    }

    const maxVer = isEdit ? await findMaxEntityVersionNumberByType(ctx.dal.db, 'dataset', datasetId) : 0;
    const nextVer = isEdit ? (maxVer || 1) + 1 : 1;
    const verId = nanoId('ver');
    const verStmt = buildInsertDatasetVersionStatement(ctx.dal.db, {
        id: verId,
        siteId,
        datasetId,
        versionNumber: nextVer,
        title: params.title,
        summary: params.summary || '',
        contentRaw,
        metadataStr,
        commitMessage: params.commitMessage || (isEdit ? 'Update dataset version' : 'Initial item creation'),
        authorId
    });

    const sortOrder = params.sortOrder !== undefined && params.sortOrder !== null && Number.isFinite(Number(params.sortOrder))
        ? Math.trunc(Number(params.sortOrder))
        : undefined;

    if (isEdit) {
        const existingItem = await findDatasetById(ctx.dal.db, datasetId);
        if (existingItem && existingItem.site_id !== siteId) {
            throw new Error('FORBIDDEN_CROSS_SITE_ACCESS');
        }
        if (existingItem) {
            await ctx.dal.batch([
                buildUpdateDatasetStatement(ctx.dal.db, {
                    id: datasetId,
                    siteId,
                    title: params.title,
                    summary: params.summary || '',
                    metadataStr,
                    currentVersionId: verId,
                    status: params.status,
                    sortOrder
                }),
                verStmt
            ]);
            return { id: datasetId, success: true, versionNumber: nextVer };
        }
    }

    await ctx.dal.batch([
        buildInsertDatasetStatement(ctx.dal.db, {
            id: datasetId,
            siteId,
            collectionId: resolvedCollectionId,
            schemaSlug: resolvedSchemaSlug,
            schemaId,
            slug,
            title: params.title,
            summary: params.summary || '',
            metadataStr,
            currentVersionId: verId,
            status,
            sortOrder
        }),
        verStmt
    ]);

    return { id: datasetId, success: true, versionNumber: 1 };
}

async function resolveCollectionTarget(
    db: any,
    siteId: string,
    collectionId?: string,
    initialSchemaSlug = ''
): Promise<{ collectionId?: string; schemaSlug: string; collectionSlug: string }> {
    const schemaSlug = initialSchemaSlug;
    if (collectionId) {
        const col = await findDatasetCollectionById(db, collectionId, siteId);
        if (!col) throw new Error('DATASET_COLLECTION_NOT_FOUND');
        return { collectionId, schemaSlug: col.schema_key, collectionSlug: col.slug };
    }
    if (schemaSlug) {
        const col = await findDatasetCollectionBySlug(db, siteId, schemaSlug);
        if (col) return { collectionId: col.id, schemaSlug: col.schema_key, collectionSlug: col.slug };
    }
    return { collectionId, schemaSlug, collectionSlug: schemaSlug };
}

export const datasetPlugin: WalnutPlugin = {
    name: 'dataset',
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
            { siteId: string; name: string; slug: string; schemaKey: string; description?: string },
            { id: string; slug: string; name: string; schemaKey: string; success: boolean }
        >('DATASET_COLLECTION_CREATE', async (ctx) => {
            const siteId = ctx.data.siteId || ctx.siteId || 'site_default';
            await assertSiteAdmin(ctx.dal, siteId, ctx.user);

            const name = String(ctx.data.name || '').trim();
            const slug = String(ctx.data.slug || '').trim().toLowerCase();
            const schemaKey = String(ctx.data.schemaKey || '').trim();
            if (!name || !slug || !schemaKey) {
                throw new Error('DATASET_COLLECTION_FIELDS_REQUIRED');
            }
            if (!/^[a-z0-9][a-z0-9_-]*$/.test(slug)) {
                throw new Error('DATASET_COLLECTION_INVALID_SLUG');
            }

            const schemaExists = await findSchemaBySlug(ctx.dal.db, siteId, schemaKey);
            if (!schemaExists) {
                throw new Error(`SCHEMA_NOT_FOUND: ${schemaKey}`);
            }

            const existing = await findDatasetCollectionBySlug(ctx.dal.db, siteId, slug);
            if (existing) {
                throw new Error(`DATASET_COLLECTION_SLUG_EXISTS: ${slug}`);
            }

            const id = nanoId('col');
            await ctx.dal.batch([
                buildInsertDatasetCollectionStatement(ctx.dal.db, {
                    id,
                    siteId,
                    slug,
                    name,
                    schemaKey,
                    description: String(ctx.data.description || '').trim()
                })
            ]);
            return { id, slug, name, schemaKey, success: true };
        });

        engine.registerService<
            { siteId: string; id: string; name: string; slug?: string; description?: string },
            { id: string; slug: string; oldSlug: string; schemaKey: string; success: boolean }
        >('DATASET_COLLECTION_META_SAVE', async (ctx) => {
            const siteId = ctx.data.siteId || ctx.siteId || 'site_default';
            await assertSiteAdmin(ctx.dal, siteId, ctx.user);

            const existing = await findDatasetCollectionById(ctx.dal.db, ctx.data.id, siteId);
            if (!existing) throw new Error('DATASET_COLLECTION_NOT_FOUND');

            const name = String(ctx.data.name || '').trim();
            if (!name) throw new Error('DATASET_COLLECTION_FIELDS_REQUIRED');

            let nextSlug: string | undefined;
            if (ctx.data.slug && ctx.data.slug.trim() !== existing.slug) {
                const candidate = ctx.data.slug.trim().toLowerCase();
                if (!/^[a-z0-9][a-z0-9_-]*$/.test(candidate)) {
                    throw new Error('DATASET_COLLECTION_INVALID_SLUG');
                }
                const conflict = await findDatasetCollectionBySlug(ctx.dal.db, siteId, candidate);
                if (conflict && conflict.id !== existing.id) {
                    throw new Error(`DATASET_COLLECTION_SLUG_EXISTS: ${candidate}`);
                }
                nextSlug = candidate;
            }

            await ctx.dal.batch([
                buildUpdateDatasetCollectionStatement(ctx.dal.db, {
                    id: existing.id,
                    siteId,
                    name,
                    slug: nextSlug,
                    description: ctx.data.description
                })
            ]);
            return {
                id: existing.id,
                slug: nextSlug || existing.slug,
                oldSlug: existing.slug,
                schemaKey: existing.schema_key,
                success: true
            };
        });

        engine.registerService<
            { siteId: string; ids: string[] },
            { deletedIds: string[]; slugs: string[]; success: boolean }
        >('DATASET_COLLECTION_DELETE', async (ctx) => {
            const siteId = ctx.data.siteId || ctx.siteId || 'site_default';
            await assertSiteAdmin(ctx.dal, siteId, ctx.user);

            const ids = Array.isArray(ctx.data.ids) ? ctx.data.ids.filter(Boolean) : [];
            if (ids.length === 0) return { deletedIds: [], slugs: [], success: true };

            const stmts: D1PreparedStatement[] = [];
            const deletedIds: string[] = [];
            const slugs: string[] = [];

            for (const colId of ids) {
                const col = await findDatasetCollectionById(ctx.dal.db, colId, siteId);
                if (!col) continue;
                deletedIds.push(col.id);
                slugs.push(col.slug);
                stmts.push(
                    buildSoftDeleteDatasetCollectionStatement(ctx.dal.db, siteId, col.id),
                    buildSoftDeleteDatasetsByCollectionStatement(ctx.dal.db, siteId, col.id)
                );
            }

            if (stmts.length > 0) {
                await ctx.dal.batch(stmts);
            }
            return { deletedIds, slugs, success: true };
        });

        engine.tapAfter<{ siteId: string; ids: string[] }, { deletedIds: string[]; slugs: string[]; success: boolean }>(
            'DATASET_COLLECTION_DELETE',
            async (ctx) => {
                const siteId = ctx.data?.siteId || ctx.siteId || 'site_default';
                const slugs = ctx.result?.slugs || [];
                const keys = [...slugs.map((s) => `dataset:${s}`), 'dataset:*'];
                await markRoutesDirtyByDependency(ctx.dal.db, siteId, keys, ['/']);

                const deletedIds = ctx.result?.deletedIds || [];
                if (deletedIds.length > 0) {
                    try {
                        await ctx.dal.batch([
                            buildInsertAuditLogStatement(ctx.dal.db, {
                                id: nanoId('aud'),
                                siteId,
                                userId: ctx.user?.id || 'admin',
                                action: 'DATASET_COLLECTION_DELETE',
                                details: JSON.stringify({ collectionIds: deletedIds, slugs }),
                                ipAddress: ctx.clientIp || '127.0.0.1',
                                status: 'success'
                            })
                        ]);
                    } catch {}
                }
            }
        );

        engine.registerService<
            {
                siteId: string;
                collectionId?: string;
                schemaSlug?: string;
                rows: Array<{ id?: string; title: string; summary?: string; fields: Record<string, any> }>;
                deletedIds?: string[];
            },
            { savedCount: number; deletedCount: number; collectionSlug?: string; success: boolean }
        >('DATASET_COLLECTION_SAVE', async (ctx) => {
            const siteId = ctx.data.siteId || ctx.siteId || 'site_default';
            await assertSiteAdmin(ctx.dal, siteId, ctx.user);

            const { collectionId, schemaSlug, collectionSlug } = await resolveCollectionTarget(
                ctx.dal.db,
                siteId,
                ctx.data.collectionId,
                ctx.data.schemaSlug || ''
            );

            const deletedIds = Array.isArray(ctx.data.deletedIds) ? ctx.data.deletedIds.filter(Boolean) : [];
            const rows = Array.isArray(ctx.data.rows) ? ctx.data.rows : [];
            if (rows.length > 15 || deletedIds.length > 15) {
                throw new Error('BATCH_LIMIT_EXCEEDED');
            }
            if (deletedIds.length > 0) {
                const delStmts: D1PreparedStatement[] = [];
                for (const id of deletedIds) {
                    const existing = await findDatasetById(ctx.dal.db, id);
                    if (existing && existing.site_id === siteId && (!collectionId || existing.collection_id === collectionId)) {
                        delStmts.push(...buildSoftDeleteNodeStatements(ctx.dal.db, id, 'dataset', siteId));
                    }
                }
                if (delStmts.length > 0) await ctx.dal.db.batch(delStmts);
            }

            let savedCount = 0;
            for (const row of rows) {
                const rowTitle = String(row.title || row.fields?.title || row.fields?.name || `Item #${savedCount + 1}`).trim();
                if (!rowTitle) continue;
                const rawSort = (row as any).sort_order ?? row.fields?.sort_order;
                await persistSingleDatasetItem(ctx, {
                    id: row.id || undefined,
                    siteId,
                    collectionId,
                    schemaSlug,
                    title: rowTitle,
                    summary: String(row.summary || row.fields?.summary || ''),
                    data: row.fields || {},
                    sortOrder: rawSort !== undefined && rawSort !== '' ? Number(rawSort) : undefined,
                    commitMessage: 'Batch collection save'
                });
                savedCount++;
            }

            return { savedCount, deletedCount: deletedIds.length, collectionSlug, success: true };
        });

        engine.registerService<
            { siteId: string; collectionId?: string; schemaSlug?: string; onConflict?: 'error' | 'skip'; items: any[] },
            { count: number; skippedCount: number; collectionSlug?: string; success: boolean }
        >('DATASET_BATCH_IMPORT', async (ctx) => {
            const siteId = ctx.data.siteId || ctx.siteId || 'site_default';
            await assertSiteAdmin(ctx.dal, siteId, ctx.user);

            const { collectionId, schemaSlug, collectionSlug } = await resolveCollectionTarget(
                ctx.dal.db,
                siteId,
                ctx.data.collectionId,
                ctx.data.schemaSlug || ''
            );

            const items = Array.isArray(ctx.data.items) ? ctx.data.items : [];
            if (items.length > 15) {
                throw new Error('BATCH_LIMIT_EXCEEDED');
            }
            const skipConflicts = ctx.data.onConflict === 'skip';
            let successCount = 0;
            let skippedCount = 0;
            for (const item of items) {
                const nestedFields = (item.fields && typeof item.fields === 'object')
                    ? item.fields
                    : ((item.data && typeof item.data === 'object') ? item.data : null);
                const itemTitle = item.title || item.name || nestedFields?.title || nestedFields?.name || `Imported Item #${successCount + 1}`;
                const itemSummary = item.summary ?? nestedFields?.summary ?? '';
                const baseFields = nestedFields || item;
                const validationData = {
                    ...baseFields,
                    ...(baseFields?.title === undefined ? { title: itemTitle } : {}),
                    ...(baseFields?.summary === undefined ? { summary: itemSummary } : {})
                };
                try {
                    const rawSort = item.sort_order ?? nestedFields?.sort_order;
                    await persistSingleDatasetItem(ctx, {
                        siteId,
                        collectionId,
                        schemaSlug,
                        slug: item.slug ? String(item.slug) : undefined,
                        title: itemTitle,
                        summary: itemSummary,
                        data: validationData,
                        sortOrder: rawSort !== undefined && rawSort !== '' ? Number(rawSort) : undefined,
                        stripEnvelopeKeys: true,
                        commitMessage: 'Bulk imported initial version'
                    });
                    successCount++;
                } catch (err: any) {
                    if (skipConflicts && String(err?.message || '').includes('DATASET_SLUG_CONFLICT')) {
                        skippedCount++;
                        continue;
                    }
                    throw err;
                }
            }
            return { count: successCount, skippedCount, collectionSlug, success: true };
        });

        engine.registerService<{ id: string; siteId?: string }, { success: boolean; schemaSlug?: string }>(
            'DATASET_DELETE',
            async (ctx) => {
                const siteId = ctx.data?.siteId || ctx.siteId || 'site_default';
                await assertSiteAdmin(ctx.dal, siteId, ctx.user);
                const existing = await findDatasetById(ctx.dal.db, ctx.data.id, siteId);
                if (!existing) {
                    throw new Error('FORBIDDEN_CROSS_SITE_ACCESS');
                }
                await ctx.dal.batch(
                    buildSoftDeleteNodeStatements(ctx.dal.db, ctx.data.id, 'dataset', siteId)
                );
                return { success: true, schemaSlug: existing?.schema_slug };
            }
        );

        for (const dsAction of [
            'DATASET_COLLECTION_CREATE',
            'DATASET_COLLECTION_META_SAVE',
            'DATASET_COLLECTION_SAVE',
            'DATASET_BATCH_IMPORT',
            'DATASET_DELETE'
        ] as const) {
            engine.tapAfter<any, any>(dsAction, async (ctx) => {
                const siteId = ctx.data?.siteId || ctx.siteId || 'site_default';
                invalidateQueryCache(siteId);
                const candidates = [
                    ctx.data?.schemaSlug,
                    ctx.result?.schemaSlug,
                    ctx.data?.schemaKey,
                    ctx.result?.schemaKey,
                    ctx.data?.slug,
                    ctx.result?.slug,
                    ctx.result?.oldSlug
                ].filter(Boolean);
                const keys = Array.from(new Set([
                    ...candidates.map(s => `dataset:${s}`),
                    'dataset:*'
                ]));
                await markRoutesDirtyByDependency(ctx.dal.db, siteId, keys, ['/']);
                await purgeEdgeAndZoneCache(ctx.dal.db, siteId, ['/']);
            });
        }

        engine.registerService<
            { siteId: string; title: string; slug: string; summary: string; fields: any[]; api_only?: boolean },
            { id: string; slug: string; success: boolean }
        >('SCHEMA_CREATE', async (ctx) => {
            const siteId = ctx.data.siteId || ctx.siteId || 'site_default';
            await assertSiteAdmin(ctx.dal, siteId, ctx.user);
            const locale = ctx.locale || 'zh-CN';
            const slug = (ctx.data.slug || '').trim().replace(/^\/+/, '');
            const validFields = Array.isArray(ctx.data.fields)
                ? ctx.data.fields.filter((f: any) => f && String(f.key || f.name || '').trim().length > 0)
                : [];
            if (validFields.length === 0) {
                throw new Error(t(locale, 'schemas.fields_required'));
            }
            if (slug === 'default') {
                throw new Error(t(locale, 'schemas.duplicate_slug', { slug }));
            }

            const schemaId = `schema_${slug.replace(/[^a-zA-Z0-9_]/g, '_')}`;
            const [site, theme] = await Promise.all([
                findSiteById(ctx.dal.db, siteId),
                findPublishedTheme(ctx.dal.db, siteId)
            ]);
            if (!site) throw new Error('Site not found');

            const siteSettings = parseJson<Record<string, any>>(site.settings, {});
            const customSchemas: any[] = Array.isArray(siteSettings.custom_schemas) ? [...siteSettings.custom_schemas] : [];
            const themeMeta = parseJson<any>(theme?.metadata, {});
            const themeSchemas: any[] = themeMeta.schemas || themeMeta.schemaNodes || [];

            if (customSchemas.some((s: any) => s.slug === slug) || themeSchemas.some((s: any) => s.slug === slug)) {
                throw new Error(t(locale, 'schemas.duplicate_slug', { slug }));
            }

            customSchemas.push({
                id: schemaId,
                slug,
                name: ctx.data.title,
                description: ctx.data.summary,
                api_only: Boolean(ctx.data.api_only),
                is_custom: true,
                schema: { fields: validFields }
            });
            siteSettings.custom_schemas = customSchemas;

            await ctx.dal.batch([
                buildUpdateSiteSettingsOnlyStatement(ctx.dal.db, siteId, JSON.stringify(siteSettings))
            ]);
            await markSiteRoutesDirty(ctx.dal.db, siteId);

            return { id: schemaId, slug, success: true };
        });

        engine.registerService<
            { siteId?: string; slug: string; fields: any[] },
            { slug: string; addedCount: number; fields: any[]; success: boolean }
        >('SCHEMA_APPEND_FIELDS', async (ctx) => {
            const siteId = ctx.data.siteId || ctx.siteId || 'site_default';
            await assertSiteAdmin(ctx.dal, siteId, ctx.user);
            const locale = ctx.locale || 'zh-CN';
            const slug = String(ctx.data.slug || '').trim().replace(/^\/+/, '');
            if (!slug) {
                throw new Error(t(locale, 'schemas.name_slug_required'));
            }
            const incomingFields = Array.isArray(ctx.data.fields)
                ? ctx.data.fields.filter((f: any) => f && String(f.key || f.name || '').trim().length > 0)
                : [];

            const [site, theme] = await Promise.all([
                findSiteById(ctx.dal.db, siteId),
                findPublishedTheme(ctx.dal.db, siteId)
            ]);
            if (!site) throw new Error('Site not found');

            const siteSettings = parseJson<Record<string, any>>(site.settings, {});
            const customSchemas: any[] = Array.isArray(siteSettings.custom_schemas) ? [...siteSettings.custom_schemas] : [];
            const themeMeta = parseJson<any>(theme?.metadata, {});
            const themeSchemas: any[] = themeMeta.schemas || themeMeta.schemaNodes || [];

            const customIdx = customSchemas.findIndex((s: any) => s && (s.slug === slug || s.type === slug));
            const themeMatch = themeSchemas.find((s: any) => s && (s.slug === slug || s.type === slug));
            const target = customIdx >= 0 ? customSchemas[customIdx] : themeMatch;
            if (!target) {
                throw new Error(`SCHEMA_NOT_FOUND: ${slug}`);
            }

            const existingFields = extractSchemaFields(target);
            const existingKeys = new Set(
                existingFields.map((f: any) => String(f?.key || f?.name || '').trim()).filter(Boolean)
            );
            const toAppend: any[] = [];
            for (const f of incomingFields) {
                const fKey = String(f.key || f.name || '').trim();
                if (!fKey || existingKeys.has(fKey)) continue;
                existingKeys.add(fKey);
                toAppend.push({
                    ...f,
                    key: fKey,
                    label: String(f.label || fKey),
                    type: String(f.type || 'text')
                });
            }
            if (toAppend.length === 0) {
                return { slug, addedCount: 0, fields: existingFields, success: true };
            }

            const mergedFields = [...existingFields, ...toAppend];
            if (customIdx >= 0) {
                const prev = customSchemas[customIdx];
                customSchemas[customIdx] = {
                    ...prev,
                    schema: { ...(prev.schema || {}), fields: mergedFields }
                };
            } else {
                // Promote incremental override while preserving non-custom theme protection in SCHEMA_DELETE.
                customSchemas.push({
                    id: target.id || `schema_${slug.replace(/[^a-zA-Z0-9_]/g, '_')}`,
                    slug,
                    name: target.name || target.title || slug,
                    description: target.description || target.summary || '',
                    api_only: Boolean(target.api_only),
                    is_custom: false,
                    schema: { fields: mergedFields }
                });
            }
            siteSettings.custom_schemas = customSchemas;

            await ctx.dal.batch([
                buildUpdateSiteSettingsOnlyStatement(ctx.dal.db, siteId, JSON.stringify(siteSettings))
            ]);
            invalidateQueryCache(siteId);
            await markSiteRoutesDirty(ctx.dal.db, siteId);

            return { slug, addedCount: toAppend.length, fields: mergedFields, success: true };
        });

        engine.registerService<{ siteId: string; schemaId?: string; id?: string }, { success: boolean }>(
            'SCHEMA_DELETE',
            async (ctx) => {
                const siteId = ctx.data.siteId || ctx.siteId || 'site_default';
                await assertSiteAdmin(ctx.dal, siteId, ctx.user);
                const locale = ctx.locale || 'zh-CN';
                const targetId = String(ctx.data.schemaId || ctx.data.id || '').trim();
                if (!targetId) {
                    throw new Error('Schema ID is required');
                }
                const [site, theme] = await Promise.all([
                    findSiteById(ctx.dal.db, siteId),
                    findPublishedTheme(ctx.dal.db, siteId)
                ]);

                const matchTarget = (s: any) =>
                    (s.id && s.id === targetId) || `schema_${s.slug || s.type}` === targetId || s.slug === targetId;

                const themeMeta = parseJson<any>(theme?.metadata, {});
                const themeSchemas: any[] = themeMeta.schemas || themeMeta.schemaNodes || [];
                const themeTarget = themeSchemas.find(matchTarget);
                if (themeTarget && !themeTarget.is_custom && themeTarget.source !== 'custom') {
                    throw new Error(t(locale, 'schemas.cannot_delete_theme_schema'));
                }

                const siteSettings = site ? parseJson<Record<string, any>>(site.settings, {}) : {};
                const customSchemas: any[] = Array.isArray(siteSettings.custom_schemas) ? siteSettings.custom_schemas : [];
                const customTarget = customSchemas.find(matchTarget);
                const resolvedSchema = customTarget || themeTarget;
                const resolvedSlug = String(resolvedSchema?.slug || resolvedSchema?.type || targetId).trim();
                if (resolvedSlug) {
                    const activeCount = await countActiveSchemaDependents(ctx.dal.db, siteId, resolvedSlug);
                    if (activeCount > 0) {
                        throw new Error(`SCHEMA_HAS_ACTIVE_DATASETS: ${t(locale, 'schemas.cannot_delete_schema_has_collections')}`);
                    }
                }

                const batchStmts: D1PreparedStatement[] = [];
                if (site) {
                    const filteredCustom = customSchemas.filter((s: any) => !matchTarget(s));
                    if (filteredCustom.length !== customSchemas.length) {
                        siteSettings.custom_schemas = filteredCustom;
                        batchStmts.push(buildUpdateSiteSettingsOnlyStatement(ctx.dal.db, siteId, JSON.stringify(siteSettings)));
                    }
                }

                // Clean up any legacy custom schemas previously stored inside theme metadata.
                if (theme && themeTarget && (themeTarget.is_custom || themeTarget.source === 'custom')) {
                    themeMeta.schemas = themeSchemas.filter((s: any) => !matchTarget(s));
                    batchStmts.push(buildUpdateThemeMetadataStatement(ctx.dal.db, theme.id, JSON.stringify(themeMeta)));
                }

                if (batchStmts.length > 0) {
                    await ctx.dal.batch(batchStmts);
                    await markSiteRoutesDirty(ctx.dal.db, siteId);
                }

                return { success: true };
            }
        );
    }
};
