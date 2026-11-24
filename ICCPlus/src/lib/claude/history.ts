// Saved Claude chats, kept in this browser's IndexedDB (images make them too big for localStorage).
// A small "meta" store backs the history list so listing never loads every chat's images.

const DB_NAME = 'iccplus-claude';
const META = 'meta';
const CHATS = 'chats';

export type Backend = 'api' | 'claude-code';
export type ChatMeta = { id: string; title: string; backend: Backend; createdAt: number; updatedAt: number };
export type ChatRecord = ChatMeta & {
    messages: unknown[];
    apiMessages: unknown[];
    sessionId: string | null;
    sessionStarted: boolean;
    attachments: unknown[];
    usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
    pendingNotes: string[];
};

let dbPromise: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
    if (!dbPromise) {
        dbPromise = new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, 1);
            req.onupgradeneeded = () => {
                req.result.createObjectStore(META, { keyPath: 'id' });
                req.result.createObjectStore(CHATS, { keyPath: 'id' });
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => {
                dbPromise = null;
                reject(req.error);
            };
        });
    }
    return dbPromise;
}

function run<T>(stores: string[], mode: IDBTransactionMode, fn: (t: IDBTransaction) => IDBRequest<T> | void): Promise<T | undefined> {
    return db().then(
        (d) =>
            new Promise<T | undefined>((resolve, reject) => {
                const t = d.transaction(stores, mode);
                const req = fn(t);
                t.oncomplete = () => resolve(req ? req.result : undefined);
                t.onerror = () => reject(t.error);
                t.onabort = () => reject(t.error);
            })
    );
}

export async function saveChatRecord(record: ChatRecord): Promise<void> {
    const { id, title, backend, createdAt, updatedAt } = record;
    await run([META, CHATS], 'readwrite', (t) => {
        t.objectStore(META).put({ id, title, backend, createdAt, updatedAt });
        t.objectStore(CHATS).put(record);
    });
}

export async function loadChatRecord(id: string): Promise<ChatRecord | null> {
    return ((await run([CHATS], 'readonly', (t) => t.objectStore(CHATS).get(id))) as ChatRecord | undefined) ?? null;
}

export async function deleteChatRecord(id: string): Promise<void> {
    await run([META, CHATS], 'readwrite', (t) => {
        t.objectStore(META).delete(id);
        t.objectStore(CHATS).delete(id);
    });
}

export async function listChats(): Promise<ChatMeta[]> {
    const all = ((await run([META], 'readonly', (t) => t.objectStore(META).getAll())) ?? []) as ChatMeta[];
    return all.sort((a, b) => b.updatedAt - a.updatedAt);
}
