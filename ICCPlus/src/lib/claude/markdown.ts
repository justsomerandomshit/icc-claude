// Minimal Markdown -> HTML for chat replies: paragraphs, headings, lists, code,
// bold/italic, links. Output is sanitised with DOMPurify before it is rendered.

import DOMPurify from 'dompurify';

function escape(s: string) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function inline(s: string) {
    const codes: string[] = [];
    let t = escape(s).replace(/`([^`]+)`/g, (_, c) => {
        codes.push(`<code>${c}</code>`);
        return `\u0000${codes.length - 1}\u0000`;
    });
    t = t
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
        .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    return t.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[Number(i)]);
}

export function renderMarkdown(src: string): string {
    const lines = src.replace(/\r\n/g, '\n').split('\n');
    const html: string[] = [];
    let para: string[] = [];
    let list: { tag: 'ul' | 'ol'; items: string[] } | null = null;

    const flushPara = () => {
        if (para.length) html.push(`<p>${para.map(inline).join('<br>')}</p>`);
        para = [];
    };
    const flushList = () => {
        if (list) html.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`);
        list = null;
    };

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const fence = /^```/.exec(line);
        if (fence) {
            flushPara();
            flushList();
            const body: string[] = [];
            i++;
            while (i < lines.length && !/^```/.test(lines[i])) body.push(lines[i++]);
            html.push(`<pre><code>${escape(body.join('\n'))}</code></pre>`);
            continue;
        }
        const heading = /^(#{1,4})\s+(.*)$/.exec(line);
        if (heading) {
            flushPara();
            flushList();
            html.push(`<h${heading[1].length + 2}>${inline(heading[2])}</h${heading[1].length + 2}>`);
            continue;
        }
        const ul = /^\s*[-*]\s+(.*)$/.exec(line);
        const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
        if (ul || ol) {
            flushPara();
            const tag = ul ? 'ul' : 'ol';
            if (!list || list.tag !== tag) {
                flushList();
                list = { tag, items: [] };
            }
            list.items.push((ul ?? ol)![1]);
            continue;
        }
        if (line.trim() === '') {
            flushPara();
            flushList();
            continue;
        }
        if (list) flushList();
        para.push(line);
    }
    flushPara();
    flushList();
    return DOMPurify.sanitize(html.join(''), { ADD_ATTR: ['target'] });
}
