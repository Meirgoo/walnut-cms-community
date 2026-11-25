import { Hono } from 'hono';
import type { AppHonoEnv } from '../../engine';
import { getAdminLocale, t } from '../../engine';
import { runAdminPipeline } from './common';

export const schemasRouter = new Hono<AppHonoEnv>();

schemasRouter.post('/api/create', async (c) => {
    const siteId = c.get('siteId') || 'site_default';

    try {
        const body = await c.req.json();
        const title = (body.title || '').trim();
        const slug = (body.slug || '').trim().replace(/^\/+/, '');
        const summary = (body.summary || '').trim();
        const fields = body.fields || body.metadata?.fields || body.metadata?.schema?.fields || [];
        const apiOnly = Boolean(body.api_only ?? body.metadata?.api_only);

        if (!title || !slug) {
            const locale = getAdminLocale(c);
            return c.json({ success: false, error: t(locale, 'schemas.name_slug_required') }, 400);
        }

        const validFields = Array.isArray(fields)
            ? fields.filter((f: any) => f && String(f.key || f.name || '').trim().length > 0)
            : [];
        if (validFields.length === 0) {
            const locale = getAdminLocale(c);
            return c.json({ success: false, error: t(locale, 'schemas.fields_required') }, 400);
        }

        const result = await runAdminPipeline<any, { id: string; slug: string }>(
            c,
            'SCHEMA_CREATE',
            { siteId, title, slug, summary, fields, api_only: apiOnly }
        );

        return c.json({ success: true, id: result.id, slug: result.slug });
    } catch (err: any) {
        return c.json({ success: false, error: err.message }, 400);
    }
});

schemasRouter.post('/api/append-fields', async (c) => {
    const siteId = c.get('siteId') || 'site_default';
    const locale = getAdminLocale(c);

    try {
        const body = await c.req.json();
        const slug = String(body.slug || '').trim().replace(/^\/+/, '');
        const fields = Array.isArray(body.fields) ? body.fields : [];
        if (!slug) {
            return c.json({ success: false, error: t(locale, 'schemas.name_slug_required') }, 400);
        }
        const result = await runAdminPipeline<any, { slug: string; addedCount: number; fields: any[] }>(
            c,
            'SCHEMA_APPEND_FIELDS',
            { siteId, slug, fields }
        );
        return c.json({ success: true, slug: result.slug, addedCount: result.addedCount, fields: result.fields });
    } catch (err: any) {
        return c.json({ success: false, error: err?.message || t(locale, 'common.error') }, 400);
    }
});

schemasRouter.delete('/api/delete/:id', async (c) => {
    const id = c.req.param('id');
    const locale = getAdminLocale(c);
    const siteId = c.get('siteId') || '';

    try {
        await runAdminPipeline(c, 'SCHEMA_DELETE', { siteId, schemaId: id });
        return c.json({ success: true, message: t(locale, 'editor.schema_deleted') });
    } catch (err: any) {
        const msg = String(err?.message || t(locale, 'common.error'));
        const status = msg.includes('SCHEMA_HAS_ACTIVE_DATASETS') ? 409 : (msg.includes('UNAUTHORIZED') ? 403 : 400);
        return c.json({ success: false, error: msg }, status);
    }
});
