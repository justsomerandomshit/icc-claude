// Tools the Claude sidebar can call. Each tool has a zod schema (used both to
// build the JSON schema sent to the API and to validate the input Claude sends
// back) and an executor that runs against the live project.

import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { isMediaSupport, toggleTheme } from '$lib/store/store.svelte';
import {
    applyOps,
    buildItem,
    commitProject,
    compactForModel,
    defaultContainer,
    downloadProjectJson,
    findInProject,
    formatPath,
    getAt,
    indexIds,
    ITEM_KINDS,
    projectSummary,
    resetTakenIds,
    resolvePath,
    saveToBrowserSlot,
    setSelection,
    snapshotProject,
    undoLastEdit,
    type EditOp,
    type Json
} from './project';
import { readSource, searchSource, typeDefinition } from './knowledge';
import { forProject, loadImage, thumbnail, toModelImage, type ModelImage } from './images';

export type Attachment = { name: string; mediaType: string; dataUrl: string };
export type ToolContext = { attachments: Attachment[]; folder: string | null };
/** What a tool returns: text for the model, optional images for it to look at, thumbnails for the chat. */
export type ToolOutput = { text: string; images?: ModelImage[]; thumbs?: string[] };

const MAX_RESULT_CHARS = 60_000;

const pathDesc =
    'Project path. Forms: "rows/0/objects/2/title" (indexes), "rows/id=ab12/objects/id=cd34" (select array items by a field), or "#cd34/scores/0" (start at any row, choice, addon, point type, group, variable, word, global requirement, design group or sound effect by its id).';

const editOp = z.object({
    op: z.enum(['set', 'merge', 'delete', 'insert', 'move']).describe(
        'set: replace the value at path (creates missing parent objects). merge: shallow-merge an object into the object at path. delete: remove a field or array element. insert: insert value into the array at path (path may end in "-" to append, or point at an element to insert before it). move: move the array element at "from" into the array at path.'
    ),
    path: z.string().describe(pathDesc),
    value: z.any().optional().describe('New value for set/merge/insert. Any JSON.'),
    index: z.number().int().optional().describe('insert/move: position in the target array (default: end).'),
    from: z.string().optional().describe('move: path of the array element to move.'),
    spread: z.boolean().optional().describe('insert: when value is an array, insert each element instead of the array itself.')
});

const defs = {
    get_project_summary: {
        description:
            'Overview of the open project: counts, every row (path, id, title, choice count, flags), point types with start/current values, groups, variables, words, global requirements, design groups, sound effects and the currently selected choice ids. Call this first in a conversation and after large edits.',
        schema: z.object({})
    },
    read_project: {
        description:
            'Read the JSON at a project path. Embedded images and audio are shown as size placeholders. Use depth to skim large objects (e.g. depth 1 on "rows/3" lists its fields without expanding choices). Read the project root with path "" only with a small depth. Global settings live at the root (e.g. "defaultChoiceTitle", "autoSaveIsOn"), global design at "styling", viewer/export settings at "viewerConfig".',
        schema: z.object({
            path: z.string().describe(pathDesc),
            depth: z.number().int().min(0).max(20).optional().describe('How many levels to expand (default: everything).')
        })
    },
    find_items: {
        description: 'Search rows, choices, addons and feature items (point types, groups, variables, words, global requirements, design groups, sound effects) by id, title, name or text. Returns kind, id, path and a short title/text. An empty query lists everything of the given kinds.',
        schema: z.object({
            query: z.string(),
            kinds: z
                .array(z.enum(['row', 'backpack_row', 'choice', 'addon', 'point_type', 'group', 'variable', 'word', 'global_requirement', 'row_design_group', 'choice_design_group', 'sound_effect']))
                .optional(),
            limit: z.number().int().min(1).max(200).optional()
        })
    },
    search_editor_docs: {
        description:
            "Search the editor's own source and help text to learn what a setting does and which project field it writes. scope 'ui' searches the creator's dialogs and panels, where each control's on-screen label sits next to its binding (e.g. `bind:checked={choice.isSelectableMultiple}` beside \"Allow Multiple Selection\") and its onchange side effects. 'help' searches the Help/QnA and changelog. 'types' searches the TypeScript types. Use this whenever you are unsure of a field name, its allowed values, or what extra fields a toggle sets.",
        schema: z.object({
            query: z.string().describe('Words from the on-screen label or the field name, e.g. "discount", "allow multiple selection", "point bar color".'),
            scope: z.enum(['ui', 'help', 'types', 'all']).optional(),
            max_results: z.number().int().min(1).max(25).optional()
        })
    },
    get_type_definition: {
        description: 'Full TypeScript definition of a project data type from types.ts, e.g. Row, Choice, ChoiceFunc, Score, Requireds, PointType, Group, App, DefaultSettings, ViewerConfig, Styling, objectStyling, textStyling, filterStyling.',
        schema: z.object({ name: z.string() })
    },
    read_editor_source: {
        description: 'Read lines of an editor source file returned by search_editor_docs, e.g. to see everything an onchange handler sets when a user flips a switch.',
        schema: z.object({
            file: z.string().describe('File name as printed by search_editor_docs, e.g. "src/lib/creator/Object/ObjectAddon.svelte".'),
            line: z.number().int().min(1),
            count: z.number().int().min(1).max(150).optional()
        })
    },
    edit_project: {
        description:
            'Change the project with a list of operations applied in order to a copy, then validated and loaded into the editor in one step (all-or-nothing). This can change anything a user can change: text, titles, images (URLs), scores, requirements, choice functions, row settings, point types, groups, variables, words, global settings, design (styling), viewer config and so on. Ids must stay unique; row/choice indexes are renumbered automatically. Each call is one undo step for the user. Prefer add_items to create new rows/choices/addons/scores/requirements/feature items so they get correct defaults and fresh ids.',
        schema: z.object({
            description: z.string().describe('Short summary of the change, shown to the user in the undo history.'),
            operations: z.array(editOp).min(1)
        })
    },
    add_items: {
        description:
            "Create new items with the same defaults the editor's own create buttons use, then insert them. kind 'row' / 'backpack_row' / 'point_type' / 'group' / 'variable' / 'word' / 'global_requirement' / 'row_design_group' / 'choice_design_group' go into the matching top-level list. 'choice' needs parent = a row; 'addon' and 'score' need parent = a choice (or selectable addon for score); 'requirement' needs parent = a row, choice, addon, score, global requirement, or an 'or' requirement (with container 'orRequireds'). Each entry in items holds only the fields you want to differ from the defaults; nested objects (row.objects, choice.addons/scores/requireds) are filled with defaults too, so you can build a whole row of choices in one call. Fresh ids are generated unless you supply one. Returns the created ids and paths.",
        schema: z.object({
            kind: z.enum(ITEM_KINDS),
            items: z.array(z.record(z.string(), z.any())).min(1).max(200),
            parent: z.string().optional().describe('Path of the parent item (see read_project paths), required for choice/addon/score/requirement.'),
            container: z.string().optional().describe("Override the array field to insert into, e.g. 'orRequireds' inside an 'or' requirement."),
            index: z.number().int().optional().describe('Insert position (default: end).'),
            description: z.string().optional()
        })
    },
    set_membership: {
        description:
            'Add or remove rows/choices/selectable addons to or from a group, row design group or choice design group. Updates both sides of the link (the group list and the item list), which a raw edit_project would have to do by hand.',
        schema: z.object({
            container_id: z.string().describe('Id of the group or design group.'),
            item_ids: z.array(z.string()).min(1),
            member: z.boolean().describe('true to add, false to remove.')
        })
    },
    undo_last_edit: {
        description: 'Revert the most recent change made through edit_project, add_items, set_membership or use_attached_image. The user can also do this from the sidebar.',
        schema: z.object({})
    },
    set_selected_choices: {
        description:
            'Playtest: replace which choices are currently selected in the editor preview, using the same mechanism as importing a build. Pass choice/addon ids (multi-select choices take "id/ON#count"); an empty list clears all selections. Point totals, requirements and functions update as if the player had chosen them. Read get_project_summary afterwards to see point totals.',
        schema: z.object({ ids: z.array(z.string()) })
    },
    save_project: {
        description:
            "Save the project. target 'browser_slot' stores it in one of the 99 browser save slots shown in Save/Load Project; it refuses to overwrite a used slot unless overwrite is true (only after the user agreed). target 'download' downloads the project .json file to the user's computer.",
        schema: z.object({
            target: z.enum(['browser_slot', 'download']),
            slot: z.number().int().min(1).max(99).optional(),
            name: z.string().optional(),
            overwrite: z.boolean().optional()
        })
    },
    set_editor_theme: {
        description: "Switch the editor's own light/dark theme (an editor preference, not part of the project design).",
        schema: z.object({ theme: z.enum(['light', 'dark']) })
    },
    find_images_on_page: {
        description:
            'List the images on a web page: their direct URLs, alt text and size hints, from <img> tags, srcset, page preview images and links to image files. Use it after a web search to get real image links from a page (a wiki, gallery, artist page, etc.), then look at candidates with view_images and put the right one in the project with place_image. Needs ICC Plus started from the local launcher.',
        schema: z.object({
            url: z.string().describe('Page URL (http/https).'),
            limit: z.number().int().min(1).max(200).optional().describe('Max images to return (default 60).')
        })
    },
    view_images: {
        description:
            'Look at up to 6 images before using them: web image URLs, or image files in the reference folder (absolute path or relative to it). Returns each image so you can check it shows the right thing, plus its size. Use this to pick between candidates; do not place images you have not checked.',
        schema: z.object({
            sources: z.array(z.string()).min(1).max(6).describe('Image URLs or reference-folder file paths.')
        })
    },
    place_image: {
        description:
            'Put an image from the web or the reference folder into the project at an image field, e.g. "#choiceId/image", "rows/2/image", "#addonId/image", "styling/backgroundImage". mode "embed" (default) downloads the image and stores it in the project, scaled down to max_size and compressed like the editor does, so it keeps working offline and if the link dies. mode "link" stores the URL itself (web images only; the project stays small but depends on the site). Optional source_tooltip sets the hover text shown on the image (e.g. artist credit) when the field is an "image" field. One undo step per call.',
        schema: z.object({
            source: z.string().describe('Image URL, or a file path in the reference folder.'),
            path: z.string().describe(pathDesc),
            mode: z.enum(['embed', 'link']).optional(),
            max_size: z.number().int().min(64).max(4096).optional().describe('embed: longest side in px (default 1600).'),
            source_tooltip: z.string().optional()
        })
    },
    use_attached_image: {
        description:
            'Put an image the user attached in this chat into the project, e.g. as a choice image (path "#choiceId/image"), row image, or a styling background (e.g. "styling/backgroundImage"). attachment is the 1-based number shown in the chat ("[Attachment 1: name]").',
        schema: z.object({
            attachment: z.number().int().min(1),
            path: z.string().describe(pathDesc)
        })
    }
} as const;

export type ToolName = keyof typeof defs;

function toInputSchema(schema: z.ZodType): Anthropic.Beta.BetaTool.InputSchema {
    const json = z.toJSONSchema(schema) as Record<string, unknown>;
    delete json.$schema;
    return json as Anthropic.Beta.BetaTool.InputSchema;
}

export const toolDefinitions: Anthropic.Beta.BetaTool[] = (Object.keys(defs) as ToolName[]).map((name) => ({
    name,
    description: defs[name].description,
    input_schema: toInputSchema(defs[name].schema),
    eager_input_streaming: true
}));

/** Human-readable one-liner for the chat UI. */
export function describeToolCall(name: string, input: Json): string {
    const i = input ?? {};
    switch (name) {
        case 'get_project_summary': return 'Reading project overview';
        case 'read_project': return `Reading ${i.path || 'project root'}`;
        case 'find_items': return `Searching project for "${i.query ?? ''}"`;
        case 'search_editor_docs': return `Looking up "${i.query ?? ''}" in the editor`;
        case 'get_type_definition': return `Reading type ${i.name ?? ''}`;
        case 'read_editor_source': return `Reading ${String(i.file ?? '').split('/').pop()}:${i.line ?? ''}`;
        case 'edit_project': return i.description ? `Editing: ${i.description}` : 'Editing project';
        case 'add_items': return `Adding ${Array.isArray(i.items) ? `${i.items.length} ` : ''}${String(i.kind ?? 'item').replace(/_/g, ' ')}(s)`;
        case 'set_membership': return `${i.member ? 'Adding to' : 'Removing from'} ${i.container_id ?? 'group'}`;
        case 'undo_last_edit': return 'Undoing last edit';
        case 'set_selected_choices': return Array.isArray(i.ids) && i.ids.length ? `Selecting ${i.ids.length} choice(s)` : 'Clearing selections';
        case 'save_project': return i.target === 'download' ? 'Downloading project file' : `Saving to slot ${i.slot ?? ''}`;
        case 'set_editor_theme': return `Switching to ${i.theme ?? ''} theme`;
        case 'use_attached_image': return `Placing attachment ${i.attachment ?? ''}`;
        case 'find_images_on_page': return `Finding images on ${hostOf(i.url)}`;
        case 'view_images': return `Looking at ${Array.isArray(i.sources) ? i.sources.length : ''} image(s)`;
        case 'place_image': return `Placing image from ${/^https?:/i.test(String(i.source ?? '')) ? hostOf(i.source) : fileOf(i.source)}`;
        // Claude Code's own tools
        case 'Read': return `Reading ${fileOf(i.file_path)}${i.pages ? ` (pages ${i.pages})` : ''}`;
        case 'Glob': return `Listing files${i.pattern ? ` matching ${i.pattern}` : ''}`;
        case 'Grep': return `Searching files for "${i.pattern ?? ''}"`;
        case 'WebSearch': case 'web_search': return `Searching the web for "${i.query ?? ''}"`;
        case 'WebFetch': case 'web_fetch': return `Reading ${hostOf(i.url)}`;
        case 'Bash': return `Running: ${String(i.description || i.command || 'a command').slice(0, 120)}`;
        default: {
            // Tools from the user's own MCP servers: "mcp__ddgs__search_images" -> "ddgs: search images "query""
            const m = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(name);
            if (!m) return name;
            const what = i.query ?? i.keywords ?? i.q ?? i.url;
            return `${m[1]}: ${m[2].replace(/_/g, ' ')}${what ? ` "${String(what).slice(0, 80)}"` : ''}`;
        }
    }
}

export const MUTATING_TOOLS = new Set<string>(['edit_project', 'add_items', 'set_membership', 'undo_last_edit', 'use_attached_image', 'set_selected_choices', 'place_image']);

function hostOf(u: unknown): string {
    try {
        return new URL(String(u)).hostname.replace(/^www\./, '');
    } catch {
        return 'a web page';
    }
}

function fileOf(p: unknown): string {
    return String(p ?? '').split('/').filter(Boolean).pop() ?? 'file';
}

function kb(n: number) {
    return n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`;
}

function out(value: unknown): string {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    if (text.length <= MAX_RESULT_CHARS) return text;
    return `${text.slice(0, MAX_RESULT_CHARS)}\n…[truncated ${text.length - MAX_RESULT_CHARS} chars. Read a narrower path or use a smaller depth.]`;
}

export class ToolInputError extends Error {}

// The editor's toggle flips relative to the system colour scheme, so work out what is showing now.
function effectiveDark(): boolean {
    let stored = false;
    try {
        stored = localStorage.getItem('theme') === 'dark';
    } catch {
        // ignore
    }
    if (!isMediaSupport()) return stored;
    const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    return stored !== systemDark;
}

export async function runTool(name: string, rawInput: unknown, ctx: ToolContext): Promise<ToolOutput> {
    const r = await runToolInner(name, rawInput, ctx);
    return typeof r === 'string' ? { text: r } : r;
}

async function runToolInner(name: string, rawInput: unknown, ctx: ToolContext): Promise<string | ToolOutput> {
    const def = (defs as Record<string, { schema: z.ZodType }>)[name];
    if (!def) throw new ToolInputError(`Unknown tool "${name}".`);
    const parsed = def.schema.safeParse(rawInput ?? {});
    if (!parsed.success) {
        throw new ToolInputError(`Invalid input: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(input)'} ${i.message}`).join('; ')}`);
    }
    const input = parsed.data as Json;
    resetTakenIds();

    switch (name as ToolName) {
        case 'get_project_summary':
            return out(projectSummary(snapshotProject()));

        case 'read_project': {
            const p = snapshotProject();
            const path = resolvePath(p, input.path ?? '');
            const value = getAt(p, path);
            if (value === undefined) return out({ path: formatPath(path), value: null, note: 'Nothing stored at this path (the editor treats missing fields as their default).' });
            const depth = input.depth ?? (path.length === 0 ? 1 : Infinity);
            return out({ path: formatPath(path), value: compactForModel(value, depth) });
        }

        case 'find_items':
            return out(findInProject(snapshotProject(), input.query, input.kinds, input.limit ?? 40));

        case 'search_editor_docs':
            return out(await searchSource(input.query, input.scope ?? 'ui', input.max_results ?? 10));

        case 'get_type_definition':
            return out(await typeDefinition(input.name));

        case 'read_editor_source':
            return out(await readSource(input.file, input.line, input.count ?? 40));

        case 'edit_project': {
            const p = snapshotProject();
            const log = applyOps(p, input.operations as EditOp[]);
            const { warnings } = await commitProject(p, input.description);
            return out({ ok: true, applied: log, warnings });
        }

        case 'add_items': {
            const p = snapshotProject();
            const kind = input.kind as (typeof ITEM_KINDS)[number];
            const { key, needsParent } = defaultContainer(kind);
            let arrPath: (string | number)[];
            if (needsParent || input.parent) {
                if (!input.parent) throw new ToolInputError(`kind "${kind}" needs a parent path.`);
                arrPath = [...resolvePath(p, input.parent), input.container ?? key];
            } else {
                arrPath = [input.container ?? key];
            }
            const items = (input.items as Json[]).map((o) => buildItem(p, kind, o));
            const ops: EditOp[] = [{ op: 'insert', path: formatPath(arrPath), value: items, spread: true, ...(input.index != null ? { index: input.index } : {}) }];
            applyOps(p, ops);
            const arr = getAt(p, arrPath) as Json[];
            const created = items.map((it) => {
                const pos = arr.indexOf(arr.find((x) => (it.id ? x.id === it.id : it.idx ? x.idx === it.idx : x === it)) ?? it);
                return { id: it.id || it.idx || undefined, path: formatPath([...arrPath, pos]), title: it.title ?? it.name ?? undefined };
            });
            const { warnings } = await commitProject(p, input.description ?? `Add ${items.length} ${kind.replace(/_/g, ' ')}(s)`);
            const ids = indexIds(snapshotProject());
            // paths may shift after normalisation; report the live ones where we can
            for (const c of created) {
                const hit = c.id ? ids.get(c.id)?.[0] : undefined;
                if (hit) c.path = formatPath(hit.path);
            }
            return out({ ok: true, created, warnings });
        }

        case 'set_membership': {
            const p = snapshotProject();
            const containers: [string, string][] = [['groups', 'group'], ['rowDesignGroups', 'row_design_group'], ['objectDesignGroups', 'choice_design_group']];
            let found: { list: string; item: Json } | null = null;
            for (const [list] of containers) {
                const item = (p[list] ?? []).find((g: Json) => g.id === input.container_id);
                if (item) { found = { list, item }; break; }
            }
            if (!found) throw new ToolInputError(`No group or design group has id "${input.container_id}".`);
            const ids = indexIds(p);
            const changed: string[] = [];
            for (const id of input.item_ids as string[]) {
                const hit = ids.get(id)?.find((h) => ['row', 'backpack_row', 'choice', 'addon'].includes(h.kind));
                if (!hit) throw new ToolInputError(`"${id}" is not a row, choice or addon id.`);
                const target = getAt(p, hit.path);
                const isRow = hit.kind === 'row' || hit.kind === 'backpack_row';
                let groupList: string;
                let itemList: string;
                if (found.list === 'groups') {
                    groupList = isRow ? 'rowElements' : 'elements';
                    itemList = 'groups';
                } else if (found.list === 'rowDesignGroups') {
                    if (!isRow) throw new ToolInputError(`Row design groups only hold rows; "${id}" is a ${hit.kind}.`);
                    groupList = 'elements';
                    itemList = 'rowDesignGroups';
                } else {
                    if (isRow) throw new ToolInputError(`Choice design groups only hold choices; "${id}" is a row.`);
                    groupList = 'elements';
                    itemList = 'objectDesignGroups';
                }
                const g: string[] = (found.item[groupList] = found.item[groupList] ?? []);
                const t: string[] = (target[itemList] = target[itemList] ?? []);
                if (input.member) {
                    if (!g.includes(id)) g.push(id);
                    if (!t.includes(found.item.id)) t.push(found.item.id);
                } else {
                    found.item[groupList] = g.filter((x) => x !== id);
                    target[itemList] = t.filter((x) => x !== found!.item.id);
                }
                changed.push(id);
            }
            const { warnings } = await commitProject(p, `${input.member ? 'Add' : 'Remove'} ${changed.length} item(s) ${input.member ? 'to' : 'from'} ${found.item.name ?? found.item.id}`);
            return out({ ok: true, changed, warnings });
        }

        case 'undo_last_edit': {
            const label = await undoLastEdit();
            return out(label ? { ok: true, reverted: label } : { ok: false, note: 'Nothing to undo.' });
        }

        case 'set_selected_choices': {
            await setSelection(input.ids);
            const s = projectSummary(snapshotProject());
            return out({ ok: true, selected: s.selectedChoiceIds, points: s.pointTypes });
        }

        case 'save_project': {
            if (input.target === 'download') return out({ ok: true, downloaded: downloadProjectJson() });
            if (!input.slot) throw new ToolInputError('slot is required for browser_slot.');
            return out({ ok: true, ...(await saveToBrowserSlot(input.slot, input.name, input.overwrite ?? false)) });
        }

        case 'set_editor_theme': {
            const want = input.theme === 'dark';
            if (effectiveDark() !== want) toggleTheme();
            return out({ ok: true, theme: effectiveDark() ? 'dark' : 'light' });
        }

        case 'use_attached_image': {
            const att = ctx.attachments[input.attachment - 1];
            if (!att) throw new ToolInputError(`There is no attachment ${input.attachment}. ${ctx.attachments.length} image(s) are attached in this chat.`);
            const p = snapshotProject();
            applyOps(p, [{ op: 'set', path: input.path, value: att.dataUrl }]);
            const { warnings } = await commitProject(p, `Use image "${att.name}"`);
            return out({ ok: true, set: input.path, warnings });
        }

        case 'find_images_on_page': {
            let res: Response;
            try {
                res = await fetch(`./__claude-code/page-images?url=${encodeURIComponent(input.url)}&limit=${input.limit ?? 60}`, { cache: 'no-store' });
            } catch {
                res = new Response(null, { status: 404 });
            }
            if (!(res.headers.get('content-type') ?? '').includes('application/json')) {
                throw new Error('Listing images on a page needs ICC Plus started from the "Launch ICC Plus" shortcut. Use image URLs from search results instead.');
            }
            const body = await res.json();
            if (body.error) throw new Error(body.error);
            return out(body);
        }

        case 'view_images': {
            const lines: string[] = [];
            const images: ModelImage[] = [];
            const thumbs: string[] = [];
            for (const [n, source] of (input.sources as string[]).entries()) {
                try {
                    const img = await loadImage(source, ctx.folder);
                    images.push(await toModelImage(img.dataUrl, 768));
                    thumbs.push(await thumbnail(img.dataUrl));
                    lines.push(`Image ${images.length}: ${source} (${img.width}x${img.height}, ${img.mime}, ${kb(img.bytes)})`);
                } catch (e) {
                    lines.push(`Source ${n + 1}: ${source} could not be loaded: ${(e as Error).message}`);
                }
            }
            if (images.length === 0) throw new Error(lines.join('\n'));
            return { text: `${lines.join('\n')}\nThe images follow in the same order (scaled down for viewing).`, images, thumbs };
        }

        case 'place_image': {
            const mode = input.mode ?? 'embed';
            const isWeb = /^https?:\/\//i.test(input.source);
            const p = snapshotProject();
            const target = resolvePath(p, input.path);
            let value: string;
            let info: Record<string, unknown>;
            let thumb: string | undefined;
            if (mode === 'link') {
                if (!isWeb) throw new ToolInputError('mode "link" needs a web URL; files from the reference folder must be embedded.');
                const img = await loadImage(input.source, ctx.folder).catch(() => null);
                value = input.source;
                info = img ? { stored: 'link', width: img.width, height: img.height } : { stored: 'link', note: 'Could not load the image to check it; make sure the link works.' };
                if (img) thumb = await thumbnail(img.dataUrl).catch(() => undefined);
            } else {
                const img = await loadImage(input.source, ctx.folder);
                const ready = await forProject(img, input.max_size ?? 1600);
                value = ready.dataUrl;
                info = { stored: 'embedded', width: ready.width, height: ready.height, size: kb(Math.round((ready.dataUrl.length * 3) / 4)), converted: ready.converted };
                thumb = await thumbnail(ready.dataUrl).catch(() => undefined);
            }
            const ops: EditOp[] = [{ op: 'set', path: input.path, value }];
            const field = target[target.length - 1];
            if (field === 'image') {
                const parent = target.slice(0, -1);
                if (input.source_tooltip !== undefined) ops.push({ op: 'set', path: formatPath([...parent, 'imageSourceTooltip']), value: input.source_tooltip });
                // The editor's Image dialog keeps the external URL it was given in imageLink.
                if (mode === 'link') ops.push({ op: 'set', path: formatPath([...parent, 'imageLink']), value: input.source });
            }
            applyOps(p, ops);
            const label = isWeb ? hostOf(input.source) : fileOf(input.source);
            const { warnings } = await commitProject(p, `Image from ${label} at ${formatPath(target)}`);
            return { text: out({ ok: true, set: formatPath(target), ...info, warnings }), thumbs: thumb ? [thumb] : undefined };
        }
    }
    throw new ToolInputError(`Unhandled tool ${name}`);
}
