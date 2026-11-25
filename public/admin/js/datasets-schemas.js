(function() {
    'use strict';

    const t = function(k, params) {
        const fn = window.__EDGE_I18N__ && window.__EDGE_I18N__.t;
        return typeof fn === 'function' ? fn(k, params) : k;
    };

    let parsedDatasetImportItems = null;

    window.updateDatasetBatchState = function() {
        const checked = Array.from(document.querySelectorAll('.dataset-select-box:checked'));
        const toolbar = document.getElementById('datasets-batch-toolbar');
        const badge = document.getElementById('datasets-selected-badge');
        if (toolbar) {
            if (checked.length > 0) toolbar.classList.remove('hidden');
            else toolbar.classList.add('hidden');
        }
        if (badge) {
            badge.textContent = t('common.selected_count', { count: checked.length });
        }
    };

    window.toggleAllDatasetCheckboxes = function(master) {
        document.querySelectorAll('.dataset-select-box').forEach(function(cb) {
            const row = cb.closest('tr');
            if (!row || row.style.display !== 'none') cb.checked = !!master.checked;
        });
        window.updateDatasetBatchState();
    };

    window.clearDatasetCollectionSelection = function() {
        const master = document.getElementById('dataset-select-all');
        if (master) master.checked = false;
        document.querySelectorAll('.dataset-select-box').forEach(function(cb) { cb.checked = false; });
        window.updateDatasetBatchState();
    };

    window.openCreateCollectionModal = function() {
        const modal = document.getElementById('dataset-create-collection-modal');
        const nameEl = document.getElementById('new-collection-name');
        const slugEl = document.getElementById('new-collection-slug');
        if (nameEl) nameEl.value = '';
        if (slugEl) slugEl.value = '';
        if (modal) modal.classList.remove('hidden');
    };

    window.submitCreateCollection = async function() {
        const nameEl = document.getElementById('new-collection-name');
        const slugEl = document.getElementById('new-collection-slug');
        const schemaEl = document.getElementById('new-collection-schema');
        const name = nameEl ? nameEl.value.trim() : '';
        const slug = slugEl ? slugEl.value.trim().toLowerCase() : '';
        const schemaKey = schemaEl ? schemaEl.value.trim() : '';

        if (!name || !slug || !schemaKey) {
            if (window.showToast) window.showToast(t('common.fill_required'), 'warning');
            return;
        }
        try {
            const res = await fetch('/admin/datasets/api/collections/create', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, slug, schema_key: schemaKey })
            });
            const data = await res.json();
            if (!res.ok || !data.success) {
                if (window.showToast) window.showToast((data && data.error) || t('common.save_failed'), 'error');
                return;
            }
            if (window.showToast) window.showToast(t('datasets.collection_created'), 'success');
            setTimeout(function() { window.location.reload(); }, 400);
        } catch (e) {
            if (window.showToast) window.showToast(t('common.network_error'), 'error');
        }
    };

    window.deleteDatasetCollection = function(id, name, itemCount) {
        const msg = Number(itemCount) > 0
            ? t('datasets.confirm_delete_collection_with_items', { name: name, count: itemCount })
            : t('datasets.confirm_delete_collection_empty', { name: name });
        const execDelete = async function() {
            const res = await fetch('/admin/datasets/api/collections/batch-delete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ids: [id] })
            });
            const data = await res.json();
            if (res.ok && data.success) {
                if (window.showToast) window.showToast(t('datasets.collection_deleted'), 'success');
                setTimeout(function() { window.location.reload(); }, 400);
            } else if (window.showToast) {
                window.showToast((data && data.error) || t('common.delete_failed'), 'error');
            }
        };
        if (window.showConfirmDialog) {
            window.showConfirmDialog({ title: t('common.confirm_delete_title'), message: msg, icon: 'delete', onConfirm: execDelete });
        } else {
            execDelete();
        }
    };

    window.handleBatchDeleteCollections = function() {
        const selected = Array.from(document.querySelectorAll('.dataset-select-box:checked')).map(function(el) {
            return el.getAttribute('data-id');
        }).filter(Boolean);
        if (selected.length === 0) return;
        const msg = t('datasets.confirm_batch_delete_collections', { count: selected.length });
        const execDelete = async function() {
            const res = await fetch('/admin/datasets/api/collections/batch-delete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ids: selected })
            });
            const data = await res.json();
            if (res.ok && data.success) {
                if (window.showToast) window.showToast(t('datasets.collection_deleted'), 'success');
                setTimeout(function() { window.location.reload(); }, 400);
            } else if (window.showToast) {
                window.showToast((data && data.error) || t('common.delete_failed'), 'error');
            }
        };
        if (window.showConfirmDialog) {
            window.showConfirmDialog({ title: t('common.confirm_delete_title'), message: msg, icon: 'delete', onConfirm: execDelete });
        } else {
            execDelete();
        }
    };

    window.handleBatchExportDatasetJson = function() {
        const selected = Array.from(document.querySelectorAll('.dataset-select-box:checked'));
        if (selected.length === 0) {
            if (window.showToast) window.showToast(t('common.no_nodes_selected'), 'warning');
            return;
        }
        const ids = selected.map(function(el) { return el.getAttribute('data-id'); }).filter(Boolean);
        window.location.href = '/admin/datasets/api/collections/export-selected?ids=' + ids.join(',');
    };

    window.openDatasetImportModal = function() {
        const modal = document.getElementById('dataset-import-modal');
        const feedback = document.getElementById('import-validation-feedback');
        const submitBtn = document.getElementById('btn-submit-dataset-import');
        const fileInput = document.getElementById('import-json-file');

        if (fileInput) fileInput.value = '';
        if (feedback) feedback.innerHTML = '';
        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.className = 'bg-stone-400 text-white px-5 py-2 rounded-xl text-xs font-bold shadow-sm transition flex items-center space-x-1.5 cursor-not-allowed';
        }
        parsedDatasetImportItems = null;
        if (modal) modal.classList.remove('hidden');
    };

    window.handleDatasetFileSelected = function(fileInput) {
        const file = fileInput.files && fileInput.files[0];
        const feedback = document.getElementById('import-validation-feedback');
        const submitBtn = document.getElementById('btn-submit-dataset-import');
        const schemaSelect = document.getElementById('import-target-collection');

        if (!file) return;

        const selectedOption = schemaSelect ? schemaSelect.options[schemaSelect.selectedIndex] : null;
        const rawMeta = selectedOption ? selectedOption.getAttribute('data-fields') : null;
        let schemaFields = [];
        if (rawMeta) {
            try {
                const parsedMeta = JSON.parse(decodeURIComponent(rawMeta));
                schemaFields = parsedMeta.fields || parsedMeta.schema?.fields || [];
            } catch (e) {}
        }

        const reader = new FileReader();
        reader.onload = function(e) {
            try {
                const parsed = JSON.parse(e.target.result);
                const items = Array.isArray(parsed)
                    ? parsed
                    : (parsed && typeof parsed === 'object' && Array.isArray(parsed.items) ? parsed.items : null);
                if (!Array.isArray(items) || items.length === 0) {
                    throw new Error(t('datasets.import_empty_or_not_array'));
                }

                const errors = [];
                items.forEach(function(item, idx) {
                    const fields = (item && (item.fields || item.data)) || item || {};
                    if (!item || (!item.title && !item.name && !fields.title && !fields.name)) {
                        errors.push(t('datasets.import_err_missing_title', { row: idx + 1 }));
                    }
                    if (schemaFields.length > 0) {
                        schemaFields.forEach(function(f) {
                            if (f.required && (fields[f.key] === undefined || fields[f.key] === null || fields[f.key] === '')) {
                                errors.push(t('datasets.import_err_missing_field', { row: idx + 1, field: f.label || f.key }));
                            }
                        });
                    }
                });

                if (errors.length > 0) {
                    if (feedback) {
                        feedback.innerHTML = '<div class="text-red-500 font-bold mb-1">' + t('datasets.import_validation_failed') + ' (' + errors.length + ')</div>' +
                            '<div class="max-h-24 overflow-y-auto text-red-400 space-y-0.5">' +
                            errors.map(function(err) { return '<div>• ' + err + '</div>'; }).join('') +
                            '</div>';
                    }
                    if (submitBtn) {
                        submitBtn.disabled = true;
                        submitBtn.className = 'bg-stone-400 text-white px-5 py-2 rounded-xl text-xs font-bold shadow-sm transition flex items-center space-x-1.5 cursor-not-allowed';
                    }
                    parsedDatasetImportItems = null;
                } else {
                    if (feedback) {
                        feedback.innerHTML = '<span class="text-amber-500 font-bold">' + t('datasets.import_validation_success', { count: items.length }) + '</span>';
                    }
                    if (submitBtn) {
                        submitBtn.disabled = false;
                        submitBtn.className = 'bg-[var(--admin-accent)] hover:bg-[var(--admin-accent-hover)] text-[var(--admin-accent-on)] px-5 py-2 rounded-xl text-xs font-bold shadow-sm transition flex items-center space-x-1.5 cursor-pointer';
                    }
                    parsedDatasetImportItems = items;
                }
            } catch (err) {
                if (feedback) {
                    feedback.innerHTML = '<span class="text-red-500 font-bold">' + (err.message || t('datasets.import_invalid_json')) + '</span>';
                }
                if (submitBtn) {
                    submitBtn.disabled = true;
                    submitBtn.className = 'bg-stone-400 text-white px-5 py-2 rounded-xl text-xs font-bold shadow-sm transition flex items-center space-x-1.5 cursor-not-allowed';
                }
                parsedDatasetImportItems = null;
            }
        };
        reader.readAsText(file);
    };

    window.submitDatasetImport = async function() {
        if (!parsedDatasetImportItems) return;
        const schemaSelect = document.getElementById('import-target-collection');
        const schemaSlug = schemaSelect ? schemaSelect.value : '';
        const submitBtn = document.getElementById('btn-submit-dataset-import');

        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.innerHTML = '<span class="material-symbols-outlined text-[16px] animate-spin">refresh</span><span>' + t('common.importing') + '</span>';
        }

        try {
            let totalImported = 0;
            const totalItems = parsedDatasetImportItems.length;
            // Slice into 10-item batches to stay within Worker/D1 per-request execution and subrequest limits.
            for (let i = 0; i < totalItems; i += 10) {
                const slice = parsedDatasetImportItems.slice(i, i + 10);
                const res = await fetch('/admin/datasets/api/batch-import', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        collection_id: schemaSlug,
                        items: slice
                    })
                });
                const data = await res.json();
                if (!res.ok || !data.success) {
                    if (window.showToast) window.showToast(data.error || t('datasets.import_failed'), 'error');
                    if (submitBtn) {
                        submitBtn.disabled = false;
                        submitBtn.innerHTML = '<span class="material-symbols-outlined text-[16px]">check</span><span>' + t('datasets.btn_confirm_import') + '</span>';
                    }
                    return;
                }
                totalImported += Number(data.count || slice.length);
                if (submitBtn) {
                    submitBtn.innerHTML = '<span class="material-symbols-outlined text-[16px] animate-spin">refresh</span><span>' + totalImported + ' / ' + totalItems + '</span>';
                }
            }
            if (window.showToast) window.showToast(t('datasets.import_success', { count: totalImported }), 'success');
            setTimeout(function() { window.location.reload(); }, 600);
        } catch (e) {
            if (window.showToast) window.showToast(t('common.network_error'), 'error');
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.innerHTML = '<span class="material-symbols-outlined text-[16px]">check</span><span>' + t('datasets.btn_confirm_import') + '</span>';
            }
        }
    };

    window.handleDatasetFormSubmit = async function(event) {
        event.preventDefault();
        const form = event.target;
        const feedback = document.getElementById('dataset-form-feedback');
        const submitBtn = form.querySelector('button[type="submit"]');

        const formData = new FormData(form);
        const title = (formData.get('title') || '').toString().trim();
        const slug = (formData.get('slug') || '').toString().trim();
        const schemaSlug = (formData.get('schema_slug') || '').toString().trim();
        const summary = (formData.get('summary') || '').toString().trim();
        const commitMessage = (formData.get('commit_message') || '').toString().trim();
        const status = (formData.get('status') || 'published').toString();
        const id = (formData.get('dataset_id') || formData.get('id') || '').toString().trim();

        if (!title) {
            if (feedback) feedback.innerHTML = '<span class="text-red-500 font-bold">' + t('datasets.error_title_required') + '</span>';
            return;
        }

        const fields = {};
        form.querySelectorAll('input[type="checkbox"][name^="field_"]').forEach(function(cb) {
            fields[cb.name.replace('field_', '')] = !!cb.checked;
        });
        for (const [key, value] of formData.entries()) {
            if (key.startsWith('field_')) {
                const fieldName = key.replace('field_', '');
                if (typeof fields[fieldName] !== 'boolean') {
                    fields[fieldName] = value;
                }
            }
        }

        const payload = {
            dataset_id: id || undefined,
            title: title,
            slug: slug || undefined,
            schema_slug: schemaSlug,
            summary: summary,
            sort_order: Number(formData.get('sort_order')) || 0,
            commit_message: commitMessage,
            status: status,
            fields: fields
        };

        if (submitBtn) submitBtn.disabled = true;
        if (feedback) feedback.innerHTML = '<span class="text-stone-400 font-bold">' + t('common.saving') + '</span>';

        try {
            const res = await fetch('/admin/datasets/api/save', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            const result = await res.json();
            if (result.success) {
                if (window.showToast) window.showToast(t('articles.save_success_version', { version: result.version || 1 }), 'success');
                setTimeout(function() { window.location.href = '/admin/datasets'; }, 500);
            } else {
                if (feedback) feedback.innerHTML = '<span class="text-red-500 font-bold">' + (result.error || t('common.error')) + '</span>';
            }
        } catch (e) {
            if (feedback) feedback.innerHTML = '<span class="text-red-500 font-bold">' + e.message + '</span>';
        } finally {
            if (submitBtn) submitBtn.disabled = false;
        }
    };

    window.filterDatasetTable = function(query) {
        const cleanQ = (query || '').toLowerCase().trim();
        const rows = document.querySelectorAll('.dataset-row');
        rows.forEach(function(row) {
            const text = row.innerText.toLowerCase();
            if (!cleanQ || text.includes(cleanQ)) {
                row.classList.remove('hidden');
            } else {
                row.classList.add('hidden');
            }
        });
    };

    window.selectDatasetSchemaOption = function(slug, label) {
        const input = document.getElementById('dataset-schema-input');
        const labelEl = document.getElementById('dataset-schema-label');
        const menu = document.getElementById('dropdown-menu-dataset-schema');

        if (input) input.value = slug;
        if (labelEl) labelEl.innerText = label;
        if (menu) menu.classList.add('hidden');

        let schemasData = [];
        try {
            const dataEl = document.getElementById('dataset-schemas-data');
            if (dataEl && dataEl.textContent) schemasData = JSON.parse(dataEl.textContent);
        } catch(e) {}

        const matchedSchema = schemasData.find(function(s) { return s.slug === slug; });
        const container = document.getElementById('dynamic-schema-fields-container');
        if (matchedSchema && container) {
            const fields = matchedSchema.fields || [];
            if (fields.length === 0) {
                container.innerHTML = '<div class="p-6 text-center text-stone-400 text-xs italic">' + (t('editor.no_schema_fields') || 'No custom fields in this schema contract.') + '</div>';
            } else {
                container.innerHTML = fields.map(function(f) {
                    const requiredMark = f.required ? '<span class="text-red-500 font-bold ml-0.5">*</span>' : '';
                    const requiredAttr = f.required ? 'required' : '';
                    const fieldId = 'field_' + f.key;
                    const val = f.default !== undefined && f.default !== null ? f.default : '';

                    if (f.type === 'textarea') {
                        return '<div><label class="block text-xs font-bold text-stone-700 dark:text-stone-300 mb-1" for="' + fieldId + '">' + (f.label || f.key) + requiredMark + '</label>' +
                            '<textarea id="' + fieldId + '" name="field_' + f.key + '" ' + requiredAttr + ' placeholder="' + (f.placeholder || '') + '" class="w-full bg-stone-50 dark:bg-stone-950 border border-stone-300 dark:border-stone-700 rounded-xl px-3 py-2 text-xs text-stone-800 dark:text-stone-100 h-24 resize-none focus:border-stone-900 dark:focus:border-amber-500 outline-none leading-relaxed">' + val + '</textarea></div>';
                    } else if (f.type === 'select' && Array.isArray(f.options)) {
                        const optHtml = f.options.map(function(opt) {
                            return '<option value="' + opt.value + '">' + (opt.label || opt.value) + '</option>';
                        }).join('');
                        return '<div><label class="block text-xs font-bold text-stone-700 dark:text-stone-300 mb-1" for="' + fieldId + '">' + (f.label || f.key) + requiredMark + '</label>' +
                            '<edge-select id="' + fieldId + '" name="field_' + f.key + '" class="w-full bg-stone-50 dark:bg-stone-950 border border-stone-300 dark:border-stone-700 rounded-xl p-2.5 text-xs font-semibold text-stone-800 dark:text-stone-200 outline-none focus:border-amber-500">' + optHtml + '</edge-select></div>';
                    } else if (f.type === 'boolean') {
                        return '<div class="flex items-center space-x-2 pt-2"><input type="checkbox" id="' + fieldId + '" name="field_' + f.key + '" value="true" ' + (val ? 'checked' : '') + ' class="rounded text-amber-600 focus:ring-0 cursor-pointer" /><label for="' + fieldId + '" class="text-xs font-bold text-stone-700 dark:text-stone-300 cursor-pointer">' + (f.label || f.key) + requiredMark + '</label></div>';
                    } else {
                        return '<div><label class="block text-xs font-bold text-stone-700 dark:text-stone-300 mb-1" for="' + fieldId + '">' + (f.label || f.key) + requiredMark + '</label>' +
                            '<input type="' + (f.type || 'text') + '" id="' + fieldId + '" name="field_' + f.key + '" ' + requiredAttr + ' value="' + val + '" placeholder="' + (f.placeholder || '') + '" class="w-full bg-stone-50 dark:bg-stone-950 border border-stone-300 dark:border-stone-700 rounded-xl px-3 py-2 text-xs text-stone-800 dark:text-stone-100 focus:border-stone-900 dark:focus:border-amber-500 outline-none" /></div>';
                    }
                }).join('');
            }
        }
    };

    window.addNewSchemaFieldRow = function() {
        const container = document.getElementById('new-schema-fields-list');
        const emptyTip = document.getElementById('new-schema-fields-empty');
        if (!container) return;
        if (emptyTip) emptyTip.style.display = 'none';

        const rowId = 'field_row_' + Date.now();
        const row = document.createElement('div');
        row.id = rowId;
        row.className = 'flex items-center gap-2 p-2 bg-[var(--admin-canvas)] rounded-lg border border-[var(--admin-border)]';
        row.innerHTML =
            '<input type="text" placeholder="' + t('schemas.field_key_placeholder') + '" class="schema-field-key flex-1 min-w-0 h-7 bg-[var(--admin-surface)] border border-[var(--admin-border)] rounded-md px-2 text-xs font-mono text-[var(--admin-text)] outline-none focus:border-[var(--admin-accent)]" required />' +
            '<input type="text" placeholder="' + t('schemas.field_label_placeholder') + '" class="schema-field-label flex-1 min-w-0 h-7 bg-[var(--admin-surface)] border border-[var(--admin-border)] rounded-md px-2 text-xs text-[var(--admin-text)] outline-none focus:border-[var(--admin-accent)]" required />' +
            '<edge-select class="schema-field-type edge-select-compact inline-flex items-center w-28 h-7 shrink-0 bg-[var(--admin-surface)] border border-[var(--admin-border)] rounded-md px-2 text-xs text-[var(--admin-text)] outline-none">' +
                '<option value="text">' + t('schemas.field_type_text') + '</option>' +
                '<option value="textarea">' + t('schemas.field_type_textarea') + '</option>' +
                '<option value="number">' + t('schemas.field_type_number') + '</option>' +
                '<option value="boolean">' + t('schemas.field_type_boolean') + '</option>' +
            '</edge-select>' +
            '<label class="inline-flex items-center gap-1 h-7 text-[11px] text-[var(--admin-text-muted)] cursor-pointer shrink-0">' +
                '<input type="checkbox" class="schema-field-required rounded text-[var(--admin-accent)] focus:ring-0" />' +
                '<span class="leading-none">' + t('schemas.field_required') + '</span>' +
            '</label>' +
            '<button type="button" onclick="document.getElementById(\'' + rowId + '\').remove()" class="inline-flex items-center justify-center h-7 w-7 rounded-md text-[var(--admin-text-muted)] hover:text-red-500 hover:bg-[var(--admin-surface-hover)] transition cursor-pointer shrink-0">' +
                '<span class="material-symbols-outlined text-[16px] leading-none">delete</span>' +
            '</button>';
        container.appendChild(row);
    };

    window.handleNewSchemaModalSubmit = async function(event) {
        event.preventDefault();
        const title = (document.getElementById('new-schema-title-input')?.value || '').trim();
        const slug = (document.getElementById('new-schema-slug-input')?.value || '').trim().replace(/^\/+/, '');
        const desc = (document.getElementById('new-schema-summary-input')?.value || '').trim();
        const feedback = document.getElementById('new-schema-modal-feedback');

        if (!title || !slug) {
            if (feedback) feedback.innerHTML = '<span class="text-red-500 font-bold">' + t('common.fill_required') + '</span>';
            return;
        }

        const existingSlugs = new Set(['default']);
        document.querySelectorAll('#dropdown-menu-schema [data-value]').forEach(function(el) {
            const v = el.getAttribute('data-value');
            if (v) existingSlugs.add(v);
        });
        try {
            const dsEl = document.getElementById('dataset-schemas-data');
            if (dsEl && dsEl.textContent) {
                JSON.parse(dsEl.textContent).forEach(function(s) {
                    if (s && s.slug) existingSlugs.add(s.slug);
                });
            }
        } catch (e) {}

        if (existingSlugs.has(slug)) {
            if (feedback) feedback.innerHTML = '<span class="text-red-500 font-bold">' + t('schemas.duplicate_slug', { slug: slug }) + '</span>';
            return;
        }

        const rows = document.querySelectorAll('#new-schema-fields-list > div[id^="field_row_"]');
        const fields = [];
        rows.forEach(function(row) {
            const key = (row.querySelector('.schema-field-key')?.value || '').trim();
            const label = (row.querySelector('.schema-field-label')?.value || '').trim();
            const type = row.querySelector('.schema-field-type')?.value || 'text';
            const req = row.querySelector('.schema-field-required')?.checked || false;

            if (key) {
                fields.push({
                    key: key,
                    name: key,
                    label: label || key,
                    title: label || key,
                    type: type,
                    required: req,
                    default: type === 'boolean' ? false : ''
                });
            }
        });

        if (fields.length === 0) {
            if (feedback) feedback.innerHTML = '<span class="text-red-500 font-bold">' + t('schemas.fields_required') + '</span>';
            return;
        }

        const apiOnly = Boolean(document.getElementById('schema-api-only-input')?.checked);
        const metadata = {
            schema: { fields: fields },
            fields: fields,
            description: desc,
            api_only: apiOnly
        };

        try {
            const res = await fetch('/admin/schemas/api/create', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    title: title,
                    slug: slug,
                    summary: desc,
                    fields: fields,
                    api_only: apiOnly,
                    metadata: metadata
                })
            });

            const result = await res.json();
            if (result.success) {
                const createdSlug = result.slug || slug;
                window.closeNewSchemaModal();
                if (window.showToast) window.showToast(t('schemas.save_success', { title: title }), 'success');

                const safeTitle = title.replace(/</g, '&lt;').replace(/>/g, '&gt;');
                const safeSlug = createdSlug.replace(/</g, '&lt;').replace(/>/g, '&gt;');
                const jsTitle = title.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
                const jsSlug = createdSlug.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

                // Update ContentEditor schema dropdown & fields container in place so unsaved article edits are preserved
                const articleMenu = document.getElementById('dropdown-menu-schema');
                const articleFields = document.getElementById('schema-fields-container');
                if (articleMenu && typeof window.selectSchemaOption === 'function') {
                    const opt = document.createElement('div');
                    opt.id = 'schema-item-' + (result.id || createdSlug);
                    opt.setAttribute('data-value', createdSlug);
                    opt.setAttribute('data-label', title);
                    opt.className = 'px-2.5 py-1.5 hover:bg-[var(--admin-surface-hover)] cursor-pointer flex items-center justify-between gap-2';
                    opt.setAttribute('onclick', "selectSchemaOption('" + jsSlug + "', '" + jsTitle + " (" + jsSlug + ")')");
                    opt.innerHTML = '<span class="truncate font-medium">' + safeTitle + '</span><span class="text-[10px] text-[var(--admin-accent-text)] font-mono shrink-0">' + safeSlug + '</span>';
                    articleMenu.appendChild(opt);

                    if (articleFields) {
                        const schemaNodeId = result.slug || result.id || createdSlug;
                        const jsNodeId = String(schemaNodeId).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
                        const group = document.createElement('div');
                        group.id = 'schema-fields-' + createdSlug.replace(/[^a-zA-Z0-9_-]/g, '_');
                        group.setAttribute('data-schema-id', schemaNodeId);
                        group.className = 'schema-fields-group hidden p-2 bg-[var(--admin-surface)] rounded-lg border border-[var(--admin-border)] space-y-1.5';
                        let fieldsHtml = '';
                        if (fields.length === 0) {
                            fieldsHtml = '<div class="text-[11px] text-[var(--admin-text-muted)] italic">' + (t('editor.no_schema_fields') || '') + '</div>';
                        } else {
                            fieldsHtml = fields.map(function(f) {
                                const fKey = String(f.key || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                                const fLabel = String(f.label || f.key || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                                return '<div><label class="block text-[10px] font-bold text-[var(--admin-text-muted)] mb-0.5">' + fLabel + ' <span class="font-mono font-normal">(' + fKey + ')</span></label>' +
                                    '<input type="text" name="meta_' + fKey + '" placeholder="' + fLabel + '" class="w-full h-7 bg-[var(--admin-canvas)] border border-[var(--admin-border)] rounded-md px-2 text-xs text-[var(--admin-text)] outline-none focus:border-[var(--admin-accent)]" /></div>';
                            }).join('');
                        }
                        group.innerHTML = '<div class="flex items-center justify-between gap-1.5">' +
                            '<span class="text-[10px] font-bold text-[var(--admin-accent-text)] font-mono truncate">' + safeTitle + ' (' + safeSlug + ')</span>' +
                            '<button type="button" onclick="deleteSchemaModel(\'' + jsNodeId + '\', \'' + jsTitle + '\')" class="text-[var(--admin-text-muted)] hover:text-red-500 transition inline-flex items-center justify-center w-5 h-5 rounded shrink-0 cursor-pointer" title="' + (t('editor.btn_delete_schema') || '') + '">' +
                                '<span class="material-symbols-outlined text-[14px] leading-none">delete</span>' +
                            '</button>' +
                            '</div>' + fieldsHtml;
                        articleFields.appendChild(group);
                    }
                    window.selectSchemaOption(createdSlug, title + ' (' + createdSlug + ')');
                }

                // Update DatasetEditor schema dropdown & JSON cache in place
                const datasetMenu = document.getElementById('dropdown-menu-dataset-schema');
                const datasetJsonEl = document.getElementById('dataset-schemas-data');
                if (datasetJsonEl) {
                    try {
                        const arr = JSON.parse(datasetJsonEl.textContent || '[]');
                        arr.push({
                            id: result.id || ('schema_' + createdSlug),
                            slug: createdSlug,
                            title: title,
                            summary: desc,
                            is_custom: true,
                            dependent_count: 0,
                            fields: fields
                        });
                        datasetJsonEl.textContent = JSON.stringify(arr);
                    } catch (e) {}
                }
                if (datasetMenu && typeof window.selectDatasetSchemaOption === 'function') {
                    const opt = document.createElement('div');
                    opt.className = 'px-3 py-2.5 hover:bg-stone-50 dark:hover:bg-stone-700 cursor-pointer text-stone-800 dark:text-stone-200 flex items-center justify-between';
                    opt.setAttribute('onclick', "window.selectDatasetSchemaOption && window.selectDatasetSchemaOption('" + jsSlug + "', '" + jsTitle + " (" + jsSlug + ")')");
                    opt.innerHTML = '<span class="truncate">' + safeTitle + '</span><span class="text-[10px] text-stone-400 font-mono ml-2 shrink-0">' + safeSlug + '</span>';
                    datasetMenu.appendChild(opt);
                    window.selectDatasetSchemaOption(createdSlug, title + ' (' + createdSlug + ')');
                }

                // Update DatasetList new-collection <edge-select> in place and select the newly created site schema.
                const collectionSchemaSelect = document.getElementById('new-collection-schema');
                if (collectionSchemaSelect) {
                    const emptyPlaceholder = collectionSchemaSelect.querySelector('option[value=""]');
                    if (emptyPlaceholder) emptyPlaceholder.remove();
                    const optEl = document.createElement('option');
                    optEl.value = createdSlug;
                    optEl.setAttribute('data-custom', '1');
                    optEl.textContent = title + ' (' + createdSlug + ') · ' + t('schemas.source_site');
                    collectionSchemaSelect.appendChild(optEl);
                    if (typeof collectionSchemaSelect.refresh === 'function') {
                        collectionSchemaSelect.refresh(createdSlug);
                    } else {
                        collectionSchemaSelect.value = createdSlug;
                    }
                }
                if (typeof window.renderManageSchemasList === 'function') {
                    window.renderManageSchemasList();
                }
            } else {
                if (feedback) feedback.innerHTML = '<span class="text-red-500 font-bold">' + (result.error || t('common.error')) + '</span>';
            }
        } catch (e) {
            if (feedback) feedback.innerHTML = '<span class="text-red-500 font-bold">' + e.message + '</span>';
        }
    };

    window.openExportSchemaModal = function(title, slug, jsonStr) {
        const modal = document.getElementById('export-schema-modal');
        const titleEl = document.getElementById('export-schema-modal-title');
        const infoEl = document.getElementById('export-schema-modal-info');
        const jsonEl = document.getElementById('export-schema-modal-json');

        if (titleEl) titleEl.innerText = title;
        if (infoEl) infoEl.innerText = slug;
        if (jsonEl) jsonEl.value = jsonStr;
        if (modal) modal.classList.remove('hidden');
    };

    window.copySchemaJsonToClipboard = function() {
        const jsonEl = document.getElementById('export-schema-modal-json');
        if (jsonEl) {
            navigator.clipboard.writeText(jsonEl.value);
            if (window.showToast) window.showToast(t('common.copy_clipboard_success'), 'success');
        }
    };

    window.openNewSchemaModal = function() {
        const modal = document.getElementById('new-schema-modal');
        if (!modal) return;
        const form = document.getElementById('new-schema-modal-form');
        if (form) form.reset();
        const list = document.getElementById('new-schema-fields-list');
        if (list) {
            list.querySelectorAll('div[id^="field_row_"]').forEach(function(el) { el.remove(); });
        }
        const emptyTip = document.getElementById('new-schema-fields-empty');
        if (emptyTip) emptyTip.style.display = '';
        const feedback = document.getElementById('new-schema-modal-feedback');
        if (feedback) feedback.innerHTML = '';
        modal.classList.remove('hidden');
        const titleInput = document.getElementById('new-schema-title-input');
        if (titleInput) titleInput.focus();
    };

    window.closeNewSchemaModal = function() {
        const modal = document.getElementById('new-schema-modal');
        if (modal) modal.classList.add('hidden');
    };

    window.renderManageSchemasList = function() {
        const listEl = document.getElementById('manage-schemas-list');
        if (!listEl) return;
        let schemas = [];
        try {
            const raw = document.getElementById('dataset-schemas-data')?.textContent;
            if (raw) schemas = JSON.parse(raw);
        } catch (e) {}
        listEl.innerHTML = '';
        if (!Array.isArray(schemas) || schemas.length === 0) {
            const emptyDiv = document.createElement('div');
            emptyDiv.className = 'p-6 text-center text-[var(--admin-text-muted)] italic';
            emptyDiv.textContent = t('schemas.empty_custom_tip');
            listEl.appendChild(emptyDiv);
            return;
        }
        schemas.forEach(function(s) {
            const row = document.createElement('div');
            row.className = 'p-3 rounded-xl bg-[var(--admin-canvas)] border border-[var(--admin-border)] flex items-center justify-between gap-3';

            const left = document.createElement('div');
            left.className = 'min-w-0 space-y-1';

            const topLine = document.createElement('div');
            topLine.className = 'flex items-center gap-2 flex-wrap';
            const titleEl = document.createElement('span');
            titleEl.className = 'font-bold text-[var(--admin-text)] truncate';
            titleEl.textContent = s.title || s.slug;
            const slugEl = document.createElement('span');
            slugEl.className = 'font-mono text-[11px] text-[var(--admin-text-muted)]';
            slugEl.textContent = s.slug;
            const srcBadge = document.createElement('span');
            srcBadge.className = s.is_custom
                ? 'px-1.5 py-0.5 rounded bg-[var(--admin-accent-soft)] text-[var(--admin-accent-text)] border border-[var(--admin-accent-border)] text-[10px] font-semibold'
                : 'px-1.5 py-0.5 rounded bg-[var(--admin-chrome)] text-[var(--admin-text-muted)] border border-[var(--admin-border)] text-[10px] font-semibold';
            srcBadge.textContent = s.is_custom ? t('schemas.source_site') : t('schemas.source_theme');
            topLine.append(titleEl, slugEl, srcBadge);
            left.appendChild(topLine);

            const fieldsText = Array.isArray(s.fields) && s.fields.length > 0
                ? s.fields.map(function(f) { return f.key || f.name; }).filter(Boolean).join(', ')
                : '';
            if (fieldsText) {
                const subEl = document.createElement('div');
                subEl.className = 'text-[11px] font-mono text-[var(--admin-text-muted)] truncate';
                subEl.textContent = fieldsText;
                left.appendChild(subEl);
            }

            const right = document.createElement('div');
            right.className = 'shrink-0 flex items-center gap-2';
            const exportOneBtn = document.createElement('button');
            exportOneBtn.type = 'button';
            exportOneBtn.className = 'h-7 px-2 rounded-lg text-[11px] font-semibold text-[var(--admin-text-muted)] hover:text-[var(--admin-text)] hover:bg-[var(--admin-chrome)] border border-[var(--admin-border)] transition cursor-pointer';
            exportOneBtn.textContent = t('schemas.btn_export_one');
            exportOneBtn.onclick = function() {
                window.exportSchemaContractJson && window.exportSchemaContractJson(s);
            };
            right.appendChild(exportOneBtn);
            const depCount = Number(s.dependent_count || 0);
            if (!s.is_custom) {
                const locked = document.createElement('span');
                locked.className = 'text-[11px] text-[var(--admin-text-muted)]';
                locked.textContent = t('schemas.theme_locked_badge');
                right.appendChild(locked);
            } else if (depCount > 0) {
                const inUse = document.createElement('span');
                inUse.className = 'px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400 text-[11px] font-mono';
                inUse.textContent = t('schemas.in_use_badge', { count: depCount });
                right.appendChild(inUse);
            } else {
                const delBtn = document.createElement('button');
                delBtn.type = 'button';
                delBtn.className = 'h-7 px-2.5 rounded-lg text-[11px] font-semibold text-red-600 hover:bg-red-500/10 border border-red-500/20 transition cursor-pointer';
                delBtn.textContent = t('schemas.btn_delete');
                delBtn.onclick = function() {
                    window.deleteSiteSchema && window.deleteSiteSchema(s.slug, s.title || s.slug);
                };
                right.appendChild(delBtn);
            }

            row.append(left, right);
            listEl.appendChild(row);
        });
    };

    function triggerSchemaJsonDownload(filename, payload) {
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    }

    function toExportableSchema(schemaObj) {
        return {
            slug: schemaObj.slug,
            title: schemaObj.title || schemaObj.slug,
            summary: schemaObj.summary || '',
            source: schemaObj.is_custom ? 'site' : 'theme',
            fields: Array.isArray(schemaObj.fields) ? schemaObj.fields : []
        };
    }

    window.exportSchemaContractJson = function(schemaObj) {
        if (!schemaObj) return;
        triggerSchemaJsonDownload('schema-' + (schemaObj.slug || 'contract') + '.json', toExportableSchema(schemaObj));
    };

    window.exportAllSiteSchemasJson = function() {
        const jsonEl = document.getElementById('dataset-schemas-data');
        let schemas = [];
        try { schemas = jsonEl ? JSON.parse(jsonEl.textContent || '[]') : []; } catch (e) {}
        triggerSchemaJsonDownload('site-schemas.json', {
            exported_at: new Date().toISOString(),
            schemas: schemas.map(toExportableSchema)
        });
    };

    window.openManageSchemasModal = function() {
        const importPanel = document.getElementById('import-schema-panel');
        if (importPanel) importPanel.classList.add('hidden');
        window.renderManageSchemasList();
        const modal = document.getElementById('manage-schemas-modal');
        if (modal) modal.classList.remove('hidden');
    };

    window.toggleImportSchemaPanel = function() {
        const panel = document.getElementById('import-schema-panel');
        const feedback = document.getElementById('import-schema-feedback');
        if (!panel) return;
        if (feedback) feedback.innerHTML = '';
        panel.classList.toggle('hidden');
    };

    window.handleSchemaJsonFileSelected = function(fileInput) {
        const file = fileInput && fileInput.files && fileInput.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = function(ev) {
            const ta = document.getElementById('import-schema-textarea');
            if (ta) ta.value = String((ev && ev.target && ev.target.result) || '');
        };
        reader.readAsText(file);
    };

    function appendImportedSchemaToUi(slug, title, summary, fields, id) {
        const jsonEl = document.getElementById('dataset-schemas-data');
        if (jsonEl) {
            try {
                const arr = JSON.parse(jsonEl.textContent || '[]');
                arr.push({
                    id: id || ('schema_' + slug),
                    slug: slug,
                    title: title,
                    summary: summary || '',
                    is_custom: true,
                    dependent_count: 0,
                    fields: fields
                });
                jsonEl.textContent = JSON.stringify(arr);
            } catch (e) {}
        }
        const selectEl = document.getElementById('new-collection-schema');
        if (selectEl) {
            const emptyPlaceholder = selectEl.querySelector('option[value=""]');
            if (emptyPlaceholder) emptyPlaceholder.remove();
            const optEl = document.createElement('option');
            optEl.value = slug;
            optEl.setAttribute('data-custom', '1');
            optEl.textContent = title + ' (' + slug + ') · ' + t('schemas.source_site');
            selectEl.appendChild(optEl);
            if (typeof selectEl.refresh === 'function') selectEl.refresh();
        }
    }

    window.submitImportSchemaJson = async function() {
        const ta = document.getElementById('import-schema-textarea');
        const feedback = document.getElementById('import-schema-feedback');
        const raw = ta ? ta.value.trim() : '';
        if (!raw) {
            if (feedback) feedback.innerHTML = '<span class="text-red-500 font-bold">' + t('schemas.import_invalid_payload') + '</span>';
            return;
        }
        try {
            const parsed = JSON.parse(raw);
            const rawList = Array.isArray(parsed)
                ? parsed
                : (parsed && Array.isArray(parsed.schemas) ? parsed.schemas : [parsed]);
            const candidates = rawList.filter(function(item) {
                return item && typeof item === 'object' && item.source !== 'theme';
            });
            if (candidates.length === 0) {
                throw new Error(t('schemas.import_invalid_payload'));
            }

            const normalizedList = candidates.map(function(s) {
                const slug = String(s.slug || '').trim().replace(/^\/+/, '');
                const title = String(s.title || s.name || '').trim();
                const summary = String(s.summary || s.description || '').trim();
                const fields = Array.isArray(s.fields) ? s.fields : (s.schema && Array.isArray(s.schema.fields) ? s.schema.fields : []);
                const validFields = fields.filter(function(f) { return f && String(f.key || f.name || '').trim().length > 0; }).map(function(f) {
                    const k = String(f.key || f.name).trim();
                    return {
                        key: k,
                        name: k,
                        label: f.label || f.title || k,
                        title: f.title || f.label || k,
                        type: f.type || 'text',
                        required: Boolean(f.required),
                        ...(Array.isArray(f.options) && f.options.length > 0 ? { options: f.options } : {}),
                        default: f.default !== undefined ? f.default : (f.type === 'boolean' ? false : '')
                    };
                });
                if (!slug || !title || validFields.length === 0) {
                    throw new Error(t('schemas.import_invalid_payload'));
                }
                return { slug: slug, title: title, summary: summary, api_only: Boolean(s.api_only), fields: validFields };
            });

            let importedCount = 0;
            for (const item of normalizedList) {
                const res = await fetch('/admin/schemas/api/create', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(item)
                });
                const resJson = await res.json();
                if (!res.ok || !resJson.success) {
                    throw new Error((resJson && resJson.error) || t('common.error'));
                }
                appendImportedSchemaToUi(resJson.slug || item.slug, item.title, item.summary, item.fields, resJson.id);
                importedCount++;
            }

            window.renderManageSchemasList();
            if (ta) ta.value = '';
            const panel = document.getElementById('import-schema-panel');
            if (panel) panel.classList.add('hidden');
            if (feedback) feedback.innerHTML = '';
            if (window.showToast) window.showToast(t('schemas.import_success', { count: importedCount }), 'success');
        } catch (err) {
            if (feedback) feedback.innerHTML = '<span class="text-red-500 font-bold">' + String(err.message || t('schemas.import_invalid_payload')).replace(/</g, '&lt;') + '</span>';
        }
    };

    window.closeManageSchemasModal = function() {
        const modal = document.getElementById('manage-schemas-modal');
        if (modal) modal.classList.add('hidden');
    };

    window.deleteSiteSchema = function(schemaSlug, schemaTitle) {
        if (!schemaSlug) return;
        const execDelete = async function() {
            try {
                const res = await fetch('/admin/schemas/api/delete/' + encodeURIComponent(schemaSlug), {
                    method: 'DELETE'
                });
                const data = await res.json();
                if (!res.ok || !data.success) {
                    if (window.showToast) window.showToast((data && data.error) || t('common.error'), 'error');
                    return;
                }
                const jsonEl = document.getElementById('dataset-schemas-data');
                if (jsonEl) {
                    try {
                        const arr = JSON.parse(jsonEl.textContent || '[]').filter(function(item) {
                            return item && item.slug !== schemaSlug;
                        });
                        jsonEl.textContent = JSON.stringify(arr);
                    } catch (e) {}
                }
                const selectEl = document.getElementById('new-collection-schema');
                if (selectEl) {
                    Array.from(selectEl.querySelectorAll('option')).forEach(function(opt) {
                        if (opt.value === schemaSlug) opt.remove();
                    });
                    if (typeof selectEl.refresh === 'function') selectEl.refresh();
                }
                window.renderManageSchemasList();
                if (window.showToast) window.showToast(t('editor.schema_deleted'), 'success');
            } catch (e) {
                if (window.showToast) window.showToast(t('common.network_error'), 'error');
            }
        };
        if (window.showConfirmDialog) {
            window.showConfirmDialog({
                title: t('schemas.btn_delete'),
                message: schemaTitle || schemaSlug,
                icon: 'delete',
                onConfirm: execDelete
            });
        } else {
            execDelete();
        }
    };

    function getDatasetVcsMap() {
        try {
            const el = document.getElementById('vcs-versions-data');
            return el ? JSON.parse(el.textContent || '{}') : {};
        } catch (e) {
            return {};
        }
    }

    if (!window.inspectVersionById) {
        window.inspectVersionById = function(versionId, vNum) {
            const snap = getDatasetVcsMap()[versionId];
            if (!snap) return;
            const text = typeof snap.contentRaw === 'string' && snap.contentRaw.trim()
                ? snap.contentRaw
                : JSON.stringify(snap.fields || {}, null, 2);
            if (window.showConfirmDialog) {
                window.showConfirmDialog({
                    title: t('editor.viewing_snapshot', { version: vNum }),
                    message: text.slice(0, 1800),
                    icon: 'history',
                    onConfirm: function() {}
                });
            }
        };
    }

    if (!window.rollbackToVersionById) {
        window.rollbackToVersionById = function(versionId, vNum) {
            const snap = getDatasetVcsMap()[versionId];
            if (!snap) return;
            const applyRollback = function() {
                const form = document.getElementById('dataset-editor-form');
                if (!form) return;
                const titleInput = form.querySelector('#dataset-title-input');
                if (titleInput && snap.title) titleInput.value = snap.title;
                const summaryInput = form.querySelector('input[name="summary"]');
                if (summaryInput && snap.summary !== undefined) summaryInput.value = snap.summary;
                const fields = snap.fields || {};
                Object.keys(fields).forEach(function(k) {
                    const el = form.querySelector('[name="field_' + k + '"]');
                    if (!el) return;
                    if (el.type === 'checkbox') el.checked = Boolean(fields[k] === true || fields[k] === 'true' || fields[k] === 1);
                    else el.value = fields[k] ?? '';
                });
                const commitInput = form.querySelector('input[name="commit_message"]');
                if (commitInput) commitInput.value = t('editor.rollback_commit_prefix', { version: vNum });
                if (window.showToast) window.showToast('✔️ ' + t('editor.rollback_success', { version: vNum }), 'success');
            };
            if (window.showConfirmDialog) {
                window.showConfirmDialog({
                    title: t('editor.btn_rollback_snapshot'),
                    message: t('editor.confirm_rollback', { version: vNum }),
                    icon: 'history',
                    onConfirm: applyRollback
                });
            } else {
                applyRollback();
            }
        };
    }

    if (!window.deletePastVersion) {
        window.deletePastVersion = function(vId, vNum) {
            const form = document.getElementById('dataset-editor-form');
            const dsId = form ? (form.querySelector('input[name="dataset_id"]')?.value || '') : '';
            window.showConfirmDialog({
                title: t('common.delete'),
                message: 'v' + vNum,
                icon: 'delete',
                onConfirm: async function() {
                    const res = await fetch('/admin/articles/api/version/' + encodeURIComponent(vId) + '?node_id=' + encodeURIComponent(dsId), { method: 'DELETE' });
                    if (res.ok) {
                        document.getElementById('version-card-' + vId)?.remove();
                        if (window.showToast) window.showToast('✔️ ' + t('common.success'), 'success');
                    }
                }
            });
        };
    }

    window.confirmSoftDeleteDataset = function() {
        const form = document.getElementById('dataset-editor-form');
        const dsId = form ? (form.querySelector('input[name="dataset_id"]')?.value || '') : '';
        if (!dsId) return;
        window.showConfirmDialog({
            title: t('common.btn_move_to_trash'),
            message: t('datasets.confirm_delete'),
            icon: 'delete',
            onConfirm: async function() {
                const res = await fetch('/admin/datasets/api/delete/' + encodeURIComponent(dsId), { method: 'DELETE' });
                if (res.ok) window.location.href = '/admin/datasets';
            }
        });
    };
})();
