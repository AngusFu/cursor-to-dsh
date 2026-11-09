/**
 * Turn-integrity gate (acp-kernel recommend.ts / turn-integrity.ts).
 * Keeps tool-call/result pairs and reasoning+act turns atomic when folding.
 */
import type { CoreMessage } from "acp-kernel";

function isAssistantAct(msg: CoreMessage): boolean {
  return msg.role === "assistant" && (msg.contentType === "text" || msg.contentType === "tool-call");
}

export function computeTurnGroups(messages: CoreMessage[]): string[][] {
  const resultIdByCallId = new Map<string, string>();
  for (const msg of messages) {
    if (msg.contentType === "tool-result" && typeof msg.toolCallId === "string" && msg.id) {
      if (!resultIdByCallId.has(msg.toolCallId)) resultIdByCallId.set(msg.toolCallId, msg.id);
    }
  }
  const grouped = new Set<string>();
  const groups: string[][] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (!msg.id || grouped.has(msg.id)) continue;
    if (!(msg.contentType === "reasoning" || isAssistantAct(msg))) continue;
    let reasoningStart = i;
    if (msg.contentType === "reasoning") {
      while (reasoningStart > 0 && messages[reasoningStart - 1]!.contentType === "reasoning") reasoningStart--;
    } else {
      let s = i;
      while (s > 0 && isAssistantAct(messages[s - 1]!)) s--;
      reasoningStart = s;
      while (reasoningStart > 0 && messages[reasoningStart - 1]!.contentType === "reasoning") reasoningStart--;
    }
    const burstStart = (() => {
      let s = reasoningStart;
      while (s < messages.length && messages[s]!.contentType === "reasoning") s++;
      return s;
    })();
    if (burstStart >= messages.length || !isAssistantAct(messages[burstStart]!)) continue;
    let burstEnd = burstStart;
    while (burstEnd + 1 < messages.length && isAssistantAct(messages[burstEnd + 1]!)) burstEnd++;
    const members = new Set<string>();
    for (let k = reasoningStart; k <= burstEnd; k++) {
      const m = messages[k]!;
      if (!m.id) continue;
      members.add(m.id);
      if (m.role === "assistant" && m.contentType === "tool-call" && typeof m.toolCallId === "string") {
        const rid = resultIdByCallId.get(m.toolCallId);
        if (rid) members.add(rid);
      }
    }
    for (const id of members) grouped.add(id);
    groups.push([...members]);
  }
  return groups;
}

export interface IntegrityWithdrawals {
  withdrawn: Set<string>;
  splitTurnCount: number;
  splitPairCount: number;
}

export function computeIntegrityWithdrawals(messages: CoreMessage[], foldedIds: ReadonlySet<string>): IntegrityWithdrawals {
  const remaining = new Set(foldedIds);
  const withdrawn = new Set<string>();
  const handledTurns = new Set<number>();
  const handledPairs = new Set<string>();
  const reasoningIds = new Set<string>();
  const callIds = new Set<string>();
  const callIdByMessageId = new Map<string, string>();
  const resultIdByCallId = new Map<string, string>();
  for (const m of messages) {
    if (!m.id) continue;
    if (m.contentType === "reasoning") reasoningIds.add(m.id);
    if (m.role === "assistant" && m.contentType === "tool-call") {
      callIds.add(m.id);
      if (typeof m.toolCallId === "string") callIdByMessageId.set(m.id, m.toolCallId);
    }
    if (m.contentType === "tool-result" && typeof m.toolCallId === "string") {
      if (!resultIdByCallId.has(m.toolCallId)) resultIdByCallId.set(m.toolCallId, m.id);
    }
  }
  const groups = computeTurnGroups(messages);
  let changed = true;
  while (changed) {
    changed = false;
    for (let g = 0; g < groups.length; g++) {
      if (handledTurns.has(g)) continue;
      const group = groups[g]!;
      const foldHasReasoning = group.some((id) => remaining.has(id) && reasoningIds.has(id));
      if (!foldHasReasoning) continue;
      const keptHasCall = group.some((id) => !remaining.has(id) && callIds.has(id));
      if (!keptHasCall) continue;
      handledTurns.add(g);
      for (const id of group) {
        remaining.delete(id);
        withdrawn.add(id);
      }
      changed = true;
    }
    for (const m of messages) {
      if (!m.id || !callIds.has(m.id)) continue;
      const callId = callIdByMessageId.get(m.id);
      if (callId === undefined || handledPairs.has(callId)) continue;
      const resultId = resultIdByCallId.get(callId);
      if (resultId === undefined) continue;
      if (remaining.has(m.id) === remaining.has(resultId)) continue;
      handledPairs.add(callId);
      remaining.delete(m.id);
      remaining.delete(resultId);
      withdrawn.add(m.id);
      withdrawn.add(resultId);
      changed = true;
    }
  }
  return { withdrawn, splitTurnCount: handledTurns.size, splitPairCount: handledPairs.size };
}
