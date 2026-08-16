import { describe, expect, it } from "vitest";
import { createGame, applyAction, getLegalActions, getOutcome, summarize } from "./game.js";

describe("pg-lighttrace",()=>{
  it("starts in a complete playable state",()=>{const s=createGame({seed:42});expect(getOutcome(s)).toBe("playing");expect(getLegalActions(s).length).toBeGreaterThanOrEqual(3);expect(summarize(s).msg).toBeTypeOf("string")});
  it("does not mutate the previous state",()=>{const s=createGame({seed:7}),before=structuredClone(s),next=applyAction(s,getLegalActions(s)[0]);expect(s).toEqual(before);expect(next).not.toBe(s)});
  it("keeps summaries renderable through a dozen turns",()=>{let s=createGame({seed:19});for(let i=0;i<12&&getOutcome(s)==="playing";i++){const actions=getLegalActions(s);s=applyAction(s,actions[i%actions.length]);const view=summarize(s);expect(view.outcome).toBe(getOutcome(s));expect(Number.isFinite(Number(view.score??0))).toBe(true)}});
  it("only reports supported outcomes",()=>{let s=createGame({seed:3});for(let i=0;i<80&&getOutcome(s)==="playing";i++){const a=getLegalActions(s);s=applyAction(s,a[i%a.length])}expect(["playing","won","lost"]).toContain(getOutcome(s))});
});
