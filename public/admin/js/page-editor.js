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

    const THEME_COMPONENTS_MAP = {};
    const THEME_TEMPLATES_MAP = {};
    let PAGE_DATASETS_DATA = { collections: [], schemas: [], externalExtensions: [], extIslandEnabled: false, slotQuotas: {} };
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
                        const rawDataSlots = Array.isArray(comp.data_slots)
                            ? comp.data_slots
                            : (Array.isArray(meta.data_slots)
                                ? meta.data_slots
                                : (comp.schema && Array.isArray(comp.schema.data_slots)
                                    ? comp.schema.data_slots
                                    : (meta.schema && Array.isArray(meta.schema.data_slots) ? meta.schema.data_slots : [])));
                        const dataSlots = rawDataSlots.filter(function(ds) { return ds && typeof ds.key === 'string' && ds.key.trim(); });
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
                            data_slots: dataSlots,
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

        const rawDatasets = document.getElementById('page-datasets-data')?.textContent;
        if (rawDatasets) {
            try {
                const parsed = JSON.parse(rawDatasets);
                PAGE_DATASETS_DATA = {
                    collections: Array.isArray(parsed.collections) ? parsed.collections : [],
                    schemas: Array.isArray(parsed.schemas) ? parsed.schemas : [],
                    externalExtensions: Array.isArray(parsed.externalExtensions) ? parsed.externalExtensions : [],
                    extIslandEnabled: Boolean(parsed.extIslandEnabled),
                    slotQuotas: (parsed.slotQuotas && typeof parsed.slotQuotas === 'object') ? parsed.slotQuotas : {}
                };
            } catch (e) {
                console.warn('[PageEditor] Failed to parse page datasets metadata:', e);
            }
        }
    }

    function getComponentSchema(compName) {
        if (!compName) return { name: '', slug: '', title: '', icon: 'widgets', summary: '', category: 'General', isContainer: false, fields: [] };
        const lower = String(compName).toLowerCase();
        if (lower === '@ext:island' || lower === 'ext:island') {
            if (PAGE_DATASETS_DATA.extIslandEnabled) {
                const extList = PAGE_DATASETS_DATA.externalExtensions || [];
                const slugField = extList.length > 0
                    ? {
                        key: 'slug',
                        label: t('pages.ext_island_slug'),
                        widget: 'select',
                        type: 'select',
                        options: extList.map(function(ext) {
                            return { value: ext.slug, label: (ext.name || ext.slug) + ' (' + ext.slug + ')' };
                        }),
                        default: extList[0].slug
                    }
                    : {
                        key: 'slug',
                        label: t('pages.ext_island_slug'),
                        type: 'text',
                        placeholder: 'tag-worker',
                        default: ''
                    };
                return {
                    name: '@ext:island',
                    slug: '@ext:island',
                    title: t('pages.ext_island_title'),
                    icon: 'extension',
                    summary: t('pages.ext_island_desc'),
                    category: 'System',
                    isContainer: false,
                    slots: ['main', 'sidebar', 'footer', 'header', 'subnav'],
                    fields: [
                        slugField,
                        { key: 'path', label: t('pages.ext_island_path'), type: 'text', placeholder: '/widget', default: '/widget' },
                        { key: 'params', label: t('pages.ext_island_params'), type: 'text', placeholder: '{"limit":5}', default: '' }
                    ]
                };
            }
            return {
                name: compName,
                slug: compName,
                title: compName,
                icon: 'extension',
                summary: '',
                category: 'System',
                isContainer: false,
                fields: []
            };
        }
        if (THEME_COMPONENTS_MAP[compName]) return THEME_COMPONENTS_MAP[compName];
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
            icon: 'error',
            summary: '',
            category: 'Theme',
            isContainer: false,
            isMissing: true,
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

    const getFieldsMod = () => (window.__EDGE_RUNTIME__ && window.__EDGE_RUNTIME__.pageEditorFields) || {};

    const expandedBlockIds = new Set();
    const blockActiveTabMap = new Map();
    let draggingBlockIndex = -1;

    function escapeHtmlText(str) {
        return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    window.__EDGE_RUNTIME__ = window.__EDGE_RUNTIME__ || {};
    window.__EDGE_RUNTIME__.pageEditorHost = {
        THEME_COMPONENTS_MAP,
        DEFAULT_SLOT_QUOTAS,
        getPageDatasetsData: () => PAGE_DATASETS_DATA,
        getCurrentBlocks: () => currentBlocks,
        getActiveTemplateObj,
        resolveEditorBlockSlot,
        escapeHtmlText
    };

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
            tplBanner.className = 'p-3.5 rounded-2xl bg-stone-100 dark:bg-stone-900/90 border border-stone-300 dark:border-stone-700 space-y-2';
            tplBanner.innerHTML = `
                <div class="flex items-center justify-between text-xs">
                    <div class="flex items-center space-x-2 font-black text-stone-700 dark:text-stone-200">
                        <span class="material-symbols-outlined text-[16px] text-stone-500">lock</span>
                        <span>${t('pages.inherited_from_template')}: ${activeTpl.title} (${t('pages.readonly_skeleton')})</span>
                    </div>
                </div>
                <div class="flex flex-wrap gap-2 pt-1">
                    ${tplBlocks.map(function(tb) {
                        const cSlug = String(tb.component || tb.type || tb.id || '');
                        if (cSlug === '@slot:page_content' || cSlug === 'slot:page_content') {
                            return `<span class="px-2.5 py-1 rounded-lg bg-amber-100 dark:bg-amber-950 text-amber-700 dark:text-amber-300 text-[11px] font-mono font-bold border border-amber-300 dark:border-amber-700">${t('pages.slot_page_content_badge')}</span>`;
                        }
                        const tSlot = resolveEditorBlockSlot(tb);
                        const sch = getComponentSchema(cSlug);
                        return `<span class="px-2.5 py-1 rounded-lg bg-stone-200/80 dark:bg-stone-800 text-stone-600 dark:text-stone-300 text-[11px] font-mono border border-stone-300 dark:border-stone-700">🔒 ${sch.title || cSlug} [${tSlot}]</span>`;
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
                slotCard.className = 'p-4 rounded-2xl bg-amber-50/70 dark:bg-amber-950/40 border-2 border-dashed border-amber-400 dark:border-amber-700 flex items-center justify-between';
                slotCard.innerHTML = `
                    <div class="flex items-center space-x-3">
                        <span class="material-symbols-outlined text-amber-600">dynamic_feed</span>
                        <div>
                            <div class="text-xs font-black text-amber-900 dark:text-amber-200">${t('pages.slot_page_content_title')}</div>
                            <div class="text-[11px] text-amber-700 dark:text-amber-400">${t('pages.slot_page_content_desc')}</div>
                        </div>
                    </div>
                `;
                const delSlotBtn = document.createElement('button');
                delSlotBtn.type = 'button';
                delSlotBtn.className = 'p-1.5 rounded-lg text-stone-400 hover:text-red-600 cursor-pointer';
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
            const isMissingComponent = Boolean(schema.isMissing);

            const card = document.createElement('div');
            card.draggable = true;
            card.dataset.blockIndex = String(index);
            if (isMissingComponent) card.setAttribute('data-invalid-component', compName);
            card.className = isMissingComponent
                ? 'relative bg-red-50/40 dark:bg-red-950/20 rounded-xl border-2 border-red-400 dark:border-red-500/80 shadow-xs transition-colors duration-75'
                : (isSuspended
                    ? 'relative bg-amber-50/40 dark:bg-stone-800/50 rounded-xl border-2 border-dashed border-amber-400 dark:border-amber-500/80 shadow-xs opacity-75 transition-colors duration-75'
                    : 'relative bg-white dark:bg-stone-800 rounded-xl border border-stone-200/80 dark:border-stone-700 shadow-xs transition-colors duration-75 hover:border-amber-500/40');

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

            if (isMissingComponent) {
                const missingBanner = document.createElement('div');
                missingBanner.className = 'rounded-t-xl px-3 py-1.5 bg-red-100/90 dark:bg-red-950/80 border-b border-red-300 dark:border-red-800 text-red-800 dark:text-red-200 text-[11px] font-bold flex items-center space-x-2';
                missingBanner.textContent = t('pages.comp_invalid_hint', { component: compName });
                card.appendChild(missingBanner);
            } else if (isSuspended) {
                const warnBanner = document.createElement('div');
                warnBanner.className = 'rounded-t-xl px-3 py-1.5 bg-amber-100/90 dark:bg-amber-950/80 border-b border-amber-300 dark:border-amber-700 text-amber-900 dark:text-amber-200 text-[11px] font-bold flex items-center space-x-2';
                warnBanner.textContent = t('pages.slot_quota_suspended');
                card.appendChild(warnBanner);
            }

            const header = document.createElement('div');
            header.className = 'h-11 px-3 flex items-center justify-between gap-3 cursor-pointer select-none hover:bg-stone-50/80 dark:hover:bg-stone-700/40 transition-colors duration-75' + (isExpanded ? ' border-b border-stone-100 dark:border-stone-700/80' : '');

            const headerLeft = document.createElement('div');
            headerLeft.className = 'flex items-center space-x-2.5 min-w-0 flex-1';
            const slotBadgeHtml = allowedSlots.length === 1
                ? `<span class="text-[10px] font-mono text-stone-400 bg-stone-100 dark:bg-stone-900 px-1.5 py-0.5 rounded shrink-0">${targetSlot}</span>`
                : '';
            const missingPillHtml = isMissingComponent
                ? `<span class="px-1.5 py-0.5 rounded bg-red-100 dark:bg-red-900/60 text-red-700 dark:text-red-300 border border-red-300 dark:border-red-700 text-[10px] font-bold shrink-0">${escapeHtmlText(t('pages.comp_invalid_badge'))}</span>`
                : '';

            headerLeft.innerHTML = `
                <span class="material-symbols-outlined text-[16px] text-stone-300 dark:text-stone-600 cursor-grab shrink-0">drag_indicator</span>
                <div class="w-7 h-7 rounded-lg ${isMissingComponent ? 'bg-red-100 text-red-600 border-red-300 dark:bg-red-950/60 dark:text-red-400 dark:border-red-800' : 'bg-[var(--admin-chrome)] text-[var(--admin-text-muted)] border-[var(--admin-border)]'} border flex items-center justify-center shrink-0">
                    <span class="material-symbols-outlined text-[16px]">${schema.icon || 'widgets'}</span>
                </div>
                <div class="flex items-center space-x-2 min-w-0 flex-1">
                    <span class="font-bold text-xs ${isMissingComponent ? 'text-red-700 dark:text-red-300' : 'text-stone-900 dark:text-white'} shrink-0">${escapeHtmlText(schema.title || compName)}</span>
                    <span class="text-[11px] font-mono text-stone-400 shrink-0">(${escapeHtmlText(compName)})</span>
                    ${missingPillHtml}
                    ${snippetText ? `<span class="text-xs text-stone-400 dark:text-stone-500 truncate min-w-0">· ${escapeHtmlText(snippetText)}</span>` : ''}
                </div>
                ${slotBadgeHtml}
            `;
            header.appendChild(headerLeft);

            const headerRight = document.createElement('div');
            headerRight.className = 'flex items-center space-x-1 shrink-0';
            headerRight.addEventListener('click', function(e) { e.stopPropagation(); });

            if (allowedSlots.length > 1) {
                const slotCapsule = document.createElement('edge-select');
                slotCapsule.className = 'edge-select-compact bg-amber-50 dark:bg-amber-950/80 border border-amber-300 dark:border-amber-700 rounded-full px-2 py-0.5 text-[11px] font-mono font-bold text-amber-700 dark:text-amber-300 cursor-pointer';
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
            upBtn.className = 'p-1 rounded-lg text-stone-400 hover:text-stone-700 dark:hover:text-white hover:bg-stone-100 dark:hover:bg-stone-700 transition-colors duration-75 cursor-pointer ' + (index === 0 ? 'opacity-30 cursor-not-allowed' : '');
            upBtn.disabled = index === 0;
            upBtn.onclick = function() { window.moveBlock(index, -1); };
            upBtn.innerHTML = '<span class="material-symbols-outlined text-[16px]">arrow_upward</span>';
            headerRight.appendChild(upBtn);

            const downBtn = document.createElement('button');
            downBtn.type = 'button';
            downBtn.className = 'p-1 rounded-lg text-stone-400 hover:text-stone-700 dark:hover:text-white hover:bg-stone-100 dark:hover:bg-stone-700 transition-colors duration-75 cursor-pointer ' + (index === currentBlocks.length - 1 ? 'opacity-30 cursor-not-allowed' : '');
            downBtn.disabled = index === currentBlocks.length - 1;
            downBtn.onclick = function() { window.moveBlock(index, 1); };
            downBtn.innerHTML = '<span class="material-symbols-outlined text-[16px]">arrow_downward</span>';
            headerRight.appendChild(downBtn);

            const delBtn = document.createElement('button');
            delBtn.type = 'button';
            delBtn.className = 'p-1 rounded-lg text-stone-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40 transition-colors duration-75 cursor-pointer';
            delBtn.onclick = function() { window.deleteBlock(index); };
            delBtn.innerHTML = '<span class="material-symbols-outlined text-[16px]">delete</span>';
            headerRight.appendChild(delBtn);

            const chevronIcon = document.createElement('span');
            chevronIcon.className = 'material-symbols-outlined text-[16px] text-stone-400 transition-transform duration-150 ml-0.5 ' + (isExpanded ? 'rotate-180' : '');
            chevronIcon.textContent = 'expand_more';
            headerRight.appendChild(chevronIcon);

            header.appendChild(headerRight);
            card.appendChild(header);

            const bodyWrap = document.createElement('div');
            bodyWrap.className = (isExpanded ? 'p-4' : 'hidden p-4');
            if (schema.allow_custom_js === true) {
                const activeTab = blockActiveTabMap.get(block.id) || 'props';
                const tabBar = document.createElement('div');
                tabBar.className = 'flex items-center space-x-1.5 pb-3 mb-3 border-b border-stone-100 dark:border-stone-700/80';

                const propsPane = typeof getFieldsMod().createBlockFieldsBody === 'function'
                    ? getFieldsMod().createBlockFieldsBody(block, schema, function() { syncBlocksToTextarea(); }, compName)
                    : document.createElement('div');
                const jsPane = typeof getFieldsMod().createBlockCustomJsPane === 'function'
                    ? getFieldsMod().createBlockCustomJsPane(block, function() { syncBlocksToTextarea(); })
                    : document.createElement('div');

                const btnProps = document.createElement('button');
                btnProps.type = 'button';
                btnProps.textContent = t('pages.comp_tab_props');

                const btnJs = document.createElement('button');
                btnJs.type = 'button';
                btnJs.textContent = t('pages.comp_tab_custom_js');

                const syncSubTabs = function(nextTab) {
                    blockActiveTabMap.set(block.id, nextTab);
                    const activeCls = 'px-2.5 py-1 rounded-lg text-[11px] font-bold bg-[#B45309] text-white shadow-xs cursor-pointer transition-colors duration-75';
                    const idleCls = 'px-2.5 py-1 rounded-lg text-[11px] font-semibold text-stone-600 dark:text-stone-300 bg-stone-100 dark:bg-stone-900 hover:bg-stone-200 dark:hover:bg-stone-700 cursor-pointer transition-colors duration-75';
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
                const body = typeof getFieldsMod().createBlockFieldsBody === 'function'
                    ? getFieldsMod().createBlockFieldsBody(block, schema, function() { syncBlocksToTextarea(); }, compName)
                    : document.createElement('div');
                bodyWrap.appendChild(body);
            }
            card.appendChild(bodyWrap);

            header.addEventListener('click', function() {
                const nowOpen = expandedBlockIds.has(block.id);
                if (nowOpen) {
                    expandedBlockIds.delete(block.id);
                    bodyWrap.classList.add('hidden');
                    header.classList.remove('border-b', 'border-stone-100', 'dark:border-stone-700/80');
                    chevronIcon.classList.remove('rotate-180');
                } else {
                    expandedBlockIds.add(block.id);
                    bodyWrap.classList.remove('hidden');
                    header.classList.add('border-b', 'border-stone-100', 'dark:border-stone-700/80');
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
            if (window.closeAddComponentGallery) window.closeAddComponentGallery();
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

        if (window.closeAddComponentGallery) window.closeAddComponentGallery();
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

    window.switchPageEditorTab = function(tabName) {
        const visualPane = document.getElementById('pane-visual-editor');
        const codePane = document.getElementById('pane-code-editor');
        const tabVisualBtn = document.getElementById('tab-btn-visual');
        const tabCodeBtn = document.getElementById('tab-btn-code');
        const activeCls = 'h-full px-2.5 rounded-md text-[13px] font-semibold transition-colors cursor-pointer bg-[var(--admin-accent-soft)] text-[var(--admin-accent-text)] flex items-center space-x-1.5';
        const idleCls = 'h-full px-2.5 rounded-md text-[13px] font-semibold transition-colors cursor-pointer text-[var(--admin-text-muted)] hover:text-[var(--admin-text)] flex items-center space-x-1.5';

        if (tabName === 'visual') {
            currentBlocks = parseBlocksFromTextarea();
            window.renderVisualBlocks();
            if (visualPane) visualPane.classList.remove('hidden');
            if (codePane) codePane.classList.add('hidden');
            if (tabVisualBtn) tabVisualBtn.className = activeCls;
            if (tabCodeBtn) tabCodeBtn.className = idleCls;
        } else {
            syncBlocksToTextarea();
            if (visualPane) visualPane.classList.add('hidden');
            if (codePane) codePane.classList.remove('hidden');
            if (tabVisualBtn) tabVisualBtn.className = idleCls;
            if (tabCodeBtn) tabCodeBtn.className = activeCls;
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

    const PAGE_TAB_MAP = {
        'page-meta': 'props',
        'page-seo': 'seo',
        'page-i18n': 'i18n',
        'page-vcs': 'vcs',
        props: 'props',
        seo: 'seo',
        i18n: 'i18n',
        vcs: 'vcs'
    };
    const ALL_PAGE_TABS = ['props', 'seo', 'i18n', 'vcs'];

    window.switchPageInspectorTab = function(targetKey) {
        const tabKey = PAGE_TAB_MAP[targetKey] || 'props';
        for (let i = 0; i < ALL_PAGE_TABS.length; i++) {
            const k = ALL_PAGE_TABS[i];
            const panel = document.getElementById('page-inspector-panel-' + k);
            const btn = document.getElementById('page-inspector-tab-' + k);
            const isActive = k === tabKey;
            if (panel) panel.classList.toggle('hidden', !isActive);
            if (btn) {
                btn.classList.toggle('bg-[var(--admin-surface)]', isActive);
                btn.classList.toggle('text-[var(--admin-text)]', isActive);
                btn.classList.toggle('shadow-sm', isActive);
                btn.classList.toggle('border-[var(--admin-border)]', isActive);
                btn.classList.toggle('text-[var(--admin-text-muted)]', !isActive);
                btn.classList.toggle('border-transparent', !isActive);
            }
        }
    };

    window.copyPagePreviewUrl = function() {
        const box = document.getElementById('page-preview-url-box');
        if (!box) return;
        const text = (box.textContent || '').trim();
        if (text && navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(function() {
                if (window.showToast) window.showToast(t('editor.copied_url') || 'URL copied', 'success');
            }).catch(function() {});
        }
    };

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
        const seoSection = document.getElementById('page-inspector-tab-seo');

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
            if (!document.getElementById('page-inspector-panel-seo')?.classList.contains('hidden')) {
                window.switchPageInspectorTab('props');
            }
        } else if (val === 'redirect') {
            templateBox?.classList.add('hidden');
            slugBox?.classList.remove('hidden');
            parentBox?.classList.add('hidden');
            localeBox?.classList.add('hidden');
            redirectBox?.classList.remove('hidden');
            seoSection?.classList.add('hidden');
            if (!document.getElementById('page-inspector-panel-seo')?.classList.contains('hidden')) {
                window.switchPageInspectorTab('props');
            }
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

    window.selectPagePermissionOption = function(val, label) {
        const input = document.getElementById('form-permission-input');
        const labelElem = document.getElementById('page-permission-selected-label');
        if (input) input.value = val;
        if (labelElem) labelElem.textContent = label;
        document.getElementById('dropdown-menu-page-permission')?.classList.add('hidden');
    };

    function inspectSpecialRouteSlug(rawVal, fullPath) {
        return typeof window.inspectEdgeSpecialRouteSlug === 'function'
            ? window.inspectEdgeSpecialRouteSlug(rawVal, fullPath)
            : { level: 'none', message: '' };
    }

    function renderSpecialRouteHint(hintEl, inputEl, checkResult) {
        if (typeof window.renderEdgeSpecialRouteHint === 'function') {
            window.renderEdgeSpecialRouteHint(hintEl, inputEl, checkResult);
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

    function syncPageTransGroupUi(tgId, tgName) {
        const input = document.getElementById('form-page-trans-group-id');
        const label = document.getElementById('page-trans-group-label');
        const leaveBtn = document.getElementById('btn-leave-page-trans-group');
        const addLink = document.getElementById('btn-add-page-translation');
        const joined = Boolean(tgId);
        if (input) input.value = tgId || '';
        if (label) label.textContent = joined ? tgName : t('editor.trans_group_not_joined');
        if (leaveBtn) leaveBtn.classList.toggle('hidden', !joined);
        if (addLink) {
            if (joined) {
                const pageId = document.getElementById('form-page-id')?.value || '';
                addLink.href = '/admin/pages/new?translation_group_id=' + encodeURIComponent(tgId) + '&source_id=' + encodeURIComponent(pageId);
            }
            addLink.classList.toggle('hidden', !joined);
        }
    }

    window.selectPageTransGroupOption = function(tgId, tgName) { syncPageTransGroupUi(tgId, tgName); };
    window.unlinkPageTransGroup = function() { syncPageTransGroupUi('', ''); };

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

    window.__walnutSetPageEditorBlocks = function(nextBlocks) {
        currentBlocks = Array.isArray(nextBlocks) ? nextBlocks : [];
        syncBlocksToTextarea();
        window.renderVisualBlocks && window.renderVisualBlocks();
    };

    window.inspectVersionById = function(versionId, vNum) {
        let map = {};
        try {
            const el = document.getElementById('vcs-versions-data');
            map = el ? JSON.parse(el.textContent || '{}') : {};
        } catch (e) {}
        const raw = map[versionId] || '[]';
        let formatted = raw;
        try { formatted = JSON.stringify(JSON.parse(raw), null, 2); } catch (e) {}
        window.switchPageEditorTab && window.switchPageEditorTab('code');
        const textarea = document.getElementById('page-content-core');
        if (textarea) {
            window.showConfirmDialog && window.showConfirmDialog({
                title: t('editor.viewing_snapshot', { version: vNum }),
                message: formatted.slice(0, 1800) + (formatted.length > 1800 ? '\n...' : ''),
                icon: 'history',
                onConfirm: function() {}
            });
        }
    };

    window.rollbackToVersionById = function(versionId, vNum) {
        let map = {};
        try {
            const el = document.getElementById('vcs-versions-data');
            map = el ? JSON.parse(el.textContent || '{}') : {};
        } catch (e) {}
        const raw = map[versionId] || '[]';
        window.showConfirmDialog({
            title: t('editor.btn_rollback_snapshot'),
            message: t('editor.confirm_rollback', { version: vNum }),
            icon: 'history',
            onConfirm: function() {
                try {
                    const parsed = JSON.parse(raw);
                    currentBlocks = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.blocks) ? parsed.blocks : []);
                } catch (e) {
                    currentBlocks = [];
                }
                syncBlocksToTextarea();
                window.renderVisualBlocks && window.renderVisualBlocks();
                const commitInput = document.querySelector('#page-edit-form input[name="commit_message"]');
                if (commitInput) commitInput.value = t('editor.rollback_commit_prefix', { version: vNum });
                if (window.showToast) window.showToast('✔️ ' + t('editor.rollback_success', { version: vNum }), 'success');
            }
        });
    };

    window.deletePastVersion = function(vId, vNum) {
        window.showConfirmDialog({
            title: t('common.delete'),
            message: 'v' + vNum,
            icon: 'delete',
            onConfirm: async function() {
                const pageId = document.getElementById('form-page-id')?.value || '';
                const res = await fetch('/admin/articles/api/version/' + encodeURIComponent(vId) + '?node_id=' + encodeURIComponent(pageId), { method: 'DELETE' });
                if (res.ok) {
                    document.getElementById('version-card-' + vId)?.remove();
                    if (window.showToast) window.showToast('✔️ ' + t('common.success'), 'success');
                }
            }
        });
    };

    window.confirmSoftDeletePage = function() {
        const title = document.getElementById('page-title-input')?.value || '';
        window.showConfirmDialog({
            title: t('common.btn_move_to_trash'),
            message: t('pages.confirm_delete', { title: title }),
            icon: 'delete',
            onConfirm: async function() {
                const pageId = document.getElementById('form-page-id')?.value || '';
                const res = await fetch('/admin/pages/api/delete/' + encodeURIComponent(pageId), { method: 'DELETE' });
                if (res.ok) window.location.href = '/admin/pages';
            }
        });
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initPageEditor);
    } else {
        initPageEditor();
    }
})();
