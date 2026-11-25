(function() {
    'use strict';

    const t = function(k, params) {
        const fn = window.__EDGE_I18N__ && window.__EDGE_I18N__.t;
        return typeof fn === 'function' ? fn(k, params) : k;
    };

    window.updateBatchState = function() {
        const checked = Array.from(document.querySelectorAll('.media-select-box:checked'));
        const toolbar = document.getElementById('batch-toolbar');
        const badge = document.getElementById('selected-count-badge');
        if (checked.length > 0) {
            if (toolbar) toolbar.classList.remove('hidden');
            if (badge) badge.innerText = t('media.selected_count', { count: checked.length });
        } else {
            if (toolbar) toolbar.classList.add('hidden');
        }
    };

    window.selectAllMedia = function() {
        document.querySelectorAll('.media-select-box').forEach(function(cb) { cb.checked = true; });
        window.updateBatchState();
    };

    window.deselectAllMedia = function() {
        document.querySelectorAll('.media-select-box').forEach(function(cb) { cb.checked = false; });
        window.updateBatchState();
    };

    window.batchCopyUrls = function() {
        const checked = Array.from(document.querySelectorAll('.media-select-box:checked'));
        const urls = checked.map(function(cb) {
            return cb.getAttribute('data-url');
        }).join('\n');
        navigator.clipboard.writeText(urls);
        window.showToast(t('media.batch_copy_urls_success', { count: checked.length }), 'success');
    };

    window.batchCopyMarkdown = function() {
        const checked = Array.from(document.querySelectorAll('.media-select-box:checked'));
        const mds = checked.map(function(cb) {
            return '![' + (cb.getAttribute('data-name') || 'image') + '](' + cb.getAttribute('data-url') + ')';
        }).join('\n');
        navigator.clipboard.writeText(mds);
        window.showToast(t('media.batch_copy_md_success', { count: checked.length }), 'success');
    };

    window.batchDeleteMediaSelected = function() {
        const checked = Array.from(document.querySelectorAll('.media-select-box:checked'));
        if (checked.length === 0) return;

        window.showConfirmDialog({
            title: t('common.confirm_delete_title'),
            message: t('media.confirm_batch_delete', { count: checked.length }),
            icon: 'delete_forever',
            onConfirm: async function() {
                for (let i = 0; i < checked.length; i++) {
                    const id = checked[i].getAttribute('data-id');
                    if (id) {
                        await fetch('/admin/media/api/delete/' + id, { method: 'DELETE' });
                    }
                }
                window.location.reload();
            }
        });
    };

    window.openMediaModal = function(asset) {
        const modal = document.getElementById('media-detail-modal');
        const imgPrev = document.getElementById('modal-img-preview');
        const docPrev = document.getElementById('modal-doc-preview');

        const nameEl = document.getElementById('modal-file-name');
        const mimeEl = document.getElementById('modal-mime-type');
        const sizeEl = document.getElementById('modal-file-size');
        const dateEl = document.getElementById('modal-created-at');
        const keyEl = document.getElementById('modal-r2-key');

        if (nameEl) nameEl.innerText = asset.file_name;
        if (mimeEl) mimeEl.innerText = asset.mime_type;
        if (sizeEl) sizeEl.innerText = (asset.file_size / 1024).toFixed(1) + ' KB';
        if (dateEl) {
            const rawDt = String(asset.created_at || '');
            const utcDt = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(rawDt) ? rawDt.replace(' ', 'T') + 'Z' : rawDt;
            dateEl.innerText = new Date(utcDt).toLocaleString();
        }
        if (keyEl) keyEl.innerText = asset.r2_key;

        let assetMeta = {};
        try {
            assetMeta = asset.metadata ? (typeof asset.metadata === 'string' ? JSON.parse(asset.metadata) : asset.metadata) : {};
        } catch {}

        const metaTitleInput = document.getElementById('modal-meta-title');
        const metaAltInput = document.getElementById('modal-meta-alt');
        const editFilenameInput = document.getElementById('modal-edit-filename');
        const editFolderInput = document.getElementById('modal-edit-folder');
        const editIsPublicInput = document.getElementById('modal-edit-is-public');

        if (metaTitleInput) metaTitleInput.value = assetMeta.title || '';
        if (metaAltInput) metaAltInput.value = assetMeta.alt || '';
        if (editFilenameInput) editFilenameInput.value = asset.file_name || '';
        if (editFolderInput) editFolderInput.value = assetMeta.folder || '';
        if (editIsPublicInput) editIsPublicInput.checked = asset.is_public === undefined ? true : Boolean(Number(asset.is_public));

        const saveBtn = document.getElementById('modal-save-btn');
        if (saveBtn) {
            saveBtn.onclick = async function() {
                saveBtn.disabled = true;
                try {
                    const res = await fetch('/admin/media/api/update/' + asset.id, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            title: metaTitleInput ? metaTitleInput.value : '',
                            alt: metaAltInput ? metaAltInput.value : '',
                            file_name: editFilenameInput ? editFilenameInput.value : asset.file_name,
                            folder: editFolderInput ? editFolderInput.value : '',
                            is_public: editIsPublicInput ? editIsPublicInput.checked : true
                        })
                    });
                    const data = await res.json();
                    if (data && data.success) {
                        if (window.showToast) window.showToast(t('media.save_meta_success'), 'success');
                        setTimeout(function() { window.location.reload(); }, 400);
                    } else {
                        if (window.showToast) window.showToast((data && data.error) || t('common.error'), 'error');
                    }
                } catch (e) {
                    if (window.showToast) window.showToast(e.message || t('common.error'), 'error');
                } finally {
                    saveBtn.disabled = false;
                }
            };
        }

        const urlInput = document.getElementById('modal-url-input');
        const mdInput = document.getElementById('modal-md-input');
        const htmlInput = document.getElementById('modal-html-input');
        const directLink = document.getElementById('modal-direct-link');
        const downloadLink = document.getElementById('modal-download-link');

        const isImg = asset.mime_type && asset.mime_type.startsWith('image/');
        if (urlInput) urlInput.value = asset.public_url;
        if (mdInput) mdInput.value = isImg ? '![' + asset.file_name + '](' + asset.public_url + ')' : '[' + asset.file_name + '](' + asset.public_url + ')';
        if (htmlInput) htmlInput.value = isImg ? '<img src="' + asset.public_url + '" alt="' + asset.file_name + '" />' : '<a href="' + asset.public_url + '" download>' + asset.file_name + '</a>';
        if (directLink) directLink.href = asset.public_url;
        if (downloadLink) {
            downloadLink.href = asset.public_url;
            downloadLink.download = asset.file_name;
        }

        if (isImg) {
            if (imgPrev) { imgPrev.src = asset.public_url; imgPrev.classList.remove('hidden'); }
            if (docPrev) docPrev.classList.add('hidden');
        } else {
            if (imgPrev) imgPrev.classList.add('hidden');
            if (docPrev) docPrev.classList.remove('hidden');
        }

        const deleteBtn = document.getElementById('modal-delete-btn');
        if (deleteBtn) {
            deleteBtn.onclick = function() {
                window.showConfirmDialog({
                    title: t('media.btn_delete_file'),
                    message: t('media.confirm_delete_named', { name: asset.file_name }),
                    icon: 'delete',
                    onConfirm: async function() {
                        await fetch('/admin/media/api/delete/' + asset.id, { method: 'DELETE' });
                        window.location.reload();
                    }
                });
            };
        }

        if (modal) modal.classList.remove('hidden');
    };

    window.closeMediaModal = function() {
        const modal = document.getElementById('media-detail-modal');
        if (modal) modal.classList.add('hidden');
    };

    window.copyModalInput = function(id) {
        const input = document.getElementById(id);
        if (input) {
            navigator.clipboard.writeText(input.value);
            window.showToast(t('common.copy_clipboard_success'), 'success');
        }
    };

    async function convertImageToWebp(file) {
        if (!file.type.startsWith('image/') || file.type === 'image/webp' || file.type === 'image/svg+xml' || file.type === 'image/gif') {
            return file;
        }
        return new Promise(function(resolve) {
            const img = new Image();
            const url = URL.createObjectURL(file);
            img.onload = function() {
                URL.revokeObjectURL(url);
                const canvas = document.createElement('canvas');
                canvas.width = img.width;
                canvas.height = img.height;
                const ctx = canvas.getContext('2d');
                if (!ctx) return resolve(file);
                ctx.drawImage(img, 0, 0);
                canvas.toBlob(function(blob) {
                    if (!blob) return resolve(file);
                    const baseName = file.name.substring(0, file.name.lastIndexOf('.')) || file.name;
                    const newFile = new File([blob], baseName + '.webp', { type: 'image/webp' });
                    resolve(newFile);
                }, 'image/webp', 0.85);
            };
            img.onerror = function() {
                URL.revokeObjectURL(url);
                resolve(file);
            };
            img.src = url;
        });
    }

    function initMediaUploadListener() {
        const uploadInput = document.getElementById('media-upload-input');
        if (!uploadInput || uploadInput.dataset.boundUpload) return;
        uploadInput.dataset.boundUpload = '1';

        uploadInput.addEventListener('change', async function(e) {
            const files = e.target.files;
            if (!files || files.length === 0) return;

            const statusEl = document.getElementById('upload-status');
            if (statusEl) {
                statusEl.classList.remove('hidden');
                statusEl.innerText = t('media.uploading', { count: files.length });
            }

            const fd = new FormData();
            for (let i = 0; i < files.length; i++) {
                const processedFile = await convertImageToWebp(files[i]);
                fd.append('files', processedFile);
            }

            const searchParams = new URLSearchParams(window.location.search);
            const siteIdParam = searchParams.get('site_id');
            const uploadUrl = '/admin/media/api/upload' + (siteIdParam ? '?site_id=' + encodeURIComponent(siteIdParam) : '');

            try {
                const res = await fetch(uploadUrl, { method: 'POST', body: fd });
                const data = await res.json().catch(function() { return {}; });

                if (res.ok && data.success) {
                    if (statusEl) statusEl.innerText = t('media.upload_success');
                    if (window.showToast) window.showToast(t('media.upload_success'), 'success');
                    uploadInput.value = '';
                    setTimeout(function() { window.location.reload(); }, 500);
                } else {
                    const errMsg = data.error || t('common.error');
                    if (statusEl) statusEl.innerText = errMsg;
                    if (window.showToast) window.showToast(errMsg, 'error');
                }
            } catch (err) {
                if (statusEl) statusEl.innerText = t('common.network_error');
                if (window.showToast) window.showToast(t('common.network_error'), 'error');
            }
        });
    }

    window.openBatchRenameModal = function() {
        const selected = Array.from(document.querySelectorAll('.media-select-box:checked'));
        if (selected.length === 0) {
            if (window.showToast) window.showToast(t('common.no_nodes_selected'), 'warning');
            return;
        }
        const modal = document.getElementById('media-batch-rename-modal');
        const countEl = document.getElementById('rename-modal-count');
        if (countEl) countEl.innerText = String(selected.length);
        if (modal) modal.classList.remove('hidden');
    };

    window.closeBatchRenameModal = function() {
        const modal = document.getElementById('media-batch-rename-modal');
        if (modal) modal.classList.add('hidden');
    };

    window.submitBatchRename = async function() {
        const prefix = (document.getElementById('rename-prefix-input')?.value || '').trim();
        const replaceFrom = (document.getElementById('rename-from-input')?.value || '');
        const replaceTo = (document.getElementById('rename-to-input')?.value || '');

        const selected = Array.from(document.querySelectorAll('.media-select-box:checked'));
        const items = selected.map(function(box, idx) {
            const id = box.getAttribute('data-id');
            const oldName = box.getAttribute('data-name') || 'file';
            const ext = oldName.includes('.') ? oldName.substring(oldName.lastIndexOf('.')) : '';
            const base = oldName.includes('.') ? oldName.substring(0, oldName.lastIndexOf('.')) : oldName;

            let newBase = base;
            if (replaceFrom) {
                newBase = newBase.split(replaceFrom).join(replaceTo);
            }
            if (prefix) {
                newBase = prefix + '_' + (idx + 1) + '_' + newBase;
            }
            return { id: id, newName: newBase + ext };
        });

        try {
            const res = await fetch('/admin/media/api/batch-rename', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ items: items })
            });
            const data = await res.json();
            if (data.success) {
                if (window.showToast) window.showToast(t('common.success'), 'success');
                setTimeout(function() { window.location.reload(); }, 600);
            } else {
                if (window.showToast) window.showToast(data.error || t('common.error'), 'error');
            }
        } catch (e) {
            if (window.showToast) window.showToast(t('common.network_error'), 'error');
        }
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initMediaUploadListener);
    } else {
        initMediaUploadListener();
    }
})();
