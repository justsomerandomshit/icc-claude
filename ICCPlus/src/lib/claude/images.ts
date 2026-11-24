// Image helpers for the Claude sidebar: loading images from the web or the reference folder
// (through the local bridge), resizing them for the model, and preparing them for the project.

export type ModelImage = { mediaType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif'; data: string };

export function readFileAsDataUrl(file: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result as string);
        r.onerror = () => reject(r.error);
        r.readAsDataURL(file);
    });
}

async function decode(dataUrl: string): Promise<HTMLImageElement> {
    const img = new Image();
    img.src = dataUrl;
    try {
        await img.decode();
    } catch {
        throw new Error('the browser cannot open this image format');
    }
    return img;
}

function mimeOf(dataUrl: string): string {
    return /^data:(image\/[a-z0-9.+-]+)/i.exec(dataUrl)?.[1]?.toLowerCase() ?? '';
}

const ALPHA = new Set(['image/png', 'image/svg+xml', 'image/webp', 'image/gif', 'image/avif']);

function draw(img: HTMLImageElement, maxSide: number, keepAlpha: boolean): HTMLCanvasElement {
    const w = img.naturalWidth || 1024;
    const h = img.naturalHeight || 1024;
    const scale = Math.min(1, maxSide / Math.max(w, h));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    const ctx = canvas.getContext('2d')!;
    if (!keepAlpha) {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas;
}

/**
 * Prepare an image for the model: formats the API accepts pass through when small enough,
 * anything else the browser can display (SVG, BMP, AVIF, ...) is converted, and large images
 * are scaled down to `maxSide`.
 */
export async function toModelImage(dataUrl: string, maxSide = 1568): Promise<ModelImage> {
    const img = await decode(dataUrl);
    const w = img.naturalWidth || 1024;
    const h = img.naturalHeight || 1024;
    const mime = mimeOf(dataUrl);
    const accepted = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (Math.max(w, h) <= maxSide && accepted.includes(mime) && dataUrl.length < 4_500_000) {
        return { mediaType: mime as ModelImage['mediaType'], data: dataUrl.slice(dataUrl.indexOf(',') + 1) };
    }
    const keepAlpha = ALPHA.has(mime);
    const canvas = draw(img, maxSide, keepAlpha);
    let out = canvas.toDataURL(keepAlpha ? 'image/png' : 'image/jpeg', 0.85);
    let mediaType: ModelImage['mediaType'] = keepAlpha ? 'image/png' : 'image/jpeg';
    if (out.length > 4_500_000) {
        out = canvas.toDataURL('image/jpeg', 0.8);
        mediaType = 'image/jpeg';
    }
    return { mediaType, data: out.slice(out.indexOf(',') + 1) };
}

export type LoadedImage = { dataUrl: string; mime: string; bytes: number; width: number; height: number; origin: string };

async function bridgeBlob(url: string): Promise<Blob> {
    let res: Response;
    try {
        res = await fetch(url, { cache: 'no-store' });
    } catch {
        throw new Error('NO_BRIDGE');
    }
    const type = res.headers.get('content-type') ?? '';
    if (type.includes('application/json')) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `Request failed (${res.status}).`);
    }
    if (!res.ok || !type.startsWith('image/')) throw new Error('NO_BRIDGE');
    return res.blob();
}

/**
 * Load an image from a web URL, a file in the reference folder, or a data URL.
 * Web images go through the local bridge (sites rarely allow direct browser downloads);
 * without the bridge, a direct download is tried.
 */
export async function loadImage(source: string, folder: string | null): Promise<LoadedImage> {
    const src = source.trim();
    let blob: Blob;
    let origin = src;
    if (src.startsWith('data:image/')) {
        blob = await (await fetch(src)).blob();
        origin = 'data URL';
    } else if (/^https?:\/\//i.test(src)) {
        try {
            blob = await bridgeBlob(`./__claude-code/web-image?url=${encodeURIComponent(src)}`);
        } catch (e) {
            if ((e as Error).message !== 'NO_BRIDGE') throw e;
            try {
                const res = await fetch(src, { mode: 'cors' });
                if (!res.ok) throw new Error(`The site answered ${res.status}.`);
                blob = await res.blob();
            } catch {
                throw new Error(
                    'This site does not allow downloads from the browser. Start ICC Plus with the "Launch ICC Plus" shortcut to download it, or use mode "link" to use the image by its URL.'
                );
            }
        }
    } else {
        if (!folder) throw new Error(`"${src}" is not a web link, and no reference folder is open. Ask the user to choose one in the sidebar.`);
        try {
            blob = await bridgeBlob(`./__claude-code/local-image?folder=${encodeURIComponent(folder)}&path=${encodeURIComponent(src.replace(/^file:\/\//, ''))}`);
        } catch (e) {
            if ((e as Error).message === 'NO_BRIDGE') throw new Error('Reading files needs ICC Plus started from the "Launch ICC Plus" shortcut.');
            throw e;
        }
    }
    if (blob.type && !blob.type.startsWith('image/')) throw new Error(`That is not an image (${blob.type}).`);
    const dataUrl = await readFileAsDataUrl(blob);
    const img = await decode(dataUrl);
    return { dataUrl, mime: blob.type || mimeOf(dataUrl), bytes: blob.size, width: img.naturalWidth, height: img.naturalHeight, origin };
}

/**
 * Make an image suitable for storing in the project: keep small images as they are (and keep
 * animated GIFs and SVGs), otherwise scale to `maxSide` and re-encode as WebP like the
 * editor's own compressor.
 */
export async function forProject(image: LoadedImage, maxSide: number): Promise<{ dataUrl: string; width: number; height: number; converted: boolean }> {
    const keep =
        image.mime === 'image/svg+xml' ||
        image.mime === 'image/gif' ||
        (Math.max(image.width, image.height) <= maxSide && image.bytes <= 600 * 1024 && image.mime !== 'image/bmp');
    if (keep) return { dataUrl: image.dataUrl, width: image.width, height: image.height, converted: false };
    const img = await decode(image.dataUrl);
    const canvas = draw(img, maxSide, true);
    let out = canvas.toDataURL('image/webp', 0.9);
    if (!out.startsWith('data:image/webp')) out = canvas.toDataURL(ALPHA.has(image.mime) ? 'image/png' : 'image/jpeg', 0.9);
    return { dataUrl: out, width: canvas.width, height: canvas.height, converted: true };
}

/** Small JPEG/PNG data URL for showing in the chat. */
export async function thumbnail(dataUrl: string, maxSide = 240): Promise<string> {
    const img = await decode(dataUrl);
    const keepAlpha = ALPHA.has(mimeOf(dataUrl));
    return draw(img, maxSide, keepAlpha).toDataURL(keepAlpha ? 'image/png' : 'image/jpeg', 0.8);
}
