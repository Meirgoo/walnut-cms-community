(function() {
    'use strict';

    const t = function(k, params) {
        const fn = window.__EDGE_I18N__ && window.__EDGE_I18N__.t;
        return typeof fn === 'function' ? fn(k, params) : k;
    };

    function initWikiGraph() {
        const rawEl = document.getElementById('admin-wiki-raw-data') || document.getElementById('wiki-raw-relations-data');
        const canvas = document.getElementById('admin-wiki-canvas') || document.getElementById('wiki-graph-canvas');
        if (!canvas || !rawEl) return;

        const payload = { nodes: [], relations: [] };
        try {
            let rawText = (rawEl.textContent || '{}').trim();
            if (rawText.startsWith('$')) rawText = rawText.substring(1).trim();
            const parsed = JSON.parse(rawText || '{}');
            if (Array.isArray(parsed)) {
                payload.relations = parsed;
            } else if (parsed && typeof parsed === 'object') {
                payload.nodes = parsed.nodes || [];
                payload.relations = parsed.relations || [];
            }
        } catch (e) {
            console.warn('[ImpactGraph] Failed to parse topology data:', e);
        }

        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        let width = 800;
        let height = 600;

        function resizeCanvas() {
            if (!canvas.parentElement) return;
            const rect = canvas.parentElement.getBoundingClientRect();
            width = Math.max(300, Math.floor(rect.width || 800));
            height = Math.max(300, Math.floor(rect.height || 600));
            const dpr = window.devicePixelRatio || 1;
            canvas.width = Math.round(width * dpr);
            canvas.height = Math.round(height * dpr);
            canvas.style.width = width + 'px';
            canvas.style.height = height + 'px';
            canvas.style.display = 'block';
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        }
        resizeCanvas();
        window.addEventListener('resize', resizeCanvas);
        if (window.ResizeObserver && canvas.parentElement) {
            const ro = new ResizeObserver(function () {
                resizeCanvas();
            });
            ro.observe(canvas.parentElement);
        }

        const nodeMap = {};
        const nodes = [];
        const links = [];

        const colorMap = {
            route: '#f59e0b',
            page: '#ef4444',
            single: '#ef4444',
            template: '#ef4444',
            redirect: '#ef4444',
            article: '#3b82f6',
            note: '#10b981',
            micro: '#10b981',
            dataset: '#06b6d4',
            clip: '#0ea5e9',
            log: '#eab308'
        };

        const layerYOffsets = {
            0: Math.max(90, Math.round(height * 0.18)),
            1: Math.round(height * 0.50),
            2: Math.min(height - 70, Math.round(height * 0.82))
        };

        let hierarchicalMode = false;
        let physicsEnabled = true;
        let autoOrbit = true;
        let isOrbitPaused = false;
        let orbitResumeTimer = null;
        let orbitAngle = 0;
        let highlightIsolated = false;
        let highlightDirty = false;
        let inspectorHoverNode = null;
        let customOverlayRenderer = null;
        const hiddenTypes = new Set();
        let timeLapseActive = false;
        let timeLapseTimer = null;
        let timeLapseVisibleCount = 0;
        let timeLapseOrderMap = new Map();

        let maxHeat = 0;
        (payload.nodes || []).forEach(function(item) {
            const h = Number(item.heat || 0);
            if (h > maxHeat) maxHeat = h;
        });

        function getNodeRadius(n) {
            if (n.type === 'route') return 10;
            const baseRadius = n.level === 2 && n.degree >= 2 ? 10 : 8;
            const degreeBonus = Math.min(10, n.degree * 1.8);
            let heatBonus = 0;
            if (n.heat > 0) {
                heatBonus = maxHeat > 0
                    ? Math.min(18, (n.heat / maxHeat) * 18)
                    : Math.min(18, Math.log10(n.heat + 1) * 5);
            }
            return Math.max(7, Math.min(34, baseRadius + degreeBonus + heatBonus));
        }

        const groupedByLevel = { 0: [], 1: [], 2: [] };

        (payload.nodes || []).forEach(function(item) {
            let lvl;
            if (item.type === 'route') lvl = 0;
            else if (item.type === 'page' || item.type === 'article') lvl = 1;
            else if (item.type === 'note' || item.type === 'micro' || item.type === 'dataset') lvl = 2;
            else lvl = 1;
            item._calculatedLevel = lvl;
            if (!groupedByLevel[lvl]) groupedByLevel[lvl] = [];
            groupedByLevel[lvl].push(item);
        });

        // Scale concentric orbital radii with node count to preserve ~48-60px arc spacing and prevent crowding.
        const count0 = groupedByLevel[0].length;
        const count1 = groupedByLevel[1].length;
        const count2 = groupedByLevel[2].length;

        const r0 = Math.max(80, Math.ceil((count0 * 45) / (2 * Math.PI)));
        const r1 = Math.max(r0 + 130, Math.ceil((count1 * 50) / (2 * Math.PI)));
        const r2 = Math.max(r1 + 140, Math.ceil((count2 * 52) / (2 * Math.PI)));

        const orbitalRadii = {
            0: r0,
            1: r1,
            2: r2
        };

        (payload.nodes || []).forEach(function(item) {
            const lvl = item._calculatedLevel !== undefined ? item._calculatedLevel : 1;
            const group = groupedByLevel[lvl] || [item];
            const indexInGroup = group.indexOf(item);
            const totalInGroup = Math.max(1, group.length);

            const targetX = (width / (totalInGroup + 1)) * (indexInGroup + 1);
            const targetY = layerYOffsets[lvl] || (height / 2);

            const angle = (2 * Math.PI / totalInGroup) * indexInGroup + (lvl * 0.4);
            const r = orbitalRadii[lvl] || 200;
            const sX = (width / 2) + r * Math.cos(angle);
            const sY = (height / 2) + r * Math.sin(angle);

            const heatVal = Number(item.heat || 0);
            const isDirty = Boolean(item.is_dirty || item.status === 'draft' || item.status === 'dirty' || item.status === 'pending');

            const n = {
                id: item.id,
                title: item.title || item.slug,
                slug: item.slug,
                type: item.type || 'page',
                layer: item.layer || 'content',
                level: lvl,
                path: item.path,
                maturity: item.maturity || 'seedling',
                summary: item.summary || '',
                heat: heatVal,
                is_dirty: isDirty,
                created_at: item.created_at || null,
                entity_type: item.entity_type || null,
                entity_id: item.entity_id || null,
                x: sX + (Math.random() - 0.5) * 20,
                y: sY + (Math.random() - 0.5) * 20,
                zOffset: (((nodes.length * 47) % 100) - 50) / 50 * Math.min(r * 0.42, 160),
                renderX: sX,
                renderY: sY,
                renderScale: 1,
                renderAlpha: 1,
                renderZ: 0,
                hierarchicalX: targetX,
                hierarchicalY: targetY,
                targetLevelY: targetY,
                vx: 0,
                vy: 0,
                degree: 0
            };

            if (item.id) nodeMap[item.id] = n;
            if (item.type !== 'route') {
                if (item.slug) {
                    nodeMap[item.slug] = n;
                    nodeMap[item.slug.toLowerCase()] = n;
                }
                if (item.path) {
                    nodeMap[item.path] = n;
                    nodeMap[item.path.toLowerCase()] = n;
                }
            } else {
                nodeMap['route:' + item.path] = n;
                nodeMap['route:' + item.slug] = n;
            }
            if (item.title) {
                nodeMap[item.title] = n;
                nodeMap[item.title.toLowerCase()] = n;
            }
            nodes.push(n);
        });

        (payload.relations || []).forEach(function(r) {
            let srcNode = (r.source_id && nodeMap[r.source_id]) || nodeMap['route:' + r.source_slug] || nodeMap[r.source_slug] || (r.source_slug && nodeMap[r.source_slug.toLowerCase()]);
            let tgtNode = (r.target_id && nodeMap[r.target_id]) || nodeMap[r.target_slug] || (r.target_slug && nodeMap[r.target_slug.toLowerCase()]);
            if (!srcNode || !tgtNode) return;

            srcNode.degree++;
            tgtNode.degree++;
            links.push({
                source: srcNode,
                target: tgtNode,
                relationType: r.relation_type || 'ref'
            });
        });

        const statsEl = document.getElementById('admin-wiki-stats') || document.getElementById('wiki-graph-stats');
        if (statsEl) {
            statsEl.innerText = t('wiki.nodes_count', { nodes: nodes.length, links: links.length }) || (nodes.length + ' nodes · ' + links.length + ' references');
        }

        const initialLayoutBtn = document.getElementById('wiki-layout-toggle');
        if (initialLayoutBtn) {
            const label = initialLayoutBtn.querySelector('span:last-child');
            if (label) {
                label.innerText = hierarchicalMode
                    ? (t('wiki.mode_hierarchical') || 'Hierarchical View')
                    : (t('wiki.mode_spherical') || 'Spherical View');
            }
        }

        const fitRadius = orbitalRadii[2] + 70;
        const availableRadius = Math.min(width, height) / 2;
        const initialScale = fitRadius > availableRadius ? Math.max(0.2, (availableRadius - 30) / fitRadius) : 1;

        const view = { x: 0, y: 0, scale: initialScale };
        let isDraggingView = false;
        let startX = 0, startY = 0;
        let draggedNode = null;
        let hoveredNode = null;
        let selectedNode = null;
        let mouseDownPos = { x: 0, y: 0 };
        let searchQuery = '';

        window.resetAdminWikiView = function() { view.x = 0; view.y = 0; view.scale = initialScale; };
        window.highlightAdminWikiNode = function(q) { searchQuery = (q || '').trim().toLowerCase(); };

        window.toggleHighlightIsolated = function() {
            highlightIsolated = !highlightIsolated;
            const btn = document.getElementById('wiki-isolated-toggle');
            if (btn) {
                btn.className = highlightIsolated
                    ? 'bg-purple-600 hover:bg-purple-500 text-white px-3 py-2 rounded-xl text-xs font-bold shadow-sm transition flex items-center space-x-1 cursor-pointer ring-2 ring-purple-400'
                    : 'bg-white dark:bg-stone-800 hover:bg-stone-50 dark:hover:bg-stone-700 text-stone-700 dark:text-stone-200 px-3 py-2 rounded-xl text-xs font-bold border border-stone-200/80 dark:border-stone-700 shadow-sm transition flex items-center space-x-1 cursor-pointer';
            }
        };

        window.toggleHighlightDirty = function() {
            highlightDirty = !highlightDirty;
            const btn = document.getElementById('wiki-dirty-toggle');
            if (btn) {
                btn.className = highlightDirty
                    ? 'bg-amber-600 hover:bg-amber-500 text-white px-3 py-2 rounded-xl text-xs font-bold shadow-sm transition flex items-center space-x-1 cursor-pointer ring-2 ring-amber-400'
                    : 'bg-white dark:bg-stone-800 hover:bg-stone-50 dark:hover:bg-stone-700 text-stone-700 dark:text-stone-200 px-3 py-2 rounded-xl text-xs font-bold border border-stone-200/80 dark:border-stone-700 shadow-sm transition flex items-center space-x-1 cursor-pointer';
            }
        };

        window.toggleWikiPhysics = function() {
            physicsEnabled = !physicsEnabled;
            const btn = document.getElementById('wiki-physics-toggle');
            if (btn) {
                btn.className = physicsEnabled
                    ? 'bg-amber-600/80 hover:bg-[#92400E] text-white px-3 py-2 rounded-xl text-xs font-mono shadow-sm transition flex items-center space-x-1 cursor-pointer'
                    : 'bg-stone-800 text-stone-400 hover:text-white px-3 py-2 rounded-xl text-xs font-mono border border-stone-700 shadow-sm transition flex items-center space-x-1 cursor-pointer';
            }
        };

        function normalizeFilterType(t) {
            const lower = String(t || '').toLowerCase();
            if (lower === 'single' || lower === 'template' || lower === 'redirect') return 'page';
            if (lower === 'note') return 'micro';
            return lower;
        }

        function isNodeVisible(n) {
            if (hiddenTypes.has(normalizeFilterType(n.type))) return false;
            if (timeLapseActive) {
                const order = timeLapseOrderMap.get(n.id);
                if (order !== undefined && order >= timeLapseVisibleCount) return false;
            }
            return true;
        }

        function updateStatsLabel() {
            const statsEl = document.getElementById('admin-wiki-stats') || document.getElementById('wiki-graph-stats');
            if (!statsEl) return;
            if (timeLapseActive) {
                const label = t('wiki.timelapse_label') || 'Time-Lapse';
                statsEl.innerText = label + ': ' + Math.min(timeLapseVisibleCount, nodes.length) + ' / ' + nodes.length;
                return;
            }
            const visibleCount = nodes.filter(isNodeVisible).length;
            const visibleLinks = links.filter(function(l) { return isNodeVisible(l.source) && isNodeVisible(l.target); }).length;
            statsEl.innerText = t('wiki.nodes_count', { nodes: visibleCount, links: visibleLinks }) || (visibleCount + ' nodes · ' + visibleLinks + ' references');
        }

        function pauseOrbitTemporarily(resumeLater) {
            isOrbitPaused = true;
            if (orbitResumeTimer) {
                clearTimeout(orbitResumeTimer);
                orbitResumeTimer = null;
            }
            if (resumeLater) {
                orbitResumeTimer = setTimeout(function() {
                    if (!hoveredNode && !draggedNode && !isDraggingView) {
                        isOrbitPaused = false;
                    }
                }, 2000);
            }
        }

        window.toggleWikiTypeFilter = function(type, btnEl) {
            const norm = normalizeFilterType(type);
            if (hiddenTypes.has(norm)) {
                hiddenTypes.delete(norm);
                if (btnEl) btnEl.classList.remove('opacity-40', 'line-through');
            } else {
                hiddenTypes.add(norm);
                if (btnEl) btnEl.classList.add('opacity-40', 'line-through');
            }
            if (selectedNode && !isNodeVisible(selectedNode)) {
                window.closeWikiInspector && window.closeWikiInspector();
            }
            updateStatsLabel();
        };

        window.toggleWikiAutoOrbit = function() {
            autoOrbit = !autoOrbit;
            const btn = document.getElementById('wiki-orbit-toggle');
            if (btn) {
                btn.className = autoOrbit
                    ? 'bg-amber-600/80 hover:bg-[#92400E] text-white px-3 py-2 rounded-xl text-xs font-bold shadow-sm transition flex items-center space-x-1 cursor-pointer'
                    : 'bg-white dark:bg-stone-800 hover:bg-stone-50 dark:hover:bg-stone-700 text-stone-700 dark:text-stone-200 px-3 py-2 rounded-xl text-xs font-bold border border-stone-200/80 dark:border-stone-700 shadow-sm transition flex items-center space-x-1 cursor-pointer';
            }
        };

        function stopTimeLapse() {
            timeLapseActive = false;
            if (timeLapseTimer) {
                clearInterval(timeLapseTimer);
                timeLapseTimer = null;
            }
            const btn = document.getElementById('wiki-timelapse-toggle');
            if (btn) {
                btn.className = 'bg-white dark:bg-stone-800 hover:bg-stone-50 dark:hover:bg-stone-700 text-stone-700 dark:text-stone-200 px-3 py-2 rounded-xl text-xs font-bold border border-stone-200/80 dark:border-stone-700 shadow-sm transition flex items-center space-x-1 cursor-pointer';
                const lbl = btn.querySelector('span:last-child');
                if (lbl) lbl.innerText = t('wiki.btn_timelapse') || 'Time-Lapse';
            }
            updateStatsLabel();
        }

        window.toggleWikiTimeLapse = function() {
            if (timeLapseActive) {
                stopTimeLapse();
                return;
            }
            if (nodes.length === 0) return;

            const sorted = nodes.slice().sort(function(a, b) {
                const ta = a.created_at ? Date.parse(a.created_at) : NaN;
                const tb = b.created_at ? Date.parse(b.created_at) : NaN;
                if (!isNaN(ta) && !isNaN(tb) && ta !== tb) return ta - tb;
                if (!isNaN(ta) && isNaN(tb)) return -1;
                if (isNaN(ta) && !isNaN(tb)) return 1;
                return (b.level || 0) - (a.level || 0);
            });
            timeLapseOrderMap = new Map();
            sorted.forEach(function(n, idx) { timeLapseOrderMap.set(n.id, idx); });

            timeLapseActive = true;
            timeLapseVisibleCount = 1;
            const btn = document.getElementById('wiki-timelapse-toggle');
            if (btn) {
                btn.className = 'bg-indigo-600 hover:bg-indigo-500 text-white px-3 py-2 rounded-xl text-xs font-bold shadow-sm transition flex items-center space-x-1 cursor-pointer ring-2 ring-indigo-400';
                const lbl = btn.querySelector('span:last-child');
                if (lbl) lbl.innerText = t('wiki.btn_timelapse_stop') || 'Stop Replay';
            }
            updateStatsLabel();

            const stepSize = Math.max(1, Math.ceil(nodes.length / 40));
            timeLapseTimer = setInterval(function() {
                timeLapseVisibleCount += stepSize;
                updateStatsLabel();
                if (timeLapseVisibleCount >= nodes.length) {
                    stopTimeLapse();
                }
            }, 90);
        };

        window.toggleWikiHierarchyLayout = function() {
            hierarchicalMode = !hierarchicalMode;
            if (!hierarchicalMode && autoOrbit) {
                isOrbitPaused = false;
            }
            const btn = document.getElementById('wiki-layout-toggle');
            if (btn) {
                btn.className = hierarchicalMode
                    ? 'bg-amber-600 hover:bg-amber-500 text-white px-3 py-2 rounded-xl text-xs font-bold shadow-sm transition flex items-center space-x-1 cursor-pointer'
                    : 'bg-white dark:bg-stone-800 hover:bg-stone-50 dark:hover:bg-stone-700 text-stone-700 dark:text-stone-200 px-3 py-2 rounded-xl text-xs font-bold border border-stone-200/80 dark:border-stone-700 shadow-sm transition flex items-center space-x-1 cursor-pointer';
                const label = btn.querySelector('span:last-child');
                if (label) {
                    label.innerText = hierarchicalMode
                        ? (t('wiki.mode_hierarchical') || 'Hierarchical View')
                        : (t('wiki.mode_spherical') || 'Spherical View');
                }
            }
            nodes.forEach(function(n) {
                n.vx += (Math.random() - 0.5) * 3;
                n.vy += (Math.random() - 0.5) * 3;
            });
        };

        function updatePhysics() {
            if (!physicsEnabled && !draggedNode && !hierarchicalMode) return;
            const cx = width / 2;
            const cy = height / 2;

            for (let i = 0; i < nodes.length; i++) {
                for (let j = i + 1; j < nodes.length; j++) {
                    const a = nodes[i];
                    const b = nodes[j];
                    const dx = b.x - a.x;
                    const dy = b.y - a.y;
                    const rawDist = Math.sqrt(dx * dx + dy * dy) || 1;
                    const rA = getNodeRadius(a);
                    const rB = getNodeRadius(b);
                    const minDist = rA + rB + 16;
                    const dist = Math.max(rawDist, minDist);
                    if (dist < 320) {
                        const force = Math.min((minDist * minDist * 1.5) / (dist * dist) * 0.4, 9);
                        const fx = (dx / rawDist) * force;
                        const fy = (dy / rawDist) * force;
                        a.vx -= fx; a.vy -= fy;
                        b.vx += fx; b.vy += fy;
                    }
                }
            }

            links.forEach(function(link) {
                const a = link.source;
                const b = link.target;
                const dx = b.x - a.x;
                const dy = b.y - a.y;
                const dist = Math.sqrt(dx * dx + dy * dy) || 1;

                if (hierarchicalMode) {
                    const levelDiff = Math.abs((a.level || 0) - (b.level || 0));
                    const desiredDist = levelDiff > 0 ? (levelDiff * 130) : 90;
                    const force = Math.min((dist - desiredDist) * 0.03, 8);
                    const fx = (dx / dist) * force;
                    const fy = (dy / dist) * force;
                    a.vx += fx; a.vy += fy;
                    b.vx -= fx; b.vy -= fy;
                } else {
                    const resourceNode = b.level === 2 ? b : (a.level === 2 ? a : null);
                    const isSharedResource = resourceNode && resourceNode.degree >= 2;

                    let desiredDist;
                    let k;

                    if (link.relationType === 'route_binds') {
                        // Keep route_binds tightly coupled so route labels stay adjacent to target nodes.
                        desiredDist = 48;
                        k = 0.09;
                    } else if (link.relationType === 'translation') {
                        desiredDist = 95;
                        k = 0.045;
                    } else if (link.relationType === 'data_source') {
                        desiredDist = 110;
                        k = 0.04;
                    } else if (isSharedResource) {
                        // Pull shared resources closer with higher stiffness so they settle at the centroid of referencing pages.
                        desiredDist = 85;
                        k = 0.055;
                    } else if (link.relationType === 'parent_child') {
                        desiredDist = 80;
                        k = 0.04;
                    } else {
                        desiredDist = 105;
                        k = 0.035;
                    }

                    const force = Math.min((dist - desiredDist) * k, 8);
                    const fx = (dx / dist) * force;
                    const fy = (dy / dist) * force;
                    a.vx += fx; a.vy += fy;
                    b.vx -= fx; b.vy -= fy;
                }
            });

            const maxSpeed = 6;
            const margin = 50;

            nodes.forEach(function(n) {
                if (n === draggedNode) return;

                if (hierarchicalMode) {
                    const targetY = n.hierarchicalY || cy;
                    n.vy += (targetY - n.y) * 0.085;
                    n.vx += (cx - n.x) * 0.001;
                } else {
                    const dx = n.x - cx;
                    const dy = n.y - cy;
                    const r = Math.sqrt(dx * dx + dy * dy) || 1;

                    if (n.level === 0) {
                        const targetR = orbitalRadii[0];
                        const diffR = r - targetR;
                        n.vx -= (dx / r) * diffR * 0.006;
                        n.vy -= (dy / r) * diffR * 0.006;
                    } else if (n.level === 1) {
                        const targetR = orbitalRadii[1];
                        const diffR = r - targetR;
                        n.vx -= (dx / r) * diffR * 0.0035;
                        n.vy -= (dy / r) * diffR * 0.0035;
                    } else {
                        if (n.degree <= 1) {
                            const targetR = orbitalRadii[2];
                            const diffR = r - targetR;
                            n.vx -= (dx / r) * diffR * 0.0025;
                            n.vy -= (dy / r) * diffR * 0.0025;
                        } else {
                            // Stabilize shared resources pulled by multiple pages toward the center.
                            n.vx += (cx - n.x) * 0.001;
                            n.vy += (cy - n.y) * 0.001;
                        }
                    }
                }

                if (hierarchicalMode) {
                    if (n.x < margin) n.vx += (margin - n.x) * 0.04;
                    if (n.x > width - margin) n.vx -= (n.x - (width - margin)) * 0.04;
                    if (n.y < margin) n.vy += (margin - n.y) * 0.04;
                    if (n.y > height - margin) n.vy -= (n.y - (height - margin)) * 0.04;
                } else {
                    const dx = n.x - cx;
                    const dy = n.y - cy;
                    const distCenter = Math.sqrt(dx * dx + dy * dy) || 1;
                    const maxAllowedR = orbitalRadii[2] + 200;
                    if (distCenter > maxAllowedR) {
                        const diff = distCenter - maxAllowedR;
                        n.vx -= (dx / distCenter) * diff * 0.04;
                        n.vy -= (dy / distCenter) * diff * 0.04;
                    }
                }

                n.vx *= 0.85;
                n.vy *= 0.85;
                n.vx = Math.max(-maxSpeed, Math.min(maxSpeed, n.vx));
                n.vy = Math.max(-maxSpeed, Math.min(maxSpeed, n.vy));
                n.x += n.vx;
                n.y += n.vy;
            });
        }

        function computeImpactSets(focusNode) {
            const upstream = new Set();
            const downstream = new Set();
            if (!focusNode) return { upstream, downstream };

            const upQueue = [focusNode];
            const downQueue = [focusNode];
            const seenUp = new Set([focusNode]);
            const seenDown = new Set([focusNode]);

            while (upQueue.length > 0) {
                const curr = upQueue.shift();
                links.forEach(function(l) {
                    if (!isNodeVisible(l.source) || !isNodeVisible(l.target)) return;
                    if (l.target === curr && !seenUp.has(l.source)) {
                        seenUp.add(l.source);
                        upstream.add(l.source);
                        upQueue.push(l.source);
                    }
                });
            }
            while (downQueue.length > 0) {
                const curr = downQueue.shift();
                links.forEach(function(l) {
                    if (!isNodeVisible(l.source) || !isNodeVisible(l.target)) return;
                    if (l.source === curr && !seenDown.has(l.target)) {
                        seenDown.add(l.target);
                        downstream.add(l.target);
                        downQueue.push(l.target);
                    }
                });
            }
            return { upstream, downstream };
        }

        function projectNodes() {
            const cx = width / 2;
            const cy = height / 2;
            const cosA = Math.cos(orbitAngle);
            const sinA = Math.sin(orbitAngle);
            const maxZ = Math.max(200, fitRadius);

            nodes.forEach(function(n) {
                if (hierarchicalMode) {
                    n.renderX = n.x;
                    n.renderY = n.y;
                    n.renderScale = 1;
                    n.renderAlpha = 1;
                    n.renderZ = 0;
                } else {
                    const dx = n.x - cx;
                    const z0 = n.zOffset || 0;
                    const rx = dx * cosA - z0 * sinA;
                    const rz = dx * sinA + z0 * cosA;
                    n.renderX = cx + rx;
                    n.renderY = n.y;
                    n.renderZ = rz;
                    n.renderScale = Math.max(0.62, Math.min(1.28, 1 + rz / (maxZ * 2.1)));
                    n.renderAlpha = Math.max(0.28, Math.min(1, 0.72 + rz / (maxZ * 1.7)));
                }
            });
        }

        function render() {
            if (!hierarchicalMode && autoOrbit && !isOrbitPaused) {
                orbitAngle += 0.0042;
            }
            projectNodes();

            ctx.clearRect(0, 0, width, height);

            ctx.save();
            ctx.translate(width / 2 + view.x, height / 2 + view.y);
            ctx.scale(view.scale, view.scale);
            ctx.translate(-width / 2, -height / 2);

            if (hierarchicalMode) {
                ctx.save();
                ctx.strokeStyle = 'rgba(148, 163, 184, 0.12)';
                ctx.lineWidth = 1;
                ctx.setLineDash([4, 6]);
                ctx.font = '10px font-mono sans-serif';
                ctx.fillStyle = 'rgba(148, 163, 184, 0.4)';

                const layerLabels = [
                    { y: layerYOffsets[0], text: t('wiki.layer_routes') || 'LAYER 0 · Routes' },
                    { y: layerYOffsets[1], text: t('wiki.layer_pages') || 'LAYER 1 · Pages & Articles' },
                    { y: layerYOffsets[2], text: t('wiki.layer_data') || 'LAYER 2 · Data Sources' }
                ];

                layerLabels.forEach(function(l) {
                    ctx.beginPath();
                    ctx.moveTo(20, l.y);
                    ctx.lineTo(width - 20, l.y);
                    ctx.stroke();
                    ctx.fillText(l.text, 25, l.y - 6);
                });
                ctx.restore();
            } else {
                ctx.save();
                ctx.strokeStyle = 'rgba(148, 163, 184, 0.08)';
                ctx.lineWidth = 1;
                ctx.setLineDash([3, 6]);
                ctx.font = '10px font-mono sans-serif';
                ctx.fillStyle = 'rgba(148, 163, 184, 0.28)';

                const orbits = [
                    { r: orbitalRadii[0], label: t('wiki.orbit_core') || 'CORE · Routes' },
                    { r: orbitalRadii[1], label: t('wiki.orbit_pages') || 'ORBIT 1 · Pages' },
                    { r: orbitalRadii[2], label: t('wiki.orbit_resources') || 'ORBIT 2 · Data Sources' }
                ];

                orbits.forEach(function(orb) {
                    ctx.beginPath();
                    ctx.arc(width / 2, height / 2, orb.r, 0, Math.PI * 2);
                    ctx.stroke();
                    ctx.fillText(orb.label, width / 2 + 10, height / 2 - orb.r + 12);
                });
                ctx.restore();
            }

            const focusNode = hoveredNode || selectedNode;
            const impact = (!highlightIsolated && !highlightDirty) ? computeImpactSets(focusNode) : { upstream: new Set(), downstream: new Set() };
            const pulsePhase = (Date.now() * 0.00055) % 1;

            links.forEach(function(l, linkIdx) {
                if (!isNodeVisible(l.source) || !isNodeVisible(l.target)) return;

                const sx = l.source.renderX, sy = l.source.renderY;
                const tx = l.target.renderX, ty = l.target.renderY;
                const isSelectedLink = selectedNode && (l.source === selectedNode || l.target === selectedNode);
                const isHoveredLink = hoveredNode && (l.source === hoveredNode || l.target === hoveredNode);
                const isUpstreamLink = focusNode && (l.target === focusNode || impact.upstream.has(l.target)) && (l.source === focusNode || impact.upstream.has(l.source));
                const isDownstreamLink = focusNode && (l.source === focusNode || impact.downstream.has(l.source)) && (l.target === focusNode || impact.downstream.has(l.target));
                const isImpactLink = isUpstreamLink || isDownstreamLink;
                const isSharedLink = (l.source.level === 2 && l.source.degree >= 2) || (l.target.level === 2 && l.target.degree >= 2);

                if (highlightIsolated) {
                    ctx.save();
                    ctx.strokeStyle = 'rgba(71, 85, 105, 0.06)';
                    ctx.lineWidth = 0.5;
                    ctx.beginPath();
                    ctx.moveTo(sx, sy);
                    ctx.lineTo(tx, ty);
                    ctx.stroke();
                    ctx.restore();
                    return;
                }

                if (highlightDirty && !l.source.is_dirty && !l.target.is_dirty) {
                    ctx.save();
                    ctx.strokeStyle = 'rgba(71, 85, 105, 0.1)';
                    ctx.lineWidth = 0.8;
                    ctx.beginPath();
                    ctx.moveTo(sx, sy);
                    ctx.lineTo(tx, ty);
                    ctx.stroke();
                    ctx.restore();
                    return;
                }

                let linkColor = 'rgba(71, 85, 105, 0.35)';
                let linkWidth = 1.2;
                let dimmedLink = false;

                ctx.save();
                if (focusNode && !isImpactLink && !isSelectedLink && !isHoveredLink) {
                    linkColor = 'rgba(71, 85, 105, 0.10)';
                    linkWidth = 0.7;
                    dimmedLink = true;
                } else if (isUpstreamLink) {
                    linkColor = '#38bdf8';
                    linkWidth = 2.2;
                } else if (isDownstreamLink) {
                    linkColor = '#f59e0b';
                    linkWidth = 2.2;
                } else if (l.relationType === 'translation') {
                    linkColor = isSelectedLink ? '#c084fc' : (isHoveredLink ? '#a855f7' : 'rgba(168, 85, 247, 0.7)');
                    linkWidth = isSelectedLink ? 2.6 : 1.8;
                    ctx.setLineDash([4, 4]);
                } else if (l.relationType === 'data_source') {
                    linkColor = isSelectedLink ? '#22d3ee' : (isHoveredLink ? '#06b6d4' : 'rgba(6, 182, 212, 0.7)');
                    linkWidth = isSelectedLink ? 2.5 : 1.8;
                } else if (isSelectedLink) {
                    linkColor = '#34d399';
                    linkWidth = 2.4;
                } else if (isHoveredLink) {
                    linkColor = '#10b981';
                    linkWidth = 2.0;
                } else if (isSharedLink) {
                    linkColor = 'rgba(6, 182, 212, 0.65)';
                    linkWidth = 1.6;
                } else if (l.relationType === 'route_binds') {
                    linkColor = 'rgba(245, 158, 11, 0.55)';
                    linkWidth = 1.6;
                }

                ctx.strokeStyle = linkColor;
                ctx.lineWidth = linkWidth;
                ctx.beginPath();
                ctx.moveTo(sx, sy);
                ctx.lineTo(tx, ty);
                ctx.stroke();
                ctx.restore();

                if (!dimmedLink) {
                    const t = (pulsePhase + (linkIdx * 0.173)) % 1;
                    const reverseFlow = l.relationType === 'data_source' || l.relationType === 'route_binds';
                    const pT = reverseFlow ? (1 - t) : t;
                    const px = sx + (tx - sx) * pT;
                    const py = sy + (ty - sy) * pT;
                    ctx.save();
                    ctx.beginPath();
                    ctx.arc(px, py, isImpactLink ? 3.2 : 2.1, 0, Math.PI * 2);
                    ctx.fillStyle = isUpstreamLink ? '#7dd3fc' : (isDownstreamLink ? '#fcd34d' : '#34d399');
                    ctx.fill();
                    ctx.beginPath();
                    ctx.arc(px, py, isImpactLink ? 6 : 4, 0, Math.PI * 2);
                    ctx.fillStyle = isUpstreamLink ? 'rgba(56, 189, 248, 0.28)' : (isDownstreamLink ? 'rgba(245, 158, 11, 0.28)' : 'rgba(52, 211, 153, 0.22)');
                    ctx.fill();
                    ctx.restore();
                }
            });

            // Sort back-to-front by Z depth for proper 3D occlusion.
            const visibleNodes = nodes.filter(isNodeVisible).sort(function(a, b) {
                return (a.renderZ || 0) - (b.renderZ || 0);
            });

            visibleNodes.forEach(function(n) {
                const isRoute = n.type === 'route';
                const isSharedResource = !hierarchicalMode && n.level === 2 && n.degree >= 2;
                const radius = getNodeRadius(n) * (n.renderScale || 1);
                const nx = n.renderX;
                const ny = n.renderY;
                const isSelected = selectedNode === n;
                const isHovered = hoveredNode === n;
                const isUpstream = impact.upstream.has(n);
                const isDownstream = impact.downstream.has(n);
                const isMatch = searchQuery && n.title.toLowerCase().indexOf(searchQuery) !== -1;
                const isPage = n.type === 'page' || n.type === 'single' || n.type === 'template' || n.type === 'redirect' || n.layer === 'page';
                const nodeColor = isPage ? '#ef4444' : (colorMap[n.type] || '#10b981');

                const isIsolated = n.degree === 0;
                const isDirty = Boolean(n.is_dirty);
                const isFocusDimmed = Boolean(focusNode && n !== focusNode && !isUpstream && !isDownstream);
                const isDimmed = (highlightIsolated && !isIsolated) || (highlightDirty && !isDirty) || isFocusDimmed;

                ctx.save();
                ctx.globalAlpha = (isDimmed && !isSelected && !isHovered && !isMatch)
                    ? (n.renderAlpha || 1) * 0.16
                    : (n.renderAlpha || 1);

                if (highlightIsolated && isIsolated) {
                    ctx.save();
                    ctx.beginPath();
                    ctx.arc(nx, ny, radius + 8, 0, Math.PI * 2);
                    ctx.fillStyle = 'rgba(168, 85, 247, 0.35)';
                    ctx.fill();
                    ctx.strokeStyle = '#c084fc';
                    ctx.lineWidth = 2.2;
                    ctx.setLineDash([3, 3]);
                    ctx.stroke();
                    ctx.restore();
                }

                if (highlightDirty && isDirty) {
                    ctx.save();
                    ctx.beginPath();
                    ctx.arc(nx, ny, radius + 9, 0, Math.PI * 2);
                    ctx.fillStyle = 'rgba(245, 158, 11, 0.4)';
                    ctx.fill();
                    ctx.strokeStyle = '#f59e0b';
                    ctx.lineWidth = 2.4;
                    ctx.stroke();
                    ctx.restore();
                }

                if (isUpstream && !isSelected && !isHovered) {
                    ctx.beginPath();
                    ctx.arc(nx, ny, radius + 6, 0, Math.PI * 2);
                    ctx.fillStyle = 'rgba(56, 189, 248, 0.28)';
                    ctx.fill();
                    ctx.strokeStyle = '#38bdf8';
                    ctx.lineWidth = 2;
                    ctx.stroke();
                } else if (isDownstream && !isSelected && !isHovered) {
                    ctx.beginPath();
                    ctx.arc(nx, ny, radius + 6, 0, Math.PI * 2);
                    ctx.fillStyle = 'rgba(245, 158, 11, 0.28)';
                    ctx.fill();
                    ctx.strokeStyle = '#f59e0b';
                    ctx.lineWidth = 2;
                    ctx.stroke();
                }

                if (isSharedResource && !isSelected && !isHovered && !isUpstream && !isDownstream) {
                    ctx.save();
                    ctx.beginPath();
                    ctx.arc(nx, ny, radius + 5, 0, Math.PI * 2);
                    ctx.strokeStyle = 'rgba(6, 182, 212, 0.55)';
                    ctx.lineWidth = 1.4;
                    ctx.setLineDash([3, 3]);
                    ctx.stroke();
                    ctx.restore();
                }

                if (isSelected) {
                    ctx.beginPath();
                    ctx.arc(nx, ny, radius + 8, 0, Math.PI * 2);
                    ctx.fillStyle = 'rgba(16, 185, 129, 0.35)';
                    ctx.fill();

                    ctx.beginPath();
                    ctx.arc(nx, ny, radius + 4, 0, Math.PI * 2);
                    ctx.strokeStyle = '#ffffff';
                    ctx.lineWidth = 2.5;
                    ctx.stroke();
                } else if (isHovered) {
                    ctx.beginPath();
                    ctx.arc(nx, ny, radius + 5, 0, Math.PI * 2);
                    ctx.fillStyle = 'rgba(52, 211, 153, 0.35)';
                    ctx.fill();
                } else if (isMatch) {
                    ctx.beginPath();
                    ctx.arc(nx, ny, radius + 6, 0, Math.PI * 2);
                    ctx.fillStyle = 'rgba(234, 179, 8, 0.4)';
                    ctx.fill();
                }

                if (inspectorHoverNode === n) {
                    ctx.save();
                    ctx.beginPath();
                    ctx.arc(nx, ny, radius + 10, 0, Math.PI * 2);
                    ctx.fillStyle = 'rgba(56, 189, 248, 0.35)';
                    ctx.fill();
                    ctx.strokeStyle = '#ffffff';
                    ctx.lineWidth = 2.5;
                    ctx.stroke();
                    ctx.restore();
                }

                ctx.beginPath();
                if (isRoute) {
                    const rw = 20 * (n.renderScale || 1), rh = 14 * (n.renderScale || 1);
                    ctx.rect(nx - rw / 2, ny - rh / 2, rw, rh);
                } else {
                    ctx.arc(nx, ny, radius, 0, Math.PI * 2);
                }
                ctx.fillStyle = isMatch ? '#eab308' : (isSelected ? '#10b981' : (isHovered ? '#34d399' : nodeColor));
                ctx.fill();
                ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
                ctx.lineWidth = 1.2;
                ctx.stroke();

                if (isSelected || isHovered || isUpstream || isDownstream || isMatch || isRoute || n.degree > 0 || view.scale > 0.85 || (highlightIsolated && isIsolated) || (highlightDirty && isDirty)) {
                    ctx.font = isSelected ? 'bold 12px sans-serif' : '11px sans-serif';
                    const labelText = isRoute ? (n.path || n.title) : n.title;
                    const textW = ctx.measureText(labelText).width;
                    ctx.fillStyle = isSelected ? 'rgba(15, 23, 42, 0.95)' : 'rgba(15, 23, 42, 0.75)';
                    ctx.fillRect(nx - textW / 2 - 4, ny + radius + 4, textW + 8, 16);
                    ctx.fillStyle = isSelected ? '#34d399' : (isHovered ? '#ffffff' : (isUpstream ? '#7dd3fc' : (isDownstream ? '#fcd34d' : (isMatch ? '#fde047' : '#cbd5e1'))));
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'middle';
                    ctx.fillText(labelText, nx, ny + radius + 12);
                }

                ctx.restore();
            });

            if (typeof customOverlayRenderer === 'function') {
                customOverlayRenderer({
                    ctx: ctx,
                    nodes: visibleNodes,
                    links: links,
                    isNodeVisible: isNodeVisible,
                    getNodeRadius: getNodeRadius,
                    selectedNode: selectedNode,
                    hoveredNode: hoveredNode,
                    focusNode: focusNode
                });
            }

            ctx.restore();
        }

        function loop() {
            updatePhysics();
            render();
            requestAnimationFrame(loop);
        }
        loop();

        function getTransformedPoint(clientX, clientY) {
            const rect = canvas.getBoundingClientRect();
            const scaleX = rect.width ? (width / rect.width) : 1;
            const scaleY = rect.height ? (height / rect.height) : 1;
            const x = (clientX - rect.left) * scaleX;
            const y = (clientY - rect.top) * scaleY;
            const wx = (x - width / 2 - view.x) / view.scale + width / 2;
            const wy = (y - height / 2 - view.y) / view.scale + height / 2;
            return { x: wx, y: wy };
        }

        function findNodeAt(clientX, clientY) {
            const p = getTransformedPoint(clientX, clientY);
            const candidates = nodes.filter(isNodeVisible).sort(function(a, b) {
                return (b.renderZ || 0) - (a.renderZ || 0);
            });
            for (let i = 0; i < candidates.length; i++) {
                const n = candidates[i];
                const nx = n.renderX !== undefined ? n.renderX : n.x;
                const ny = n.renderY !== undefined ? n.renderY : n.y;
                const radius = getNodeRadius(n) * (n.renderScale || 1) + 6;
                const dx = nx - p.x;
                const dy = ny - p.y;
                if (dx * dx + dy * dy <= radius * radius) {
                    return n;
                }
            }
            return null;
        }

        canvas.addEventListener('mousedown', function(e) {
            mouseDownPos = { x: e.clientX, y: e.clientY };
            pauseOrbitTemporarily(false);
            const node = findNodeAt(e.clientX, e.clientY);
            if (node) {
                draggedNode = node;
                draggedNode._dragRz = node.renderZ || 0;
            } else {
                isDraggingView = true;
                startX = e.clientX - view.x;
                startY = e.clientY - view.y;
            }
        });

        window.addEventListener('mousemove', function(e) {
            const hoverCard = document.getElementById('admin-wiki-hover-card') || document.getElementById('wiki-hover-card');

            if (draggedNode) {
                const p = getTransformedPoint(e.clientX, e.clientY);
                if (hierarchicalMode) {
                    draggedNode.x = p.x;
                    draggedNode.y = p.y;
                } else {
                    const cx = width / 2;
                    const rx = p.x - cx;
                    const rz = draggedNode._dragRz || 0;
                    const cosA = Math.cos(orbitAngle);
                    const sinA = Math.sin(orbitAngle);
                    draggedNode.x = cx + rx * cosA + rz * sinA;
                    draggedNode.zOffset = -rx * sinA + rz * cosA;
                    draggedNode.y = p.y;
                }
                draggedNode.vx = 0;
                draggedNode.vy = 0;
                pauseOrbitTemporarily(false);
                if (hoverCard) hoverCard.classList.add('hidden');
                return;
            }

            if (isDraggingView) {
                view.x = e.clientX - startX;
                view.y = e.clientY - startY;
                pauseOrbitTemporarily(false);
                if (hoverCard) hoverCard.classList.add('hidden');
                return;
            }

            const prevHovered = hoveredNode;
            const node = findNodeAt(e.clientX, e.clientY);
            hoveredNode = node;
            if (node) {
                pauseOrbitTemporarily(false);
            } else if (prevHovered && !node) {
                pauseOrbitTemporarily(true);
            }
            const activeNode = selectedNode || node;

            if (activeNode && hoverCard) {
                const rect = canvas.getBoundingClientRect();
                hoverCard.style.left = Math.min(rect.width - 240, Math.max(10, e.clientX - rect.left + 16)) + 'px';
                hoverCard.style.top = Math.min(rect.height - 130, Math.max(10, e.clientY - rect.top + 16)) + 'px';

                const titleElem = document.getElementById('admin-hover-title') || document.getElementById('hover-card-title');
                const slugElem = document.getElementById('admin-hover-slug') || document.getElementById('hover-card-slug');
                const degreeElem = document.getElementById('admin-hover-degree') || document.getElementById('hover-card-degree');

                if (titleElem) titleElem.innerText = (selectedNode === activeNode ? '★ ' : '') + activeNode.title;
                if (slugElem) {
                    const tagType = activeNode.type.toUpperCase();
                    let slugText = (activeNode.path || ('/' + activeNode.slug)) + ' [' + tagType + ' · L' + activeNode.level + ']';
                    if (activeNode.is_dirty) {
                        slugText += ' ⚠️';
                    }
                    slugElem.innerText = slugText;
                }
                if (degreeElem) {
                    let info = '🔗 ' + (t('wiki.node_degree') || 'Connections: ') + activeNode.degree;
                    if (activeNode.heat > 0) {
                        info += ' · 🔥 ' + (t('wiki.heat_metric') || 'Heat: ') + activeNode.heat;
                    }
                    if (activeNode.is_dirty) {
                        info += ' · ' + (t('wiki.status_dirty') || 'Draft');
                    }
                    degreeElem.innerText = info;
                }

                hoverCard.classList.remove('hidden');
            } else if (hoverCard) {
                hoverCard.classList.add('hidden');
            }
        });

        window.closeWikiInspector = function() {
            selectedNode = null;
            const insp = document.getElementById('admin-wiki-inspector');
            if (insp) insp.classList.add('hidden');
        };

        function getNodeEditHref(targetNode) {
            if (!targetNode) return '';
            const t = String(targetNode.type || '').toLowerCase();
            if (t === 'page' || t === 'single' || t === 'template' || t === 'redirect') {
                return targetNode.id ? ('/admin/pages/edit/' + encodeURIComponent(targetNode.id)) : '';
            }
            if (t === 'article') {
                return targetNode.id ? ('/admin/articles/edit/' + encodeURIComponent(targetNode.id)) : '';
            }
            if (t === 'dataset') {
                return targetNode.path && targetNode.path.startsWith('/admin/')
                    ? targetNode.path
                    : ('/admin/datasets/collection/' + encodeURIComponent(targetNode.slug || ''));
            }
            if (t === 'micro' || t === 'note') {
                if (targetNode.entity_id) {
                    return '/admin/micros/edit/' + encodeURIComponent(targetNode.entity_id);
                }
                if (targetNode.path && targetNode.path.startsWith('/admin/')) {
                    return targetNode.path;
                }
                if (targetNode.id && !String(targetNode.id).startsWith('hub_micro_')) {
                    return '/admin/micros/edit/' + encodeURIComponent(targetNode.id);
                }
                return '/admin/micros';
            }
            if (t === 'route') {
                if (targetNode.entity_id) {
                    const et = String(targetNode.entity_type || '').toLowerCase();
                    if (et === 'article') return '/admin/articles/edit/' + encodeURIComponent(targetNode.entity_id);
                    if (et === 'page' || et === 'single' || et === 'template' || et === 'redirect') {
                        return '/admin/pages/edit/' + encodeURIComponent(targetNode.entity_id);
                    }
                }
                const boundLink = links.find(function(l) {
                    return l.source === targetNode && l.relationType === 'route_binds' && l.target && l.target !== targetNode;
                });
                if (boundLink) return getNodeEditHref(boundLink.target);
            }
            return '';
        }

        function getNodeViewHref(targetNode) {
            if (!targetNode) return '';
            const t = String(targetNode.type || '').toLowerCase();
            if (t === 'page' || t === 'single') {
                return targetNode.slug === '/' || targetNode.slug === 'index'
                    ? '/'
                    : ('/' + String(targetNode.slug || '').replace(/^\/+/, ''));
            }
            if (t === 'article') {
                return '/' + String(targetNode.slug || '').replace(/^\/+/, '');
            }
            if (t === 'route') {
                return targetNode.path || '/';
            }
            return '';
        }

        function renderRelationList(listEl, nodeSet, accentClass) {
            if (!listEl) return;
            const items = Array.from(nodeSet || []);
            if (items.length === 0) {
                const emptyText = t('wiki.inspector_no_items') || 'No linked nodes';
                listEl.innerHTML = '<div class="text-[11px] text-stone-500 italic px-2 py-1">' + emptyText + '</div>';
                return;
            }
            listEl.innerHTML = '';
            items.forEach(function(item) {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'w-full text-left px-2.5 py-1.5 rounded-xl bg-stone-950/60 hover:bg-stone-800 border border-stone-800/80 flex items-center justify-between gap-2 text-[11px] transition cursor-pointer';
                const dotColor = colorMap[item.type] || '#10b981';
                const left = document.createElement('span');
                left.className = 'flex items-center space-x-2 min-w-0';
                const dot = document.createElement('span');
                dot.className = 'w-2 h-2 rounded-full shrink-0';
                dot.style.backgroundColor = dotColor;
                const txt = document.createElement('span');
                txt.className = 'truncate text-stone-200 font-medium';
                txt.textContent = item.title || item.path || item.slug || item.id;
                left.appendChild(dot);
                left.appendChild(txt);
                const badge = document.createElement('span');
                badge.className = 'text-[9px] font-mono uppercase shrink-0 ' + accentClass;
                badge.textContent = item.type || 'node';
                btn.appendChild(left);
                btn.appendChild(badge);

                btn.addEventListener('mouseenter', function() {
                    inspectorHoverNode = item;
                });
                btn.addEventListener('mouseleave', function() {
                    if (inspectorHoverNode === item) inspectorHoverNode = null;
                });
                btn.addEventListener('click', function() {
                    inspectorHoverNode = null;
                    selectedNode = item;
                    updateWikiInspector(item);
                });
                listEl.appendChild(btn);
            });
        }

        function updateWikiInspector(node) {
            const insp = document.getElementById('admin-wiki-inspector');
            if (!insp) return;
            if (!node) {
                inspectorHoverNode = null;
                insp.classList.add('hidden');
                window.dispatchEvent(new CustomEvent('walnut:wiki-inspector-change', { detail: { node: null, impact: null } }));
                return;
            }
            const typeEl = document.getElementById('inspector-node-type');
            const statusEl = document.getElementById('inspector-node-status');
            const titleEl = document.getElementById('inspector-node-title');
            const pathEl = document.getElementById('inspector-node-path');
            const createdEl = document.getElementById('inspector-node-created');
            const inEl = document.getElementById('inspector-node-in');
            const outEl = document.getElementById('inspector-node-out');
            const upListEl = document.getElementById('inspector-upstream-list');
            const downListEl = document.getElementById('inspector-downstream-list');
            const editBtn = document.getElementById('inspector-btn-edit');
            const viewBtn = document.getElementById('inspector-btn-view');

            const impact = computeImpactSets(node);
            if (typeEl) typeEl.textContent = (node.type || 'node').toUpperCase();
            if (statusEl) {
                if (node.is_dirty) {
                    statusEl.textContent = t('wiki.status_dirty_label') || 'Dirty';
                    statusEl.className = 'px-1.5 py-0.5 rounded font-mono text-[10px] font-bold bg-amber-500/20 text-amber-300 border border-amber-500/30';
                } else if (node.degree === 0) {
                    statusEl.textContent = t('wiki.status_isolated') || 'Isolated';
                    statusEl.className = 'px-1.5 py-0.5 rounded font-mono text-[10px] font-bold bg-purple-500/20 text-purple-300 border border-purple-500/30';
                } else {
                    statusEl.textContent = t('wiki.status_normal') || 'Normal';
                    statusEl.className = 'px-1.5 py-0.5 rounded font-mono text-[10px] font-bold bg-amber-500/20 text-amber-300 border border-amber-500/30';
                }
            }
            if (titleEl) titleEl.textContent = node.title || node.slug || node.id;
            if (pathEl) pathEl.textContent = node.path || ('/' + (node.slug || ''));
            if (createdEl) {
                createdEl.textContent = node.created_at ? String(node.created_at).slice(0, 19).replace('T', ' ') : '';
            }
            if (inEl) inEl.textContent = String(impact.upstream.size);
            if (outEl) outEl.textContent = String(impact.downstream.size);

            renderRelationList(upListEl, impact.upstream, 'text-sky-400');
            renderRelationList(downListEl, impact.downstream, 'text-amber-400');

            const editHref = getNodeEditHref(node);
            const viewHref = getNodeViewHref(node);

            if (editBtn) {
                if (editHref) { editBtn.href = editHref; editBtn.classList.remove('hidden'); }
                else { editBtn.removeAttribute('href'); editBtn.classList.add('hidden'); }
            }
            if (viewBtn) {
                if (viewHref) { viewBtn.href = viewHref; viewBtn.classList.remove('hidden'); }
                else { viewBtn.removeAttribute('href'); viewBtn.classList.add('hidden'); }
            }

            insp.classList.remove('hidden');
            window.dispatchEvent(new CustomEvent('walnut:wiki-inspector-change', { detail: { node: node, impact: impact } }));
        }

        window.__walnutWikiGraph = {
            getNodes: function() { return nodes; },
            getLinks: function() { return links; },
            getSelectedNode: function() { return selectedNode; },
            isHighlightIsolated: function() { return highlightIsolated; },
            setOverlayRenderer: function(fn) { customOverlayRenderer = fn; },
            selectNodeById: function(id) {
                const target = nodes.find(function(n) { return n.id === id; });
                if (target) {
                    selectedNode = target;
                    updateWikiInspector(target);
                }
            },
            removeNodeById: function(id) {
                const idx = nodes.findIndex(function(n) { return n.id === id; });
                if (idx !== -1) {
                    const removed = nodes.splice(idx, 1)[0];
                    for (let i = links.length - 1; i >= 0; i--) {
                        if (links[i].source === removed || links[i].target === removed) {
                            links.splice(i, 1);
                        }
                    }
                    if (selectedNode === removed) {
                        selectedNode = null;
                        updateWikiInspector(null);
                    }
                    updateStatsLabel();
                }
            }
        };

        window.addEventListener('mouseup', function(e) {
            const wasInteractingWithCanvas = Boolean(draggedNode || isDraggingView);
            draggedNode = null;
            isDraggingView = false;
            if (wasInteractingWithCanvas && !hoveredNode) {
                pauseOrbitTemporarily(true);
            }
            if (!wasInteractingWithCanvas || e.target !== canvas) return;
            const distMoved = Math.hypot(e.clientX - mouseDownPos.x, e.clientY - mouseDownPos.y);
            if (distMoved < 5) {
                const clickedNode = findNodeAt(e.clientX, e.clientY);
                selectedNode = (selectedNode === clickedNode) ? null : clickedNode;
                updateWikiInspector(selectedNode);
            }
        });

        canvas.addEventListener('wheel', function(e) {
            e.preventDefault();
            const zoomFactor = e.deltaY < 0 ? 1.1 : 0.9;
            view.scale = Math.max(0.3, Math.min(3.5, view.scale * zoomFactor));
        }, { passive: false });

        canvas.addEventListener('dblclick', function(e) {
            const node = findNodeAt(e.clientX, e.clientY);
            if (!node) return;
            const editHref = getNodeEditHref(node);
            if (editHref) {
                window.location.href = editHref;
            } else if (node.type === 'route') {
                window.open(node.path || '/', '_blank');
            }
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initWikiGraph);
    } else {
        initWikiGraph();
    }
})();
