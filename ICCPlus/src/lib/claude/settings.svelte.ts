// Sign-in state for the Claude sidebar. Two ways to connect, the user picks:
//
// - "claude-code": Claude Code installed on this computer, signed in with the user's
//   claude.ai account. Only available when the site runs from the local launcher / dev
//   server, which hosts the bridge (claude-code-bridge.ts).
// - "api": an API key from the user's Claude Console account. Works anywhere, including the
//   hosted site. The key is kept in this browser only and sent straight to api.anthropic.com.

import Anthropic from '@anthropic-ai/sdk';

export type Backend = 'claude-code' | 'api';

export const MODELS = [
    { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
    { id: 'claude-fable-5-2', label: 'Claude Fable 5.2' },
    { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
    { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5' }
] as const;

export const EFFORTS = ['low', 'medium', 'high', 'xhigh'] as const;
export type Effort = (typeof EFFORTS)[number];

const STORAGE_KEY = 'iccplus.claude';

/** A folder of reference files (PDFs, images, notes) Claude Code may read. */
export type ReferenceFolder = {
    path: string;
    name: string;
    total: number;
    truncated?: boolean;
    counts: { pdf: number; image: number; text: number; other: number };
};

type Persisted = {
    backend?: Backend | null;
    folder?: ReferenceFolder | null;
    web?: boolean;
    apiKey?: string;
    workspaceId?: string;
    model?: string;
    effort?: Effort;
    showThinking?: boolean;
};

function readStorage(): Persisted {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        return raw ? (JSON.parse(raw) as Persisted) : {};
    } catch {
        return {};
    }
}

const initial = readStorage();

export const claudeSettings = $state({
    backend: (initial.backend ?? null) as Backend | null,
    apiKey: initial.apiKey ?? '',
    workspaceId: initial.workspaceId ?? '',
    remember: Boolean(initial.apiKey),
    model: initial.model ?? 'claude-opus-5-5',
    effort: (initial.effort ?? 'medium') as Effort,
    showThinking: initial.showThinking ?? true,
    /** Claude Code only: a folder it may read (never write). */
    folder: (initial.folder ?? null) as ReferenceFolder | null,
    /** Let Claude search and read the web (Claude Code tools, or the API's web search/fetch). */
    web: initial.web ?? true,
    /** Display info about the signed-in account, filled after verification. */
    account: null as null | { keyHint: string }
});

export function persistSettings() {
    try {
        const data: Persisted = {
            backend: claudeSettings.backend,
            model: claudeSettings.model,
            effort: claudeSettings.effort,
            showThinking: claudeSettings.showThinking,
            folder: claudeSettings.folder,
            web: claudeSettings.web
        };
        if (claudeSettings.remember) {
            data.apiKey = claudeSettings.apiKey;
            data.workspaceId = claudeSettings.workspaceId;
        }
        localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch {
        // storage blocked (private mode etc.) - settings just won't persist
    }
}

export type ClaudeCodeStatus = {
    checked: boolean;
    checking: boolean;
    bridge: boolean;
    available: boolean;
    loggedIn: boolean;
    version?: string;
    email?: string | null;
    authMethod?: string | null;
    subscription?: string | null;
};

export const claudeCode = $state<ClaudeCodeStatus>({ checked: false, checking: false, bridge: false, available: false, loggedIn: false });

/** Ask the local bridge whether Claude Code is installed and signed in. */
export async function checkClaudeCode() {
    claudeCode.checking = true;
    try {
        const res = await fetch('./__claude-code/status', { cache: 'no-store' });
        const type = res.headers.get('content-type') ?? '';
        if (!res.ok || !type.includes('application/json')) throw new Error('no bridge');
        const s = await res.json();
        Object.assign(claudeCode, {
            bridge: true,
            available: Boolean(s.available),
            loggedIn: Boolean(s.loggedIn),
            version: s.version,
            email: s.email,
            authMethod: s.authMethod,
            subscription: s.subscription
        });
    } catch {
        Object.assign(claudeCode, { bridge: false, available: false, loggedIn: false });
    } finally {
        claudeCode.checked = true;
        claudeCode.checking = false;
    }
}

type FolderReply = Partial<ReferenceFolder> & { error?: string; cancelled?: boolean };

async function folderCall(route: string, body?: unknown): Promise<ReferenceFolder | null> {
    let res: Response;
    try {
        res = await fetch(`./__claude-code/${route}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body ?? {})
        });
    } catch {
        throw new Error('The local Claude Code bridge is not running. Start ICC Plus with the "Launch ICC Plus" shortcut.');
    }
    if (!(res.headers.get('content-type') ?? '').includes('application/json')) {
        throw new Error('Reference folders only work when ICC Plus runs from the "Launch ICC Plus" shortcut.');
    }
    const r = (await res.json()) as FolderReply;
    if (r.cancelled) return null;
    if (r.error || !r.path) throw new Error(r.error ?? 'Could not open that folder.');
    return r as ReferenceFolder;
}

/** Open the macOS folder chooser. Returns null if the user cancelled. */
export async function pickReferenceFolder(): Promise<ReferenceFolder | null> {
    const f = await folderCall('pick-folder');
    if (f) setReferenceFolder(f);
    return f;
}

/** Use a folder typed as a path (e.g. "~/Documents/My CYOA"). */
export async function useReferenceFolderPath(path: string): Promise<ReferenceFolder> {
    const f = await folderCall('folder-info', { path });
    if (!f) throw new Error('Could not open that folder.');
    setReferenceFolder(f);
    return f;
}

/** Re-count the files in the current folder (they may have changed). */
export async function refreshReferenceFolder() {
    if (!claudeSettings.folder) return;
    try {
        const f = await folderCall('folder-info', { path: claudeSettings.folder.path });
        if (f) setReferenceFolder(f);
    } catch {
        // keep the old summary; the run will report a missing folder
    }
}

export function setReferenceFolder(folder: ReferenceFolder | null) {
    claudeSettings.folder = folder;
    persistSettings();
}

export function useBackend(backend: Backend | null) {
    claudeSettings.backend = backend;
    persistSettings();
}

export function isReady() {
    if (claudeSettings.backend === 'api') return claudeSettings.apiKey !== '';
    if (claudeSettings.backend === 'claude-code') return claudeCode.loggedIn;
    return false;
}

export function createClient(apiKey = claudeSettings.apiKey, workspaceId = claudeSettings.workspaceId) {
    return new Anthropic({
        apiKey,
        // The key belongs to the person using this page and lives only in their browser.
        dangerouslyAllowBrowser: true,
        defaultHeaders: workspaceId ? { 'anthropic-workspace-id': workspaceId } : undefined,
        maxRetries: 2
    });
}

function keyHint(key: string) {
    return key.length > 12 ? `${key.slice(0, 10)}…${key.slice(-4)}` : '••••';
}

/** Check the key against the API before storing it. Throws a readable error on failure. */
export async function signIn(apiKey: string, workspaceId: string, remember: boolean) {
    const key = apiKey.trim();
    const ws = workspaceId.trim();
    if (!key) throw new Error('Paste an API key from your Claude Console account.');
    const client = createClient(key, ws);
    try {
        await client.models.retrieve(claudeSettings.model);
    } catch (e) {
        throw new Error(describeApiError(e));
    }
    claudeSettings.apiKey = key;
    claudeSettings.workspaceId = ws;
    claudeSettings.remember = remember;
    claudeSettings.account = { keyHint: keyHint(key) };
    claudeSettings.backend = 'api';
    persistSettings();
}

export function signOut() {
    if (claudeSettings.backend === 'api') claudeSettings.backend = null;
    claudeSettings.apiKey = '';
    claudeSettings.workspaceId = '';
    claudeSettings.account = null;
    claudeSettings.remember = false;
    persistSettings();
}

if (claudeSettings.apiKey) {
    claudeSettings.account = { keyHint: keyHint(claudeSettings.apiKey) };
}

export function describeApiError(e: unknown): string {
    if (e instanceof Anthropic.AuthenticationError) {
        const msg = e.message || '';
        if (/CORS requests are not allowed/i.test(msg)) {
            return 'Your organization blocks API calls straight from a browser (zero data retention or Compliance API is on), so the sidebar cannot use this key.';
        }
        return 'That API key was rejected. Check it is active in the Claude Console, or create a new one.';
    }
    if (e instanceof Anthropic.PermissionDeniedError) return 'This key is not allowed to use that model or workspace.';
    if (e instanceof Anthropic.NotFoundError) return 'Not found. If your key is not scoped to one workspace, enter the workspace ID.';
    if (e instanceof Anthropic.RateLimitError) return 'Rate limited by the API. Wait a moment and try again.';
    if (e instanceof Anthropic.BadRequestError) {
        if (/workspace/i.test(e.message)) return 'This key is not scoped to a workspace. Enter the workspace ID (wrkspc_…) from the Console.';
        if (/credit balance/i.test(e.message)) return 'Your Claude Console account is out of credits. Add credits under Billing.';
        return `The API rejected the request: ${e.message}`;
    }
    if (e instanceof Anthropic.InternalServerError) return 'The Claude API had a server error. Try again shortly.';
    if (e instanceof Anthropic.APIConnectionError) return 'Could not reach api.anthropic.com. Check your connection.';
    if (e instanceof Anthropic.APIError) return `API error ${e.status ?? ''}: ${e.message}`;
    return e instanceof Error ? e.message : String(e);
}
