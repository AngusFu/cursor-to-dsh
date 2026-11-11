/**
 * File-first recovery for images folded out of a Cursor checkpoint.
 *
 * billion-context can rebuild its index from inbound HTTP history each turn.
 * cursor-to-dsh uses the Cursor SDK + checkpoint, so bytes must be spilled
 * when the session still has them. This module writes under a session-scoped
 * directory (session cwd/.dsh/retrieve/img/<session> or ~/.dsh/retrieve/img/<session>),
 * never a new database. Only payloads we can actually decode are restorable.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

export const IMAGE_PLACEHOLDER = "[image]";
const DEFAULT_TTL_MS = 7 * 24 * 3600 * 1000;
const INDEX_NAME = "index.json";
const LIST_CAP = 50;

export interface RestorableImage {
  mediaType: string;
  b64: string;
  bytes: number;
  width?: number;
  height?: number;
}

export interface IndexedImage {
  mediaType: string;
  bytes: number;
  width?: number;
  height?: number;
  path: string;
}

export interface ImageNote {
  ref?: string;
  placeholder: string;
  restorable: boolean;
}

export interface ImageRestoreResult {
  ok: boolean;
  mode?: "image" | "list";
  imageRef?: string;
  images?: Array<IndexedImage & { path: string }>;
  text: string;
}

const ROOTS = new Map<string, string>();
const INDEX = new Map<string, Map<string, IndexedImage[]>>();

export function setImageRestoreRoot(sessionId: string, root: string): void {
  const resolved = resolveSafeRoot(root);
  if (resolved) ROOTS.set(sessionId, resolved);
}

export function imageRestoreRoot(sessionId: string, sessionRoot?: string): string {
  return sessionRoot?.trim() ? resolveSafeRoot(sessionRoot) ?? defaultStateRoot() : ROOTS.get(sessionId) ?? defaultStateRoot();
}

export function resetImageRestoreForTests(): void {
  ROOTS.clear();
  INDEX.clear();
}

function defaultStateRoot(): string {
  return resolve(join(homedir(), ".dsh"));
}

function resolveSafeRoot(root: string): string | undefined {
  const trimmed = root.trim();
  if (!trimmed) return undefined;
  try {
    const resolved = resolve(trimmed);
    if (existsSync(resolved)) return realpathSync(resolved);
    return resolved;
  } catch {
    return undefined;
  }
}

export function restoreExportDirName(sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 100);
  return safe === sessionId
    ? safe || "session"
    : `${safe || "session"}-${createHash("sha256").update(sessionId).digest("hex").slice(0, 8)}`;
}

export function restoreExportDir(sessionId: string, sessionRoot?: string): string {
  const root = imageRestoreRoot(sessionId, sessionRoot);
  const name = restoreExportDirName(sessionId);
  return samePath(root, defaultStateRoot()) ? join(root, "retrieve", "img", name) : join(root, ".dsh", "retrieve", "img", name);
}

function samePath(a: string, b: string): boolean {
  return resolve(a) === resolve(b);
}

/** Return the resolved path when it stays inside root; otherwise undefined. */
export function pathWithinRoot(root: string, target: string): string | undefined {
  let resolvedRoot: string;
  let resolvedTarget: string;
  try {
    resolvedRoot = resolve(root);
    resolvedTarget = resolve(target);
  } catch {
    return undefined;
  }
  const prefix = resolvedRoot.endsWith(sep) ? resolvedRoot : resolvedRoot + sep;
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(prefix)) return undefined;
  return resolvedTarget;
}

function existingPathWithin(root: string, target: string): string | undefined {
  const within = pathWithinRoot(root, target);
  if (!within || !existsSync(within)) return undefined;
  try {
    const realFile = realpathSync(within);
    const realRoot = existsSync(root) ? realpathSync(root) : resolve(root);
    return pathWithinRoot(realRoot, realFile);
  } catch {
    return undefined;
  }
}

function extFor(mediaType: string): string {
  const sub = (mediaType.split("/")[1] ?? "").toLowerCase();
  const map: Record<string, string> = { png: "png", jpeg: "jpg", jpg: "jpg", gif: "gif", webp: "webp", svg: "svg" };
  return map[sub] ?? "img";
}

function b64Bytes(b64: string): number {
  return Buffer.byteLength(b64, "base64") || 0;
}

function parseDataUrl(url: string): { mediaType: string; base64: string } | undefined {
  const m = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/i.exec(url.trim());
  if (!m || !m[3]) return undefined;
  if (!m[2]) return undefined;
  return { mediaType: m[1] || "image/png", base64: m[3] };
}

function payloadFrom(data: unknown, mediaType?: string): RestorableImage | undefined {
  if (typeof data !== "string" || !data) return undefined;
  const parsed = data.startsWith("data:") ? parseDataUrl(data) : undefined;
  const b64 = parsed?.base64 ?? data;
  if (!b64) return undefined;
  const type = parsed?.mediaType || mediaType || "image/png";
  const dims = decodeImageDims(b64);
  return { mediaType: type, b64, bytes: b64Bytes(b64), width: dims?.w, height: dims?.h };
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Best-effort header scan (no full decode). */
export function decodeImageDims(b64: string): { w: number; h: number } | undefined {
  let buf: Buffer;
  try {
    buf = Buffer.from(b64, "base64");
  } catch {
    return undefined;
  }
  if (buf.length < 24) return undefined;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
  }
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf.toString("ascii", 8, 12) === "WEBP") {
    return webpDims(buf);
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) return jpegDims(buf);
  return undefined;
}

function jpegDims(buf: Buffer): { w: number; h: number } | undefined {
  let i = 2;
  while (i + 8 < buf.length) {
    if (buf[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = buf[i + 1];
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = buf.readUInt16BE(i + 2);
    if (len < 2) return undefined;
    if (
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    ) {
      return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return undefined;
}

function webpDims(buf: Buffer): { w: number; h: number } | undefined {
  const kind = buf.toString("ascii", 12, 16);
  if (kind === "VP8X" && buf.length >= 30) {
    const w = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
    const h = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
    return { w, h };
  }
  if (kind === "VP8 " && buf.length >= 30) {
    const start = buf[20] === 0x9d && buf[21] === 0x01 && buf[22] === 0x2a ? 20 : buf.indexOf(Buffer.from([0x9d, 0x01, 0x2a]));
    if (start >= 0 && start + 6 < buf.length) {
      return { w: buf.readUInt16LE(start + 3) & 0x3fff, h: buf.readUInt16LE(start + 5) & 0x3fff };
    }
  }
  return undefined;
}

interface SeenImage {
  restorable?: RestorableImage;
  mediaType?: string;
  width?: number;
  height?: number;
}

function contentBlocks(message: any): any[] {
  return Array.isArray(message?.content) ? message.content : [];
}

export function messageImages(message: any): SeenImage[] {
  const out: SeenImage[] = [];
  for (const b of contentBlocks(message)) {
    if (b?.type !== "image" || b.offloaded === true) continue;
    const mediaType = typeof b.mimeType === "string" ? b.mimeType : typeof b.attachment?.mediaType === "string" ? b.attachment.mediaType : undefined;
    const restorable = payloadFrom(b.data, mediaType);
    if (restorable) {
      out.push({ restorable, mediaType: restorable.mediaType, width: restorable.width, height: restorable.height });
      continue;
    }
    const width = Number(b.attachment?.width);
    const height = Number(b.attachment?.height);
    out.push({
      mediaType,
      width: Number.isFinite(width) && width > 0 ? width : undefined,
      height: Number.isFinite(height) && height > 0 ? height : undefined,
    });
  }
  return out;
}

export function messageImageBytes(message: any): RestorableImage[] {
  return messageImages(message).flatMap((img) => (img.restorable ? [img.restorable] : []));
}

function shortType(mediaType?: string): string {
  if (!mediaType) return "";
  return mediaType.includes("/") ? mediaType.split("/").pop()! : mediaType;
}

export function imagePlaceholder(img: SeenImage, ref?: string, restorable = false): string {
  let note = shortType(img.mediaType);
  const w = img.restorable?.width ?? img.width;
  const h = img.restorable?.height ?? img.height;
  if (w && h) note += `${note ? " " : ""}${w}x${h}`;
  let text = note ? `[image: ${note}]` : IMAGE_PLACEHOLDER;
  if (ref && restorable) text = `${text.slice(0, -1)} · ${ref}]`;
  return text;
}

export function imagePlaceholdersForSummary(message: any, ref: string | undefined, restorableFlags?: boolean[]): string[] {
  return messageImages(message).map((img, i) => imagePlaceholder(img, ref, restorableFlags?.[i] ?? Boolean(img.restorable && ref)));
}

function ensureGitignore(sessionRoot: string): void {
  if (samePath(sessionRoot, defaultStateRoot())) return;
  const marker = join(sessionRoot, ".dsh", ".gitignore");
  if (existsSync(marker)) return;
  try {
    mkdirSync(dirname(marker), { recursive: true, mode: 0o700 });
    writeFileSync(marker, "*\n", { encoding: "utf8", mode: 0o600 });
  } catch {
    /* best-effort */
  }
}

export function writeRestoredImage(ref: string, idx: number, img: RestorableImage, sessionId: string, sessionRoot?: string): string | null {
  const safeRef = ref.replace(/[^a-zA-Z0-9_-]/g, "-");
  if (!safeRef) return null;
  const dir = restoreExportDir(sessionId, sessionRoot);
  const root = imageRestoreRoot(sessionId, sessionRoot);
  const body = Buffer.from(img.b64, "base64");
  const digest = createHash("sha256").update(body).digest("hex").slice(0, 8);
  const candidate = join(dir, `${safeRef}${idx > 0 ? `-${idx}` : ""}-${digest}.${extFor(img.mediaType)}`);
  const path = pathWithinRoot(dir, candidate);
  if (!path) return null;
  try {
    if (existsSync(path)) return existingPathWithin(dir, path) ?? path;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    ensureGitignore(root);
    writeFileSync(path, body, { mode: 0o600 });
    return path;
  } catch {
    return null;
  }
}

function loadIndex(sessionId: string, sessionRoot?: string): Map<string, IndexedImage[]> {
  const cached = INDEX.get(sessionId);
  if (cached) return cached;
  const dir = restoreExportDir(sessionId, sessionRoot);
  const index = new Map<string, IndexedImage[]>();
  const file = pathWithinRoot(dir, join(dir, INDEX_NAME));
  if (file && existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as { images?: Record<string, IndexedImage[]> };
      for (const [ref, imgs] of Object.entries(parsed.images ?? {})) {
        const kept = (imgs ?? []).filter((im) => im?.path && existingPathWithin(dir, im.path));
        if (kept.length) index.set(ref, kept);
      }
    } catch {
      /* rebuild from files below */
    }
  }
  if (index.size === 0) {
    try {
      for (const name of readdirSync(dir)) {
        const m = /^(m\d+)(?:-(\d+))?-([0-9a-f]{8})\.[A-Za-z0-9]+$/i.exec(name);
        if (!m) continue;
        const path = existingPathWithin(dir, join(dir, name));
        if (!path) continue;
        const st = statSync(path);
        if (!st.isFile()) continue;
        const ref = m[1];
        const arr = index.get(ref) ?? [];
        arr.push({ mediaType: "image/" + (name.split(".").pop() === "jpg" ? "jpeg" : name.split(".").pop() ?? "png"), bytes: st.size, path });
        index.set(ref, arr);
      }
    } catch {
      /* empty dir */
    }
  }
  INDEX.set(sessionId, index);
  return index;
}

function saveIndex(sessionId: string, index: Map<string, IndexedImage[]>, sessionRoot?: string): void {
  INDEX.set(sessionId, index);
  const dir = restoreExportDir(sessionId, sessionRoot);
  const file = pathWithinRoot(dir, join(dir, INDEX_NAME));
  if (!file) return;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const images: Record<string, IndexedImage[]> = {};
    for (const [ref, imgs] of index) images[ref] = imgs;
    writeFileSync(file, JSON.stringify({ sessionId, images }), { encoding: "utf8", mode: 0o600 });
  } catch {
    /* best-effort */
  }
}

export function pruneRetrieveImgExports(sessionId: string, sessionRoot?: string, ttlMs = DEFAULT_TTL_MS): number {
  const dir = restoreExportDir(sessionId, sessionRoot);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }
  const now = Date.now();
  let removed = 0;
  for (const name of entries) {
    if (name === INDEX_NAME) continue;
    const p = join(dir, name);
    try {
      const st = statSync(p);
      if (st.isFile() && now - st.mtimeMs > ttlMs) {
        unlinkSync(p);
        removed++;
      }
    } catch {
      /* skip */
    }
  }
  if (removed > 0) {
    const index = loadIndex(sessionId, sessionRoot);
    for (const [ref, imgs] of [...index.entries()]) {
      const kept = imgs.filter((im) => existsSync(im.path));
      if (kept.length) index.set(ref, kept);
      else index.delete(ref);
    }
    saveIndex(sessionId, index, sessionRoot);
    try {
      if (readdirSync(dir).every((name) => name === INDEX_NAME)) {
        try {
          unlinkSync(join(dir, INDEX_NAME));
        } catch {
          /* ignore */
        }
        rmdirSync(dir);
        INDEX.delete(sessionId);
      }
    } catch {
      /* leave dir */
    }
  }
  return removed;
}

export function archiveSessionImages(opts: {
  sessionId: string;
  messages: readonly any[];
  refs: readonly { ref: string; index: number }[];
  sessionRoot?: string;
  onlyIndexes?: Set<number>;
}): ImageNote[] {
  const { sessionId, messages, sessionRoot, onlyIndexes } = opts;
  if (sessionRoot) setImageRestoreRoot(sessionId, sessionRoot);
  pruneRetrieveImgExports(sessionId, sessionRoot);
  const byIndex = new Map<number, string>();
  for (const r of opts.refs) {
    if (!byIndex.has(r.index) && r.ref && r.ref !== "BLOCKED") byIndex.set(r.index, r.ref);
  }
  const index = loadIndex(sessionId, sessionRoot);
  const notes: ImageNote[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (onlyIndexes && !onlyIndexes.has(i)) continue;
    const ref = byIndex.get(i);
    const seen = messageImages(messages[i]);
    if (!seen.length) continue;
    const bytes = seen.flatMap((img) => (img.restorable ? [img.restorable] : []));
    const written: IndexedImage[] = [];
    bytes.forEach((im, n) => {
      const path = writeRestoredImage(ref ?? `orphan-${i}`, n, im, sessionId, sessionRoot);
      if (!path || !ref) return;
      written.push({ mediaType: im.mediaType, bytes: im.bytes, width: im.width, height: im.height, path });
    });
    if (ref && written.length) index.set(ref, written);
    const flags = seen.map((img) => Boolean(ref && img.restorable && written.some((w) => w.bytes === img.restorable?.bytes)));
    for (const [n, img] of seen.entries()) {
      const restorable = flags[n] ?? false;
      notes.push({ ref, placeholder: imagePlaceholder(img, ref, restorable), restorable });
    }
  }
  saveIndex(sessionId, index, sessionRoot);
  return notes;
}

export function appendImagePlaceholders(summary: string, notes: ImageNote[]): string {
  const restorable = notes.filter((n) => n.restorable && n.placeholder);
  const all = notes.map((n) => n.placeholder).filter(Boolean);
  const markers = restorable.length ? restorable.map((n) => n.placeholder) : all;
  if (!markers.length) return summary;
  if (markers.every((p) => summary.includes(p))) return summary;
  return `${summary.trim()}\n\n[folded images: ${markers.join(" ")} — cursor_context_decompress({ imageRef }) restores pixels]`;
}

function refNum(ref: string): number {
  const m = /^m(\d+)$/i.exec(ref.trim());
  return m ? Number.parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER;
}

export function describeRestorable(sessionId: string, sessionRoot?: string, cap = LIST_CAP): string[] {
  const index = loadIndex(sessionId, sessionRoot);
  const dir = restoreExportDir(sessionId, sessionRoot);
  const lines: string[] = [];
  const refs = [...index.keys()].sort((a, b) => refNum(a) - refNum(b));
  outer: for (const ref of refs) {
    const imgs = (index.get(ref) ?? []).filter((im) => existingPathWithin(dir, im.path));
    for (let i = 0; i < imgs.length; i++) {
      const im = imgs[i];
      let note = shortType(im.mediaType) || "image";
      if (im.width != null && im.height != null) note += ` ${im.width}x${im.height}`;
      note += ` · ${Math.max(1, Math.round(im.bytes / 1024))}KB`;
      lines.push(`${ref}${i > 0 ? `[-${i}]` : ""} [${note}]`);
      if (lines.length >= cap) break outer;
    }
  }
  return lines;
}

export function restorableImageList(sessionId: string, sessionRoot?: string): IndexedImage[] {
  const index = loadIndex(sessionId, sessionRoot);
  const dir = restoreExportDir(sessionId, sessionRoot);
  return [...index.values()].flat().filter((im) => existingPathWithin(dir, im.path));
}

/** Validity-based dispatch: blank/null imageRef is text paging, not list. */
export function imageRestoreMode(imageRef: unknown): { mode: "image"; ref: string } | { mode: "text" } | { mode: "error"; message: string } {
  if (imageRef == null) return { mode: "text" };
  if (typeof imageRef !== "string") {
    return { mode: "error", message: 'imageRef must be a string (an mNNNNN ref or "list") — omit it to page archived text.' };
  }
  if (imageRef.trim() === "") return { mode: "text" };
  return { mode: "image", ref: imageRef.trim() };
}

function parseImageRef(raw: string): { ref: string; index?: number } | { list: true } {
  const value = raw.trim();
  if (value.toLowerCase() === "list") return { list: true };
  const indexed = /^(m\d+)(?:\[-(\d+)\]|-(\d+))$/i.exec(value);
  if (indexed) return { ref: indexed[1], index: Number.parseInt(indexed[2] ?? indexed[3]!, 10) };
  return { ref: value };
}

export function resolveImageRestore(opts: { sessionId: string; imageRef: string; sessionRoot?: string }): ImageRestoreResult {
  const { sessionId, sessionRoot } = opts;
  if (sessionRoot) setImageRestoreRoot(sessionId, sessionRoot);
  pruneRetrieveImgExports(sessionId, sessionRoot);
  const parsed = parseImageRef(opts.imageRef);
  const index = loadIndex(sessionId, sessionRoot);
  const dir = restoreExportDir(sessionId, sessionRoot);

  if ("list" in parsed) {
    const lines = describeRestorable(sessionId, sessionRoot);
    if (!lines.length) {
      return { ok: true, mode: "list", images: [], text: "[No restorable images right now — no image bytes were archived for this session.]" };
    }
    return {
      ok: true,
      mode: "list",
      images: restorableImageList(sessionId, sessionRoot),
      text: `[Restorable images (${lines.length}):]\n${lines.join("\n")}\nRestore one with cursor_context_decompress({ imageRef: "<ref>" }); it is written to a file you open with the read tool.`,
    };
  }

  const raw = parsed.ref;
  const imgs = (index.get(raw) ?? []).filter((im) => existingPathWithin(dir, im.path));
  const selected = parsed.index == null ? imgs : imgs[parsed.index] ? [imgs[parsed.index]] : [];
  if (!index.has(raw) && imgs.length === 0) {
    return {
      ok: false,
      imageRef: opts.imageRef.trim(),
      text: `[decompress FAILED: no restorable image for ref "${opts.imageRef.trim()}" (it carries no image, had no stored bytes, or is not from this session). Call cursor_context_decompress({ imageRef: "list" }) to see what is available.]`,
    };
  }
  if (selected.length === 0) {
    return {
      ok: false,
      imageRef: opts.imageRef.trim(),
      text: `[decompress FAILED: no restorable image for ref "${opts.imageRef.trim()}" (it carries no image, had no stored bytes, or is not from this session). Call cursor_context_decompress({ imageRef: "list" }) to see what is available.]`,
    };
  }
  const images = selected.map((im) => ({ ...im, path: existingPathWithin(dir, im.path)! }));
  const missing = (parsed.index == null ? (index.get(raw) ?? []).length : 1) - images.length;
  return {
    ok: true,
    mode: "image",
    imageRef: raw,
    images,
    text: `[Restored ${images.length} image(s) for ${opts.imageRef.trim()}:\n${images.map((im) => `  ${im.path}`).join("\n")}\nOpen them with the read tool to view the pixels.${missing > 0 ? `\n(${missing} image(s) could not be located on disk.)` : ""}]`,
  };
}
