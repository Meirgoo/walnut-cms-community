(function() {
    'use strict';

    const t = function(k, params) {
        const fn = window.__WALNUT_I18N__ && window.__WALNUT_I18N__.t;
        return typeof fn === 'function' ? fn(k, params) : k;
    };

    let parsedDatasetImportItems = null;

    window.handleBatchExportDatasetJson = function() {
        const selected = Array.from(document.querySelectorAll('.dataset-select-box:checked'));
        if (selected.length === 0) {
            if (window.showToast) window.showToast(t('common.no_nodes_selected'), 'warning');
            return;
        }

        const schemaSet = new Set();
        const ids = [];
        selected.forEach(function(el) {
            ids.push(el.getAttribute('data-id'));
            schemaSet.add(el.getAttribute('data-schema') || 'unassigned');
        });

        if (schemaSet.size > 1) {
            if (window.showToast) window.showToast(t('datasets.error_title_schema_required'), 'error');
            return;
        }

        window.location.href = '/admin/datasets/api/export-selected?ids=' + ids.join(',');
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
            submitBtn.className = 'bg-slate-400 text-white px-5 py-2 rounded-xl text-xs font-bold shadow-sm transition flex items-center space-x-1.5 cursor-not-allowed';
        }
        parsedDatasetImportItems = null;
        if (modal) modal.classList.remove('hidden');
    };

    window.handleDatasetFileSelected = function(fileInput) {
        const file = fileInput.files && fileInput.files[0];
        const feedback = document.getElementById('import-validation-feedback');
        const submitBtn = document.getElementById('btn-submit-dataset-import');
        const schemaSelect = document.getElementById('import-target-schema');

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
                const items = JSON.parse(e.target.result);
                if (!Array.isArray(items) || items.length === 0) {
                    throw new Error(t('datasets.import_empty_or_not_array'));
                }

                const errors = [];
                items.forEach(function(item, idx) {
                    if (!item.title) {
                        errors.push(t('datasets.import_err_missing_title', { row: idx + 1 }));
                    }
                    if (schemaFields.length > 0) {
                        schemaFields.forEach(function(f) {
                            if (f.required && (item[f.key] === undefined || item[f.key] === null || item[f.key] === '')) {
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
                        submitBtn.className = 'bg-slate-400 text-white px-5 py-2 rounded-xl text-xs font-bold shadow-sm transition flex items-center space-x-1.5 cursor-not-allowed';
                    }
                    parsedDatasetImportItems = null;
                } else {
                    if (feedback) {
                        feedback.innerHTML = '<span class="text-emerald-500 font-bold">' + t('datasets.import_validation_success', { count: items.length }) + '</span>';
                    }
                    if (submitBtn) {
                        submitBtn.disabled = false;
                        submitBtn.className = 'bg-slate-900 hover:bg-black dark:bg-emerald-600 dark:hover:bg-emerald-500 text-white px-5 py-2 rounded-xl text-xs font-bold shadow-sm transition flex items-center space-x-1.5 cursor-pointer';
                    }
                    parsedDatasetImportItems = items;
                }
            } catch (err) {
                if (feedback) {
                    feedback.innerHTML = '<span class="text-red-500 font-bold">' + (err.message || t('datasets.import_invalid_json')) + '</span>';
                }
                if (submitBtn) {
                    submitBtn.disabled = true;
                    submitBtn.className = 'bg-slate-400 text-white px-5 py-2 rounded-xl text-xs font-bold shadow-sm transition flex items-center space-x-1.5 cursor-not-allowed';
                }
                parsedDatasetImportItems = null;
            }
        };
        reader.readAsText(file);
    };

    window.submitDatasetImport = async function() {
        if (!parsedDatasetImportItems) return;
        const schemaSelect = document.getElementById('import-target-schema');
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
                        schema_slug: schemaSlug,
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
        const status = (formData.get('status') || 'published').toString();
        const id = (formData.get('id') || '').toString().trim();

        if (!title) {
            if (feedback) feedback.innerHTML = '<span class="text-red-500 font-bold">' + t('datasets.error_title_required') + '</span>';
            return;
        }

        const fields = {};
        for (const [key, value] of formData.entries()) {
            if (key.startsWith('field_')) {
                const fieldName = key.replace('field_', '');
                fields[fieldName] = value;
            }
        }

        const payload = {
            id: id || undefined,
            title: title,
            slug: slug || undefined,
            schema_slug: schemaSlug,
            summary: summary,
            status: status,
            fields: fields
        };

        if (submitBtn) submitBtn.disabled = true;
        if (feedback) feedback.innerHTML = '<span class="text-slate-400 font-bold">' + t('common.saving') + '</span>';

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

    window.toggleAllDatasetCheckboxes = function(master) {
        const boxes = document.querySelectorAll('.dataset-select-box');
        boxes.forEach(function(b) { b.checked = master.checked; });
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
                container.innerHTML = '<div class="p-6 text-center text-slate-400 text-xs italic">' + (t('editor.no_schema_fields') || 'No custom fields in this schema contract.') + '</div>';
            } else {
                container.innerHTML = fields.map(function(f) {
                    const requiredMark = f.required ? '<span class="text-red-500 font-bold ml-0.5">*</span>' : '';
                    const requiredAttr = f.required ? 'required' : '';
                    const fieldId = 'field_' + f.key;
                    const val = f.default !== undefined && f.default !== null ? f.default : '';

                    if (f.type === 'textarea') {
                        return '<div><label class="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1" for="' + fieldId + '">' + (f.label || f.key) + requiredMark + '</label>' +
                            '<textarea id="' + fieldId + '" name="field_' + f.key + '" ' + requiredAttr + ' placeholder="' + (f.placeholder || '') + '" class="w-full bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-xl px-3 py-2 text-xs text-slate-800 dark:text-slate-100 h-24 resize-none focus:border-slate-900 dark:focus:border-emerald-500 outline-none leading-relaxed">' + val + '</textarea></div>';
                    } else if (f.type === 'select' && Array.isArray(f.options)) {
                        const optHtml = f.options.map(function(opt) {
                            return '<option value="' + opt.value + '">' + (opt.label || opt.value) + '</option>';
                        }).join('');
                        return '<div><label class="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1" for="' + fieldId + '">' + (f.label || f.key) + requiredMark + '</label>' +
                            '<walnut-select id="' + fieldId + '" name="field_' + f.key + '" class="w-full bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-xl p-2.5 text-xs font-semibold text-slate-800 dark:text-slate-200 outline-none focus:border-emerald-500">' + optHtml + '</walnut-select></div>';
                    } else if (f.type === 'boolean') {
                        return '<div class="flex items-center space-x-2 pt-2"><input type="checkbox" id="' + fieldId + '" name="field_' + f.key + '" value="true" ' + (val ? 'checked' : '') + ' class="rounded text-emerald-600 focus:ring-0 cursor-pointer" /><label for="' + fieldId + '" class="text-xs font-bold text-slate-700 dark:text-slate-300 cursor-pointer">' + (f.label || f.key) + requiredMark + '</label></div>';
                    } else {
                        return '<div><label class="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1" for="' + fieldId + '">' + (f.label || f.key) + requiredMark + '</label>' +
                            '<input type="' + (f.type || 'text') + '" id="' + fieldId + '" name="field_' + f.key + '" ' + requiredAttr + ' value="' + val + '" placeholder="' + (f.placeholder || '') + '" class="w-full bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-xl px-3 py-2 text-xs text-slate-800 dark:text-slate-100 focus:border-slate-900 dark:focus:border-emerald-500 outline-none" /></div>';
                    }
                }).join('');
            }
        }
    };

    window.addPageSchemaFieldRow = function() {
        const container = document.getElementById('page-schema-fields-list');
        const emptyTip = document.getElementById('page-schema-fields-empty');
        if (!container) return;
        if (emptyTip) emptyTip.style.display = 'none';

        const rowId = 'field_row_' + Date.now();
        const row = document.createElement('div');
        row.id = rowId;
        row.className = 'flex items-center space-x-2 p-3 bg-slate-50 dark:bg-slate-950 rounded-xl border border-slate-200 dark:border-slate-800';
        row.innerHTML =
            '<input type="text" placeholder="' + t('schemas.field_key_placeholder') + '" class="schema-field-key flex-1 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-lg px-2.5 py-1.5 text-xs font-mono text-slate-800 dark:text-slate-200 outline-none" required />' +
            '<input type="text" placeholder="' + t('schemas.field_label_placeholder') + '" class="schema-field-label flex-1 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-800 dark:text-slate-200 outline-none" required />' +
            '<walnut-select class="schema-field-type w-28 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-lg p-1.5 text-xs text-slate-800 dark:text-slate-200 outline-none">' +
                '<option value="text">' + t('schemas.field_type_text') + '</option>' +
                '<option value="textarea">' + t('schemas.field_type_textarea') + '</option>' +
                '<option value="number">' + t('schemas.field_type_number') + '</option>' +
                '<option value="boolean">' + t('schemas.field_type_boolean') + '</option>' +
            '</walnut-select>' +
            '<label class="flex items-center space-x-1 text-xs text-slate-600 dark:text-slate-400 cursor-pointer">' +
                '<input type="checkbox" class="schema-field-required rounded text-emerald-600 focus:ring-0" />' +
                '<span>' + t('schemas.field_required') + '</span>' +
            '</label>' +
            '<button type="button" onclick="document.getElementById(\'' + rowId + '\').remove()" class="text-slate-400 hover:text-red-500 transition p-1 cursor-pointer">' +
                '<span class="material-symbols-outlined text-[18px]">delete</span>' +
            '</button>';
        container.appendChild(row);
    };

    window.handleNewSchemaPageSubmit = async function(event) {
        event.preventDefault();
        const name = (document.getElementById('new-schema-page-name')?.value || '').trim();
        const slug = (document.getElementById('new-schema-page-slug')?.value || '').trim();
        const desc = (document.getElementById('new-schema-page-desc')?.value || '').trim();
        const feedback = document.getElementById('new-schema-page-feedback');

        if (!name || !slug) {
            if (feedback) feedback.innerHTML = '<span class="text-red-500 font-bold">' + t('common.fill_required') + '</span>';
            return;
        }

        const rows = document.querySelectorAll('#page-schema-fields-list > div[id^="field_row_"]');
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

        const title = name;
        const metadata = {
            schema: { fields: fields },
            fields: fields,
            description: desc
        };

        try {
            const res = await fetch('/admin/schemas/api/create', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    title: title,
                    slug: slug,
                    summary: desc,
                    metadata: metadata
                })
            });

            const result = await res.json();
            if (result.success) {
                if (window.showToast) window.showToast(t('schemas.save_success', { title: title }), 'success');
                setTimeout(function() { window.location.href = '/admin/themes'; }, 500);
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
        window.location.href = '/admin/schemas/new';
    };

    window.closeNewSchemaModal = function() {
        const modal = document.getElementById('new-schema-modal');
        if (modal) modal.classList.add('hidden');
    };
})();
