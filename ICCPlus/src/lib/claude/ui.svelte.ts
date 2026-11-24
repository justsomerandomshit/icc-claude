// Sidebar open/width state. Kept separate from the SDK code so the creator can show
// the toggle button without loading the Claude client until the sidebar is opened.

const KEY = 'iccplus.claude.ui';

function read(): { open?: boolean; width?: number } {
    try {
        return JSON.parse(localStorage.getItem(KEY) ?? '{}');
    } catch {
        return {};
    }
}

const saved = read();

export const claudeUi = $state({
    open: saved.open ?? false,
    width: Math.min(Math.max(saved.width ?? 420, 320), 900)
});

export function saveClaudeUi() {
    try {
        localStorage.setItem(KEY, JSON.stringify({ open: claudeUi.open, width: claudeUi.width }));
    } catch {
        // ignore - storage unavailable
    }
}

export function toggleClaude() {
    claudeUi.open = !claudeUi.open;
    saveClaudeUi();
}
