(function() {
    'use strict';

    const t = function(k, params) {
        const fn = window.__EDGE_I18N__ && window.__EDGE_I18N__.t;
        return typeof fn === 'function' ? fn(k, params) : k;
    };

    const isCpuLimitResponse = function(status, textBody) {
        const helper = window.__EDGE_RUNTIME__ && window.__EDGE_RUNTIME__.isCpuLimitResponse;
        return typeof helper === 'function' ? helper(status, textBody) : false;
    };

    window.filterByFolder = function(tableId, folderName, chipContainerId) {
        const table = document.getElementById(tableId);
        if (!table) return;
        const tbody = table.querySelector('tbody');
        if (!tbody) return;
        const rows = Array.from(tbody.querySelectorAll('tr:not(.table-empty-row)'));
        const f = (folderName || '').trim().toLowerCase();

        rows.forEach(function(row) {
            const rowFolder = (row.getAttribute('data-folder') || '').trim().toLowerCase();
            row.style.display = (!f || f === 'all' || rowFolder === f) ? '' : 'none';
        });

        if (chipContainerId) {
            const container = document.getElementById(chipContainerId);
            if (container) {
                container.querySelectorAll('.folder-chip').forEach(function(c) {
                    const cFolder = (c.getAttribute('data-folder') || '').trim().toLowerCase();
                    c.className = ((!f && cFolder === 'all') || cFolder === f)
                        ? 'folder-chip folder-chip-active'
                        : 'folder-chip folder-chip-inactive';
                });
            }
        }
    };

    window.toggleMoreActionsMenu = function(menuId, event) {
        if (event) event.stopPropagation();
        const menu = document.getElementById(menuId);
        if (!menu) return;
        const willOpen = menu.classList.contains('hidden');
        document.querySelectorAll('.more-actions-menu').forEach(function(el) {
            el.classList.add('hidden');
        });
        if (willOpen) menu.classList.remove('hidden');
    };

    document.addEventListener('click', function(e) {
        if (e.target && e.target.closest && e.target.closest('.more-actions-wrapper')) return;
        document.querySelectorAll('.more-actions-menu').forEach(function(el) {
            el.classList.add('hidden');
        });
    });

    const activeColMultiFilters = {};

    window.toggleColumnHeaderFilter = function(e, tableId, colName) {
        e.stopPropagation();
        const existing = document.getElementById('col-filter-popover');
        if (existing) {
            const prevCol = existing.getAttribute('data-current-col');
            const prevTable = existing.getAttribute('data-current-table');
            existing.remove();
            if (prevCol === colName && prevTable === tableId) return;
        }

        const btn = e.currentTarget;
        const rect = btn.getBoundingClientRect();
        const table = document.getElementById(tableId);
        const filterKey = tableId + ':' + colName;
        const selectedSet = new Set(activeColMultiFilters[filterKey] || []);

        const valueCounts = new Map();
        if (table) {
            table.querySelectorAll('tbody tr:not(.table-empty-row)').forEach(function(row) {
                const cell = row.querySelector('[data-col="' + colName + '"]');
                const raw = ((cell ? cell.textContent : '') || '').replace(/\s+/g, ' ').trim();
                if (raw && raw !== '-') {
                    valueCounts.set(raw, (valueCounts.get(raw) || 0) + 1);
                }
            });
        }
        const sortedValues = Array.from(valueCounts.entries()).sort(function(a, b) {
            return b[1] - a[1] || a[0].localeCompare(b[0]);
        });

        const popover = document.createElement('div');
        popover.id = 'col-filter-popover';
        popover.setAttribute('data-current-col', colName);
        popover.setAttribute('data-current-table', tableId);
        popover.className = 'fixed z-50 bg-white dark:bg-stone-800 border border-stone-200 dark:border-stone-700 rounded-xl shadow-2xl p-2.5 space-y-2 text-xs w-60';
        popover.style.left = Math.min(window.innerWidth - 250, Math.max(10, rect.left - 80)) + 'px';
        popover.style.top = (rect.bottom + 6) + 'px';

        const optionsHtml = sortedValues.length === 0
            ? ''
            : `<div id="col-filter-options" class="max-h-44 overflow-y-auto thin-scrollbar space-y-0.5 border-t border-b border-stone-100 dark:border-stone-700/70 py-1.5">
                ${sortedValues.map(function(entry) {
                    const val = entry[0];
                    const cnt = entry[1];
                    const escVal = val.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
                    const checked = selectedSet.has(val) ? 'checked' : '';
                    return `<label class="col-filter-opt flex items-center justify-between gap-2 px-1.5 py-1 rounded hover:bg-stone-50 dark:hover:bg-stone-700/60 cursor-pointer" data-val="${escVal}">
                        <span class="flex items-center space-x-1.5 min-w-0">
                            <input type="checkbox" class="col-filter-cb rounded text-amber-600 focus:ring-0 shrink-0" value="${escVal}" ${checked} />
                            <span class="truncate text-[11px] text-stone-700 dark:text-stone-200" title="${escVal}">${escVal}</span>
                        </span>
                        <span class="text-[10px] font-mono text-stone-400 shrink-0">${cnt}</span>
                    </label>`;
                }).join('')}
            </div>`;

        popover.innerHTML = `
            <div class="flex items-center justify-between pb-1.5 border-b border-stone-100 dark:border-stone-700">
                <span class="font-bold text-stone-700 dark:text-stone-200 text-[11px] flex items-center space-x-1">
                    <span class="material-symbols-outlined text-[13px] text-amber-500">filter_alt</span>
                    <span>${t('common.filter')}: ${colName}</span>
                </span>
                <button type="button" class="text-stone-400 hover:text-stone-600 dark:hover:text-white cursor-pointer" onclick="document.getElementById('col-filter-popover')?.remove()">
                    <span class="material-symbols-outlined text-[14px]">close</span>
                </button>
            </div>
            <input type="text" id="col-filter-input" placeholder="${t('common.search_placeholder')}" class="w-full bg-stone-50 dark:bg-stone-900 border border-stone-200 dark:border-stone-700 rounded-lg px-2 py-1 text-xs outline-none focus:border-amber-500" />
            ${optionsHtml}
            <div class="flex justify-between items-center pt-0.5">
                <button type="button" class="text-stone-400 hover:text-stone-600 dark:hover:text-stone-200 text-[10px] cursor-pointer" id="col-filter-reset-btn">${t('common.clear')}</button>
                <button type="button" class="bg-[#B45309] hover:bg-[#92400E] text-white px-2.5 py-0.5 rounded text-[11px] font-bold cursor-pointer" id="col-filter-apply-btn">${t('common.filter')}</button>
            </div>
        `;

        document.body.appendChild(popover);

        const getCheckedValues = function() {
            return Array.from(popover.querySelectorAll('.col-filter-cb:checked')).map(function(cb) { return cb.value; });
        };

        const input = document.getElementById('col-filter-input');
        if (input) {
            input.focus();
            input.addEventListener('input', function() {
                const q = input.value.trim().toLowerCase();
                popover.querySelectorAll('.col-filter-opt').forEach(function(opt) {
                    const v = (opt.getAttribute('data-val') || '').toLowerCase();
                    opt.style.display = (!q || v.indexOf(q) !== -1) ? '' : 'none';
                });
            });
            input.addEventListener('keydown', function(evt) {
                if (evt.key === 'Enter') {
                    const checked = getCheckedValues();
                    activeColMultiFilters[filterKey] = checked;
                    applyColFilter(tableId, colName, input.value, checked);
                    popover.remove();
                }
            });
        }

        popover.querySelectorAll('.col-filter-cb').forEach(function(cb) {
            cb.addEventListener('change', function() {
                const checked = getCheckedValues();
                activeColMultiFilters[filterKey] = checked;
                applyColFilter(tableId, colName, input ? input.value : '', checked);
            });
        });

        document.getElementById('col-filter-apply-btn')?.addEventListener('click', function() {
            const checked = getCheckedValues();
            activeColMultiFilters[filterKey] = checked;
            applyColFilter(tableId, colName, input ? input.value : '', checked);
            popover.remove();
        });

        document.getElementById('col-filter-reset-btn')?.addEventListener('click', function() {
            activeColMultiFilters[filterKey] = [];
            applyColFilter(tableId, colName, '', []);
            popover.remove();
        });

        function onDocClick(evt) {
            if (!popover.contains(evt.target) && evt.target !== btn && !btn.contains(evt.target)) {
                popover.remove();
                document.removeEventListener('click', onDocClick);
            }
        }
        setTimeout(function() {
            document.addEventListener('click', onDocClick);
        }, 10);
    };

    function applyColFilter(tableId, colName, filterVal, checkedList) {
        const table = document.getElementById(tableId);
        if (!table) return;
        const tbody = table.querySelector('tbody');
        if (!tbody) return;
        const rows = Array.from(tbody.querySelectorAll('tr:not(.table-empty-row)'));
        const f = (filterVal || '').trim().toLowerCase();
        const checkedSet = new Set(Array.isArray(checkedList) ? checkedList : (activeColMultiFilters[tableId + ':' + colName] || []));

        rows.forEach(function(row) {
            const cell = row.querySelector('[data-col="' + colName + '"]');
            const rawText = ((cell ? cell.textContent : row.textContent) || '').replace(/\s+/g, ' ').trim();
            const matchText = !f || rawText.toLowerCase().indexOf(f) !== -1;
            const matchChecked = checkedSet.size === 0 || checkedSet.has(rawText);
            row.style.display = (matchText && matchChecked) ? '' : 'none';
        });

        const colBtn = table.querySelector('th[data-col="' + colName + '"] .col-filter-btn');
        if (colBtn) {
            colBtn.classList.toggle('text-amber-500', Boolean(f || checkedSet.size > 0));
        }
    }

    window.filterTableRows = function(tableId, query, countBadgeId, emptyStateId) {
        const table = document.getElementById(tableId);
        if (!table) return;
        const tbody = table.querySelector('tbody');
        if (!tbody) return;
        const rows = Array.from(tbody.querySelectorAll('tr:not(.table-empty-row)'));
        const q = (query || '').trim().toLowerCase();
        let matchCount = 0;

        rows.forEach(function(row) {
            const extraSearch = (row.getAttribute('data-search-text') || '').toLowerCase();
            const text = ((row.textContent || '') + ' ' + extraSearch).toLowerCase();
            const isMatch = !q || text.indexOf(q) !== -1;
            row.style.display = isMatch ? '' : 'none';
            if (isMatch) matchCount++;
        });

        const badge = document.getElementById(countBadgeId);
        if (badge) {
            if (q) {
                badge.innerText = t('common.matching_records', { count: matchCount });
            } else {
                const totalLabel = badge.getAttribute('data-total-label');
                badge.innerText = totalLabel || t('common.total_records', { count: rows.length });
            }
        }

        const emptyEl = document.getElementById(emptyStateId);
        if (emptyEl) {
            emptyEl.classList.toggle('hidden', !(matchCount === 0 && rows.length > 0));
        }
    };

    window.filterCardItems = function(containerId, itemSelector, query, countBadgeId, emptyStateId) {
        const container = document.getElementById(containerId);
        if (!container) return;
        const items = Array.from(container.querySelectorAll(itemSelector));
        const q = (query || '').trim().toLowerCase();
        let matchCount = 0;

        items.forEach(function(item) {
            const text = (item.textContent || '').toLowerCase();
            const isMatch = !q || text.indexOf(q) !== -1;
            item.style.display = isMatch ? '' : 'none';
            if (isMatch) matchCount++;
        });

        const badge = document.getElementById(countBadgeId);
        if (badge) {
            badge.innerText = q ? t('common.matching_records', { count: matchCount }) : t('common.total_records', { count: items.length });
        }

        const emptyEl = document.getElementById(emptyStateId);
        if (emptyEl) {
            emptyEl.classList.toggle('hidden', !(matchCount === 0 && items.length > 0));
        }
    };

    const DEFAULT_COLS_REGISTRY = {
        articles: {
            folder: true,
            'trans-group': false,
            trans_group: false,
            slug: false,
            version: false,
            created: false,
            locale: true,
            tags: false,
            maturity: false,
            status: true,
            updated: true,
            actions: true
        },
        pages: { folder: false, template: true, page_type: false, batch_id: false, version: false, locale: true, status: true, updated: true, actions: true },
        users: { folder: true, email: true, 'global-role': true, 'site-role': true, created: true, actions: true },
        logs: { action: true, user: true, details: true, status: true, ip: true, created: true, actions: true },
        tasks: { type: true, folder: true, interval: true, next_run: true, last_run: true, status: true, actions: true },
        micro: { title: true, folder: true, status: false, maturity: true, locale: false, tags: true, created: false, updated: true, actions: true },
        datasets: { collection: true, schema: true, items_count: true, schema_slug: false, ref_pages: false, created: false, updated: true, actions: true }
    };

    window.toggleColumnPickerMenu = function(tableId, storageKey) {
        const key = storageKey || (tableId ? tableId.replace(/-table$/, '') : 'articles');
        const menu = document.getElementById('column-picker-menu-' + key)
            || document.getElementById(key + '-column-picker-dropdown')
            || document.getElementById('column-picker-dropdown');
        if (menu) menu.classList.toggle('hidden');
    };

    window.toggleTableColumn = function(tableIdOrColName, colNameOrVisible, visibleOrKey, storageKey) {
        let tableId = null;
        let colName;
        let visible = true;
        let key;

        if (typeof visibleOrKey === 'boolean') {
            tableId = tableIdOrColName;
            colName = colNameOrVisible;
            visible = visibleOrKey;
            key = storageKey || (tableId ? tableId.replace(/-table$/, '') : 'articles');
        } else {
            colName = tableIdOrColName;
            visible = !!colNameOrVisible;
            key = (typeof visibleOrKey === 'string' ? visibleOrKey : 'articles');
        }

        if (!colName) return;

        const selector = tableId ? ('#' + tableId + ' [data-col="' + colName + '"]') : ('[data-col="' + colName + '"]');
        let elements = document.querySelectorAll(selector);
        if (elements.length === 0) {
            elements = document.querySelectorAll('[data-col="' + colName + '"]');
        }
        elements.forEach(function(el) {
            el.classList.toggle('hidden', !visible);
        });

        const cbSelector = 'input[type="checkbox"].col-toggle-' + colName + ', ' +
            'input[type="checkbox"][data-col="' + colName + '"]';
        document.querySelectorAll(cbSelector).forEach(function(cb) {
            cb.checked = visible;
        });

        try {
            const storeKey = 'walnut_' + key + '_cols_v2';
            const current = JSON.parse(localStorage.getItem(storeKey) || '{}');
            current[colName] = visible;
            if (colName === 'trans-group') current['trans_group'] = visible;
            if (colName === 'trans_group') current['trans-group'] = visible;
            localStorage.setItem(storeKey, JSON.stringify(current));
        } catch {}
    };

    window.initTableColumns = function(tableId, storageKey, defaultCols) {
        const key = storageKey || (tableId ? tableId.replace(/-table$/, '') : 'articles');
        const defaults = defaultCols || DEFAULT_COLS_REGISTRY[key] || {};
        const storeKey = 'walnut_' + key + '_cols_v2';
        const cols = Object.assign({}, defaults);

        try {
            const saved = localStorage.getItem(storeKey);
            if (saved) Object.assign(cols, JSON.parse(saved));
        } catch {}

        Object.keys(cols).forEach(function(colName) {
            const isVisible = cols[colName];

            const cbSelector = '#column-picker-menu-' + key + ' .col-toggle-' + colName + ', ' +
                '#' + key + '-column-picker-dropdown [data-col="' + colName + '"], ' +
                '#' + key + '-column-picker-wrapper input[data-col="' + colName + '"], ' +
                '.col-toggle-checkbox[data-col="' + colName + '"], ' +
                '.' + key + '-col-toggle-checkbox[data-col="' + colName + '"], ' +
                'input[type="checkbox"].col-toggle-' + colName;
            document.querySelectorAll(cbSelector).forEach(function(cb) {
                cb.checked = isVisible;
            });

            const cellSelector = tableId ? ('#' + tableId + ' [data-col="' + colName + '"]') : ('[data-col="' + colName + '"]');
            document.querySelectorAll(cellSelector).forEach(function(el) {
                el.classList.toggle('hidden', !isVisible);
            });
        });
    };

    function initAllTableColumnsInternal() {
        Object.keys(DEFAULT_COLS_REGISTRY).forEach(function(key) {
            const tableId = key + '-table';
            if (document.getElementById(tableId)) {
                window.initTableColumns(tableId, key, DEFAULT_COLS_REGISTRY[key]);
            }
        });
    }

    window.updateArticleBatchState = function() {
        const checked = Array.from(document.querySelectorAll('.article-checkbox:checked, .row-select-box:checked'));
        const toolbar = document.getElementById('articles-batch-toolbar');
        const badge = document.getElementById('articles-selected-badge');
        if (checked.length > 0) {
            if (toolbar) toolbar.classList.remove('hidden');
            if (badge) badge.innerText = t('common.selected_count', { count: checked.length });
        } else {
            if (toolbar) toolbar.classList.add('hidden');
        }
    };

    window.toggleAllArticles = function(checked) {
        document.querySelectorAll('.article-checkbox, .row-select-box').forEach(function(cb) { cb.checked = checked; });
        window.updateArticleBatchState();
    };

    window.selectAllArticles = function() { window.toggleAllArticles(true); };
    window.deselectAllArticles = function() { window.toggleAllArticles(false); };

    window.batchTrashSelected = function() {
        const checked = Array.from(document.querySelectorAll('.article-checkbox:checked, .row-select-box:checked'));
        if (checked.length === 0) return;

        window.showConfirmDialog({
            title: t('common.btn_trash'),
            message: t('articles.confirm_batch_delete', { count: checked.length }),
            icon: 'delete',
            onConfirm: async function() {
                const nodeIds = checked.map(function(cb) {
                    return cb.getAttribute('data-id');
                }).filter(Boolean);
                for (let i = 0; i < nodeIds.length; i += 10) {
                    const fd = new FormData();
                    fd.append('node_ids', JSON.stringify(nodeIds.slice(i, i + 10)));
                    const res = await fetch('/admin/articles/api/batch-soft-delete', { method: 'POST', body: fd });
                    if (!res.ok) {
                        if (window.showToast) window.showToast(t('common.error'), 'error');
                        return;
                    }
                }
                window.location.reload();
            }
        });
    };

    window.promptCreateFolder = function(pageType, chipsContainerId, tableId) {
        const container = document.getElementById(chipsContainerId || (pageType + '-folder-chips'));
        const targetTable = tableId || (pageType === 'micro' ? 'micro-table' : (pageType + '-table'));

        const existingModal = document.getElementById('common-create-folder-modal');
        if (existingModal) existingModal.remove();

        const modal = document.createElement('div');
        modal.id = 'common-create-folder-modal';
        modal.className = 'fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4';
        modal.innerHTML = `
            <div class="bg-white dark:bg-stone-800 rounded-2xl max-w-sm w-full p-5 shadow-2xl border border-stone-200 dark:border-stone-700 space-y-4">
                <div class="flex justify-between items-center border-b border-stone-100 dark:border-stone-700 pb-2">
                    <h3 class="text-sm font-bold text-stone-900 dark:text-white flex items-center space-x-1.5">
                        <span class="material-symbols-outlined text-amber-600 text-[18px]">create_new_folder</span>
                        <span>${t('common.title_new_folder')}</span>
                    </h3>
                    <button type="button" onclick="document.getElementById('common-create-folder-modal').remove()" class="text-stone-400 hover:text-stone-700 dark:hover:text-white cursor-pointer">
                        <span class="material-symbols-outlined text-[18px]">close</span>
                    </button>
                </div>
                <div>
                    <label class="block text-xs font-bold text-stone-700 dark:text-stone-300 mb-1">${t('common.prompt_create_folder')} *</label>
                    <input type="text" id="new-folder-input-val" placeholder="guides, daily, dev" class="w-full bg-stone-50 dark:bg-stone-950 border border-stone-300 dark:border-stone-700 rounded-xl px-3 py-2 text-xs font-mono text-stone-800 dark:text-stone-100 outline-none focus:border-stone-900 dark:focus:border-amber-500" />
                </div>
                <div class="flex justify-end space-x-2 pt-2 border-t border-stone-100 dark:border-stone-700">
                    <button type="button" onclick="document.getElementById('common-create-folder-modal').remove()" class="px-3.5 py-1.5 rounded-xl text-xs font-bold text-stone-600 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-700 cursor-pointer">${t('common.cancel')}</button>
                    <button type="button" id="confirm-create-folder-btn" class="bg-[#B45309] hover:bg-[#92400E] text-white px-4 py-1.5 rounded-xl text-xs font-bold shadow-sm cursor-pointer">${t('common.confirm')}</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);

        const input = document.getElementById('new-folder-input-val');
        if (input) input.focus();

        document.getElementById('confirm-create-folder-btn').onclick = function() {
            const val = (input.value || '').trim();
            if (!val) {
                if (window.showToast) window.showToast(t('common.prompt_create_folder'), 'warning');
                return;
            }
            modal.remove();

            if (container) {
                const existingBtn = container.querySelector('[data-folder="' + val + '"]');
                if (!existingBtn) {
                    const btn = document.createElement('button');
                    btn.type = 'button';
                    btn.className = 'folder-chip px-3 py-1 rounded-xl text-xs font-semibold bg-white dark:bg-stone-800 text-stone-600 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-700 border border-stone-200 dark:border-stone-700 transition cursor-pointer flex items-center space-x-1';
                    btn.setAttribute('data-folder', val);
                    btn.onclick = function() {
                        window.filterByFolder(targetTable, val, container.id);
                    };
                    btn.innerHTML = '<span class="material-symbols-outlined text-[14px] text-amber-500">folder</span><span>' + val + '</span>';
                    container.appendChild(btn);
                }
                window.filterByFolder(targetTable, val, container.id);
            }

            if (window.showToast) window.showToast(t('common.success'), 'success');
        };
    };

    window.updateTableBatchState = function(tableId, toolbarId, badgeId, checkboxClass) {
        const tb = document.getElementById(tableId);
        if (!tb) return;
        const cls = checkboxClass || 'row-select-box';
        const checked = Array.from(tb.querySelectorAll('.' + cls + ':checked'));
        const toolbar = document.getElementById(toolbarId || (tableId.replace('-table', '') + '-batch-toolbar'));
        const badge = document.getElementById(badgeId || (tableId.replace('-table', '') + '-selected-badge'));
        if (checked.length > 0) {
            if (toolbar) toolbar.classList.remove('hidden');
            if (badge) badge.innerText = t('common.selected_count', { count: checked.length });
        } else {
            if (toolbar) toolbar.classList.add('hidden');
        }
    };

    window.toggleAllTableRows = function(tableId, checked, checkboxClass) {
        const tb = document.getElementById(tableId);
        if (!tb) return;
        const cls = checkboxClass || 'row-select-box';
        tb.querySelectorAll('.' + cls).forEach(function(cb) { cb.checked = checked; });
        window.updateTableBatchState(tableId);
    };

    window.selectAllTableRows = function(tableId) { window.toggleAllTableRows(tableId, true); };
    window.deselectAllTableRows = function(tableId) { window.toggleAllTableRows(tableId, false); };

    window.batchDeleteSelected = function(tableId, deleteUrl, entityName, checkboxClass) {
        const tb = document.getElementById(tableId);
        if (!tb) return;
        const cls = checkboxClass || 'row-select-box';
        const checked = Array.from(tb.querySelectorAll('.' + cls + ':checked'));
        if (checked.length === 0) return;

        const name = entityName || t('common.record_unit');
        window.showConfirmDialog({
            title: t('common.confirm_delete_title'),
            message: t('common.confirm_batch_delete_msg', { count: checked.length, name: name }),
            icon: 'delete',
            onConfirm: async function() {
                const ids = checked.map(function(cb) {
                    return cb.getAttribute('data-id');
                }).filter(Boolean);
                const targetUrl = deleteUrl || '/admin/articles/api/batch-soft-delete';
                let chunkSize = 10;
                let offset = 0;
                while (offset < ids.length) {
                    const chunk = ids.slice(offset, offset + chunkSize);
                    if (window.showToast && ids.length > chunkSize) {
                        window.showToast(t('common.loading') + ' ' + Math.min(offset + chunk.length, ids.length) + ' / ' + ids.length, 'info');
                    }
                    try {
                        const res = await fetch(targetUrl, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ ids: chunk, node_ids: chunk, user_ids: chunk })
                        });
                        const text = await res.clone().text();
                        if (isCpuLimitResponse(res.status, text) && chunkSize > 1) {
                            chunkSize = Math.max(1, Math.floor(chunkSize / 2));
                            await new Promise(function(r) { setTimeout(r, 500); });
                            continue;
                        }
                        offset += chunk.length;
                    } catch {
                        const fd = new FormData();
                        fd.append('node_ids', JSON.stringify(chunk));
                        fd.append('ids', JSON.stringify(chunk));
                        fd.append('user_ids', JSON.stringify(chunk));
                        await fetch(targetUrl, { method: 'POST', body: fd });
                        offset += chunk.length;
                    }
                }
                window.location.reload();
            }
        });
    };

    window.batchMoveToFolder = function(tableId, moveUrl, pageType, checkboxClass) {
        const tb = document.getElementById(tableId);
        if (!tb) return;
        const cls = checkboxClass || 'row-select-box';
        const checked = Array.from(tb.querySelectorAll('.' + cls + ':checked'));
        if (checked.length === 0) return;

        const chipsId = pageType ? (pageType + '-folder-chips') : (tableId.replace('-table', '') + '-folder-chips');
        const container = document.getElementById(chipsId);
        const existingFolders = [];
        if (container) {
            container.querySelectorAll('.folder-chip').forEach(function(el) {
                const f = el.getAttribute('data-folder');
                if (f && f !== 'all' && !existingFolders.includes(f)) existingFolders.push(f);
            });
        }

        const existingModal = document.getElementById('common-batch-folder-modal');
        if (existingModal) existingModal.remove();

        const modal = document.createElement('div');
        modal.id = 'common-batch-folder-modal';
        modal.className = 'fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4';
        modal.innerHTML = `
            <div class="bg-white dark:bg-stone-800 rounded-2xl max-w-sm w-full p-5 shadow-2xl border border-stone-200 dark:border-stone-700 space-y-4">
                <div class="flex justify-between items-center border-b border-stone-100 dark:border-stone-700 pb-2">
                    <h3 class="text-sm font-bold text-stone-900 dark:text-white flex items-center space-x-1.5">
                        <span class="material-symbols-outlined text-amber-500 text-[18px]">folder</span>
                        <span>${t('common.batch_move_folder')} (<span class="text-amber-500">${checked.length}</span>)</span>
                    </h3>
                    <button type="button" onclick="document.getElementById('common-batch-folder-modal').remove()" class="text-stone-400 hover:text-stone-700 dark:hover:text-white cursor-pointer">
                        <span class="material-symbols-outlined text-[18px]">close</span>
                    </button>
                </div>
                <div class="space-y-3">
                    <div>
                        <label class="block text-xs font-bold text-stone-700 dark:text-stone-300 mb-1">${t('common.folder_select_existing')}</label>
                        <div class="flex flex-wrap gap-1.5 max-h-32 overflow-y-auto">
                            ${existingFolders.map(function(f) {
                                return '<button type="button" class="folder-select-opt px-2.5 py-1 rounded-lg text-xs font-semibold bg-stone-100 dark:bg-stone-700 text-stone-700 dark:text-stone-200 hover:bg-[#92400E] hover:text-white transition cursor-pointer" data-val="' + f + '">' + f + '</button>';
                            }).join('')}
                        </div>
                    </div>
                    <div>
                        <label class="block text-xs font-bold text-stone-700 dark:text-stone-300 mb-1">${t('common.folder_or_input_new')}</label>
                        <input type="text" id="batch-folder-target-input" placeholder="${t('common.folder_input_placeholder')}" class="w-full bg-stone-50 dark:bg-stone-950 border border-stone-300 dark:border-stone-700 rounded-xl px-3 py-2 text-xs font-mono text-stone-800 dark:text-stone-100 outline-none focus:border-stone-900 dark:focus:border-amber-500" />
                    </div>
                </div>
                <div class="flex justify-end space-x-2 pt-2 border-t border-stone-100 dark:border-stone-700">
                    <button type="button" onclick="document.getElementById('common-batch-folder-modal').remove()" class="px-3.5 py-1.5 rounded-xl text-xs font-bold text-stone-600 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-700 cursor-pointer">${t('common.cancel')}</button>
                    <button type="button" id="confirm-batch-folder-btn" class="bg-[#B45309] hover:bg-[#92400E] text-white px-4 py-1.5 rounded-xl text-xs font-bold shadow-sm cursor-pointer">${t('common.btn_confirm_move')}</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);

        modal.querySelectorAll('.folder-select-opt').forEach(function(btn) {
            btn.onclick = function() {
                const inp = document.getElementById('batch-folder-target-input');
                if (inp) inp.value = btn.getAttribute('data-val');
            };
        });

        document.getElementById('confirm-batch-folder-btn').onclick = async function() {
            const inp = document.getElementById('batch-folder-target-input');
            const targetFolder = (inp ? inp.value : '').trim() || '/';
            const ids = checked.map(function(cb) {
                return cb.getAttribute('data-id');
            }).filter(Boolean);

            const CHUNK_SIZE = 10;
            let allOk = true;
            for (let offset = 0; offset < ids.length; offset += CHUNK_SIZE) {
                const chunk = ids.slice(offset, offset + CHUNK_SIZE);
                if (window.showToast && ids.length > CHUNK_SIZE) {
                    window.showToast(t('common.loading') + ' ' + Math.min(offset + chunk.length, ids.length) + ' / ' + ids.length, 'info');
                }
                const fd = new FormData();
                fd.append('node_ids', JSON.stringify(chunk));
                fd.append('user_ids', JSON.stringify(chunk));
                fd.append('folder', targetFolder);

                const res = await fetch(moveUrl || '/admin/articles/api/batch-folder', { method: 'POST', body: fd });
                if (!res.ok) {
                    allOk = false;
                    break;
                }
            }
            if (allOk) {
                modal.remove();
                if (window.showToast) window.showToast(t('common.batch_folder_moved', { count: ids.length, folder: targetFolder }), 'success');
                setTimeout(function() { window.location.reload(); }, 300);
            } else {
                if (window.showToast) window.showToast(t('common.batch_folder_failed'), 'error');
            }
        };
    };

    const tableSortStates = {};

    window.sortTableByColumn = function(tableId, colIndex, dataType) {
        dataType = dataType || 'string';
        const table = document.getElementById(tableId);
        if (!table) return;
        const tbody = table.querySelector('tbody');
        if (!tbody) return;

        const key = tableId + '_' + colIndex;
        const currentSort = tableSortStates[key] || 'none';
        const nextSort = currentSort === 'none' ? 'asc' : (currentSort === 'asc' ? 'desc' : 'none');

        Object.keys(tableSortStates).forEach(function(k) {
            if (k.startsWith(tableId + '_')) {
                tableSortStates[k] = 'none';
            }
        });
        tableSortStates[key] = nextSort;

        table.querySelectorAll('thead th').forEach(function(th, idx) {
            const icon = th.querySelector('.sort-icon');
            if (!icon) return;
            if (idx === colIndex && nextSort !== 'none') {
                icon.textContent = nextSort === 'asc' ? 'arrow_upward' : 'arrow_downward';
                icon.className = 'sort-icon material-symbols-outlined text-[15px] text-amber-600 font-bold';
            } else {
                icon.textContent = 'unfold_more';
                icon.className = 'sort-icon material-symbols-outlined text-[15px] text-stone-400';
            }
        });

        const rows = Array.from(tbody.querySelectorAll('tr'));
        if (rows.length <= 1) return;
        if (!tbody._originalRows) tbody._originalRows = rows.slice();

        if (nextSort === 'none') {
            tbody._originalRows.forEach(function(r) { tbody.appendChild(r); });
            return;
        }

        rows.sort(function(a, b) {
            const cellA = a.children[colIndex];
            const cellB = b.children[colIndex];
            if (!cellA || !cellB) return 0;

            const valA = cellA.getAttribute('data-sort-val') !== null ? cellA.getAttribute('data-sort-val') : cellA.innerText.trim();
            const valB = cellB.getAttribute('data-sort-val') !== null ? cellB.getAttribute('data-sort-val') : cellB.innerText.trim();

            let cmp;
            if (dataType === 'number') {
                cmp = parseFloat(valA || '0') - parseFloat(valB || '0');
            } else if (dataType === 'date') {
                cmp = new Date(valA || 0).getTime() - new Date(valB || 0).getTime();
            } else {
                cmp = String(valA).localeCompare(String(valB), 'zh-CN');
            }

            return nextSort === 'asc' ? cmp : -cmp;
        });

        rows.forEach(function(r) { tbody.appendChild(r); });
    };

    let isResizingCol = false;
    let lastResizeEndAt = 0;

    function initResizableTableColumns() {
        document.querySelectorAll('table[id]').forEach(function(table) {
            const tableId = table.id;
            const ths = Array.from(table.querySelectorAll('thead th'));
            if (ths.length === 0) return;

            if (!table.dataset.sortGuardBound) {
                table.dataset.sortGuardBound = '1';
                // Only sort on explicit .sort-icon clicks and ignore clicks within 300ms of resize end to prevent accidental sorts.
                table.addEventListener('click', function(e) {
                    if (isResizingCol || (Date.now() - lastResizeEndAt < 300)) {
                        e.stopPropagation();
                        e.preventDefault();
                        return;
                    }
                    const th = e.target.closest('th');
                    if (th && th.querySelector('.sort-icon') && !e.target.closest('.sort-icon') && !e.target.closest('.col-filter-btn') && !e.target.closest('input')) {
                        e.stopPropagation();
                    }
                }, true);
            }

            // Preserve table-auto and size individual columns rather than switching to table-layout: fixed.
            table.style.tableLayout = 'auto';

            let savedWidths = {};
            try {
                savedWidths = JSON.parse(localStorage.getItem('walnut_col_widths_' + tableId) || '{}');
            } catch {}

            ths.forEach(function(th, idx) {
                const labelW = th.firstElementChild ? th.firstElementChild.scrollWidth : 48;
                const minColW = Math.max(88, Math.ceil(labelW + 36));
                th.dataset.minWidth = String(minColW);

                const colKey = th.getAttribute('data-col') || String(idx);
                if (savedWidths[colKey]) {
                    const applied = Math.max(minColW, Number(savedWidths[colKey]) || minColW);
                    th.style.width = applied + 'px';
                    th.style.minWidth = applied + 'px';
                }
            });

            ths.forEach(function(th, idx) {
                if (idx === 0 && th.classList.contains('w-12')) return;
                if (th.querySelector('.th-resize-handle')) return;
                const handle = document.createElement('span');
                handle.className = 'th-resize-handle';
                handle.addEventListener('click', function(e) { e.stopPropagation(); });
                handle.addEventListener('mousedown', function(e) {
                    e.preventDefault();
                    e.stopPropagation();
                    const startX = e.clientX;
                    const startWidth = th.getBoundingClientRect().width;
                    const minColW = Number(th.dataset.minWidth || 88);
                    isResizingCol = true;
                    handle.classList.add('is-resizing');

                    function onMouseMove(ev) {
                        const nextW = Math.max(minColW, Math.round(startWidth + (ev.clientX - startX)));
                        th.style.width = nextW + 'px';
                        th.style.minWidth = nextW + 'px';
                    }
                    function onMouseUp() {
                        isResizingCol = false;
                        lastResizeEndAt = Date.now();
                        handle.classList.remove('is-resizing');
                        document.removeEventListener('mousemove', onMouseMove);
                        document.removeEventListener('mouseup', onMouseUp);
                        const colKey = th.getAttribute('data-col') || String(idx);
                        savedWidths[colKey] = Math.round(th.getBoundingClientRect().width);
                        try {
                            localStorage.setItem('walnut_col_widths_' + tableId, JSON.stringify(savedWidths));
                        } catch {}
                    }
                    document.addEventListener('mousemove', onMouseMove);
                    document.addEventListener('mouseup', onMouseUp);
                });
                th.appendChild(handle);
            });
        });
    }

    document.addEventListener('click', function(e) {
        ['articles', 'pages', 'users', 'logs', 'tasks', 'micro'].forEach(function(key) {
            const wrapper = document.getElementById('column-picker-wrapper-' + key)
                || document.getElementById(key + '-column-picker-wrapper')
                || document.getElementById('column-picker-wrapper');
            const menu = document.getElementById('column-picker-menu-' + key)
                || document.getElementById(key + '-column-picker-dropdown')
                || document.getElementById('column-picker-dropdown');
            if (wrapper && menu && !wrapper.contains(e.target)) {
                menu.classList.add('hidden');
            }
        });
    });

    window.handleBatchExportArticlesJson = function() {
        const selected = Array.from(document.querySelectorAll('.row-select-box:checked, .article-select-box:checked'));
        if (selected.length === 0) {
            if (window.showToast) window.showToast(t('common.no_nodes_selected'), 'warning');
            return;
        }
        const ids = selected.map(function(el) {
            return el.getAttribute('data-id');
        }).filter(Boolean);
        window.location.href = '/admin/articles/api/export-selected?ids=' + ids.join(',');
    };

    window.handleArticleFileImport = function(fileInput) {
        const file = fileInput.files && fileInput.files[0];
        if (!file) return;

        const reader = new FileReader();
        const fileName = file.name || 'article.md';
        const isMarkdown = fileName.endsWith('.md') || fileName.endsWith('.markdown');

        reader.onload = async function(e) {
            const content = e.target.result;
            let items = [];

            if (isMarkdown) {
                const lines = content.split('\n');
                let title = fileName.replace(/\.[^/.]+$/, '');
                if (lines[0] && lines[0].startsWith('# ')) {
                    title = lines[0].replace(/^#\s+/, '').trim();
                }
                items.push({
                    title: title,
                    slug: title.toLowerCase().replace(/[^\w\u4e00-\u9fa5]+/g, '-'),
                    content: content,
                    type: 'article'
                });
            } else {
                try {
                    const parsed = JSON.parse(content);
                    items = Array.isArray(parsed) ? parsed : [parsed];
                } catch {
                    if (window.showToast) window.showToast(t('common.error'), 'error');
                    return;
                }
            }

            try {
                let chunkSize = 10;
                const total = items.length;
                let done = 0;
                let lastError = null;
                while (done < total) {
                    const chunk = items.slice(done, done + chunkSize);
                    if (window.showToast) window.showToast(t('common.loading') + ' ' + done + ' / ' + total, 'info');
                    const res = await fetch('/admin/articles/api/batch-import', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ items: chunk })
                    });
                    const rawText = await res.clone().text();
                    if (isCpuLimitResponse(res.status, rawText) && chunkSize > 1) {
                        chunkSize = Math.max(1, Math.floor(chunkSize / 2));
                        await new Promise(function(r) { setTimeout(r, 500); });
                        continue;
                    }
                    const data = JSON.parse(rawText || '{}');
                    if (!data.success) {
                        lastError = data.error || t('common.error');
                        break;
                    }
                    done += chunk.length;
                    if (window.showToast) window.showToast(t('common.loading') + ' ' + done + ' / ' + total, 'info');
                }
                if (!lastError) {
                    if (window.showToast) window.showToast(t('common.success') + ' (' + done + ' / ' + total + ')', 'success');
                    setTimeout(function() { window.location.reload(); }, 600);
                } else {
                    if (window.showToast) window.showToast(lastError, 'error');
                }
            } catch {
                if (window.showToast) window.showToast(t('common.network_error'), 'error');
            }
        };
        reader.readAsText(file);
    };

    function bootTables() {
        initAllTableColumnsInternal();
        initResizableTableColumns();
        try {
            const folderParam = new URLSearchParams(window.location.search).get('folder');
            if (folderParam && document.getElementById('micro-folder-chips') && window.filterByFolder) {
                window.filterByFolder('micro-table', folderParam, 'micro-folder-chips');
            }
        } catch {}
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bootTables);
    } else {
        bootTables();
    }
    document.addEventListener('htmx:afterSwap', initResizableTableColumns);
    document.addEventListener('htmx:load', initAllTableColumnsInternal);
})();
