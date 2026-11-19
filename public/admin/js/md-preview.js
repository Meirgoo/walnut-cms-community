(function() {
    'use strict';

    function escHtml(str) {
        return String(str || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    function escAttr(str) {
        return escHtml(str).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function safeUrl(url) {
        var u = String(url || '').trim();
        var clean = u.replace(/[\x00-\x1f\x7f\s]+/g, '');
        if (/^(?:javascript|vbscript|data|blob):/i.test(clean)) return '#blocked';
        return escAttr(u);
    }

    function parseInline(text) {
        var out = String(text || '');
        // Stash inline code spans before link/emphasis replacements so markdown syntax inside backticks is preserved.
        var codeTokens = [];
        out = out.replace(/`([^`\n]+)`/g, function(_, code) {
            var idx = codeTokens.length;
            codeTokens.push('<code class="px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 font-mono text-xs text-emerald-600 dark:text-emerald-400">' + escHtml(code) + '</code>');
            return '\x00INLCODE' + idx + '\x00';
        });

        out = out
            .replace(/!\[([^\[\]\n]*)\]\(([^)\n]+)\)/g, function(_, alt, src) {
                return '<img src="' + safeUrl(src) + '" alt="' + escAttr(alt) + '" class="rounded-xl max-w-full h-auto my-3 shadow-sm" />';
            })
            .replace(/\[([^\[\]\n]+)\]\(([^)\n]+)\)/g, function(_, label, href) {
                return '<a href="' + safeUrl(href) + '" target="_blank" rel="noopener" class="text-emerald-600 dark:text-emerald-400 font-semibold hover:underline">' + label + '</a>';
            })
            .replace(/\[\[([^\[\]\n|]+)\|([^\[\]\n]+)\]\]/g, function(_, slug, label) {
                return '<a href="/' + escAttr(slug.trim()) + '" class="text-emerald-600 dark:text-emerald-400 font-semibold hover:underline">' + escHtml(label.trim()) + '</a>';
            })
            .replace(/\[\[([^\[\]\n:：]+)\]\]/g, function(_, slug) {
                return '<a href="/' + escAttr(slug.trim()) + '" class="text-emerald-600 dark:text-emerald-400 font-semibold hover:underline">' + escHtml(slug.trim()) + '</a>';
            })
            .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
            .replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
            .replace(/\*([^*\n]+)\*/g, '<em>$1</em>');

        return out.replace(/\x00INLCODE(\d+)\x00/g, function(_, idx) {
            return codeTokens[Number(idx)] || '';
        });
    }

    function parseMarkdown(raw) {
        if (!raw || typeof raw !== 'string') return '';

        var codeBlocks = [];
        var src = raw.replace(/\r\n/g, '\n').replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, function(_, lang, code) {
            var idx = codeBlocks.length;
            codeBlocks.push('<pre class="bg-slate-900 text-emerald-400 p-4 rounded-xl overflow-x-auto text-xs font-mono my-4"><code class="language-' + escAttr(lang || 'text') + '">' + escHtml(code.replace(/\n$/, '')) + '</code></pre>');
            return '\n\n\x00CODEBLK' + idx + '\x00\n\n';
        });

        var lines = src.split('\n');
        var htmlParts = [];
        var i = 0;

        while (i < lines.length) {
            var loopStartIdx = i;
            var line = lines[i];
            var trimmed = line.trim();

            if (!trimmed) { i++; continue; }

            var cbMatch = trimmed.match(/^\x00CODEBLK(\d+)\x00$/);
            if (cbMatch) {
                htmlParts.push(codeBlocks[Number(cbMatch[1])] || '');
                i++;
                continue;
            }

            // Pass through pre-processed HTML blocks (e.g. WALNUTPREVIEWMD blocks) verbatim.
            if (/^<(?:div|blockquote|section|article|table|ul|ol|pre|h[1-6]|hr)\b/i.test(trimmed)) {
                var rawHtmlBuf = [line];
                i++;
                while (i < lines.length && lines[i].trim() !== '') {
                    rawHtmlBuf.push(lines[i]);
                    i++;
                }
                htmlParts.push(rawHtmlBuf.join('\n'));
                continue;
            }

            var hMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
            if (hMatch) {
                var lvl = hMatch[1].length;
                htmlParts.push('<h' + lvl + '>' + parseInline(hMatch[2]) + '</h' + lvl + '>');
                i++;
                continue;
            }

            if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
                htmlParts.push('<hr class="my-6 border-slate-200 dark:border-slate-700" />');
                i++;
                continue;
            }

            if (trimmed.indexOf('|') !== -1 && i + 1 < lines.length && /^\s*\|?(?:\s*:?-+:?\s*\|)+\s*:?-+:?\s*\|?\s*$/.test(lines[i + 1])) {
                var parseCells = function(rowStr) {
                    return rowStr.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(function(c) { return c.trim(); });
                };
                var headers = parseCells(trimmed);
                i += 2;
                var bodyRows = [];
                while (i < lines.length && lines[i].trim().indexOf('|') !== -1) {
                    bodyRows.push(parseCells(lines[i]));
                    i++;
                }
                var tbl = '<table class="w-full text-xs border-collapse my-4"><thead><tr>'
                    + headers.map(function(h) { return '<th class="border border-slate-200 dark:border-slate-700 px-3 py-2 bg-slate-50 dark:bg-slate-800 text-left font-bold">' + parseInline(h) + '</th>'; }).join('')
                    + '</tr></thead><tbody>'
                    + bodyRows.map(function(r) {
                        return '<tr>' + r.map(function(c) { return '<td class="border border-slate-200 dark:border-slate-700 px-3 py-2">' + parseInline(c) + '</td>'; }).join('') + '</tr>';
                    }).join('')
                    + '</tbody></table>';
                htmlParts.push(tbl);
                continue;
            }

            if (/^>\s?/.test(trimmed)) {
                var qLines = [];
                while (i < lines.length && /^\s*>/.test(lines[i])) {
                    qLines.push(lines[i].replace(/^\s*>\s?/, ''));
                    i++;
                }
                htmlParts.push('<blockquote class="border-l-4 border-emerald-500 pl-4 py-1 my-4 italic text-slate-600 dark:text-slate-400">' + qLines.map(parseInline).join('<br />') + '</blockquote>');
                continue;
            }

            if (/^[-*+]\s+/.test(trimmed)) {
                var ulItems = [];
                while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
                    var itemTxt = lines[i].replace(/^\s*[-*+]\s+/, '');
                    var taskM = itemTxt.match(/^\[( |x|X)\]\s+(.*)$/);
                    if (taskM) {
                        var checked = taskM[1].toLowerCase() === 'x';
                        ulItems.push('<li class="list-none flex items-center space-x-2"><input type="checkbox" disabled ' + (checked ? 'checked' : '') + ' class="rounded text-emerald-600" /><span>' + parseInline(taskM[2]) + '</span></li>');
                    } else {
                        ulItems.push('<li>' + parseInline(itemTxt) + '</li>');
                    }
                    i++;
                }
                htmlParts.push('<ul class="list-disc pl-5 my-3 space-y-1">' + ulItems.join('') + '</ul>');
                continue;
            }

            if (/^\d+\.\s+/.test(trimmed)) {
                var olItems = [];
                while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
                    olItems.push('<li>' + parseInline(lines[i].replace(/^\s*\d+\.\s+/, '')) + '</li>');
                    i++;
                }
                htmlParts.push('<ol class="list-decimal pl-5 my-3 space-y-1">' + olItems.join('') + '</ol>');
                continue;
            }

            var pLines = [];
            while (i < lines.length) {
                var cur = lines[i].trim();
                // Break only on block-level HTML tags so inline HTML or rendered [[wiki]] links at line start never stall the loop.
                if (pLines.length > 0 && (!cur || /^(?:#{1,6}\s|>|[-*+]\s|\d+\.\s|(?:-{3,}|\*{3,}|_{3,})$|\x00CODEBLK|<(?:div|blockquote|section|article|table|ul|ol|pre|h[1-6]|hr)\b)/i.test(cur))) break;
                pLines.push(parseInline(lines[i]));
                i++;
            }
            if (pLines.length > 0) {
                htmlParts.push('<p class="leading-relaxed mb-4">' + pLines.join('<br />') + '</p>');
            }

            // Guarantee monotonic forward progress so unexpected line prefixes can never spin infinitely.
            if (i <= loopStartIdx) {
                htmlParts.push('<p class="leading-relaxed mb-4">' + parseInline(lines[loopStartIdx]) + '</p>');
                i = loopStartIdx + 1;
            }
        }

        return htmlParts.join('\n');
    }

    window.marked = {
        parse: parseMarkdown,
        parseInline: parseInline
    };

    if (typeof window.updatePreview === 'function') {
        window.updatePreview();
    }
})();
