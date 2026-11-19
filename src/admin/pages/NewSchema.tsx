import { raw } from 'hono/html';
import { AdminLayout } from '../layout';
import type { Site, AuthenticatedUser } from '../../engine';
import { renderTemplate, fetchAsset, getAdminI18nSlice } from '../../engine';

export const NewSchemaPage = async (props: {
    sites: Site[];
    currentSiteId: string;
    currentUser?: AuthenticatedUser;
    isSuperAdmin?: boolean;
    locale?: string;
}) => {
    const locale = props.locale || 'zh-CN';
    const i18n = getAdminI18nSlice(locale, 'schemas');
    const newSchemaTemplate = await fetchAsset('/admin/pages/new-schema.html');

    const pageHtml = renderTemplate(newSchemaTemplate, {
        locale,
        site_id: props.currentSiteId,
    }, i18n);

    return (
        <AdminLayout
            title={i18n.new_title}
            {...props}
            clientI18nSections={['schemas', 'datasets', 'editor']}
            locale={locale}
        >
            {raw(pageHtml)}
        </AdminLayout>
    );
};
