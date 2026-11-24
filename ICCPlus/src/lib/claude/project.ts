// Project access layer for the Claude assistant.
//
// Every edit Claude makes goes through the same path a user takes when they save
// a project to JSON and load it back: serialize `app`, change the plain JSON,
// run it through `removeNulls` + `AppSchema`, then `initializeApp`. That rebuilds
// every lookup map (rows, choices, groups, point types, ...) so the editor never
// ends up with stale indexes, no matter which fields were touched.

import {
    app,
    AppSchema,
    removeNulls,
    initializeApp,
    getSelectedObjectId,
    generateId,
    appVersion,
    loadActivated,
    cleanActivated,
    saveSlots,
    saveToSlot
} from '$lib/store/store.svelte';

export type Json = any;
type Seg = string | number;

// ---------------------------------------------------------------------------
// Snapshots & history
// ---------------------------------------------------------------------------

export function snapshotProject(): Json {
    app.activated = getSelectedObjectId().split(',').filter((s) => s !== '');
    return JSON.parse(JSON.stringify(app));
}

type HistoryEntry = { label: string; time: number; json: string };
const history: HistoryEntry[] = [];
const MAX_HISTORY_CHARS = 120_000_000;

export function historyEntries() {
    return history.map((h) => ({ label: h.label, time: h.time }));
}

function pushHistory(entry: HistoryEntry) {
    history.push(entry);
    let total = history.reduce((n, h) => n + h.json.length, 0);
    while (history.length > 1 && (history.length > 30 || total > MAX_HISTORY_CHARS)) {
        total -= history.shift()!.json.length;
    }
}

async function loadProjectJson(next: Json) {
    const cleaned = removeNulls(next);
    const parsed = AppSchema.safeParse(cleaned);
    if (!parsed.success) {
        const issues = parsed.error.issues.slice(0, 10).map((i) => `${i.path.join('/') || '(root)'}: ${i.message}`);
        throw new Error(`The edited project failed validation:\n${issues.join('\n')}`);
    }
    await initializeApp(parsed.data);
}

export type CommitResult = { warnings: string[] };

/** Validate, normalise and load `next` as the current project. Records an undo entry. */
export async function commitProject(next: Json, label: string): Promise<CommitResult> {
    const { errors, warnings } = normalizeProject(next);
    if (errors.length > 0) {
        throw new Error(`Edit rejected, nothing was changed:\n- ${errors.join('\n- ')}`);
    }
    const before = JSON.stringify(snapshotProject());
    await loadProjectJson(next);
    pushHistory({ label, time: Date.now(), json: before });
    return { warnings };
}

/** Restore the project as it was before the most recent Claude edit. */
export async function undoLastEdit(): Promise<string | null> {
    const entry = history.pop();
    if (!entry) return null;
    await loadProjectJson(JSON.parse(entry.json));
    return entry.label;
}

// ---------------------------------------------------------------------------
// Path handling
//
//   rows/0/objects/2/title          index path
//   rows/id=ab12/objects/id=cd34    select array items by any field
//   #cd34/scores/0/value            jump to any row/choice/addon/point/group/... by id
//   rows/-                          (insert only) append to array
// ---------------------------------------------------------------------------

type IdHit = { path: Seg[]; kind: string };

export function indexIds(project: Json): Map<string, IdHit[]> {
    const map = new Map<string, IdHit[]>();
    const add = (id: unknown, path: Seg[], kind: string) => {
        if (typeof id !== 'string' || id === '') return;
        const list = map.get(id) ?? [];
        list.push({ path, kind });
        map.set(id, list);
    };
    for (const listKey of ['rows', 'backpack'] as const) {
        const rows: Json[] = project[listKey] ?? [];
        rows.forEach((row, i) => {
            add(row.id, [listKey, i], listKey === 'rows' ? 'row' : 'backpack_row');
            (row.objects ?? []).forEach((choice: Json, j: number) => {
                add(choice.id, [listKey, i, 'objects', j], 'choice');
                (choice.addons ?? []).forEach((addon: Json, k: number) => {
                    add(addon.id, [listKey, i, 'objects', j, 'addons', k], 'addon');
                });
            });
        });
    }
    const simple: [string, string][] = [
        ['pointTypes', 'point_type'],
        ['groups', 'group'],
        ['variables', 'variable'],
        ['words', 'word'],
        ['globalRequirements', 'global_requirement'],
        ['rowDesignGroups', 'row_design_group'],
        ['objectDesignGroups', 'choice_design_group'],
        ['soundEffects', 'sound_effect']
    ];
    for (const [key, kind] of simple) {
        (project[key] ?? []).forEach((item: Json, i: number) => add(item.id, [key, i], kind));
    }
    return map;
}

function parseSegments(path: string): string[] {
    return path
        .trim()
        .replace(/^\/+|\/+$/g, '')
        .split('/')
        .filter((s) => s !== '');
}

/** Resolve a user-supplied path to concrete segments. `allowAppend` keeps a trailing `-`. */
export function resolvePath(project: Json, path: string, allowAppend = false): Seg[] {
    const raw = parseSegments(path);
    const out: Seg[] = [];
    let node: Json = project;
    for (let i = 0; i < raw.length; i++) {
        const seg = raw[i];
        if (i === 0 && seg.startsWith('#')) {
            const id = seg.slice(1);
            const hits = indexIds(project).get(id);
            if (!hits || hits.length === 0) throw new Error(`No row, choice, addon or feature item has id "${id}".`);
            if (hits.length > 1) {
                throw new Error(`Id "${id}" is ambiguous (${hits.map((h) => `${h.kind} at ${formatPath(h.path)}`).join(', ')}). Use an explicit path.`);
            }
            out.push(...hits[0].path);
            node = getAt(project, hits[0].path);
            continue;
        }
        if (Array.isArray(node)) {
            if (seg === '-' && allowAppend && i === raw.length - 1) {
                out.push(node.length);
                node = undefined;
                continue;
            }
            const eq = seg.indexOf('=');
            if (eq > 0) {
                const field = seg.slice(0, eq);
                const value = seg.slice(eq + 1);
                const idx = node.findIndex((item: Json) => item && String(item[field]) === value);
                if (idx === -1) throw new Error(`No item with ${field}=${value} at ${formatPath(out)}.`);
                out.push(idx);
                node = node[idx];
                continue;
            }
            if (!/^-?\d+$/.test(seg)) throw new Error(`"${seg}" is not a valid array index at ${formatPath(out) || '(root)'}.`);
            let idx = Number(seg);
            if (idx < 0) idx = node.length + idx;
            out.push(idx);
            node = node[idx];
            continue;
        }
        out.push(seg);
        node = node == null ? undefined : node[seg];
    }
    return out;
}

export function formatPath(path: Seg[]): string {
    return path.join('/');
}

export function getAt(root: Json, path: Seg[]): Json {
    let node = root;
    for (const seg of path) {
        if (node == null) return undefined;
        node = node[seg as any];
    }
    return node;
}

function parentOf(root: Json, path: Seg[], create: boolean): { parent: Json; key: Seg } {
    if (path.length === 0) throw new Error('The project root cannot be replaced or deleted. Target a field inside it.');
    let node = root;
    const checkIndex = (arr: Json[], seg: Seg, i: number, allowEnd: boolean) => {
        if (typeof seg !== 'number' || seg < 0 || seg > arr.length || (!allowEnd && seg === arr.length)) {
            throw new Error(`Index ${String(seg)} is out of range at ${formatPath(path.slice(0, i)) || '(root)'} (length ${arr.length}).`);
        }
    };
    for (let i = 0; i < path.length - 1; i++) {
        const seg = path[i];
        if (Array.isArray(node)) checkIndex(node, seg, i, false);
        let next = node[seg as any];
        if (next == null) {
            if (!create) throw new Error(`Path ${formatPath(path.slice(0, i + 1))} does not exist.`);
            next = typeof path[i + 1] === 'number' ? [] : {};
            node[seg as any] = next;
        }
        if (typeof next !== 'object') throw new Error(`Path ${formatPath(path.slice(0, i + 1))} is a ${typeof next}, not an object or array.`);
        node = next;
    }
    const key = path[path.length - 1];
    if (Array.isArray(node)) checkIndex(node, key, path.length - 1, create);
    return { parent: node, key };
}

// ---------------------------------------------------------------------------
// Edit operations
// ---------------------------------------------------------------------------

export type EditOp = {
    op: 'set' | 'merge' | 'delete' | 'insert' | 'move';
    path: string;
    value?: Json;
    index?: number;
    from?: string;
    spread?: boolean;
};

export function applyOps(project: Json, ops: EditOp[]): string[] {
    const log: string[] = [];
    ops.forEach((o, n) => {
        const where = `operation ${n + 1} (${o.op} ${o.path})`;
        try {
            switch (o.op) {
                case 'set': {
                    const p = resolvePath(project, o.path);
                    const { parent, key } = parentOf(project, p, true);
                    parent[key as any] = clone(o.value);
                    log.push(`set ${formatPath(p)}`);
                    break;
                }
                case 'merge': {
                    const p = resolvePath(project, o.path);
                    if (!o.value || typeof o.value !== 'object' || Array.isArray(o.value)) throw new Error('merge needs an object value');
                    const { parent, key } = parentOf(project, p, true);
                    const target = parent[key as any];
                    if (target != null && (typeof target !== 'object' || Array.isArray(target))) throw new Error('merge target is not an object');
                    parent[key as any] = { ...(target ?? {}), ...clone(o.value) };
                    log.push(`merged ${Object.keys(o.value).length} field(s) into ${formatPath(p)}`);
                    break;
                }
                case 'delete': {
                    const p = resolvePath(project, o.path);
                    const { parent, key } = parentOf(project, p, false);
                    if (Array.isArray(parent)) {
                        if (typeof key !== 'number' || key >= parent.length) throw new Error('index out of range');
                        parent.splice(key, 1);
                    } else {
                        delete parent[key as any];
                    }
                    log.push(`deleted ${formatPath(p)}`);
                    break;
                }
                case 'insert': {
                    const p = resolvePath(project, o.path, true);
                    let arrPath = p;
                    let index = o.index;
                    let arr = getAt(project, p);
                    if (!Array.isArray(arr)) {
                        // path pointed at an element (or `-`): insert before it
                        const last = p[p.length - 1];
                        if (typeof last !== 'number') throw new Error(`${formatPath(p)} is not an array`);
                        arrPath = p.slice(0, -1);
                        arr = getAt(project, arrPath);
                        index = last;
                    }
                    if (!Array.isArray(arr)) {
                        const { parent, key } = parentOf(project, arrPath, true);
                        if (parent[key as any] != null) throw new Error(`${formatPath(arrPath)} is not an array`);
                        parent[key as any] = arr = [];
                    }
                    const values = Array.isArray(o.value) && o.spread ? o.value : [o.value];
                    const at = index == null ? arr.length : Math.max(0, Math.min(index, arr.length));
                    arr.splice(at, 0, ...values.map(clone));
                    log.push(`inserted into ${formatPath(arrPath)} at ${at}`);
                    break;
                }
                case 'move': {
                    if (!o.from) throw new Error('move needs "from"');
                    const src = resolvePath(project, o.from);
                    const { parent: srcParent, key: srcKey } = parentOf(project, src, false);
                    if (!Array.isArray(srcParent) || typeof srcKey !== 'number') throw new Error('"from" must point at an array element');
                    const [item] = srcParent.splice(srcKey, 1);
                    const dest = resolvePath(project, o.path, true);
                    let arr = getAt(project, dest);
                    let at = o.index;
                    if (!Array.isArray(arr)) {
                        const last = dest[dest.length - 1];
                        if (typeof last !== 'number') {
                            srcParent.splice(srcKey, 0, item);
                            throw new Error(`${formatPath(dest)} is not an array`);
                        }
                        arr = getAt(project, dest.slice(0, -1));
                        at = last;
                    }
                    const pos = at == null ? arr.length : Math.max(0, Math.min(at, arr.length));
                    arr.splice(pos, 0, item);
                    log.push(`moved ${formatPath(src)} to position ${pos}`);
                    break;
                }
                default:
                    throw new Error(`unknown op "${(o as any).op}"`);
            }
        } catch (e) {
            throw new Error(`${where} failed: ${(e as Error).message}`);
        }
    });
    return log;
}

function clone<T>(v: T): T {
    return v === undefined ? v : JSON.parse(JSON.stringify(v));
}

// ---------------------------------------------------------------------------
// New item templates (mirror what the editor's own "create" buttons produce)
// ---------------------------------------------------------------------------

export const ITEM_KINDS = [
    'row', 'backpack_row', 'choice', 'addon', 'score', 'requirement', 'point_type', 'group', 'variable',
    'word', 'global_requirement', 'row_design_group', 'choice_design_group'
] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

const takenIds = new Set<string>();
function freshId(project: Json, len: number, type: string): string {
    const known = indexIds(project);
    for (let i = 0; i < 50; i++) {
        const id = generateId(0, len + (i > 20 ? 1 : 0), type);
        if (!known.has(id) && !takenIds.has(id)) {
            takenIds.add(id);
            return id;
        }
    }
    throw new Error('Could not generate a unique id');
}

function deepMerge(base: Json, over: Json): Json {
    if (!over || typeof over !== 'object' || Array.isArray(over)) return base;
    const out: Json = { ...base };
    for (const [k, v] of Object.entries(over)) {
        if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
            out[k] = deepMerge(base[k], v);
        } else {
            out[k] = clone(v);
        }
    }
    return out;
}

export function buildItem(project: Json, kind: ItemKind, overrides: Json = {}): Json {
    const a = project;
    const o = overrides ?? {};
    let item: Json;
    switch (kind) {
        case 'row':
        case 'backpack_row': {
            const isBp = kind === 'backpack_row';
            item = {
                index: 0,
                id: freshId(project, a.rowIdLength ?? 4, 'row'),
                ...(isBp ? { isBackpack: true } : {}),
                title: a.defaultRowTitle ?? '',
                titleText: a.defaultRowText ?? '',
                debugTitle: '',
                objectWidth: isBp ? 'col-md-3' : a.defaultRowWidth ?? 'col-md-3',
                image: '',
                template: isBp ? 1 : a.defaultRowTemplate ?? 1,
                isButtonRow: false,
                buttonType: true,
                buttonId: '',
                buttonText: 'Click',
                buttonRandom: false,
                buttonRandomNumber: 1,
                isResultRow: isBp,
                resultGroupId: '',
                isInfoRow: isBp,
                defaultAspectWidth: 1,
                defaultAspectHeight: 1,
                allowedChoices: isBp ? 0 : a.defaultRowAllowedChoices ?? 0,
                currentChoices: 0,
                rowJustify: a.defaultRowJustify ?? 'center',
                requireds: [],
                isEditModeOn: false,
                isRequirementOpen: false,
                objects: [],
                rowDesignGroups: []
            };
            const { objects, requireds, ...rest } = o;
            item = deepMerge(item, rest);
            if (Array.isArray(requireds)) item.requireds = requireds.map((r: Json) => buildItem(project, 'requirement', r));
            if (Array.isArray(objects)) item.objects = objects.map((c: Json) => buildItem(project, 'choice', c));
            break;
        }
        case 'choice': {
            item = {
                index: 0,
                id: freshId(project, a.objectIdLength ?? 4, 'choice'),
                title: a.defaultChoiceTitle ?? '',
                text: a.defaultChoiceText ?? '',
                debugTitle: '',
                image: '',
                template: a.defaultChoiceTemplate ?? 1,
                objectWidth: a.defaultChoiceWidth ?? '',
                isActive: false,
                multipleUseVariable: 0,
                initMultipleTimesMinus: 0,
                selectedThisManyTimesProp: 0,
                requireds: [],
                addons: [],
                scores: [],
                groups: [],
                objectDesignGroups: []
            };
            const { addons, scores, requireds, ...rest } = o;
            item = deepMerge(item, rest);
            if (Array.isArray(requireds)) item.requireds = requireds.map((r: Json) => buildItem(project, 'requirement', r));
            if (Array.isArray(scores)) item.scores = scores.map((s: Json) => buildItem(project, 'score', s));
            if (Array.isArray(addons)) {
                item.addons = addons.map((ad: Json) => buildItem(project, 'addon', ad));
                if (!item.addonJustify) item.addonJustify = a.defaultAddonJustify;
                if (!item.useSeperateAddon && a.defaultUseSeperateAddon) item.useSeperateAddon = a.defaultUseSeperateAddon;
            }
            break;
        }
        case 'addon': {
            item = {
                id: '',
                title: a.defaultAddonTitle ?? '',
                text: a.defaultAddonText ?? '',
                template: a.defaultAddonTemplate ?? 1,
                addonWidth: a.defaultAddonWidth ?? '',
                image: '',
                requireds: [],
                ...(a.defaultUseShowAddon ? { showAddon: true } : {}),
                ...(a.defaultUseHideAddon ? { hideAddon: true } : {})
            };
            const { scores, requireds, ...rest } = o;
            item = deepMerge(item, rest);
            if (Array.isArray(requireds)) item.requireds = requireds.map((r: Json) => buildItem(project, 'requirement', r));
            if (item.isSelectable) {
                if (!item.id) item.id = freshId(project, a.objectIdLength ?? 4, 'addon');
                item.scores = Array.isArray(scores) ? scores.map((s: Json) => buildItem(project, 'score', s)) : item.scores ?? [];
                item.groups = item.groups ?? [];
                item.multipleUseVariable = item.multipleUseVariable ?? 0;
                item.isActive = false;
            }
            break;
        }
        case 'score': {
            item = deepMerge(
                {
                    idx: freshId(project, 5, 's'),
                    id: '',
                    value: 0,
                    type: '',
                    requireds: [],
                    beforeText: a.defaultBeforePoint ?? '',
                    afterText: a.defaultAfterPoint ?? '',
                    showScore: a.defaultUseShowScore ?? true
                },
                { ...o, requireds: undefined }
            );
            item.requireds = Array.isArray(o.requireds) ? o.requireds.map((r: Json) => buildItem(project, 'requirement', r)) : [];
            break;
        }
        case 'requirement': {
            const type = o.type ?? 'id';
            item = deepMerge(
                {
                    required: true,
                    requireds: [],
                    orRequired: type === 'word' ? [{ req: '' }] : [],
                    orRequireds: [],
                    id: '',
                    type,
                    reqId: '',
                    reqId1: '',
                    reqId2: '',
                    reqId3: '',
                    reqPoints: 0,
                    showRequired: a.defaultUseShowReq ?? false,
                    operator: type === 'points' || type === 'pointCompare' ? '1' : '',
                    afterText: a.defaultAfterReq ?? '',
                    beforeText: a.defaultBeforeReq ?? '',
                    orNum: 1,
                    selNum: 1,
                    selFromOperators: '1',
                    more: []
                },
                { ...o, orRequireds: undefined, requireds: undefined }
            );
            item.orRequireds = Array.isArray(o.orRequireds) ? o.orRequireds.map((r: Json) => buildItem(project, 'requirement', r)) : [];
            item.requireds = Array.isArray(o.requireds) ? o.requireds.map((r: Json) => buildItem(project, 'requirement', r)) : [];
            break;
        }
        case 'point_type': {
            const n = (a.pointTypes?.length ?? 0) + 1;
            item = deepMerge(
                { id: freshId(project, 4, 'point'), name: `Point ${n}`, startingSum: 0, initValue: 0, activatedId: '', beforeText: `Point ${n}:`, afterText: '', category: -1 },
                o
            );
            if (o.startingSum != null && o.initValue == null) item.initValue = o.startingSum;
            if (o.initValue != null && o.startingSum == null) item.startingSum = o.initValue;
            break;
        }
        case 'group':
            item = deepMerge({ id: freshId(project, 4, 'group'), name: `Group ${(a.groups?.length ?? 0) + 1}`, category: -1, elements: [], rowElements: [] }, o);
            break;
        case 'variable':
            item = deepMerge({ id: freshId(project, 4, 'variable'), isTrue: false, category: -1 }, o);
            break;
        case 'word':
            item = deepMerge({ id: freshId(project, 4, 'word'), replaceText: '', category: -1 }, o);
            break;
        case 'global_requirement': {
            item = deepMerge({ id: freshId(project, 4, 'req'), name: `Requirement ${(a.globalRequirements?.length ?? 0) + 1}`, category: -1, requireds: [] }, { ...o, requireds: undefined });
            item.requireds = Array.isArray(o.requireds) ? o.requireds.map((r: Json) => buildItem(project, 'requirement', r)) : [];
            break;
        }
        case 'row_design_group':
        case 'choice_design_group': {
            const list = kind === 'row_design_group' ? a.rowDesignGroups : a.objectDesignGroups;
            item = deepMerge(
                { id: freshId(project, 4, 'design'), name: `Design Group ${(list?.length ?? 0) + 1}`, activatedId: '', category: -1, elements: [], backpackElements: [], groupElements: [], styling: {} },
                o
            );
            break;
        }
        default:
            throw new Error(`Unknown item kind "${kind}"`);
    }
    return item;
}

/** Default array an item kind lives in, relative to its parent (or the project root). */
export function defaultContainer(kind: ItemKind): { key: string; needsParent: boolean } {
    switch (kind) {
        case 'row': return { key: 'rows', needsParent: false };
        case 'backpack_row': return { key: 'backpack', needsParent: false };
        case 'choice': return { key: 'objects', needsParent: true };
        case 'addon': return { key: 'addons', needsParent: true };
        case 'score': return { key: 'scores', needsParent: true };
        case 'requirement': return { key: 'requireds', needsParent: true };
        case 'point_type': return { key: 'pointTypes', needsParent: false };
        case 'group': return { key: 'groups', needsParent: false };
        case 'variable': return { key: 'variables', needsParent: false };
        case 'word': return { key: 'words', needsParent: false };
        case 'global_requirement': return { key: 'globalRequirements', needsParent: false };
        case 'row_design_group': return { key: 'rowDesignGroups', needsParent: false };
        case 'choice_design_group': return { key: 'objectDesignGroups', needsParent: false };
    }
}

export function resetTakenIds() {
    takenIds.clear();
}

// ---------------------------------------------------------------------------
// Normalisation & integrity checks (run before every commit)
// ---------------------------------------------------------------------------

function ensureArray(obj: Json, key: string) {
    if (!Array.isArray(obj[key])) obj[key] = [];
}

export function normalizeProject(p: Json): { errors: string[]; warnings: string[] } {
    const errors: string[] = [];
    const warnings: string[] = [];
    for (const key of ['rows', 'backpack', 'pointTypes', 'groups', 'variables', 'words', 'objectDesignGroups', 'soundEffects']) ensureArray(p, key);

    const choiceIds = new Map<string, string>();
    const rowIds = new Map<string, string>();
    const scoreIdx = new Set<string>();
    const claim = (map: Map<string, string>, id: string, where: string, what: string) => {
        if (map.has(id)) errors.push(`Duplicate ${what} id "${id}" at ${where} (also used at ${map.get(id)}). Ids must be unique.`);
        else map.set(id, where);
    };

    const fixScores = (scores: Json[]) => {
        for (const s of scores) {
            if (!s || typeof s !== 'object') continue;
            if (typeof s.idx !== 'string' || s.idx === '' || scoreIdx.has(s.idx)) s.idx = freshId(p, 5, 's');
            scoreIdx.add(s.idx);
            ensureArray(s, 'requireds');
        }
    };

    for (const listKey of ['rows', 'backpack']) {
        p[listKey].forEach((row: Json, i: number) => {
            const where = `${listKey}/${i}`;
            if (!row || typeof row !== 'object') { errors.push(`${where} is not an object`); return; }
            if (typeof row.id !== 'string' || row.id === '') errors.push(`${where} has no id`);
            else claim(rowIds, row.id, where, 'row');
            row.index = i;
            if (listKey === 'backpack') row.isBackpack = true;
            for (const k of ['objects', 'requireds']) ensureArray(row, k);
            row.objects.forEach((c: Json, j: number) => {
                const cw = `${where}/objects/${j}`;
                if (!c || typeof c !== 'object') { errors.push(`${cw} is not an object`); return; }
                if (typeof c.id !== 'string' || c.id === '') errors.push(`${cw} has no id`);
                else claim(choiceIds, c.id, cw, 'choice/addon');
                c.index = j;
                for (const k of ['requireds', 'addons', 'scores', 'groups']) ensureArray(c, k);
                if (typeof c.isActive !== 'boolean') c.isActive = false;
                if (typeof c.multipleUseVariable !== 'number') c.multipleUseVariable = 0;
                if (typeof c.selectedThisManyTimesProp !== 'number') c.selectedThisManyTimesProp = 0;
                fixScores(c.scores);
                c.addons.forEach((ad: Json, k: number) => {
                    if (!ad || typeof ad !== 'object') return;
                    ad.parentId = c.id;
                    ensureArray(ad, 'requireds');
                    if (ad.isSelectable) {
                        if (typeof ad.id !== 'string' || ad.id === '') ad.id = freshId(p, p.objectIdLength ?? 4, 'addon');
                        claim(choiceIds, ad.id, `${cw}/addons/${k}`, 'choice/addon');
                        for (const key of ['scores', 'groups']) ensureArray(ad, key);
                        if (typeof ad.multipleUseVariable !== 'number') ad.multipleUseVariable = 0;
                        if (typeof ad.isActive !== 'boolean') ad.isActive = false;
                        fixScores(ad.scores);
                    }
                });
            });
        });
    }

    const uniqueIn = (key: string, what: string) => {
        const seen = new Map<string, string>();
        (p[key] ?? []).forEach((item: Json, i: number) => {
            if (!item || typeof item.id !== 'string' || item.id === '') errors.push(`${key}/${i} has no id`);
            else claim(seen, item.id, `${key}/${i}`, what);
        });
        return seen;
    };
    const pointIds = uniqueIn('pointTypes', 'point type');
    const groupIds = uniqueIn('groups', 'group');
    const varIds = uniqueIn('variables', 'variable');
    uniqueIn('words', 'word');
    const gReqIds = uniqueIn('globalRequirements', 'global requirement');
    const rdgIds = uniqueIn('rowDesignGroups', 'row design group');
    const odgIds = uniqueIn('objectDesignGroups', 'choice design group');

    if (errors.length > 0) return { errors, warnings };

    // Keep two-way membership links in sync (the editor stores both sides).
    const groupsById = new Map<string, Json>((p.groups ?? []).map((g: Json) => [g.id, g]));
    for (const g of p.groups ?? []) { ensureArray(g, 'elements'); ensureArray(g, 'rowElements'); }
    const rdgById = new Map<string, Json>((p.rowDesignGroups ?? []).map((g: Json) => [g.id, g]));
    const odgById = new Map<string, Json>((p.objectDesignGroups ?? []).map((g: Json) => [g.id, g]));
    for (const g of [...rdgById.values(), ...odgById.values()]) ensureArray(g, 'elements');

    const choiceObj = new Map<string, Json>();
    const rowObj = new Map<string, Json>();
    for (const listKey of ['rows', 'backpack']) {
        for (const row of p[listKey]) {
            if (!row || typeof row !== 'object') continue;
            rowObj.set(row.id, row);
            for (const c of row.objects ?? []) {
                if (!c || typeof c !== 'object') continue;
                choiceObj.set(c.id, c);
                for (const ad of c.addons ?? []) if (ad?.isSelectable) choiceObj.set(ad.id, ad);
            }
        }
    }
    const link = (list: string[], id: string) => { if (!list.includes(id)) list.push(id); };
    for (const [id, c] of choiceObj) {
        for (const gid of c.groups ?? []) {
            const g = groupsById.get(gid);
            if (g) link(g.elements, id);
            else warnings.push(`${id}.groups references unknown group "${gid}" (it will be dropped).`);
        }
        for (const did of c.objectDesignGroups ?? []) {
            const d = odgById.get(did);
            if (d) link(d.elements, id);
            else warnings.push(`${id}.objectDesignGroups references unknown design group "${did}" (it will be dropped).`);
        }
    }
    for (const [id, r] of rowObj) {
        for (const gid of r.groups ?? []) {
            const g = groupsById.get(gid);
            if (g) link(g.rowElements, id);
        }
        for (const did of r.rowDesignGroups ?? []) {
            const d = rdgById.get(did);
            if (d) link(d.elements, id);
        }
    }
    for (const g of groupsById.values()) {
        for (const cid of g.elements) { const c = choiceObj.get(cid); if (c) { c.groups = c.groups ?? []; link(c.groups, g.id); } }
        for (const rid of g.rowElements) { const r = rowObj.get(rid); if (r) { r.groups = r.groups ?? []; link(r.groups, g.id); } }
    }
    for (const d of odgById.values()) for (const cid of d.elements) { const c = choiceObj.get(cid); if (c) { c.objectDesignGroups = c.objectDesignGroups ?? []; link(c.objectDesignGroups, d.id); } }
    for (const d of rdgById.values()) for (const rid of d.elements) { const r = rowObj.get(rid); if (r) { r.rowDesignGroups = r.rowDesignGroups ?? []; link(r.rowDesignGroups, d.id); } }

    // Reference checks (warnings only - the creator allows dangling ids while editing).
    const checkReqs = (reqs: Json[], where: string) => {
        for (const r of reqs ?? []) {
            if (!r || typeof r !== 'object') continue;
            if (r.type === 'id' && r.reqId && !choiceIds.has(r.reqId) && !varIds.has(r.reqId) && !rowIds.has(r.reqId)) {
                warnings.push(`Requirement at ${where} needs "${r.reqId}", which is not a choice, addon or variable id.`);
            }
            if ((r.type === 'points' || r.type === 'pointCompare') && r.reqId && !pointIds.has(r.reqId)) {
                warnings.push(`Requirement at ${where} uses unknown point type "${r.reqId}".`);
            }
            if (r.type === 'gid' && r.reqId && !gReqIds.has(r.reqId)) warnings.push(`Requirement at ${where} uses unknown global requirement "${r.reqId}".`);
            checkReqs(r.requireds, where);
            checkReqs(r.orRequireds, where);
        }
    };
    p.rows.forEach((row: Json, i: number) => {
        checkReqs(row.requireds, `rows/${i}`);
        row.objects.forEach((c: Json, j: number) => {
            checkReqs(c.requireds, `rows/${i}/objects/${j}`);
            c.scores.forEach((s: Json, k: number) => {
                if (s.id && !pointIds.has(s.id)) warnings.push(`Score rows/${i}/objects/${j}/scores/${k} uses unknown point type "${s.id}".`);
                checkReqs(s.requireds, `rows/${i}/objects/${j}/scores/${k}`);
            });
        });
    });
    void groupIds; void rdgIds; void odgIds;
    return { errors, warnings: warnings.slice(0, 25) };
}

// ---------------------------------------------------------------------------
// Read helpers
// ---------------------------------------------------------------------------

/** JSON-safe copy with data URLs collapsed and optional depth limit. */
export function compactForModel(value: Json, depth = Infinity): Json {
    const walk = (v: Json, d: number): Json => {
        if (typeof v === 'string') {
            if (v.startsWith('data:') && v.length > 200) {
                const kind = v.slice(5, v.indexOf(';') > 0 ? v.indexOf(';') : 30);
                return `[embedded ${kind || 'data'}, ${Math.round(v.length / 1024)} KB]`;
            }
            return v.length > 4000 ? `${v.slice(0, 4000)}… [${v.length - 4000} more chars]` : v;
        }
        if (Array.isArray(v)) {
            if (d <= 0) return `[array of ${v.length}]`;
            return v.map((x) => walk(x, d - 1));
        }
        if (v && typeof v === 'object') {
            if (d <= 0) return `{object with ${Object.keys(v).length} keys}`;
            const out: Json = {};
            for (const [k, x] of Object.entries(v)) out[k] = walk(x, d - 1);
            return out;
        }
        return v;
    };
    return walk(value, depth);
}

const stripHtml = (s: unknown) => (typeof s === 'string' ? s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() : '');
const short = (s: unknown, n = 80) => {
    const t = stripHtml(s);
    return t.length > n ? `${t.slice(0, n)}…` : t;
};

export function projectSummary(p: Json): Json {
    const rowLine = (row: Json, i: number, key: string) => ({
        path: `${key}/${i}`,
        id: row.id,
        title: short(row.title, 60),
        choices: (row.objects ?? []).length,
        allowedChoices: row.allowedChoices,
        flags: [
            row.isInfoRow && 'info row',
            row.isResultRow && 'result row',
            row.isButtonRow && 'button row',
            row.isPrivateStyling && 'private styling',
            (row.requireds ?? []).length > 0 && `${row.requireds.length} requirement(s)`
        ].filter(Boolean)
    });
    return {
        title: p.viewerConfig?.title ?? '',
        version: p.version,
        counts: {
            rows: p.rows?.length ?? 0,
            choices: (p.rows ?? []).reduce((n: number, r: Json) => n + (r.objects?.length ?? 0), 0),
            backpackRows: p.backpack?.length ?? 0,
            pointTypes: p.pointTypes?.length ?? 0,
            groups: p.groups?.length ?? 0,
            variables: p.variables?.length ?? 0,
            words: p.words?.length ?? 0,
            globalRequirements: p.globalRequirements?.length ?? 0,
            rowDesignGroups: p.rowDesignGroups?.length ?? 0,
            choiceDesignGroups: p.objectDesignGroups?.length ?? 0,
            soundEffects: p.soundEffects?.length ?? 0,
            selectedChoices: (p.activated ?? []).filter((x: string) => x).length
        },
        rows: (p.rows ?? []).map((r: Json, i: number) => rowLine(r, i, 'rows')),
        backpack: (p.backpack ?? []).map((r: Json, i: number) => rowLine(r, i, 'backpack')),
        pointTypes: (p.pointTypes ?? []).map((pt: Json) => ({ id: pt.id, name: pt.name, start: pt.initValue, current: pt.startingSum, beforeText: pt.beforeText })),
        groups: (p.groups ?? []).map((g: Json) => ({ id: g.id, name: g.name, choices: g.elements?.length ?? 0, rows: g.rowElements?.length ?? 0 })),
        variables: (p.variables ?? []).map((v: Json) => v.id),
        words: (p.words ?? []).map((w: Json) => ({ id: w.id, text: short(w.replaceText, 40) })),
        globalRequirements: (p.globalRequirements ?? []).map((g: Json) => ({ id: g.id, name: g.name })),
        rowDesignGroups: (p.rowDesignGroups ?? []).map((g: Json) => ({ id: g.id, name: g.name, members: g.elements?.length ?? 0 })),
        choiceDesignGroups: (p.objectDesignGroups ?? []).map((g: Json) => ({ id: g.id, name: g.name, members: g.elements?.length ?? 0 })),
        soundEffects: (p.soundEffects ?? []).map((s: Json) => ({ id: s.id, name: s.name })),
        selectedChoiceIds: (p.activated ?? []).filter((x: string) => x)
    };
}

export function findInProject(p: Json, query: string, kinds?: string[], limit = 40) {
    const q = query.trim().toLowerCase();
    const results: Json[] = [];
    const ids = indexIds(p);
    for (const [id, hits] of ids) {
        for (const hit of hits) {
            if (kinds && kinds.length && !kinds.includes(hit.kind)) continue;
            const item = getAt(p, hit.path);
            const hay = [id, item?.title, item?.name, item?.text, item?.titleText, item?.replaceText, item?.debugTitle].map(stripHtml).join(' ').toLowerCase();
            if (q === '' || hay.includes(q)) {
                results.push({ kind: hit.kind, id, path: formatPath(hit.path), title: short(item?.title ?? item?.name ?? item?.replaceText ?? '', 60), text: short(item?.text ?? item?.titleText ?? '', 100) });
                if (results.length >= limit) return { results, truncated: true };
            }
        }
    }
    return { results, truncated: false };
}

// ---------------------------------------------------------------------------
// Playtest & saving
// ---------------------------------------------------------------------------

export async function setSelection(ids: string[]) {
    if (ids.length === 0) await cleanActivated();
    else await loadActivated(ids.join(','));
}

export async function saveToBrowserSlot(slot: number, name: string | undefined, overwrite: boolean) {
    const index = slot - 1;
    if (!Number.isInteger(index) || index < 0 || index >= saveSlots.length) throw new Error('slot must be between 1 and 99');
    if (saveSlots[index].stored && !overwrite) {
        throw new Error(`Slot ${slot} already holds "${saveSlots[index].name}" (saved ${saveSlots[index].time}). Ask the user before overwriting, then pass overwrite: true.`);
    }
    const tempApp = snapshotProject();
    tempApp.version = appVersion;
    const key = `${location.pathname.replace(/\/index\.html$/, '/')}slot-${index}`;
    const time = new Intl.DateTimeFormat(navigator.language, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date());
    await saveToSlot({ stored: true, name: name || saveSlots[index].name || `Slot-${slot}`, time, app: tempApp }, key, index, 'cyoaStore');
    if (!saveSlots[index].stored) throw new Error('The browser refused to store the save (storage may be full).');
    return { slot, name: saveSlots[index].name, time };
}

export function downloadProjectJson() {
    const tempApp = snapshotProject();
    tempApp.version = appVersion;
    const blob = new Blob([JSON.stringify(tempApp)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    a.href = url;
    a.download = `project_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return a.download;
}
