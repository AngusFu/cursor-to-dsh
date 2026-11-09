/**
 * Ephemeral context-fill readings for the conversation pill (polled from host API).
 * Updated after each Cursor turn; not persisted.
 */
export interface ContextFillSnapshot {
  sessionId: string;
  modelId: string;
  percent: number;
  retainedTokens: number;
  limitTokens: number;
  viewPending: boolean;
  updatedAt: number;
}

const fills = new Map<string, ContextFillSnapshot>();

export function setContextFillSnapshot(snapshot: ContextFillSnapshot): void {
  fills.set(snapshot.sessionId, snapshot);
}

export function getContextFillSnapshot(sessionId: string): ContextFillSnapshot | undefined {
  return fills.get(sessionId);
}

export function clearContextFillSnapshots(): void {
  fills.clear();
}
