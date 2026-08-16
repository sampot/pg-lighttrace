import { describe, expect, it } from "vitest";
import {
  ARENAS,
  CRASH_MSG,
  DIFFICULTIES,
  DIRS,
  EMPTY,
  GRID_H,
  GRID_W,
  MAX_QUEUE,
  OPPOSITE,
  PILLAR,
  ROUND_TARGET,
  aliveRiders,
  candidateDirs,
  cellAt,
  createGame,
  decideDir,
  getOutcome,
  idx,
  inBounds,
  isFree,
  leaders,
  nextRound,
  openSpace,
  riderById,
  step,
  summarize,
  territoryEdge,
  turn,
} from "./game.js";
import { loadProgress, saveProgress } from "./persist.js";

/** 把騎手挪到指定格，並清掉舊光跡，讓每個測試只留下自己關心的東西。 */
function place(state, id, x, y, dir) {
  const rider = riderById(state, id);
  for (const c of rider.trail) {
    if (state.grid[idx(c.x, c.y)] === id + 1) state.grid[idx(c.x, c.y)] = EMPTY;
  }
  rider.x = x;
  rider.y = y;
  rider.dir = dir;
  rider.queue = [];
  rider.trail = [{ x, y }];
  rider.claimed = 1;
  rider.alive = true;
  rider.deathReason = null;
  state.grid[idx(x, y)] = id + 1;
  return state;
}

/** 對手改成直線行駛（kind human 但沒有輸入），讓碰撞測試完全可預期。 */
function duel(options = {}) {
  const state = createGame({ rivals: 1, arena: 0, seed: 7, ...options });
  riderById(state, 1).kind = "human";
  place(state, 1, GRID_W - 4, GRID_H - 4, "N");
  place(state, 0, 5, 5, "E");
  return state;
}

function run(state, ticks) {
  let s = state;
  for (let i = 0; i < ticks && getOutcome(s) === "playing" && !s.roundOver; i += 1) s = step(s);
  return s;
}

describe("開局", () => {
  it("建立完整的格子地圖與兩名騎手", () => {
    const s = createGame();
    expect(s.grid).toHaveLength(GRID_W * GRID_H);
    expect(s.riders).toHaveLength(2);
    expect(s.riders[0].kind).toBe("human");
    expect(s.riders[1].kind).toBe("ai");
    expect(s.outcome).toBe("playing");
    expect(s.roundOver).toBe(false);
  });

  it("每名騎手開場就佔住自己的起點", () => {
    const s = createGame({ rivals: 3 });
    expect(s.riders).toHaveLength(4);
    const spots = new Set();
    for (const r of s.riders) {
      expect(cellAt(s, r.x, r.y)).toBe(r.id + 1);
      expect(r.trail).toEqual([{ x: r.x, y: r.y }]);
      expect(r.claimed).toBe(1);
      spots.add(`${r.x},${r.y}`);
    }
    expect(spots.size).toBe(4);
  });

  it("場地的光柱會寫進佔格地圖", () => {
    const s = createGame({ arena: 1 });
    const pillar = ARENAS[1].pillars[0];
    expect(cellAt(s, pillar.x, pillar.y)).toBe(PILLAR);
    expect(isFree(s, pillar.x, pillar.y)).toBe(false);
    expect(s.openCells).toBeLessThan(GRID_W * GRID_H);
  });

  it("難度決定節拍與 AI 強度", () => {
    expect(createGame({ difficulty: "easy" }).tickMs).toBe(DIFFICULTIES.easy.tickMs);
    expect(createGame({ difficulty: "hard" }).skill).toBe(DIFFICULTIES.hard.skill);
    expect(createGame({ difficulty: "??" }).difficulty).toBe("normal");
  });
});

describe("轉向", () => {
  it("方向鍵進入轉向佇列", () => {
    const s = turn(createGame(), "N");
    expect(riderById(s, 0).queue).toEqual(["N"]);
  });

  it("不能瞬間反向", () => {
    const base = createGame();
    expect(riderById(base, 0).dir).toBe("E");
    expect(turn(base, "W")).toBe(base);
  });

  it("已經朝這個方向就不用再排一次", () => {
    const base = createGame();
    expect(turn(base, "E")).toBe(base);
  });

  it("佇列裡的最後一個方向才是反向判斷基準", () => {
    let s = turn(createGame(), "N");
    expect(turn(s, "S")).toBe(s);
    s = turn(s, "W");
    expect(riderById(s, 0).queue).toEqual(["N", "W"]);
  });

  it("轉向佇列有長度上限", () => {
    let s = createGame();
    s = turn(s, "N");
    s = turn(s, "W");
    const full = turn(s, "S");
    expect(riderById(s, 0).queue).toHaveLength(MAX_QUEUE);
    expect(full).toBe(s);
  });

  it("出局或比賽結束後不再吃輸入", () => {
    const dead = createGame();
    riderById(dead, 0).alive = false;
    expect(turn(dead, "N")).toBe(dead);

    const over = createGame();
    over.outcome = "lost";
    expect(turn(over, "N")).toBe(over);
  });
});

describe("移動與光跡", () => {
  it("每個 tick 前進一格並留下永久光牆", () => {
    const s = step(duel());
    const you = riderById(s, 0);
    expect(you).toMatchObject({ x: 6, y: 5, claimed: 2 });
    expect(you.trail).toEqual([{ x: 5, y: 5 }, { x: 6, y: 5 }]);
    expect(cellAt(s, 5, 5)).toBe(1);
    expect(cellAt(s, 6, 5)).toBe(1);
    expect(s.tick).toBe(1);
  });

  it("佇列的轉向在下一個 tick 生效", () => {
    const s = step(turn(duel(), "S"));
    expect(riderById(s, 0)).toMatchObject({ x: 5, y: 6, dir: "S" });
    expect(riderById(s, 0).queue).toEqual([]);
  });

  it("直接塞進佇列的反向指令會被丟掉", () => {
    const base = duel();
    riderById(base, 0).queue = ["W"];
    const s = step(base);
    expect(riderById(s, 0)).toMatchObject({ x: 6, y: 5, dir: "E", alive: true });
  });

  it("兩名騎手的光跡分開記錄", () => {
    const s = run(duel(), 3);
    expect(riderById(s, 0).trail).toHaveLength(4);
    expect(riderById(s, 1).trail).toHaveLength(4);
    expect(cellAt(s, 7, 5)).toBe(1);
    expect(cellAt(s, GRID_W - 4, GRID_H - 6)).toBe(2);
  });
});

describe("碰撞", () => {
  it("撞上邊界出局", () => {
    const base = duel();
    place(base, 0, GRID_W - 1, 5, "E");
    const s = step(base);
    expect(riderById(s, 0)).toMatchObject({ alive: false, deathReason: "wall", x: GRID_W - 1 });
    expect(CRASH_MSG.wall).toBeTruthy();
  });

  it("撞上光柱出局", () => {
    const base = duel({ arena: 1 });
    const pillar = ARENAS[1].pillars[0];
    place(base, 0, pillar.x - 1, pillar.y, "E");
    const s = step(base);
    expect(riderById(s, 0).deathReason).toBe("pillar");
  });

  it("撞上自己的光牆出局", () => {
    const base = duel();
    base.grid[idx(6, 5)] = 1;
    const s = step(base);
    expect(riderById(s, 0)).toMatchObject({ alive: false, deathReason: "self" });
  });

  it("撞上對手的光牆出局，並算對手一個擊墜", () => {
    const base = duel();
    base.grid[idx(6, 5)] = 2;
    const s = step(base);
    expect(riderById(s, 0).deathReason).toBe("trail");
    expect(riderById(s, 1).kills).toBe(1);
  });

  it("兩台車搶同一格會對撞，兩邊都出局", () => {
    const base = duel();
    place(base, 0, 5, 10, "E");
    place(base, 1, 7, 10, "W");
    const s = step(base);
    expect(riderById(s, 0)).toMatchObject({ alive: false, deathReason: "headon", x: 5 });
    expect(riderById(s, 1)).toMatchObject({ alive: false, deathReason: "headon", x: 7 });
    expect(aliveRiders(s)).toHaveLength(0);
  });

  it("面對面互穿也算撞上對方的光牆", () => {
    const base = duel();
    place(base, 0, 5, 10, "E");
    place(base, 1, 6, 10, "W");
    const s = step(base);
    expect(riderById(s, 0).deathReason).toBe("trail");
    expect(riderById(s, 1).deathReason).toBe("trail");
  });

  it("出局的車不再移動，但佔住的格子仍然是牆", () => {
    const base = duel();
    place(base, 0, GRID_W - 1, 5, "E");
    const s = step(step(base));
    expect(riderById(s, 0).x).toBe(GRID_W - 1);
    expect(cellAt(s, GRID_W - 1, 5)).toBe(1);
  });
});

describe("AI 對手", () => {
  it("每個 tick 都會移動並留下自己的光跡", () => {
    const s = step(createGame({ seed: 12 }));
    const ai = riderById(s, 1);
    expect(ai.trail).toHaveLength(2);
    expect(ai.claimed).toBe(2);
    expect(cellAt(s, ai.x, ai.y)).toBe(2);
  });

  it("有活路的時候不會自己去撞死", () => {
    let s = createGame({ difficulty: "hard", seed: 3 });
    let ticks = 0;
    while (getOutcome(s) === "playing" && !s.roundOver && ticks < 60) {
      const ai = riderById(s, 1);
      const room = candidateDirs(ai.dir).some((d) => isFree(s, ai.x + DIRS[d].x, ai.y + DIRS[d].y));
      s = step(s);
      ticks += 1;
      if (!riderById(s, 1).alive) expect(room).toBe(false);
    }
    expect(ticks).toBeGreaterThan(5);
    expect(riderById(s, 1).alive).toBe(true);
  });

  it("兩台 AI 互相纏鬥也撐得住", () => {
    const base = createGame({ difficulty: "hard", seed: 11 });
    riderById(base, 0).kind = "ai";
    const s = run(base, 60);
    expect(s.tick).toBe(60);
    expect(aliveRiders(s)).toHaveLength(2);
    expect(riderById(s, 1).claimed).toBe(61);
  });

  it("不會瞬間反向", () => {
    let s = createGame({ seed: 21 });
    for (let i = 0; i < 30 && getOutcome(s) === "playing" && !s.roundOver; i += 1) {
      const before = riderById(s, 1).dir;
      s = step(s);
      expect(riderById(s, 1).dir).not.toBe(OPPOSITE[before]);
    }
  });

  it("只會挑非反向的方向", () => {
    expect(candidateDirs("E").sort()).toEqual(["E", "N", "S"]);
    const s = createGame({ seed: 5 });
    expect(candidateDirs(riderById(s, 1).dir)).not.toContain(OPPOSITE[riderById(s, 1).dir]);
  });

  it("三面全封死時維持原方向（等著撞）", () => {
    const s = createGame({ seed: 2 });
    place(s, 1, 10, 10, "E");
    s.grid[idx(11, 10)] = PILLAR;
    s.grid[idx(10, 9)] = PILLAR;
    s.grid[idx(10, 11)] = PILLAR;
    expect(decideDir(s, riderById(s, 1))).toBe("E");
  });

  it("看得到空間的時候會避開死巷", () => {
    const s = createGame({ difficulty: "hard", seed: 9 });
    place(s, 1, 10, 10, "E");
    // 東邊只剩兩格的死巷，北邊是整片空地。
    for (const y of [9, 11]) for (const x of [11, 12, 13]) s.grid[idx(x, y)] = PILLAR;
    s.grid[idx(13, 10)] = PILLAR;
    expect(decideDir(s, riderById(s, 1))).not.toBe("E");
  });
});

describe("空間估算", () => {
  it("openSpace 只算得到連通的空格", () => {
    const s = createGame();
    for (let x = 0; x < GRID_W; x += 1) s.grid[idx(x, 2)] = PILLAR;
    const above = openSpace(s, { x: 0, y: 0 });
    expect(above).toBe(GRID_W * 2);
    expect(openSpace(s, { x: 0, y: 2 })).toBe(0);
  });

  it("openSpace 可以設定上限，讓弱 AI 只看近處", () => {
    const s = createGame();
    expect(openSpace(s, { x: 14, y: 20 }, 12)).toBe(12);
  });

  it("territoryEdge 把場地切給比較近的那一邊", () => {
    const s = createGame();
    const heads = [{ x: 1, y: 14 }, { x: GRID_W - 2, y: 14 }];
    const mine = territoryEdge(s, heads, 0);
    const theirs = territoryEdge(s, heads, 1);
    expect(mine).toBeGreaterThan(100);
    expect(Math.abs(mine - theirs)).toBeLessThan(GRID_H * 2);
  });

  it("inBounds／isFree 認得邊界", () => {
    const s = createGame();
    expect(inBounds(-1, 0)).toBe(false);
    expect(inBounds(GRID_W, 0)).toBe(false);
    expect(inBounds(0, 0)).toBe(true);
    expect(isFree(s, s.riders[0].x, s.riders[0].y)).toBe(false);
  });
});

describe("生存對決", () => {
  it("對手全滅就贏下這一回合", () => {
    const base = duel();
    place(base, 1, GRID_W - 1, 5, "E");
    const s = step(base);
    expect(s.roundOver).toBe(true);
    expect(s.roundWinner).toBe(0);
    expect(s.roundReason).toBe("survive");
    expect(riderById(s, 0).roundWins).toBe(1);
    expect(riderById(s, 0).score).toBeGreaterThan(0);
    expect(s.outcome).toBe("playing");
  });

  it("玩家出局就把回合讓給對手，但比賽還沒結束", () => {
    const base = duel();
    place(base, 0, GRID_W - 1, 5, "E");
    const s = step(base);
    expect(s.roundWinner).toBe(1);
    expect(riderById(s, 1).roundWins).toBe(1);
    expect(s.outcome).toBe("playing");
  });

  it("同歸於盡不算任何人的勝場", () => {
    const base = duel();
    place(base, 0, 5, 10, "E");
    place(base, 1, 7, 10, "W");
    const s = step(base);
    expect(s.roundOver).toBe(true);
    expect(s.roundWinner).toBe(null);
    expect(s.roundReason).toBe("mutual");
    expect(s.riders.map((r) => r.roundWins)).toEqual([0, 0]);
  });

  it("先拿到三勝就贏下整場", () => {
    const base = duel();
    riderById(base, 0).roundWins = ROUND_TARGET - 1;
    place(base, 1, GRID_W - 1, 5, "E");
    const s = step(base);
    expect(s.outcome).toBe("won");
    expect(getOutcome(s)).toBe("won");
    expect(s.events.some((e) => e.type === "match")).toBe(true);
  });

  it("對手先拿到三勝就輸掉整場", () => {
    const base = duel();
    riderById(base, 1).roundWins = ROUND_TARGET - 1;
    place(base, 0, GRID_W - 1, 5, "E");
    const s = step(base);
    expect(s.outcome).toBe("lost");
    expect(s.msg).toContain(riderById(s, 1).name);
  });

  it("下一回合換場地、清光跡，比分留著", () => {
    const base = duel();
    place(base, 1, GRID_W - 1, 5, "E");
    const done = step(base);
    const s = nextRound(done);
    expect(s.round).toBe(2);
    expect(s.arena).not.toBe(done.arena);
    expect(s.tick).toBe(0);
    expect(s.roundOver).toBe(false);
    expect(riderById(s, 0).roundWins).toBe(1);
    expect(riderById(s, 0).trail).toHaveLength(1);
    expect(s.riders.every((r) => r.alive)).toBe(true);
  });

  it("回合還沒結束時 nextRound 不做事", () => {
    const s = duel();
    expect(nextRound(s)).toBe(s);
  });

  it("回合結束後 step 不再推進", () => {
    const base = duel();
    place(base, 1, GRID_W - 1, 5, "E");
    const done = step(base);
    expect(step(done)).toBe(done);
  });
});

describe("佔格爭霸", () => {
  it("佔滿目標格數直接贏", () => {
    const base = duel({ mode: "territory" });
    riderById(base, 0).claimed = base.claimTarget - 1;
    const s = step(base);
    expect(s.roundReason).toBe("claim");
    expect(s.outcome).toBe("won");
  });

  it("時間到就比誰佔得多", () => {
    const base = duel({ mode: "territory" });
    base.tick = base.tickLimit - 1;
    riderById(base, 0).claimed = 40;
    const s = step(base);
    expect(s.roundReason).toBe("time");
    expect(s.roundWinner).toBe(0);
    expect(s.outcome).toBe("won");
  });

  it("佔格一樣多就是平手", () => {
    const base = duel({ mode: "territory" });
    base.tick = base.tickLimit - 1;
    const s = step(base);
    expect(riderById(s, 0).claimed).toBe(riderById(s, 1).claimed);
    expect(s.roundWinner).toBe(null);
    expect(s.outcome).toBe("draw");
  });

  it("兩個對手並列第一，就是你輸了而不是平手", () => {
    const base = createGame({ mode: "territory", rivals: 2, seed: 5 });
    for (const r of base.riders) r.kind = "human";
    place(base, 0, GRID_W - 1, 5, "E");
    riderById(base, 1).claimed = 31;
    riderById(base, 2).claimed = 31;
    const s = step(base);
    expect(leaders(s).map((r) => r.id)).toEqual([1, 2]);
    expect(s.roundWinner).toBe(1);
    expect(s.outcome).toBe("lost");
  });

  it("玩家出局就立刻結算", () => {
    const base = duel({ mode: "territory" });
    place(base, 0, GRID_W - 1, 5, "E");
    riderById(base, 1).claimed = 40;
    const s = step(base);
    expect(s.roundReason).toBe("out");
    expect(s.outcome).toBe("lost");
  });
});

describe("輸出與存檔", () => {
  it("summarize 給得出畫面要的所有欄位", () => {
    const v = summarize(run(createGame({ mode: "territory", rivals: 2, seed: 4 }), 5));
    expect(v).toMatchObject({ mode: "territory", modeName: "佔格爭霸", tick: 5 });
    expect(v.standings).toHaveLength(3);
    expect(v.standings[0]).toHaveProperty("color");
    expect(v.claimTarget).toBeGreaterThan(0);
    expect(v.ticksLeft).toBe(v.tickLimit - 5);
    expect(typeof v.score).toBe("number");
  });

  it("同一顆 seed 重播出同一局", () => {
    const a = run(createGame({ seed: 99, difficulty: "hard", rivals: 2 }), 25);
    const b = run(createGame({ seed: 99, difficulty: "hard", rivals: 2 }), 25);
    expect(summarize(a)).toEqual(summarize(b));
    expect(a.grid).toEqual(b.grid);
  });

  it("不同 seed 會走出不一樣的局", () => {
    const a = run(createGame({ seed: 1, rivals: 2 }), 25);
    const b = run(createGame({ seed: 2024, rivals: 2 }), 25);
    expect(a.grid).not.toEqual(b.grid);
  });
});

describe("進度存檔", () => {
  it("讀得回剛存進去的最佳成績", async () => {
    const store = new Map();
    const fetcher = async (url, init) => {
      if (init?.method === "PUT") {
        store.set(url, init.body);
        return { ok: true, text: async () => "" };
      }
      return { ok: store.has(url), text: async () => store.get(url) ?? "" };
    };
    await saveProgress({ best: { survival: 1200 } }, fetcher);
    expect(await loadProgress(fetcher)).toEqual({ best: { survival: 1200 } });
    expect([...store.keys()][0]).toContain("/api/kv/pg-lighttrace");
  });

  it("讀不到或壞掉時回傳空物件", async () => {
    expect(await loadProgress(async () => ({ ok: false, text: async () => "" }))).toEqual({});
    expect(await loadProgress(async () => { throw new Error("offline"); })).toEqual({});
    expect(await saveProgress({ a: 1 }, async () => { throw new Error("offline"); })).toEqual({ a: 1 });
  });
});
