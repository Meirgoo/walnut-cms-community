(function() {
    'use strict';

    const t = (key, params) => {
        const fn = window.__EDGE_I18N__ && window.__EDGE_I18N__.t;
        return typeof fn === 'function' ? fn(key, params) : key;
    };

    let schemaFields = [];
    let rows = [];
    const deletedIds = [];
    let collectionId = '';
    let schemaSlug = '';
    let dragSrcIndex = null;

    function init() {
        const schemaEl = document.getElementById('collection-schema-data');
        const rowsEl = document.getElementById('collection-rows-data');
        const colIdEl = document.getElementById('collection-id');
        const slugEl = document.getElementById('collection-schema-slug');
        if (!schemaEl || !rowsEl || !slugEl) return;

        collectionId = colIdEl ? (colIdEl.value || '') : '';
        schemaSlug = slugEl.value || '';
        try { schemaFields = JSON.parse(schemaEl.textContent || '[]'); } catch { schemaFields = []; }
        try { rows = JSON.parse(rowsEl.textContent || '[]'); } catch { rows = []; }

        if (schemaFields.length === 0 && rows.length > 0) {
            const keySet = new Set();
            rows.forEach(r => {
                Object.keys(r.fields || {}).forEach(k => {
                    if (k !== 'schema_slug' && k !== 'schema_id' && k !== 'title') keySet.add(k);
                });
            });
            schemaFields = Array.from(keySet).map(k => ({ key: k, label: k, type: 'text' }));
        }

        renderHeader();
        renderBody();

        const addBtn = document.getElementById('btn-add-collection-row');
        if (addBtn) {
            addBtn.addEventListener('click', () => {
                const emptyFields = {};
                schemaFields.forEach(f => {
                    emptyFields[f.key] = f.default !== undefined ? f.default : (f.type === 'boolean' ? false : '');
                });
                rows.push({ id: '', title: '', summary: '', sort_order: 0, fields: emptyFields });
                renderBody();
            });
        }

        const saveBtn = document.getElementById('btn-save-collection');
        if (saveBtn) {
            saveBtn.addEventListener('click', saveCollection);
        }

        const aiCleanBtn = document.getElementById('btn-copy-ai-clean-context');
        const openExportBtn = document.getElementById('btn-open-collection-export');
        const openImportBtn = document.getElementById('btn-open-collection-import');
        const closeImportBtn = document.getElementById('btn-close-collection-import');
        const cancelImportBtn = document.getElementById('btn-cancel-collection-import');
        const importModal = document.getElementById('collection-import-modal');
        const importFile = document.getElementById('collection-import-file');
        const importText = document.getElementById('collection-import-textarea');
        const confirmImportBtn = document.getElementById('btn-confirm-collection-import');

        const openModalTab = (tab) => {
            if (!importModal) return;
            if (tab === 'import') {
                if (importFile) importFile.value = '';
                if (importText) importText.value = '';
                parsedImportItems = null;
                updateImportState(null);
            }
            window.switchCollectionModalTab(tab);
            importModal.classList.remove('hidden');
        };

        if (aiCleanBtn) aiCleanBtn.addEventListener('click', () => openModalTab('ai'));
        if (openExportBtn) openExportBtn.addEventListener('click', () => openModalTab('export'));
        if (openImportBtn) openImportBtn.addEventListener('click', () => openModalTab('import'));

        const closeImport = () => importModal && importModal.classList.add('hidden');
        window.closeCollectionContractModal = closeImport;
        if (closeImportBtn) closeImportBtn.addEventListener('click', closeImport);
        if (cancelImportBtn) cancelImportBtn.addEventListener('click', closeImport);

        const aiCopyBtn = document.getElementById('btn-col-ai-copy');
        const aiDlBtn = document.getElementById('btn-col-ai-download');
        const expCopyBtn = document.getElementById('btn-col-export-copy');
        const expDlBtn = document.getElementById('btn-col-export-download');
        if (aiCopyBtn) aiCopyBtn.addEventListener('click', copyAiCleanContext);
        if (aiDlBtn) {
            aiDlBtn.addEventListener('click', () => {
                const colSlug = (document.getElementById('collection-slug')?.value) || schemaSlug || 'collection';
                window.walnutDownloadFile && window.walnutDownloadFile(colSlug + '-ai-cleaning.md', window.buildCollectionAiCleanContext(), 'text/markdown;charset=utf-8');
            });
        }
        if (expCopyBtn) {
            expCopyBtn.addEventListener('click', () => {
                const jsonStr = document.getElementById('collection-export-json-preview')?.value || buildCollectionExportJson();
                window.walnutCopyText && window.walnutCopyText(jsonStr, t('common.copy_clipboard_success'), t('common.error'));
            });
        }
        if (expDlBtn) {
            expDlBtn.addEventListener('click', () => {
                const colSlug = (document.getElementById('collection-slug')?.value) || schemaSlug || 'collection';
                const jsonStr = document.getElementById('collection-export-json-preview')?.value || buildCollectionExportJson();
                window.walnutDownloadFile && window.walnutDownloadFile(colSlug + '.json', jsonStr, 'application/json');
            });
        }

        if (importFile) {
            importFile.addEventListener('change', () => {
                const file = importFile.files && importFile.files[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = (ev) => {
                    const text = String(ev.target?.result || '');
                    if (importText) importText.value = text;
                    validateCollectionImportJson(text);
                };
                reader.readAsText(file);
            });
        }
        if (importText) {
            importText.addEventListener('input', () => validateCollectionImportJson(importText.value));
        }
        if (confirmImportBtn) {
            confirmImportBtn.addEventListener('click', submitCollectionJsonImport);
        }
    }

    let parsedImportItems = null;

    const SYSTEM_SAMPLE_KEYS = new Set([
        'id', 'site_id', 'collection_id', 'schema_slug', 'schema_id',
        'created_at', 'updated_at', 'deleted_at', 'current_version_id', 'curator_id', 'status'
    ]);

    function truncateSampleVal(val) {
        if (typeof val === 'string') {
            return val.length > 200 ? val.slice(0, 200) + '...' : val;
        }
        if (Array.isArray(val)) return val.slice(0, 5);
        return val;
    }

    function buildCollectionExportJson() {
        const colSlug = (document.getElementById('collection-slug')?.value) || schemaSlug;
        return JSON.stringify({
            collection_id: collectionId || undefined,
            collection_slug: colSlug,
            schema_slug: schemaSlug,
            items: rows.map(r => ({
                title: r.title || '',
                ...(r.slug ? { slug: r.slug } : {}),
                ...(r.summary ? { summary: r.summary } : {}),
                sort_order: Number(r.sort_order) || 0,
                fields: r.fields || {}
            }))
        }, null, 2);
    }

    window.switchCollectionModalTab = function(tab) {
        const tabs = ['ai', 'export', 'import'];
        const activeCls = 'px-4 py-2.5 border-b-2 border-[var(--admin-accent)] text-[var(--admin-text)] cursor-pointer transition flex items-center space-x-1.5';
        const idleCls = 'px-4 py-2.5 border-b-2 border-transparent text-[var(--admin-text-muted)] hover:text-[var(--admin-text)] cursor-pointer transition flex items-center space-x-1.5';
        tabs.forEach(k => {
            const btn = document.getElementById('btn-col-modal-tab-' + k);
            const pane = document.getElementById('col-modal-pane-' + k);
            if (btn) btn.className = k === tab ? activeCls : idleCls;
            if (pane) pane.classList.toggle('hidden', k !== tab);
        });
        if (tab === 'ai') {
            const aiEl = document.getElementById('collection-ai-clean-preview');
            if (aiEl) aiEl.value = window.buildCollectionAiCleanContext();
        } else if (tab === 'export') {
            const expEl = document.getElementById('collection-export-json-preview');
            if (expEl) expEl.value = buildCollectionExportJson();
        }
    };

    window.buildCollectionAiCleanContext = function() {
        const colSlugEl = document.getElementById('collection-slug');
        const colSlug = (colSlugEl && colSlugEl.value) || schemaSlug;
        const exampleItem = { title: 'Sample Title', slug: 'sample-item' };
        const fieldsDesc = schemaFields.map(f => {
            const val = f.type === 'number' ? 1 : (f.type === 'boolean' ? false : ('<' + f.key + '>'));
            if (f.key !== 'title') exampleItem[f.key] = val;
            return {
                key: f.key,
                label: f.label || f.key,
                type: f.type || 'text',
                required: Boolean(f.required),
                ...(Array.isArray(f.options) && f.options.length > 0 ? { options: f.options } : {})
            };
        });
        const payload = {
            collection_slug: colSlug,
            schema_slug: schemaSlug,
            fields: fieldsDesc
        };
        const validSamples = (Array.isArray(rows) ? rows : []).filter(r =>
            r && (r.id || r.title || Object.values(r.fields || {}).some(v => v !== '' && v !== undefined && v !== null))
        );
        if (validSamples.length > 0) {
            payload.reference_items = validSamples.slice(0, 2).map(row => {
                const sample = {};
                if (row.title) sample.title = truncateSampleVal(row.title);
                if (row.slug) sample.slug = row.slug;
                if (row.summary) sample.summary = truncateSampleVal(row.summary);
                const rawFields = (row.fields && typeof row.fields === 'object') ? row.fields : {};
                Object.keys(rawFields).forEach(k => {
                    if (SYSTEM_SAMPLE_KEYS.has(k)) return;
                    if (sample[k] === undefined && rawFields[k] !== undefined && rawFields[k] !== '') {
                        sample[k] = truncateSampleVal(rawFields[k]);
                    }
                });
                return sample;
            });
        } else {
            payload.example_output = [exampleItem];
        }
        const rules = [
            'Output ONLY a valid JSON array matching the schema below.',
            '`title` (required) plus optional `slug` and `summary` are built-in top-level item fields; `fields[]` lists only extra custom fields—never duplicate `title` inside custom schema fields.',
            'Include `title`, all `required: true` custom fields, and an optional unique kebab-case `slug` on every output item.'
        ];
        if (payload.reference_items) {
            rules.push('Match the exact field format, value conventions, and language style shown in `reference_items`.');
        }
        return '# Walnut Dataset AI Cleaning Context\n\n' +
            '## Output Rules\n' +
            rules.map(r => '- ' + r).join('\n') + '\n\n' +
            '```json\n' + JSON.stringify(payload, null, 2) + '\n```\n';
    };

    async function copyAiCleanContext() {
        const text = window.buildCollectionAiCleanContext();
        if (window.walnutCopyText) {
            await window.walnutCopyText(text, t('datasets.ai_clean_context_copied'), t('common.error'));
        }
    }

    function updateImportState(result) {
        const feedback = document.getElementById('collection-import-feedback');
        const btn = document.getElementById('btn-confirm-collection-import');
        const disabledCls = 'h-8 bg-[var(--admin-border)] text-[var(--admin-text-muted)] px-4 rounded-lg text-xs font-semibold transition flex items-center space-x-1.5 cursor-not-allowed opacity-70';
        const activeCls = 'h-8 bg-[var(--admin-accent)] hover:bg-[var(--admin-accent-hover)] text-[var(--admin-accent-on)] px-4 rounded-lg text-xs font-semibold shadow-sm transition flex items-center space-x-1.5 cursor-pointer';
        if (!result) {
            if (feedback) feedback.innerHTML = '';
            if (btn) {
                btn.disabled = true;
                btn.className = disabledCls;
            }
            return;
        }
        if (result.errorHtml) {
            if (feedback) feedback.innerHTML = result.errorHtml;
            if (btn) {
                btn.disabled = true;
                btn.className = disabledCls;
            }
            parsedImportItems = null;
            return;
        }
        if (feedback) {
            feedback.innerHTML = `<span class="text-[var(--admin-accent-text)] font-bold">${t('datasets.import_validation_success', { count: result.items.length })}</span>`;
        }
        if (btn) {
            btn.disabled = false;
            btn.className = activeCls;
        }
        parsedImportItems = result.items;
    }

    window.unwrapCollectionImportPayload = function(parsed) {
        if (Array.isArray(parsed)) return parsed;
        if (parsed && typeof parsed === 'object' && Array.isArray(parsed.items)) return parsed.items;
        return null;
    };

    function validateCollectionImportJson(rawText) {
        if (!String(rawText || '').trim()) {
            updateImportState(null);
            return;
        }
        try {
            const parsed = JSON.parse(rawText);
            const items = window.unwrapCollectionImportPayload(parsed);
            if (!Array.isArray(items) || items.length === 0) {
                throw new Error(t('datasets.import_empty_or_not_array'));
            }
            const errors = [];
            items.forEach((item, idx) => {
                if (!item || typeof item !== 'object' || Array.isArray(item)) {
                    errors.push(`#${idx + 1}: invalid object`);
                    return;
                }
                const fields = item.fields || item.data || item;
                if (!item.title && !item.name && !fields.title && !fields.name) {
                    errors.push(t('datasets.import_err_missing_title', { row: idx + 1 }));
                }
                schemaFields.forEach(f => {
                    const resolvedVal = fields[f.key] !== undefined ? fields[f.key] : item[f.key];
                    if (f.required && (resolvedVal === undefined || resolvedVal === null || resolvedVal === '')) {
                        errors.push(t('datasets.import_err_missing_field', { row: idx + 1, field: f.label || f.key }));
                    }
                });
            });
            if (errors.length > 0) {
                const errList = errors.map(e => `<div>&bull; ${String(e).replace(/</g, '&lt;')}</div>`).join('');
                updateImportState({ errorHtml: `<div class="text-red-500 font-bold mb-1">${t('datasets.import_validation_failed', { errors: errors.length })}</div><div class="max-h-24 overflow-y-auto text-red-400 space-y-0.5">${errList}</div>` });
            } else {
                updateImportState({ items });
            }
        } catch (err) {
            const safeMsg = String(err.message || t('datasets.import_invalid_json')).replace(/</g, '&lt;');
            updateImportState({ errorHtml: `<span class="text-red-500 font-bold">${safeMsg}</span>` });
        }
    }

    async function submitCollectionJsonImport() {
        if (!Array.isArray(parsedImportItems) || parsedImportItems.length === 0) return;
        const btn = document.getElementById('btn-confirm-collection-import');
        const skipEl = document.getElementById('collection-import-skip-conflicts');
        const feedback = document.getElementById('collection-import-feedback');
        const onConflict = (skipEl && skipEl.checked) ? 'skip' : 'error';
        if (btn) btn.disabled = true;

        try {
            let totalImported = 0;
            let totalSkipped = 0;
            for (let i = 0; i < parsedImportItems.length; i += 10) {
                const slice = parsedImportItems.slice(i, i + 10);
                const res = await fetch('/admin/datasets/api/batch-import', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        collection_id: collectionId || undefined,
                        schema_slug: schemaSlug,
                        on_conflict: onConflict,
                        items: slice
                    })
                });
                const data = await res.json();
                if (!res.ok || !data.success) {
                    const errMsg = (data && data.error) || t('datasets.import_failed');
                    if (feedback) feedback.innerHTML = `<span class="text-red-500 font-bold">${String(errMsg).replace(/</g, '&lt;')}</span>`;
                    if (window.showToast) window.showToast(errMsg, 'error');
                    if (btn) btn.disabled = false;
                    return;
                }
                totalImported += Number(data.count || 0);
                totalSkipped += Number(data.skippedCount || 0);
            }
            const okMsg = totalSkipped > 0
                ? t('datasets.import_success_with_skipped', { count: totalImported, skipped: totalSkipped })
                : t('datasets.import_success', { count: totalImported });
            if (window.showToast) window.showToast(okMsg, 'success');
            setTimeout(() => window.location.reload(), 500);
        } catch (err) {
            if (window.showToast) window.showToast(t('common.network_error'), 'error');
            if (btn) btn.disabled = false;
        }
    }

    function renderHeader() {
        const headTr = document.getElementById('collection-table-head');
        if (!headTr) return;
        let html = '<th class="w-10 px-3 py-3 text-center">#</th>';
        html += `<th class="px-4 py-3 min-w-[160px]">${t('datasets.col_title') || 'Title'}</th>`;
        html += `<th class="w-24 px-3 py-3 text-center">${t('datasets.col_sort_order') || 'Weight'}</th>`;
        schemaFields.forEach(f => {
            if (f.key === 'title') return;
            html += `<th class="px-4 py-3 min-w-[140px]">${f.label || f.key}</th>`;
        });
        html += `<th class="w-16 px-3 py-3 text-center">${t('datasets.col_actions') || 'Actions'}</th>`;
        headTr.innerHTML = html;
    }

    function renderBody() {
        const tbody = document.getElementById('collection-table-body');
        if (!tbody) return;
        tbody.innerHTML = '';

        if (rows.length === 0) {
            const emptyTr = document.createElement('tr');
            const colSpan = 4 + schemaFields.filter(f => f.key !== 'title').length;
            emptyTr.innerHTML = `<td colspan="${colSpan}" class="px-6 py-10 text-center text-stone-400 text-xs">${t('datasets.empty') || 'No items'}</td>`;
            tbody.appendChild(emptyTr);
            return;
        }

        rows.forEach((row, idx) => {
            const tr = document.createElement('tr');
            tr.className = 'h-11 hover:bg-stone-50/70 dark:hover:bg-stone-700/30 transition-colors duration-75 ease-out';
            tr.setAttribute('draggable', 'true');
            tr.dataset.index = String(idx);

            tr.addEventListener('dragstart', (e) => {
                dragSrcIndex = idx;
                tr.classList.add('opacity-50');
                if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
            });
            tr.addEventListener('dragend', () => {
                tr.classList.remove('opacity-50');
            });
            tr.addEventListener('dragover', (e) => {
                e.preventDefault();
                if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
            });
            tr.addEventListener('drop', (e) => {
                e.preventDefault();
                if (dragSrcIndex !== null && dragSrcIndex !== idx) {
                    const moved = rows.splice(dragSrcIndex, 1)[0];
                    rows.splice(idx, 0, moved);
                    renderBody();
                }
                dragSrcIndex = null;
            });

            const tdDrag = document.createElement('td');
            tdDrag.className = 'px-3 py-2 text-center cursor-grab text-stone-400 hover:text-stone-600 dark:hover:text-stone-200';
            tdDrag.innerHTML = '<span class="material-symbols-outlined text-[16px]">drag_indicator</span>';
            tr.appendChild(tdDrag);

            const tdTitle = document.createElement('td');
            tdTitle.className = 'px-3 py-1.5';
            const titleInput = document.createElement('input');
            titleInput.type = 'text';
            titleInput.value = row.title || '';
            titleInput.className = 'w-full bg-transparent border border-transparent hover:border-[var(--admin-border)] focus:border-[var(--admin-accent)] focus:bg-[var(--admin-surface)] rounded-lg px-2.5 py-1 text-xs font-bold text-[var(--admin-text)] outline-none transition-colors duration-75 overflow-hidden text-ellipsis whitespace-nowrap';
            titleInput.addEventListener('input', (e) => { rows[idx].title = e.target.value; });
            tdTitle.appendChild(titleInput);
            tr.appendChild(tdTitle);

            const tdSort = document.createElement('td');
            tdSort.className = 'px-2 py-1.5';
            const sortInput = document.createElement('input');
            sortInput.type = 'number';
            sortInput.step = '1';
            sortInput.value = String(Number(row.sort_order) || 0);
            sortInput.className = 'w-full bg-transparent border border-transparent hover:border-[var(--admin-border)] focus:border-[var(--admin-accent)] focus:bg-[var(--admin-surface)] rounded-lg px-2 py-1 text-xs font-mono text-center text-[var(--admin-text)] outline-none transition-colors duration-75';
            sortInput.addEventListener('input', (e) => { rows[idx].sort_order = e.target.value === '' ? 0 : (Number(e.target.value) || 0); });
            tdSort.appendChild(sortInput);
            tr.appendChild(tdSort);

            schemaFields.forEach(f => {
                if (f.key === 'title') return;
                const td = document.createElement('td');
                td.className = 'px-3 py-1.5';
                const val = row.fields ? row.fields[f.key] : '';

                if (f.type === 'boolean') {
                    td.className = 'px-3 py-1.5 text-center';
                    const cb = document.createElement('input');
                    cb.type = 'checkbox';
                    cb.checked = Boolean(val);
                    cb.className = 'w-4 h-4 rounded border-stone-300 dark:border-stone-600 text-amber-600 cursor-pointer accent-amber-600';
                    cb.addEventListener('change', (e) => {
                        if (!rows[idx].fields) rows[idx].fields = {};
                        rows[idx].fields[f.key] = e.target.checked;
                    });
                    td.appendChild(cb);
                } else {
                    const inp = document.createElement('input');
                    inp.type = f.type === 'number' ? 'number' : 'text';
                    inp.value = val !== undefined && val !== null ? String(val) : '';
                    inp.className = 'w-full bg-transparent border border-transparent hover:border-[var(--admin-border)] focus:border-[var(--admin-accent)] focus:bg-[var(--admin-surface)] rounded-lg px-2.5 py-1 text-xs font-mono text-[var(--admin-text)] outline-none transition-colors duration-75 overflow-hidden text-ellipsis whitespace-nowrap';
                    inp.title = inp.value;
                    inp.addEventListener('input', (e) => {
                        if (!rows[idx].fields) rows[idx].fields = {};
                        rows[idx].fields[f.key] = f.type === 'number' && e.target.value !== '' ? Number(e.target.value) : e.target.value;
                    });
                    td.appendChild(inp);
                }
                tr.appendChild(td);
            });

            const tdAct = document.createElement('td');
            tdAct.className = 'px-3 py-2 text-center';
            const delBtn = document.createElement('button');
            delBtn.type = 'button';
            delBtn.className = 'p-1 rounded-lg text-stone-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950/50 transition-colors duration-75 cursor-pointer';
            delBtn.innerHTML = '<span class="material-symbols-outlined text-[16px]">delete</span>';
            delBtn.addEventListener('click', () => {
                if (rows[idx].id) deletedIds.push(rows[idx].id);
                rows.splice(idx, 1);
                renderBody();
            });
            tdAct.appendChild(delBtn);
            tr.appendChild(tdAct);

            tbody.appendChild(tr);
        });
    }

    async function saveCollection() {
        const btn = document.getElementById('btn-save-collection');
        if (btn) btn.disabled = true;
        try {
            const res = await fetch('/admin/datasets/api/collection-save', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    collection_id: collectionId || undefined,
                    schema_slug: schemaSlug,
                    rows: rows,
                    deleted_ids: deletedIds
                })
            });
            const data = await res.json();
            if (data && data.success) {
                if (window.showToast) window.showToast(t('datasets.save_collection_success') || 'Saved!', 'success');
                setTimeout(() => window.location.reload(), 500);
            } else {
                if (window.showToast) window.showToast((data && data.error) || t('common.error') || 'Error', 'error');
            }
        } catch (err) {
            if (window.showToast) window.showToast(err.message || 'Error', 'error');
        } finally {
            if (btn) btn.disabled = false;
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
