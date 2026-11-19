(function() {
    'use strict';

    const CSRF_TOKEN = 'walnut-admin-csrf-valid-token';
    const originalFetch = window.fetch;
    window.fetch = function(url, options) {
        options = options || {};
        options.headers = options.headers || {};
        if (options.method && options.method.toUpperCase() !== 'GET' && options.method.toUpperCase() !== 'HEAD') {
            if (options.headers instanceof Headers) {
                if (!options.headers.has('X-Admin-CSRF-Token')) {
                    options.headers.set('X-Admin-CSRF-Token', CSRF_TOKEN);
                }
            } else if (Array.isArray(options.headers)) {
                options.headers.push(['X-Admin-CSRF-Token', CSRF_TOKEN]);
            } else {
                options.headers['X-Admin-CSRF-Token'] = CSRF_TOKEN;
            }
        }
        return originalFetch.call(this, url, options);
    };

    const t = (k, params) => {
        if (!k) return '';
        const fn = window.__WALNUT_I18N__ && window.__WALNUT_I18N__.t;
        if (typeof fn === 'function') {
            const res = fn(k, params);
            if (res) return res;
        }
        return k;
    };

    const THEME_COMPONENTS_MAP = {};
    const THEME_TEMPLATES_MAP = {};
    let currentBlocks = [];

    function mergeComponentFields(comp, meta) {
        const uiList = Array.isArray(comp.ui_schema) && comp.ui_schema.length > 0
            ? comp.ui_schema
            : (Array.isArray(meta.ui_schema) ? meta.ui_schema : []);

        const schemaFields = (comp.schema && Array.isArray(comp.schema.fields) && comp.schema.fields.length > 0)
            ? comp.schema.fields
            : (Array.isArray(comp.fields) && comp.fields.length > 0
                ? comp.fields
                : ((meta.schema && Array.isArray(meta.schema.fields)) ? meta.schema.fields : (Array.isArray(meta.fields) ? meta.fields : [])));

        const fallback = comp.lowlevel_fallback || meta.lowlevel_fallback || {};
        const map = new Map();

        schemaFields.forEach(function(sf) {
            const key = sf.key || sf.name || sf.id;
            if (!key) return;
            const type = sf.type || 'text';
            map.set(key, {
                key: key,
                label: sf.label || sf.title || sf.name || key,
                type: type,
                widget: sf.widget || (type === 'array' ? 'list' : (type === 'boolean' ? 'switch' : type)),
                default: sf.default !== undefined ? sf.default : (fallback[key] !== undefined ? fallback[key] : (type === 'array' ? [] : '')),
                placeholder: sf.placeholder || '',
                group: sf.group || t('pages.comp_group_basic'),
                options: Array.isArray(sf.options) ? sf.options : undefined,
                item_fields: sf.item_fields || sf.itemFields,
                item_schema: sf.item_schema || sf.items
            });
        });

        uiList.forEach(function(uf) {
            const key = uf.key || uf.name || uf.id;
            if (!key) return;
            const prev = map.get(key);
            if (prev) {
                const widget = uf.widget || prev.widget || (prev.type === 'boolean' ? 'switch' : prev.type);
                map.set(key, {
                    ...prev,
                    ...uf,
                    key: key,
                    label: uf.label || prev.label || key,
                    type: prev.type || uf.type || (widget === 'switch' ? 'boolean' : 'text'),
                    widget: widget,
                    default: uf.default !== undefined ? uf.default : prev.default,
                    placeholder: uf.placeholder || prev.placeholder || (prev.default !== undefined && typeof prev.default !== 'boolean' ? String(prev.default) : ''),
                    group: uf.group || prev.group || t('pages.comp_group_basic'),
                    options: Array.isArray(uf.options) && uf.options.length > 0 ? uf.options : prev.options,
                    item_fields: uf.item_fields || uf.itemFields || prev.item_fields,
                    item_schema: uf.item_schema || uf.items || prev.item_schema
                });
            } else {
                const widget = uf.widget || uf.type || 'text';
                const defVal = uf.default !== undefined ? uf.default : (fallback[key] !== undefined ? fallback[key] : (widget === 'switch' ? false : (widget === 'list' || widget === 'array' ? [] : '')));
                map.set(key, {
                    ...uf,
                    key: key,
                    label: uf.label || uf.title || key,
                    type: uf.type || (widget === 'switch' ? 'boolean' : (widget === 'list' || widget === 'array' ? 'array' : 'text')),
                    widget: widget,
                    default: defVal,
                    placeholder: uf.placeholder || (defVal !== undefined && typeof defVal !== 'boolean' ? String(defVal) : ''),
                    group: uf.group || t('pages.comp_group_basic'),
                    options: Array.isArray(uf.options) ? uf.options : undefined,
                    item_fields: uf.item_fields || uf.itemFields,
                    item_schema: uf.item_schema || uf.items
                });
            }
        });

        // Infer editable fields from lowlevel_fallback when schema.fields is omitted.
        if (map.size === 0 && fallback && typeof fallback === 'object') {
            Object.keys(fallback).forEach(function(key) {
                if (key === 'items' || key.includes('_html')) return;
                const val = fallback[key];
                const type = Array.isArray(val) ? 'array' : (typeof val === 'boolean' ? 'boolean' : (typeof val === 'number' ? 'number' : 'text'));
                map.set(key, {
                    key: key,
                    label: key.replace(/_/g, ' ').replace(/\b\w/g, function(l) { return l.toUpperCase(); }),
                    type: type,
                    widget: type === 'array' ? 'list' : (type === 'boolean' ? 'switch' : (type === 'number' ? 'number' : (String(val).length > 35 ? 'textarea' : 'text'))),
                    default: val,
                    placeholder: '',
                    group: t('pages.comp_group_props')
                });
            });
        }

        return Array.from(map.values()).filter(function(f) {
            const k = String(f.key || f.name || f.id || '');
            return k !== 'powered_by';
        });
    }

    function initThemeMetadata() {
        const rawComps = document.getElementById('theme-components-data')?.textContent;
        if (rawComps) {
            try {
                const list = JSON.parse(rawComps);
                if (Array.isArray(list)) {
                    list.forEach(function(comp) {
                        const meta = (typeof comp.metadata === 'string' ? JSON.parse(comp.metadata) : comp.metadata) || {};
                        const slug = comp.slug || comp.componentType || meta.slug || (comp.type !== 'component' ? comp.type : null) || (meta.type !== 'component' ? meta.type : null) || comp.id;
                        if (!slug || slug === 'component') return;

                        const title = comp.title || comp.name || meta.title || meta.name || slug;
                        const icon = comp.icon || meta.icon || 'widgets';
                        const summary = comp.summary || comp.description || meta.summary || meta.description || '';
                        const category = comp.category || meta.category || t('pages.comp_general_category');
                        const fields = mergeComponentFields(comp, meta);
                        const isContainer = !!(comp.isContainer || meta.isContainer);
                        const rawSlots = comp.slots || meta.slots || (comp.slot ? [comp.slot] : (meta.slot ? [meta.slot] : ['main']));
                        const slots = Array.isArray(rawSlots) && rawSlots.length > 0 ? rawSlots : ['main'];
                        const allowCustomJs = comp.allow_custom_js === true || meta.allow_custom_js === true;

                        const schemaObj = {
                            name: slug,
                            slug: slug,
                            title: title,
                            icon: icon,
                            summary: summary,
                            category: category,
                            isContainer: isContainer,
                            allow_custom_js: allowCustomJs,
                            fields: fields,
                            slots: slots,
                            preview_srcdoc: comp.preview_srcdoc || ''
                        };

                        THEME_COMPONENTS_MAP[slug] = schemaObj;
                        THEME_COMPONENTS_MAP[slug.toLowerCase()] = schemaObj;
                        if (meta.type) THEME_COMPONENTS_MAP[meta.type] = schemaObj;
                    });
                }
            } catch (e) {
                console.warn('[PageEditor] Failed to parse theme components:', e);
            }
        }

        const rawTpls = document.getElementById('theme-templates-data')?.textContent;
        if (rawTpls) {
            try {
                const tpls = JSON.parse(rawTpls);
                if (Array.isArray(tpls)) {
                    tpls.forEach(function(tpl) {
                        const id = tpl.id || tpl.slug;
                        const slug = tpl.slug || tpl.id;
                        const item = {
                            id: id,
                            slug: slug,
                            title: tpl.title || tpl.name || slug,
                            layout: tpl.layout || 'default',
                            blocks: Array.isArray(tpl.blocks) ? tpl.blocks : []
                        };
                        if (id) THEME_TEMPLATES_MAP[id] = item;
                        if (slug) THEME_TEMPLATES_MAP[slug] = item;
                    });
                }
            } catch (e) {
                console.warn('[PageEditor] Failed to parse theme templates:', e);
            }
        }
    }

    function getComponentSchema(compName) {
        if (!compName) return { name: '', slug: '', title: '', icon: 'widgets', summary: '', category: 'General', isContainer: false, fields: [] };
        if (THEME_COMPONENTS_MAP[compName]) return THEME_COMPONENTS_MAP[compName];
        const lower = String(compName).toLowerCase();
        if (THEME_COMPONENTS_MAP[lower]) return THEME_COMPONENTS_MAP[lower];

        for (const k in THEME_COMPONENTS_MAP) {
            if (k.toLowerCase() === lower || k.replace(/[-_]/g, '') === lower.replace(/[-_]/g, '')) {
                return THEME_COMPONENTS_MAP[k];
            }
        }
        return {
            name: compName,
            slug: compName,
            title: compName,
            icon: 'widgets',
            summary: '',
            category: 'Theme',
            isContainer: false,
            fields: []
        };
    }

    function parseBlocksFromTextarea() {
        const textarea = document.getElementById('page-content-core');
        if (!textarea) return [];
        const val = (textarea.value || '').trim();
        if (!val) return [];
        try {
            const parsed = JSON.parse(val);
            if (Array.isArray(parsed)) return parsed;
            if (parsed && Array.isArray(parsed.blocks)) return parsed.blocks;
            return [];
        } catch (e) {
            return [];
        }
    }

    function syncBlocksToTextarea() {
        const textarea = document.getElementById('page-content-core');
        if (textarea) {
            textarea.value = JSON.stringify(currentBlocks, null, 2);
        }
    }

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
        return [
            { value: '@api:feed:types=article,micro&limit=10', label: t('pages.api_preset_feed') },
            { value: '@api:dataset:schema=projects&limit=6', label: t('pages.api_preset_showcase') },
            { value: '@api:dataset:id=', label: t('pages.api_preset_by_id') },
            { value: '@api:micro:limit=10', label: t('pages.api_preset_latest_micros') },
            { value: '@api:micro:maturity=evergreen&limit=6', label: t('pages.api_preset_evergreen_micros') },
            { value: '@api:article:limit=6', label: t('pages.api_preset_latest_articles') }
        ];
    }

    const DEFAULT_SLOT_QUOTAS = {
        header: 1,
        footer: 1,
        sidebar: 3,
        subnav: 2,
        main: Infinity
    };

    function getActiveTemplateObj() {
        const pageTypeInput = document.getElementById('form-page-type');
        const currentPageType = pageTypeInput ? pageTypeInput.value : 'single';
        if (currentPageType !== 'single') return null;
        const tplInput = document.getElementById('form-template-page-id');
        const tplId = tplInput ? tplInput.value : '';
        return (tplId && THEME_TEMPLATES_MAP[tplId]) ? THEME_TEMPLATES_MAP[tplId] : null;
    }

    function resolveEditorBlockSlot(block) {
        if (!block) return 'main';
        const comp = String(block.component || block.componentSlug || block.componentType || block.type || block.id || '');
        if (comp === '@slot:page_content' || comp === 'slot:page_content') return 'main';
        if (block.target_slot) return block.target_slot;
        if (block.slot) return block.slot;
        const schema = getComponentSchema(comp);
        if (schema && Array.isArray(schema.slots) && schema.slots.length > 0) {
            return schema.slots[0];
        }
        return 'main';
    }

    function attachApiProtocolSuggest(inputEl, onSelectVal) {
        const wrapper = document.createElement('div');
        wrapper.className = 'relative w-full';
        const menu = document.createElement('div');
        menu.className = 'hidden absolute left-0 right-0 top-full mt-1 z-30 bg-white dark:bg-slate-900 border border-emerald-300 dark:border-emerald-700 rounded-xl shadow-lg py-1 max-h-48 overflow-y-auto';

        function renderSuggestions(val) {
            const trimmed = (val || '').trim();
            if (!trimmed.startsWith('@api:')) {
                menu.classList.add('hidden');
                return;
            }
            menu.innerHTML = '';
            getApiProtocolSuggestions().forEach(function(sug) {
                const row = document.createElement('div');
                row.className = 'px-3 py-1.5 hover:bg-emerald-50 dark:hover:bg-emerald-950/60 cursor-pointer flex items-center justify-between text-xs';
                row.innerHTML = `<span class="font-mono font-bold text-emerald-700 dark:text-emerald-300">${sug.value}</span><span class="text-[10px] text-slate-400 ml-2">${sug.label}</span>`;
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
            tip.className = 'col-span-full text-[11px] text-slate-400 italic py-1';
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
            fieldBox.className = (widget === 'textarea' ? 'col-span-full ' : '') + 'space-y-1.5';

            const labelBox = document.createElement('div');
            labelBox.className = 'flex items-center justify-between';
            const label = document.createElement('label');
            label.className = 'block text-xs font-bold text-slate-700 dark:text-slate-300';
            label.textContent = fieldLabel;
            labelBox.appendChild(label);

            fieldBox.appendChild(labelBox);

            if (widget === 'textarea') {
                const textarea = document.createElement('textarea');
                textarea.rows = 2;
                textarea.className = 'w-full bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-xl p-2.5 text-xs text-slate-800 dark:text-slate-100 outline-none focus:border-slate-900 dark:focus:border-emerald-500 resize-y leading-relaxed';
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
                switchWrapper.className = 'flex items-center space-x-2.5 h-9 px-3 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-xl';
                const isChecked = fieldVal === true || fieldVal === 'true' || fieldVal === 1;

                const switchBtn = document.createElement('button');
                switchBtn.type = 'button';
                switchBtn.className = 'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ' + (isChecked ? 'bg-emerald-600' : 'bg-slate-300 dark:bg-slate-700');
                const switchDot = document.createElement('span');
                switchDot.className = 'pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ' + (isChecked ? 'translate-x-4' : 'translate-x-0');
                switchBtn.appendChild(switchDot);

                const switchStatus = document.createElement('span');
                switchStatus.className = 'text-xs text-slate-700 dark:text-slate-300 font-semibold';
                switchStatus.textContent = isChecked ? t('pages.switch_enabled') : t('pages.switch_disabled');

                switchBtn.onclick = function() {
                    const current = blockProps[fieldKey] === true || blockProps[fieldKey] === 'true' || blockProps[fieldKey] === 1;
                    const next = !current;
                    blockProps[fieldKey] = next;
                    block.props = blockProps;
                    switchBtn.className = 'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ' + (next ? 'bg-emerald-600' : 'bg-slate-300 dark:bg-slate-700');
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
                numInput.className = 'w-full bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-xl px-3 py-2 text-xs font-mono text-slate-800 dark:text-slate-100 outline-none focus:border-slate-900 dark:focus:border-emerald-500';
                numInput.value = String(fieldVal !== undefined && fieldVal !== '' ? fieldVal : 0);
                numInput.oninput = function(e) {
                    blockProps[fieldKey] = Number(e.target.value);
                    block.props = blockProps;
                    onUpdate();
                };
                fieldBox.appendChild(numInput);
            } else if ((widget === 'select' || Array.isArray(field.options)) && Array.isArray(field.options) && field.options.length > 0) {
                const select = document.createElement('walnut-select');
                select.className = 'w-full bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-xl px-3 py-2 text-xs font-semibold text-slate-800 dark:text-slate-100 outline-none focus:border-emerald-500 block';
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
                        <label class="block text-xs font-bold text-slate-800 dark:text-slate-200">${fieldLabel}</label>
                        <span class="text-[10px] font-mono text-slate-400 bg-slate-100 dark:bg-slate-900 px-1.5 py-0.5 rounded items-count-badge">${isApiString ? t('pages.api_dynamic_source') : (currentCount + ' ' + t('pages.items_unit'))}</span>
                    </div>
                `;

                const rightControls = document.createElement('div');
                rightControls.className = 'flex items-center space-x-1.5';

                const apiModeBtn = document.createElement('button');
                apiModeBtn.type = 'button';
                apiModeBtn.className = 'inline-flex items-center space-x-1 px-2 py-1 rounded-xl bg-blue-50 dark:bg-blue-950/70 hover:bg-blue-100 border border-blue-200 dark:border-blue-800 text-blue-600 dark:text-blue-400 text-[11px] font-mono font-bold transition cursor-pointer';
                apiModeBtn.textContent = isApiString ? t('pages.switch_static_list') : t('pages.switch_to_api');

                const addBtn = document.createElement('button');
                addBtn.type = 'button';
                addBtn.className = 'inline-flex items-center space-x-1 px-2.5 py-1 rounded-xl bg-emerald-50 dark:bg-emerald-950/70 hover:bg-emerald-100 dark:hover:bg-emerald-900 border border-emerald-300 dark:border-emerald-700 text-emerald-700 dark:text-emerald-300 text-xs font-bold transition cursor-pointer shadow-xs ' + (isApiString ? 'hidden' : '');
                addBtn.innerHTML = '<span class="material-symbols-outlined text-[14px]">add</span><span>' + t('pages.add_item') + '</span>';

                rightControls.appendChild(apiModeBtn);
                rightControls.appendChild(addBtn);
                arrayHead.appendChild(rightControls);
                fieldBox.innerHTML = '';
                fieldBox.appendChild(arrayHead);

                const itemsContainer = document.createElement('div');
                itemsContainer.className = 'space-y-2';

                const subFields = field.item_fields || (field.item_schema?.fields) || [
                    { key: 'text', label: t('pages.link_text'), placeholder: t('pages.link_text') },
                    { key: 'url', label: t('pages.link_url'), placeholder: '/' }
                ];

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
                        apiInput.className = 'w-full bg-blue-50/40 dark:bg-slate-950 border border-blue-300 dark:border-blue-800 rounded-xl px-3 py-2 text-xs font-mono text-blue-700 dark:text-blue-300 outline-none focus:border-emerald-500';
                        apiInput.placeholder = t('pages.api_placeholder');
                        apiInput.value = curVal;
                        apiInput.oninput = function(e) {
                            blockProps[fieldKey] = e.target.value;
                            block.props = blockProps;
                            onUpdate();
                        };
                        itemsContainer.appendChild(attachApiProtocolSuggest(apiInput, function(v) {
                            blockProps[fieldKey] = v;
                            block.props = blockProps;
                            onUpdate();
                        }));
                        return;
                    }

                    addBtn.classList.remove('hidden');
                    apiModeBtn.textContent = t('pages.switch_to_api');
                    const itemsList = Array.isArray(curVal) ? curVal : [];
                    if (countBadge) countBadge.textContent = `${itemsList.length} ` + t('pages.items_unit');

                    if (itemsList.length === 0) {
                        const emptyTip = document.createElement('div');
                        emptyTip.className = 'text-center py-3 px-3 rounded-xl border border-dashed border-slate-300 dark:border-slate-700 text-[11px] text-slate-400';
                        emptyTip.textContent = t('pages.empty_items_tip', 'No items yet. Click "+ Add Item" to extend, or bind dynamic data with @api:');
                        itemsContainer.appendChild(emptyTip);
                        return;
                    }

                    itemsList.forEach(function(item, idx) {
                        const row = document.createElement('div');
                        row.className = 'h-9 flex items-center space-x-2 px-1 border-b border-slate-100 dark:border-slate-800/80 last:border-b-0';

                        const idxBadge = document.createElement('span');
                        idxBadge.className = 'w-5 h-5 rounded bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 text-[10px] font-mono font-bold flex items-center justify-center shrink-0';
                        idxBadge.textContent = String(idx + 1);
                        row.appendChild(idxBadge);

                        if (typeof item === 'object' && item !== null) {
                            subFields.forEach(function(sf) {
                                const sfKey = sf.key || sf.name;
                                const sfVal = item[sfKey] !== undefined ? item[sfKey] : '';
                                const subInput = document.createElement('input');
                                subInput.type = 'text';
                                subInput.placeholder = sf.placeholder || sf.label || sfKey;
                                subInput.title = sf.label || sfKey;
                                subInput.className = 'flex-1 min-w-[90px] h-7 bg-slate-50/70 dark:bg-slate-950/70 border border-slate-200/80 dark:border-slate-700/80 rounded-lg px-2 text-xs text-slate-800 dark:text-slate-100 outline-none focus:border-emerald-500 font-medium';
                                subInput.value = String(sfVal);
                                subInput.oninput = function(e) {
                                    item[sfKey] = e.target.value;
                                    block.props = blockProps;
                                    onUpdate();
                                };
                                row.appendChild(subInput);
                            });
                        } else {
                            const valInput = document.createElement('input');
                            valInput.type = 'text';
                            valInput.placeholder = field.placeholder || t('pages.input_content_ph');
                            valInput.className = 'flex-1 h-7 bg-slate-50/70 dark:bg-slate-950/70 border border-slate-200/80 dark:border-slate-700/80 rounded-lg px-2 text-xs text-slate-800 dark:text-slate-100 outline-none focus:border-emerald-500';
                            valInput.value = String(item ?? '');
                            valInput.oninput = function(e) {
                                itemsList[idx] = e.target.value;
                                block.props = blockProps;
                                onUpdate();
                            };
                            row.appendChild(valInput);
                        }

                        const delBtn = document.createElement('button');
                        delBtn.type = 'button';
                        delBtn.className = 'p-1 text-slate-400 hover:text-rose-500 rounded hover:bg-rose-50 dark:hover:bg-rose-950/50 transition cursor-pointer shrink-0';
                        delBtn.title = t('pages.delete_item');
                        delBtn.innerHTML = '<span class="material-symbols-outlined text-[15px]">delete</span>';
                        delBtn.onclick = function() {
                            itemsList.splice(idx, 1);
                            block.props = blockProps;
                            renderListItems();
                            onUpdate();
                        };
                        row.appendChild(delBtn);

                        itemsContainer.appendChild(row);
                    });
                }

                apiModeBtn.onclick = function() {
                    if (typeof blockProps[fieldKey] === 'string' && blockProps[fieldKey].trim().startsWith('@api:')) {
                        blockProps[fieldKey] = [];
                    } else {
                        blockProps[fieldKey] = '@api:dataset:schema=showcase&limit=6';
                    }
                    block.props = blockProps;
                    renderListItems();
                    onUpdate();
                };

                addBtn.onclick = function() {
                    if (!Array.isArray(blockProps[fieldKey])) blockProps[fieldKey] = [];
                    const itemsList = blockProps[fieldKey];
                    let newItem = {};
                    if (subFields && subFields.length > 0) {
                        subFields.forEach(function(sf) {
                            const sfKey = sf.key || sf.name;
                            newItem[sfKey] = sf.default !== undefined ? sf.default : '';
                        });
                    } else {
                        newItem = { text: t('pages.new_link'), url: '/' };
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
                textInput.className = 'flex-1 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-xl px-3 py-2 text-xs text-slate-800 dark:text-slate-100 outline-none focus:border-slate-900 dark:focus:border-emerald-500 font-mono';
                textInput.value = String(fieldVal ?? '');

                const previewImg = document.createElement('img');
                previewImg.className = 'w-7 h-7 rounded-lg object-contain bg-slate-100 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 shrink-0 ' + (textInput.value ? '' : 'hidden');
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
                pickBtn.className = 'px-2.5 py-2 bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 rounded-xl text-slate-600 dark:text-slate-200 text-xs font-bold flex items-center space-x-1 shrink-0 cursor-pointer transition';
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
                const textInput = document.createElement('input');
                textInput.type = 'text';
                textInput.placeholder = field.placeholder || '';
                textInput.className = 'w-full bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-xl px-3 py-2 text-xs text-slate-800 dark:text-slate-100 outline-none focus:border-slate-900 dark:focus:border-emerald-500 ' + (widget === 'url' ? 'font-mono' : '');
                textInput.value = String(fieldVal ?? '');
                textInput.oninput = function(e) {
                    blockProps[fieldKey] = e.target.value;
                    block.props = blockProps;
                    onUpdate();
                };
                fieldBox.appendChild(attachApiProtocolSuggest(textInput, function(v) {
                    blockProps[fieldKey] = v;
                    block.props = blockProps;
                    onUpdate();
                }));
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
        hint.className = 'text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed';
        hint.textContent = t('pages.comp_custom_js_hint');
        wrap.appendChild(hint);

        const textarea = document.createElement('textarea');
        textarea.rows = 6;
        textarea.spellcheck = false;
        textarea.className = 'w-full bg-slate-950 text-emerald-300 border border-slate-700 rounded-xl p-3 text-xs font-mono outline-none focus:border-emerald-500 resize-y leading-relaxed';
        textarea.placeholder = t('pages.comp_custom_js_ph');
        textarea.value = typeof block.props.custom_js === 'string' ? block.props.custom_js : '';
        textarea.oninput = function(e) {
            block.props.custom_js = e.target.value;
            onUpdate();
        };
        wrap.appendChild(textarea);
        return wrap;
    }

    const expandedBlockIds = new Set();
    const blockActiveTabMap = new Map();
    let draggingBlockIndex = -1;
    let activeGalleryCategory = 'all';

    function escapeHtmlText(str) {
        return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function getBlockSnippet(block, schema) {
        const props = block.props || {};
        const keys = ['title', 'headline', 'brand_name', 'subtitle', 'description', 'cta_text', 'copyright'];
        for (const k of keys) {
            if (typeof props[k] === 'string' && props[k].trim()) return props[k].trim();
        }
        for (const v of Object.values(props)) {
            if (typeof v === 'string' && v.trim() && !v.startsWith('{') && !v.startsWith('[')) return v.trim();
        }
        return schema.summary || '';
    }

    window.renderVisualBlocks = function() {
        const container = document.getElementById('visual-blocks-container');
        const emptyTip = document.getElementById('visual-blocks-empty');
        if (!container) return;

        container.innerHTML = '';

        const activeTpl = getActiveTemplateObj();
        const tplBlocks = (activeTpl && Array.isArray(activeTpl.blocks)) ? activeTpl.blocks : [];

        const slotOccupancy = {};
        let tplHasMainBlocks = false;
        let tplHasPageContentSlot = false;

        tplBlocks.forEach(function(tb) {
            const cName = String(tb.component || tb.type || tb.id || '');
            if (cName === '@slot:page_content' || cName === 'slot:page_content') {
                tplHasPageContentSlot = true;
                return;
            }
            const tSlot = resolveEditorBlockSlot(tb);
            slotOccupancy[tSlot] = (slotOccupancy[tSlot] || 0) + 1;
            if (tSlot === 'main') tplHasMainBlocks = true;
        });

        if (tplBlocks.length > 0) {
            const tplBanner = document.createElement('div');
            tplBanner.className = 'p-3.5 rounded-2xl bg-slate-100 dark:bg-slate-900/90 border border-slate-300 dark:border-slate-700 space-y-2';
            tplBanner.innerHTML = `
                <div class="flex items-center justify-between text-xs">
                    <div class="flex items-center space-x-2 font-black text-slate-700 dark:text-slate-200">
                        <span class="material-symbols-outlined text-[16px] text-slate-500">lock</span>
                        <span>${t('pages.inherited_from_template')}: ${activeTpl.title} (${t('pages.readonly_skeleton')})</span>
                    </div>
                </div>
                <div class="flex flex-wrap gap-2 pt-1">
                    ${tplBlocks.map(function(tb) {
                        const cSlug = String(tb.component || tb.type || tb.id || '');
                        if (cSlug === '@slot:page_content' || cSlug === 'slot:page_content') {
                            return `<span class="px-2.5 py-1 rounded-lg bg-emerald-100 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300 text-[11px] font-mono font-bold border border-emerald-300 dark:border-emerald-700">${t('pages.slot_page_content_badge')}</span>`;
                        }
                        const tSlot = resolveEditorBlockSlot(tb);
                        const sch = getComponentSchema(cSlug);
                        return `<span class="px-2.5 py-1 rounded-lg bg-slate-200/80 dark:bg-slate-800 text-slate-600 dark:text-slate-300 text-[11px] font-mono border border-slate-300 dark:border-slate-700">🔒 ${sch.title || cSlug} [${tSlot}]</span>`;
                    }).join('')}
                </div>
            `;
            container.appendChild(tplBanner);
        }

        if (!currentBlocks || currentBlocks.length === 0) {
            if (emptyTip) {
                if (tplBlocks.length === 0) emptyTip.classList.remove('hidden');
                else emptyTip.classList.add('hidden');
            }
            return;
        }

        if (emptyTip) emptyTip.classList.add('hidden');

        currentBlocks.forEach(function(block, index) {
            const compName = block.component || block.componentType || block.type || '';
            block.component = compName;
            if (!block.id) {
                block.id = 'blk_' + compName.replace(/[^a-z0-9]/gi, '_') + '_' + (index + 1);
            }

            if (compName === '@slot:page_content' || compName === 'slot:page_content') {
                const slotCard = document.createElement('div');
                slotCard.className = 'p-4 rounded-2xl bg-emerald-50/70 dark:bg-emerald-950/40 border-2 border-dashed border-emerald-400 dark:border-emerald-700 flex items-center justify-between';
                slotCard.innerHTML = `
                    <div class="flex items-center space-x-3">
                        <span class="material-symbols-outlined text-emerald-600">dynamic_feed</span>
                        <div>
                            <div class="text-xs font-black text-emerald-900 dark:text-emerald-200">${t('pages.slot_page_content_title')}</div>
                            <div class="text-[11px] text-emerald-700 dark:text-emerald-400">${t('pages.slot_page_content_desc')}</div>
                        </div>
                    </div>
                `;
                const delSlotBtn = document.createElement('button');
                delSlotBtn.type = 'button';
                delSlotBtn.className = 'p-1.5 rounded-lg text-slate-400 hover:text-red-600 cursor-pointer';
                delSlotBtn.onclick = function() { window.deleteBlock(index); };
                delSlotBtn.innerHTML = '<span class="material-symbols-outlined text-[16px]">delete</span>';
                slotCard.appendChild(delSlotBtn);
                container.appendChild(slotCard);
                return;
            }

            const schema = getComponentSchema(compName);
            const allowedSlots = (Array.isArray(schema.slots) && schema.slots.length > 0) ? schema.slots : ['main'];
            if (!block.target_slot) {
                block.target_slot = block.slot || allowedSlots[0] || 'main';
            }
            const targetSlot = block.target_slot;

            // Mark blocks displaced by template slot quotas as suspended without deleting their JSON data.
            slotOccupancy[targetSlot] = (slotOccupancy[targetSlot] || 0) + 1;
            const maxForSlot = DEFAULT_SLOT_QUOTAS[targetSlot] !== undefined ? DEFAULT_SLOT_QUOTAS[targetSlot] : Infinity;
            const isMainLockedByTpl = (targetSlot === 'main' && tplBlocks.length > 0 && tplHasMainBlocks && !tplHasPageContentSlot);
            const isSuspended = (tplBlocks.length > 0) && (slotOccupancy[targetSlot] > maxForSlot || isMainLockedByTpl);

            const isExpanded = expandedBlockIds.has(block.id);
            const snippetText = getBlockSnippet(block, schema);

            const card = document.createElement('div');
            card.draggable = true;
            card.dataset.blockIndex = String(index);
            card.className = isSuspended
                ? 'relative bg-amber-50/40 dark:bg-slate-800/50 rounded-xl border-2 border-dashed border-amber-400 dark:border-amber-500/80 shadow-xs opacity-75 transition-colors duration-75'
                : 'relative bg-white dark:bg-slate-800 rounded-xl border border-slate-200/80 dark:border-slate-700 shadow-xs transition-colors duration-75 hover:border-emerald-500/40';

            card.addEventListener('dragstart', function(e) {
                draggingBlockIndex = index;
                if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
                card.classList.add('opacity-50');
            });
            card.addEventListener('dragend', function() {
                draggingBlockIndex = -1;
                card.classList.remove('opacity-50');
            });
            card.addEventListener('dragover', function(e) {
                e.preventDefault();
                if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
            });
            card.addEventListener('drop', function(e) {
                e.preventDefault();
                if (draggingBlockIndex < 0 || draggingBlockIndex === index) return;
                const moved = currentBlocks.splice(draggingBlockIndex, 1)[0];
                currentBlocks.splice(index, 0, moved);
                draggingBlockIndex = -1;
                syncBlocksToTextarea();
                window.renderVisualBlocks();
            });

            if (isSuspended) {
                const warnBanner = document.createElement('div');
                warnBanner.className = 'rounded-t-xl px-3 py-1.5 bg-amber-100/90 dark:bg-amber-950/80 border-b border-amber-300 dark:border-amber-700 text-amber-900 dark:text-amber-200 text-[11px] font-bold flex items-center space-x-2';
                warnBanner.textContent = t('pages.slot_quota_suspended');
                card.appendChild(warnBanner);
            }

            const header = document.createElement('div');
            header.className = 'h-11 px-3 flex items-center justify-between gap-3 cursor-pointer select-none hover:bg-slate-50/80 dark:hover:bg-slate-700/40 transition-colors duration-75' + (isExpanded ? ' border-b border-slate-100 dark:border-slate-700/80' : '');

            const headerLeft = document.createElement('div');
            headerLeft.className = 'flex items-center space-x-2.5 min-w-0 flex-1';
            const slotBadgeHtml = allowedSlots.length === 1
                ? `<span class="text-[10px] font-mono text-slate-400 bg-slate-100 dark:bg-slate-900 px-1.5 py-0.5 rounded shrink-0">${targetSlot}</span>`
                : '';

            headerLeft.innerHTML = `
                <span class="material-symbols-outlined text-[16px] text-slate-300 dark:text-slate-600 cursor-grab shrink-0">drag_indicator</span>
                <div class="w-7 h-7 rounded-lg bg-emerald-50 dark:bg-emerald-950/80 text-emerald-600 dark:text-emerald-400 border border-emerald-200/70 dark:border-emerald-800/70 flex items-center justify-center shrink-0">
                    <span class="material-symbols-outlined text-[16px]">${schema.icon || 'widgets'}</span>
                </div>
                <div class="flex items-center space-x-2 min-w-0 flex-1">
                    <span class="font-bold text-xs text-slate-900 dark:text-white shrink-0">${schema.title || compName}</span>
                    <span class="text-[11px] font-mono text-slate-400 shrink-0">(${compName})</span>
                    ${snippetText ? `<span class="text-xs text-slate-400 dark:text-slate-500 truncate min-w-0">· ${escapeHtmlText(snippetText)}</span>` : ''}
                </div>
                ${slotBadgeHtml}
            `;
            header.appendChild(headerLeft);

            const headerRight = document.createElement('div');
            headerRight.className = 'flex items-center space-x-1 shrink-0';
            headerRight.addEventListener('click', function(e) { e.stopPropagation(); });

            if (allowedSlots.length > 1) {
                const slotCapsule = document.createElement('walnut-select');
                slotCapsule.className = 'walnut-select-compact bg-emerald-50 dark:bg-emerald-950/80 border border-emerald-300 dark:border-emerald-700 rounded-full px-2 py-0.5 text-[11px] font-mono font-bold text-emerald-700 dark:text-emerald-300 cursor-pointer';
                allowedSlots.forEach(function(sOpt) {
                    const optEl = document.createElement('option');
                    optEl.setAttribute('value', sOpt);
                    optEl.textContent = t('pages.position_prefix') + ': ' + sOpt;
                    if (sOpt === targetSlot) optEl.setAttribute('selected', 'selected');
                    slotCapsule.appendChild(optEl);
                });
                slotCapsule.addEventListener('change', function() {
                    block.target_slot = slotCapsule.value;
                    syncBlocksToTextarea();
                    window.renderVisualBlocks();
                });
                headerRight.appendChild(slotCapsule);
            }

            const upBtn = document.createElement('button');
            upBtn.type = 'button';
            upBtn.className = 'p-1 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors duration-75 cursor-pointer ' + (index === 0 ? 'opacity-30 cursor-not-allowed' : '');
            upBtn.disabled = index === 0;
            upBtn.onclick = function() { window.moveBlock(index, -1); };
            upBtn.innerHTML = '<span class="material-symbols-outlined text-[16px]">arrow_upward</span>';
            headerRight.appendChild(upBtn);

            const downBtn = document.createElement('button');
            downBtn.type = 'button';
            downBtn.className = 'p-1 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors duration-75 cursor-pointer ' + (index === currentBlocks.length - 1 ? 'opacity-30 cursor-not-allowed' : '');
            downBtn.disabled = index === currentBlocks.length - 1;
            downBtn.onclick = function() { window.moveBlock(index, 1); };
            downBtn.innerHTML = '<span class="material-symbols-outlined text-[16px]">arrow_downward</span>';
            headerRight.appendChild(downBtn);

            const delBtn = document.createElement('button');
            delBtn.type = 'button';
            delBtn.className = 'p-1 rounded-lg text-slate-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40 transition-colors duration-75 cursor-pointer';
            delBtn.onclick = function() { window.deleteBlock(index); };
            delBtn.innerHTML = '<span class="material-symbols-outlined text-[16px]">delete</span>';
            headerRight.appendChild(delBtn);

            const chevronIcon = document.createElement('span');
            chevronIcon.className = 'material-symbols-outlined text-[16px] text-slate-400 transition-transform duration-150 ml-0.5 ' + (isExpanded ? 'rotate-180' : '');
            chevronIcon.textContent = 'expand_more';
            headerRight.appendChild(chevronIcon);

            header.appendChild(headerRight);
            card.appendChild(header);

            const bodyWrap = document.createElement('div');
            bodyWrap.className = (isExpanded ? 'p-4' : 'hidden p-4');
            if (schema.allow_custom_js === true) {
                const activeTab = blockActiveTabMap.get(block.id) || 'props';
                const tabBar = document.createElement('div');
                tabBar.className = 'flex items-center space-x-1.5 pb-3 mb-3 border-b border-slate-100 dark:border-slate-700/80';

                const propsPane = createBlockFieldsBody(block, schema, function() {
                    syncBlocksToTextarea();
                }, compName);
                const jsPane = createBlockCustomJsPane(block, function() {
                    syncBlocksToTextarea();
                });

                const btnProps = document.createElement('button');
                btnProps.type = 'button';
                btnProps.textContent = t('pages.comp_tab_props');

                const btnJs = document.createElement('button');
                btnJs.type = 'button';
                btnJs.textContent = t('pages.comp_tab_custom_js');

                const syncSubTabs = function(nextTab) {
                    blockActiveTabMap.set(block.id, nextTab);
                    const activeCls = 'px-2.5 py-1 rounded-lg text-[11px] font-bold bg-emerald-600 text-white shadow-xs cursor-pointer transition-colors duration-75';
                    const idleCls = 'px-2.5 py-1 rounded-lg text-[11px] font-semibold text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-900 hover:bg-slate-200 dark:hover:bg-slate-700 cursor-pointer transition-colors duration-75';
                    btnProps.className = nextTab === 'props' ? activeCls : idleCls;
                    btnJs.className = nextTab === 'custom_js' ? activeCls : idleCls;
                    if (nextTab === 'props') {
                        propsPane.classList.remove('hidden');
                        jsPane.classList.add('hidden');
                    } else {
                        propsPane.classList.add('hidden');
                        jsPane.classList.remove('hidden');
                    }
                };

                btnProps.onclick = function() { syncSubTabs('props'); };
                btnJs.onclick = function() { syncSubTabs('custom_js'); };
                tabBar.appendChild(btnProps);
                tabBar.appendChild(btnJs);
                bodyWrap.appendChild(tabBar);
                bodyWrap.appendChild(propsPane);
                bodyWrap.appendChild(jsPane);
                syncSubTabs(activeTab);
            } else {
                if (block.custom_js !== undefined) delete block.custom_js;
                if (block.props && block.props.custom_js !== undefined) delete block.props.custom_js;
                if (block.data && block.data.custom_js !== undefined) delete block.data.custom_js;
                const body = createBlockFieldsBody(block, schema, function() {
                    syncBlocksToTextarea();
                }, compName);
                bodyWrap.appendChild(body);
            }
            card.appendChild(bodyWrap);

            header.addEventListener('click', function() {
                const nowOpen = expandedBlockIds.has(block.id);
                if (nowOpen) {
                    expandedBlockIds.delete(block.id);
                    bodyWrap.classList.add('hidden');
                    header.classList.remove('border-b', 'border-slate-100', 'dark:border-slate-700/80');
                    chevronIcon.classList.remove('rotate-180');
                } else {
                    expandedBlockIds.add(block.id);
                    bodyWrap.classList.remove('hidden');
                    header.classList.add('border-b', 'border-slate-100', 'dark:border-slate-700/80');
                    chevronIcon.classList.add('rotate-180');
                }
            });

            container.appendChild(card);
        });

        syncBlocksToTextarea();
    };

    window.addBlock = function(compSlug) {
        if (compSlug === '@slot:page_content') {
            currentBlocks.push({
                id: '@slot:page_content',
                component: '@slot:page_content',
                target_slot: 'main'
            });
            syncBlocksToTextarea();
            window.renderVisualBlocks();
            window.closeAddComponentGallery();
            return;
        }

        const schema = getComponentSchema(compSlug);
        const allowedSlots = (Array.isArray(schema.slots) && schema.slots.length > 0) ? schema.slots : ['main'];
        const defaultProps = {};
        (schema.fields || []).forEach(function(f) {
            const k = f.key || f.name || f.id;
            if (k) defaultProps[k] = f.default !== undefined ? f.default : '';
        });

        const newBlock = {
            id: 'blk_' + compSlug.replace(/[^a-z0-9]/gi, '_') + '_' + Date.now().toString(36).slice(-4),
            component: compSlug,
            target_slot: allowedSlots[0] || 'main',
            props: defaultProps
        };

        currentBlocks.push(newBlock);
        expandedBlockIds.add(newBlock.id);
        syncBlocksToTextarea();
        window.renderVisualBlocks();

        window.closeAddComponentGallery();
        if (window.showToast) {
            window.showToast((t('pages.comp_added_title') || '').replace('{{name}}', (schema.title || compSlug)), 'success');
        }
    };

    window.moveBlock = function(index, direction) {
        const targetIndex = index + direction;
        if (targetIndex < 0 || targetIndex >= currentBlocks.length) return;
        const temp = currentBlocks[index];
        currentBlocks[index] = currentBlocks[targetIndex];
        currentBlocks[targetIndex] = temp;
        syncBlocksToTextarea();
        window.renderVisualBlocks();
    };

    window.deleteBlock = function(index) {
        currentBlocks.splice(index, 1);
        syncBlocksToTextarea();
        window.renderVisualBlocks();
        if (window.showToast) {
            window.showToast(t('pages.comp_deleted_toast'), 'info');
        }
    };

    function classifyGalleryComp(comp) {
        const s = ((comp.slug || '') + ' ' + (comp.category || '') + ' ' + (comp.title || '')).toLowerCase();
        if (/nav|header|menu|breadcrumb|sidebar/.test(s)) return 'nav';
        if (/hero|banner|intro|cta|cover/.test(s)) return 'hero';
        if (/footer|form|lead|contact|subscribe|pricing|testimonial/.test(s)) return 'footer';
        if (/dataset|media|gallery|feed|stream|viewer|table|chart/.test(s)) return 'data';
        return 'grid';
    }

    let galleryCardsInitialized = false;

    function buildGalleryCardDom(gridEl) {
        const slotCard = document.createElement('div');
        slotCard.id = 'comp-gallery-slot-card';
        slotCard.className = 'col-span-full shrink-0 p-4 bg-emerald-50/70 dark:bg-emerald-950/40 hover:bg-emerald-100/70 dark:hover:bg-emerald-950/70 cursor-pointer flex items-center space-x-3 transition-colors duration-75 rounded-2xl border-2 border-dashed border-emerald-300 dark:border-emerald-700 hidden';
        slotCard.onclick = function() { window.addBlock('@slot:page_content'); };
        slotCard.innerHTML = `
            <div class="w-10 h-10 rounded-xl bg-emerald-600 text-white flex items-center justify-center shrink-0">
                <span class="material-symbols-outlined text-[20px]">dynamic_feed</span>
            </div>
            <div class="min-w-0 flex-1">
                <div class="font-black text-xs text-emerald-900 dark:text-emerald-200">${t('pages.slot_comp_title')}</div>
                <div class="text-[11px] text-emerald-700 dark:text-emerald-400 mt-0.5">${t('pages.slot_comp_desc')}</div>
            </div>
        `;
        gridEl.appendChild(slotCard);

        const seenSlugs = new Set();
        Object.values(THEME_COMPONENTS_MAP).forEach(function(comp) {
            if (!comp || !comp.slug || seenSlugs.has(comp.slug)) return;
            seenSlugs.add(comp.slug);
            const cSlots = (Array.isArray(comp.slots) && comp.slots.length > 0) ? comp.slots : ['main'];
            const cat = classifyGalleryComp(comp);

            const card = document.createElement('div');
            card.setAttribute('data-gallery-card', '1');
            card.setAttribute('data-gallery-slug', comp.slug);
            card.setAttribute('data-gallery-category', cat);
            card.setAttribute('data-gallery-slots', cSlots.join(','));

            const previewWrap = document.createElement('div');
            previewWrap.className = 'shrink-0 bg-slate-100 dark:bg-slate-950/80 p-2.5 border-b border-slate-200/80 dark:border-slate-700/80';
            const viewport = document.createElement('div');
            viewport.className = 'w-full h-32 rounded-lg overflow-hidden relative bg-white dark:bg-slate-900 ring-1 ring-black/5 dark:ring-white/10';
            if (comp.preview_srcdoc) {
                const iframe = document.createElement('iframe');
                iframe.className = 'pointer-events-none select-none border-0 origin-top-left absolute top-0 left-0';
                iframe.style.width = '960px';
                iframe.style.height = '480px';
                iframe.style.transformOrigin = '0 0';
                iframe.setAttribute('data-srcdoc', comp.preview_srcdoc);
                iframe.setAttribute('tabindex', '-1');
                viewport.appendChild(iframe);
            } else {
                viewport.innerHTML = `<div class="w-full h-full flex items-center justify-center text-slate-400"><span class="material-symbols-outlined text-[32px]">${comp.icon || 'widgets'}</span></div>`;
            }
            previewWrap.appendChild(viewport);
            card.appendChild(previewWrap);

            const info = document.createElement('div');
            info.className = 'p-4 flex-1 flex flex-col justify-between space-y-2.5';
            const slotsBadges = cSlots.map(function(s) {
                return `<span class="bg-indigo-50 dark:bg-indigo-950/80 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800/80 px-2 py-0.5 rounded-md font-mono text-[10px] font-semibold">${s}</span>`;
            }).join(' ');
            info.innerHTML = `
                <div>
                    <div class="flex items-center justify-between gap-2">
                        <div class="flex items-center space-x-2 min-w-0">
                            <span class="material-symbols-outlined text-[16px] text-emerald-600 dark:text-emerald-400 shrink-0">${comp.icon || 'widgets'}</span>
                            <span class="font-black text-xs text-slate-900 dark:text-white truncate">${escapeHtmlText(comp.title)}</span>
                        </div>
                        <span class="text-[10px] font-mono text-slate-400 shrink-0">${escapeHtmlText(comp.slug)}</span>
                    </div>
                    <p class="text-[11px] text-slate-500 dark:text-slate-400 mt-1 line-clamp-2">${escapeHtmlText(comp.summary || comp.slug)}</p>
                </div>
                <div class="flex items-center justify-between pt-2 border-t border-slate-100 dark:border-slate-700/60">
                    <div class="flex items-center flex-wrap gap-1">${slotsBadges}</div>
                    <span data-gallery-quota-msg class="text-[10px] text-amber-600 font-bold hidden">${t('pages.slot_not_open_by_template')}</span>
                </div>
            `;
            card.appendChild(info);
            gridEl.appendChild(card);
        });

        const emptyEl = document.createElement('div');
        emptyEl.id = 'comp-gallery-empty';
        emptyEl.className = 'col-span-full py-12 text-center text-slate-400 text-xs italic hidden';
        emptyEl.textContent = t('pages.no_theme_comps');
        gridEl.appendChild(emptyEl);
    }

    function scaleVisibleGalleryIframes(gridEl) {
        requestAnimationFrame(function() {
            gridEl.querySelectorAll('[data-gallery-card]:not(.hidden) iframe').forEach(function(ifr) {
                const w = ifr.parentElement ? ifr.parentElement.clientWidth : 400;
                if (w > 0) {
                    const scale = Math.min(1, Math.max(0.25, w / 960));
                    ifr.style.transform = 'scale(' + scale.toFixed(4) + ')';
                }
                const pendingSrcdoc = ifr.getAttribute('data-srcdoc');
                if (pendingSrcdoc !== null) {
                    ifr.srcdoc = pendingSrcdoc;
                    ifr.removeAttribute('data-srcdoc');
                }
            });
        });
    }

    window.renderComponentGallery = function(category) {
        if (category) activeGalleryCategory = category;
        const filtersEl = document.getElementById('comp-gallery-filters');
        const gridEl = document.getElementById('comp-gallery-grid');
        if (!filtersEl || !gridEl) return;

        const cats = [
            { id: 'all', label: t('pages.gallery_cat_all') },
            { id: 'nav', label: t('pages.gallery_cat_nav') },
            { id: 'hero', label: t('pages.gallery_cat_hero') },
            { id: 'grid', label: t('pages.gallery_cat_grid') },
            { id: 'data', label: t('pages.gallery_cat_data') },
            { id: 'footer', label: t('pages.gallery_cat_footer') }
        ];
        if (!filtersEl.hasChildNodes()) {
            cats.forEach(function(cat) {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.setAttribute('data-gallery-filter', cat.id);
                btn.textContent = cat.label;
                btn.onclick = function() { window.renderComponentGallery(cat.id); };
                filtersEl.appendChild(btn);
            });
        }
        filtersEl.querySelectorAll('button[data-gallery-filter]').forEach(function(btn) {
            const isActive = activeGalleryCategory === btn.getAttribute('data-gallery-filter');
            btn.className = isActive
                ? 'px-3 py-1 rounded-full text-xs font-bold bg-emerald-600 text-white shadow-xs transition-colors duration-75 cursor-pointer'
                : 'px-3 py-1 rounded-full text-xs font-semibold bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700 hover:border-emerald-400 transition-colors duration-75 cursor-pointer';
        });

        // Keep mounted card iframes alive in DOM across category switches to eliminate srcdoc reload flashes.
        if (!galleryCardsInitialized) {
            gridEl.innerHTML = '';
            buildGalleryCardDom(gridEl);
            galleryCardsInitialized = true;
        }

        const pageTypeInput = document.getElementById('form-page-type');
        const currentPageType = pageTypeInput ? pageTypeInput.value : 'single';
        const hasPageContentSlotAlready = currentBlocks.some(function(b) {
            const c = b.component || b.id || '';
            return c === '@slot:page_content' || c === 'slot:page_content';
        });
        const slotCard = document.getElementById('comp-gallery-slot-card');
        const showSlotCard = currentPageType === 'template' && !hasPageContentSlotAlready && (activeGalleryCategory === 'all' || activeGalleryCategory === 'grid');
        if (slotCard) slotCard.classList.toggle('hidden', !showSlotCard);

        const activeTpl = getActiveTemplateObj();
        const tplSlotUsed = {};
        if (activeTpl && Array.isArray(activeTpl.blocks)) {
            activeTpl.blocks.forEach(function(tb) {
                const s = resolveEditorBlockSlot(tb);
                tplSlotUsed[s] = (tplSlotUsed[s] || 0) + 1;
            });
        }

        let visibleCount = 0;
        gridEl.querySelectorAll('[data-gallery-card]').forEach(function(card) {
            const slug = card.getAttribute('data-gallery-slug') || '';
            const cat = card.getAttribute('data-gallery-category') || 'grid';
            const cSlots = (card.getAttribute('data-gallery-slots') || 'main').split(',').filter(Boolean);
            const matchesCat = activeGalleryCategory === 'all' || cat === activeGalleryCategory;
            const allSlotsFull = cSlots.every(function(s) {
                const max = DEFAULT_SLOT_QUOTAS[s] !== undefined ? DEFAULT_SLOT_QUOTAS[s] : Infinity;
                return (tplSlotUsed[s] || 0) >= max;
            });

            card.className = (allSlotsFull
                ? 'shrink-0 rounded-2xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/50 opacity-50 cursor-not-allowed overflow-hidden flex flex-col'
                : 'group shrink-0 rounded-2xl border border-slate-200/80 dark:border-slate-700/80 bg-white dark:bg-slate-800 hover:border-emerald-500 hover:shadow-lg transition-colors duration-75 cursor-pointer overflow-hidden flex flex-col')
                + (matchesCat ? '' : ' hidden');
            card.onclick = allSlotsFull ? null : function() { window.addBlock(slug); };
            const quotaMsg = card.querySelector('[data-gallery-quota-msg]');
            if (quotaMsg) quotaMsg.classList.toggle('hidden', !allSlotsFull);
            if (matchesCat) visibleCount++;
        });

        const emptyEl = document.getElementById('comp-gallery-empty');
        if (emptyEl) emptyEl.classList.toggle('hidden', visibleCount > 0 || showSlotCard);

        scaleVisibleGalleryIframes(gridEl);
    };

    window.openAddComponentGallery = function() {
        const modal = document.getElementById('add-component-gallery-modal');
        if (!modal) return;
        modal.classList.remove('hidden');
        window.renderComponentGallery(activeGalleryCategory);
    };

    window.closeAddComponentGallery = function() {
        const modal = document.getElementById('add-component-gallery-modal');
        if (modal) modal.classList.add('hidden');
    };

    window.switchPageEditorTab = function(tabName) {
        const visualPane = document.getElementById('pane-visual-editor');
        const codePane = document.getElementById('pane-code-editor');
        const tabVisualBtn = document.getElementById('tab-btn-visual');
        const tabCodeBtn = document.getElementById('tab-btn-code');

        if (tabName === 'visual') {
            currentBlocks = parseBlocksFromTextarea();
            window.renderVisualBlocks();
            if (visualPane) visualPane.classList.remove('hidden');
            if (codePane) codePane.classList.add('hidden');
            if (tabVisualBtn) tabVisualBtn.className = 'px-3 py-1.5 rounded-lg text-xs font-bold bg-slate-900 dark:bg-emerald-600 text-white shadow-sm transition flex items-center space-x-1 cursor-pointer';
            if (tabCodeBtn) tabCodeBtn.className = 'px-3 py-1.5 rounded-lg text-xs font-bold text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-700 transition flex items-center space-x-1 cursor-pointer';
        } else {
            syncBlocksToTextarea();
            if (visualPane) visualPane.classList.add('hidden');
            if (codePane) codePane.classList.remove('hidden');
            if (tabVisualBtn) tabVisualBtn.className = 'px-3 py-1.5 rounded-lg text-xs font-bold text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-700 transition flex items-center space-x-1 cursor-pointer';
            if (tabCodeBtn) tabCodeBtn.className = 'px-3 py-1.5 rounded-lg text-xs font-bold bg-slate-900 dark:bg-emerald-600 text-white shadow-sm transition flex items-center space-x-1 cursor-pointer';
        }
    };

    window.togglePageEditorSidebar = function() {
        const sidebar = document.getElementById('page-inspector-sidebar');
        const icon = document.getElementById('page-sidebar-toggle-icon');
        if (!sidebar) return;

        const isHidden = sidebar.classList.contains('hidden');
        if (isHidden) {
            sidebar.classList.remove('hidden');
            if (icon) icon.textContent = 'dock_to_right';
            try { localStorage.setItem('walnut_page_sidebar_collapsed', 'false'); } catch(e){}
        } else {
            sidebar.classList.add('hidden');
            if (icon) icon.textContent = 'view_sidebar';
            try { localStorage.setItem('walnut_page_sidebar_collapsed', 'true'); } catch(e){}
        }
    };

    const PAGE_ACCORDION_SECTIONS = ['page-meta', 'page-seo', 'page-vcs', 'page-i18n'];
    window.openPageSingleAccordion = function(targetKey) {
        const targetContent = document.getElementById('accordion-content-' + targetKey);
        const targetArrow = document.getElementById('accordion-arrow-' + targetKey);
        const isCurrentlyOpen = targetContent && !targetContent.classList.contains('hidden');

        PAGE_ACCORDION_SECTIONS.forEach(function(k) {
            const c = document.getElementById('accordion-content-' + k);
            const a = document.getElementById('accordion-arrow-' + k);
            if (c) c.classList.add('hidden');
            if (a) a.classList.add('-rotate-90');
        });

        if (!isCurrentlyOpen && targetContent) {
            targetContent.classList.remove('hidden');
            if (targetArrow) targetArrow.classList.remove('-rotate-90');
        }
    };
    window.toggleAccordion = window.openPageSingleAccordion;

    window.selectPageTypeOption = function(val, label) {
        const input = document.getElementById('form-page-type');
        const labelElem = document.getElementById('page-type-selected-label');
        if (input) input.value = val;

        const labelMap = {
            single: t('pages.type_single_option') || 'Single Page',
            template: t('pages.type_template_option') || 'Template Blueprint',
            redirect: t('pages.type_redirect_option') || 'Redirect Page'
        };
        const resolvedLabel = (label && label !== val) ? label : (labelMap[val] || val);
        if (labelElem) labelElem.textContent = resolvedLabel;

        const templateBox = document.getElementById('field-box-page-template');
        const slugBox = document.getElementById('field-box-page-slug');
        const parentBox = document.getElementById('dropdown-box-parent');
        const localeBox = document.getElementById('dropdown-box-locale');
        const redirectBox = document.getElementById('field-box-page-redirect');
        const seoSection = document.getElementById('accordion-section-page-seo');

        if (val === 'single') {
            templateBox?.classList.remove('hidden');
            slugBox?.classList.remove('hidden');
            parentBox?.classList.remove('hidden');
            localeBox?.classList.remove('hidden');
            redirectBox?.classList.add('hidden');
            seoSection?.classList.remove('hidden');
        } else if (val === 'template') {
            templateBox?.classList.add('hidden');
            slugBox?.classList.add('hidden');
            parentBox?.classList.add('hidden');
            localeBox?.classList.remove('hidden');
            redirectBox?.classList.add('hidden');
            seoSection?.classList.add('hidden');
        } else if (val === 'redirect') {
            templateBox?.classList.add('hidden');
            slugBox?.classList.remove('hidden');
            parentBox?.classList.add('hidden');
            localeBox?.classList.add('hidden');
            redirectBox?.classList.remove('hidden');
            seoSection?.classList.add('hidden');
        }

        document.getElementById('dropdown-menu-page-type')?.classList.add('hidden');
    };

    window.selectTemplatePageOption = function(val, label) {
        const input = document.getElementById('form-template-page-id');
        const labelElem = document.getElementById('template-page-selected-label');
        if (input) input.value = val;
        if (labelElem) labelElem.textContent = label;
        document.getElementById('dropdown-menu-template-page')?.classList.add('hidden');

        // Retain existing page blocks so displaced blocks recover automatically if the template is detached.
        window.renderVisualBlocks();
        if (typeof window.renderAddComponentMenu === 'function') window.renderAddComponentMenu();
    };

    window.selectPageLocaleOption = function(val, label) {
        const input = document.getElementById('form-locale-input');
        const labelElem = document.getElementById('page-locale-selected-label');
        if (input) input.value = val;
        if (labelElem) labelElem.textContent = label;
        document.getElementById('dropdown-menu-locale')?.classList.add('hidden');
    };
    window.selectLocaleOption = window.selectPageLocaleOption;

    window.selectParentPageOption = function(val, label, slug) {
        const input = document.getElementById('form-parent-id');
        const labelElem = document.getElementById('parent-selected-label');
        if (input) input.value = val;
        if (labelElem) labelElem.textContent = label;

        const cleanParent = slug ? slug.replace(/^\/+|\/+$/g, '') : '';
        window._currentParentSlug = cleanParent;
        updatePageSlugPreview();
        document.getElementById('dropdown-menu-parent')?.classList.add('hidden');
    };

    window.selectRedirectCodeOption = function(val, label) {
        const input = document.getElementById('page-redirect-code-input');
        const labelElem = document.getElementById('redirect-code-selected-label');
        if (input) input.value = val;
        if (labelElem) labelElem.textContent = label;
        document.getElementById('dropdown-menu-redirect-code')?.classList.add('hidden');
    };

    window.selectPageRobotsOption = function(val) {
        const input = document.getElementById('form-robots-input');
        const labelElem = document.getElementById('page-robots-selected-label');
        if (input) input.value = val;
        if (labelElem) labelElem.textContent = val;
        document.getElementById('dropdown-menu-robots')?.classList.add('hidden');
    };

    window.selectPageStatusOption = function(val, label) {
        const input = document.getElementById('form-status-input');
        const labelElem = document.getElementById('page-status-selected-label');
        if (input) input.value = val;
        if (labelElem) labelElem.textContent = label;

        const scheduledBox = document.getElementById('field-box-scheduled-at');
        if (scheduledBox) {
            if (val === 'scheduled') scheduledBox.classList.remove('hidden');
            else scheduledBox.classList.add('hidden');
        }
        document.getElementById('dropdown-menu-page-status')?.classList.add('hidden');
    };
    window.selectStatusOption = window.selectPageStatusOption;

    window.selectPagePermissionOption = function(val, label) {
        const input = document.getElementById('form-permission-input');
        const labelElem = document.getElementById('page-permission-selected-label');
        if (input) input.value = val;
        if (labelElem) labelElem.textContent = label;
        document.getElementById('dropdown-menu-page-permission')?.classList.add('hidden');
    };
    window.selectPermissionOption = window.selectPagePermissionOption;

    const FORBIDDEN_ROUTE_PREFIX_KEYS = {
        'admin': 'common.route_forbidden_admin',
        'api': 'common.route_forbidden_api',
        'desk': 'common.route_forbidden_desk',
        'shared': 'common.route_forbidden_shared',
        'assets': 'common.route_forbidden_assets',
        'content': 'common.route_forbidden_content',
        'theme': 'common.route_forbidden_theme',
        'commercial': 'common.route_forbidden_commercial',
        'cdn-cgi': 'common.route_forbidden_cdncgi',
        '.well-known': 'common.route_forbidden_wellknown'
    };

    const FORBIDDEN_EXACT_PATH_KEYS = {
        '/sitemap.xml': { key: 'common.route_forbidden_sitemap' },
        '/robots.txt': { key: 'common.route_forbidden_robots' },
        '/favicon.ico': { key: 'common.route_forbidden_favicon' },
        '/app.css': { key: 'common.route_forbidden_appcss' },
        '/zh-cn': { key: 'common.route_forbidden_locale', params: { path: '/zh-CN' } },
        '/en-us': { key: 'common.route_forbidden_locale', params: { path: '/en-US' } }
    };

    function trRouteMsg(key, params) {
        const fn = window.__WALNUT_I18N__ && window.__WALNUT_I18N__.t;
        if (typeof fn === 'function') {
            return fn(key, params);
        }
        return key;
    }

    function inspectSpecialRouteSlug(rawVal, fullPath) {
        const rawTrimmed = (rawVal || '').trim();
        const lowerPath = (fullPath || '/').toLowerCase();
        const firstSeg = lowerPath.replace(/^\/+/, '').split('/')[0] || '';

        if (FORBIDDEN_EXACT_PATH_KEYS[lowerPath]) {
            const rule = FORBIDDEN_EXACT_PATH_KEYS[lowerPath];
            return { level: 'forbidden', message: trRouteMsg(rule.key, rule.params) };
        }
        if (firstSeg && FORBIDDEN_ROUTE_PREFIX_KEYS[firstSeg]) {
            return { level: 'forbidden', message: trRouteMsg(FORBIDDEN_ROUTE_PREFIX_KEYS[firstSeg]) };
        }
        if (lowerPath === '/') {
            const isRawIndex = rawTrimmed.replace(/^\/+|\/+$/g, '').toLowerCase() === 'index';
            return {
                level: 'warning',
                message: isRawIndex
                    ? trRouteMsg('common.route_warn_home_index')
                    : trRouteMsg('common.route_warn_home_root')
            };
        }
        if (lowerPath === '/404') {
            return {
                level: 'warning',
                message: trRouteMsg('common.route_warn_404')
            };
        }
        if (lowerPath === '/500') {
            return {
                level: 'warning',
                message: trRouteMsg('common.route_warn_500')
            };
        }
        if (lowerPath === '/503' || lowerPath === '/maintenance') {
            return {
                level: 'warning',
                message: trRouteMsg('common.route_warn_503', { path: fullPath })
            };
        }
        return { level: 'none', message: '' };
    }

    function renderSpecialRouteHint(hintEl, inputEl, checkResult) {
        if (!hintEl) return;
        if (!checkResult || checkResult.level === 'none') {
            hintEl.className = 'hidden text-[11px] px-2.5 py-2 rounded-lg border font-medium leading-relaxed';
            hintEl.textContent = '';
            if (inputEl) {
                inputEl.classList.remove('border-red-500', 'dark:border-red-500', 'border-amber-400', 'dark:border-amber-500');
            }
            return;
        }
        if (checkResult.level === 'forbidden') {
            hintEl.className = 'text-[11px] px-2.5 py-2 rounded-lg border font-bold leading-relaxed bg-red-50 dark:bg-red-950/50 text-red-700 dark:text-red-300 border-red-200 dark:border-red-800/80';
            hintEl.textContent = checkResult.message;
            if (inputEl) {
                inputEl.classList.remove('border-amber-400', 'dark:border-amber-500');
                inputEl.classList.add('border-red-500', 'dark:border-red-500');
            }
        } else if (checkResult.level === 'warning') {
            hintEl.className = 'text-[11px] px-2.5 py-2 rounded-lg border font-semibold leading-relaxed bg-amber-50 dark:bg-amber-950/50 text-amber-800 dark:text-amber-300 border-amber-200 dark:border-amber-800/80';
            hintEl.textContent = checkResult.message;
            if (inputEl) {
                inputEl.classList.remove('border-red-500', 'dark:border-red-500');
                inputEl.classList.add('border-amber-400', 'dark:border-amber-500');
            }
        }
    }

    function normalizeSlugInputValue(rawVal) {
        const trimmed = (rawVal || '').trim();
        if (!trimmed) return '';
        if (trimmed === '/' || trimmed.replace(/\/+/g, '/') === '/' || trimmed.toLowerCase() === 'index') {
            return '/';
        }
        return trimmed.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\/+/g, '/');
    }

    function updatePageSlugPreview() {
        const slugInput = document.getElementById('page-slug-input');
        const previewPath = document.getElementById('page-preview-full-path');
        const hintEl = document.getElementById('page-slug-special-hint');
        if (!slugInput || !previewPath) return;

        const rawVal = slugInput.value;
        const normSlug = normalizeSlugInputValue(rawVal);
        const parentSlug = window._currentParentSlug !== undefined ? window._currentParentSlug : '';
        const cleanParent = (parentSlug && parentSlug !== '/') ? parentSlug.replace(/^\/+|\/+$/g, '') : '';

        let fullPath;
        if (normSlug === '/' || !normSlug) {
            fullPath = cleanParent ? ('/' + cleanParent) : '/';
        } else if (cleanParent) {
            fullPath = '/' + cleanParent + '/' + normSlug;
        } else {
            fullPath = '/' + normSlug;
        }
        previewPath.textContent = fullPath;

        if (!rawVal.trim()) {
            renderSpecialRouteHint(hintEl, slugInput, { level: 'none' });
        } else {
            const check = inspectSpecialRouteSlug(rawVal, fullPath);
            renderSpecialRouteHint(hintEl, slugInput, check);
        }
    }

    window.submitPageWithStatus = async function() {
        const form = document.getElementById('page-edit-form');
        if (!form) return;

        const codePane = document.getElementById('pane-code-editor');
        if (codePane && !codePane.classList.contains('hidden')) {
            const rawText = (document.getElementById('page-content-core')?.value || '').trim();
            if (rawText) {
                try {
                    const parsed = JSON.parse(rawText);
                    if (!Array.isArray(parsed) && !(parsed && Array.isArray(parsed.blocks))) {
                        if (window.showToast) window.showToast(t('pages.save_failed'), 'error');
                        return;
                    }
                } catch (jsonErr) {
                    if (window.showToast) window.showToast((jsonErr && jsonErr.message) || t('pages.save_failed'), 'error');
                    return;
                }
            }
            currentBlocks = parseBlocksFromTextarea();
        } else {
            syncBlocksToTextarea();
        }

        const titleInput = document.getElementById('page-title-input');
        if (!titleInput || !titleInput.value.trim()) {
            if (window.showToast) window.showToast(t('pages.title_required_warn'), 'warning');
            titleInput?.focus();
            return;
        }

        const pageTypeInput = document.getElementById('form-page-type');
        const currentPageType = pageTypeInput ? pageTypeInput.value : 'single';
        const slugInput = document.getElementById('page-slug-input');
        if (slugInput && currentPageType !== 'template') {
            const rawBeforeNorm = slugInput.value;
            const norm = normalizeSlugInputValue(rawBeforeNorm);
            const parentSlug = window._currentParentSlug !== undefined ? window._currentParentSlug : '';
            const cleanParent = (parentSlug && parentSlug !== '/') ? parentSlug.replace(/^\/+|\/+$/g, '') : '';
            const fullPath = (norm === '/' || !norm)
                ? (cleanParent ? ('/' + cleanParent) : '/')
                : (cleanParent ? ('/' + cleanParent + '/' + norm) : ('/' + norm));

            const specialCheck = inspectSpecialRouteSlug(rawBeforeNorm, fullPath);
            if (specialCheck.level === 'forbidden') {
                updatePageSlugPreview();
                if (window.showToast) window.showToast(specialCheck.message, 'error');
                slugInput.focus();
                return;
            }

            if (norm) {
                slugInput.value = norm;
            }
            updatePageSlugPreview();
        }

        const saveBtn = document.getElementById('page-save-btn');
        if (saveBtn) {
            saveBtn.disabled = true;
            saveBtn.style.opacity = '0.7';
        }

        try {
            const formData = new FormData(form);
            const response = await fetch('/admin/pages/api/save', {
                method: 'POST',
                headers: {
                    'Accept': 'application/json'
                },
                body: formData
            });

            const rawRespText = await response.text();
            let data = null;
            try {
                data = rawRespText ? JSON.parse(rawRespText) : null;
            } catch (_) {
                data = null;
            }
            if (response.ok && data && data.success) {
                const pageIdInput = document.getElementById('form-page-id');
                const isEditInput = form.querySelector('input[name="is_edit"]');
                if (data.nodeId && pageIdInput) pageIdInput.value = data.nodeId;
                if (isEditInput) isEditInput.value = 'true';

                if (slugInput && data.rawSlug !== undefined) {
                    slugInput.value = data.rawSlug === '/' ? '/' : data.rawSlug.replace(/^\/+|\/+$/g, '');
                    updatePageSlugPreview();
                } else if (slugInput) {
                    slugInput.value = normalizeSlugInputValue(slugInput.value);
                    updatePageSlugPreview();
                }

                if (data.unchanged) {
                    if (window.showToast) window.showToast('ℹ️ ' + t('pages.no_changes_detected'), 'warning');
                } else if (data.isNew) {
                    if (window.showToast) window.showToast(t('pages.create_success_redirecting'), 'success');
                    setTimeout(function() {
                        const targetUrl = data.nodeId ? ('/admin/pages/edit/' + data.nodeId) : (data.redirectUrl || '/admin/pages');
                        window.location.href = targetUrl;
                    }, 350);
                } else {
                    const verTip = data.versionNumber ? (' (v' + data.versionNumber + ')') : '';
                    if (window.showToast) window.showToast(t('pages.save_success') + verTip, 'success');
                }
            } else {
                const errReason = (data && data.error) || (rawRespText && !rawRespText.trim().startsWith('<') ? rawRespText.trim() : ('HTTP ' + response.status));
                if (window.showToast) window.showToast('❌ ' + (errReason || t('pages.save_failed')), 'error');
            }
        } catch (e) {
            if (window.showToast) window.showToast('❌ ' + t('pages.network_error'), 'error');
        } finally {
            if (saveBtn) {
                saveBtn.disabled = false;
                saveBtn.style.opacity = '1';
            }
        }
    };

    window.selectPageTransGroupOption = function(tgId, tgName) {
        const input = document.getElementById('form-page-trans-group-id');
        const label = document.getElementById('page-trans-group-label');
        const leaveBtn = document.getElementById('btn-leave-page-trans-group');
        const addLink = document.getElementById('btn-add-page-translation');
        const pageId = document.getElementById('form-page-id')?.value || '';
        if (input) input.value = tgId;
        if (label) label.textContent = tgName;
        if (leaveBtn) leaveBtn.classList.remove('hidden');
        if (addLink) {
            addLink.href = '/admin/pages/new?translation_group_id=' + encodeURIComponent(tgId) + '&source_id=' + encodeURIComponent(pageId);
            addLink.classList.remove('hidden');
        }
    };

    window.unlinkPageTransGroup = function() {
        const input = document.getElementById('form-page-trans-group-id');
        const label = document.getElementById('page-trans-group-label');
        const leaveBtn = document.getElementById('btn-leave-page-trans-group');
        const addLink = document.getElementById('btn-add-page-translation');
        if (input) input.value = '';
        if (label) label.textContent = t('editor.trans_group_not_joined');
        if (leaveBtn) leaveBtn.classList.add('hidden');
        if (addLink) addLink.classList.add('hidden');
    };

    function initPageEditor() {
        initThemeMetadata();
        if (window.renderAddComponentMenu) window.renderAddComponentMenu();

        currentBlocks = parseBlocksFromTextarea();

        // Pre-populate template blocks onto an empty page so inherited component props can be edited immediately.
        const tplInput = document.getElementById('form-template-page-id');
        if ((!currentBlocks || currentBlocks.length === 0) && tplInput && tplInput.value) {
            const tplObj = THEME_TEMPLATES_MAP[tplInput.value];
            if (tplObj && Array.isArray(tplObj.blocks) && tplObj.blocks.length > 0) {
                currentBlocks = JSON.parse(JSON.stringify(tplObj.blocks));
                syncBlocksToTextarea();
            }
        }

        window.renderVisualBlocks();

        const isCollapsed = localStorage.getItem('walnut_page_sidebar_collapsed') === 'true';
        const sidebar = document.getElementById('page-inspector-sidebar');
        const icon = document.getElementById('page-sidebar-toggle-icon');
        if (isCollapsed && sidebar) {
            sidebar.classList.add('hidden');
            if (icon) icon.textContent = 'view_sidebar';
        }

        const slugInput = document.getElementById('page-slug-input');
        if (slugInput) {
            slugInput.addEventListener('input', function() {
                const raw = this.value;
                if (raw.length > 1 && raw.startsWith('/')) {
                    this.value = raw.replace(/^\/+/, '');
                }
                updatePageSlugPreview();
            });
            slugInput.addEventListener('blur', function() {
                this.value = normalizeSlugInputValue(this.value);
                updatePageSlugPreview();
            });

            const parentInput = document.getElementById('form-parent-id');
            const parentMenu = document.getElementById('dropdown-menu-parent');
            if (parentInput && parentMenu && parentInput.value) {
                const opt = parentMenu.querySelector('[data-value="' + parentInput.value + '"]');
                const slugSpan = opt ? opt.querySelector('.font-mono') : null;
                if (slugSpan) {
                    window._currentParentSlug = slugSpan.textContent.replace(/^\/+|\/+$/g, '');
                }
            }
            updatePageSlugPreview();
            window.addEventListener('walnut:i18n-loaded', updatePageSlugPreview);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initPageEditor);
    } else {
        initPageEditor();
    }
})();
