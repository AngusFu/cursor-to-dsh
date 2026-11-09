/**
 * SQLite persistence for ledger refs, archive chunks, and acp-kernel state (§9).
 */
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);

import type { ArchiveChunk } from "./ledger.ts";
import type { CompressionState, MessageContentStore } from "acp-kernel";

type SqliteDb = {
  exec(sql: string): void;
  prepare(sql: string): { run(...args: unknown[]): void; all(...args: unknown[]): unknown[] };
};

let db: SqliteDb | undefined;
let tried = false;

function ledgerDbPath(): string {
  const dir = join(homedir(), ".dsh");
  mkdirSync(dir, { recursive: true });
  return join(dir, "cursor-context-ledger.db");
}

function openLedgerDb(): SqliteDb | undefined {
  if (tried) return db;
  tried = true;
  try {
    const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (path: string) => SqliteDb };
    db = new DatabaseSync(ledgerDbPath());
    try {
      db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;`);
    } catch {
      /* best-effort concurrency */
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS archive_chunks (
        session_id TEXT NOT NULL,
        chunk_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        summary TEXT NOT NULL,
        body TEXT NOT NULL,
        refs_json TEXT NOT NULL,
        tier INTEGER NOT NULL DEFAULT 1,
        at INTEGER NOT NULL,
        PRIMARY KEY (session_id, chunk_id)
      );
      CREATE INDEX IF NOT EXISTS idx_chunks_session ON archive_chunks(session_id, at);
      CREATE TABLE IF NOT EXISTS message_refs (
        session_id TEXT NOT NULL,
        ref TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        body_text TEXT NOT NULL,
        msg_index INTEGER NOT NULL,
        archived INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (session_id, ref)
      );
      CREATE INDEX IF NOT EXISTS idx_refs_session_fp ON message_refs(session_id, fingerprint);
      CREATE TABLE IF NOT EXISTS kernel_state (
        session_id TEXT PRIMARY KEY,
        state_json TEXT NOT NULL,
        applied_revision INTEGER NOT NULL DEFAULT 0,
        last_token_count INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS content_store (
        session_id TEXT PRIMARY KEY,
        store_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    try {
      db.exec(`ALTER TABLE archive_chunks ADD COLUMN tier INTEGER NOT NULL DEFAULT 1`);
    } catch {
      /* column exists */
    }
    try {
      db.exec(`ALTER TABLE kernel_state ADD COLUMN last_token_count INTEGER NOT NULL DEFAULT 0`);
    } catch {
      /* column exists */
    }
  } catch {
    db = undefined;
  }
  return db;
}

export function persistArchiveChunk(sessionId: string, chunk: ArchiveChunk & { tier?: number }): void {
  const store = openLedgerDb();
  if (!store) return;
  try {
    store
      .prepare(
        `INSERT OR REPLACE INTO archive_chunks (session_id, chunk_id, revision, summary, body, refs_json, tier, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sessionId,
        chunk.id,
        chunk.revision,
        chunk.summary,
        chunk.text,
        JSON.stringify(chunk.messageRefs),
        chunk.tier ?? 1,
        chunk.at,
      );
  } catch {
    /* parallel tests or sqlite lock */
  }
}

export function loadArchiveChunks(sessionId: string): ArchiveChunk[] {
  const store = openLedgerDb();
  if (!store) return [];
  const rows = store
    .prepare(
      `SELECT chunk_id, revision, summary, body, refs_json, at FROM archive_chunks WHERE session_id = ? ORDER BY at ASC`,
    )
    .all(sessionId) as { chunk_id: string; revision: number; summary: string; body: string; refs_json: string; at: number }[];
  return rows.map((r) => ({
    id: r.chunk_id,
    revision: r.revision,
    messageRefs: JSON.parse(r.refs_json) as string[],
    text: r.body,
    summary: r.summary,
    at: r.at,
  }));
}

export interface PersistedMessageRef {
  ref: string;
  fingerprint: string;
  text: string;
  index: number;
  archived: boolean;
}

export function persistMessageRefs(sessionId: string, refs: readonly PersistedMessageRef[]): void {
  const store = openLedgerDb();
  if (!store || !refs.length) return;
  try {
    const stmt = store.prepare(
      `INSERT OR REPLACE INTO message_refs (session_id, ref, fingerprint, body_text, msg_index, archived)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const r of refs) {
      stmt.run(sessionId, r.ref, r.fingerprint, r.text, r.index, r.archived ? 1 : 0);
    }
  } catch {
    /* parallel tests or sqlite lock — in-memory refs still apply this turn */
  }
}

export function loadMessageRefs(sessionId: string): PersistedMessageRef[] {
  const store = openLedgerDb();
  if (!store) return [];
  const rows = store
    .prepare(`SELECT ref, fingerprint, body_text, msg_index, archived FROM message_refs WHERE session_id = ? ORDER BY ref`)
    .all(sessionId) as { ref: string; fingerprint: string; body_text: string; msg_index: number; archived: number }[];
  return rows.map((r) => ({
    ref: r.ref,
    fingerprint: r.fingerprint,
    text: r.body_text,
    index: r.msg_index,
    archived: Boolean(r.archived),
  }));
}

export function persistKernelState(
  sessionId: string,
  payload: { state: CompressionState; appliedRevision: number; lastTokenCount?: number },
): void {
  const store = openLedgerDb();
  if (!store) return;
  const lastTokenCount = Math.max(0, Math.floor(Number(payload.lastTokenCount ?? 0)));
  try {
    store
      .prepare(
        `INSERT OR REPLACE INTO kernel_state (session_id, state_json, applied_revision, last_token_count, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      )
      .run(sessionId, JSON.stringify(payload.state), payload.appliedRevision, lastTokenCount, Date.now());
  } catch {
    /* parallel tests or sqlite lock — in-memory kernel state still applies this turn */
  }
}

export function persistContentStore(sessionId: string, store: MessageContentStore): void {
  const sqlite = openLedgerDb();
  if (!sqlite) return;
  try {
    sqlite
      .prepare(`INSERT OR REPLACE INTO content_store (session_id, store_json, updated_at) VALUES (?, ?, ?)`)
      .run(sessionId, JSON.stringify(store), Date.now());
  } catch {
    /* ignore lock */
  }
}

export function loadContentStore(sessionId: string): MessageContentStore | undefined {
  const sqlite = openLedgerDb();
  if (!sqlite) return undefined;
  const row = sqlite
    .prepare(`SELECT store_json FROM content_store WHERE session_id = ?`)
    .all(sessionId)[0] as { store_json: string } | undefined;
  if (!row) return undefined;
  try {
    return JSON.parse(row.store_json) as MessageContentStore;
  } catch {
    return undefined;
  }
}

export function loadKernelState(
  sessionId: string,
): { state: CompressionState; appliedRevision: number; lastTokenCount: number } | undefined {
  const store = openLedgerDb();
  if (!store) return undefined;
  const row = store
    .prepare(`SELECT state_json, applied_revision, last_token_count FROM kernel_state WHERE session_id = ?`)
    .all(sessionId)[0] as { state_json: string; applied_revision: number; last_token_count?: number } | undefined;
  if (!row) return undefined;
  try {
    return {
      state: JSON.parse(row.state_json) as CompressionState,
      appliedRevision: row.applied_revision,
      lastTokenCount: Math.max(0, Math.floor(Number(row.last_token_count ?? 0))),
    };
  } catch {
    return undefined;
  }
}

/** Test hook. */
export function resetLedgerDb(): void {
  db = undefined;
  tried = false;
}

export function ledgerPersistenceEnabled(): boolean {
  return openLedgerDb() !== undefined;
}

export function listPersistedContextSessions(limit = 40): {
  sessionId: string;
  appliedRevision: number;
  updatedAt: number;
}[] {
  const store = openLedgerDb();
  if (!store) return [];
  const rows = store
    .prepare(
      `SELECT session_id, applied_revision, updated_at FROM kernel_state ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(limit) as { session_id: string; applied_revision: number; updated_at: number }[];
  return rows.map((r) => ({
    sessionId: r.session_id,
    appliedRevision: r.applied_revision,
    updatedAt: r.updated_at,
  }));
}
