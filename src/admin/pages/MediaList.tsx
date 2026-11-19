import { raw } from 'hono/html';
import { AdminLayout } from '../layout';
import type { Site, AuthenticatedUser, MediaAsset } from '../../engine';
import { renderTemplate, fetchAsset, getAdminI18nSlice } from '../../engine';

export const MediaListPage = async (props: {
    assets: MediaAsset[];
    sites: Site[];
    currentSiteId: string;
    currentUser?: AuthenticatedUser;
    isSuperAdmin?: boolean;
    locale?: string;
}) => {
    const locale = props.locale || 'zh-CN';
    const i18n = getAdminI18nSlice(locale, ['media', 'common']);

    const mediaListTemplate = await fetchAsset('/admin/pages/media-list.html');
    const batchRenameModalTemplate = await fetchAsset('/admin/modals/media-batch-rename-modal.html');
    const mediaCardTemplate = await fetchAsset('/admin/snippets/media-card.html');
    const emptyPlaceholderTemplate = await fetchAsset('/admin/snippets/empty-placeholder.html');

    const mediaGridContentHtml = props.assets.length === 0
        ? renderTemplate(emptyPlaceholderTemplate, { message: i18n.empty })
        : `<div id="media-grid-container" class="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-4">` +
            props.assets.map(asset => {
                const displayUrl = asset.public_url || '';
                const normalizedAsset = { ...asset, public_url: displayUrl };
                const assetJson = JSON.stringify(normalizedAsset).replace(/"/g, '&quot;');
                let thumbContent: string;

                const makeThumb = (col: string, ico: string, txt: string) => `<div class="flex flex-col items-center justify-center text-${col}-500"><span class="material-symbols-outlined text-[42px]">${ico}</span><span class="text-[10px] font-bold text-slate-600 dark:text-slate-300 uppercase font-mono mt-0.5">${txt}</span></div>`;

                if (asset.mime_type && asset.mime_type.startsWith('image/')) {
                    thumbContent = `<img src="${displayUrl}" alt="${asset.file_name}" class="w-full h-full object-cover group-hover:scale-105 transition" loading="lazy" />`;
                } else if (asset.file_name.endsWith('.pdf') || asset.mime_type === 'application/pdf') {
                    thumbContent = makeThumb('red', 'picture_as_pdf', 'PDF');
                } else if (asset.mime_type?.startsWith('audio/') || /\.(mp3|wav)$/.test(asset.file_name)) {
                    thumbContent = makeThumb('purple', 'audio_file', 'AUDIO');
                } else if (asset.mime_type?.startsWith('video/') || /\.(mp4|mov)$/.test(asset.file_name)) {
                    thumbContent = makeThumb('rose', 'video_file', 'VIDEO');
                } else if (/\.(zip|tar|gz|7z)$/.test(asset.file_name)) {
                    thumbContent = makeThumb('amber', 'folder_zip', 'ZIP');
                } else {
                    thumbContent = makeThumb('blue', 'description', asset.file_name.split('.').pop() || '');
                }

                return renderTemplate(mediaCardTemplate, {
                    id: asset.id,
                    asset_json: assetJson,
                    public_url: displayUrl,
                    file_name: asset.file_name,
                    thumb_content: thumbContent,
                    click_to_zoom: i18n.click_to_zoom,
                    file_size_formatted: `${(asset.file_size / 1024).toFixed(1)} KB`,
                    file_ext: asset.file_name.split('.').pop()
                });
            }).join('') + `</div>`;

    const batchRenameModalHtml = renderTemplate(batchRenameModalTemplate, {
        modal_rename_title: i18n.format(i18n.modal_rename_title, { count: 0 }),
    }, i18n);

    const folderSet = new Set<string>();
    for (const a of props.assets) {
        try {
            const m = a.metadata ? (typeof a.metadata === 'string' ? JSON.parse(a.metadata) : a.metadata) : {};
            if (m && m.folder) folderSet.add(String(m.folder).trim());
        } catch {}
    }
    const folderDatalistOptions = Array.from(folderSet).filter(Boolean).map(f => `<option value="${f}"></option>`).join('');

    const pageHtml = renderTemplate(mediaListTemplate, {
        total_records_text: i18n.format(i18n.total_records, { count: props.assets.length }),
        selected_count_zero: i18n.format(i18n.selected_count, { count: 0 }),
        btn_batch_rename_class: '',
        folder_datalist_options: folderDatalistOptions,
        media_grid_content: mediaGridContentHtml,
        batch_rename_modal: batchRenameModalHtml
    }, i18n);

    return (
        <AdminLayout
            title={i18n.title}
            {...props}
            clientI18nSections={['media', 'editor']}
            locale={locale}
        >
            {raw(pageHtml)}
        </AdminLayout>
    );
};
