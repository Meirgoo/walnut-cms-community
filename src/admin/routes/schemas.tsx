import { Hono } from 'hono';
import type { AppHonoEnv } from '../../engine';
import { getAdminLocale, t } from '../../engine';
import { NewSchemaPage } from '../pages/NewSchema';
import { getAdminRouteContext, runAdminPipeline } from './common';

export const schemasRouter = new Hono<AppHonoEnv>();

schemasRouter.get('/new', async (c) => {
    const ctx = await getAdminRouteContext(c);

    return c.html(
        <NewSchemaPage
            {...ctx}
        />
    );
});

schemasRouter.post('/api/create', async (c) => {
    const siteId = c.get('siteId') || 'site_default';

    try {
        const body = await c.req.json();
        const title = (body.title || '').trim();
        const slug = (body.slug || '').trim().replace(/^\/+/, '');
        const summary = (body.summary || '').trim();
        const fields = body.fields || [];

        if (!title || !slug) {
            const locale = getAdminLocale(c);
            return c.json({ success: false, error: t(locale, 'schemas.name_slug_required') }, 400);
        }

        const result = await runAdminPipeline<any, { id: string; slug: string }>(
            c,
            'SCHEMA_CREATE',
            { siteId, title, slug, summary, fields }
        );

        return c.json({ success: true, id: result.id, slug: result.slug });
    } catch (err: any) {
        return c.json({ success: false, error: err.message }, 400);
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
        return c.json({ success: false, error: err.message || t(locale, 'common.error') }, 500);
    }
});
