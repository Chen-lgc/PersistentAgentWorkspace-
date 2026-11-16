import type { WireMessage } from "../shared/wire.ts";

export function pruneScreenFrames(t: { messages: WireMessage[] }, keep = 4): WireMessage[] {
  const pruned: WireMessage[] = [];
  let seen = 0;
  for (let i = t.messages.length - 1; i >= 0 && seen < t.messages.length; i--) {
    const m = t.messages[i];
    if (m.kind !== "screen" || !m.png) continue;
    seen += 1;
    if (seen > keep) {
      m.png = undefined;
      pruned.push(m);
    }
  }
  return pruned;
}
