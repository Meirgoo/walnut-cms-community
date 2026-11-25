(function() {
    'use strict';

    const t = (key, params) => {
        const fn = window.__EDGE_I18N__ && window.__EDGE_I18N__.t;
        return typeof fn === 'function' ? fn(key, params) : key;
    };

    const DEFAULT_SLOT_QUOTAS = {
        header: 1,
        footer: 1,
        main: Infinity,
        sidebar: Infinity
    };

    function readJsonScript(id, fallback) {
        try {
            const el = document.getElementById(id);
            return el && el.textContent ? JSON.parse(el.textContent) : fallback;
        } catch {
            return fallback;
        }
    }

    function normalizeComponentContract(comp) {
        const meta = (comp && comp.metadata && typeof comp.metadata === 'object') ? comp.metadata : {};
        const propsSchema = Array.isArray(comp?.fields)
            ? comp.fields
            : (Array.isArray(meta.fields) ? meta.fields : (Array.isArray(meta.props_schema) ? meta.props_schema : []));
        const tplHtml = String(meta.template_html || meta.templateHtml || comp?.template_html || '');
        const hasArticleSlot = comp?.role === 'article_content_slot' ||
            meta.role === 'article_content_slot' ||
            /\{\{\{?\s*(?:content_html|page\.content)\s*\}?\}\}/.test(tplHtml);
        const description = String(comp?.description || meta.description || comp?.summary || meta.summary || '').trim();

        const entry = {
            slug: comp.slug,
            title: comp.title || comp.slug,
            ...(description ? { description } : {}),
            slots: Array.isArray(comp?.slots) && comp.slots.length > 0
                ? comp.slots
                : (Array.isArray(meta.slots) && meta.slots.length > 0 ? meta.slots : ['main']),
            ...(hasArticleSlot ? { role: 'article_content_slot' } : {}),
            fields: propsSchema.map(function(f) {
                const fType = f.type || f.widget || 'text';
                const fieldMeta = {
                    key: f.key || f.name || f.id,
                    label: f.label || f.key || f.name,
                    type: fType
                };
                if (f.required) fieldMeta.required = true;
                if (f.default !== undefined) fieldMeta.default = f.default;
                if (Array.isArray(f.options) && f.options.length > 0) {
                    fieldMeta.options = f.options;
                }
                const nestedSchema = f.item_schema !== undefined ? f.item_schema : f.item_fields;
                if (nestedSchema !== undefined && (!Array.isArray(nestedSchema) || nestedSchema.length > 0)) {
                    fieldMeta.item_schema = nestedSchema;
                }
                return fieldMeta;
            }).filter(function(f) { return !!f.key; }),
            data_slots: Array.isArray(comp?.data_slots)
                ? comp.data_slots
                : (Array.isArray(meta.data_slots) ? meta.data_slots : [])
        };
        return entry;
    }

    function readTemplatesList() {
        const raw = readJsonScript('theme-templates-data', []);
        return Array.isArray(raw) ? raw.map(function(tp) {
            let occupied = Array.isArray(tp.occupied_slots) ? tp.occupied_slots.slice() : null;
            if (!occupied && Array.isArray(tp.blocks)) {
                const set = new Set();
                tp.blocks.forEach(function(b) {
                    if (!b || typeof b !== 'object') return;
                    if (b.component === '@slot:page_content' || b.component === 'slot:page_content' || b.id === '@slot:page_content') return;
                    set.add(String(b.target_slot || 'main').trim() || 'main');
                });
                occupied = Array.from(set);
            }
            return {
                id: tp.id || tp.slug,
                slug: tp.slug || tp.id,
                title: tp.title || tp.name || tp.slug || tp.id,
                occupied_slots: occupied || [],
                has_page_content_slot: Boolean(
                    tp.has_page_content_slot ||
                    (Array.isArray(tp.blocks) && tp.blocks.some(function(b) { return b && b.component === '@slot:page_content'; }))
                )
            };
        }) : [];
    }

    function readCurrentBlocks() {
        const textarea = document.getElementById('page-content-core');
        if (textarea && textarea.value && textarea.value.trim()) {
            try {
                const parsed = JSON.parse(textarea.value);
                if (Array.isArray(parsed)) return parsed;
                if (parsed && Array.isArray(parsed.blocks)) return parsed.blocks;
            } catch {}
        }
        return [];
    }

    function detectInitialMode(templates) {
        const pageTypeEl = document.getElementById('form-page-type');
        const tplIdEl = document.getElementById('form-template-page-id');
        if (!pageTypeEl) return 'unspecified';
        const pType = (pageTypeEl.value || 'single').trim();
        if (pType === 'template') return 'template';
        const boundTplId = tplIdEl ? (tplIdEl.value || '').trim() : '';
        if (boundTplId) {
            const match = templates.find(function(tp) { return tp.id === boundTplId || tp.slug === boundTplId; });
            return 'tpl:' + (match ? match.id : boundTplId);
        }
        const curBlocks = readCurrentBlocks();
        const hasChrome = curBlocks.some(function(b) { return b && (b.target_slot === 'header' || b.target_slot === 'footer'); });
        return hasChrome ? 'standalone' : 'unspecified';
    }

    function resolveTargetContext(modeOpt, templates) {
        const selectEl = document.getElementById('page-contract-target-mode');
        const rawMode = (modeOpt && typeof modeOpt === 'string')
            ? modeOpt
            : (selectEl && selectEl.value ? selectEl.value : detectInitialMode(templates));

        if (rawMode.startsWith('tpl:') || templates.some(function(tp) { return tp.id === rawMode || tp.slug === rawMode; })) {
            const lookup = rawMode.startsWith('tpl:') ? rawMode.slice(4) : rawMode;
            const tpl = templates.find(function(tp) { return tp.id === lookup || tp.slug === lookup; });
            if (tpl) {
                return {
                    modeKey: 'tpl:' + tpl.id,
                    kind: 'template_bound',
                    template: tpl,
                    currentPage: {
                        mode: 'template_bound',
                        template_id: tpl.id,
                        template_slug: tpl.slug,
                        template_title: tpl.title,
                        occupied_slots: tpl.occupied_slots
                    }
                };
            }
        }
        if (rawMode === 'standalone') {
            return { modeKey: 'standalone', kind: 'standalone', template: null, currentPage: { mode: 'standalone' } };
        }
        if (rawMode === 'template') {
            return { modeKey: 'template', kind: 'template', template: null, currentPage: { mode: 'template' } };
        }
        return { modeKey: 'unspecified', kind: 'unspecified', template: null, currentPage: { mode: 'unspecified' } };
    }

    window.filterConflictingChromeBlocks = function(blocks, occupiedSlots) {
        if (!Array.isArray(blocks)) return { blocks: [], removedCount: 0 };
        const conflictSet = new Set(
            (Array.isArray(occupiedSlots) && occupiedSlots.length > 0 ? occupiedSlots : ['header', 'footer'])
                .filter(function(s) { return s === 'header' || s === 'footer'; })
        );
        if (conflictSet.size === 0) return { blocks: blocks.slice(), removedCount: 0 };
        let removedCount = 0;
        const filtered = blocks.filter(function(blk) {
            if (!blk || typeof blk !== 'object') return true;
            const slot = String(blk.target_slot || '').trim();
            if (conflictSet.has(slot)) {
                removedCount++;
                return false;
            }
            return true;
        });
        return { blocks: filtered, removedCount };
    };

    window.buildPageAiContextPayload = function(options) {
        const opts = options && typeof options === 'object' ? options : {};
        const rawComponents = readJsonScript('theme-components-data', []);
        const templates = readTemplatesList();
        const datasetsData = readJsonScript('page-datasets-data', {});

        const seen = new Set();
        const components = [];
        (Array.isArray(rawComponents) ? rawComponents : []).forEach(function(comp) {
            if (!comp || !comp.slug || seen.has(comp.slug)) return;
            seen.add(comp.slug);
            components.push(normalizeComponentContract(comp));
        });

        const quotas = {};
        Object.keys(DEFAULT_SLOT_QUOTAS).forEach(function(k) {
            quotas[k] = Number.isFinite(DEFAULT_SLOT_QUOTAS[k]) ? DEFAULT_SLOT_QUOTAS[k] : 'unlimited';
        });
        if (datasetsData.slotQuotas && typeof datasetsData.slotQuotas === 'object') {
            Object.keys(datasetsData.slotQuotas).forEach(function(k) {
                const v = datasetsData.slotQuotas[k];
                quotas[k] = (typeof v === 'number' && Number.isFinite(v)) ? v : 'unlimited';
            });
        }

        const targetCtx = resolveTargetContext(opts.mode, templates);
        const currentPage = Object.assign({}, targetCtx.currentPage);
        const titleInput = document.getElementById('page-title-input');
        const slugInput = document.getElementById('page-slug-input');
        if (titleInput && titleInput.value.trim()) currentPage.title = titleInput.value.trim();
        if (slugInput && slugInput.value.trim()) currentPage.slug = slugInput.value.trim();

        const includeCheckbox = document.getElementById('page-contract-include-payload');
        const isListModal = document.getElementById('page-contract-modal')?.getAttribute('data-context') === 'list';
        const includePayload = typeof opts.includePagePayload === 'boolean'
            ? opts.includePagePayload
            : (includeCheckbox ? includeCheckbox.checked : !isListModal);

        const hasExtIsland = Boolean(
            datasetsData.extIslandEnabled &&
            Array.isArray(datasetsData.externalExtensions) &&
            datasetsData.externalExtensions.length > 0
        );
        const virtualBlocks = {
            page_content_slot: { id: '@slot:page_content', component: '@slot:page_content', target_slot: 'main' }
        };
        if (hasExtIsland) {
            virtualBlocks.ext_island = { component: '@ext:island', target_slot: 'main|sidebar|footer', props: { slug: '<ext_slug>', path: '/widget', params: '' } };
        }

        const rawTax = datasetsData.siteTaxonomy || {};
        const siteTaxonomy = {
            articles: {
                total: Number(rawTax.articles?.total || 0),
                folders: Array.isArray(rawTax.articles?.folders) ? rawTax.articles.folders.slice(0, 30) : [],
                tags: Array.isArray(rawTax.articles?.tags) ? rawTax.articles.tags.slice(0, 30) : []
            },
            micros: {
                total: Number(rawTax.micros?.total || 0),
                folders: Array.isArray(rawTax.micros?.folders) ? rawTax.micros.folders.slice(0, 30) : [],
                tags: Array.isArray(rawTax.micros?.tags) ? rawTax.micros.tags.slice(0, 30) : [],
                progress: Array.isArray(rawTax.micros?.progress) ? rawTax.micros.progress.slice(0, 30) : []
            }
        };

        const aiContext = {
            current_page: currentPage,
            site_taxonomy: siteTaxonomy,
            protocol: {
                api_sources: [
                    '@api:dataset:collection=<slug>&limit=6',
                    '@api:feed:types=article,micro&limit=10',
                    '@api:articles:limit=6&tag=<tag>&folder=<folder>',
                    '@api:micro:limit=10&progress=<progress>&folder=<folder>&tag=<tag>',
                    '@api:media:limit=6&folder=<folder>'
                ],
                virtual_blocks: virtualBlocks,
                field_map_format: { '<data_slot_key>': '<schema_field_key>' },
                data_slots_note: 'For components declaring non-empty `data_slots`, array props (e.g. `items`) support BOTH static item arrays matching `item_schema`/`data_slots` keys verbatim AND `@api:dataset:collection=<slug>&limit=6` binding strings.'
            },
            slot_quotas: quotas,
            components: components,
            dataset_schema_spec: {
                builtin_item_fields: ['title', 'slug', 'summary'],
                note: '`title` (required) plus optional `slug` and `summary` are built-in top-level fields placed directly on each `items[]` entry; only declare extra custom fields in `schema.fields` and never duplicate `title` there.',
                allowed_field_types: ['text', 'textarea', 'url', 'number', 'boolean', 'select', 'image'],
                minimal_example: {
                    schema: {
                        slug: 'example-slug',
                        name: 'Collection Name',
                        fields: [
                            { key: 'k', label: 'Field Label', type: 'text' }
                        ]
                    },
                    items: [
                        { title: 'Item Title', slug: 'item-slug', summary: 'Optional summary', k: 'Field value' }
                    ]
                }
            },
            dataset_collections: (datasetsData.collections || []).map(function(c) {
                return {
                    slug: c.slug,
                    name: c.name,
                    schema_key: c.schema_key,
                    item_count: Number(c.item_count || 0),
                    ...(c.sample_item ? { sample_item: c.sample_item } : {})
                };
            }),
            schemas: (datasetsData.schemas || []).map(function(s) {
                return {
                    slug: s.slug,
                    title: s.title || s.slug,
                    source: s.is_custom ? 'site' : 'theme',
                    item_count: Number(s.item_count || 0),
                    fields: Array.isArray(s.fields) ? s.fields : [],
                    ...(s.sample_item ? { sample_item: s.sample_item } : {})
                };
            }),
            recent_media: Array.isArray(datasetsData.recentMedia) ? datasetsData.recentMedia.slice(0, 8) : []
        };
        if (includePayload) {
            aiContext.page_payload = readCurrentBlocks();
        }
        if (hasExtIsland) {
            aiContext.external_extensions = datasetsData.externalExtensions;
        }
        return aiContext;
    };

    window.buildPageAiContextMarkdown = function(options) {
        const ctxPayload = window.buildPageAiContextPayload(options);
        const cp = ctxPayload.current_page || { mode: 'unspecified' };
        const rules = [
            'Output a single valid JSON object: `{ "datasets"?: [{ "schema": { "slug": "example-slug", "name": "Collection Name", "fields": [{ "key": "k", "label": "Label", "type": "text" }] }, "items": [{ "title": "Item Title", "k": "Field value" }] }], "blocks": [...] }` (omit `"datasets"` when no new datasets are needed).',
            'Block shape: `{ "id": "<id>", "component": "<slug>", "target_slot": "<slot>", "props": {...}, "field_map"?: {...} }` (`field_map` is top-level on the block, never inside `props`).',
            'Dynamic vs. Static boundary: Use static `items` arrays in `props` for 3-4 one-off showcase items (e.g. highlights, FAQs). For reusable structured data (reading lists, projects, gear, builds), reuse existing `dataset_collections`/`schemas` first; if none fit, emit `datasets[]` alongside `blocks` and bind `"items": "@api:dataset:collection=<slug>&limit=6"` with `field_map`.',
            'Taxonomy filter redline: When passing `folder=`, `tag=`, or `progress=` to `@api:article:`, `@api:micro:`, or `@api:feed:`, you MUST ONLY pick values present in `site_taxonomy`. If no matching value exists, omit the filter parameter to fetch all items—NEVER fabricate non-existent filter values.',
            'No ghost dataset references: Every `<slug>` referenced via `@api:dataset:collection=<slug>` MUST already exist in `dataset_collections`/`schemas` OR be defined inside `datasets[]` of the same JSON payload.',
            '`field_map` ONLY applies to dynamic datasets (`@api:dataset:collection=<slug>&limit=6` or `fetch_datasets`); STRICTLY FORBIDDEN when `items` is a static array (static item keys MUST strictly align with component `item_schema` / `data_slots` keys verbatim or render blank).',
            'In `dataset_schema_spec`, `title` (plus optional `slug`/`summary`) is a built-in top-level column on each `items[]` row—only declare extra custom fields in `schema.fields` and never duplicate `title`.',
            'Do NOT pick image-dependent split/gallery blocks with empty `image_url` unless real image URLs are provided; prefer `univers-markdown` for long prose, reviews, or narrative sections.',
            'Media selection redline: `recent_media` provides up to 8 recent site library images (`{ url, filename, alt }`). Only reuse a `url` when `filename`/`alt` genuinely matches the block topic; otherwise omit it or use `@api:media:limit=6&folder=<folder>`—never guess URLs or reuse mismatched images.',
            '`block.id` renders as `data-block-id` rather than native HTML `id`; NEVER generate `#<block-id>` anchor jump links.',
            'Keep `main` concise at 3-6 core blocks (hero intro -> core content/data -> closing section); never pad pages with unused components or place wide banner blocks into narrow `sidebar`.',
            'Strictly honor `slot_quotas`, `slots`, `options`, `data_slots`, and `dataset_schema_spec`; never invent unknown components or unsupported field types.'
        ];

        if (cp.mode === 'template_bound') {
            const occupiedStr = (cp.occupied_slots && cp.occupied_slots.length > 0) ? cp.occupied_slots.join(', ') : 'header, footer';
            rules.unshift(
                `CRITICAL (Template-Bound Page): Inherits template "${cp.template_title || cp.template_id}" (\`/${cp.template_slug || ''}\`), which ALREADY occupies slots [${occupiedStr}]. STRICTLY FORBIDDEN to emit blocks for already-occupied slots (e.g. header/footer) or \`@slot:page_content\`. Output content-area blocks only.`
            );
        } else if (cp.mode === 'standalone') {
            rules.unshift(
                'CRITICAL (Standalone Complete Page): No parent template is bound. Emit complete page layout slots (including `header`, `main`, `footer` as needed) and DO NOT emit `@slot:page_content`.'
            );
        } else if (cp.mode === 'template') {
            rules.unshift(
                'CRITICAL (Template Page Itself): Output a reusable master template shell (including chrome slots such as `header`/`footer`), and `main` MUST include `{ "component": "@slot:page_content", "target_slot": "main", "props": {} }`.'
            );
        } else {
            rules.unshift(
                'CRITICAL (Unspecified Target): Default to `main` (and optional `sidebar`) content-area blocks ONLY. DO NOT output `header`/`footer` chrome blocks or `@slot:page_content` unless the user prompt explicitly requests them.'
            );
        }

        return '# Walnut Page Assembly Context\n\n## Architecture & Output Rules\n' +
            rules.map(function(r) { return '- ' + r; }).join('\n') +
            '\n\n```json\n' + JSON.stringify(ctxPayload, null, 2) + '\n```\n';
    };

    function syncExportPreview() {
        const previewEl = document.getElementById('page-contract-export-preview');
        const hintEl = document.getElementById('page-contract-mode-hint');
        const modeSelect = document.getElementById('page-contract-target-mode');
        if (!previewEl) return;
        const selectedMode = modeSelect ? modeSelect.value : undefined;
        previewEl.value = window.buildPageAiContextMarkdown({ mode: selectedMode });
        if (hintEl) {
            const templates = readTemplatesList();
            const ctx = resolveTargetContext(selectedMode, templates);
            hintEl.textContent = ctx.kind === 'template_bound' && ctx.template
                ? (ctx.template.title + ' [' + (ctx.template.occupied_slots.join(', ') || '-') + ']')
                : ctx.kind;
        }
    }

    function populateTargetModeSelect(ctxMode) {
        const selectEl = document.getElementById('page-contract-target-mode');
        if (!selectEl) return;
        const templates = readTemplatesList();
        const initialValue = ctxMode === 'editor' ? detectInitialMode(templates) : 'unspecified';

        let html = '<option value="unspecified">' + t('pages.contract_mode_unspecified') + '</option>';
        templates.forEach(function(tp) {
            const slotsStr = tp.occupied_slots.length > 0 ? tp.occupied_slots.join(', ') : '-';
            html += '<option value="tpl:' + tp.id + '">' + tp.title + ' (/' + tp.slug + ') [' + slotsStr + ']</option>';
        });
        html += '<option value="standalone">' + t('pages.contract_mode_standalone') + '</option>';
        html += '<option value="template">' + t('pages.contract_mode_template') + '</option>';

        selectEl.innerHTML = html;
        if (typeof selectEl.refresh === 'function') {
            selectEl.refresh(initialValue);
        } else {
            selectEl.value = initialValue;
        }
        if (!selectEl._contractBound) {
            selectEl._contractBound = true;
            selectEl.addEventListener('change', syncExportPreview);
        }
    }

    window.exportPagePayloadJson = function() {
        const blocks = readCurrentBlocks();
        const slugInput = document.getElementById('page-slug-input');
        const slugName = ((slugInput && slugInput.value) || 'page').replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '') || 'page';
        if (window.walnutDownloadFile) {
            window.walnutDownloadFile(slugName + '-payload.json', JSON.stringify(blocks, null, 2), 'application/json');
        }
        if (window.showToast) window.showToast(t('pages.payload_exported'), 'success');
    };

    window.copyPageAiContext = async function() {
        const modeSelect = document.getElementById('page-contract-target-mode');
        const text = window.buildPageAiContextMarkdown(modeSelect ? { mode: modeSelect.value } : undefined);
        if (window.walnutCopyText) {
            await window.walnutCopyText(text, t('pages.ai_context_copied'), t('pages.copy_failed'));
        }
    };

    window.downloadPageAiContext = function() {
        const modeSelect = document.getElementById('page-contract-target-mode');
        const text = window.buildPageAiContextMarkdown(modeSelect ? { mode: modeSelect.value } : undefined);
        const slugInput = document.getElementById('page-slug-input');
        const slugName = ((slugInput && slugInput.value) || 'page').replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '') || 'page';
        if (window.walnutDownloadFile) {
            window.walnutDownloadFile(slugName + '-ai-context.md', text, 'text/markdown;charset=utf-8');
        }
    };

    window.switchPageContractTab = function(tab) {
        const isImport = tab === 'import';
        const exportBtn = document.getElementById('btn-page-contract-tab-export');
        const importBtn = document.getElementById('btn-page-contract-tab-import');
        const exportPane = document.getElementById('page-contract-pane-export');
        const importPane = document.getElementById('page-contract-pane-import');
        const activeCls = 'px-4 py-2.5 border-b-2 border-[var(--admin-accent)] text-[var(--admin-text)] cursor-pointer transition flex items-center space-x-1.5';
        const idleCls = 'px-4 py-2.5 border-b-2 border-transparent text-[var(--admin-text-muted)] hover:text-[var(--admin-text)] cursor-pointer transition flex items-center space-x-1.5';
        if (exportBtn) exportBtn.className = isImport ? idleCls : activeCls;
        if (importBtn) importBtn.className = isImport ? activeCls : idleCls;
        if (exportPane) exportPane.classList.toggle('hidden', isImport);
        if (importPane) importPane.classList.toggle('hidden', !isImport);
        if (!isImport) syncExportPreview();
    };

    const ALLOWED_SCHEMA_FIELD_TYPES = new Set(['text', 'textarea', 'url', 'number', 'boolean', 'select', 'image']);

    function escapeHtml(str) {
        return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function parsePageContractImportInput(parsed) {
        if (Array.isArray(parsed)) {
            if (parsed.length === 0 || (parsed[0] && parsed[0].component)) {
                return { blocks: parsed, datasets: [], pageItems: null };
            }
            return { blocks: null, datasets: [], pageItems: parsed };
        }
        if (parsed && typeof parsed === 'object') {
            const datasets = Array.isArray(parsed.datasets)
                ? parsed.datasets.filter(function(d) { return d && typeof d === 'object'; })
                : [];
            const blocks = Array.isArray(parsed.page_payload)
                ? parsed.page_payload
                : (Array.isArray(parsed.blocks)
                    ? parsed.blocks
                    : (Array.isArray(parsed.metadata?.blocks) ? parsed.metadata.blocks : null));
            const pageItems = Array.isArray(parsed.items) ? parsed.items : null;
            return { blocks, datasets, pageItems };
        }
        return { blocks: null, datasets: [], pageItems: null };
    }
    window.parsePageContractImportPayload = parsePageContractImportInput;

    function normalizeDatasetEntry(dsEntry, idx) {
        const schemaObj = (dsEntry && dsEntry.schema && typeof dsEntry.schema === 'object') ? dsEntry.schema : (dsEntry || {});
        const schemaSlug = String(schemaObj.slug || dsEntry?.schema_slug || dsEntry?.collection_slug || '').trim().toLowerCase();
        const colSlug = String(dsEntry?.collection_slug || dsEntry?.collectionSlug || schemaSlug).trim().toLowerCase();
        const name = String(schemaObj.name || schemaObj.title || dsEntry?.name || colSlug || schemaSlug).trim();
        const summary = String(schemaObj.description || schemaObj.summary || dsEntry?.description || '').trim();
        const fields = Array.isArray(schemaObj.fields) ? schemaObj.fields : [];
        const items = Array.isArray(dsEntry?.items) ? dsEntry.items : [];
        return {
            index: idx,
            schemaSlug: schemaSlug,
            collectionSlug: colSlug,
            name: name || colSlug || schemaSlug,
            summary: summary,
            apiOnly: Boolean(schemaObj.api_only),
            fields: fields,
            items: items
        };
    }

    function collectDatasetRefsFromValue(val, outSet) {
        if (!val) return;
        if (typeof val === 'string') {
            const re = /@api:dataset:collection=([a-zA-Z0-9_-]+)/gi;
            let m;
            while ((m = re.exec(val)) !== null) {
                if (m[1]) outSet.add(m[1].toLowerCase());
            }
            return;
        }
        if (Array.isArray(val)) {
            val.forEach(function(item) { collectDatasetRefsFromValue(item, outSet); });
            return;
        }
        if (typeof val === 'object') {
            Object.keys(val).forEach(function(k) { collectDatasetRefsFromValue(val[k], outSet); });
        }
    }

    function getSchemaFieldKeySet(schemaObj) {
        const set = new Set();
        const fields = Array.isArray(schemaObj?.fields) ? schemaObj.fields : [];
        fields.forEach(function(f) {
            const k = f && String(f.key || f.name || '').trim();
            if (k) set.add(k);
        });
        return set;
    }

    function refreshDatasetsPreview() {
        const box = document.getElementById('page-contract-datasets-box');
        const summaryEl = document.getElementById('page-contract-datasets-summary');
        const listEl = document.getElementById('page-contract-datasets-list');
        const chkEl = document.getElementById('page-contract-import-datasets');
        const ghostBox = document.getElementById('page-contract-ghost-datasets-warning');
        const ghostText = document.getElementById('page-contract-ghost-datasets-text');
        const textArea = document.getElementById('page-contract-import-textarea');
        if (!box && !ghostBox) return;

        const datasetsData = readJsonScript('page-datasets-data', {});
        const knownColSlugs = new Set((datasetsData.collections || []).map(function(c) { return String(c?.slug || '').toLowerCase(); }).filter(Boolean));
        const knownSchemaMap = new Map();
        (datasetsData.schemas || []).forEach(function(s) {
            if (s && s.slug) knownSchemaMap.set(String(s.slug).toLowerCase(), s);
        });
        const knownColMap = new Map();
        (datasetsData.collections || []).forEach(function(c) {
            if (c && c.slug) knownColMap.set(String(c.slug).toLowerCase(), c);
        });

        const raw = (textArea && textArea.value || '').trim();
        let bundle = { blocks: null, datasets: [], pageItems: null };
        if (raw) {
            try {
                bundle = parsePageContractImportInput(JSON.parse(raw));
            } catch {}
        }
        const datasets = bundle.datasets || [];

        const bundledSlugs = new Set();
        datasets.forEach(function(d, idx) {
            const norm = normalizeDatasetEntry(d, idx);
            if (norm.collectionSlug) bundledSlugs.add(norm.collectionSlug);
            if (norm.schemaSlug) bundledSlugs.add(norm.schemaSlug);
        });

        if (ghostBox && ghostText) {
            const referencedSlugs = new Set();
            if (Array.isArray(bundle.blocks)) collectDatasetRefsFromValue(bundle.blocks, referencedSlugs);
            if (Array.isArray(bundle.pageItems)) collectDatasetRefsFromValue(bundle.pageItems, referencedSlugs);
            const missingSlugs = Array.from(referencedSlugs).filter(function(slug) {
                return !knownColSlugs.has(slug) && !knownSchemaMap.has(slug) && !bundledSlugs.has(slug);
            });
            if (missingSlugs.length > 0) {
                ghostText.textContent = t('pages.import_ghost_datasets_warning', { slugs: missingSlugs.join(', ') });
                ghostBox.classList.remove('hidden');
            } else {
                ghostText.textContent = '';
                ghostBox.classList.add('hidden');
            }
        }

        if (!box) return;
        if (!datasets.length) {
            box.classList.add('hidden');
            if (summaryEl) summaryEl.textContent = '';
            if (listEl) listEl.innerHTML = '';
            return;
        }

        const totalItems = datasets.reduce(function(acc, d) {
            return acc + (Array.isArray(d.items) ? d.items.length : 0);
        }, 0);
        if (summaryEl) {
            summaryEl.textContent = t('pages.import_datasets_detected', { collections: datasets.length, items: totalItems });
        }
        if (listEl) {
            listEl.innerHTML = datasets.map(function(d, idx) {
                const norm = normalizeDatasetEntry(d, idx);
                const slugLabel = norm.collectionSlug || norm.schemaSlug || ('dataset-' + (idx + 1));
                const existingCol = knownColMap.get(norm.collectionSlug);
                const existingSchema = knownSchemaMap.get(norm.schemaSlug) || (existingCol && knownSchemaMap.get(String(existingCol.schema_key || '').toLowerCase()));
                const isExisting = Boolean(existingCol || existingSchema);
                const existingKeySet = existingSchema ? getSchemaFieldKeySet(existingSchema) : (existingCol ? getSchemaFieldKeySet(existingCol) : new Set());
                const newFieldsCount = norm.fields.filter(function(f) {
                    const k = f && String(f.key || f.name || '').trim();
                    return k && !existingKeySet.has(k);
                }).length;

                const badgeText = !isExisting
                    ? t('pages.import_dataset_badge_new')
                    : (newFieldsCount > 0
                        ? t('pages.import_dataset_badge_update', { fields: newFieldsCount })
                        : t('pages.import_dataset_badge_append_only'));
                const badgeCls = !isExisting
                    ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                    : 'bg-sky-500/15 text-sky-600 dark:text-sky-400';
                const itemCountText = t('pages.import_datasets_item_count', { count: norm.items.length });
                return '<span class="inline-flex items-center space-x-1.5 px-2 py-0.5 rounded-md bg-[var(--admin-surface)] border border-[var(--admin-border)] text-[11px] font-mono text-[var(--admin-text)]">' +
                    '<span class="px-1.5 py-0 rounded text-[10px] font-sans font-bold ' + badgeCls + '">[' + escapeHtml(badgeText) + ']</span>' +
                    '<span>' + escapeHtml(slugLabel) + '</span>' +
                    '<span class="text-[var(--admin-text-muted)]">(+' + escapeHtml(itemCountText) + ')</span>' +
                    '</span>';
            }).join('');
        }
        if (chkEl) chkEl.checked = true;
        box.classList.remove('hidden');
    }
    window.previewPageContractDatasets = refreshDatasetsPreview;

    async function importBundledDatasets(rawDatasets) {
        const datasetsData = readJsonScript('page-datasets-data', {});
        const knownSchemaMap = new Map();
        (datasetsData.schemas || []).forEach(function(s) {
            if (s && s.slug) knownSchemaMap.set(String(s.slug).toLowerCase(), s);
        });
        const knownCollections = new Map();
        (datasetsData.collections || []).forEach(function(c) {
            if (c && c.slug) knownCollections.set(String(c.slug).toLowerCase(), c);
        });

        const validateFields = function(slugLabel, fields) {
            for (let fIdx = 0; fIdx < fields.length; fIdx++) {
                const f = fields[fIdx];
                const fKey = f && String(f.key || f.name || '').trim();
                const fType = f && String(f.type || 'text').trim();
                if (!fKey || !ALLOWED_SCHEMA_FIELD_TYPES.has(fType)) {
                    throw new Error(t('pages.import_dataset_failed', {
                        slug: slugLabel,
                        error: 'Invalid schema field key or type (' + (fKey || fIdx) + ':' + fType + ')'
                    }));
                }
            }
        };

        const normalized = rawDatasets.map(normalizeDatasetEntry);
        for (let i = 0; i < normalized.length; i++) {
            const ds = normalized[i];
            if (!ds.schemaSlug || !/^[a-z0-9][a-z0-9_-]*$/.test(ds.schemaSlug)) {
                throw new Error(t('pages.import_dataset_failed', {
                    slug: ds.schemaSlug || ('#' + (i + 1)),
                    error: 'Invalid or missing schema slug'
                }));
            }
            const existingSchema = knownSchemaMap.get(ds.schemaSlug);
            if (!existingSchema) {
                if (!Array.isArray(ds.fields) || ds.fields.length === 0) {
                    throw new Error(t('pages.import_dataset_failed', {
                        slug: ds.schemaSlug,
                        error: 'New dataset schema requires non-empty fields[]'
                    }));
                }
                validateFields(ds.schemaSlug, ds.fields);
            } else if (Array.isArray(ds.fields) && ds.fields.length > 0) {
                const existingKeySet = getSchemaFieldKeySet(existingSchema);
                const extraFields = ds.fields.filter(function(f) {
                    const k = f && String(f.key || f.name || '').trim();
                    return k && !existingKeySet.has(k);
                });
                if (extraFields.length > 0) validateFields(ds.schemaSlug, extraFields);
            }
        }

        let created = 0;
        let reused = 0;
        let importedItems = 0;

        for (let i = 0; i < normalized.length; i++) {
            const ds = normalized[i];
            try {
                let existingSchema = knownSchemaMap.get(ds.schemaSlug);
                if (!existingSchema) {
                    const schemaRes = await fetch('/admin/schemas/api/create', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            title: ds.name,
                            slug: ds.schemaSlug,
                            summary: ds.summary,
                            fields: ds.fields,
                            api_only: ds.apiOnly
                        })
                    });
                    const schemaJson = await schemaRes.json();
                    if (!schemaRes.ok || !schemaJson.success) {
                        throw new Error(schemaJson.error || 'Schema create failed');
                    }
                    existingSchema = { slug: ds.schemaSlug, title: ds.name, is_custom: true, fields: ds.fields };
                    knownSchemaMap.set(ds.schemaSlug, existingSchema);
                    if (Array.isArray(datasetsData.schemas)) {
                        datasetsData.schemas.push(existingSchema);
                    }
                } else if (Array.isArray(ds.fields) && ds.fields.length > 0) {
                    const existingKeySet = getSchemaFieldKeySet(existingSchema);
                    const newFields = ds.fields.filter(function(f) {
                        const k = f && String(f.key || f.name || '').trim();
                        return k && !existingKeySet.has(k);
                    });
                    if (newFields.length > 0) {
                        const appendRes = await fetch('/admin/schemas/api/append-fields', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ slug: ds.schemaSlug, fields: newFields })
                        });
                        const appendJson = await appendRes.json();
                        if (!appendRes.ok || !appendJson.success) {
                            throw new Error(appendJson.error || 'Schema field append failed');
                        }
                        if (Array.isArray(appendJson.fields)) {
                            existingSchema.fields = appendJson.fields;
                        }
                    }
                }

                let targetCol = knownCollections.get(ds.collectionSlug);
                if (targetCol) {
                    reused++;
                } else {
                    const colRes = await fetch('/admin/datasets/api/collections/create', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            name: ds.name,
                            slug: ds.collectionSlug,
                            schema_key: ds.schemaSlug,
                            description: ds.summary
                        })
                    });
                    const colJson = await colRes.json();
                    if (colRes.ok && colJson.success && colJson.data) {
                        targetCol = colJson.data;
                        knownCollections.set(ds.collectionSlug, targetCol);
                        if (Array.isArray(datasetsData.collections)) {
                            datasetsData.collections.push(targetCol);
                        }
                        created++;
                    } else if (String(colJson?.error || '').includes('DATASET_COLLECTION_SLUG_EXISTS')) {
                        reused++;
                        targetCol = { slug: ds.collectionSlug, schema_key: ds.schemaSlug };
                        knownCollections.set(ds.collectionSlug, targetCol);
                    } else {
                        throw new Error(colJson?.error || 'Collection create failed');
                    }
                }

                for (let offset = 0; offset < ds.items.length; offset += 15) {
                    const batch = ds.items.slice(offset, offset + 15);
                    const batchRes = await fetch('/admin/datasets/api/batch-import', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            ...(targetCol?.id ? { collection_id: targetCol.id } : {}),
                            schema_slug: ds.collectionSlug,
                            on_conflict: 'skip',
                            items: batch
                        })
                    });
                    const batchJson = await batchRes.json();
                    if (!batchRes.ok || !batchJson.success) {
                        throw new Error(batchJson?.error || 'Batch import failed');
                    }
                    importedItems += Number(batchJson.count || 0);
                }
            } catch (err) {
                throw new Error(t('pages.import_dataset_failed', {
                    slug: ds.collectionSlug || ds.schemaSlug,
                    error: err?.message || t('common.error')
                }));
            }
        }

        const datasetsScriptEl = document.getElementById('page-datasets-data');
        if (datasetsScriptEl) {
            try { datasetsScriptEl.textContent = JSON.stringify(datasetsData); } catch {}
        }

        return { created: created, reused: reused, importedItems: importedItems };
    }

    window.openPageContractModal = function(ctxOverride, initialTab) {
        const modal = document.getElementById('page-contract-modal');
        if (!modal) return;
        const ctxMode = ctxOverride || modal.getAttribute('data-context') || (document.getElementById('page-edit-form') ? 'editor' : 'list');
        modal.setAttribute('data-context', ctxMode);

        const includeEl = document.getElementById('page-contract-include-payload');
        if (includeEl) {
            includeEl.checked = ctxMode === 'editor';
            if (!includeEl._contractBound) {
                includeEl._contractBound = true;
                includeEl.addEventListener('change', syncExportPreview);
            }
        }
        const metaRow = document.getElementById('page-contract-import-meta');
        if (metaRow) metaRow.classList.toggle('hidden', ctxMode !== 'list');

        const fileInput = document.getElementById('page-contract-import-file');
        const textArea = document.getElementById('page-contract-import-textarea');
        const feedback = document.getElementById('page-contract-import-feedback');
        if (fileInput && !fileInput._contractBound) {
            fileInput._contractBound = true;
            if (window.walnutReadFileInput) {
                window.walnutReadFileInput(fileInput, function(content) {
                    if (textArea) textArea.value = content;
                    refreshDatasetsPreview();
                });
            }
        }
        if (textArea && !textArea._contractBound) {
            textArea._contractBound = true;
            textArea.addEventListener('input', refreshDatasetsPreview);
        }
        if (feedback) feedback.textContent = '';

        refreshDatasetsPreview();
        populateTargetModeSelect(ctxMode);
        window.switchPageContractTab(initialTab || 'export');
        modal.classList.remove('hidden');
    };

    window.closePageContractModal = function() {
        const modal = document.getElementById('page-contract-modal');
        if (modal) modal.classList.add('hidden');
    };

    function getOccupiedSlotsForImport(templates, parsedObj) {
        const modal = document.getElementById('page-contract-modal');
        const ctxMode = modal?.getAttribute('data-context') || 'editor';
        const modeSelect = document.getElementById('page-contract-target-mode');
        const selectedMode = modeSelect ? modeSelect.value : '';

        if (selectedMode.startsWith('tpl:')) {
            const tpl = templates.find(function(tp) { return tp.id === selectedMode.slice(4); });
            if (tpl) return tpl.occupied_slots.length > 0 ? tpl.occupied_slots : ['header', 'footer'];
        }
        if (ctxMode === 'editor') {
            const pType = document.getElementById('form-page-type')?.value || 'single';
            const tplId = document.getElementById('form-template-page-id')?.value || '';
            if (pType === 'single' && tplId) {
                const tpl = templates.find(function(tp) { return tp.id === tplId || tp.slug === tplId; });
                return (tpl && tpl.occupied_slots.length > 0) ? tpl.occupied_slots : ['header', 'footer'];
            }
        } else if (parsedObj && typeof parsedObj === 'object') {
            const tplRef = parsedObj.template_id || parsedObj.metadata?.template_id || parsedObj.metadata?.template_page_id || parsedObj.current_page?.template_id;
            if (tplRef) {
                const tpl = templates.find(function(tp) { return tp.id === tplRef || tp.slug === tplRef; });
                return (tpl && tpl.occupied_slots.length > 0) ? tpl.occupied_slots : ['header', 'footer'];
            }
        }
        return [];
    }

    window.submitPageContractImport = async function() {
        const modal = document.getElementById('page-contract-modal');
        const textArea = document.getElementById('page-contract-import-textarea');
        const filterChk = document.getElementById('page-contract-filter-chrome');
        const datasetsChk = document.getElementById('page-contract-import-datasets');
        const feedback = document.getElementById('page-contract-import-feedback');
        const rawText = (textArea && textArea.value || '').trim();
        if (feedback) feedback.textContent = '';
        if (!rawText) {
            if (feedback) feedback.innerHTML = '<span class="text-red-500">' + escapeHtml(t('pages.import_empty_error')) + '</span>';
            return;
        }
        let parsed;
        try {
            parsed = JSON.parse(rawText);
        } catch {
            if (feedback) feedback.innerHTML = '<span class="text-red-500">' + escapeHtml(t('pages.import_invalid_json')) + '</span>';
            return;
        }

        const bundle = parsePageContractImportInput(parsed);
        const templates = readTemplatesList();
        const shouldFilter = Boolean(!filterChk || filterChk.checked);
        const shouldImportDatasets = Boolean(bundle.datasets.length > 0 && (!datasetsChk || datasetsChk.checked));
        const ctxMode = modal?.getAttribute('data-context') || 'editor';

        const applyFilterIfNeeded = function(blocks, objMeta) {
            if (!shouldFilter) return { blocks: blocks, removedCount: 0 };
            const occupied = getOccupiedSlotsForImport(templates, objMeta);
            if (!occupied.length) return { blocks: blocks, removedCount: 0 };
            return window.filterConflictingChromeBlocks(blocks, occupied);
        };

        if (ctxMode === 'editor') {
            if (!Array.isArray(bundle.blocks)) {
                if (feedback) feedback.innerHTML = '<span class="text-red-500">' + escapeHtml(t('pages.import_invalid_blocks')) + '</span>';
                return;
            }
            let dsStats = null;
            if (shouldImportDatasets) {
                try {
                    dsStats = await importBundledDatasets(bundle.datasets);
                } catch (err) {
                    if (feedback) feedback.innerHTML = '<span class="text-red-500">' + escapeHtml(err?.message || t('common.error')) + '</span>';
                    return;
                }
            }
            const res = applyFilterIfNeeded(bundle.blocks, parsed);
            if (typeof window.__walnutSetPageEditorBlocks === 'function') {
                window.__walnutSetPageEditorBlocks(res.blocks);
            }
            window.closePageContractModal();
            if (window.showToast) {
                const msg = dsStats
                    ? t('pages.import_joint_success', {
                        created: dsStats.created,
                        reused: dsStats.reused,
                        items: dsStats.importedItems,
                        blocks: res.blocks.length
                    })
                    : (res.removedCount > 0
                        ? t('pages.import_applied_filtered', { count: res.blocks.length, removed: res.removedCount })
                        : t('pages.import_applied', { count: res.blocks.length }));
                window.showToast(msg, 'success');
            }
            return;
        }

        const titleIn = document.getElementById('page-contract-import-title')?.value?.trim() || '';
        const slugIn = document.getElementById('page-contract-import-slug')?.value?.trim() || '';
        const modeVal = document.getElementById('page-contract-target-mode')?.value || 'unspecified';
        const tplIdFromSelect = modeVal.startsWith('tpl:') ? modeVal.slice(4) : '';
        let itemsToImport = [];

        if (Array.isArray(bundle.blocks)) {
            const res = applyFilterIfNeeded(bundle.blocks, parsed);
            const objMeta = (!Array.isArray(parsed) && parsed && typeof parsed === 'object') ? parsed : {};
            const s = String(objMeta.slug || slugIn || ('page-' + Date.now().toString(36))).trim();
            const tl = String(objMeta.title || titleIn || s).trim();
            const mergedMeta = Object.assign({}, objMeta.metadata || {}, {
                page_type: objMeta.page_type || objMeta.metadata?.page_type || (modeVal === 'template' ? 'template' : 'single'),
                ...(tplIdFromSelect && !objMeta.metadata?.template_id ? { template_id: tplIdFromSelect, template_page_id: tplIdFromSelect } : {}),
                blocks: res.blocks
            });
            itemsToImport = [{
                title: tl,
                slug: s,
                page_type: mergedMeta.page_type,
                content_raw: JSON.stringify(res.blocks),
                metadata: mergedMeta
            }];
        } else if (Array.isArray(bundle.pageItems) && bundle.pageItems.length > 0) {
            itemsToImport = bundle.pageItems.map(function(it, idx) {
                const blks = Array.isArray(it?.page_payload)
                    ? it.page_payload
                    : (Array.isArray(it?.blocks) ? it.blocks : (Array.isArray(it?.metadata?.blocks) ? it.metadata.blocks : []));
                const res = applyFilterIfNeeded(blks, it);
                const s = String(it?.slug || (idx === 0 ? slugIn : '') || ('page-' + Date.now().toString(36) + '-' + idx)).trim();
                const tl = String(it?.title || (idx === 0 ? titleIn : '') || s).trim();
                const mergedMeta = Object.assign({}, it?.metadata || {}, {
                    page_type: it?.page_type || it?.metadata?.page_type || (modeVal === 'template' ? 'template' : 'single'),
                    ...(tplIdFromSelect && !it?.metadata?.template_id ? { template_id: tplIdFromSelect, template_page_id: tplIdFromSelect } : {}),
                    blocks: res.blocks
                });
                const cleanItem = Object.assign({}, it, {
                    title: tl,
                    slug: s,
                    content_raw: JSON.stringify(res.blocks),
                    metadata: mergedMeta
                });
                delete cleanItem.datasets;
                return cleanItem;
            });
        } else {
            if (feedback) feedback.innerHTML = '<span class="text-red-500">' + escapeHtml(t('pages.import_invalid_blocks')) + '</span>';
            return;
        }

        let dsStats = null;
        if (shouldImportDatasets) {
            try {
                dsStats = await importBundledDatasets(bundle.datasets);
            } catch (err) {
                if (feedback) feedback.innerHTML = '<span class="text-red-500">' + escapeHtml(err?.message || t('common.error')) + '</span>';
                return;
            }
        }

        try {
            const res = await fetch('/admin/pages/api/batch-import', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ items: itemsToImport, conflict_strategy: 'upsert' })
            });
            const data = await res.json();
            if (!res.ok || !data.success) {
                if (feedback) feedback.innerHTML = '<span class="text-red-500">' + escapeHtml(data.error || t('common.error')) + '</span>';
                return;
            }
            window.closePageContractModal();
            if (window.showToast) {
                const pageCount = data.count || itemsToImport.length;
                const msg = dsStats
                    ? t('pages.import_joint_list_success', {
                        created: dsStats.created,
                        reused: dsStats.reused,
                        items: dsStats.importedItems,
                        pages: pageCount
                    })
                    : t('pages.import_page_success', { count: pageCount });
                window.showToast(msg, 'success');
            }
            setTimeout(function() { window.location.reload(); }, 400);
        } catch {
            if (feedback) feedback.innerHTML = '<span class="text-red-500">' + escapeHtml(t('common.network_error')) + '</span>';
        }
    };
})();
