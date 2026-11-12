/**
 * File-first recovery for images folded out of a Cursor checkpoint.
 *
 * billion-context can rebuild its index from inbound HTTP history each turn.
 * cursor-to-dsh uses the Cursor SDK + checkpoint, so bytes must be spilled
 * when the session still has them. Writes go only to the user-level plugin
 * store: `$DSH_HOME/cursor-to-dsh/retrieve/img/<session>` (default
 * `~/.dsh/cursor-to-dsh/retrieve/img/<session>`). That follows the host's
 * DSH home convention and is isolated by native session id, never by cwd.
 * Only real descendants of the canonical OS user home are writable; custom
 * external homes, descendant symlinks, and observed project roots fail closed.
 * This module never falls back to a project or `cwd/.dsh` for writes.
 *
 * Older `cwd/.dsh/retrieve/img/<session>` trees are left in place and are
 * never deleted, rewritten, or bulk-imported. The same session may read
 * them after a strict ownership check. Other sessions are not scanned.
 * External storage is not a sandbox: a model can still read shared workspace
 * files with ordinary tools.
 *
 * Only payloads we can actually decode are restorable.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const IMAGE_PLACEHOLDER = "[image]";
const DEFAULT_TTL_MS = 7 * 24 * 3600 * 1000;
const INDEX_NAME = "index.json";
const LIST_CAP = 50;
const PLUGIN_STORE_SEGMENTS = ["cursor-to-dsh", "retrieve", "img"] as const;

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
  /** Zero-based position among images that share this ref; preserved across rebuilds. */
  index?: number;
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

/** Optional cwd hints used only to locate a same-session legacy project cache. */
const LEGACY_CWD = new Map<string, string>();
// Canonical project roots ever observed in this process. A later cwd change must
// not make an earlier project's path eligible for cache writes or TTL deletes.
const PROJECT_ROOTS = new Set<string>();

/**
 * Record a session cwd as a read-only hint for a pre-existing project cache.
 * This never selects the write location.
 */
export function setImageRestoreRoot(sessionId: string, root: string): void {
  const resolved = resolveSafeRoot(root);
  if (resolved) {
    LEGACY_CWD.set(sessionId, resolved);
    PROJECT_ROOTS.add(resolved);
  }
}

/** User-level plugin image store root (`$DSH_HOME/cursor-to-dsh/retrieve/img`). The arguments are ignored and kept only for call-site compatibility. */
export function imageRestoreRoot(_sessionId?: string, _sessionRoot?: string): string {
  return pluginImageStoreRoot();
}

export function resetImageRestoreForTests(): void {
  LEGACY_CWD.clear();
  PROJECT_ROOTS.clear();
}

/**
 * Resolve the host user-data home the same way DSH does: a non-empty
 * `$DSH_HOME`, otherwise `~/.dsh`. Whitespace-only and cwd-relative values
 * are treated as unset. This computes the candidate only: guardedStoreRoot
 * separately restricts filesystem access to real user-home descendants.
 */
export function resolveDshHome(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.DSH_HOME?.trim();
  if (raw) {
    const expanded = expandHomePath(raw);
    if (isAbsolute(expanded)) return canonicalHomePath(resolve(expanded));
  }
  return canonicalHomePath(resolve(join(homedir(), ".dsh")));
}

function expandHomePath(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~" + sep) || value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}

/** Canonical write root for this plugin's image backups, session buckets live underneath. */
export function pluginImageStoreRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveDshHome(env), ...PLUGIN_STORE_SEGMENTS);
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

/** Writable, session-scoped export directory under the plugin store. `sessionRoot` is ignored. */
export function restoreExportDir(sessionId: string, _sessionRoot?: string): string {
  return join(pluginImageStoreRoot(), restoreExportDirName(sessionId));
}

function samePath(a: string, b: string): boolean {
  return resolve(a) === resolve(b);
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
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
  // Read-only legacy references can use OS ancestor aliases (/var vs /private/var).
  // Compare their real locations, still rejecting final symlinks and foreign buckets.
  if (!existsSync(target) || isSymlink(target) || isSymlink(root)) return undefined;
  try {
    const realFile = realpathSync(target);
    const realRoot = realpathSync(root);
    return pathWithinRoot(realRoot, realFile);
  } catch {
    return undefined;
  }
}

/** Canonicalize the trusted OS home/its system ancestors, not user-controlled children. */
function trustedHome(): string | undefined {
  const home = homedir();
  if (!isAbsolute(home)) return undefined;
  try {
    const real = realpathSync(home);
    return statSync(real).isDirectory() ? real : undefined;
  } catch {
    return undefined;
  }
}

/** Accept both lexical HOME and canonical HOME spellings (e.g. macOS /var -> /private/var). */
function canonicalHomePath(target: string): string {
  const home = trustedHome();
  const lexicalHome = resolve(homedir());
  if (home && pathWithinRoot(lexicalHome, target)) return join(home, relative(lexicalHome, target));
  return target;
}

function insideKnownProject(target: string): boolean {
  return [...PROJECT_ROOTS].some((project) => Boolean(pathWithinRoot(project, target)));
}

/**
 * Trust only a dedicated DSH directory inside the canonical user home. Custom
 * external homes fail closed (no fallback writes). Validate every descendant
 * BEFORE mkdir, so no user-created DSH/plugin ancestor link can redefine trust.
 * The canonical OS home itself may have legitimate system aliases.
 */
function guardedStoreRoot(create: boolean): string | undefined {
  const home = trustedHome();
  const dsh = resolveDshHome();
  const root = pluginImageStoreRoot();
  if (!home || samePath(home, dsh) || !pathWithinRoot(home, dsh) || insideKnownProject(root)) return undefined;
  let current = home;
  for (const part of relative(home, root).split(sep)) {
    if (!part || part === "." || part === "..") return undefined;
    current = join(current, part);
    try {
      const st = lstatSync(current);
      if (st.isSymbolicLink() || !st.isDirectory()) return undefined;
    } catch (err) {
      if (!create || (err as NodeJS.ErrnoException)?.code !== "ENOENT") return undefined;
      try {
        mkdirSync(current, { mode: 0o700 });
        const st = lstatSync(current);
        if (st.isSymbolicLink() || !st.isDirectory()) return undefined;
      } catch {
        return undefined;
      }
    }
  }
  return current;
}

/** Open a real session bucket only under a fully validated user-level root. */
function openRealSessionDir(sessionId: string, create: boolean): string | undefined {
  const store = guardedStoreRoot(create);
  if (!store) return undefined;
  const dir = join(store, restoreExportDirName(sessionId));
  try {
    try {
      const st = lstatSync(dir);
      if (st.isSymbolicLink() || !st.isDirectory()) return undefined;
    } catch (err) {
      if (!create || (err as NodeJS.ErrnoException)?.code !== "ENOENT") return undefined;
      mkdirSync(dir, { mode: 0o700 });
    }
    if (isSymlink(dir) || !pathWithinRoot(store, realpathSync(dir))) return undefined;
    const file = join(dir, INDEX_NAME);
    if (isSymlink(file)) return undefined;
    if (existsSync(file)) {
      if (!lstatSync(file).isFile()) return undefined;
      // Foreign ownership is not corruption to repair, and must also stop TTL/write.
      let parsed: any;
      try { parsed = JSON.parse(readFileSync(file, "utf8")); } catch { /* torn index: rebuild allowed */ }
      if (parsed && Object.hasOwn(parsed, "sessionId") && parsed.sessionId !== sessionId) return undefined;
    }
    return dir;
  } catch {
    return undefined;
  }
}

function atomicWriteFile(sessionId: string, path: string, data: string | Uint8Array, mode: number): boolean {
  if (openRealSessionDir(sessionId, false) !== dirname(path) || isSymlink(path)) return false;
  const dir = dirname(path);
  const tmp = join(dir, `.${basename(path)}.${randomUUID()}.tmp`);
  const flags = constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0);
  let fd: number | undefined;
  try {
    fd = openSync(tmp, flags, mode);
    const body = typeof data === "string" ? Buffer.from(data, "utf8") : data;
    let offset = 0;
    while (offset < body.byteLength) {
      const wrote = writeSync(fd, body, offset, body.byteLength - offset);
      if (wrote <= 0) throw new Error("Incomplete image-store write");
      offset += wrote;
    }
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    if (openRealSessionDir(sessionId, false) !== dir) return false;
    if (isSymlink(path)) {
      unlinkSync(tmp);
      return false;
    }
    renameSync(tmp, path);
    return true;
  } catch {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* already closed */
      }
    }
    try {
      if (openRealSessionDir(sessionId, false) === dir) unlinkSync(tmp);
    } catch {
      /* best-effort */
    }
    return false;
  }
}

function legacyCwdHint(sessionId: string, sessionRoot?: string): string | undefined {
  const raw = sessionRoot?.trim() || LEGACY_CWD.get(sessionId);
  if (!raw) return undefined;
  const resolved = resolveSafeRoot(raw);
  if (!resolved) return undefined;
  if (samePath(resolved, resolveDshHome()) || samePath(resolved, pluginImageStoreRoot())) return undefined;
  return resolved;
}

/**
 * Historical project cache for this session only. Never created, pruned, or
 * written by this module; undefined when the bucket is missing, foreign, or a symlink.
 */
export function legacyProjectExportDir(sessionId: string, sessionRoot?: string): string | undefined {
  const cwd = legacyCwdHint(sessionId, sessionRoot);
  if (!cwd) return undefined;
  const name = restoreExportDirName(sessionId);
  const parent = join(cwd, ".dsh", "retrieve", "img");
  const dir = join(parent, name);
  try {
    let child = cwd;
    for (const part of [".dsh", "retrieve", "img", name]) {
      child = join(child, part);
      const st = lstatSync(child);
      if (st.isSymbolicLink() || !st.isDirectory()) return undefined;
    }
    const realDir = realpathSync(dir);
    const realParent = existsSync(parent) && !isSymlink(parent) ? realpathSync(parent) : resolve(parent);
    if (!pathWithinRoot(realParent, realDir)) return undefined;
    if (basename(realDir) !== name) return undefined;
    const cwdReal = existsSync(cwd) ? realpathSync(cwd) : resolve(cwd);
    if (!pathWithinRoot(cwdReal, realDir)) return undefined;
    return realDir;
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

function compactSlots(slots: (IndexedImage | undefined)[]): IndexedImage[] {
  return slots.filter((im): im is IndexedImage => Boolean(im));
}

function placeIndexed(index: Map<string, (IndexedImage | undefined)[]>, ref: string, idx: number, image: IndexedImage): void {
  if (!Number.isInteger(idx) || idx < 0) return;
  const slots = index.get(ref) ?? [];
  if (slots[idx] && slots[idx]!.path !== image.path) return;
  slots[idx] = { ...image, index: idx };
  index.set(ref, slots);
}

function parseExportName(name: string): { ref: string; index: number } | undefined {
  const m = /^(m\d+|orphan-\d+)(?:-(\d+))?-([0-9a-f]{8})\.[A-Za-z0-9]+$/i.exec(name);
  if (!m) return undefined;
  return { ref: m[1], index: m[2] ? Number.parseInt(m[2], 10) : 0 };
}

function rebuildIndexFromFiles(dir: string, index: Map<string, (IndexedImage | undefined)[]>): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  names.sort();
  const conflicts = new Map<string, Set<number>>();
  for (const name of names) {
    const parsed = parseExportName(name);
    if (!parsed) continue;
    const path = existingPathWithin(dir, join(dir, name));
    if (!path) continue;
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(path);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    if (conflicts.get(parsed.ref)?.has(parsed.index)) continue;
    const slots = index.get(parsed.ref);
    if (slots?.[parsed.index] && slots[parsed.index]!.path !== path) {
      slots[parsed.index] = undefined;
      const blocked = conflicts.get(parsed.ref) ?? new Set<number>();
      blocked.add(parsed.index);
      conflicts.set(parsed.ref, blocked);
      continue;
    }
    const ext = name.split(".").pop() ?? "png";
    placeIndexed(index, parsed.ref, parsed.index, {
      mediaType: "image/" + (ext === "jpg" ? "jpeg" : ext),
      bytes: st.size,
      path,
      index: parsed.index,
    });
  }
}

function loadIndexFromDir(sessionId: string, dir: string | undefined, allowRebuild: boolean, requireOwner = false): Map<string, (IndexedImage | undefined)[]> {
  const index = new Map<string, (IndexedImage | undefined)[]>();
  if (!dir) return index;
  const file = pathWithinRoot(dir, join(dir, INDEX_NAME));
  if (file && existsSync(file) && !isSymlink(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as { sessionId?: string; images?: Record<string, Array<(IndexedImage & { index?: number }) | null>> };
      if (Object.hasOwn(parsed, "sessionId") && parsed.sessionId !== sessionId) return index;
      if (requireOwner && parsed.sessionId !== sessionId) return index;
      if (!parsed.sessionId || parsed.sessionId === sessionId) {
        for (const [ref, imgs] of Object.entries(parsed.images ?? {})) {
          // A valid primary index owns the ref even if every pixel is missing.
          // Preserve this tombstone so legacy or older versions cannot fill it.
          index.set(ref, []);
          (imgs ?? []).forEach((im, i) => {
            if (!im?.path) return;
            const idx = typeof im.index === "number" && Number.isInteger(im.index) && im.index >= 0 ? im.index : i;
            const path = existingPathWithin(dir, im.path);
            if (!path) return;
            placeIndexed(index, ref, idx, { ...im, path, index: idx });
          });
        }
        return index;
      }
    } catch {
      /* rebuild from files below */
    }
  }
  if (allowRebuild) rebuildIndexFromFiles(dir, index);
  return index;
}

function loadIndex(sessionId: string, _sessionRoot?: string): Map<string, (IndexedImage | undefined)[]> {
  return loadIndexFromDir(sessionId, openRealSessionDir(sessionId, false), true);
}

function loadLegacyIndex(sessionId: string, sessionRoot?: string): Map<string, (IndexedImage | undefined)[]> {
  const dir = legacyProjectExportDir(sessionId, sessionRoot);
  // Old project data has no trusted-store provenance: only an explicit matching
  // owner index is accepted. Never scan old directories to infer ownership.
  return loadIndexFromDir(sessionId, dir, false, true);
}

function saveIndex(sessionId: string, index: Map<string, (IndexedImage | undefined)[]>, _sessionRoot?: string): void {
  if (index.size === 0) return;
  const dir = openRealSessionDir(sessionId, true);
  if (!dir) return;
  const file = pathWithinRoot(dir, join(dir, INDEX_NAME));
  if (!file) return;
  const images: Record<string, IndexedImage[]> = {};
  for (const [ref, slots] of index) {
    // Empty refs are authoritative tombstones, not permission to rebuild history.
    images[ref] = compactSlots(slots);
  }
  if (!Object.keys(images).length) return;
  atomicWriteFile(sessionId, file, JSON.stringify({ sessionId, images }), 0o600);
}

export function writeRestoredImage(ref: string, idx: number, img: RestorableImage, sessionId: string, sessionRoot?: string): string | null {
  if (sessionRoot) setImageRestoreRoot(sessionId, sessionRoot);
  const safeRef = ref.replace(/[^a-zA-Z0-9_-]/g, "-");
  if (!safeRef) return null;
  const dir = openRealSessionDir(sessionId, true);
  if (!dir) return null;
  const body = Buffer.from(img.b64, "base64");
  const digest = createHash("sha256").update(body).digest("hex").slice(0, 8);
  const candidate = join(dir, `${safeRef}${idx > 0 ? `-${idx}` : ""}-${digest}.${extFor(img.mediaType)}`);
  const path = pathWithinRoot(dir, candidate);
  if (!path) return null;
  try {
    if (existsSync(path)) return isSymlink(path) ? null : existingPathWithin(dir, path) ?? null;
    if (!atomicWriteFile(sessionId, path, body, 0o600)) return null;
    return existingPathWithin(dir, path) ?? path;
  } catch {
    return null;
  }
}

export function pruneRetrieveImgExports(sessionId: string, sessionRoot?: string, ttlMs = DEFAULT_TTL_MS): number {
  if (sessionRoot) setImageRestoreRoot(sessionId, sessionRoot);
  const dir = openRealSessionDir(sessionId, false);
  if (!dir) return 0;
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
      if (openRealSessionDir(sessionId, false) !== dir || isSymlink(p)) continue;
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
    if (openRealSessionDir(sessionId, false) !== dir) return removed;
    // Keep the authoritative mapping when valid; only torn/missing indexes
    // may rebuild. A surviving older file must not replace a newer indexed image.
    const index = loadIndex(sessionId);
    if (index.size === 0) {
      try {
        if (existsSync(join(dir, INDEX_NAME)) && !isSymlink(join(dir, INDEX_NAME))) unlinkSync(join(dir, INDEX_NAME));
      } catch {
        /* ignore */
      }
      try {
        if (readdirSync(dir).length === 0) rmdirSync(dir);
      } catch {
        /* leave dir */
      }
    } else {
      saveIndex(sessionId, index);
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
  // cwd is remembered only as a same-session legacy read hint.
  if (sessionRoot) setImageRestoreRoot(sessionId, sessionRoot);
  pruneRetrieveImgExports(sessionId);
  const byIndex = new Map<number, string>();
  for (const r of opts.refs) {
    if (!byIndex.has(r.index) && r.ref && r.ref !== "BLOCKED") byIndex.set(r.index, r.ref);
  }
  const index = loadIndex(sessionId, sessionRoot);
  const notes: ImageNote[] = [];
  let wrote = false;
  for (let i = 0; i < messages.length; i++) {
    if (onlyIndexes && !onlyIndexes.has(i)) continue;
    const ref = byIndex.get(i);
    const seen = messageImages(messages[i]);
    if (!seen.length) continue;
    const written: IndexedImage[] = [];
    // Preserve original image positions, including gaps for unavailable pixels.
    seen.forEach((entry, n) => {
      const im = entry.restorable;
      if (!im) return;
      const path = writeRestoredImage(ref ?? `orphan-${i}`, n, im, sessionId);
      if (!path || !ref) return;
      wrote = true;
      written.push({ mediaType: im.mediaType, bytes: im.bytes, width: im.width, height: im.height, path, index: n });
    });
    if (ref && written.length) {
      // This host message is authoritative; do not retain an old image at a rebased ref.
      const slots: (IndexedImage | undefined)[] = [];
      for (const im of written) slots[im.index!] = im;
      index.set(ref, slots);
    }
    const flags = seen.map((_, n) => written.some((im) => im.index === n));
    for (const [n, img] of seen.entries()) {
      const restorable = flags[n] ?? false;
      notes.push({ ref, placeholder: imagePlaceholder(img, ref, restorable), restorable });
    }
  }
  if (wrote || index.size > 0) saveIndex(sessionId, index);
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

function mergeSessionIndexes(primary: Map<string, (IndexedImage | undefined)[]>, legacy: Map<string, (IndexedImage | undefined)[]>): Map<string, (IndexedImage | undefined)[]> {
  const out = new Map<string, (IndexedImage | undefined)[]>();
  for (const [ref, slots] of primary) out.set(ref, slots.slice());
  for (const [ref, slots] of legacy) {
    // A primary ref describes the whole message, including absent/ambiguous
    // positions. Never fill those holes with older project pixels.
    if (!out.has(ref)) out.set(ref, slots.slice());
  }
  return out;
}

export function describeRestorable(sessionId: string, sessionRoot?: string, cap = LIST_CAP): string[] {
  const index = mergeSessionIndexes(loadIndex(sessionId, sessionRoot), loadLegacyIndex(sessionId, sessionRoot));
  const lines: string[] = [];
  const refs = [...index.keys()].sort((a, b) => refNum(a) - refNum(b));
  outer: for (const ref of refs) {
    const slots = index.get(ref) ?? [];
    for (let i = 0; i < slots.length; i++) {
      const im = slots[i];
      if (!im) continue;
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
  const index = mergeSessionIndexes(loadIndex(sessionId, sessionRoot), loadLegacyIndex(sessionId, sessionRoot));
  return [...index.values()].flatMap((slots) => compactSlots(slots));
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

function locatedImages(slots: (IndexedImage | undefined)[], want?: number): IndexedImage[] {
  if (want == null) return compactSlots(slots);
  const im = slots[want];
  return im ? [im] : [];
}

export function resolveImageRestore(opts: { sessionId: string; imageRef: string; sessionRoot?: string }): ImageRestoreResult {
  const { sessionId, sessionRoot } = opts;
  if (sessionRoot) setImageRestoreRoot(sessionId, sessionRoot);
  pruneRetrieveImgExports(sessionId);
  const parsed = parseImageRef(opts.imageRef);
  const primary = loadIndex(sessionId, sessionRoot);
  const legacy = loadLegacyIndex(sessionId, sessionRoot);
  const index = mergeSessionIndexes(primary, legacy);

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
  const slots = index.get(raw) ?? [];
  const selected = locatedImages(slots, parsed.index);
  if (!index.has(raw) && selected.length === 0) {
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
  const images = selected;
  const missing = (parsed.index == null ? compactSlots(index.get(raw) ?? []).length : 1) - images.length;
  return {
    ok: true,
    mode: "image",
    imageRef: raw,
    images,
    text: `[Restored ${images.length} image(s) for ${opts.imageRef.trim()}:\n${images.map((im) => `  ${im.path}`).join("\n")}\nOpen them with the read tool to view the pixels.${missing > 0 ? `\n(${missing} image(s) could not be located on disk.)` : ""}]`,
  };
}
