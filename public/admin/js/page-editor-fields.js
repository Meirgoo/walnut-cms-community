(function() {
    'use strict';

    const t = (k, params) => {
        if (!k) return '';
        const fn = window.__EDGE_I18N__ && window.__EDGE_I18N__.t;
        if (typeof fn === 'function') {
            const res = fn(k, params);
            if (res) return res;
        }
        return k;
    };

    const getDatasetsData = () => {
        const host = window.__EDGE_RUNTIME__ && window.__EDGE_RUNTIME__.pageEditorHost;
        return (host && typeof host.getPageDatasetsData === 'function')
            ? host.getPageDatasetsData()
            : { collections: [], schemas: [] };
    };

    function ensureBlockDefaultProps(block, schema) {
        if (!block.props || typeof block.props !== 'object') {
            block.props = block.data && typeof block.data === 'object' ? { ...block.data } : {};
        }
        const fields = schema.fields || [];
        fields.forEach(function(f) {
            const key = f.key || f.name || f.id;
            if (!key) return;
            if (block.props[key] === undefined && f.default !== undefined) {
                block.props[key] = f.default;
            }
        });
        return block.props;
    }

    function getApiProtocolSuggestions() {
        const datasets = getDatasetsData();
        const suggestions = [];
        const seen = new Set();
        (datasets.collections || []).forEach(function(col) {
            if (!col || !col.slug) return;
            const val = '@api:dataset:collection=' + col.slug;
            if (seen.has(val)) return;
            seen.add(val);
            suggestions.push({
                value: val,
                label: (col.name || col.slug) + (col.schema_key ? ' [' + col.schema_key + ']' : '')
            });
        });
        [
            { value: '@api:feed:types=article,micro&limit=10', label: t('pages.api_preset_feed') },
            { value: '@api:dataset:schema=projects&limit=6', label: t('pages.api_preset_showcase') },
            { value: '@api:dataset:id=', label: t('pages.api_preset_by_id') },
            { value: '@api:micro:limit=10', label: t('pages.api_preset_latest_micros') },
            { value: '@api:micro:maturity=evergreen&limit=6', label: t('pages.api_preset_evergreen_micros') },
            { value: '@api:article:limit=6', label: t('pages.api_preset_latest_articles') }
        ].forEach(function(item) {
            if (!seen.has(item.value)) {
                seen.add(item.value);
                suggestions.push(item);
            }
        });
        return suggestions;
    }

    const fieldMapExpandedIds = new Set();

    function parseDatasetApiRef(apiStr) {
        if (typeof apiStr !== 'string') return null;
        const trimmed = apiStr.trim();
        if (!trimmed.startsWith('@api:dataset:')) return null;
        const queryPart = trimmed.slice('@api:dataset:'.length);
        const params = new URLSearchParams(queryPart);
        const colSlug = (params.get('collection') || '').trim();
        const schemaSlug = (params.get('schema') || '').trim();

        const datasets = getDatasetsData();
        const collections = datasets.collections || [];
        const schemas = datasets.schemas || [];

        let fields = [];
        let sourceLabel = '';
        if (colSlug) {
            const col = collections.find(function(c) { return c.slug === colSlug; });
            if (col) {
                sourceLabel = col.name || col.slug;
                if (Array.isArray(col.fields) && col.fields.length > 0) {
                    fields = col.fields;
                } else if (col.schema_key) {
                    const matchedSchema = schemas.find(function(s) { return s.slug === col.schema_key; });
                    if (matchedSchema && Array.isArray(matchedSchema.fields)) fields = matchedSchema.fields;
                }
            }
        } else if (schemaSlug) {
            const matchedSchema = schemas.find(function(s) { return s.slug === schemaSlug; });
            if (matchedSchema) {
                sourceLabel = matchedSchema.title || matchedSchema.slug;
                if (Array.isArray(matchedSchema.fields)) fields = matchedSchema.fields;
            }
        }

        return fields.length > 0 ? { fields: fields, sourceLabel: sourceLabel } : null;
    }

    function renderFieldMappingPanel(mountEl, block, schema, apiValue, onUpdate) {
        if (!mountEl) return;
        mountEl.innerHTML = '';
        const dataSlots = Array.isArray(schema && schema.data_slots) ? schema.data_slots : [];
        if (dataSlots.length === 0) return;
        const refInfo = parseDatasetApiRef(apiValue);
        if (!refInfo) return;

        if (!block.field_map && block.props && block.props.field_map && typeof block.props.field_map === 'object' && !Array.isArray(block.props.field_map)) {
            block.field_map = { ...block.props.field_map };
        }
        const existingMap = (block.field_map && typeof block.field_map === 'object' && !Array.isArray(block.field_map))
            ? block.field_map
            : {};
        const mappedCount = Object.keys(existingMap).filter(function(k) { return !!existingMap[k]; }).length;
        const blockKey = block.id || schema.slug || 'block';
        const isOpen = fieldMapExpandedIds.has(blockKey) || mappedCount > 0;
        if (isOpen) fieldMapExpandedIds.add(blockKey);

        const card = document.createElement('div');
        card.className = 'mt-2 rounded-xl border border-stone-200 dark:border-stone-800 bg-stone-50/70 dark:bg-stone-900/50 overflow-hidden';

        const headerBtn = document.createElement('button');
        headerBtn.type = 'button';
        headerBtn.className = 'w-full px-3 py-2 flex items-center justify-between gap-2 text-left hover:bg-stone-100/80 dark:hover:bg-stone-800/60 transition cursor-pointer';

        const leftWrap = document.createElement('div');
        leftWrap.className = 'flex items-center gap-2 min-w-0';
        const iconSpan = document.createElement('span');
        iconSpan.className = 'material-symbols-outlined text-[15px] text-amber-600 dark:text-amber-400 shrink-0';
        iconSpan.textContent = 'tune';
        const titleSpan = document.createElement('span');
        titleSpan.className = 'text-xs font-bold text-stone-800 dark:text-stone-100 truncate';
        titleSpan.textContent = t('pages.field_map_title');
        const countBadge = document.createElement('span');
        countBadge.className = 'px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-950/60 text-amber-700 dark:text-amber-300 text-[10px] font-mono font-bold shrink-0 ' + (mappedCount > 0 ? '' : 'hidden');
        countBadge.textContent = t('pages.field_map_active_count').replace('{count}', String(mappedCount));
        leftWrap.appendChild(iconSpan);
        leftWrap.appendChild(titleSpan);
        leftWrap.appendChild(countBadge);
        if (refInfo.sourceLabel) {
            const srcBadge = document.createElement('span');
            srcBadge.className = 'text-[10px] font-mono text-stone-400 truncate';
            srcBadge.textContent = refInfo.sourceLabel;
            leftWrap.appendChild(srcBadge);
        }

        const chev = document.createElement('span');
        chev.className = 'material-symbols-outlined text-[16px] text-stone-400 transition-transform ' + (isOpen ? 'rotate-180' : '');
        chev.textContent = 'expand_more';

        headerBtn.appendChild(leftWrap);
        headerBtn.appendChild(chev);

        const body = document.createElement('div');
        body.className = 'px-3 pb-3 pt-1.5 border-t border-stone-200/70 dark:border-stone-800 grid grid-cols-1 sm:grid-cols-2 gap-2.5 ' + (isOpen ? '' : 'hidden');

        headerBtn.addEventListener('click', function() {
            const nowOpen = body.classList.contains('hidden');
            if (nowOpen) {
                body.classList.remove('hidden');
                chev.classList.add('rotate-180');
                fieldMapExpandedIds.add(blockKey);
            } else {
                body.classList.add('hidden');
                chev.classList.remove('rotate-180');
                fieldMapExpandedIds.delete(blockKey);
            }
        });

        const hint = document.createElement('p');
        hint.className = 'col-span-full text-[11px] text-stone-500 dark:text-stone-400 leading-relaxed';
        hint.textContent = t('pages.field_map_hint');
        body.appendChild(hint);

        dataSlots.forEach(function(slot) {
            const slotWrap = document.createElement('div');
            slotWrap.className = 'space-y-1';

            const lbl = document.createElement('div');
            lbl.className = 'text-[11px] font-medium text-stone-600 dark:text-stone-300 flex items-center gap-1 truncate';
            const keySpan = document.createElement('span');
            keySpan.className = 'font-mono font-bold text-stone-800 dark:text-stone-100';
            keySpan.textContent = slot.key;
            lbl.appendChild(keySpan);
            if (slot.label) {
                const subLbl = document.createElement('span');
                subLbl.className = 'text-stone-400 truncate';
                subLbl.textContent = '· ' + slot.label;
                lbl.appendChild(subLbl);
            }
            if (slot.required) {
                const reqSpan = document.createElement('span');
                reqSpan.className = 'text-amber-600 font-bold';
                reqSpan.textContent = '*';
                lbl.appendChild(reqSpan);
            }

            const select = document.createElement('edge-select');
            select.className = 'w-full h-8 bg-[var(--admin-canvas)] border border-[var(--admin-border)] rounded-lg px-2 text-xs text-[var(--admin-text)] block';

            const curMapped = typeof existingMap[slot.key] === 'string' ? existingMap[slot.key] : '';
            const optAuto = document.createElement('option');
            optAuto.setAttribute('value', '');
            optAuto.textContent = t('pages.field_map_auto');
            if (!curMapped) optAuto.setAttribute('selected', 'selected');
            select.appendChild(optAuto);

            refInfo.fields.forEach(function(f) {
                if (!f || !f.key) return;
                const opt = document.createElement('option');
                opt.setAttribute('value', f.key);
                opt.textContent = (f.label && f.label !== f.key) ? (f.label + ' (' + f.key + ')') : f.key;
                if (curMapped === f.key) opt.setAttribute('selected', 'selected');
                select.appendChild(opt);
            });

            select.addEventListener('change', function() {
                const nextMap = (block.field_map && typeof block.field_map === 'object' && !Array.isArray(block.field_map))
                    ? { ...block.field_map }
                    : {};
                const nextVal = String(select.value || '').trim();
                if (nextVal) {
                    nextMap[slot.key] = nextVal;
                } else {
                    delete nextMap[slot.key];
                }
                if (Object.keys(nextMap).length > 0) {
                    block.field_map = nextMap;
                } else {
                    delete block.field_map;
                }
                if (block.props && block.props.field_map !== undefined) {
                    delete block.props.field_map;
                }
                const nextCount = Object.keys(nextMap).length;
                if (nextCount > 0) {
                    countBadge.textContent = t('pages.field_map_active_count').replace('{count}', String(nextCount));
                    countBadge.classList.remove('hidden');
                } else {
                    countBadge.classList.add('hidden');
                }
                onUpdate();
            });

            slotWrap.appendChild(lbl);
            slotWrap.appendChild(select);
            body.appendChild(slotWrap);
        });

        card.appendChild(headerBtn);
        card.appendChild(body);
        mountEl.appendChild(card);
    }

    function attachApiProtocolSuggest(inputEl, onSelectVal) {
        const wrapper = document.createElement('div');
        wrapper.className = 'relative w-full';
        const menu = document.createElement('div');
        menu.className = 'hidden absolute left-0 right-0 top-full mt-1 z-30 bg-white dark:bg-stone-900 border border-amber-300 dark:border-amber-700 rounded-xl shadow-lg py-1 max-h-48 overflow-y-auto';

        function renderSuggestions(val) {
            const trimmed = (val || '').trim();
            if (!trimmed.startsWith('@api:')) {
                menu.classList.add('hidden');
                return;
            }
            menu.innerHTML = '';
            getApiProtocolSuggestions().forEach(function(sug) {
                const row = document.createElement('div');
                row.className = 'px-3 py-1.5 hover:bg-amber-50 dark:hover:bg-amber-950/60 cursor-pointer flex items-center justify-between text-xs';
                row.innerHTML = `<span class="font-mono font-bold text-amber-700 dark:text-amber-300">${sug.value}</span><span class="text-[10px] text-stone-400 ml-2">${sug.label}</span>`;
                row.onmousedown = function(ev) {
                    ev.preventDefault();
                    inputEl.value = sug.value;
                    menu.classList.add('hidden');
                    onSelectVal(sug.value);
                };
                menu.appendChild(row);
            });
            menu.classList.remove('hidden');
        }

        inputEl.addEventListener('input', function() { renderSuggestions(inputEl.value); });
        inputEl.addEventListener('focus', function() { renderSuggestions(inputEl.value); });
        inputEl.addEventListener('blur', function() { setTimeout(function() { menu.classList.add('hidden'); }, 150); });
        wrapper.appendChild(inputEl);
        wrapper.appendChild(menu);
        return wrapper;
    }

    function createBlockFieldsBody(block, schema, onUpdate, _compName) {
        const body = document.createElement('div');
        body.className = 'grid grid-cols-1 md:grid-cols-2 gap-3.5 pt-1';
        const blockProps = ensureBlockDefaultProps(block, schema);

        const fields = schema.fields || [];
        if (fields.length === 0) {
            const tip = document.createElement('div');
            tip.className = 'col-span-full text-[11px] text-stone-400 italic py-1';
            tip.textContent = t('pages.comp_no_props_tip');
            body.appendChild(tip);
            return body;
        }

        fields.forEach(function(field) {
            const fieldKey = field.key || field.name || field.id;
            if (!fieldKey) return;
            const fieldLabel = field.label || field.title || field.name || fieldKey;
            const fieldVal = blockProps[fieldKey] !== undefined ? blockProps[fieldKey] : (field.default !== undefined ? field.default : '');
            const widget = field.widget || field.type || 'text';

            const fieldBox = document.createElement('div');
            fieldBox.className = ((widget === 'textarea' || widget === 'markdown') ? 'col-span-full ' : '') + 'space-y-1.5';

            const labelBox = document.createElement('div');
            labelBox.className = 'flex items-center justify-between';
            const label = document.createElement('label');
            label.className = 'block text-xs font-bold text-stone-700 dark:text-stone-300';
            label.textContent = fieldLabel;
            labelBox.appendChild(label);
            if (widget === 'markdown') {
                const mdBadge = document.createElement('span');
                mdBadge.className = 'px-1.5 py-0.5 rounded bg-[var(--admin-accent-soft)] border border-[var(--admin-accent-border)] text-[10px] font-mono font-bold text-[var(--admin-accent-text)]';
                mdBadge.textContent = 'Markdown';
                labelBox.appendChild(mdBadge);
            }

            fieldBox.appendChild(labelBox);

            if (widget === 'markdown') {
                const mdArea = document.createElement('textarea');
                mdArea.rows = 8;
                mdArea.className = 'w-full bg-[var(--admin-canvas)] border border-[var(--admin-border)] rounded-lg p-3 text-xs font-mono text-[var(--admin-text)] outline-none focus:border-[var(--admin-accent)] resize-y leading-relaxed';
                mdArea.placeholder = field.placeholder || '# Markdown...';
                mdArea.value = typeof fieldVal === 'object' ? JSON.stringify(fieldVal) : String(fieldVal ?? '');
                mdArea.oninput = function(e) {
                    blockProps[fieldKey] = e.target.value;
                    block.props = blockProps;
                    onUpdate();
                };
                fieldBox.appendChild(mdArea);
            } else if (widget === 'textarea') {
                const textarea = document.createElement('textarea');
                textarea.rows = 2;
                textarea.className = 'w-full bg-[var(--admin-canvas)] border border-[var(--admin-border)] rounded-lg p-2.5 text-xs text-[var(--admin-text)] outline-none focus:border-[var(--admin-accent)] resize-y leading-relaxed';
                textarea.placeholder = field.placeholder || 'Enter text or @api:dataset:... / @api:micro:...';
                textarea.value = typeof fieldVal === 'object' ? JSON.stringify(fieldVal) : String(fieldVal ?? '');
                textarea.oninput = function(e) {
                    blockProps[fieldKey] = e.target.value;
                    block.props = blockProps;
                    onUpdate();
                };
                fieldBox.appendChild(attachApiProtocolSuggest(textarea, function(v) {
                    blockProps[fieldKey] = v;
                    block.props = blockProps;
                    onUpdate();
                }));
            } else if (widget === 'switch' || widget === 'boolean') {
                const switchWrapper = document.createElement('div');
                switchWrapper.className = 'flex items-center space-x-2.5 h-8 px-3 bg-[var(--admin-canvas)] border border-[var(--admin-border)] rounded-lg';
                const isChecked = fieldVal === true || fieldVal === 'true' || fieldVal === 1;

                const switchBtn = document.createElement('button');
                switchBtn.type = 'button';
                switchBtn.className = 'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ' + (isChecked ? 'bg-[#B45309]' : 'bg-stone-300 dark:bg-stone-700');
                const switchDot = document.createElement('span');
                switchDot.className = 'pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ' + (isChecked ? 'translate-x-4' : 'translate-x-0');
                switchBtn.appendChild(switchDot);

                const switchStatus = document.createElement('span');
                switchStatus.className = 'text-xs text-stone-700 dark:text-stone-300 font-semibold';
                switchStatus.textContent = isChecked ? t('pages.switch_enabled') : t('pages.switch_disabled');

                switchBtn.onclick = function() {
                    const current = blockProps[fieldKey] === true || blockProps[fieldKey] === 'true' || blockProps[fieldKey] === 1;
                    const next = !current;
                    blockProps[fieldKey] = next;
                    block.props = blockProps;
                    switchBtn.className = 'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ' + (next ? 'bg-[#B45309]' : 'bg-stone-300 dark:bg-stone-700');
                    switchDot.className = 'pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ' + (next ? 'translate-x-4' : 'translate-x-0');
                    switchStatus.textContent = next ? t('pages.switch_enabled') : t('pages.switch_disabled');
                    onUpdate();
                };

                switchWrapper.appendChild(switchBtn);
                switchWrapper.appendChild(switchStatus);
                fieldBox.appendChild(switchWrapper);
            } else if (widget === 'number') {
                const numInput = document.createElement('input');
                numInput.type = 'number';
                numInput.className = 'w-full h-8 bg-[var(--admin-canvas)] border border-[var(--admin-border)] rounded-lg px-2.5 text-xs font-mono text-[var(--admin-text)] outline-none focus:border-[var(--admin-accent)]';
                numInput.value = String(fieldVal !== undefined && fieldVal !== '' ? fieldVal : 0);
                numInput.oninput = function(e) {
                    blockProps[fieldKey] = Number(e.target.value);
                    block.props = blockProps;
                    onUpdate();
                };
                fieldBox.appendChild(numInput);
            } else if ((widget === 'select' || Array.isArray(field.options)) && Array.isArray(field.options) && field.options.length > 0) {
                const select = document.createElement('edge-select');
                select.className = 'w-full h-8 bg-[var(--admin-canvas)] border border-[var(--admin-border)] rounded-lg px-2.5 text-xs font-medium text-[var(--admin-text)] outline-none focus:border-[var(--admin-accent)] block';
                field.options.forEach(function(opt) {
                    const optEl = document.createElement('option');
                    const val = opt && typeof opt === 'object' ? (opt.value !== undefined ? opt.value : opt.label) : opt;
                    const text = opt && typeof opt === 'object' ? (opt.label || opt.name || String(val)) : String(opt);
                    optEl.setAttribute('value', String(val));
                    optEl.textContent = text;
                    if (String(fieldVal) === String(val)) {
                        optEl.setAttribute('selected', 'selected');
                    }
                    select.appendChild(optEl);
                });
                select.addEventListener('change', function() {
                    blockProps[fieldKey] = select.value;
                    block.props = blockProps;
                    onUpdate();
                });
                fieldBox.appendChild(select);
            } else if (widget === 'list' || widget === 'array' || field.type === 'array' || Array.isArray(fieldVal)) {
                fieldBox.className = 'col-span-full space-y-2';
                const isApiString = typeof blockProps[fieldKey] === 'string' && blockProps[fieldKey].trim().startsWith('@api:');

                if (!isApiString && !Array.isArray(blockProps[fieldKey])) {
                    blockProps[fieldKey] = Array.isArray(fieldVal) ? [...fieldVal] : [];
                }

                const arrayHead = document.createElement('div');
                arrayHead.className = 'flex items-center justify-between pb-1 flex-wrap gap-2';
                const currentCount = Array.isArray(blockProps[fieldKey]) ? blockProps[fieldKey].length : 0;
                arrayHead.innerHTML = `
                    <div class="flex items-center space-x-2">
                        <label class="block text-xs font-bold text-stone-800 dark:text-stone-200">${fieldLabel}</label>
                        <span class="text-[10px] font-mono text-stone-400 bg-stone-100 dark:bg-stone-900 px-1.5 py-0.5 rounded items-count-badge">${isApiString ? t('pages.api_dynamic_source') : (currentCount + ' ' + t('pages.items_unit'))}</span>
                    </div>
                `;

                const rightControls = document.createElement('div');
                rightControls.className = 'flex items-center space-x-1.5';

                const apiModeBtn = document.createElement('button');
                apiModeBtn.type = 'button';
                apiModeBtn.className = 'inline-flex items-center space-x-1 h-7 px-2.5 rounded-lg bg-[var(--admin-chrome)] hover:bg-[var(--admin-surface-hover)] border border-[var(--admin-border)] text-[var(--admin-text-muted)] hover:text-[var(--admin-text)] text-[11px] font-mono font-medium transition cursor-pointer';
                apiModeBtn.textContent = isApiString ? t('pages.switch_static_list') : t('pages.switch_to_api');

                const addBtn = document.createElement('button');
                addBtn.type = 'button';
                addBtn.className = 'inline-flex items-center space-x-1 h-7 px-2.5 rounded-lg bg-[var(--admin-surface)] hover:bg-[var(--admin-surface-hover)] border border-[var(--admin-border)] text-[var(--admin-text)] text-xs font-medium transition cursor-pointer ' + (isApiString ? 'hidden' : '');
                addBtn.innerHTML = '<span class="material-symbols-outlined text-[14px]">add</span><span>' + t('pages.add_item') + '</span>';

                rightControls.appendChild(apiModeBtn);
                rightControls.appendChild(addBtn);
                arrayHead.appendChild(rightControls);
                fieldBox.innerHTML = '';
                fieldBox.appendChild(arrayHead);

                const itemsContainer = document.createElement('div');
                itemsContainer.className = 'space-y-2';

                const resolveExplicitSubFields = (f) => {
                    if (Array.isArray(f.item_schema) && f.item_schema.length > 0) return f.item_schema;
                    if (Array.isArray(f.item_fields) && f.item_fields.length > 0) return f.item_fields;
                    if (Array.isArray(f.item_schema?.fields) && f.item_schema.fields.length > 0) return f.item_schema.fields;
                    if (Array.isArray(f.item_fields?.fields) && f.item_fields.fields.length > 0) return f.item_fields.fields;
                    return [];
                };
                const explicitSubFields = resolveExplicitSubFields(field);
                const DEFAULT_LINK_FIELDS = [
                    { key: 'text', label: t('pages.link_text'), placeholder: t('pages.link_text'), type: 'text' },
                    { key: 'url', label: t('pages.link_url'), placeholder: '/', type: 'text' }
                ];
                const collectDynamicKeys = (list) => {
                    const keys = [];
                    const seen = new Set();
                    (Array.isArray(list) ? list : []).forEach(function(it) {
                        if (it && typeof it === 'object' && !Array.isArray(it)) {
                            Object.keys(it).forEach(function(k) {
                                if (!seen.has(k)) {
                                    seen.add(k);
                                    keys.push(k);
                                }
                            });
                        }
                    });
                    return keys;
                };
                const inferFieldType = (val) => {
                    if (typeof val === 'boolean') return 'boolean';
                    if (typeof val === 'number') return 'number';
                    if (typeof val === 'object' && val !== null) return 'json';
                    return 'text';
                };

                function renderListItems() {
                    itemsContainer.innerHTML = '';
                    const countBadge = fieldBox.querySelector('.items-count-badge');
                    const curVal = blockProps[fieldKey];

                    if (typeof curVal === 'string' && curVal.trim().startsWith('@api:')) {
                        if (countBadge) countBadge.textContent = t('pages.api_binding_active');
                        addBtn.classList.add('hidden');
                        apiModeBtn.textContent = t('pages.switch_static_list');
                        const apiInput = document.createElement('input');
                        apiInput.type = 'text';
                        apiInput.className = 'w-full h-8 bg-[var(--admin-accent-soft)] border border-[var(--admin-accent-border)] rounded-lg px-2.5 text-xs font-mono text-[var(--admin-accent-text)] outline-none focus:border-[var(--admin-accent)]';
                        apiInput.placeholder = t('pages.api_placeholder');
                        apiInput.value = curVal;
                        const mapMount = document.createElement('div');
                        apiInput.oninput = function(e) {
                            blockProps[fieldKey] = e.target.value;
                            block.props = blockProps;
                            renderFieldMappingPanel(mapMount, block, schema, e.target.value, onUpdate);
                            onUpdate();
                        };
                        itemsContainer.appendChild(attachApiProtocolSuggest(apiInput, function(v) {
                            blockProps[fieldKey] = v;
                            block.props = blockProps;
                            renderFieldMappingPanel(mapMount, block, schema, v, onUpdate);
                            onUpdate();
                        }));
                        itemsContainer.appendChild(mapMount);
                        renderFieldMappingPanel(mapMount, block, schema, curVal, onUpdate);
                        return;
                    }

                    addBtn.classList.remove('hidden');
                    apiModeBtn.textContent = t('pages.switch_to_api');
                    const itemsList = Array.isArray(curVal) ? curVal : [];
                    if (countBadge) countBadge.textContent = `${itemsList.length} ` + t('pages.items_unit');

                    if (itemsList.length === 0) {
                        const emptyTip = document.createElement('div');
                        emptyTip.className = 'text-center py-3 px-3 rounded-xl border border-dashed border-stone-300 dark:border-stone-700 text-[11px] text-stone-400';
                        emptyTip.textContent = t('pages.empty_items_tip', 'No items yet. Click "+ Add Item" to extend, or bind dynamic data with @api:');
                        itemsContainer.appendChild(emptyTip);
                        return;
                    }

                    const dynKeys = collectDynamicKeys(itemsList);
                    const hasCustomDynamicKeys = explicitSubFields.length === 0 && dynKeys.some(function(k) { return k !== 'text' && k !== 'url'; });

                    itemsList.forEach(function(item, idx) {
                        const isObjItem = typeof item === 'object' && item !== null && !Array.isArray(item);
                        let rowSubFields = explicitSubFields;
                        if (rowSubFields.length === 0) {
                            if (hasCustomDynamicKeys && isObjItem) {
                                const objKeys = Object.keys(item);
                                const keysToUse = objKeys.length > 0 ? objKeys : dynKeys;
                                rowSubFields = keysToUse.map(function(k) {
                                    return { key: k, label: k, placeholder: k, type: inferFieldType(item[k]) };
                                });
                            } else {
                                rowSubFields = DEFAULT_LINK_FIELDS;
                            }
                        }

                        const useCardLayout = isObjItem && rowSubFields.length > 2;
                        const row = document.createElement('div');
                        row.className = useCardLayout
                            ? 'p-2.5 rounded-xl bg-stone-50/60 dark:bg-stone-900/40 border border-stone-200/70 dark:border-stone-800 space-y-2'
                            : 'min-h-9 flex items-center space-x-2 px-1 py-1 border-b border-stone-100 dark:border-stone-800/80 last:border-b-0';

                        const idxBadge = document.createElement('span');
                        idxBadge.className = 'w-5 h-5 rounded bg-stone-100 dark:bg-stone-800 text-stone-500 dark:text-stone-400 text-[10px] font-mono font-bold flex items-center justify-center shrink-0';
                        idxBadge.textContent = String(idx + 1);

                        const delBtn = document.createElement('button');
                        delBtn.type = 'button';
                        delBtn.className = 'p-1 text-stone-400 hover:text-rose-500 rounded hover:bg-rose-50 dark:hover:bg-rose-950/50 transition cursor-pointer shrink-0';
                        delBtn.title = t('pages.delete_item');
                        delBtn.innerHTML = '<span class="material-symbols-outlined text-[15px]">delete</span>';
                        delBtn.onclick = function() {
                            itemsList.splice(idx, 1);
                            block.props = blockProps;
                            renderListItems();
                            onUpdate();
                        };

                        if (useCardLayout) {
                            const cardHead = document.createElement('div');
                            cardHead.className = 'flex items-center justify-between';
                            cardHead.appendChild(idxBadge);
                            cardHead.appendChild(delBtn);
                            row.appendChild(cardHead);
                        } else {
                            row.appendChild(idxBadge);
                        }

                        if (isObjItem) {
                            const fieldsGrid = useCardLayout ? document.createElement('div') : row;
                            if (useCardLayout) fieldsGrid.className = 'grid grid-cols-1 sm:grid-cols-2 gap-2';

                            rowSubFields.forEach(function(sf) {
                                const sfKey = sf.key || sf.name;
                                if (!sfKey) return;
                                const sfType = sf.widget || sf.type || inferFieldType(item[sfKey]);
                                const sfLabel = sf.label || sfKey;
                                const sfVal = item[sfKey];

                                let controlEl;
                                if (sfType === 'boolean' || sfType === 'switch') {
                                    const wrap = document.createElement('label');
                                    wrap.className = (useCardLayout ? 'h-7 px-2 ' : 'px-2 h-7 shrink-0 ') + 'inline-flex items-center space-x-1.5 bg-stone-50/70 dark:bg-stone-950/70 border border-stone-200/80 dark:border-stone-700/80 rounded-lg text-xs text-stone-700 dark:text-stone-200 cursor-pointer';
                                    const cb = document.createElement('input');
                                    cb.type = 'checkbox';
                                    cb.className = 'w-3.5 h-3.5 rounded accent-[var(--admin-accent)] cursor-pointer';
                                    cb.checked = sfVal === true || sfVal === 'true' || sfVal === 1;
                                    cb.onchange = function(e) {
                                        item[sfKey] = Boolean(e.target.checked);
                                        block.props = blockProps;
                                        onUpdate();
                                    };
                                    const txt = document.createElement('span');
                                    txt.className = 'truncate font-medium';
                                    txt.textContent = sfLabel;
                                    wrap.appendChild(cb);
                                    wrap.appendChild(txt);
                                    controlEl = wrap;
                                } else if (sfType === 'textarea' && useCardLayout) {
                                    const ta = document.createElement('textarea');
                                    ta.rows = 2;
                                    ta.placeholder = sf.placeholder || sfLabel;
                                    ta.title = sfLabel;
                                    ta.className = 'w-full bg-stone-50/70 dark:bg-stone-950/70 border border-stone-200/80 dark:border-stone-700/80 rounded-lg px-2 py-1.5 text-xs text-stone-800 dark:text-stone-100 outline-none focus:border-amber-500 resize-y leading-relaxed';
                                    ta.value = (typeof sfVal === 'object' && sfVal !== null) ? JSON.stringify(sfVal) : String(sfVal ?? '');
                                    ta.oninput = function(e) {
                                        item[sfKey] = e.target.value;
                                        block.props = blockProps;
                                        onUpdate();
                                    };
                                    controlEl = ta;
                                } else {
                                    const subInput = document.createElement('input');
                                    subInput.type = sfType === 'number' ? 'number' : 'text';
                                    subInput.placeholder = sf.placeholder || sfLabel;
                                    subInput.title = sfLabel;
                                    subInput.className = (useCardLayout ? 'w-full ' : 'flex-1 min-w-[90px] ') + 'h-7 bg-stone-50/70 dark:bg-stone-950/70 border border-stone-200/80 dark:border-stone-700/80 rounded-lg px-2 text-xs text-stone-800 dark:text-stone-100 outline-none focus:border-amber-500 ' + (sfType === 'json' || sfType === 'url' || sfType === 'image' ? 'font-mono' : 'font-medium');
                                    const isComplex = typeof sfVal === 'object' && sfVal !== null;
                                    subInput.value = isComplex ? JSON.stringify(sfVal) : String(sfVal ?? '');
                                    subInput.oninput = function(e) {
                                        const raw = e.target.value;
                                        if (sfType === 'number') {
                                            item[sfKey] = raw === '' ? '' : Number(raw);
                                        } else if (sfType === 'json' || (isComplex && (raw.trim().startsWith('{') || raw.trim().startsWith('[')))) {
                                            try {
                                                item[sfKey] = JSON.parse(raw);
                                            } catch {
                                                item[sfKey] = raw;
                                            }
                                        } else {
                                            item[sfKey] = raw;
                                        }
                                        block.props = blockProps;
                                        onUpdate();
                                    };
                                    controlEl = subInput;
                                }

                                if (useCardLayout) {
                                    const cell = document.createElement('div');
                                    cell.className = (sfType === 'textarea' || sfType === 'json') ? 'sm:col-span-2 space-y-1' : 'space-y-1';
                                    if (sfType !== 'boolean' && sfType !== 'switch') {
                                        const cellLbl = document.createElement('label');
                                        cellLbl.className = 'block text-[10px] font-bold text-stone-500 dark:text-stone-400 truncate';
                                        cellLbl.textContent = sfLabel;
                                        cell.appendChild(cellLbl);
                                    }
                                    cell.appendChild(controlEl);
                                    fieldsGrid.appendChild(cell);
                                } else {
                                    row.appendChild(controlEl);
                                }
                            });

                            if (useCardLayout) row.appendChild(fieldsGrid);
                        } else {
                            const valInput = document.createElement('input');
                            valInput.type = 'text';
                            valInput.placeholder = field.placeholder || t('pages.input_content_ph');
                            valInput.className = 'flex-1 h-7 bg-stone-50/70 dark:bg-stone-950/70 border border-stone-200/80 dark:border-stone-700/80 rounded-lg px-2 text-xs text-stone-800 dark:text-stone-100 outline-none focus:border-amber-500';
                            valInput.value = String(item ?? '');
                            valInput.oninput = function(e) {
                                itemsList[idx] = e.target.value;
                                block.props = blockProps;
                                onUpdate();
                            };
                            row.appendChild(valInput);
                        }

                        if (!useCardLayout) row.appendChild(delBtn);
                        itemsContainer.appendChild(row);
                    });
                }

                apiModeBtn.onclick = function() {
                    if (typeof blockProps[fieldKey] === 'string' && blockProps[fieldKey].trim().startsWith('@api:')) {
                        blockProps[fieldKey] = [];
                        delete block.field_map;
                        if (blockProps.field_map !== undefined) delete blockProps.field_map;
                    } else {
                        blockProps[fieldKey] = (typeof field.default === 'string' && field.default.trim().startsWith('@api:'))
                            ? field.default.trim()
                            : '@api:dataset:collection=projects&limit=6';
                    }
                    block.props = blockProps;
                    renderListItems();
                    onUpdate();
                };

                addBtn.onclick = function() {
                    if (!Array.isArray(blockProps[fieldKey])) blockProps[fieldKey] = [];
                    const itemsList = blockProps[fieldKey];
                    let newItem = {};
                    if (explicitSubFields.length > 0) {
                        explicitSubFields.forEach(function(sf) {
                            const sfKey = sf.key || sf.name;
                            if (!sfKey) return;
                            newItem[sfKey] = sf.default !== undefined ? sf.default : (sf.type === 'boolean' ? false : '');
                        });
                    } else {
                        const dynKeys = collectDynamicKeys(itemsList);
                        if (dynKeys.some(function(k) { return k !== 'text' && k !== 'url'; })) {
                            dynKeys.forEach(function(k) { newItem[k] = ''; });
                        } else {
                            newItem = { text: t('pages.new_link'), url: '/' };
                        }
                    }
                    itemsList.push(newItem);
                    block.props = blockProps;
                    renderListItems();
                    onUpdate();
                };

                renderListItems();
                fieldBox.appendChild(itemsContainer);
            } else if (widget === 'image' || (widget === 'url' && /image|logo|cover|icon|avatar|banner/i.test(fieldKey))) {
                const imgWrap = document.createElement('div');
                imgWrap.className = 'flex items-center space-x-2';
                const inputId = 'prop-input-' + Math.random().toString(36).slice(2, 8);
                const textInput = document.createElement('input');
                textInput.id = inputId;
                textInput.type = 'text';
                textInput.placeholder = field.placeholder || t('pages.logo_asset_ph');
                textInput.className = 'flex-1 h-8 bg-[var(--admin-canvas)] border border-[var(--admin-border)] rounded-lg px-2.5 text-xs text-[var(--admin-text)] outline-none focus:border-[var(--admin-accent)] font-mono';
                textInput.value = String(fieldVal ?? '');

                const previewImg = document.createElement('img');
                previewImg.className = 'w-8 h-8 rounded-lg object-contain bg-[var(--admin-chrome)] border border-[var(--admin-border)] shrink-0 ' + (textInput.value ? '' : 'hidden');
                previewImg.src = textInput.value || '';
                previewImg.onerror = function() { previewImg.classList.add('hidden'); };

                function syncImgPreview(val) {
                    if (val && val.trim()) {
                        previewImg.src = val.trim();
                        previewImg.classList.remove('hidden');
                    } else {
                        previewImg.classList.add('hidden');
                        previewImg.src = '';
                    }
                }

                textInput.oninput = function(e) {
                    blockProps[fieldKey] = e.target.value;
                    block.props = blockProps;
                    syncImgPreview(e.target.value);
                    onUpdate();
                };
                const pickBtn = document.createElement('button');
                pickBtn.type = 'button';
                pickBtn.className = 'h-8 px-2.5 bg-[var(--admin-surface)] hover:bg-[var(--admin-surface-hover)] border border-[var(--admin-border)] rounded-lg text-[var(--admin-text-muted)] hover:text-[var(--admin-text)] text-xs font-medium flex items-center space-x-1 shrink-0 cursor-pointer transition';
                pickBtn.innerHTML = '<span class="material-symbols-outlined text-[15px]">perm_media</span>';
                pickBtn.title = t('pages.pick_from_media');
                pickBtn.onclick = function() {
                    if (window.openMediaPickerForInput) {
                        window.openMediaPickerForInput(inputId);
                        textInput.addEventListener('change', function() {
                            blockProps[fieldKey] = textInput.value;
                            block.props = blockProps;
                            syncImgPreview(textInput.value);
                            onUpdate();
                        }, { once: true });
                    }
                };
                imgWrap.appendChild(previewImg);
                imgWrap.appendChild(textInput);
                imgWrap.appendChild(pickBtn);
                fieldBox.appendChild(imgWrap);
            } else {
                const isDataSourceField = fieldKey === 'items' || fieldKey === 'dataSource' || fieldKey === 'data_source'
                    || (typeof fieldVal === 'string' && fieldVal.trim().startsWith('@api:dataset:'));
                if (isDataSourceField) {
                    fieldBox.className = 'col-span-full space-y-1.5';
                }
                const textInput = document.createElement('input');
                textInput.type = 'text';
                textInput.placeholder = field.placeholder || '';
                textInput.className = 'w-full h-8 bg-[var(--admin-canvas)] border border-[var(--admin-border)] rounded-lg px-2.5 text-xs text-[var(--admin-text)] outline-none focus:border-[var(--admin-accent)] ' + (widget === 'url' ? 'font-mono' : '');
                textInput.value = String(fieldVal ?? '');
                const mapMount = document.createElement('div');
                textInput.oninput = function(e) {
                    blockProps[fieldKey] = e.target.value;
                    block.props = blockProps;
                    if (String(e.target.value || '').trim().startsWith('@api:dataset:')) {
                        fieldBox.className = 'col-span-full space-y-1.5';
                    }
                    renderFieldMappingPanel(mapMount, block, schema, e.target.value, onUpdate);
                    onUpdate();
                };
                fieldBox.appendChild(attachApiProtocolSuggest(textInput, function(v) {
                    blockProps[fieldKey] = v;
                    block.props = blockProps;
                    if (String(v || '').trim().startsWith('@api:dataset:')) {
                        fieldBox.className = 'col-span-full space-y-1.5';
                    }
                    renderFieldMappingPanel(mapMount, block, schema, v, onUpdate);
                    onUpdate();
                }));
                fieldBox.appendChild(mapMount);
                renderFieldMappingPanel(mapMount, block, schema, String(fieldVal ?? ''), onUpdate);
            }

            body.appendChild(fieldBox);
        });

        return body;
    }

    function createBlockCustomJsPane(block, onUpdate) {
        if (!block.props || typeof block.props !== 'object') {
            block.props = block.data && typeof block.data === 'object' ? { ...block.data } : {};
        }
        const wrap = document.createElement('div');
        wrap.className = 'space-y-2 pt-1';

        const hint = document.createElement('p');
        hint.className = 'text-[11px] text-stone-500 dark:text-stone-400 leading-relaxed';
        hint.textContent = t('pages.comp_custom_js_hint');
        wrap.appendChild(hint);

        const textarea = document.createElement('textarea');
        textarea.rows = 6;
        textarea.spellcheck = false;
        textarea.className = 'w-full bg-stone-950 text-amber-300 border border-stone-700 rounded-xl p-3 text-xs font-mono outline-none focus:border-amber-500 resize-y leading-relaxed';
        textarea.placeholder = t('pages.comp_custom_js_ph');
        textarea.value = typeof block.props.custom_js === 'string' ? block.props.custom_js : '';
        textarea.oninput = function(e) {
            block.props.custom_js = e.target.value;
            onUpdate();
        };
        wrap.appendChild(textarea);
        return wrap;
    }

    window.__EDGE_RUNTIME__ = window.__EDGE_RUNTIME__ || {};
    window.__EDGE_RUNTIME__.pageEditorFields = {
        createBlockFieldsBody,
        createBlockCustomJsPane
    };
})();
