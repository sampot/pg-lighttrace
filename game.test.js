import { describe, expect, it } from "vitest";
import { createGame, applyAction, getLegalActions, getOutcome, summarize } from "./game.js";

describe("pg-lighttrace", () => {
  it("creates a playable state with legal actions", () => {
    const s = createGame({ seed: 42 });
    expect(getOutcome(s)).toBe("playing");
    const acts = getLegalActions(s);
    expect(acts.length).toBeGreaterThan(0);
    expect(summarize(s)).toBeTruthy();
  });

  it("applyAction advances without throwing", () => {
    let s = createGame({ seed: 7 });
    for (let i = 0; i < 12; i++) {
      const acts = getLegalActions(s);
      if (!acts.length) break;
      s = applyAction(s, acts[i % acts.length]);
      expect(s).toBeTruthy();
    }
    expect(["playing", "won", "lost"]).toContain(getOutcome(s));
  });
});
