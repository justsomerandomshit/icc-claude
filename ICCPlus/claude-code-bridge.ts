// Local bridge between the creator's Claude sidebar and Claude Code on this computer.
//
// Runs inside the Vite server (dev / launcher only, never in the published build):
//   GET  /__claude-code/status        is Claude Code installed and signed in?
//   POST /__claude-code/run           run one chat turn; streams NDJSON events back
//   POST /__claude-code/tool-result   the page returns the result of a tool call
//   POST /__claude-code/stop          stop a running turn
//   POST /__claude-code/mcp/<runId>   MCP endpoint Claude Code uses to call the editor tools
//   POST /__claude-code/pick-folder   open the macOS folder chooser
//   POST /__claude-code/folder-info   check a folder and count the files in it
//   GET  /__claude-code/local-image   an image file inside the chosen reference folder
//   GET  /__claude-code/web-image     download an image from the web (no CORS in the way)
//   GET  /__claude-code/page-images   list the images on a web page
//   POST /__claude-code/forget        delete a chat's private work folder
//
// Each turn spawns `claude -p` with the user's own Claude Code login and one MCP server ("icc")
// whose tools are executed by the open editor page, plus any of the user's own Claude Code MCP
// servers they switched on. Built-in tools: reading the reference folder (Read/Glob/Grep, nothing
// else outside the chat's work folder), the web (WebSearch/WebFetch), and a sandboxed shell
// (Bash) that can write only inside the chat's work folder and reach only PyPI. Each chat has its
// own work folder, which is also the Claude Code working directory, so --resume finds the session.

import type { Plugin, ViteDevServer } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync } from 'node:fs';
import { readdir, readFile, realpath, rm, stat } from 'node:fs/promises';
import { lookup } from 'node:dns/promises';
import net from 'node:net';
import { homedir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

type ToolDef = { name: string; description: string; input_schema: unknown };

type ToolImage = { mediaType: string; data: string };
type ToolReply = { text: string; isError: boolean; images?: ToolImage[] };
type PendingCall = { resolve: (r: ToolReply) => void; timer: ReturnType<typeof setTimeout> };

type Run = {
    id: string;
    tools: ToolDef[];
    child: ChildProcess | null;
    res: ServerResponse;
    pending: Map<string, PendingCall>;
    closed: boolean;
};

const PREFIX = '/__claude-code';
const TOOL_TIMEOUT_MS = 10 * 60 * 1000;
const MODEL_RE = /^[a-z0-9.\-[\]]{1,60}$/i;
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const SESSION_RE = /^[0-9a-f-]{36}$/i;
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.avif', '.bmp']);
const IMAGE_MIME: Record<string, string> = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
    '.svg': 'image/svg+xml', '.avif': 'image/avif', '.bmp': 'image/bmp'
};
const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
const MAX_PAGE_BYTES = 8 * 1024 * 1024;
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';

function findClaude(): string | null {
    const candidates = [
        process.env.CLAUDE_CODE_BIN,
        path.join(homedir(), '.local/bin/claude'),
        path.join(homedir(), '.claude/local/claude'),
        '/opt/homebrew/bin/claude',
        '/usr/local/bin/claude'
    ];
    for (const c of candidates) if (c && existsSync(c)) return c;
    for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
        const p = path.join(dir, 'claude');
        if (dir && existsSync(p)) return p;
    }
    return null;
}

function childEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env };
    // Running the launcher from inside another Claude Code session must not confuse the child.
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;
    delete env.CLAUDE_CODE_SSE_PORT;
    return env;
}

function readBody(req: IncomingMessage, limit = 60 * 1024 * 1024): Promise<string> {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => {
            size += c.length;
            if (size > limit) {
                reject(new Error('Request too large'));
                req.destroy();
                return;
            }
            chunks.push(c);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(body));
}

/** Only accept calls made to localhost, from pages served by this same local server. */
function sameOrigin(req: IncomingMessage): boolean {
    const host = req.headers.host ?? '';
    // Blocks DNS-rebinding: the bridge only answers when addressed as localhost.
    if (!/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host)) return false;
    const origin = req.headers.origin;
    if (!origin) return true; // Claude Code's MCP client sends no Origin
    try {
        return new URL(origin).host === req.headers.host;
    } catch {
        return false;
    }
}

function authStatus(bin: string): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
        execFile(bin, ['auth', 'status', '--json'], { env: childEnv(), timeout: 15000 }, (err, stdout) => {
            try {
                resolve(JSON.parse(stdout));
            } catch {
                resolve({ loggedIn: false, error: err ? String(err.message) : 'Could not read auth status' });
            }
        });
    });
}

function version(bin: string): Promise<string> {
    return new Promise((resolve) => {
        execFile(bin, ['--version'], { env: childEnv(), timeout: 15000 }, (_err, stdout) => resolve(String(stdout ?? '').trim()));
    });
}


function expandHome(p: string): string {
    return p === '~' ? homedir() : p.startsWith('~/') ? path.join(homedir(), p.slice(2)) : p;
}

/** Resolve a folder path the user chose; throws a readable error if it is not a folder. */
async function resolveFolder(input: unknown): Promise<string> {
    if (typeof input !== 'string' || !input.trim()) throw new Error('No folder given.');
    const abs = path.resolve(expandHome(input.trim()));
    let real: string;
    try {
        real = await realpath(abs);
    } catch {
        throw new Error(`The folder "${abs}" does not exist.`);
    }
    if (!(await stat(real)).isDirectory()) throw new Error(`"${abs}" is a file, not a folder.`);
    if (real === '/' || real === (await realpath(homedir()))) throw new Error('Pick a specific folder, not your whole disk or home folder.');
    return real;
}

/** Count files by kind so the sidebar can show what Claude will see. */
async function folderSummary(root: string) {
    const counts = { pdf: 0, book: 0, image: 0, text: 0, other: 0 };
    let total = 0;
    let truncated = false;
    const walk = async (dir: string, depth: number) => {
        if (depth > 8 || truncated) return;
        let entries;
        try {
            entries = await readdir(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const e of entries) {
            if (e.name.startsWith('.') || e.name === 'node_modules') continue;
            if (e.isDirectory()) await walk(path.join(dir, e.name), depth + 1);
            else if (e.isFile()) {
                if (++total > 5000) {
                    truncated = true;
                    return;
                }
                const ext = path.extname(e.name).toLowerCase();
                if (ext === '.pdf') counts.pdf++;
                else if (['.epub', '.mobi', '.azw3', '.docx', '.doc', '.odt', '.pages', '.fb2'].includes(ext)) counts.book++;
                else if (IMAGE_EXT.has(ext)) counts.image++;
                else if (['.txt', '.md', '.json', '.csv', '.html', '.htm', '.xml', '.rtf'].includes(ext)) counts.text++;
                else counts.other++;
            }
        }
    };
    await walk(root, 0);
    return { path: root, name: path.basename(root), total: Math.min(total, 5000), truncated, counts };
}

/** Block requests to this machine and the local network (a web page could ask Claude to fetch them). */
function isPrivateAddress(ip: string): boolean {
    if (net.isIPv4(ip)) {
        const [a, b] = ip.split('.').map(Number);
        return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
    }
    const v6 = ip.toLowerCase();
    if (v6.startsWith('::ffff:')) return isPrivateAddress(v6.slice(7));
    return v6 === '::1' || v6 === '::' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80');
}

async function assertPublicUrl(raw: string): Promise<URL> {
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        throw new Error(`Not a valid URL: ${raw}`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only http and https links can be fetched.');
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const addrs = net.isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => []);
    if (addrs.length === 0) throw new Error(`Could not find the site ${url.hostname}.`);
    if (addrs.some((a) => isPrivateAddress(a.address))) throw new Error('Links to this computer or the local network are not allowed.');
    return url;
}

/** GET a public URL, following redirects (each hop re-checked), with a size cap. */
async function fetchPublic(raw: string, accept: string, maxBytes: number): Promise<{ buf: Buffer; type: string; url: string }> {
    let url = await assertPublicUrl(raw);
    for (let hop = 0; hop < 6; hop++) {
        const res = await fetch(url, {
            redirect: 'manual',
            headers: { 'user-agent': BROWSER_UA, accept, 'accept-language': 'en-US,en;q=0.8' },
            signal: AbortSignal.timeout(25000)
        });
        if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
            url = await assertPublicUrl(new URL(res.headers.get('location')!, url).href);
            continue;
        }
        if (!res.ok) throw new Error(`The site answered ${res.status} ${res.statusText} for ${url.href}`);
        const len = Number(res.headers.get('content-length') ?? 0);
        if (len > maxBytes) throw new Error(`The file is too large (${Math.round(len / 1048576)} MB).`);
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
            size += chunk.length;
            if (size > maxBytes) throw new Error(`The file is larger than ${Math.round(maxBytes / 1048576)} MB.`);
            chunks.push(Buffer.from(chunk));
        }
        return { buf: Buffer.concat(chunks), type: (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase(), url: url.href };
    }
    throw new Error('Too many redirects.');
}

function sniffImage(buf: Buffer): string | null {
    if (buf.length < 12) return null;
    if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
    if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
    if (buf.toString('ascii', 0, 4) === 'GIF8') return 'image/gif';
    if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
    if (buf.toString('ascii', 4, 12).startsWith('ftypavi')) return 'image/avif';
    if (buf.toString('ascii', 0, 2) === 'BM') return 'image/bmp';
    const head = buf.toString('utf8', 0, 512).trimStart().toLowerCase();
    if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'image/svg+xml';
    return null;
}

function decodeEntities(s: string): string {
    return s
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#0*39;|&apos;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
        .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)));
}

function attrs(tag: string): Record<string, string> {
    const out: Record<string, string> = {};
    const re = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(tag))) out[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
    return out;
}

/** Largest candidate of a srcset. */
function bestFromSrcset(srcset: string): string | null {
    let best: { url: string; w: number } | null = null;
    for (const part of srcset.split(/,\s+/)) {
        const [u, d] = part.trim().split(/\s+/);
        if (!u) continue;
        const w = d ? parseFloat(d) * (d.endsWith('x') ? 1000 : 1) : 1;
        if (!best || w > best.w) best = { url: u, w };
    }
    return best?.url ?? null;
}

/** Pull image links out of an HTML page. */
function extractImages(html: string, base: string, limit: number) {
    const found = new Map<string, { url: string; alt?: string; width?: number; height?: number; from: string }>();
    const add = (raw: string | null | undefined, from: string, extra: { alt?: string; width?: number; height?: number } = {}) => {
        if (!raw || raw.startsWith('data:') || raw.startsWith('blob:')) return;
        let abs: string;
        try {
            abs = new URL(raw.trim(), base).href;
        } catch {
            return;
        }
        if (!/^https?:/.test(abs)) return;
        if ((extra.width && extra.width < 32) || (extra.height && extra.height < 32)) return; // icons, tracking pixels
        const prev = found.get(abs);
        if (prev) {
            if (!prev.alt && extra.alt) prev.alt = extra.alt;
            return;
        }
        found.set(abs, { url: abs, from, ...Object.fromEntries(Object.entries(extra).filter(([, v]) => v)) });
    };
    const title = decodeEntities(/<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]?.trim() ?? '');
    for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
        const a = attrs(m[0]);
        const key = (a.property ?? a.name ?? '').toLowerCase();
        if (key === 'og:image' || key === 'og:image:url' || key === 'og:image:secure_url' || key === 'twitter:image') add(a.content, 'page preview image');
    }
    for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
        const a = attrs(m[0]);
        const src = (a.srcset && bestFromSrcset(a.srcset)) || (a['data-srcset'] && bestFromSrcset(a['data-srcset'])) || a['data-src'] || a['data-original'] || a['data-lazy-src'] || a.src;
        add(src, 'img', { alt: a.alt?.slice(0, 160), width: Number(a.width) || undefined, height: Number(a.height) || undefined });
    }
    for (const m of html.matchAll(/<source\b[^>]*>/gi)) {
        const a = attrs(m[0]);
        if (a.srcset) add(bestFromSrcset(a.srcset), 'picture');
    }
    for (const m of html.matchAll(/<a\b[^>]*>/gi)) {
        const a = attrs(m[0]);
        if (a.href && /\.(png|jpe?g|webp|gif|avif)(\?|#|$)/i.test(a.href)) add(a.href, 'link to image file', { alt: a.title?.slice(0, 160) });
    }
    const images = [...found.values()];
    return { title, total: images.length, images: images.slice(0, limit) };
}

/**
 * The user's own MCP servers from their Claude Code setup (user scope in ~/.claude.json, local
 * scope for this repo, and the repo's .mcp.json). Configs stay on this computer: the page only
 * sees names and types, and picks which ones the sidebar may use.
 */
async function userMcpServers(repoRoot: string): Promise<Record<string, Record<string, unknown>>> {
    const out: Record<string, Record<string, unknown>> = {};
    const add = (servers: unknown) => {
        if (!servers || typeof servers !== 'object') return;
        for (const [name, cfg] of Object.entries(servers as Record<string, unknown>)) {
            if (name !== 'icc' && /^[\w-]{1,64}$/.test(name) && cfg && typeof cfg === 'object') out[name] = cfg as Record<string, unknown>;
        }
    };
    try {
        const d = JSON.parse(await readFile(path.join(homedir(), '.claude.json'), 'utf8'));
        add(d.mcpServers);
        for (const dir of [repoRoot, path.dirname(repoRoot)]) add(d.projects?.[dir]?.mcpServers);
    } catch {
        // no Claude Code config yet
    }
    for (const dir of [repoRoot, path.dirname(repoRoot)]) {
        try {
            add(JSON.parse(await readFile(path.join(dir, '.mcp.json'), 'utf8')).mcpServers);
        } catch {
            // none
        }
    }
    return out;
}

/**
 * Sandbox for the shell: writes only in the chat's work folder (and a shared package cache, never
 * the reference folder), network only to PyPI (for converters installed with uvx/pip), and no
 * reading of credentials, browser data or Claude's own files. The sandbox is enforced by the OS,
 * so every command is pre-approved: in dontAsk mode anything that would ask is refused, and
 * Claude Code asks about any command whose effects it can't work out (loops, variables, $(...)).
 */
function shellSettings(toolsDir: string, folder: string | null) {
    const home = '~';
    const deny = [
        `${home}/.claude.json`, `${home}/.claude/**`, `${home}/.ssh/**`, `${home}/.aws/**`, `${home}/.config/**`, `${home}/.gnupg/**`,
        `${home}/.netrc`, `${home}/.npmrc`, `${home}/.pypirc`, `${home}/.docker/**`, `${home}/.kube/**`, `${home}/.zsh_history`,
        `${home}/.bash_history`, `${home}/.local/share/**`, `${home}/Library/Keychains/**`, `${home}/Library/Cookies/**`,
        `${home}/Library/Application Support/**`, `${home}/Library/Containers/**`, `${home}/Library/Group Containers/**`,
        `${home}/Library/Messages/**`, `${home}/Library/Mail/**`, `${home}/Library/Safari/**`
    ].map((p) => `Read(${p})`);
    return {
        sandbox: { enabled: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false },
        permissions: {
            allow: ['Bash', 'WebFetch(domain:pypi.org)', 'WebFetch(domain:files.pythonhosted.org)', `Edit(/${toolsDir}/**)`],
            deny: [...deny, ...(folder ? [`Edit(/${folder}/**)`] : [])]
        }
    };
}

/** Where Claude Code keeps a session's transcript for a given working directory. */
function sessionFile(cwd: string, sessionId: string) {
    return path.join(homedir(), '.claude/projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`);
}

function pickFolderDialog(): Promise<{ path?: string; cancelled?: boolean; error?: string }> {
    if (process.platform !== 'darwin') return Promise.resolve({ error: 'The folder chooser only works on macOS. Type the folder path instead.' });
    return new Promise((resolve) => {
        execFile(
            'osascript',
            ['-e', 'activate', '-e', 'POSIX path of (choose folder with prompt "Choose a reference folder Claude can read (PDFs, images, notes)")'],
            { timeout: 10 * 60 * 1000 },
            (err, stdout, stderr) => {
                if (err) return resolve(/-128|cancel/i.test(String(stderr) + err.message) ? { cancelled: true } : { error: String(stderr || err.message).trim() });
                resolve({ path: String(stdout).trim().replace(/\/$/, '') });
            }
        );
    });
}

export function claudeCodeBridge(): Plugin {
    return {
        name: 'icc-claude-code-bridge',
        apply: 'serve',
        configureServer(server: ViteDevServer) {
            const runs = new Map<string, Run>();
            const workspace = path.join(server.config.root, 'node_modules/.cache/icc-claude-code');

            const emit = (run: Run, obj: unknown) => {
                if (!run.closed) run.res.write(JSON.stringify(obj) + '\n');
            };

            const finish = (run: Run) => {
                if (run.closed) return;
                run.closed = true;
                for (const p of run.pending.values()) {
                    clearTimeout(p.timer);
                    p.resolve({ text: 'The editor page stopped this turn.', isError: true });
                }
                run.pending.clear();
                if (run.child && run.child.exitCode === null) run.child.kill('SIGTERM');
                run.res.end();
                runs.delete(run.id);
            };

            async function handleRun(req: IncomingMessage, res: ServerResponse) {
                const bin = findClaude();
                if (!bin) return sendJson(res, 500, { error: 'Claude Code is not installed on this computer.' });
                let body: {
                    sessionId?: string;
                    resume?: boolean;
                    message?: unknown[];
                    model?: string;
                    effort?: string;
                    systemPrompt?: string;
                    tools?: ToolDef[];
                    folder?: string | null;
                    web?: boolean;
                    shell?: boolean;
                    mcp?: string[];
                };
                try {
                    body = JSON.parse(await readBody(req));
                } catch (e) {
                    return sendJson(res, 400, { error: `Bad request: ${(e as Error).message}` });
                }
                if (!body.sessionId || !SESSION_RE.test(body.sessionId)) return sendJson(res, 400, { error: 'sessionId must be a UUID' });
                if (!Array.isArray(body.message) || !Array.isArray(body.tools)) return sendJson(res, 400, { error: 'message and tools are required' });
                let folder: string | null = null;
                if (body.folder) {
                    try {
                        folder = await resolveFolder(body.folder);
                    } catch (e) {
                        return sendJson(res, 400, { error: `Reference folder: ${(e as Error).message}` });
                    }
                }
                // Built-in tools. Reads are allowed inside the working directories only (dontAsk
                // denies everything else); the shell runs sandboxed (see shellSettings).
                const builtIn = [
                    ...(folder || body.shell ? ['Read', 'Glob', 'Grep'] : []),
                    ...(body.shell ? ['Bash'] : []),
                    ...(body.web ? ['WebSearch', 'WebFetch'] : [])
                ];
                const allowed = ['mcp__icc', ...(body.shell ? ['Bash'] : []), ...(body.web ? ['WebSearch', 'WebFetch'] : [])];
                // The user's own MCP servers they switched on for the sidebar.
                const known = await userMcpServers(server.config.root);
                const extraMcp: Record<string, Record<string, unknown>> = {};
                for (const name of Array.isArray(body.mcp) ? body.mcp : []) {
                    if (typeof name === 'string' && known[name]) {
                        extraMcp[name] = known[name];
                        allowed.push(`mcp__${name}`);
                    }
                }
                // Each chat works in its own folder. Chats from before this existed ran in the shared
                // folder; keep using it for them so their sessions still resume.
                let cwd = path.join(workspace, 'chats', body.sessionId);
                if (body.resume && !existsSync(sessionFile(cwd, body.sessionId)) && existsSync(sessionFile(workspace, body.sessionId))) cwd = workspace;
                const toolsDir = path.join(workspace, 'tools');

                const run: Run = { id: randomUUID(), tools: body.tools, child: null, res, pending: new Map(), closed: false };
                runs.set(run.id, run);

                res.statusCode = 200;
                res.setHeader('content-type', 'application/x-ndjson');
                res.setHeader('cache-control', 'no-store');
                res.flushHeaders?.();
                emit(run, { kind: 'run', runId: run.id });

                mkdirSync(cwd, { recursive: true });
                mkdirSync(toolsDir, { recursive: true });
                // Temp files stay inside the work folder, where the shell may write and Read may look.
                const tmpDir = path.join(cwd, '.tmp');
                mkdirSync(tmpDir, { recursive: true });
                const mcpConfig = JSON.stringify({
                    mcpServers: { ...extraMcp, icc: { type: 'http', url: `http://${req.headers.host}${PREFIX}/mcp/${run.id}` } }
                });
                const args = [
                    '-p',
                    '--input-format', 'stream-json',
                    '--output-format', 'stream-json',
                    '--verbose',
                    '--include-partial-messages',
                    '--tools', builtIn.join(','),
                    '--strict-mcp-config',
                    '--mcp-config', mcpConfig,
                    '--allowedTools', allowed.join(','),
                    ...(folder ? ['--add-dir', folder] : []),
                    '--permission-mode', 'dontAsk',
                    '--setting-sources', '',
                    ...(body.shell ? ['--settings', JSON.stringify(shellSettings(toolsDir, folder))] : []),
                    '--system-prompt', String(body.systemPrompt ?? '')
                ];
                args.push(...(body.resume ? ['--resume', body.sessionId] : ['--session-id', body.sessionId]));
                if (body.model && body.model !== 'default' && MODEL_RE.test(body.model)) args.push('--model', body.model);
                if (body.effort && EFFORTS.has(body.effort)) args.push('--effort', body.effort);

                // Package caches go where the sandbox lets the shell write.
                const env = {
                    ...childEnv(),
                    UV_CACHE_DIR: path.join(toolsDir, 'uv-cache'),
                    UV_TOOL_DIR: path.join(toolsDir, 'uv-tools'),
                    UV_PYTHON_INSTALL_DIR: path.join(toolsDir, 'uv-python'),
                    PIP_CACHE_DIR: path.join(toolsDir, 'pip-cache'),
                    XDG_CACHE_HOME: path.join(toolsDir, 'cache'),
                    XDG_DATA_HOME: path.join(toolsDir, 'data'),
                    TMPDIR: tmpDir
                };
                const child = spawn(bin, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
                run.child = child;

                let buffer = '';
                child.stdout.setEncoding('utf8');
                child.stdout.on('data', (chunk: string) => {
                    buffer += chunk;
                    let nl: number;
                    while ((nl = buffer.indexOf('\n')) !== -1) {
                        const line = buffer.slice(0, nl).trim();
                        buffer = buffer.slice(nl + 1);
                        if (!line) continue;
                        try {
                            emit(run, { kind: 'cc', event: JSON.parse(line) });
                        } catch {
                            emit(run, { kind: 'log', text: line });
                        }
                    }
                });
                let stderr = '';
                child.stderr.setEncoding('utf8');
                child.stderr.on('data', (c: string) => {
                    stderr = (stderr + c).slice(-4000);
                });
                child.on('error', (err) => {
                    emit(run, { kind: 'error', message: `Could not start Claude Code: ${err.message}` });
                    finish(run);
                });
                child.on('close', (code) => {
                    emit(run, { kind: 'exit', code, stderr: code ? stderr : '' });
                    finish(run);
                });

                child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: body.message } }) + '\n');
                child.stdin.end();

                // The page went away (tab closed / stop): end the turn.
                res.on('close', () => finish(run));
            }

            async function handleToolResult(req: IncomingMessage, res: ServerResponse) {
                const body = JSON.parse(await readBody(req)) as { runId: string; callId: string; text: string; isError?: boolean; images?: ToolImage[] };
                const run = runs.get(body.runId);
                const pending = run?.pending.get(body.callId);
                if (!run || !pending) return sendJson(res, 404, { error: 'No such tool call' });
                clearTimeout(pending.timer);
                run.pending.delete(body.callId);
                const images = Array.isArray(body.images)
                    ? body.images.filter((i) => typeof i?.data === 'string' && /^image\/(png|jpeg|webp|gif)$/.test(i.mediaType)).slice(0, 8)
                    : undefined;
                pending.resolve({ text: String(body.text ?? ''), isError: Boolean(body.isError), images });
                sendJson(res, 200, { ok: true });
            }

            async function handleStop(req: IncomingMessage, res: ServerResponse) {
                const body = JSON.parse(await readBody(req)) as { runId: string };
                const run = runs.get(body.runId);
                if (run) finish(run);
                sendJson(res, 200, { ok: true });
            }

            // Minimal MCP (streamable HTTP, JSON responses) for the editor tools.
            async function handleMcp(runId: string, req: IncomingMessage, res: ServerResponse) {
                if (req.method !== 'POST') {
                    res.statusCode = 405;
                    return res.end();
                }
                const run = runs.get(runId);
                let msg: { jsonrpc: string; id?: number | string; method: string; params?: Record<string, unknown> };
                try {
                    msg = JSON.parse(await readBody(req));
                } catch {
                    return sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
                }
                if (msg.id === undefined) {
                    res.statusCode = 202;
                    return res.end();
                }
                const reply = (result: unknown) => sendJson(res, 200, { jsonrpc: '2.0', id: msg.id, result });
                const fail = (code: number, message: string) => sendJson(res, 200, { jsonrpc: '2.0', id: msg.id, error: { code, message } });

                switch (msg.method) {
                    case 'initialize':
                        return reply({
                            protocolVersion: (msg.params?.protocolVersion as string) ?? '2025-06-18',
                            capabilities: { tools: {} },
                            serverInfo: { name: 'icc-plus-editor', version: '1.0.0' }
                        });
                    case 'ping':
                        return reply({});
                    case 'tools/list':
                        return reply({
                            tools: (run?.tools ?? []).map((t) => ({ name: t.name, description: t.description, inputSchema: t.input_schema }))
                        });
                    case 'tools/call': {
                        if (!run || run.closed) return reply({ content: [{ type: 'text', text: 'The editor page is no longer connected.' }], isError: true });
                        const callId = randomUUID();
                        const result = await new Promise<ToolReply>((resolve) => {
                            const timer = setTimeout(() => {
                                run.pending.delete(callId);
                                resolve({ text: 'The editor did not answer in time.', isError: true });
                            }, TOOL_TIMEOUT_MS);
                            run.pending.set(callId, { resolve, timer });
                            emit(run, { kind: 'tool_call', callId, name: msg.params?.name, input: msg.params?.arguments ?? {} });
                        });
                        return reply({
                            content: [
                                { type: 'text', text: result.text },
                                ...(result.images ?? []).map((i) => ({ type: 'image', data: i.data, mimeType: i.mediaType }))
                            ],
                            isError: result.isError
                        });
                    }
                    default:
                        return fail(-32601, `Method not found: ${msg.method}`);
                }
            }

            server.middlewares.use(async (req, res, next) => {
                const url = req.url ?? '';
                if (!url.startsWith(PREFIX)) return next();
                if (!sameOrigin(req)) return sendJson(res, 403, { error: 'Forbidden' });
                try {
                    const route = url.slice(PREFIX.length).split('?')[0];
                    if (route === '/status' && req.method === 'GET') {
                        const bin = findClaude();
                        if (!bin) return sendJson(res, 200, { available: false });
                        const [v, auth] = await Promise.all([version(bin), authStatus(bin)]);
                        return sendJson(res, 200, {
                            available: true,
                            version: v,
                            loggedIn: Boolean(auth.loggedIn),
                            authMethod: auth.authMethod ?? null,
                            email: auth.email ?? null,
                            subscription: auth.subscriptionType ?? null,
                            mcpServers: Object.entries(await userMcpServers(server.config.root)).map(([name, cfg]) => ({
                                name,
                                type: String(cfg.type ?? (cfg.command ? 'stdio' : 'http'))
                            }))
                        });
                    }
                    if (route === '/run' && req.method === 'POST') return await handleRun(req, res);
                    if (route === '/tool-result' && req.method === 'POST') return await handleToolResult(req, res);
                    if (route === '/stop' && req.method === 'POST') return await handleStop(req, res);
                    if (route.startsWith('/mcp/')) return await handleMcp(route.slice(5), req, res);
                    const query = new URL(url, 'http://localhost').searchParams;
                    if (route === '/forget' && req.method === 'POST') {
                        const body = JSON.parse(await readBody(req)) as { sessionId?: string };
                        if (!body.sessionId || !SESSION_RE.test(body.sessionId)) return sendJson(res, 400, { error: 'sessionId must be a UUID' });
                        await rm(path.join(workspace, 'chats', body.sessionId), { recursive: true, force: true });
                        return sendJson(res, 200, { ok: true });
                    }
                    if (route === '/pick-folder' && req.method === 'POST') {
                        const picked = await pickFolderDialog();
                        if (!picked.path) return sendJson(res, 200, picked);
                        try {
                            return sendJson(res, 200, await folderSummary(await resolveFolder(picked.path)));
                        } catch (e) {
                            return sendJson(res, 200, { error: (e as Error).message });
                        }
                    }
                    if (route === '/folder-info' && req.method === 'POST') {
                        const body = JSON.parse(await readBody(req)) as { path?: string };
                        try {
                            return sendJson(res, 200, await folderSummary(await resolveFolder(body.path)));
                        } catch (e) {
                            return sendJson(res, 200, { error: (e as Error).message });
                        }
                    }
                    if (route === '/local-image' && req.method === 'GET') {
                        // Only image files inside the reference folder the page is using.
                        const folder = await resolveFolder(query.get('folder'));
                        const wanted = path.resolve(folder, expandHome(query.get('path') ?? ''));
                        let file: string;
                        try {
                            file = await realpath(wanted);
                        } catch {
                            return sendJson(res, 404, { error: `No file at ${wanted}` });
                        }
                        if (!file.startsWith(folder + path.sep)) return sendJson(res, 403, { error: 'That file is outside the reference folder.' });
                        const ext = path.extname(file).toLowerCase();
                        if (!IMAGE_EXT.has(ext)) return sendJson(res, 415, { error: `${path.basename(file)} is not an image file (png, jpg, webp, gif, svg, avif, bmp).` });
                        const info = await stat(file);
                        if (info.size > MAX_IMAGE_BYTES) return sendJson(res, 413, { error: 'The image is larger than 30 MB.' });
                        res.statusCode = 200;
                        res.setHeader('content-type', IMAGE_MIME[ext]);
                        res.setHeader('cache-control', 'no-store');
                        return createReadStream(file).pipe(res);
                    }
                    if (route === '/web-image' && req.method === 'GET') {
                        try {
                            const r = await fetchPublic(query.get('url') ?? '', 'image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8,*/*;q=0.5', MAX_IMAGE_BYTES);
                            const type = r.type.startsWith('image/') ? r.type : sniffImage(r.buf);
                            if (!type) return sendJson(res, 415, { error: `That link is not an image (it returned ${r.type || 'unknown content'}). Use page-images to find the image links on a page.` });
                            res.statusCode = 200;
                            res.setHeader('content-type', type);
                            res.setHeader('x-final-url', encodeURI(r.url));
                            res.setHeader('cache-control', 'no-store');
                            return res.end(r.buf);
                        } catch (e) {
                            return sendJson(res, 502, { error: (e as Error).message });
                        }
                    }
                    if (route === '/page-images' && req.method === 'GET') {
                        try {
                            const r = await fetchPublic(query.get('url') ?? '', 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5', MAX_PAGE_BYTES);
                            if (r.type.startsWith('image/')) return sendJson(res, 200, { title: '', total: 1, images: [{ url: r.url, from: 'the link itself is an image' }], url: r.url });
                            const limit = Math.min(200, Math.max(1, Number(query.get('limit')) || 60));
                            return sendJson(res, 200, { url: r.url, ...extractImages(r.buf.toString('utf8'), r.url, limit) });
                        } catch (e) {
                            return sendJson(res, 502, { error: (e as Error).message });
                        }
                    }
                    sendJson(res, 404, { error: 'Not found' });
                } catch (e) {
                    if (!res.headersSent) sendJson(res, 500, { error: (e as Error).message });
                    else res.end();
                }
            });
        }
    };
}
