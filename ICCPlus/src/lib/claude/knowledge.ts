// Lets Claude look up how any editor control maps to project fields by searching
// the creator's own source (labels sit next to `bind:` expressions), the help
// page, and the type definitions. Loaded lazily so the main bundle stays small,
// and always in sync with the code that ships.

type SourceFile = { name: string; lines: string[] };

const loaders = import.meta.glob(
    ['../creator/**/*.svelte', '../store/types.ts', '../information/InfoMain.svelte', '../store/ImageUpload.svelte', '../store/PictureInput.svelte'],
    { query: '?raw', import: 'default' }
) as Record<string, () => Promise<string>>;

let cache: Promise<SourceFile[]> | null = null;

function loadAll(): Promise<SourceFile[]> {
    if (!cache) {
        cache = Promise.all(
            Object.entries(loaders).map(async ([path, load]) => ({
                name: path.replace(/^\.\.\//, 'src/lib/'),
                lines: (await load()).split('\n')
            }))
        ).catch((e) => {
            cache = null;
            throw e;
        });
    }
    return cache;
}

export type SearchScope = 'ui' | 'help' | 'types' | 'all';

function inScope(name: string, scope: SearchScope) {
    if (scope === 'all') return true;
    if (scope === 'types') return name.endsWith('types.ts');
    if (scope === 'help') return name.includes('information/');
    return !name.endsWith('types.ts') && !name.includes('information/');
}

/** Rank source lines by how many query terms they contain; return small windows around the best hits. */
export async function searchSource(query: string, scope: SearchScope = 'ui', maxResults = 10): Promise<string> {
    const files = await loadAll();
    const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 1);
    if (terms.length === 0) return 'Give at least one search term.';

    type Hit = { file: SourceFile; line: number; score: number };
    const hits: Hit[] = [];
    for (const file of files) {
        if (!inScope(file.name, scope)) continue;
        file.lines.forEach((text, i) => {
            const lower = text.toLowerCase();
            let score = 0;
            for (const t of terms) if (lower.includes(t)) score += 1;
            if (score === 0) return;
            if (score === terms.length) score += 2;
            if (/label=|<Label>|title:|text:|<span/.test(text)) score += 0.5;
            if (/bind:(checked|value)/.test(text)) score += 0.5;
            hits.push({ file, line: i, score });
        });
    }
    hits.sort((a, b) => b.score - a.score);

    const taken: { file: SourceFile; from: number; to: number }[] = [];
    for (const h of hits) {
        if (taken.length >= maxResults) break;
        const from = Math.max(0, h.line - 3);
        const to = Math.min(h.file.lines.length - 1, h.line + 4);
        if (taken.some((t) => t.file === h.file && !(to < t.from || from > t.to))) continue;
        taken.push({ file: h.file, from, to });
    }
    if (taken.length === 0) return `No matches for "${query}" in ${scope} sources.`;

    return taken
        .map((t) => {
            const body = t.file.lines
                .slice(t.from, t.to + 1)
                .map((l) => l.trim())
                .filter((l) => l !== '')
                .map((l) => (l.length > 400 ? `${l.slice(0, 400)}…` : l))
                .join('\n');
            return `── ${t.file.name}:${t.from + 1}\n${body}`;
        })
        .join('\n\n');
}

/** Return the full TypeScript definition of a project type from types.ts. */
export async function typeDefinition(name: string): Promise<string> {
    const files = await loadAll();
    const types = files.find((f) => f.name.endsWith('store/types.ts'));
    if (!types) return 'types.ts not available';
    const start = types.lines.findIndex((l) => new RegExp(`^export type ${name}\\b`).test(l));
    if (start === -1) {
        const names = types.lines.map((l) => /^export type (\w+)/.exec(l)?.[1]).filter(Boolean);
        return `No type "${name}". Available: ${names.join(', ')}`;
    }
    let depth = 0;
    const out: string[] = [];
    for (let i = start; i < types.lines.length; i++) {
        const l = types.lines[i];
        out.push(l);
        depth += (l.match(/[{(]/g) ?? []).length - (l.match(/[})]/g) ?? []).length;
        if (depth <= 0 && /[;}]\s*$/.test(l.trim()) && i > start) break;
        if (depth <= 0 && i === start && l.trim().endsWith(';')) break;
    }
    return out.join('\n');
}

/** Read a few lines of one source file, e.g. to see what an onchange handler does. */
export async function readSource(file: string, line: number, count = 40): Promise<string> {
    const files = await loadAll();
    const f = files.find((x) => x.name === file || x.name.endsWith(file));
    if (!f) return `No source file "${file}". Files: ${files.map((x) => x.name).join(', ')}`;
    const from = Math.max(1, line);
    const to = Math.min(f.lines.length, from + Math.min(count, 150) - 1);
    return `── ${f.name}:${from}-${to}\n` + f.lines.slice(from - 1, to).join('\n');
}
