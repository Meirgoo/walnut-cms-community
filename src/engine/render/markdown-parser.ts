import { renderTemplate } from './template';
import { escapeHtmlAttr } from '../core/utils';

export { escapeHtmlAttr };

// Escape HTML-significant characters so embedded JSON cannot break out of an inline <script> tag.
export function safeJsonStringify(obj: any): string {
    return JSON.stringify(obj)
        .replace(/</g, '\\u003c')
        .replace(/>/g, '\\u003e')
        .replace(/\//g, '\\u002f')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
}

// Reject dangerous URI schemes (including control-char obfuscation) and HTML attribute breakout characters.
export function sanitizeUrlAttr(rawUrl: string): string {
    if (!rawUrl || typeof rawUrl !== 'string') return '#blocked';
    const trimmed = rawUrl.trim();
    const disarmed = trimmed.replace(/[\x00-\x1f\x7f\s]+/g, '');
    if (/^(?:javascript|vbscript|data|blob):/i.test(disarmed)) {
        return '#blocked';
    }
    if (/["'<>]|\bon[a-z]+\s*=/i.test(trimmed)) {
        return '#blocked';
    }
    return escapeHtmlAttr(trimmed);
}

export function renderMarkdownToHtml(md: string): string {
    if (!md || typeof md !== 'string') return '';
    const trimmed = md.trim();
    if (!trimmed || trimmed.startsWith('[{') || trimmed === '[]') return '';

    const codeBlockTokens: string[] = [];
    const inlineCodeTokens: string[] = [];

    // Tokenize fenced and inline code first so [[wikilinks]] and markdown inside code stay unparsed.
    let html = trimmed.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, (_, l, c) => {
            const idx = codeBlockTokens.length;
            codeBlockTokens.push(`<pre><code class="language-${l || 'text'}">${c.trim()}</code></pre>`);
            return `\n\n\x00MDSRVCODEBLK${idx}\x00\n\n`;
        })
        .replace(/`([^`\n]+)`/g, (_, c) => {
            const idx = inlineCodeTokens.length;
            inlineCodeTokens.push(`<code>${c}</code>`);
            return `\x00MDSRVINLCODE${idx}\x00`;
        })
        .replace(/^(#{1,4})\s+(.+)$/gm, (_, h, t) => `<h${h.length}>${t}</h${h.length}>`)
        .replace(/^&gt;\s+(.+)$/gm, '<blockquote>$1</blockquote>')
        .replace(/!\[([^\[\]\n]*)\]\(([^)\n]+)\)/g, (_, a, s) => `<img src="${sanitizeUrlAttr(s)}" alt="${escapeHtmlAttr(a)}" />`)
        .replace(/\[([^\[\]\n]+)\]\(([^)\n]+)\)/g, (_, t, h) => `<a href="${sanitizeUrlAttr(h)}">${t}</a>`)
        .replace(/\[\[([^\[\]\n|]+)\|([^\[\]\n]+)\]\]/g, (_, target, label) => `<a href="${sanitizeUrlAttr('/' + String(target).replace(/^\/+/, ''))}">${label}</a>`)
        .replace(/\[\[([^\[\]\n]+)\]\]/g, (_, target) => `<a href="${sanitizeUrlAttr('/' + String(target).replace(/^\/+/, ''))}">${target}</a>`)
        .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
        .replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
        .replace(/\x00MDSRVINLCODE(\d+)\x00/g, (_, idx) => inlineCodeTokens[Number(idx)] || '')
        .replace(/\x00MDSRVCODEBLK(\d+)\x00/g, (_, idx) => codeBlockTokens[Number(idx)] || '');

    return html.split(/\n{2,}/).map(blk => {
        const b = blk.trim();
        return !b ? '' : (/^<(h[1-6]|pre|blockquote|div|img)/i.test(b) ? b : `<p>${b.replace(/\n/g, '<br />')}</p>`);
    }).join('\n');
}

export function processThemeMarkdownComponents(contentRaw: string, themeMeta?: any): string {
    if (!contentRaw || typeof contentRaw !== 'string') return '';
    const trimmed = contentRaw.trim();
    if (trimmed.startsWith('[{') || trimmed === '[]') return '';

    const themeMdComps: Record<string, string> = {
        ...(themeMeta?.md_components || {})
    };

    if (Object.keys(themeMdComps).length === 0) {
        return renderMarkdownToHtml(contentRaw);
    }

    const placeholders: string[] = [];
    const getCompTpl = (k: string) => themeMdComps[k] || themeMdComps[k.toLowerCase()];

    let processed = contentRaw;

    const compTagNames = Array.from(new Set(Object.keys(themeMdComps).flatMap(k => [k, k.toLowerCase(), k.replace(/[-_]/g, '')])));
    if (compTagNames.length > 0) {
        const tagPattern = new RegExp(`<(${compTagNames.join('|')})\\b[^>]*>([\\s\\S]*?)<\\/\\1>`, 'gi');
        processed = processed.replace(tagPattern, (_match, tag, inner) => {
            const tpl = getCompTpl(tag);
            if (tpl) {
                const innerHtml = renderMarkdownToHtml(inner.trim()).replace(/^<p[^>]*>([\s\S]*)<\/p>$/, '$1');
                const compHtml = renderTemplate(tpl, { content: innerHtml }, false);
                const idx = placeholders.length;
                placeholders.push(compHtml);
                return `\n\nWALNUTMDCOMPPLACEHOLDER${idx}TOKEN\n\n`;
            }
            return _match;
        });

        const containerPattern = new RegExp(`:::(${compTagNames.join('|')})(?:[ \\t]+[^\\n]*)?\\n([\\s\\S]*?)\\n:::`, 'gi');
        processed = processed.replace(containerPattern, (_match, tag, inner) => {
            const tpl = getCompTpl(tag);
            if (tpl) {
                const innerHtml = renderMarkdownToHtml(inner.trim()).replace(/^<p[^>]*>([\s\S]*)<\/p>$/, '$1');
                const compHtml = renderTemplate(tpl, { content: innerHtml }, false);
                const idx = placeholders.length;
                placeholders.push(compHtml);
                return `\n\nWALNUTMDCOMPPLACEHOLDER${idx}TOKEN\n\n`;
            }
            return _match;
        });
    }

    // Track bracket depth so nested [[wikilinks]] inside [[tag: ...]] do not close the outer component early.
    const prefixRegex = /\[\[([a-zA-Z0-9_\u4e00-\u9fa5-]+)\s*[:：]\s*/g;
    let match: RegExpExecArray | null;
    let lastIndex = 0;
    let result = '';

    while ((match = prefixRegex.exec(processed)) !== null) {
        const tag = match[1];
        const tpl = getCompTpl(tag);
        if (!tpl) {
            continue;
        }

        const startIndex = match.index;
        const contentStart = startIndex + match[0].length;
        let depth = 0;
        let closingIndex = -1;

        for (let i = contentStart; i < processed.length - 1; i++) {
            if (processed[i] === '[' && processed[i + 1] === '[') {
                depth++;
                i++;
            } else if (processed[i] === ']' && processed[i + 1] === ']') {
                if (depth > 0) {
                    depth--;
                    i++;
                } else {
                    closingIndex = i;
                    break;
                }
            }
        }

        if (closingIndex !== -1) {
            result += processed.slice(lastIndex, startIndex);
            const innerContent = processed.slice(contentStart, closingIndex);
            const innerHtml = renderMarkdownToHtml(innerContent.trim()).replace(/^<p[^>]*>([\s\S]*)<\/p>$/, '$1');
            const compHtml = renderTemplate(tpl, { content: innerHtml }, false);
            const idx = placeholders.length;
            placeholders.push(compHtml);
            result += `\n\nWALNUTMDCOMPPLACEHOLDER${idx}TOKEN\n\n`;
            lastIndex = closingIndex + 2;
            prefixRegex.lastIndex = lastIndex;
        }
    }
    result += processed.slice(lastIndex);
    processed = result;

    let html = renderMarkdownToHtml(processed);
    placeholders.forEach((compHtml, idx) => {
        const tokenRegex = new RegExp(`<p[^>]*>\\s*WALNUTMDCOMPPLACEHOLDER${idx}TOKEN\\s*<\\/p>|WALNUTMDCOMPPLACEHOLDER${idx}TOKEN`, 'g');
        html = html.replace(tokenRegex, compHtml);
    });

    return html;
}
