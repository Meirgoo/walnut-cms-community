(function() {
    'use strict';

    const t = (key, params) => {
        const fn = window.__WALNUT_I18N__ && window.__WALNUT_I18N__.t;
        return typeof fn === 'function' ? fn(key, params) : key;
    };

    let schemaFields = [];
    let rows = [];
    const deletedIds = [];
    let schemaSlug = '';
    let dragSrcIndex = null;

    function init() {
        const schemaEl = document.getElementById('collection-schema-data');
        const rowsEl = document.getElementById('collection-rows-data');
        const slugEl = document.getElementById('collection-schema-slug');
        if (!schemaEl || !rowsEl || !slugEl) return;

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
                rows.push({ id: '', title: '', summary: '', fields: emptyFields });
                renderBody();
            });
        }

        const saveBtn = document.getElementById('btn-save-collection');
        if (saveBtn) {
            saveBtn.addEventListener('click', saveCollection);
        }
    }

    function renderHeader() {
        const headTr = document.getElementById('collection-table-head');
        if (!headTr) return;
        let html = '<th class="w-10 px-3 py-3 text-center">#</th>';
        html += `<th class="px-4 py-3 min-w-[160px]">${t('datasets.col_title') || 'Title'}</th>`;
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
            const colSpan = 3 + schemaFields.filter(f => f.key !== 'title').length;
            emptyTr.innerHTML = `<td colspan="${colSpan}" class="px-6 py-10 text-center text-slate-400 text-xs">${t('datasets.empty') || 'No items'}</td>`;
            tbody.appendChild(emptyTr);
            return;
        }

        rows.forEach((row, idx) => {
            const tr = document.createElement('tr');
            tr.className = 'h-11 hover:bg-slate-50/70 dark:hover:bg-slate-700/30 transition-colors duration-75 ease-out';
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
            tdDrag.className = 'px-3 py-2 text-center cursor-grab text-slate-400 hover:text-slate-600 dark:hover:text-slate-200';
            tdDrag.innerHTML = '<span class="material-symbols-outlined text-[16px]">drag_indicator</span>';
            tr.appendChild(tdDrag);

            const tdTitle = document.createElement('td');
            tdTitle.className = 'px-3 py-1.5';
            const titleInput = document.createElement('input');
            titleInput.type = 'text';
            titleInput.value = row.title || '';
            titleInput.className = 'w-full bg-transparent border border-transparent hover:border-slate-200 dark:hover:border-slate-700 focus:border-emerald-500 focus:bg-white dark:focus:bg-slate-900 rounded-lg px-2.5 py-1 text-xs font-bold text-slate-900 dark:text-white outline-none transition-colors duration-75';
            titleInput.addEventListener('input', (e) => { rows[idx].title = e.target.value; });
            tdTitle.appendChild(titleInput);
            tr.appendChild(tdTitle);

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
                    cb.className = 'w-4 h-4 rounded border-slate-300 dark:border-slate-600 text-emerald-600 cursor-pointer accent-emerald-600';
                    cb.addEventListener('change', (e) => {
                        if (!rows[idx].fields) rows[idx].fields = {};
                        rows[idx].fields[f.key] = e.target.checked;
                    });
                    td.appendChild(cb);
                } else {
                    const inp = document.createElement('input');
                    inp.type = f.type === 'number' ? 'number' : 'text';
                    inp.value = val !== undefined && val !== null ? String(val) : '';
                    inp.className = 'w-full bg-transparent border border-transparent hover:border-slate-200 dark:hover:border-slate-700 focus:border-emerald-500 focus:bg-white dark:focus:bg-slate-900 rounded-lg px-2.5 py-1 text-xs font-mono text-slate-700 dark:text-slate-200 outline-none transition-colors duration-75';
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
            delBtn.className = 'p-1 rounded-lg text-slate-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950/50 transition-colors duration-75 cursor-pointer';
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
