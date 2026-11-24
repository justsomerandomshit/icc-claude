// Chat state, persistence and the two ways of running Claude:
//   - "api": the browser calls the Claude API directly with the user's API key and runs the
//     tool loop itself.
//   - "claude-code": the local bridge runs Claude Code (the user's claude.ai login); Claude Code
//     runs the loop and calls the editor tools over MCP, which the bridge relays to this page.
// Either way the tools execute here, against the live project.

import Anthropic from '@anthropic-ai/sdk';
import { claudeSettings, createClient, describeApiError, type Backend } from './settings.svelte';
import { SYSTEM_PROMPT, editorContext } from './prompt';
import { describeToolCall, MUTATING_TOOLS, runTool, toolDefinitions, ToolInputError, type Attachment } from './tools';
import { readFileAsDataUrl, toModelImage, type ModelImage } from './images';
import { projectSummary, snapshotProject, undoLastEdit, historyEntries } from './project';
import { deleteChatRecord, listChats, loadChatRecord, saveChatRecord, type ChatMeta, type ChatRecord } from './history';

type BetaMessageParam = Anthropic.Beta.BetaMessageParam;
type BetaContentBlockParam = Anthropic.Beta.BetaContentBlockParam;
type BetaToolResultBlockParam = Anthropic.Beta.BetaToolResultBlockParam;

export type ToolBlock = {
    type: 'tool';
    id: string;
    name: string;
    label: string;
    status: 'running' | 'done' | 'error' | 'cancelled';
    detail?: string;
    changed?: boolean;
    /** Small previews of images the tool looked at or placed. */
    thumbs?: string[];
    /** Raw streamed input (server tools), parsed when the block ends. */
    partial?: string;
};
export type UiBlock =
    | { type: 'text'; text: string }
    | { type: 'thinking'; text: string }
    | ToolBlock
    | { type: 'notice'; tone: 'info' | 'error'; text: string };

export type UiMessage = { role: 'user' | 'assistant'; blocks: UiBlock[]; images?: { name: string; url: string }[] };

type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number };
const emptyUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

export const chat = $state({
    id: newId(),
    title: '',
    backend: null as Backend | null,
    createdAt: Date.now(),
    messages: [] as UiMessage[],
    running: false,
    usage: emptyUsage(),
    canUndo: 0,
    list: [] as ChatMeta[],
    loaded: false
});

// Conversation state that is not shown directly.
let apiMessages: BetaMessageParam[] = [];
let attachments: Attachment[] = [];
let pendingNotes: string[] = [];
let sessionId: string | null = null;
let sessionStarted = false;
let stopCurrent: (() => void) | null = null;

const MAX_TURNS = 60;
/** Results of the API's own web tools (web_search / web_fetch) mark the matching tool chip done. */
const SERVER_RESULT_TYPES = new Set(['web_search_tool_result', 'web_fetch_tool_result']);
const CC_PREFIX = 'mcp__icc__';
const CC_TOOL_NOTE = `

# Tool names in this session
The editor tools are called through MCP, so their full names start with "${CC_PREFIX}": call ${CC_PREFIX}add_items, ${CC_PREFIX}edit_project, ${CC_PREFIX}place_image and so on. This prompt names them without the prefix. Claude Code's own tools (Read, Glob, Grep, WebSearch, WebFetch) have no prefix.`;

function newId() {
    return typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
              const r = (Math.random() * 16) | 0;
              return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
          });
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

let saveTimer: ReturnType<typeof setTimeout> | null = null;

function record(): ChatRecord {
    return {
        id: chat.id,
        title: chat.title || 'New chat',
        backend: chat.backend ?? claudeSettings.backend ?? 'api',
        createdAt: chat.createdAt,
        updatedAt: Date.now(),
        messages: $state.snapshot(chat.messages),
        apiMessages: JSON.parse(JSON.stringify(apiMessages)),
        sessionId,
        sessionStarted,
        attachments: attachments.map((a) => ({ ...a })),
        usage: $state.snapshot(chat.usage),
        pendingNotes: [...pendingNotes]
    };
}

async function saveNow() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    if (chat.messages.length === 0) return;
    try {
        await saveChatRecord(record());
        chat.list = await listChats();
    } catch (e) {
        console.error('Could not save Claude chat', e);
    }
}

function saveSoon() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 600);
}

function resetState() {
    chat.id = newId();
    chat.title = '';
    chat.backend = null;
    chat.createdAt = Date.now();
    chat.messages = [];
    chat.usage = emptyUsage();
    apiMessages = [];
    attachments = [];
    pendingNotes = [];
    sessionId = null;
    sessionStarted = false;
}

/** Load the history list and reopen the most recent chat. Safe to call more than once. */
export async function initChats() {
    if (chat.loaded) return;
    chat.loaded = true;
    try {
        chat.list = await listChats();
        if (chat.messages.length === 0 && chat.list.length > 0) await openChat(chat.list[0].id);
    } catch (e) {
        console.error('Could not load Claude chats', e);
    }
}

export async function openChat(id: string) {
    if (chat.running) return;
    await saveNow();
    const r = await loadChatRecord(id);
    if (!r) return;
    resetState();
    chat.id = r.id;
    chat.title = r.title;
    chat.backend = r.backend;
    chat.createdAt = r.createdAt;
    chat.usage = r.usage ?? emptyUsage();
    chat.messages = (r.messages as UiMessage[]).map((m) => ({
        ...m,
        blocks: m.blocks.map((b) => (b.type === 'tool' && b.status === 'running' ? { ...b, status: 'cancelled' } : b))
    }));
    apiMessages = r.apiMessages as BetaMessageParam[];
    attachments = r.attachments as Attachment[];
    pendingNotes = r.pendingNotes ?? [];
    sessionId = r.sessionId;
    sessionStarted = r.sessionStarted;
    closeDanglingToolUse();
}

export async function newChat() {
    if (chat.running) stop();
    await saveNow();
    resetState();
}

export async function deleteChat(id: string) {
    await deleteChatRecord(id);
    chat.list = await listChats();
    if (chat.id === id) resetState();
}

// ---------------------------------------------------------------------------
// Undo
// ---------------------------------------------------------------------------

function refreshUndo() {
    chat.canUndo = historyEntries().length;
}

export async function undoFromUi(): Promise<string | null> {
    const label = await undoLastEdit();
    refreshUndo();
    if (label) {
        pendingNotes.push(`The user pressed Undo in the sidebar and reverted your change "${label}".`);
        saveSoon();
    }
    return label;
}

export function lastEditLabel(): string | null {
    const h = historyEntries();
    return h.length ? h[h.length - 1].label : null;
}

export function stop() {
    stopCurrent?.();
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

export async function send(text: string, files: File[] = []) {
    if (chat.running) return;
    const backend = claudeSettings.backend;
    if (!backend) return;
    const trimmed = text.trim();
    if (!trimmed && files.length === 0) return;

    if (chat.backend && chat.backend !== backend) {
        // A conversation can't move between Claude Code and the API; keep the old one in history.
        await newChat();
    }

    const imageBlocks: BetaContentBlockParam[] = [];
    const uiImages: { name: string; url: string }[] = [];
    const labels: string[] = [];
    const problems: string[] = [];
    for (const file of files) {
        try {
            if (file.size > MAX_IMAGE_BYTES) throw new Error(`it is larger than ${MAX_IMAGE_BYTES / 1024 / 1024} MB`);
            const dataUrl = await readFileAsDataUrl(file);
            const img = await toModelImage(dataUrl);
            attachments.push({ name: file.name || 'pasted image', mediaType: file.type, dataUrl });
            imageBlocks.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } });
            labels.push(`[Attachment ${attachments.length}: ${file.name || 'pasted image'}]`);
            uiImages.push({ name: file.name || 'pasted image', url: dataUrl });
        } catch (e) {
            problems.push(`Couldn't attach "${file.name || 'image'}": ${(e as Error).message}.`);
        }
    }
    if (!trimmed && imageBlocks.length === 0) {
        chat.messages.push({ role: 'assistant', blocks: problems.map((p) => ({ type: 'notice', tone: 'error', text: p })) });
        return;
    }

    let context = '';
    try {
        context = editorContext(projectSummary(snapshotProject()), {
            folder: backend === 'claude-code' ? claudeSettings.folder : null,
            web: claudeSettings.web
        });
    } catch {
        // project not ready - skip context
    }
    const notes = pendingNotes.splice(0).map((n) => `<editor_note>${n}</editor_note>`);
    const prefix = [context, ...notes].filter(Boolean).join('\n');
    const content: BetaContentBlockParam[] = [];
    if (prefix) content.push({ type: 'text', text: prefix });
    content.push(...imageBlocks);
    content.push({ type: 'text', text: [labels.join(' '), trimmed || 'See the attached image(s).'].filter(Boolean).join('\n') });

    chat.backend = backend;
    if (!chat.title) chat.title = (trimmed || labels.join(' ') || 'Image').replace(/\s+/g, ' ').slice(0, 60);
    chat.messages.push({ role: 'user', blocks: [{ type: 'text', text: trimmed }], images: uiImages });
    chat.messages.push({ role: 'assistant', blocks: problems.map((p) => ({ type: 'notice', tone: 'error', text: p })) });
    const ui = chat.messages[chat.messages.length - 1];
    await saveNow();

    chat.running = true;
    try {
        if (backend === 'api') {
            apiMessages.push({ role: 'user', content });
            await runApiLoop(ui);
        } else {
            await runClaudeCodeTurn(ui, content);
        }
    } finally {
        for (const b of ui.blocks) if (b.type === 'tool' && b.status === 'running') b.status = 'cancelled';
        if (ui.blocks.length === 0) chat.messages.splice(chat.messages.indexOf(ui), 1);
        chat.running = false;
        stopCurrent = null;
        refreshUndo();
        await saveNow();
    }
}

type ToolRun = { text: string; isError: boolean; images?: ModelImage[] };

async function execTool(name: string, input: unknown, block: ToolBlock | undefined): Promise<ToolRun> {
    if (block) block.label = describeToolCall(name, input);
    try {
        const out = await runTool(name, input, { attachments, folder: claudeSettings.backend === 'claude-code' ? (claudeSettings.folder?.path ?? null) : null });
        if (block) {
            block.status = 'done';
            block.detail = out.text;
            block.changed = MUTATING_TOOLS.has(name);
            if (out.thumbs?.length) block.thumbs = out.thumbs;
        }
        return { text: out.text, isError: false, images: out.images };
    } catch (e) {
        const text = e instanceof ToolInputError ? `INVALID_INPUT: ${e.message}` : (e as Error).message ?? String(e);
        if (block) {
            block.status = 'error';
            block.detail = text;
        }
        return { text, isError: true };
    } finally {
        refreshUndo();
        saveSoon();
    }
}

/** An assistant turn with tool_use must be answered before the next request. */
function closeDanglingToolUse() {
    const last = apiMessages[apiMessages.length - 1];
    if (last?.role === 'assistant' && Array.isArray(last.content)) {
        const pending = last.content.filter((b) => b.type === 'tool_use') as Anthropic.Beta.BetaToolUseBlockParam[];
        if (pending.length) {
            apiMessages.push({ role: 'user', content: pending.map((b) => ({ type: 'tool_result' as const, tool_use_id: b.id, is_error: true, content: 'Not run: the turn was interrupted.' })) });
        }
    }
}

// ---------------------------------------------------------------------------
// Backend 1: Claude API from the browser
// ---------------------------------------------------------------------------

async function runApiLoop(ui: UiMessage) {
    const abort = new AbortController();
    stopCurrent = () => abort.abort();
    const signal = abort.signal;
    const client = createClient();
    let parseRetries = 0;
    // The API's own web tools; the _20260209 versions need a recent model, Haiku takes the basic ones.
    const basicWeb = /haiku/.test(claudeSettings.model);
    const tools: Anthropic.Beta.BetaToolUnion[] = claudeSettings.web
        ? [
              ...toolDefinitions,
              basicWeb ? { type: 'web_search_20250305', name: 'web_search', max_uses: 8 } : { type: 'web_search_20260209', name: 'web_search', max_uses: 8 },
              basicWeb ? { type: 'web_fetch_20250910', name: 'web_fetch', max_uses: 8 } : { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 8 }
          ]
        : toolDefinitions;

    try {
        for (let turn = 0; turn < MAX_TURNS; turn++) {
            const stream = client.beta.messages.stream(
                {
                    model: claudeSettings.model,
                    max_tokens: 64000,
                    system: [{ type: 'text', text: SYSTEM_PROMPT }],
                    tools,
                    messages: apiMessages,
                    thinking: { type: 'adaptive', display: 'summarized' },
                    output_config: { effort: claudeSettings.effort },
                    cache_control: { type: 'ephemeral' },
                    betas: ['server-side-fallback-2026-07-01'],
                    fallbacks: 'default'
                },
                { signal }
            );

            const byIndex = new Map<number, UiBlock>();
            let message: Anthropic.Beta.BetaMessage;
            try {
                for await (const event of stream) handleStreamEvent(ui, byIndex, event, '');
                message = await stream.finalMessage();
                parseRetries = 0;
            } catch (err) {
                if (err instanceof Anthropic.APIUserAbortError || signal.aborted) throw err;
                if (err instanceof Anthropic.APIError || parseRetries >= 2) throw err;
                // Unparseable tool input or a dropped connection mid-stream: re-issue the turn.
                parseRetries++;
                for (const b of byIndex.values()) {
                    const i = ui.blocks.indexOf(b);
                    if (i !== -1) ui.blocks.splice(i, 1);
                }
                continue;
            }

            const u = message.usage;
            chat.usage.input += u.input_tokens ?? 0;
            chat.usage.output += u.output_tokens ?? 0;
            chat.usage.cacheRead += u.cache_read_input_tokens ?? 0;
            chat.usage.cacheWrite += u.cache_creation_input_tokens ?? 0;
            ui.blocks = ui.blocks.filter((b) => !(b.type === 'thinking' && b.text.trim() === ''));

            if (message.stop_reason === 'refusal') {
                ui.blocks.push({ type: 'notice', tone: 'error', text: 'Claude declined this request. Try rephrasing it.' });
                break;
            }
            const toolUses = message.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
            if (message.stop_reason === 'max_tokens' && toolUses.length > 0) {
                ui.blocks.push({ type: 'notice', tone: 'error', text: 'The response ran out of room before finishing a tool call. Ask for a smaller change at a time.' });
                break;
            }
            apiMessages.push({ role: 'assistant', content: message.content });
            if (message.stop_reason === 'pause_turn') continue;
            if (toolUses.length === 0) {
                if (message.stop_reason === 'max_tokens') ui.blocks.push({ type: 'notice', tone: 'info', text: 'The reply was cut off because it reached the length limit.' });
                break;
            }

            const results: BetaToolResultBlockParam[] = [];
            for (const use of toolUses) {
                const block = ui.blocks.find((b): b is ToolBlock => b.type === 'tool' && b.id === use.id);
                if (signal.aborted) {
                    results.push({ type: 'tool_result', tool_use_id: use.id, is_error: true, content: 'Stopped by the user before this ran.' });
                    if (block) block.status = 'cancelled';
                    continue;
                }
                const r = await execTool(use.name, use.input, block);
                const content: BetaToolResultBlockParam['content'] = r.images?.length
                    ? [{ type: 'text', text: r.text }, ...r.images.map((i) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: i.mediaType, data: i.data } }))]
                    : r.text;
                results.push({ type: 'tool_result', tool_use_id: use.id, content, ...(r.isError ? { is_error: true } : {}) });
            }
            apiMessages.push({ role: 'user', content: results });
            if (signal.aborted) break;
            if (turn === MAX_TURNS - 1) ui.blocks.push({ type: 'notice', tone: 'info', text: 'Paused after many steps. Send "continue" to keep going.' });
        }
    } catch (err) {
        if (err instanceof Anthropic.APIUserAbortError || signal.aborted) {
            ui.blocks.push({ type: 'notice', tone: 'info', text: 'Stopped.' });
        } else {
            console.error(err);
            ui.blocks.push({ type: 'notice', tone: 'error', text: describeApiError(err) });
        }
    } finally {
        closeDanglingToolUse();
    }
}

/** Render one Messages streaming event into the UI message. `strip` removes a tool-name prefix. */
function handleStreamEvent(ui: UiMessage, byIndex: Map<number, UiBlock>, event: any, strip: string) {
    if (event.type === 'message_start') {
        byIndex.clear();
    } else if (event.type === 'content_block_start') {
        const b = event.content_block;
        let block: UiBlock | null = null;
        if (b.type === 'text') block = { type: 'text', text: b.text ?? '' };
        else if (b.type === 'thinking') block = { type: 'thinking', text: b.thinking ?? '' };
        else if (b.type === 'tool_use' || b.type === 'server_tool_use') {
            const name = strip && b.name.startsWith(strip) ? b.name.slice(strip.length) : b.name;
            block = { type: 'tool', id: b.id, name, label: describeToolCall(name, {}), status: 'running', ...(b.type === 'server_tool_use' ? { partial: '' } : {}) };
        } else if (SERVER_RESULT_TYPES.has(b.type)) {
            const tool = ui.blocks.find((x): x is ToolBlock => x.type === 'tool' && x.id === b.tool_use_id);
            if (tool) {
                const failed = b.content && !Array.isArray(b.content) && /error/.test(String(b.content.type ?? ''));
                tool.status = failed ? 'error' : 'done';
                if (failed) tool.detail = `Error: ${b.content.error_code ?? 'unknown'}`;
                else if (Array.isArray(b.content)) tool.detail = b.content.map((r: any) => `${r.title ?? ''} ${r.url ?? ''}`.trim()).join('\n');
                else if (b.content?.url) tool.detail = b.content.url;
            }
        }
        if (block) {
            ui.blocks.push(block);
            byIndex.set(event.index, ui.blocks[ui.blocks.length - 1]);
        }
    } else if (event.type === 'content_block_delta') {
        const block = byIndex.get(event.index);
        if (!block) return;
        if (event.delta.type === 'text_delta' && block.type === 'text') block.text += event.delta.text;
        else if (event.delta.type === 'thinking_delta' && block.type === 'thinking') block.text += event.delta.thinking;
        else if (event.delta.type === 'input_json_delta' && block.type === 'tool' && block.partial !== undefined) block.partial += event.delta.partial_json;
    } else if (event.type === 'content_block_stop') {
        const block = byIndex.get(event.index);
        if (block?.type === 'tool' && block.partial !== undefined) {
            try {
                block.label = describeToolCall(block.name, JSON.parse(block.partial || '{}'));
            } catch {
                // keep the generic label
            }
            delete block.partial;
        }
        if (block?.type === 'thinking' && block.text.trim() === '') {
            const i = ui.blocks.indexOf(block);
            if (i !== -1) ui.blocks.splice(i, 1);
        }
    }
}

// ---------------------------------------------------------------------------
// Backend 2: Claude Code on this computer, through the local bridge
// ---------------------------------------------------------------------------

async function runClaudeCodeTurn(ui: UiMessage, content: BetaContentBlockParam[]) {
    if (!sessionId) sessionId = newId();
    const abort = new AbortController();
    let runId: string | null = null;
    stopCurrent = () => {
        abort.abort();
        if (runId) fetch('./__claude-code/stop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ runId }) }).catch(() => {});
    };

    const tools = toolDefinitions.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema }));
    const byIndex = new Map<number, UiBlock>();
    let gotResult = false;
    let stderr = '';

    try {
        const res = await fetch('./__claude-code/run', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                sessionId,
                resume: sessionStarted,
                message: content,
                model: claudeSettings.model,
                effort: claudeSettings.effort,
                systemPrompt: SYSTEM_PROMPT + CC_TOOL_NOTE,
                tools,
                folder: claudeSettings.folder?.path ?? null,
                web: claudeSettings.web
            }),
            signal: abort.signal
        });
        if (!res.ok || !res.body) {
            let msg = `The local Claude Code bridge answered ${res.status}.`;
            try {
                msg = (await res.json()).error ?? msg;
            } catch {
                // keep default
            }
            throw new Error(msg);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            let nl: number;
            while ((nl = buf.indexOf('\n')) !== -1) {
                const line = buf.slice(0, nl).trim();
                buf = buf.slice(nl + 1);
                if (!line) continue;
                let msg: any;
                try {
                    msg = JSON.parse(line);
                } catch {
                    continue;
                }
                if (msg.kind === 'run') {
                    runId = msg.runId;
                } else if (msg.kind === 'tool_call') {
                    // Claude Code wants an editor tool run: do it here and hand the result back.
                    const name = String(msg.name ?? '');
                    const block = ui.blocks.find((b): b is ToolBlock => b.type === 'tool' && b.name === name && b.status === 'running' && !b.detail);
                    const r = abort.signal.aborted ? { text: 'Stopped by the user.', isError: true } : await execTool(name, msg.input, block);
                    await fetch('./__claude-code/tool-result', {
                        method: 'POST',
                        headers: { 'content-type': 'application/json' },
                        body: JSON.stringify({ runId, callId: msg.callId, text: r.text, isError: r.isError, images: r.images })
                    }).catch(() => {});
                } else if (msg.kind === 'cc') {
                    const ev = msg.event;
                    if (ev.type === 'system' && ev.subtype === 'init') {
                        sessionStarted = true;
                    } else if (ev.type === 'stream_event' && !ev.parent_tool_use_id) {
                        handleStreamEvent(ui, byIndex, ev.event, CC_PREFIX);
                    } else if (ev.type === 'assistant' && !ev.parent_tool_use_id && Array.isArray(ev.message?.content)) {
                        // Complete tool inputs arrive here; label Claude Code's own tools (Read, WebSearch, ...).
                        for (const c of ev.message.content) {
                            if (c.type !== 'tool_use' || String(c.name).startsWith(CC_PREFIX)) continue;
                            const block = ui.blocks.find((b): b is ToolBlock => b.type === 'tool' && b.id === c.id);
                            if (block) block.label = describeToolCall(c.name, c.input ?? {});
                        }
                    } else if (ev.type === 'user' && Array.isArray(ev.message?.content)) {
                        for (const c of ev.message.content) {
                            if (c.type !== 'tool_result') continue;
                            const block = ui.blocks.find((b): b is ToolBlock => b.type === 'tool' && b.id === c.tool_use_id);
                            if (block && block.status === 'running') {
                                block.status = c.is_error ? 'error' : 'done';
                                if (!block.detail) block.detail = toolResultText(c.content);
                            }
                        }
                    } else if (ev.type === 'result') {
                        gotResult = true;
                        const u = ev.usage ?? {};
                        chat.usage.input += u.input_tokens ?? 0;
                        chat.usage.output += u.output_tokens ?? 0;
                        chat.usage.cacheRead += u.cache_read_input_tokens ?? 0;
                        chat.usage.cacheWrite += u.cache_creation_input_tokens ?? 0;
                        if (ev.is_error) {
                            const detail = Array.isArray(ev.errors) && ev.errors.length ? ev.errors.join(' ') : ev.result || ev.subtype;
                            ui.blocks.push({ type: 'notice', tone: 'error', text: `Claude Code reported an error: ${detail}` });
                        } else if (ev.stop_reason === 'refusal') {
                            ui.blocks.push({ type: 'notice', tone: 'error', text: 'Claude declined this request. Try rephrasing it.' });
                        }
                    }
                } else if (msg.kind === 'error') {
                    ui.blocks.push({ type: 'notice', tone: 'error', text: msg.message });
                } else if (msg.kind === 'exit') {
                    stderr = msg.stderr ?? '';
                }
            }
        }
        if (!gotResult && !abort.signal.aborted) {
            const hint = /not logged in|login|authenticat/i.test(stderr) ? ' Sign in by running "claude auth login" in Terminal.' : '';
            const resumeHint = /no conversation found|session/i.test(stderr) ? ' This chat\'s Claude Code session is gone; start a new chat.' : '';
            ui.blocks.push({ type: 'notice', tone: 'error', text: `Claude Code stopped unexpectedly.${hint}${resumeHint}${stderr && !hint && !resumeHint ? ` (${stderr.trim().split('\n').pop()})` : ''}` });
        }
    } catch (err) {
        if (abort.signal.aborted) ui.blocks.push({ type: 'notice', tone: 'info', text: 'Stopped.' });
        else ui.blocks.push({ type: 'notice', tone: 'error', text: `Could not reach Claude Code: ${(err as Error).message}` });
    }
    ui.blocks = ui.blocks.filter((b) => !(b.type === 'thinking' && b.text.trim() === ''));
}

/** Text of a Claude Code tool result for the chat, leaving out embedded files and images. */
function toolResultText(content: unknown): string {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return JSON.stringify(content);
    return content
        .map((c: any) => (c?.type === 'text' ? c.text : c?.type === 'image' ? '[image]' : c?.type === 'document' ? '[document]' : ''))
        .filter(Boolean)
        .join('\n');
}
