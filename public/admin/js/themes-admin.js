(function() {
    'use strict';

    const t = function(k, params) {
        const fn = window.__EDGE_I18N__ && window.__EDGE_I18N__.t;
        return typeof fn === 'function' ? fn(k, params) : k;
    };

    window.switchThemeSubTab = function(tabId) {
        if (!tabId) return;
        ['tab-themes', 'tab-templates', 'tab-components', 'tab-md-components', 'tab-dataset-schemas', 'tab-themes-trash'].forEach(function(id) {
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
                if (id === tabId) {
                    btn.className = 'px-4 py-2.5 border-b-2 border-[var(--admin-accent)] text-[var(--admin-text)] transition flex items-center space-x-1.5 cursor-pointer whitespace-nowrap';
                } else {
                    btn.className = 'px-4 py-2.5 border-b-2 border-transparent text-[var(--admin-text-muted)] hover:text-[var(--admin-text)] transition flex items-center space-x-1.5 cursor-pointer whitespace-nowrap';
                }
            }
        });

        if (tabId === 'tab-components' || tabId === 'tab-templates') {
            requestAnimationFrame(function() {
                if (typeof initThemePreviewScalers === 'function') {
                    initThemePreviewScalers();
                }
                if (tabId === 'tab-components') {
                    document.querySelectorAll('.theme-component-viewport iframe').forEach(function(iframe) {
                        if (typeof window.adaptThemeComponentHeight === 'function') {
                            window.adaptThemeComponentHeight(iframe);
                        }
                    });
                }
            });
        }
    };

    async function decompressZipChunk(compData) {
        if (typeof DecompressionStream !== 'undefined') {
            const ds = new DecompressionStream('deflate-raw');
            const writer = ds.writable.getWriter();
            writer.write(compData);
            writer.close();
            const reader = ds.readable.getReader();
            const chunks = [];
            let total = 0;
            while (true) {
                const res = await reader.read();
                if (res.done) break;
                chunks.push(res.value);
                total += res.value.length;
            }
            const output = new Uint8Array(total);
            let offset = 0;
            for (let i = 0; i < chunks.length; i++) {
                output.set(chunks[i], offset);
                offset += chunks[i].length;
            }
            return output;
        }
        throw new Error(t('themes.err_no_decompression_stream'));
    }

    function stripSingleZipRootFolder(filesMap) {
        const keys = Object.keys(filesMap).filter(function(k) { return k && !k.includes('__MACOSX/'); });
        if (keys.length === 0 || filesMap['manifest.json']) return filesMap;
        const firstSlash = keys[0].indexOf('/');
        if (firstSlash <= 0) return filesMap;
        const prefix = keys[0].slice(0, firstSlash + 1);
        const allSharePrefix = keys.every(function(k) { return k.startsWith(prefix); });
        if (!allSharePrefix || !filesMap[prefix + 'manifest.json']) return filesMap;
        const stripped = {};
        keys.forEach(function(k) {
            const rel = k.slice(prefix.length);
            if (rel) stripped[rel] = filesMap[k];
        });
        return stripped;
    }

    async function parseZipInBrowser(arrayBuffer) {
        const view = new DataView(arrayBuffer);
        const bytes = new Uint8Array(arrayBuffer);
        const files = {};
        const len = bytes.byteLength;

        // Prefer Central Directory so macOS/streaming ZIPs with Bit-3 Data Descriptor (local compSize=0) inflate reliably.
        let eocdOffset = -1;
        const minEocd = Math.max(0, len - 65557);
        for (let i = len - 22; i >= minEocd; i--) {
            if (view.getUint32(i, true) === 0x06054b50) {
                eocdOffset = i;
                break;
            }
        }

        if (eocdOffset >= 0) {
            const totalEntries = view.getUint16(eocdOffset + 10, true);
            let cdOffset = view.getUint32(eocdOffset + 16, true);
            for (let idx = 0; idx < totalEntries && cdOffset + 46 <= len; idx++) {
                if (view.getUint32(cdOffset, true) !== 0x02014b50) break;
                const method = view.getUint16(cdOffset + 10, true);
                const compSize = view.getUint32(cdOffset + 20, true);
                const nameLen = view.getUint16(cdOffset + 28, true);
                const extraLen = view.getUint16(cdOffset + 30, true);
                const commentLen = view.getUint16(cdOffset + 32, true);
                const localOffset = view.getUint32(cdOffset + 42, true);
                const fileName = new TextDecoder('utf-8').decode(bytes.subarray(cdOffset + 46, cdOffset + 46 + nameLen));
                cdOffset += 46 + nameLen + extraLen + commentLen;

                if (!fileName || fileName.endsWith('/') || fileName.includes('__MACOSX/')) continue;
                if (localOffset + 30 > len || view.getUint32(localOffset, true) !== 0x04034b50) continue;
                const lNameLen = view.getUint16(localOffset + 26, true);
                const lExtraLen = view.getUint16(localOffset + 28, true);
                const dataOffset = localOffset + 30 + lNameLen + lExtraLen;
                if (dataOffset + compSize > len) continue;

                const compData = bytes.subarray(dataOffset, dataOffset + compSize);
                if (method === 0) {
                    files[fileName] = compData;
                } else if (method === 8) {
                    files[fileName] = await decompressZipChunk(compData);
                }
            }
            return stripSingleZipRootFolder(files);
        }

        let offset = 0;
        while (offset < len - 4) {
            const sig = view.getUint32(offset, true);
            if (sig === 0x04034b50) {
                const method = view.getUint16(offset + 8, true);
                const compSize = view.getUint32(offset + 18, true);
                const nameLen = view.getUint16(offset + 26, true);
                const extraLen = view.getUint16(offset + 28, true);

                const nameBytes = bytes.subarray(offset + 30, offset + 30 + nameLen);
                const fileName = new TextDecoder('utf-8').decode(nameBytes);
                const dataOffset = offset + 30 + nameLen + extraLen;

                if (!fileName.endsWith('/') && !fileName.includes('__MACOSX/')) {
                    const compData = bytes.subarray(dataOffset, dataOffset + compSize);
                    let fileData = null;
                    if (method === 0) {
                        fileData = compData;
                    } else if (method === 8) {
                        fileData = await decompressZipChunk(compData);
                    }
                    if (fileData) {
                        files[fileName] = fileData;
                    }
                }
                offset = dataOffset + compSize;
            } else if (sig === 0x02014b50 || sig === 0x06054b50) {
                break;
            } else {
                offset++;
            }
        }
        return stripSingleZipRootFolder(files);
    }

    function uint8ArrayToBase64(uint8) {
        let binary = '';
        const len = uint8.byteLength;
        for (let i = 0; i < len; i++) {
            binary += String.fromCharCode(uint8[i]);
        }
        return window.btoa(binary);
    }

    window.handleThemeImportSubmit = async function(event) {
        event.preventDefault();
        const fileInput = document.getElementById('theme-file-input');
        const jsonInput = document.getElementById('theme-json-input');
        const progressBox = document.getElementById('theme-import-progress-box');
        const statusLabel = document.getElementById('theme-import-status');
        const percentLabel = document.getElementById('theme-import-percent');
        const progressBar = document.getElementById('theme-import-bar');
        const msgBox = document.getElementById('import-theme-msg');
        const submitBtn = document.getElementById('theme-import-btn');

        const updateProgress = function (percent, status) {
            if (progressBox) progressBox.classList.remove('hidden');
            if (percentLabel) percentLabel.innerText = percent + '%';
            if (progressBar) progressBar.style.width = percent + '%';
            if (statusLabel) statusLabel.innerText = status;
        };

        const file = fileInput && fileInput.files && fileInput.files[0];
        const isZip = file && (file.name.endsWith('.zip') || file.type.includes('zip'));

        if (!file && !jsonInput?.value?.trim()) {
            if (msgBox) {
                msgBox.innerHTML = '<span class="text-amber-500 font-bold">' + t('themes.import_no_file') + '</span>';
                msgBox.classList.remove('hidden');
            }
            return;
        }

        if (submitBtn) submitBtn.disabled = true;
        if (msgBox) msgBox.classList.add('hidden');

        try {
            if (isZip) {
                updateProgress(5, t('themes.import_reading_zip'));
                const arrayBuffer = await file.arrayBuffer();
                updateProgress(15, t('themes.import_extracting_zip'));
                const unzippedFiles = await parseZipInBrowser(arrayBuffer);

                let manifestContent = null;
                for (const path in unzippedFiles) {
                    if (path.toLowerCase().endsWith('manifest.json') && !path.includes('__MACOSX')) {
                        manifestContent = new TextDecoder('utf-8').decode(unzippedFiles[path]);
                        break;
                    }
                }
                if (!manifestContent) {
                    throw new Error(t('themes.import_no_manifest'));
                }

                let manifestObj = {};
                try {
                    manifestObj = JSON.parse(manifestContent);
                } catch(e) {
                    throw new Error(t('themes.import_invalid_manifest'));
                }

                updateProgress(25, t('themes.import_status_validating'));
                let tokensObj = {};
                for (const path in unzippedFiles) {
                    if (path.toLowerCase().endsWith('tokens.json') && !path.includes('__MACOSX')) {
                        try {
                            tokensObj = JSON.parse(new TextDecoder('utf-8').decode(unzippedFiles[path]));
                        } catch(e) {}
                        break;
                    }
                }

                for (const p in unzippedFiles) {
                    if (p.includes('__MACOSX')) continue;
                    if ((manifestObj.layout_file && p.endsWith(manifestObj.layout_file)) ||
                        (manifestObj.skeleton_file && p.endsWith(manifestObj.skeleton_file)) ||
                        (!manifestObj.layout_html && p.match(/templates\/(?:layout|base|skeleton)\.html$/i))) {
                        manifestObj.layout_html = new TextDecoder('utf-8').decode(unzippedFiles[p]);
                    }
                }

                const initRes = await fetch('/admin/themes/api/chunk/init', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ manifest: manifestObj, tokens: tokensObj })
                });
                const initData = await initRes.json();
                if (!initRes.ok || !initData.success) {
                    throw new Error(initData.error || t('themes.import_session_failed'));
                }

                const themeId = initData.themeId || manifestObj.id;

                const components = [];
                const manifestComps = manifestObj.components || manifestObj.componentNodes || [];
                for (const p in unzippedFiles) {
                    if (p.includes('__MACOSX')) continue;
                    const match = p.match(/(?:blocks|components)\/([^/]+)\.html$/i);
                    if (match) {
                        const compSlug = match[1];
                        const html = new TextDecoder('utf-8').decode(unzippedFiles[p]);
                        const existing = manifestComps.find(function(c) { return c.slug === compSlug || c.type === compSlug || (c.template_path && c.template_path.endsWith(match[0])); });
                        if (existing) {
                            components.push(Object.assign({}, existing, { template_html: html, slug: existing.slug || compSlug }));
                        } else {
                            components.push({
                                slug: compSlug,
                                name: compSlug,
                                template_html: html
                            });
                        }
                    }
                }

                const templates = [];
                const manifestTemplates = manifestObj.templates || manifestObj.templateNodes || [];
                const layoutPathNorm = (manifestObj.layout_file || manifestObj.skeleton_file || '').replace(/^\/+/, '').toLowerCase();
                for (const p in unzippedFiles) {
                    if (p.includes('__MACOSX')) continue;
                    if (layoutPathNorm && p.toLowerCase() === layoutPathNorm) continue;
                    const match = p.match(/templates\/([^/]+)\.html$/i);
                    if (match) {
                        const tplSlug = match[1];
                        if (/^(?:layout|base|skeleton)$/i.test(tplSlug)) continue;
                        const html = new TextDecoder('utf-8').decode(unzippedFiles[p]);
                        const existing = manifestTemplates.find(function(t) { return t.slug === tplSlug || t.key === tplSlug; });
                        if (existing) {
                            templates.push(Object.assign({}, existing, { layout_html: html, slug: existing.slug || tplSlug }));
                        } else {
                            templates.push({
                                slug: tplSlug,
                                title: tplSlug,
                                layout_html: html
                            });
                        }
                    }
                }

                const schemas = [];
                for (const p in unzippedFiles) {
                    if (p.includes('__MACOSX')) continue;
                    if (p.startsWith('schemas/') && p.endsWith('.json')) {
                        try {
                            const schemaJson = JSON.parse(new TextDecoder('utf-8').decode(unzippedFiles[p]));
                            schemas.push(schemaJson);
                        } catch(e) {}
                    }
                }

                if (components.length > 0 || templates.length > 0 || schemas.length > 0) {
                    updateProgress(45, t('themes.import_status_assembling'));
                    const blocksRes = await fetch('/admin/themes/api/chunk/blocks', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            theme_id: themeId,
                            components: components,
                            templates: templates,
                            schemas: schemas
                        })
                    });
                    const blocksData = await blocksRes.json();
                    if (!blocksRes.ok || !blocksData.success) {
                        throw new Error(blocksData.error || t('themes.import_chunk_failed'));
                    }
                }

                // Only upload static assets under assets/** to R2; HTML templates and JSON schemas are stored in D1.
                const assetPaths = Object.keys(unzippedFiles).filter(function(p) {
                    return !p.includes('__MACOSX') && !p.endsWith('/') && p.startsWith('assets/') && !p.endsWith('.html') && !p.endsWith('.json');
                });
                const totalAssets = assetPaths.length;

                for (let i = 0; i < totalAssets; i++) {
                    const p = assetPaths[i];
                    const assetRes = await fetch('/admin/themes/api/chunk/asset', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            theme_id: themeId,
                            file_path: p,
                            content: uint8ArrayToBase64(unzippedFiles[p]),
                            is_base64: true
                        })
                    });
                    const assetData = await assetRes.json();
                    if (!assetRes.ok || !assetData.success) {
                        throw new Error(assetData.error || t('themes.import_chunk_failed'));
                    }
                    const pct = Math.floor(50 + (((i + 1) / totalAssets) * 40));
                    updateProgress(pct, t('themes.import_status_uploading_assets', { current: i + 1, total: totalAssets }));
                }

                updateProgress(95, t('themes.import_status_finishing'));
                const compRes = await fetch('/admin/themes/api/chunk/finish', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ theme_id: themeId, activate: true })
                });
                const compData = await compRes.json();
                if (!compRes.ok || !compData.success) {
                    throw new Error(compData.error || t('themes.import_compile_failed'));
                }

                updateProgress(100, t('themes.import_status_done'));
                try { sessionStorage.setItem('edge_theme_activated_check', '1'); } catch {}
                if (window.showToast) window.showToast(t('themes.import_status_done'), 'success');
                setTimeout(function() { window.location.reload(); }, 600);
            } else {
                updateProgress(20, t('themes.import_submitting'));
                const fd = new FormData();
                if (file) fd.append('file', file);
                if (jsonInput?.value?.trim()) fd.append('json', jsonInput.value.trim());

                const res = await fetch('/admin/themes/api/import', {
                    method: 'POST',
                    body: fd
                });
                const data = await res.json();
                if (data.success) {
                    updateProgress(100, t('themes.import_success'));
                    if (window.showToast) window.showToast(t('themes.import_success'), 'success');
                    setTimeout(function() { window.location.reload(); }, 600);
                } else {
                    throw new Error(data.error || t('themes.import_failed'));
                }
            }
        } catch (err) {
            console.error('[ThemeImport]', err);
            if (msgBox) {
                msgBox.innerHTML = '<span class="text-red-500 font-bold">' + err.message + '</span>';
                msgBox.classList.remove('hidden');
            }
            if (progressBox) progressBox.classList.add('hidden');
        } finally {
            if (submitBtn) submitBtn.disabled = false;
        }
    };

    window.switchThemeImportMode = function(mode) {
        const zipBtn = document.getElementById('btn-import-mode-zip');
        const repoBtn = document.getElementById('btn-import-mode-repo');
        const zipForm = document.getElementById('theme-import-form');
        const repoForm = document.getElementById('theme-repo-import-form');
        const activeCls = 'px-4 py-2 border-b-2 border-[var(--admin-accent)] text-[var(--admin-text)] cursor-pointer transition flex items-center space-x-1.5';
        const idleCls = 'px-4 py-2 border-b-2 border-transparent text-[var(--admin-text-muted)] hover:text-[var(--admin-text)] cursor-pointer transition flex items-center space-x-1.5';

        if (mode === 'repo') {
            if (zipBtn) zipBtn.className = idleCls;
            if (repoBtn) repoBtn.className = activeCls;
            if (zipForm) zipForm.classList.add('hidden');
            if (repoForm) repoForm.classList.remove('hidden');
        } else {
            if (repoBtn) repoBtn.className = idleCls;
            if (zipBtn) zipBtn.className = activeCls;
            if (repoForm) repoForm.classList.add('hidden');
            if (zipForm) zipForm.classList.remove('hidden');
        }
    };

    window.clearThemeImportFile = function() {
        const input = document.getElementById('theme-file-input');
        const emptyEl = document.getElementById('theme-file-empty');
        const selEl = document.getElementById('theme-file-selected');
        const nameEl = document.getElementById('theme-file-name');
        if (input) input.value = '';
        if (nameEl) nameEl.textContent = '';
        if (selEl) selEl.classList.add('hidden');
        if (emptyEl) emptyEl.classList.remove('hidden');
    };

    function updateThemeDropzoneFile(file) {
        const emptyEl = document.getElementById('theme-file-empty');
        const selEl = document.getElementById('theme-file-selected');
        const nameEl = document.getElementById('theme-file-name');
        if (!file) {
            window.clearThemeImportFile();
            return;
        }
        if (nameEl) nameEl.textContent = file.name;
        if (emptyEl) emptyEl.classList.add('hidden');
        if (selEl) selEl.classList.remove('hidden');
    }

    function initThemeFileDropzone() {
        const dropzone = document.getElementById('theme-file-dropzone');
        const input = document.getElementById('theme-file-input');
        if (!dropzone || !input || dropzone.dataset.bound === '1') return;
        dropzone.dataset.bound = '1';

        dropzone.addEventListener('click', function() {
            input.click();
        });
        input.addEventListener('change', function() {
            updateThemeDropzoneFile(input.files && input.files[0]);
        });
        dropzone.addEventListener('dragover', function(e) {
            e.preventDefault();
            dropzone.classList.add('border-[var(--admin-accent)]', 'bg-[var(--admin-accent-soft)]');
        });
        dropzone.addEventListener('dragleave', function() {
            dropzone.classList.remove('border-[var(--admin-accent)]', 'bg-[var(--admin-accent-soft)]');
        });
        dropzone.addEventListener('drop', function(e) {
            e.preventDefault();
            dropzone.classList.remove('border-[var(--admin-accent)]', 'bg-[var(--admin-accent-soft)]');
            const files = e.dataTransfer && e.dataTransfer.files;
            if (files && files.length > 0) {
                try {
                    const dt = new DataTransfer();
                    dt.items.add(files[0]);
                    input.files = dt.files;
                } catch {}
                updateThemeDropzoneFile(files[0]);
            }
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initThemeFileDropzone);
    } else {
        initThemeFileDropzone();
    }

    window.handleThemeRepoImportSubmit = async function(event) {
        event.preventDefault();
        const repoUrl = (document.getElementById('repo-url-input')?.value || '').trim();
        const token = (document.getElementById('repo-token-input')?.value || '').trim();
        const branch = (document.getElementById('repo-branch-input')?.value || '').trim();
        const btn = document.getElementById('btn-repo-import-submit');
        const msg = document.getElementById('repo-import-msg');

        if (!repoUrl) return;
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<span class="material-symbols-outlined text-[16px] animate-spin">refresh</span><span>' + t('themes.importing_repo') + '</span>';
        }
        if (msg) msg.classList.add('hidden');

        try {
            const res = await fetch('/admin/themes/api/repo-import', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ repoUrl: repoUrl, token: token || undefined, branch: branch || undefined })
            });
            const data = await res.json();
            if (res.ok && data.success) {
                if (window.showToast) window.showToast(t('themes.repo_import_success'), 'success');
                setTimeout(function() { window.location.reload(); }, 600);
            } else {
                if (msg) {
                    msg.innerHTML = '<span class="text-red-500 font-bold">' + (data.error || t('common.error')) + '</span>';
                    msg.classList.remove('hidden');
                }
            }
        } catch (err) {
            console.error('[ThemeRepoImport]', err);
            if (msg) {
                msg.innerHTML = '<span class="text-red-500 font-bold">' + err.message + '</span>';
                msg.classList.remove('hidden');
            }
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = '<span class="material-symbols-outlined text-[16px]">cloud_download</span><span>' + t('themes.btn_start_import') + '</span>';
            }
        }
    };

    window.openThemeVersionsModal = async function(themeId, themeTitle, themeSlug) {
        const modal = document.getElementById('theme-versions-modal');
        const titleEl = document.getElementById('theme-versions-title');
        const subEl = document.getElementById('theme-versions-subtitle');
        const listEl = document.getElementById('theme-versions-list');

        if (!modal) return;
        if (titleEl) titleEl.innerText = themeTitle || themeSlug;
        if (subEl) subEl.innerText = themeSlug;
        if (listEl) listEl.innerHTML = '<div class="text-xs text-stone-400 text-center py-8">' + t('common.loading') + '</div>';

        modal.classList.remove('hidden');

        try {
            const res = await fetch('/admin/themes/api/versions/' + encodeURIComponent(themeId));
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || t('common.error'));

            const versions = data.versions || [];
            const currentTheme = data.theme || {};
            if (versions.length === 0) {
                if (listEl) listEl.innerHTML = '<div class="text-xs text-stone-400 text-center py-8">' + t('themes.no_versions') + '</div>';
                return;
            }

            listEl.innerHTML = versions.map(function(v, i) {
                const isCurrent = (currentTheme.current_version_id === v.id) || (v.version_number === 1 && !currentTheme.current_version_id && i === 0);
                const tag = isCurrent
                    ? '<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-50 text-amber-600 border border-amber-200 dark:bg-amber-950/60 dark:border-amber-800">' + t('themes.version_current') + '</span>'
                    : '<button type="button" onclick="window.rollbackThemeVersion(\'' + themeId + '\', \'' + v.id + '\')" class="text-xs text-[var(--admin-accent-text)] hover:underline font-semibold cursor-pointer">' + t('themes.btn_rollback') + '</button>';

                return '<div class="flex items-center justify-between p-3 rounded-xl border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-800">' +
                    '<div>' +
                    '<div class="flex items-center space-x-2">' +
                    '<span class="font-mono text-xs font-bold text-stone-900 dark:text-white">v' + v.version_number + '</span>' +
                    '<span class="text-xs text-stone-500 font-mono">(' + (v.commit_hash ? v.commit_hash.slice(0, 7) : 'snapshot') + ')</span>' +
                    '</div>' +
                    '<div class="text-[11px] text-stone-400 mt-0.5">' + (v.changelog || v.commit_message || t('themes.no_changelog')) + '</div>' +
                    '<div class="text-[10px] text-stone-400 mt-0.5 font-mono">' + new Date(v.created_at).toLocaleString() + '</div>' +
                    '</div>' +
                    '<div>' + tag + '</div>' +
                    '</div>';
            }).join('');
        } catch (e) {
            if (listEl) listEl.innerHTML = '<div class="text-xs text-red-500 text-center py-8">' + e.message + '</div>';
        }
    };

    window.rollbackThemeVersion = function(themeId, versionId) {
        if (!window.showConfirmDialog) return;
        window.showConfirmDialog({
            title: t('themes.rollback_confirm_title'),
            message: t('themes.rollback_confirm_msg'),
            icon: 'history',
            onConfirm: async function() {
                try {
                    const res = await fetch('/admin/themes/api/rollback/' + encodeURIComponent(themeId), {
                        method: 'POST',
                        body: new URLSearchParams({ version_id: versionId })
                    });
                    const data = await res.json();
                    if (res.ok && data.success) {
                        if (window.showToast) window.showToast(t('themes.rollback_success'), 'success');
                        setTimeout(function() { window.location.reload(); }, 600);
                    } else {
                        if (window.showToast) window.showToast(data.error || t('common.error'), 'error');
                    }
                } catch (e) {
                    if (window.showToast) window.showToast(t('common.network_error'), 'error');
                }
            }
        });
    };

    window.openComponentContractModal = function(btn) {
        if (!btn) return;
        const title = btn.getAttribute('data-title') || '';
        const slug = btn.getAttribute('data-slug') || '';
        const version = btn.getAttribute('data-version') || '1';

        let slots = [];
        try {
            slots = JSON.parse(decodeURIComponent(btn.getAttribute('data-slots') || '[]'));
        } catch (_) {}

        let templateHtml = '';
        try {
            templateHtml = decodeURIComponent(btn.getAttribute('data-template') || '');
        } catch (_) {}

        let propsJson = '';
        try {
            propsJson = decodeURIComponent(btn.getAttribute('data-props') || '{}');
        } catch (_) {}

        let schemaJson = '';
        try {
            schemaJson = decodeURIComponent(btn.getAttribute('data-schema') || '{}');
        } catch (_) {}

        const modal = document.getElementById('component-contract-modal');
        if (!modal) return;

        const titleEl = document.getElementById('component-contract-title');
        const subtitleEl = document.getElementById('component-contract-subtitle');
        if (titleEl) titleEl.innerText = title;
        if (subtitleEl) subtitleEl.innerText = slug + ' · v' + version;

        const slotsEl = document.getElementById('component-contract-slots');
        if (slotsEl) {
            if (Array.isArray(slots) && slots.length > 0) {
                slotsEl.innerHTML = slots.map(function(s) {
                    return '<span class="bg-indigo-50 dark:bg-indigo-950/80 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800/80 px-2 py-0.5 rounded-lg font-mono text-xs font-semibold">' + s + '</span>';
                }).join(' ');
            } else {
                slotsEl.innerHTML = '<span class="bg-stone-100 dark:bg-stone-800 text-stone-500 dark:text-stone-400 border border-stone-200 dark:border-stone-700 px-2 py-0.5 rounded-lg font-mono text-xs font-semibold">main</span>';
            }
        }

        const templateEl = document.getElementById('component-contract-template');
        if (templateEl) templateEl.value = templateHtml;

        const propsEl = document.getElementById('component-contract-props');
        if (propsEl) propsEl.value = propsJson;

        const schemaEl = document.getElementById('component-contract-schema');
        if (schemaEl) schemaEl.value = schemaJson;

        modal.classList.remove('hidden');
    };

    let cachedThemeContractMd = null;

    window.openThemeContractModal = async function() {
        const modal = document.getElementById('theme-contract-modal');
        const textEl = document.getElementById('theme-contract-modal-text');
        if (!modal || !textEl) return;
        modal.classList.remove('hidden');
        if (cachedThemeContractMd !== null) {
            textEl.value = cachedThemeContractMd;
            return;
        }
        textEl.value = t('common.loading');
        try {
            const res = await fetch('/admin/theme-contract.md');
            if (!res.ok) throw new Error('HTTP ' + res.status);
            cachedThemeContractMd = await res.text();
            textEl.value = cachedThemeContractMd;
        } catch (err) {
            textEl.value = t('common.error') + ': ' + (err.message || '');
        }
    };

    window.closeThemeContractModal = function() {
        document.getElementById('theme-contract-modal')?.classList.add('hidden');
    };

    window.copyThemeContractModal = function() {
        const text = document.getElementById('theme-contract-modal-text')?.value || '';
        if (text && window.walnutCopyText) {
            window.walnutCopyText(text, t('common.copy_clipboard_success'), t('common.error'));
        }
    };

    window.downloadThemeContractModal = function() {
        const text = document.getElementById('theme-contract-modal-text')?.value || '';
        if (text && window.walnutDownloadFile) {
            window.walnutDownloadFile('theme-contract.md', text, 'text/markdown;charset=utf-8');
        }
    };

    window.downloadSchemaJsonFile = function() {
        const text = document.getElementById('export-schema-modal-json')?.value || '';
        if (text && window.walnutDownloadFile) {
            window.walnutDownloadFile('schema-contract.json', text, 'application/json');
        }
    };

    window.closeComponentContractModal = function() {
        const modal = document.getElementById('component-contract-modal');
        if (modal) modal.classList.add('hidden');
    };

    window.copyComponentTemplateHtml = function() {
        const templateEl = document.getElementById('component-contract-template');
        if (!templateEl || !templateEl.value) return;
        navigator.clipboard.writeText(templateEl.value).then(function() {
            if (window.showToast) {
                window.showToast(t('themes.copy_template_success') || 'Template HTML copied!', 'success');
            }
        }).catch(function() {
            templateEl.select();
            document.execCommand('copy');
            if (window.showToast) {
                window.showToast(t('themes.copy_template_success') || 'Template HTML copied!', 'success');
            }
        });
    };

    // Scale component previews from a 1080px desktop viewport (1280px for page templates) and pan on hover when taller than the card.
    window.adaptThemeComponentHeight = function(iframeEl) {
        if (!iframeEl) return;
        try {
            const doc = iframeEl.contentDocument || (iframeEl.contentWindow && iframeEl.contentWindow.document);
            if (!doc || !doc.body) return;

            const body = doc.body;
            let contentHeight = body.offsetHeight || body.scrollHeight || 0;
            const firstChild = body.firstElementChild;
            if (firstChild) {
                const childH = firstChild.offsetHeight || firstChild.scrollHeight || 0;
                if (childH > 0) {
                    contentHeight = Math.max(contentHeight, childH);
                }
            }

            const viewport = iframeEl.closest('.theme-component-viewport');
            if (viewport) {
                const cardWidth = viewport.clientWidth || viewport.offsetWidth || 320;
                if (cardWidth > 0) {
                    const scale = cardWidth / 1080;
                    viewport.style.setProperty('--preview-scale', scale.toFixed(4));
                    const scaledContentHeight = contentHeight * scale;
                    const targetHeight = Math.round(Math.max(48, Math.min(scaledContentHeight, 180)));
                    viewport.style.height = targetHeight + 'px';
                    iframeEl.style.height = Math.max(contentHeight, Math.round(targetHeight / scale)) + 'px';

                    const overflowScaled = Math.max(0, scaledContentHeight - targetHeight);
                    const panY = overflowScaled > 4 ? -Math.round(overflowScaled / scale) : 0;
                    viewport.dataset.panY = String(panY);
                    if (!viewport.dataset.hoverPanBound) {
                        viewport.dataset.hoverPanBound = '1';
                        viewport.addEventListener('mouseenter', function() {
                            const s = viewport.style.getPropertyValue('--preview-scale') || '0.35';
                            const p = Number(viewport.dataset.panY || 0);
                            if (p < 0) {
                                iframeEl.style.transform = `scale(${s}) translateY(${p}px)`;
                            }
                        });
                        viewport.addEventListener('mouseleave', function() {
                            const s = viewport.style.getPropertyValue('--preview-scale') || '0.35';
                            iframeEl.style.transform = `scale(${s}) translateY(0px)`;
                        });
                    }
                }
            }
        } catch (_) {}
    };

    window.syncThemePreviewsDarkMode = function(isDark) {
        if (typeof isDark === 'undefined') {
            const mode = window.getAdminThemeMode ? window.getAdminThemeMode() : (localStorage.getItem('edge_theme_mode') || 'system');
            if (mode === 'dark') isDark = true;
            else if (mode === 'light') isDark = false;
            else isDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
        }

        const applyDocTheme = function(doc) {
            if (!doc || !doc.documentElement) return;
            if (isDark) {
                doc.documentElement.classList.add('dark');
                if (doc.body) {
                    doc.body.classList.add('bg-[#0b1120]', 'text-stone-100');
                    doc.body.classList.remove('bg-white', 'text-stone-900');
                }
            } else {
                doc.documentElement.classList.remove('dark');
                if (doc.body) {
                    doc.body.classList.remove('bg-[#0b1120]', 'text-stone-100');
                    doc.body.classList.add('bg-white', 'text-stone-900');
                }
            }
        };

        document.querySelectorAll('.theme-preview-viewport iframe, .theme-component-viewport iframe').forEach(function(iframe) {
            try {
                const doc = iframe.contentDocument || (iframe.contentWindow && iframe.contentWindow.document);
                applyDocTheme(doc);
                if (iframe.contentWindow && iframe.contentWindow.postMessage) {
                    iframe.contentWindow.postMessage({ type: 'walnut:theme_mode', isDark: isDark }, '*');
                }
            } catch (_) {}
        });
    };

    let themePreviewObserver = null;

    function updatePreviewElementScale(el, cardWidth) {
        if (!el || cardWidth <= 0) return;
        if (el.classList.contains('theme-component-viewport')) {
            const scale = (cardWidth / 1080).toFixed(4);
            el.style.setProperty('--preview-scale', scale);
            const iframe = el.querySelector('iframe');
            if (iframe && typeof window.adaptThemeComponentHeight === 'function') {
                window.adaptThemeComponentHeight(iframe);
            }
        } else {
            const scale = (cardWidth / 1280).toFixed(4);
            el.style.setProperty('--preview-scale', scale);
        }
    }

    function initThemePreviewScalers() {
        if (typeof window.syncThemePreviewsDarkMode === 'function') {
            window.syncThemePreviewsDarkMode();
        }

        if (typeof ResizeObserver === 'undefined') {
            document.querySelectorAll('.theme-preview-viewport').forEach(function(el) {
                updatePreviewElementScale(el, el.clientWidth);
            });
            return;
        }

        if (!themePreviewObserver) {
            themePreviewObserver = new ResizeObserver(function(entries) {
                for (let i = 0; i < entries.length; i++) {
                    const entry = entries[i];
                    updatePreviewElementScale(entry.target, entry.contentRect.width);
                }
            });
        }

        document.querySelectorAll('.theme-preview-viewport').forEach(function(el) {
            themePreviewObserver.observe(el);
            const w = el.clientWidth;
            if (w > 0) {
                updatePreviewElementScale(el, w);
            }
        });

        document.querySelectorAll('.theme-component-viewport iframe, .theme-preview-viewport iframe').forEach(function(iframe) {
            if (typeof window.adaptThemeComponentHeight === 'function' && iframe.closest('.theme-component-viewport')) {
                window.adaptThemeComponentHeight(iframe);
            }
            iframe.addEventListener('load', function() {
                if (typeof window.syncThemePreviewsDarkMode === 'function') {
                    window.syncThemePreviewsDarkMode();
                }
            });
        });
    }

    function notifyBrokenThemeBlocksIfJustActivated() {
        let justSwitched = false;
        try {
            if (sessionStorage.getItem('edge_theme_activated_check') === '1') {
                sessionStorage.removeItem('edge_theme_activated_check');
                justSwitched = true;
            }
        } catch {}
        if (!justSwitched) return;
        const banner = document.getElementById('themes-broken-blocks-banner');
        if (!banner || !window.showToast) return;
        const pages = Number(banner.getAttribute('data-broken-pages') || 0);
        const blocks = Number(banner.getAttribute('data-broken-blocks') || 0);
        if (pages > 0) {
            window.showToast(t('themes.broken_blocks_detected_toast', { pages: pages, blocks: blocks }), 'warning');
        }
    }

    document.addEventListener('htmx:afterRequest', function(evt) {
        const reqPath = evt?.detail?.requestConfig?.path || evt?.detail?.pathInfo?.requestPath || '';
        if (evt?.detail?.successful && String(reqPath).includes('/admin/themes/api/activate/')) {
            try { sessionStorage.setItem('edge_theme_activated_check', '1'); } catch {}
        }
    });

    document.addEventListener('DOMContentLoaded', function() {
        initThemePreviewScalers();
        notifyBrokenThemeBlocksIfJustActivated();
    });

    document.addEventListener('htmx:afterSwap', function() {
        initThemePreviewScalers();
    });
})();
