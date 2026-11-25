(function() {
    'use strict';

    const t = function(k, params) {
        const fn = window.__EDGE_I18N__ && window.__EDGE_I18N__.t;
        return typeof fn === 'function' ? fn(k, params) : k;
    };

    window.toggleVersionAccordion = function(nodeId) {
        const box = document.getElementById('versions-box-' + nodeId);
        const arrow = document.getElementById('arrow-icon-' + nodeId);
        if (box && box.classList.contains('hidden')) {
            box.classList.remove('hidden');
            if (arrow) arrow.classList.add('rotate-180');
        } else if (box) {
            box.classList.add('hidden');
            if (arrow) arrow.classList.remove('rotate-180');
        }
    };

    window.updateTrashGroupBatchState = function() {
        const checked = Array.from(document.querySelectorAll('.trash-group-checkbox:checked'));
        const toolbar = document.getElementById('trash-batch-toolbar');
        const badge = document.getElementById('trash-selected-badge');
        if (checked.length > 0) {
            if (toolbar) toolbar.classList.remove('hidden');
            if (badge) badge.innerText = t('common.selected_count', { count: checked.length });
        } else {
            if (toolbar) toolbar.classList.add('hidden');
        }
    };

    window.selectAllTrashGroups = function() {
        document.querySelectorAll('.trash-group-checkbox').forEach(function(cb) { cb.checked = true; });
        window.updateTrashGroupBatchState();
    };

    window.deselectAllTrashGroups = function() {
        document.querySelectorAll('.trash-group-checkbox').forEach(function(cb) { cb.checked = false; });
        window.updateTrashGroupBatchState();
    };

    window.batchRestoreSelectedArticles = async function() {
        const checked = Array.from(document.querySelectorAll('.trash-group-checkbox:checked'));
        if (checked.length === 0) return;
        const nodeIds = checked.map(function(cb) {
            return cb.getAttribute('data-node-id');
        }).filter(Boolean);
        for (let i = 0; i < nodeIds.length; i += 10) {
            const fd = new FormData();
            fd.append('node_ids', JSON.stringify(nodeIds.slice(i, i + 10)));
            const res = await fetch('/admin/trash/api/batch-restore', { method: 'POST', body: fd });
            if (!res.ok) {
                if (window.showToast) window.showToast(t('common.error'), 'error');
                return;
            }
        }
        window.location.reload();
    };

    window.batchHardDeleteSelectedArticles = function() {
        const checked = Array.from(document.querySelectorAll('.trash-group-checkbox:checked'));
        if (checked.length === 0) return;

        window.showConfirmDialog({
            title: t('trash.btn_batch_hard_delete'),
            message: t('trash.confirm_batch_hard_delete', { count: checked.length }),
            icon: 'delete_forever',
            onConfirm: async function() {
                const nodeIds = checked.map(function(cb) {
                    return cb.getAttribute('data-node-id');
                }).filter(Boolean);
                for (let i = 0; i < nodeIds.length; i += 10) {
                    const fd = new FormData();
                    fd.append('node_ids', JSON.stringify(nodeIds.slice(i, i + 10)));
                    const res = await fetch('/admin/trash/api/batch-hard-delete', { method: 'POST', body: fd });
                    if (!res.ok) {
                        if (window.showToast) window.showToast(t('common.error'), 'error');
                        return;
                    }
                }
                window.location.reload();
            }
        });
    };

    window.openSnapshotPreview = function(title, vNum, contentRaw) {
        const modal = document.getElementById('snapshot-preview-modal');
        const titleElem = document.getElementById('snapshot-modal-title');
        const contentElem = document.getElementById('snapshot-modal-content');

        if (titleElem) titleElem.innerText = title + ' (v' + vNum + ')';
        if (contentElem && window.marked) {
            let md = contentRaw || '';
            const trimmed = md.trim();
            if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
                try {
                    md = '```json\n' + JSON.stringify(JSON.parse(trimmed), null, 2) + '\n```';
                } catch {}
            }
            contentElem.innerHTML = window.marked.parse(md);
        }
        if (modal) modal.classList.remove('hidden');
    };

    window.closeSnapshotPreview = function() {
        const modal = document.getElementById('snapshot-preview-modal');
        if (modal) modal.classList.add('hidden');
    };
})();
