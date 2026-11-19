import { raw } from 'hono/html';
import { AdminLayout } from '../layout';
import { safeJsonStringify } from '../../engine/render/markdown-parser';
import type { Site, AuthenticatedUser } from '../../engine';
import { renderTemplate, fetchAsset, getAdminI18nSlice, getCommercialSnippet, getCommercialManifest } from '../../engine';

export interface WikiRelationItem {
    source_id?: string;
    source_title: string;
    source_slug: string;
    source_type?: string;
    target_id?: string;
    target_slug: string;
    target_title?: string;
    target_type?: string;
    relation_type: string;
}

export interface WikiNodeItem {
    id: string;
    slug: string;
    title: string;
    type: string;
    layer?: string;
    level?: number;
    path?: string;
    status?: string;
    maturity?: string | null;
    summary?: string | null;
    heat?: number;
    is_dirty?: boolean;
    entity_type?: string | null;
    entity_id?: string | null;
    created_at?: string | null;
}

export const AdminWikiGraphPage = async (props: {
    nodes?: WikiNodeItem[];
    relations: WikiRelationItem[];
    sites: Site[];
    currentSiteId: string;
    currentUser?: AuthenticatedUser;
    isSuperAdmin?: boolean;
    canUseFeature?: (feature?: string) => boolean;
    locale?: string;
}) => {
    const locale = props.locale || 'zh-CN';
    const isCommercial = props.canUseFeature ? props.canUseFeature('cms:*') : false;
    const allNodes = props.nodes || [];
    const relations = props.relations || [];
    const payloadJson = safeJsonStringify({ nodes: allNodes, relations });
    const i18n = getAdminI18nSlice(locale, 'wiki');

    const graphTemplate = await fetchAsset('/admin/pages/admin-wiki-graph.html');
    const proI18nMap = isCommercial ? (getCommercialManifest<Record<string, any>>('topologyProI18n') || {}) : {};
    const proLocaleDict = proI18nMap[locale] || proI18nMap['zh-CN'] || {};
    const proVars = {
        ...proLocaleDict,
        pro_i18n_json: JSON.stringify(proLocaleDict).replace(/</g, '\\u003c')
    };
    const proToolbarTpl = isCommercial ? getCommercialSnippet('graph-pro-toolbar.html') : '';
    const proInspectorTpl = isCommercial ? getCommercialSnippet('graph-pro-inspector.html') : '';
    const proToolbarHtml = proToolbarTpl ? renderTemplate(proToolbarTpl, proVars, i18n) : '';
    const proInspectorHtml = proInspectorTpl ? renderTemplate(proInspectorTpl, proVars, i18n) : '';
    const pageHtml = renderTemplate(graphTemplate, {
        payload_json: payloadJson,
        wiki_title: i18n.wiki_title,
        wiki_subtitle: i18n.wiki_subtitle,
        title: i18n.wiki_title,
        subtitle: i18n.wiki_subtitle,
        type_micro: i18n.type_micro || i18n.type_note,
        slot_graph_pro_toolbar: proToolbarHtml,
        slot_graph_pro_inspector: proInspectorHtml,
    }, i18n);

    return (
        <AdminLayout
            title={i18n.wiki_title}
            {...props}
            locale={locale}
            clientI18nSections={['wiki']}
        >
            {raw(pageHtml)}
        </AdminLayout>
    );
};
