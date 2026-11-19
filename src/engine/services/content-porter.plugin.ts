import type { WalnutPlugin, IPluginEngine, HookContext } from '../types';
import { findNodesByIdsForExport, findActiveNodeIdBySlugInTable } from '../core/dal';
import { resolveActiveSiteId, assertAdminUser } from './common.helper';

export interface ContentBatchExportInput {
    siteId?: string;
    ids: string[];
    type?: string;
}

export interface ContentBatchExportResult {
    success: boolean;
    items: Array<{
        id: string;
        slug: string;
        title: string;
        type: string;
        locale: string;
        summary?: string;
        content: string;
        metadata: Record<string, any>;
        published_at?: string | null;
        created_at?: string | null;
        updated_at?: string | null;
    }>;
    count: number;
}

export interface ContentBatchImportInput {
    siteId?: string;
    items: any[];
    defaultType?: 'article' | 'page' | 'micro';
    conflictStrategy?: 'skip' | 'upsert';
}

export interface ContentBatchImportResult {
    success: boolean;
    count: number;
    skippedCount?: number;
    failedCount: number;
    errors: string[];
}

export const ContentPorterPlugin: WalnutPlugin = {
    name: 'content-porter:core',
    version: '1.0.0',
    tier: 'community',

    setup(engine: IPluginEngine): void {
        engine.tapBefore<ContentBatchExportInput>('CONTENT_BATCH_EXPORT', async (ctx) => {
            assertAdminUser(ctx);

            if (!ctx.data?.ids || !Array.isArray(ctx.data.ids) || ctx.data.ids.length === 0) {
                throw new Error('EXPORT_IDS_EMPTY');
            }
        });

        engine.registerService<ContentBatchExportInput, ContentBatchExportResult>(
            'CONTENT_BATCH_EXPORT',
            async (ctx) => {
                const ids = ctx.data.ids;
                const siteId = await resolveActiveSiteId(ctx.dal, ctx.data.siteId || ctx.siteId);
                const isSuperAdmin = ctx.user?.global_role === 'superadmin';

                // Enforce tenant isolation in both the query and result filter to prevent cross-site data leakage.
                const rows = await findNodesByIdsForExport(ctx.dal.db, ids, isSuperAdmin ? undefined : siteId);
                const validRows = (rows || []).filter((r: any) => isSuperAdmin || !r.site_id || r.site_id === siteId);

                const items = validRows.map((r) => {
                    let meta: Record<string, any> = {};
                    if (typeof r.metadata === 'string') {
                        try {
                            meta = JSON.parse(r.metadata);
                        } catch {
                            meta = {};
                        }
                    } else if (r.metadata && typeof r.metadata === 'object') {
                        meta = r.metadata;
                    }

                    return {
                        id: r.id,
                        slug: r.slug,
                        title: r.title,
                        type: r.type,
                        locale: r.locale || 'zh-CN',
                        summary: r.summary || '',
                        content: r.content_raw || '',
                        metadata: meta,
                        published_at: r.published_at,
                        created_at: r.created_at,
                        updated_at: r.updated_at
                    };
                });

                return {
                    success: true,
                    items,
                    count: items.length
                };
            }
        );

        const checkImportLicense = async (ctx: HookContext<any>) => {
            assertAdminUser(ctx);

            if (!Array.isArray(ctx.data?.items) || ctx.data.items.length === 0) {
                throw new Error('IMPORT_ITEMS_EMPTY');
            }
            if (ctx.data.items.length > 15) {
                throw new Error('BATCH_LIMIT_EXCEEDED');
            }
        };

        const executeBatchImport = async (
            ctx: HookContext<ContentBatchImportInput>
        ): Promise<ContentBatchImportResult> => {
            const siteId = await resolveActiveSiteId(ctx.dal, ctx.data.siteId || ctx.siteId);
            const defaultType = ctx.data.defaultType || 'article';
            const conflictStrategy = ctx.data.conflictStrategy === 'upsert' ? 'upsert' : 'skip';
            let importedCount = 0;
            let skippedCount = 0;
            let failedCount = 0;
            const errors: string[] = [];

            for (let i = 0; i < ctx.data.items.length; i++) {
                const item = ctx.data.items[i];
                if (!item || typeof item !== 'object') continue;

                const itemType = item.type || defaultType;
                const title = String(item.title || item.name || '').trim();
                const baseSlug = String(item.slug || '').trim() || (itemType === 'micro' ? `memo-${Date.now().toString(36)}-${i}` : '');
                if (!title || !baseSlug) {
                    failedCount++;
                    errors.push(`Item #${i + 1} missing required slug or title`);
                    continue;
                }

                const contentRaw = String(item.content ?? item.body ?? item.markdown ?? item.content_raw ?? '');
                const summary = String(item.summary || '');
                const locale = String(item.locale || 'zh-CN');
                const status = item.status === 'draft' ? 'draft' : 'published';
                const meta = typeof item.metadata === 'object' && item.metadata !== null ? { ...item.metadata } : {};

                const table = itemType === 'page' ? 'pages' : (itemType === 'micro' ? 'micros' : 'articles');
                const existing = await findActiveNodeIdBySlugInTable(ctx.dal.db, table, siteId, baseSlug);
                if (existing && conflictStrategy === 'skip') {
                    skippedCount++;
                    continue;
                }
                const editFields = existing && conflictStrategy === 'upsert' ? { id: existing.id, isEdit: true } : {};

                try {
                    if (itemType === 'page') {
                        await engine.runPipeline({
                            ...ctx,
                            meta: { ...(ctx.meta || {}), skipSyncCompile: true },
                            action: 'PAGE_SAVE',
                            data: {
                                ...editFields,
                                siteId,
                                slug: baseSlug,
                                title,
                                contentRaw,
                                summary,
                                locale,
                                status,
                                pageType: item.page_type || meta.page_type || 'single',
                                metadata: meta,
                                commitMessage: 'Bulk imported page'
                            }
                        });
                    } else if (itemType === 'micro') {
                        await engine.runPipeline({
                            ...ctx,
                            meta: { ...(ctx.meta || {}), skipSyncCompile: true },
                            action: 'MICRO_SAVE',
                            data: {
                                ...editFields,
                                siteId,
                                slug: baseSlug,
                                title,
                                contentRaw,
                                summary,
                                locale,
                                status,
                                maturity: item.maturity || 'draft',
                                metadata: meta,
                                commitMessage: 'Bulk imported micro content'
                            }
                        });
                    } else {
                        await engine.runPipeline({
                            ...ctx,
                            meta: { ...(ctx.meta || {}), skipSyncCompile: true },
                            action: 'ARTICLE_SAVE',
                            data: {
                                ...editFields,
                                siteId,
                                slug: baseSlug,
                                type: 'article',
                                title,
                                summary,
                                contentRaw,
                                locale,
                                maturity: item.maturity || 'none',
                                status,
                                metadata: meta,
                                commitMessage: 'Bulk imported article'
                            }
                        });
                    }
                    importedCount++;
                } catch (err: any) {
                    failedCount++;
                    errors.push(`Item #${i + 1} [${title}] import failed: ${err.message || 'Unknown error'}`);
                }
            }

            return {
                success: importedCount > 0 || skippedCount > 0 || failedCount === 0,
                count: importedCount,
                skippedCount,
                failedCount,
                errors
            };
        };

        for (const action of ['CONTENT_BATCH_IMPORT', 'ARTICLE_BATCH_IMPORT'] as const) {
            engine.tapBefore(action, checkImportLicense);
            engine.registerService<ContentBatchImportInput, ContentBatchImportResult>(
                action,
                executeBatchImport
            );
        }
    }
};
