(function() {
    'use strict';

    const t = function(k, params) {
        const fn = window.__EDGE_I18N__ && window.__EDGE_I18N__.t;
        return typeof fn === 'function' ? fn(k, params) : k;
    };

    window.switchAuditSubTab = function(tabId) {
        if (!tabId) return;
        ['tab-logs', 'tab-tasks', 'tab-webhooks', 'tab-backups', 'tab-blocklist', 'tab-traffic', 'tab-workers', 'tab-users'].forEach(function(id) {
            const tab = document.getElementById(id);
            const btn = document.getElementById('btn-' + id);
            if (tab) {
                if (id === tabId) {
                    tab.style.display = 'block';
                    tab.classList.remove('hidden');
                } else {
                    tab.style.display = 'none';
                    tab.classList.add('hidden');
                }
            }
            if (btn) {
                btn.className = id === tabId
                    ? 'px-4 py-2.5 border-b-2 border-[var(--admin-accent)] text-[var(--admin-text)] transition-colors duration-75 ease-out flex items-center space-x-1.5 cursor-pointer whitespace-nowrap'
                    : 'px-4 py-2.5 border-b-2 border-transparent text-[var(--admin-text-muted)] hover:text-[var(--admin-text)] transition-colors duration-75 ease-out flex items-center space-x-1.5 cursor-pointer whitespace-nowrap';
            }
        });
        const syncBar = document.getElementById('audit-traffic-sync-bar');
        if (syncBar) {
            syncBar.style.display = tabId === 'tab-traffic' ? 'flex' : 'none';
        }
    };

    window.closeUserModal = function() {
        const modal = document.getElementById('user-modal');
        if (modal) modal.classList.add('hidden');
    };

    window.openEditUserModal = function(user) {
        const modal = document.getElementById('edit-user-modal');
        const idInput = document.getElementById('edit-user-id');
        const usernameInput = document.getElementById('edit-username');
        const emailInput = document.getElementById('edit-email');
        const globalRoleSelect = document.getElementById('edit-global-role');
        const siteRoleSelect = document.getElementById('edit-site-role');

        if (idInput) idInput.value = user.id || '';
        if (usernameInput) usernameInput.value = user.username || '';
        if (emailInput) emailInput.value = user.email || '';
        if (globalRoleSelect) globalRoleSelect.value = user.global_role || 'user';
        if (siteRoleSelect) siteRoleSelect.value = user.site_role || 'admin';

        modal?.classList.remove('hidden');
    };

    window.closeEditUserModal = function() {
        const modal = document.getElementById('edit-user-modal');
        if (modal) modal.classList.add('hidden');
    };

    window.syncTaskModalFields = function(taskType) {
        const targetNodeWrap = document.getElementById('task-field-target-node');
        const retDaysWrap = document.getElementById('task-field-retention-days');
        const retCountWrap = document.getElementById('task-field-retention-count');
        if (targetNodeWrap) targetNodeWrap.classList.toggle('hidden', taskType !== 'publish_node' && taskType !== 'scheduled_unpublish');
        if (retDaysWrap) retDaysWrap.classList.toggle('hidden', taskType !== 'purge_deleted' && taskType !== 'archive_analytics');
        if (retCountWrap) retCountWrap.classList.toggle('hidden', taskType !== 'r2_scheduled_backup');
    };

    window.setTaskScheduleType = function(mode) {
        const input = document.getElementById('task-form-schedule-type');
        const runAtWrap = document.getElementById('task-field-run-at');
        const intervalWrap = document.getElementById('task-field-interval-wrap');
        const btnOnce = document.getElementById('task-sched-btn-once');
        const btnRec = document.getElementById('task-sched-btn-recurring');
        const activeCls = ['border-amber-500', 'bg-amber-50', 'dark:bg-amber-950/60', 'text-amber-700', 'dark:text-amber-300'];
        const idleCls = ['border-stone-200', 'dark:border-stone-700', 'text-stone-600', 'dark:text-stone-300'];
        if (input) input.value = mode;
        if (runAtWrap) runAtWrap.classList.toggle('hidden', mode !== 'once');
        if (intervalWrap) intervalWrap.classList.toggle('hidden', mode === 'once');
        if (btnOnce && btnRec) {
            const onBtn = mode === 'once' ? btnOnce : btnRec;
            const offBtn = mode === 'once' ? btnRec : btnOnce;
            onBtn.classList.remove(...idleCls);
            onBtn.classList.add(...activeCls);
            offBtn.classList.remove(...activeCls);
            offBtn.classList.add(...idleCls);
        }
    };

    window.setTaskIntervalPreset = function(preset, label) {
        const input = document.getElementById('task-form-interval-preset');
        const lbl = document.getElementById('task-preset-selected-label');
        const menu = document.getElementById('task-preset-dropdown-menu');
        const customWrap = document.getElementById('task-field-custom-minutes');
        if (input) input.value = preset;
        if (lbl && label) lbl.innerText = label;
        if (menu) menu.classList.add('hidden');
        if (customWrap) customWrap.classList.toggle('hidden', preset !== 'custom');
    };

    window.selectTaskType = function(taskType, label) {
        const formType = document.getElementById('task-form-type-input');
        const typeLabel = document.getElementById('task-type-selected-label');
        const menu = document.getElementById('task-type-dropdown-menu');
        if (formType) formType.value = taskType;
        if (typeLabel && label) typeLabel.innerText = label;
        if (menu) menu.classList.add('hidden');
        window.syncTaskModalFields(taskType);
        if (taskType === 'publish_node' || taskType === 'scheduled_unpublish') {
            window.setTaskScheduleType('once');
        } else {
            window.setTaskScheduleType('recurring');
        }
    };

    function populateTaskModal(task) {
        const title = document.getElementById('task-modal-title');
        const formId = document.getElementById('task-form-id');
        const formType = document.getElementById('task-form-type-input');
        const typeLabel = document.getElementById('task-type-selected-label');
        const interval = document.getElementById('task-form-interval');
        const targetNode = document.getElementById('task-form-target-node');
        const retDays = document.getElementById('task-form-retention-days');
        const retCount = document.getElementById('task-form-retention-count');
        const modal = document.getElementById('task-modal');
        const isEdit = Boolean(task);
        let payload = {};
        if (isEdit) {
            try { payload = typeof task.payload === 'string' ? JSON.parse(task.payload) : (task.payload || {}); } catch {}
        }
        const taskType = isEdit ? task.task_type : 'publish_node';
        if (title) title.innerText = (isEdit ? modal?.dataset?.titleEdit : modal?.dataset?.titleNew) || title.innerText;
        if (formId) formId.value = isEdit ? task.id : '';
        if (formType) formType.value = taskType;
        const opt = isEdit ? modal?.querySelector(`[data-task-type="${taskType}"]`) : null;
        if (typeLabel) typeLabel.innerText = isEdit ? (opt?.dataset?.label || taskType) : (modal?.dataset?.defaultLabel || typeLabel.innerText);
        if (interval) interval.value = isEdit ? (task.cron_interval_minutes || 5) : '5';
        if (targetNode) targetNode.value = isEdit ? (payload.node_id || '') : '';
        if (retDays) retDays.value = isEdit ? (payload.retention_days || 30) : '30';
        if (retCount) retCount.value = isEdit ? (payload.retention_count || 7) : '7';
        window.syncTaskModalFields(taskType);
        window.setTaskScheduleType(isEdit ? (task.schedule_type || 'recurring') : 'recurring');
        const preset = isEdit ? (task.interval_preset || 'custom') : 'custom';
        const presetOpt = modal?.querySelector(`[data-preset="${preset}"]`);
        window.setTaskIntervalPreset(preset, presetOpt?.dataset?.label || '');
        if (modal) modal.classList.remove('hidden');
    }

    window.openTaskModal = function() { populateTaskModal(null); };
    window.editTaskModal = function(task) { populateTaskModal(task); };

    window.closeTaskModal = function() {
        const modal = document.getElementById('task-modal');
        if (modal) modal.classList.add('hidden');
    };

    window.openWebhookModal = function(config) {
        const modal = document.getElementById('webhook-modal');
        const form = document.getElementById('webhook-form');
        const titleEl = document.getElementById('webhook-modal-title');
        const idInput = document.getElementById('wh-input-id');
        const nameInput = document.getElementById('wh-input-name');
        const formIdInput = document.getElementById('wh-input-form-id');
        const urlInput = document.getElementById('wh-input-url');
        const secretInput = document.getElementById('wh-input-secret');
        const activeInput = document.getElementById('wh-input-active');
        const previewFormId = document.getElementById('wh-preview-form-id');

        if (!modal || !form) return;

        if (config) {
            if (titleEl) titleEl.textContent = t('webhooks.modal_edit_title');
            if (idInput) idInput.value = config.id || '';
            if (nameInput) nameInput.value = config.name || '';
            if (formIdInput) {
                formIdInput.value = config.form_id || '';
                formIdInput.readOnly = true;
            }
            if (urlInput) urlInput.value = config.form_webhook_url || '';
            if (secretInput) secretInput.value = config.form_webhook_secret || '';
            if (activeInput) activeInput.checked = config.is_active !== 0;
            if (previewFormId) previewFormId.textContent = config.form_id || 'contact-us';
        } else {
            if (titleEl) titleEl.textContent = t('webhooks.modal_create_title');
            form.reset();
            if (idInput) idInput.value = '';
            if (formIdInput) formIdInput.readOnly = false;
            if (activeInput) activeInput.checked = true;
            if (previewFormId) previewFormId.textContent = 'contact-us';
        }

        modal.classList.remove('hidden');
    };

    window.closeWebhookModal = function() {
        const modal = document.getElementById('webhook-modal');
        if (modal) modal.classList.add('hidden');
    };

    window.handleWebhookFormSubmit = async function(e) {
        e.preventDefault();
        const id = (document.getElementById('wh-input-id')?.value || '').trim();
        const name = (document.getElementById('wh-input-name')?.value || '').trim();
        const form_id = (document.getElementById('wh-input-form-id')?.value || '').trim();
        const form_webhook_url = (document.getElementById('wh-input-url')?.value || '').trim();
        const form_webhook_secret = (document.getElementById('wh-input-secret')?.value || '').trim();
        const is_active = document.getElementById('wh-input-active')?.checked ? 1 : 0;

        if (!name || !form_id || !form_webhook_url) {
            window.showToast(t('common.fill_required'), 'warning');
            return;
        }

        try {
            const res = await fetch('/admin/webhooks/api/save', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    id: id || undefined,
                    name: name,
                    form_id: form_id,
                    form_webhook_url: form_webhook_url,
                    form_webhook_secret: form_webhook_secret || null,
                    is_active: is_active
                })
            });
            const json = await res.json();
            if (json.success) {
                window.showToast(t('webhooks.save_success'), 'success');
                window.closeWebhookModal();
                setTimeout(function() { window.location.reload(); }, 300);
            } else {
                window.showToast(json.error || t('webhooks.save_failed'), 'error');
            }
        } catch (err) {
            window.showToast(err.message, 'error');
        }
    };

    window.deleteWebhookRule = function(id, name) {
        window.showConfirmDialog({
            title: t('webhooks.delete_title'),
            message: (t('webhooks.delete_confirm') || '').replace('{{name}}', name),
            onConfirm: async function() {
                try {
                    const res = await fetch('/admin/webhooks/api/' + encodeURIComponent(id), {
                        method: 'DELETE'
                    });
                    const json = await res.json();
                    if (json.success) {
                        window.showToast(t('webhooks.delete_success'), 'success');
                        setTimeout(function() { window.location.reload(); }, 300);
                    } else {
                        window.showToast(json.error || t('webhooks.delete_failed'), 'error');
                    }
                } catch (err) {
                    window.showToast(err.message, 'error');
                }
            }
        });
    };

    window.testWebhookDispatch = async function(id) {
        window.showToast(t('webhooks.sending_test'), 'info');
        try {
            const res = await fetch('/admin/webhooks/api/test/' + encodeURIComponent(id), {
                method: 'POST'
            });
            const json = await res.json();
            if (json.success) {
                window.showToast(t('webhooks.test_success') + ' (Platform: ' + (json.data?.platform || 'custom') + ')', 'success');
            } else {
                window.showToast(json.error || t('webhooks.test_failed'), 'error');
            }
        } catch (err) {
            window.showToast(err.message, 'error');
        }
    };

    document.addEventListener('input', function(e) {
        if (e.target && e.target.id === 'wh-input-form-id') {
            const preview = document.getElementById('wh-preview-form-id');
            if (preview) {
                preview.textContent = e.target.value.trim() || 'contact-us';
            }
        }
    });
})();
