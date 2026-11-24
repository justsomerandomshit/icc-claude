{#snippet svg(name: 'spark' | 'undo' | 'close' | 'send' | 'history' | 'terminal' | 'key' | 'folder' | 'globe')}
    <svg class="cs-svg" class:accent={name === 'spark'} viewBox="0 0 24 24" aria-hidden="true">
        {#if name === 'spark'}
            <path fill="currentColor" d="M12 2l2.4 7.6L22 12l-7.6 2.4L12 22l-2.4-7.6L2 12l7.6-2.4z" />
        {:else if name === 'undo'}
            <path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M9 14L4 9l5-5M4 9h10.5a5.5 5.5 0 010 11H11" />
        {:else if name === 'close'}
            <path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M6 6l12 12M18 6L6 18" />
        {:else if name === 'history'}
            <path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M3 12a9 9 0 103-6.7L3 8M3 3v5h5M12 7v5l3 3" />
        {:else if name === 'terminal'}
            <path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M4 5h16v14H4zM7 9l3 3-3 3M12 15h5" />
        {:else if name === 'folder'}
            <path fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" d="M3 6.5A1.5 1.5 0 014.5 5h4l2 2.5h9A1.5 1.5 0 0121 9v9.5a1.5 1.5 0 01-1.5 1.5h-15A1.5 1.5 0 013 18.5z" />
        {:else if name === 'globe'}
            <path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M12 3a9 9 0 100 18 9 9 0 000-18zM3.5 9h17M3.5 15h17M12 3c-2.5 2.7-3.5 5.7-3.5 9s1 6.3 3.5 9c2.5-2.7 3.5-5.7 3.5-9s-1-6.3-3.5-9z" />
        {:else if name === 'key'}
            <path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M14 10a4 4 0 11-1.2-2.8M12.8 7.2L20 0M17 3l3 3M15 5l2 2" transform="translate(-2 6)" />
        {:else}
            <path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" d="M12 19V5M6 11l6-6 6 6" />
        {/if}
    </svg>
{/snippet}

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<aside
    class="claude-sidebar"
    class:cs-dark={dark}
    class:narrow={isNarrow}
    class:dragging={dragDepth > 0}
    style={isNarrow ? '' : `width: ${claudeUi.width}px;`}
    aria-label="Claude assistant"
    ondragenter={onDragEnter}
    ondragover={onDragOver}
    ondragleave={onDragLeave}
    ondrop={onDrop}
>
    {#if !isNarrow}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="resize-handle" onpointerdown={startResize} title="Drag to resize"></div>
    {/if}
    {#if dragDepth > 0 && ready}
        <div class="cs-drop">Drop images to attach them</div>
    {/if}
    <header class="cs-header">
        <div class="cs-title">
            {@render svg('spark')}
            <span>Claude</span>
            {#if ready}
                <span class="cs-model">{modelLabel} · {claudeSettings.backend === 'claude-code' ? 'Claude Code' : 'API'}</span>
            {/if}
        </div>
        <div class="cs-actions">
            {#if ready}
                <button type="button" class="icon-btn" title={undoTitle} aria-label="Undo Claude's last edit" disabled={chat.canUndo === 0 || chat.running} onclick={undo}>
                    {@render svg('undo')}
                    {#if chat.canUndo > 0}<span class="badge">{chat.canUndo}</span>{/if}
                </button>
                <button type="button" class="icon-btn" class:active={panel === 'history'} title="Chat history" aria-label="Chat history" onclick={() => togglePanel('history')}>
                    {@render svg('history')}
                </button>
                <button type="button" class="icon-btn" title="New chat" aria-label="New chat" disabled={chat.messages.length === 0} onclick={startNewChat}>
                    <i class="mdi mdi-comment-plus"></i>
                </button>
                <button type="button" class="icon-btn" class:active={panel === 'settings'} title="Settings" aria-label="Settings" onclick={() => togglePanel('settings')}>
                    <i class="mdi mdi-cog"></i>
                </button>
            {/if}
            <button type="button" class="icon-btn" title="Close" aria-label="Close sidebar" onclick={toggleClaude}>
                {@render svg('close')}
            </button>
        </div>
    </header>

    {#if !ready}
        <section class="cs-signin">
            <h3>Connect Claude</h3>
            <p>Claude can read this CYOA and make any change you could make in the editor. Choose how to connect:</p>

            <div class="cs-option" class:selected={choice === 'claude-code'}>
                <button type="button" class="cs-option-head" onclick={() => (choice = 'claude-code')}>
                    {@render svg('terminal')}
                    <span>
                        <b>Claude Code on this computer</b>
                        <small>Uses your Claude account (Pro, Max, Team…). No API key.</small>
                    </span>
                </button>
                {#if choice === 'claude-code'}
                    <div class="cs-option-body">
                        {#if claudeCode.checking && !claudeCode.checked}
                            <p>Looking for Claude Code…</p>
                        {:else if !claudeCode.bridge}
                            <p>
                                This only works when ICC Plus is opened with the <b>Launch ICC Plus</b> shortcut on your computer (not the hosted website), because the browser can't start Claude Code by itself.
                            </p>
                        {:else if !claudeCode.available}
                            <p>Claude Code isn't installed. Install it from <a href="https://claude.com/claude-code" target="_blank" rel="noopener noreferrer">claude.com/claude-code</a>, then check again.</p>
                        {:else if !claudeCode.loggedIn}
                            <p>Claude Code {claudeCode.version ? `(${claudeCode.version}) ` : ''}is installed but not signed in. Open Terminal, run <code>claude auth login</code>, sign in with your Claude account, then check again.</p>
                        {:else}
                            <p>
                                Found Claude Code {claudeCode.version?.replace(/\s*\(Claude Code\)/, '') ?? ''}, signed in{claudeCode.email ? ` as ${claudeCode.email}` : ''}{claudeCode.authMethod === 'claude.ai' ? ' with your Claude account' : ''}.
                            </p>
                            <button type="button" class="cs-primary" onclick={() => connect('claude-code')}>Use Claude Code</button>
                        {/if}
                        {#if !claudeCode.loggedIn}
                            <button type="button" class="cs-secondary" disabled={claudeCode.checking} onclick={checkClaudeCode}>{claudeCode.checking ? 'Checking…' : 'Check again'}</button>
                        {/if}
                    </div>
                {/if}
            </div>

            <div class="cs-option" class:selected={choice === 'api'}>
                <button type="button" class="cs-option-head" onclick={() => (choice = 'api')}>
                    {@render svg('key')}
                    <span>
                        <b>Claude API key</b>
                        <small>Works anywhere, including the hosted site. Billed to your Claude Console account.</small>
                    </span>
                </button>
                {#if choice === 'api'}
                    <form class="cs-option-body" onsubmit={doSignIn}>
                        <ol>
                            <li>Open <a href="https://platform.claude.com/settings/keys" target="_blank" rel="noopener noreferrer">API keys in the Claude Console</a> and sign in.</li>
                            <li>Click <b>Create key</b>, then copy it and paste it below.</li>
                        </ol>
                        <label class="cs-field">
                            <span>API key</span>
                            <input type="password" bind:value={keyInput} placeholder="sk-ant-…" autocomplete="off" spellcheck="false" />
                        </label>
                        <details class="cs-more">
                            <summary>Key not scoped to a workspace?</summary>
                            <label class="cs-field">
                                <span>Workspace ID (optional)</span>
                                <input type="text" bind:value={workspaceInput} placeholder="wrkspc_…" autocomplete="off" spellcheck="false" />
                            </label>
                        </details>
                        <label class="cs-check">
                            <input type="checkbox" bind:checked={rememberInput} />
                            <span>Keep me signed in on this browser</span>
                        </label>
                        {#if signInError}
                            <div class="cs-notice error">{signInError}</div>
                        {/if}
                        <button type="submit" class="cs-primary" disabled={signingIn || keyInput.trim() === ''}>
                            {signingIn ? 'Checking…' : 'Sign in'}
                        </button>
                        <p class="cs-fine">Your key stays in this browser and is sent only to api.anthropic.com.</p>
                    </form>
                {/if}
            </div>
        </section>
    {:else}
        {#if panel === 'settings'}
            <section class="cs-settings">
                <div class="cs-field">
                    <span>Connection</span>
                    <div class="cs-seg">
                        <button type="button" class:on={claudeSettings.backend === 'claude-code'} onclick={() => switchBackend('claude-code')}>Claude Code</button>
                        <button type="button" class:on={claudeSettings.backend === 'api'} onclick={() => switchBackend('api')}>API key</button>
                    </div>
                </div>
                <label class="cs-field">
                    <span>Model</span>
                    <select bind:value={claudeSettings.model} onchange={persistSettings}>
                        {#each MODELS as m (m.id)}
                            <option value={m.id}>{m.label}</option>
                        {/each}
                    </select>
                </label>
                <label class="cs-field">
                    <span>Effort</span>
                    <select bind:value={claudeSettings.effort} onchange={persistSettings}>
                        {#each EFFORTS as e (e)}
                            <option value={e}>{effortLabels[e]}</option>
                        {/each}
                    </select>
                </label>
                <label class="cs-check">
                    <input type="checkbox" bind:checked={claudeSettings.showThinking} onchange={persistSettings} />
                    <span>Show Claude's thinking</span>
                </label>
                <label class="cs-check">
                    <input type="checkbox" bind:checked={claudeSettings.web} onchange={persistSettings} />
                    <span>
                        Let Claude search the web and download images
                        {#if claudeSettings.backend === 'api'}<small class="cs-fine">Web searches are billed by the API ($10 per 1,000 searches).</small>{/if}
                    </span>
                </label>
                {#if claudeSettings.backend === 'claude-code'}
                    <label class="cs-check">
                        <input type="checkbox" bind:checked={claudeSettings.shell} onchange={persistSettings} />
                        <span>
                            Let Claude run commands (unzip, convert, Python)
                            <small class="cs-fine">Sandboxed: it can only write in its own work folder for each chat, can't read your passwords or browser data, and can only reach PyPI.</small>
                        </span>
                    </label>
                    {#if claudeCode.mcpServers?.length}
                        <div class="cs-mcp">
                            <div class="cs-mcp-head">Tools from your Claude Code setup</div>
                            {#each claudeCode.mcpServers as server (server.name)}
                                <label class="cs-check">
                                    <input type="checkbox" checked={mcpOn.includes(server.name)} onchange={(e) => setMcpEnabled(server.name, (e.currentTarget as HTMLInputElement).checked)} />
                                    <span>{server.name} <small class="cs-fine cs-inline">{server.type === 'stdio' ? 'runs on this Mac' : 'online service'}</small></span>
                                </label>
                            {/each}
                        </div>
                    {/if}
                    <div class="cs-field">
                        <span>Reference folder</span>
                        {#if claudeSettings.folder}
                            <div class="cs-folder-card">
                                <div class="cs-folder-path" title={claudeSettings.folder.path}>{claudeSettings.folder.path}</div>
                                <div class="cs-fine">{folderCounts(claudeSettings.folder)}</div>
                            </div>
                        {:else}
                            <div class="cs-fine">None. Claude Code can read PDFs, images and notes in a folder you choose, but never change them.</div>
                        {/if}
                        <div class="cs-folder-actions">
                            <button type="button" class="cs-secondary" disabled={folderBusy} onclick={chooseFolder}>{claudeSettings.folder ? 'Change…' : 'Choose folder…'}</button>
                            <button type="button" class="cs-link" onclick={() => (folderTyping = !folderTyping)}>Type a path</button>
                            {#if claudeSettings.folder}<button type="button" class="cs-link" onclick={() => setReferenceFolder(null)}>Remove</button>{/if}
                        </div>
                        {#if folderTyping}
                            <form class="cs-folder-type" onsubmit={(e) => { e.preventDefault(); typeFolder(); }}>
                                <input type="text" bind:value={folderInput} placeholder="~/Documents/My CYOA references" spellcheck="false" />
                                <button type="submit" class="cs-secondary" disabled={folderBusy || folderInput.trim() === ''}>Use</button>
                            </form>
                        {/if}
                        {#if folderError}<div class="cs-notice error">{folderError}</div>{/if}
                    </div>
                {/if}
                <div class="cs-account">
                    {#if claudeSettings.backend === 'claude-code'}
                        <div>Using Claude Code{claudeCode.email ? ` as ${claudeCode.email}` : ''}.</div>
                    {:else}
                        <div>Signed in with key <code>{claudeSettings.account?.keyHint}</code>{claudeSettings.workspaceId ? ` · ${claudeSettings.workspaceId}` : ''}</div>
                    {/if}
                    <div class="cs-fine">This chat: {fmt(chat.usage.input + chat.usage.cacheRead + chat.usage.cacheWrite)} input tokens ({fmt(chat.usage.cacheRead)} cached), {fmt(chat.usage.output)} output tokens.</div>
                    {#if claudeSettings.backend === 'api'}
                        <button type="button" class="cs-link" onclick={doSignOut}>Sign out of API key</button>
                    {:else}
                        <button type="button" class="cs-link" onclick={() => useBackend(null)}>Disconnect Claude Code</button>
                    {/if}
                </div>
            </section>
        {:else if panel === 'history'}
            <section class="cs-history">
                <button type="button" class="cs-history-new" onclick={startNewChat}><i class="mdi mdi-comment-plus"></i> New chat</button>
                {#if chat.list.length === 0}
                    <p class="cs-fine">No saved chats yet.</p>
                {/if}
                {#each chat.list as item (item.id)}
                    <div class="cs-history-item" class:current={item.id === chat.id}>
                        <button type="button" class="cs-history-open" onclick={() => pickChat(item.id)} disabled={chat.running}>
                            <span class="cs-history-title">{item.title}</span>
                            <small>{item.backend === 'claude-code' ? 'Claude Code' : 'API'} · {when(item.updatedAt)}</small>
                        </button>
                        <button type="button" class="icon-btn small" title="Delete chat" aria-label="Delete chat" onclick={() => removeChat(item.id)} disabled={chat.running && item.id === chat.id}>
                            <i class="mdi mdi-delete-forever"></i>
                        </button>
                    </div>
                {/each}
            </section>
        {/if}

        <div class="cs-messages" bind:this={scroller} onscroll={onScroll}>
            {#if chat.messages.length === 0}
                <div class="cs-empty">
                    <p>Ask Claude to build, change or explain anything in this project. You can attach, paste or drop images too.</p>
                    {#each suggestions as s (s)}
                        <button type="button" class="cs-suggestion" onclick={() => submit(s)}>{s}</button>
                    {/each}
                </div>
            {/if}
            {#each chat.messages as msg, mi (mi)}
                <div class="cs-msg {msg.role}">
                    {#if msg.images && msg.images.length}
                        <div class="cs-images">
                            {#each msg.images as img, ii (ii)}
                                <img src={img.url} alt={img.name} title={img.name} />
                            {/each}
                        </div>
                    {/if}
                    {#each msg.blocks as block, bi (bi)}
                        {#if block.type === 'text'}
                            {#if msg.role === 'user'}
                                {#if block.text}<div class="cs-bubble">{block.text}</div>{/if}
                            {:else if block.text}
                                <div class="cs-md">{@html renderMarkdown(block.text)}</div>
                            {/if}
                        {:else if block.type === 'thinking'}
                            {#if claudeSettings.showThinking}
                                <details class="cs-thinking">
                                    <summary>{@render svg('spark')} Thinking</summary>
                                    <div class="cs-md">{@html renderMarkdown(block.text)}</div>
                                </details>
                            {/if}
                        {:else if block.type === 'tool'}
                            <details class="cs-tool {block.status}">
                                <summary>
                                    {#if block.status === 'running'}<span class="cs-spinner"></span>{:else}<i class="mdi {toolIcon(block)}"></i>{/if}
                                    <span>{block.label}</span>
                                </summary>
                                {#if block.detail}
                                    <pre>{block.detail.length > 4000 ? `${block.detail.slice(0, 4000)}…` : block.detail}</pre>
                                {/if}
                            </details>
                            {#if block.thumbs?.length}
                                <div class="cs-tool-thumbs">
                                    {#each block.thumbs as t, ti (ti)}<img src={t} alt="" />{/each}
                                </div>
                            {/if}
                        {:else if block.type === 'notice'}
                            <div class="cs-notice {block.tone}">{block.text}</div>
                        {/if}
                    {/each}
                    {#if msg.role === 'assistant' && chat.running && mi === chat.messages.length - 1}
                        <div class="cs-typing"><span></span><span></span><span></span></div>
                    {/if}
                </div>
            {/each}
        </div>

        <form class="cs-composer" onsubmit={(e) => { e.preventDefault(); submit(); }}>
            {#if pendingFiles.length}
                <div class="cs-pending">
                    {#each pendingFiles as f, i (f.url)}
                        <div class="cs-chip" title={f.file.name}>
                            <img src={f.url} alt={f.file.name} />
                            <button type="button" aria-label="Remove attachment" onclick={() => removeFile(i)}>{@render svg('close')}</button>
                        </div>
                    {/each}
                </div>
            {/if}
            {#if attachError}
                <div class="cs-notice error">{attachError}</div>
            {/if}
            {#if folderError && panel !== 'settings'}
                <div class="cs-notice error">{folderError}</div>
            {/if}
            <div class="cs-context">
                {#if claudeSettings.backend === 'claude-code'}
                    {#if claudeSettings.folder}
                        <span class="cs-ctx-chip on" title={`${claudeSettings.folder.path}\n${folderCounts(claudeSettings.folder)}\nClaude can read these files but not change them.`}>
                            <button type="button" class="cs-ctx-main" onclick={chooseFolder} disabled={folderBusy || chat.running}>
                                {@render svg('folder')}<span class="cs-ctx-name">{claudeSettings.folder.name}</span>
                            </button>
                            <button type="button" class="cs-ctx-x" aria-label="Stop using this folder" title="Stop using this folder" onclick={() => setReferenceFolder(null)} disabled={chat.running}>{@render svg('close')}</button>
                        </span>
                    {:else}
                        <button type="button" class="cs-ctx-chip" onclick={chooseFolder} disabled={folderBusy || chat.running} title="Let Claude read PDFs, images and notes in a folder">
                            {@render svg('folder')}<span>{folderBusy ? 'Choosing…' : 'Add folder'}</span>
                        </button>
                    {/if}
                {/if}
                <button
                    type="button"
                    class="cs-ctx-chip"
                    class:on={claudeSettings.web}
                    aria-pressed={claudeSettings.web}
                    title={claudeSettings.web ? 'Web on: Claude can search the web and download images. Click to turn off.' : 'Web off. Click to let Claude search the web and download images.'}
                    onclick={() => { claudeSettings.web = !claudeSettings.web; persistSettings(); }}
                >
                    {@render svg('globe')}<span>Web {claudeSettings.web ? 'on' : 'off'}</span>
                </button>
            </div>
            <textarea
                bind:this={inputEl}
                bind:value={draft}
                rows="1"
                placeholder="Message Claude…"
                onkeydown={onKey}
                oninput={autoGrow}
                onpaste={onPaste}
            ></textarea>
            <div class="cs-composer-row">
                <input bind:this={fileEl} type="file" accept="image/*" multiple hidden onchange={onFiles} />
                <button type="button" class="icon-btn" title="Attach images" aria-label="Attach images" onclick={() => fileEl?.click()} disabled={chat.running}>
                    <i class="mdi mdi-file-image"></i>
                </button>
                <span class="cs-hint">Enter to send · Shift+Enter for a new line</span>
                {#if chat.running}
                    <button type="button" class="cs-send stop" title="Stop" aria-label="Stop" onclick={stop}><i class="mdi mdi-stop"></i></button>
                {:else}
                    <button type="submit" class="cs-send" title="Send" aria-label="Send" disabled={draft.trim() === '' && pendingFiles.length === 0}>{@render svg('send')}</button>
                {/if}
            </div>
        </form>
    {/if}
</aside>

<script lang="ts">
    import { onMount, tick } from 'svelte';
    import { claudeUi, saveClaudeUi, toggleClaude } from './ui.svelte';
    import {
        checkClaudeCode,
        claudeCode,
        claudeSettings,
        EFFORTS,
        isReady,
        MODELS,
        persistSettings,
        pickReferenceFolder,
        enabledMcp,
        setMcpEnabled,
        refreshReferenceFolder,
        setReferenceFolder,
        signIn,
        signOut,
        useBackend,
        useReferenceFolderPath,
        type Backend,
        type ReferenceFolder
    } from './settings.svelte';
    import { chat, deleteChat, initChats, lastEditLabel, MAX_IMAGE_BYTES, newChat, openChat, send, stop, undoFromUi, type ToolBlock } from './agent.svelte';
    import { renderMarkdown } from './markdown';
    import { snackbarVariables } from '$lib/store/store.svelte';

    let suggestions = $derived([
        ...(claudeSettings.backend === 'claude-code' && claudeSettings.folder
            ? [`Read the files in "${claudeSettings.folder.name}" and build rows and choices from them.`]
            : []),
        ...(claudeSettings.web ? ['Find a fitting image online for each choice in the first row.'] : []),
        'Give me an overview of this project and anything that looks broken.',
        'Add a point type called "Gold" starting at 30, and give every choice in the first row a cost of 5 Gold.',
        'How do discounts work, and how would I set one up?'
    ]);
    const effortLabels: Record<string, string> = { low: 'Low (fastest)', medium: 'Medium', high: 'High', xhigh: 'Extra high (most thorough)' };

    let choice = $state<Backend>('claude-code');
    let keyInput = $state('');
    let workspaceInput = $state(claudeSettings.workspaceId);
    let rememberInput = $state(true);
    let signingIn = $state(false);
    let signInError = $state('');
    let panel = $state<'none' | 'settings' | 'history'>('none');
    let draft = $state('');
    let pendingFiles = $state<{ file: File; url: string }[]>([]);
    let attachError = $state('');
    let dragDepth = $state(0);
    let scroller = $state<HTMLDivElement>();
    let inputEl = $state<HTMLTextAreaElement>();
    let fileEl = $state<HTMLInputElement>();
    let stickToBottom = true;
    let winWidth = $state(window.innerWidth);
    let dark = $state(editorIsDark());
    let mcpOn = $derived.by(() => {
        void claudeSettings.mcp;
        void claudeCode.mcpServers;
        return enabledMcp();
    });
    let folderBusy = $state(false);
    let folderError = $state('');
    let folderTyping = $state(false);
    let folderInput = $state('');

    function folderCounts(f: ReferenceFolder) {
        const c = f.counts;
        const parts = [c.pdf && `${c.pdf} PDF${c.pdf === 1 ? '' : 's'}`, c.book && `${c.book} ebook${c.book === 1 ? '' : 's'}/doc${c.book === 1 ? '' : 's'}`, c.image && `${c.image} image${c.image === 1 ? '' : 's'}`, c.text && `${c.text} text file${c.text === 1 ? '' : 's'}`, c.other && `${c.other} other`].filter(Boolean);
        return `${f.total}${f.truncated ? '+' : ''} file${f.total === 1 ? '' : 's'}${parts.length ? `: ${parts.join(', ')}` : ''}`;
    }

    async function chooseFolder() {
        folderBusy = true;
        folderError = '';
        try {
            await pickReferenceFolder();
        } catch (e) {
            folderError = (e as Error).message;
            folderTyping = true;
        } finally {
            folderBusy = false;
        }
    }

    async function typeFolder() {
        folderBusy = true;
        folderError = '';
        try {
            await useReferenceFolderPath(folderInput);
            folderInput = '';
            folderTyping = false;
        } catch (e) {
            folderError = (e as Error).message;
        } finally {
            folderBusy = false;
        }
    }

    // The editor switches themes by changing which stylesheet is active (it follows the system
    // setting, inverted by its Dark/Light toggle). Read that directly so the sidebar always matches.
    function editorIsDark() {
        const link = document.getElementById('theme-dark') as HTMLLinkElement | null;
        if (!link) return window.matchMedia('(prefers-color-scheme: dark)').matches;
        const media = (link.media || 'all').trim();
        if (media === 'all') return true;
        if (media === 'not all') return false;
        return window.matchMedia(media).matches;
    }

    let ready = $derived.by(() => {
        void claudeCode.loggedIn;
        void claudeSettings.apiKey;
        void claudeSettings.backend;
        return isReady();
    });
    let isNarrow = $derived(winWidth < 900);
    let modelLabel = $derived(MODELS.find((m) => m.id === claudeSettings.model)?.label.replace('Claude ', '') ?? claudeSettings.model);
    let undoTitle = $derived(chat.canUndo > 0 ? `Undo: ${lastEditLabel() ?? ''}` : "Undo Claude's last edit");

    onMount(() => {
        checkClaudeCode().then(() => {
            // Default the sign-in choice to whatever is usable on this computer.
            if (!claudeSettings.backend) choice = claudeCode.bridge ? 'claude-code' : 'api';
            if (claudeCode.bridge) refreshReferenceFolder();
        });
        initChats();
        const onResize = () => (winWidth = window.innerWidth);
        window.addEventListener('resize', onResize);
        const updateTheme = () => (dark = editorIsDark());
        const scheme = window.matchMedia('(prefers-color-scheme: dark)');
        scheme.addEventListener('change', updateTheme);
        const observer = new MutationObserver(updateTheme);
        for (const id of ['theme-dark', 'theme-light']) {
            const el = document.getElementById(id);
            if (el) observer.observe(el, { attributes: true, attributeFilter: ['media'] });
        }
        return () => {
            window.removeEventListener('resize', onResize);
            scheme.removeEventListener('change', updateTheme);
            observer.disconnect();
        };
    });

    // Keep the newest message in view while streaming, unless the user scrolled up.
    $effect(() => {
        JSON.stringify(chat.messages);
        if (stickToBottom && scroller) {
            tick().then(() => scroller && (scroller.scrollTop = scroller.scrollHeight));
        }
    });

    function onScroll() {
        if (!scroller) return;
        stickToBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 60;
    }

    function togglePanel(p: 'settings' | 'history') {
        panel = panel === p ? 'none' : p;
    }

    async function connect(backend: Backend) {
        useBackend(backend);
        await tick();
        inputEl?.focus();
    }

    async function doSignIn(e: SubmitEvent) {
        e.preventDefault();
        signingIn = true;
        signInError = '';
        try {
            await signIn(keyInput, workspaceInput, rememberInput);
            keyInput = '';
            await tick();
            inputEl?.focus();
        } catch (err) {
            signInError = (err as Error).message;
        } finally {
            signingIn = false;
        }
    }

    function doSignOut() {
        signOut();
        panel = 'none';
    }

    async function switchBackend(backend: Backend) {
        if (backend === claudeSettings.backend) return;
        if (backend === 'claude-code') {
            await checkClaudeCode();
            if (!claudeCode.loggedIn) {
                choice = 'claude-code';
                useBackend(null);
                return;
            }
        } else if (!claudeSettings.apiKey) {
            choice = 'api';
            useBackend(null);
            return;
        }
        useBackend(backend);
    }

    async function startNewChat() {
        await newChat();
        panel = 'none';
        inputEl?.focus();
    }

    async function pickChat(id: string) {
        await openChat(id);
        // Follow the chat's connection so it can be continued.
        if (chat.backend && chat.backend !== claudeSettings.backend) await switchBackend(chat.backend);
        panel = 'none';
        stickToBottom = true;
    }

    async function removeChat(id: string) {
        await deleteChat(id);
    }

    function when(t: number) {
        const d = new Date(t);
        const today = new Date();
        return d.toDateString() === today.toDateString()
            ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
    }

    async function undo() {
        const label = await undoFromUi();
        snackbarVariables.labelText = label ? `Undid: ${label}` : 'Nothing to undo.';
        snackbarVariables.isOpen = true;
    }

    function submit(text = draft) {
        if (chat.running) return;
        const files = pendingFiles.map((f) => f.file);
        if (text.trim() === '' && files.length === 0) return;
        for (const f of pendingFiles) URL.revokeObjectURL(f.url);
        pendingFiles = [];
        attachError = '';
        draft = '';
        stickToBottom = true;
        tick().then(autoGrow);
        send(text, files);
    }

    function onKey(e: KeyboardEvent) {
        e.stopPropagation();
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
            e.preventDefault();
            submit();
        }
    }

    function autoGrow() {
        if (!inputEl) return;
        inputEl.style.height = 'auto';
        inputEl.style.height = `${Math.min(inputEl.scrollHeight, 220)}px`;
    }

    function addFiles(list: Iterable<File>) {
        const rejected: string[] = [];
        for (const file of list) {
            if (!file.type.startsWith('image/')) {
                rejected.push(`${file.name || 'file'} is not an image`);
                continue;
            }
            if (file.size > MAX_IMAGE_BYTES) {
                rejected.push(`${file.name} is over ${MAX_IMAGE_BYTES / 1024 / 1024} MB`);
                continue;
            }
            pendingFiles.push({ file, url: URL.createObjectURL(file) });
        }
        attachError = rejected.length ? `Not attached: ${rejected.join('; ')}.` : '';
        inputEl?.focus();
    }

    function onFiles(e: Event) {
        const input = e.currentTarget as HTMLInputElement;
        if (input.files) addFiles(Array.from(input.files));
        input.value = '';
    }

    function onPaste(e: ClipboardEvent) {
        const files = Array.from(e.clipboardData?.files ?? []);
        if (files.length) {
            e.preventDefault();
            addFiles(files);
        }
    }

    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');

    function onDragEnter(e: DragEvent) {
        if (!hasFiles(e)) return;
        e.preventDefault();
        dragDepth++;
    }

    function onDragOver(e: DragEvent) {
        if (!hasFiles(e)) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = ready ? 'copy' : 'none';
    }

    function onDragLeave(e: DragEvent) {
        if (!hasFiles(e)) return;
        dragDepth = Math.max(0, dragDepth - 1);
    }

    function onDrop(e: DragEvent) {
        if (!hasFiles(e)) return;
        e.preventDefault();
        dragDepth = 0;
        if (ready && !chat.running) addFiles(Array.from(e.dataTransfer?.files ?? []));
    }

    function removeFile(i: number) {
        URL.revokeObjectURL(pendingFiles[i].url);
        pendingFiles.splice(i, 1);
    }

    function toolIcon(block: ToolBlock) {
        if (block.status === 'error') return 'mdi-close-circle';
        if (block.status === 'cancelled') return 'mdi-minus-circle-outline';
        return block.changed ? 'mdi-pencil' : 'mdi-checkbox-marked-circle-outline';
    }

    function fmt(n: number) {
        return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
    }

    function startResize(e: PointerEvent) {
        e.preventDefault();
        const startX = e.clientX;
        const startW = claudeUi.width;
        const move = (ev: PointerEvent) => {
            claudeUi.width = Math.min(Math.max(startW + (startX - ev.clientX), 320), Math.min(900, window.innerWidth - 200));
        };
        const up = () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
            saveClaudeUi();
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
    }
</script>

<style>
    .claude-sidebar {
        --cs-bg: #ffffff;
        --cs-fg: rgba(0, 0, 0, 0.87);
        --cs-muted: rgba(0, 0, 0, 0.62);
        --cs-line: rgba(0, 0, 0, 0.14);
        --cs-hover: rgba(0, 0, 0, 0.06);
        --cs-soft: rgba(0, 0, 0, 0.05);
        --cs-input: #ffffff;
        --cs-accent: #ae5230;
        --cs-accent-text: #ae5230;
        --cs-accent-soft: rgba(217, 119, 87, 0.16);
        --cs-error: #c62828;
        --cs-error-soft: rgba(198, 40, 40, 0.1);
        --cs-link: #0b62c4;
        color-scheme: light;
        background: var(--cs-bg);
        position: fixed;
        top: 0;
        right: 0;
        bottom: 0;
        z-index: 6;
        display: flex;
        flex-direction: column;
        border-radius: 0;
        border-left: 1px solid var(--cs-line);
        box-shadow: -4px 0 16px rgba(0, 0, 0, 0.12);
        font-size: 14px;
        line-height: 1.5;
        text-align: left;
        color: var(--cs-fg);
    }
    .claude-sidebar.cs-dark {
        --cs-bg: #1f1f23;
        --cs-fg: rgba(255, 255, 255, 0.92);
        --cs-muted: rgba(255, 255, 255, 0.66);
        --cs-line: rgba(255, 255, 255, 0.16);
        --cs-hover: rgba(255, 255, 255, 0.08);
        --cs-soft: rgba(255, 255, 255, 0.06);
        --cs-input: #2a2a2f;
        --cs-accent: #ae5230;
        --cs-accent-text: #f0a487;
        --cs-accent-soft: rgba(217, 119, 87, 0.22);
        --cs-error: #ff8a80;
        --cs-error-soft: rgba(255, 138, 128, 0.12);
        --cs-link: #8ab4f8;
        color-scheme: dark;
    }
    .claude-sidebar :global(a) {
        color: var(--cs-link);
    }
    .claude-sidebar.narrow {
        left: 0;
        width: 100%;
    }
    .resize-handle {
        position: absolute;
        left: -3px;
        top: 0;
        bottom: 0;
        width: 6px;
        cursor: ew-resize;
        z-index: 1;
    }
    .resize-handle:hover {
        background: rgba(217, 119, 87, 0.4);
    }
    .cs-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 8px 8px 8px 16px;
        border-bottom: 1px solid var(--cs-line);
        min-height: 52px;
    }
    .cs-title {
        display: flex;
        align-items: center;
        gap: 8px;
        font-weight: 600;
        font-size: 16px;
        min-width: 0;
    }
    .cs-svg {
        width: 1em;
        height: 1em;
        flex: none;
    }
    .cs-svg.accent {
        color: var(--cs-accent-text);
    }
    .cs-title {
        font-size: 16px;
    }
    .cs-title .cs-svg {
        width: 20px;
        height: 20px;
    }
    .cs-spinner {
        width: 12px;
        height: 12px;
        flex: none;
        border: 2px solid var(--cs-line);
        border-top-color: var(--cs-accent-text);
        border-radius: 50%;
        animation: cs-spin 0.8s linear infinite;
    }
    @keyframes cs-spin {
        to { transform: rotate(360deg); }
    }
    .cs-model {
        font-weight: 400;
        font-size: 12px;
        color: var(--cs-muted);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }
    .cs-actions {
        display: flex;
        gap: 2px;
    }
    .icon-btn {
        position: relative;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 36px;
        height: 36px;
        border: 0;
        border-radius: 50%;
        background: transparent;
        color: inherit;
        cursor: pointer;
        font-size: 20px;
    }
    .icon-btn:hover:not(:disabled),
    .icon-btn.active {
        background: var(--cs-hover);
    }
    .icon-btn:disabled {
        opacity: 0.35;
        cursor: default;
    }
    .badge {
        position: absolute;
        top: 2px;
        right: 2px;
        min-width: 15px;
        height: 15px;
        padding: 0 3px;
        border-radius: 8px;
        background: var(--cs-accent);
        color: #fff;
        font-size: 10px;
        line-height: 15px;
        text-align: center;
    }
    .cs-signin,
    .cs-settings {
        padding: 16px;
        overflow-y: auto;
    }
    .cs-settings {
        border-bottom: 1px solid var(--cs-line);
        display: grid;
        gap: 10px;
    }
    .cs-signin h3 {
        font-size: 18px;
        margin: 4px 0 8px;
    }
    .cs-signin p,
    .cs-signin ol {
        margin: 0 0 12px;
    }
    .cs-signin ol {
        padding-left: 20px;
        list-style: decimal;
    }
    .cs-signin form {
        display: grid;
        gap: 12px;
        margin-bottom: 12px;
    }
    .cs-field {
        display: grid;
        gap: 4px;
    }
    .cs-field span {
        font-size: 12px;
        color: var(--cs-muted);
    }
    .cs-field input,
    .cs-field select {
        width: 100%;
        padding: 8px 10px;
        border: 1px solid var(--cs-line);
        border-radius: 6px;
        background: transparent;
        color: inherit;
        font: inherit;
    }
    .cs-check {
        display: flex;
        align-items: center;
        gap: 8px;
        cursor: pointer;
    }
    .cs-more summary {
        cursor: pointer;
        font-size: 13px;
        color: var(--cs-muted);
        margin-bottom: 8px;
    }
    .cs-primary {
        padding: 10px;
        border: 0;
        border-radius: 6px;
        background: var(--cs-accent);
        color: #fff;
        font: inherit;
        font-weight: 600;
        cursor: pointer;
    }
    .cs-primary:disabled {
        opacity: 0.55;
        cursor: default;
    }
    .cs-fine {
        font-size: 12px;
        color: var(--cs-muted);
    }
    .cs-account {
        display: grid;
        gap: 4px;
        font-size: 13px;
    }
    .cs-link {
        justify-self: start;
        border: 0;
        background: none;
        padding: 0;
        color: var(--cs-accent-text);
        cursor: pointer;
        font: inherit;
    }
    .cs-messages {
        flex: 1;
        overflow-y: auto;
        padding: 12px 16px;
        display: flex;
        flex-direction: column;
        gap: 14px;
    }
    .cs-empty {
        margin: auto 0;
        display: grid;
        gap: 8px;
    }
    .cs-empty p {
        color: var(--cs-muted);
        margin-bottom: 4px;
    }
    .cs-suggestion {
        text-align: left;
        padding: 8px 12px;
        border: 1px solid var(--cs-line);
        border-radius: 8px;
        background: transparent;
        color: inherit;
        font: inherit;
        font-size: 13px;
        cursor: pointer;
    }
    .cs-suggestion:hover {
        background: var(--cs-hover);
    }
    .cs-msg {
        display: flex;
        flex-direction: column;
        gap: 6px;
        min-width: 0;
    }
    .cs-msg.user {
        align-items: flex-end;
    }
    .cs-bubble {
        max-width: 90%;
        padding: 8px 12px;
        border-radius: 12px 12px 2px 12px;
        background: var(--cs-accent-soft);
        white-space: pre-wrap;
        word-break: break-word;
    }
    .cs-images {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
        justify-content: flex-end;
    }
    .cs-images img {
        max-width: 120px;
        max-height: 120px;
        border-radius: 6px;
        object-fit: cover;
    }
    .cs-md {
        word-break: break-word;
    }
    .cs-md :global(p) {
        margin: 0 0 8px;
    }
    .cs-md :global(p:last-child) {
        margin-bottom: 0;
    }
    .cs-md :global(ul),
    .cs-md :global(ol) {
        margin: 0 0 8px;
        padding-left: 20px;
    }
    .cs-md :global(ul) {
        list-style: disc;
    }
    .cs-md :global(ol) {
        list-style: decimal;
    }
    .cs-md :global(code) {
        padding: 1px 4px;
        border-radius: 4px;
        background: var(--cs-hover);
        font-size: 12.5px;
    }
    .cs-md :global(pre) {
        padding: 8px;
        border-radius: 6px;
        background: var(--cs-hover);
        overflow-x: auto;
        margin: 0 0 8px;
    }
    .cs-md :global(pre code) {
        background: none;
        padding: 0;
    }
    .cs-md :global(h3),
    .cs-md :global(h4),
    .cs-md :global(h5),
    .cs-md :global(h6) {
        font-size: 14px;
        font-weight: 600;
        margin: 8px 0 4px;
    }
    .cs-thinking,
    .cs-tool {
        font-size: 13px;
        border-radius: 6px;
    }
    .cs-thinking summary,
    .cs-tool summary {
        cursor: pointer;
        color: var(--cs-muted);
        display: flex;
        align-items: center;
        gap: 6px;
        list-style: none;
    }
    .cs-thinking summary::-webkit-details-marker,
    .cs-tool summary::-webkit-details-marker {
        display: none;
    }
    .cs-thinking .cs-md {
        margin-top: 4px;
        padding-left: 10px;
        border-left: 2px solid var(--cs-line);
        color: var(--cs-muted);
    }
    .cs-tool {
        padding: 4px 8px;
        background: var(--cs-soft);
    }
    .cs-tool summary span {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .cs-tool.done summary .mdi-pencil {
        color: var(--cs-accent-text);
    }
    .cs-tool.error summary {
        color: var(--cs-error);
        opacity: 1;
    }
    .cs-tool pre {
        margin: 6px 0 2px;
        max-height: 240px;
        overflow: auto;
        font-size: 11.5px;
        white-space: pre-wrap;
        word-break: break-all;
    }
    .cs-tool-thumbs {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        margin: -6px 0 0 22px;
    }
    .cs-tool-thumbs img {
        height: 64px;
        max-width: 120px;
        object-fit: cover;
        border-radius: 6px;
        border: 1px solid var(--cs-line);
        background: var(--cs-soft);
    }
    .cs-check small {
        display: block;
    }
    .cs-mcp {
        display: grid;
        gap: 6px;
    }
    .cs-mcp-head {
        font-size: 12px;
        color: var(--cs-muted);
    }
    .cs-check:has(small:not(.cs-inline)) {
        align-items: flex-start;
    }
    .cs-check:has(small:not(.cs-inline)) input {
        margin-top: 3px;
    }
    .cs-check small.cs-inline {
        display: inline;
        margin-left: 4px;
    }
    .cs-folder-card {
        border: 1px solid var(--cs-line);
        border-radius: 6px;
        padding: 6px 8px;
        display: grid;
        gap: 2px;
    }
    .cs-folder-path {
        font-size: 12.5px;
        word-break: break-all;
    }
    .cs-folder-actions {
        display: flex;
        align-items: center;
        gap: 12px;
        flex-wrap: wrap;
    }
    .cs-folder-actions .cs-secondary {
        padding: 5px 10px;
    }
    .cs-folder-type {
        display: flex;
        gap: 6px;
    }
    .cs-folder-type input {
        flex: 1;
        min-width: 0;
    }
    .cs-folder-type .cs-secondary {
        padding: 5px 10px;
    }
    .cs-context {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        margin-bottom: 6px;
    }
    .cs-ctx-chip {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        max-width: 100%;
        height: 26px;
        padding: 0 9px;
        border: 1px dashed var(--cs-line);
        border-radius: 13px;
        background: transparent;
        color: var(--cs-muted);
        font: inherit;
        font-size: 12px;
        cursor: pointer;
    }
    .cs-ctx-chip:disabled {
        cursor: default;
        opacity: 0.6;
    }
    .cs-ctx-chip.on {
        border-style: solid;
        border-color: transparent;
        background: var(--cs-accent-soft);
        color: var(--cs-accent-text);
    }
    span.cs-ctx-chip {
        padding: 0 4px 0 9px;
        cursor: default;
    }
    .cs-ctx-chip :global(.cs-svg) {
        width: 14px;
        height: 14px;
        flex: none;
    }
    .cs-ctx-main,
    .cs-ctx-x {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        min-width: 0;
        border: 0;
        padding: 0;
        background: none;
        color: inherit;
        font: inherit;
        cursor: pointer;
    }
    .cs-ctx-name {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        max-width: 180px;
    }
    .cs-ctx-x {
        width: 18px;
        height: 18px;
        justify-content: center;
        border-radius: 50%;
    }
    .cs-ctx-x:hover {
        background: var(--cs-hover);
    }
    .cs-ctx-x :global(.cs-svg) {
        width: 11px;
        height: 11px;
    }
    .cs-notice {
        font-size: 13px;
        padding: 6px 10px;
        border-radius: 6px;
        background: var(--cs-hover);
    }
    .cs-notice.error {
        background: var(--cs-error-soft);
        color: var(--cs-error);
    }
    .cs-typing {
        display: flex;
        gap: 4px;
        padding: 4px 0;
    }
    .cs-typing span {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: var(--cs-accent);
        animation: cs-blink 1.2s infinite ease-in-out;
    }
    .cs-typing span:nth-child(2) {
        animation-delay: 0.2s;
    }
    .cs-typing span:nth-child(3) {
        animation-delay: 0.4s;
    }
    @keyframes cs-blink {
        0%, 80%, 100% { opacity: 0.2; }
        40% { opacity: 1; }
    }
    .cs-composer {
        border-top: 1px solid var(--cs-line);
        padding: 10px 12px 8px;
    }
    .cs-composer textarea {
        width: 100%;
        resize: none;
        border: 1px solid var(--cs-line);
        border-radius: 8px;
        padding: 8px 10px;
        background: transparent;
        color: inherit;
        font: inherit;
        max-height: 220px;
        outline: none;
    }
    .cs-composer textarea:focus {
        border-color: var(--cs-accent-text);
    }
    .cs-composer-row {
        display: flex;
        align-items: center;
        gap: 6px;
        margin-top: 4px;
    }
    .cs-hint {
        flex: 1;
        font-size: 11px;
        color: var(--cs-muted);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }
    .cs-send {
        width: 34px;
        height: 34px;
        border: 0;
        border-radius: 50%;
        background: var(--cs-accent);
        color: #fff;
        font-size: 18px;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        justify-content: center;
    }
    .cs-send:disabled {
        opacity: 0.4;
        cursor: default;
    }
    .cs-send.stop {
        background: var(--cs-muted);
    }
    .cs-pending {
        display: flex;
        gap: 6px;
        flex-wrap: wrap;
        margin-bottom: 6px;
    }
    .cs-chip {
        position: relative;
    }
    .cs-chip img {
        width: 56px;
        height: 56px;
        object-fit: cover;
        border-radius: 6px;
    }
    .cs-chip button {
        position: absolute;
        top: -6px;
        right: -6px;
        width: 20px;
        height: 20px;
        border: 0;
        border-radius: 50%;
        background: rgba(0, 0, 0, 0.7);
        color: #fff;
        font-size: 12px;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        justify-content: center;
    }
    .claude-sidebar.dragging {
        outline: 2px dashed var(--cs-accent-text);
        outline-offset: -6px;
    }
    .cs-drop {
        position: absolute;
        inset: 52px 0 0 0;
        z-index: 2;
        display: flex;
        align-items: center;
        justify-content: center;
        background: rgba(217, 119, 87, 0.12);
        font-weight: 600;
        pointer-events: none;
    }
    .cs-option {
        border: 1px solid var(--cs-line);
        border-radius: 8px;
        margin-bottom: 10px;
        overflow: hidden;
    }
    .cs-option.selected {
        border-color: var(--cs-accent-text);
    }
    .cs-option-head {
        display: flex;
        gap: 10px;
        align-items: flex-start;
        width: 100%;
        padding: 10px 12px;
        border: 0;
        background: transparent;
        color: inherit;
        font: inherit;
        text-align: left;
        cursor: pointer;
    }
    .cs-option-head .cs-svg {
        width: 22px;
        height: 22px;
        margin-top: 1px;
    }
    .cs-option-head span {
        display: grid;
        gap: 2px;
    }
    .cs-option-head small {
        color: var(--cs-muted);
        font-size: 12px;
    }
    .cs-option-body {
        display: grid;
        gap: 10px;
        padding: 0 12px 12px;
    }
    .cs-option-body p,
    .cs-option-body ol {
        margin: 0;
    }
    .cs-secondary {
        padding: 8px;
        border: 1px solid var(--cs-line);
        border-radius: 6px;
        background: transparent;
        color: inherit;
        font: inherit;
        cursor: pointer;
    }
    .cs-seg {
        display: flex;
        border: 1px solid var(--cs-line);
        border-radius: 6px;
        overflow: hidden;
    }
    .cs-seg button {
        flex: 1;
        padding: 7px;
        border: 0;
        background: transparent;
        color: inherit;
        font: inherit;
        cursor: pointer;
    }
    .cs-seg button.on {
        background: var(--cs-accent);
        color: #fff;
    }
    .cs-history {
        max-height: 50%;
        overflow-y: auto;
        padding: 8px 12px;
        border-bottom: 1px solid var(--cs-line);
        display: grid;
        gap: 2px;
    }
    .cs-history-new {
        justify-self: start;
        padding: 6px 10px;
        margin-bottom: 4px;
        border: 1px solid var(--cs-line);
        border-radius: 6px;
        background: transparent;
        color: inherit;
        font: inherit;
        font-size: 13px;
        cursor: pointer;
    }
    .cs-history-item {
        display: flex;
        align-items: center;
        border-radius: 6px;
    }
    .cs-history-item:hover,
    .cs-history-item.current {
        background: var(--cs-hover);
    }
    .cs-history-open {
        flex: 1;
        min-width: 0;
        display: grid;
        padding: 6px 8px;
        border: 0;
        background: transparent;
        color: inherit;
        font: inherit;
        text-align: left;
        cursor: pointer;
    }
    .cs-history-title {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 13px;
    }
    .cs-history-open small {
        color: var(--cs-muted);
        font-size: 11px;
    }
    .icon-btn.small {
        width: 30px;
        height: 30px;
        font-size: 16px;
    }
</style>
