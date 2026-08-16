// 光跡對決 — 純邏輯層（無 DOM）。
// 座標 {x, y}：x 向右、y 向下。每個騎手每 tick 走一格，走過的格子永久變成光牆。
// state 全是可 JSON 化的值，可以直接丟進 /api/kv 再讀回來。

export const GRID_W = 29;
export const GRID_H = 29;

export const DIRS = {
  N: { x: 0, y: -1 },
  S: { x: 0, y: 1 },
  W: { x: -1, y: 0 },
  E: { x: 1, y: 0 },
};

export const OPPOSITE = { N: "S", S: "N", E: "W", W: "E" };

/** grid 的值：0 空地、-1 場地立柱、n>0 表示第 n-1 號騎手的光牆。 */
export const EMPTY = 0;
export const PILLAR = -1;

/** 轉向緩衝：手比車快的時候，最多先記兩個轉彎。 */
export const MAX_QUEUE = 2;

/** 生存模式打幾勝。 */
export const ROUND_TARGET = 3;

/** 佔格模式：跑滿這麼多 tick 就結算，或先佔到空地的這個比例直接贏。 */
export const TERRITORY_TICKS = 240;
export const TERRITORY_SHARE = 0.22;

export const SURVIVE_SCORE = 300;
export const CLAIM_SCORE = 4;
export const KILL_SCORE = 120;
export const MATCH_BONUS = 500;

export const RIDERS = [
  { name: "你", color: "#38e8ff", kind: "human" },
  { name: "赤影", color: "#ff5470", kind: "ai" },
  { name: "紫電", color: "#c46bff", kind: "ai" },
  { name: "黃燐", color: "#ffd166", kind: "ai" },
];

export const DIFFICULTIES = {
  easy: { name: "見習", tickMs: 132, skill: 1 },
  normal: { name: "標準", tickMs: 112, skill: 2 },
  hard: { name: "光刃", tickMs: 94, skill: 3 },
};

export const CRASH_MSG = {
  wall: "撞上場地邊界。",
  pillar: "撞上光柱。",
  self: "撞上自己的光牆。",
  trail: "撞上對手的光牆。",
  headon: "兩台車對撞。",
};

/* ── 場地 ─────────────────────────────────────────────── */

function box(x0, y0, x1, y1) {
  const out = [];
  for (let y = y0; y <= y1; y += 1) for (let x = x0; x <= x1; x += 1) out.push({ x, y });
  return out;
}

const mid = Math.floor(GRID_W / 2);

export const ARENAS = [
  { name: "空場", pillars: [] },
  {
    name: "四立柱",
    pillars: [
      ...box(7, 7, 8, 8), ...box(20, 7, 21, 8),
      ...box(7, 20, 8, 21), ...box(20, 20, 21, 21),
    ],
  },
  {
    name: "中央核心",
    pillars: [
      ...box(mid - 3, mid - 3, mid + 3, mid - 3),
      ...box(mid - 3, mid + 3, mid + 3, mid + 3),
      ...box(mid - 3, mid - 2, mid - 3, mid - 1),
      ...box(mid + 3, mid - 2, mid + 3, mid - 1),
      ...box(mid - 3, mid + 1, mid - 3, mid + 2),
      ...box(mid + 3, mid + 1, mid + 3, mid + 2),
    ],
  },
  {
    name: "光廊",
    pillars: [
      ...box(9, 3, 9, 11), ...box(19, 3, 19, 11),
      ...box(9, 17, 9, 25), ...box(19, 17, 19, 25),
      ...box(3, 14, 25, 14).filter((c) => c.x < 11 || c.x > 17),
    ],
  },
];

/* ── 小工具 ───────────────────────────────────────────── */

const clone = (s) => structuredClone(s);
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

export function idx(x, y) {
  return y * GRID_W + x;
}

export function inBounds(x, y) {
  return x >= 0 && y >= 0 && x < GRID_W && y < GRID_H;
}

export function cellAt(state, x, y) {
  if (!inBounds(x, y)) return PILLAR;
  return state.grid[idx(x, y)];
}

export function isFree(state, x, y) {
  return inBounds(x, y) && state.grid[idx(x, y)] === EMPTY;
}

export function riderById(state, id) {
  return state.riders.find((r) => r.id === id) ?? null;
}

export function aliveRiders(state) {
  return state.riders.filter((r) => r.alive);
}

/** 從 start 走得到的空格數（不含 start 本身，start 可以是還沒踩下去的格子）。 */
export function openSpace(state, start, cap = GRID_W * GRID_H) {
  if (!inBounds(start.x, start.y) || state.grid[idx(start.x, start.y)] !== EMPTY) return 0;
  const seen = new Uint8Array(GRID_W * GRID_H);
  const queue = [start];
  seen[idx(start.x, start.y)] = 1;
  let count = 0;
  for (let i = 0; i < queue.length && count < cap; i += 1) {
    const cell = queue[i];
    count += 1;
    for (const d of Object.values(DIRS)) {
      const nx = cell.x + d.x;
      const ny = cell.y + d.y;
      if (!inBounds(nx, ny)) continue;
      const at = idx(nx, ny);
      if (seen[at] || state.grid[at] !== EMPTY) continue;
      seen[at] = 1;
      queue.push({ x: nx, y: ny });
    }
  }
  return count;
}

/**
 * 多源 BFS：從每台車的頭同時擴散，回傳 me 比所有人都先到的格子數。
 * 這是光循環 AI 的經典「地盤」估值。
 */
export function territoryEdge(state, heads, meIndex) {
  const dist = new Int16Array(GRID_W * GRID_H).fill(-1);
  const owner = new Int16Array(GRID_W * GRID_H).fill(-1);
  const queue = [];
  heads.forEach((h, i) => {
    if (!inBounds(h.x, h.y)) return;
    const at = idx(h.x, h.y);
    if (dist[at] !== -1) {
      if (owner[at] !== i) owner[at] = -2;
      return;
    }
    dist[at] = 0;
    owner[at] = i;
    queue.push({ x: h.x, y: h.y });
  });

  for (let i = 0; i < queue.length; i += 1) {
    const cell = queue[i];
    const from = idx(cell.x, cell.y);
    for (const d of Object.values(DIRS)) {
      const nx = cell.x + d.x;
      const ny = cell.y + d.y;
      if (!inBounds(nx, ny)) continue;
      const at = idx(nx, ny);
      if (state.grid[at] !== EMPTY) continue;
      if (dist[at] === -1) {
        dist[at] = dist[from] + 1;
        owner[at] = owner[from];
        queue.push({ x: nx, y: ny });
      } else if (dist[at] === dist[from] + 1 && owner[at] !== owner[from]) {
        owner[at] = -2; // 同時抵達 → 不算任何人的
      }
    }
  }

  let mine = 0;
  for (let i = 0; i < owner.length; i += 1) if (owner[i] === meIndex) mine += 1;
  return mine;
}

/* ── 亂數：seed 存在 state 裡，同一顆 seed 永遠重現同一局 ─── */

function advance(seed) {
  let t = (seed + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return (t ^ (t >>> 14)) >>> 0;
}

function draw(state) {
  state.rng = advance(state.rng);
  return state.rng / 4294967296;
}

/* ── 開局 ─────────────────────────────────────────────── */

const SPAWNS = [
  { x: 3, y: mid, dir: "E" },
  { x: GRID_W - 4, y: mid, dir: "W" },
  { x: mid, y: 3, dir: "S" },
  { x: mid, y: GRID_H - 4, dir: "N" },
];

function buildGrid(arenaIndex) {
  const grid = new Array(GRID_W * GRID_H).fill(EMPTY);
  for (const c of ARENAS[arenaIndex].pillars) {
    if (inBounds(c.x, c.y)) grid[idx(c.x, c.y)] = PILLAR;
  }
  return grid;
}

function spawnRiders(count) {
  return Array.from({ length: count }, (_, i) => {
    const spawn = SPAWNS[i];
    const meta = RIDERS[i];
    return {
      id: i,
      name: meta.name,
      color: meta.color,
      kind: meta.kind,
      x: spawn.x,
      y: spawn.y,
      dir: spawn.dir,
      alive: true,
      queue: [],
      trail: [{ x: spawn.x, y: spawn.y }],
      claimed: 1,
      kills: 0,
      roundWins: 0,
      score: 0,
      deathTick: null,
      deathReason: null,
    };
  });
}

function layout(state) {
  state.grid = buildGrid(state.arena);
  for (const r of state.riders) {
    const spawn = SPAWNS[r.id];
    r.x = spawn.x;
    r.y = spawn.y;
    r.dir = spawn.dir;
    r.alive = true;
    r.queue = [];
    r.trail = [{ x: spawn.x, y: spawn.y }];
    r.claimed = 1;
    r.deathTick = null;
    r.deathReason = null;
    state.grid[idx(r.x, r.y)] = r.id + 1;
  }
  state.openCells = state.grid.reduce((n, v) => n + (v === EMPTY ? 1 : 0), 0);
  state.claimTarget = Math.max(20, Math.round(state.openCells * TERRITORY_SHARE));
  return state;
}

export function createGame({
  mode = "survival",
  difficulty = "normal",
  rivals = 1,
  arena = 0,
  seed = 1,
} = {}) {
  const diff = DIFFICULTIES[difficulty] ? difficulty : "normal";
  const count = clamp(Math.trunc(rivals) || 1, 1, RIDERS.length - 1) + 1;
  const state = {
    mode: mode === "territory" ? "territory" : "survival",
    difficulty: diff,
    skill: DIFFICULTIES[diff].skill,
    tickMs: DIFFICULTIES[diff].tickMs,
    arena: clamp(Math.trunc(arena) || 0, 0, ARENAS.length - 1),
    width: GRID_W,
    height: GRID_H,
    seed,
    rng: (Math.abs(Math.trunc(seed)) >>> 0) || 1,
    grid: [],
    riders: spawnRiders(count),
    round: 1,
    roundTarget: mode === "territory" ? 1 : ROUND_TARGET,
    tickLimit: mode === "territory" ? TERRITORY_TICKS : 0,
    tick: 0,
    roundOver: false,
    roundWinner: null,
    roundReason: null,
    outcome: "playing",
    reason: null,
    events: [],
    msg: "",
  };
  layout(state);
  state.msg =
    state.mode === "territory"
      ? `佔滿 ${state.claimTarget} 格就贏。`
      : `${ROUND_TARGET} 勝制 · ${ARENAS[state.arena].name}`;
  return state;
}

/** 打完一回合後開下一局：場地換一張，比分留著。 */
export function nextRound(state) {
  if (state.outcome !== "playing" || !state.roundOver) return state;
  const s = clone(state);
  s.round += 1;
  s.arena = (s.arena + 1) % ARENAS.length;
  s.tick = 0;
  s.roundOver = false;
  s.roundWinner = null;
  s.roundReason = null;
  s.events = [];
  layout(s);
  s.msg = `第 ${s.round} 回合 · ${ARENAS[s.arena].name}`;
  return s;
}

/* ── 操作 ─────────────────────────────────────────────── */

/** 玩家轉向。不能瞬間反向，也不必重複記同一個方向。 */
export function turn(state, dirKey, riderId = 0) {
  if (state.outcome !== "playing" || state.roundOver || !DIRS[dirKey]) return state;
  const rider = riderById(state, riderId);
  if (!rider || !rider.alive) return state;
  const last = rider.queue.length ? rider.queue.at(-1) : rider.dir;
  if (dirKey === last || dirKey === OPPOSITE[last]) return state;
  if (rider.queue.length >= MAX_QUEUE) return state;
  return {
    ...state,
    riders: state.riders.map((r) => (r.id === riderId ? { ...r, queue: [...r.queue, dirKey] } : r)),
  };
}

/* ── AI ───────────────────────────────────────────────── */

/** 不能反向的三個候選方向。 */
export function candidateDirs(dir) {
  return Object.keys(DIRS).filter((d) => d !== OPPOSITE[dir]);
}

function neighbourWalls(state, x, y) {
  let n = 0;
  for (const d of Object.values(DIRS)) {
    if (!isFree(state, x + d.x, y + d.y)) n += 1;
  }
  return n;
}

/**
 * AI 選方向。skill 1 只看眼前空間，skill 2 加上完整空間，skill 3 再加地盤爭奪與對撞規避。
 * 決策只讀 state.grid，並就地推進 state.rng，所以同 seed 完全重現。
 */
export function decideDir(state, rider) {
  const options = candidateDirs(rider.dir);
  const safe = [];
  for (const dirKey of options) {
    const d = DIRS[dirKey];
    const next = { x: rider.x + d.x, y: rider.y + d.y };
    if (!isFree(state, next.x, next.y)) continue;
    safe.push({ dirKey, next });
  }
  if (!safe.length) return rider.dir;

  const rivals = state.riders.filter((r) => r.alive && r.id !== rider.id);
  const skill = state.skill ?? 2;
  const noise = skill === 1 ? 90 : skill === 2 ? 14 : 6;

  // 對手下一步也可能踏進的格子＝對撞。只要還有別條路，標準以上的 AI 就不賭。
  const clean = skill >= 2 ? safe.filter((o) => !rivals.some((r) => mayEnter(r, o.next))) : [];
  const pool = clean.length ? clean : safe;

  let best = null;
  for (const option of pool) {
    const cap = skill === 1 ? 26 : GRID_W * GRID_H;
    const space = openSpace(state, option.next, cap);
    let score = space;
    // 只剩一兩格的死巷，除非真的沒別條路，不然不要進去。
    if (space <= 2) score -= 60;

    if (skill >= 2) {
      // 貼著牆走比較省地。
      score += neighbourWalls(state, option.next.x, option.next.y) * 2.5;
      if (rider.dir === option.dirKey) score += 1.5;
    }

    if (skill >= 3) {
      const heads = [option.next, ...rivals.map((r) => ({ x: r.x, y: r.y }))];
      score += territoryEdge(state, heads, 0) * 0.85;
      for (const rival of rivals) {
        const gap = Math.abs(rival.x - option.next.x) + Math.abs(rival.y - option.next.y);
        if (gap >= 3 && gap <= 7) score += 8; // 壓迫對手，但不貼臉
      }
    }

    score += draw(state) * noise;
    if (!best || score > best.score) best = { score, dirKey: option.dirKey };
  }
  return best.dirKey;
}

/** 對手下一個 tick 有沒有可能踏進 cell。 */
function mayEnter(rival, cell) {
  return candidateDirs(rival.dir).some((dirKey) => {
    const d = DIRS[dirKey];
    return rival.x + d.x === cell.x && rival.y + d.y === cell.y;
  });
}

/* ── 推進一格 ─────────────────────────────────────────── */

function crash(state, rider, reason) {
  rider.alive = false;
  rider.deathTick = state.tick;
  rider.deathReason = reason;
  state.msg = rider.id === 0 ? CRASH_MSG[reason] : `${rider.name}${CRASH_MSG[reason]}`;
  state.events.push({ type: "crash", id: rider.id, reason, x: rider.x, y: rider.y });
}

/** 佔格最多的那些人（可能並列）。 */
export function leaders(state) {
  const max = Math.max(...state.riders.map((r) => r.claimed));
  return state.riders.filter((r) => r.claimed === max);
}

function endRound(state, winnerId, reason) {
  state.roundOver = true;
  state.roundWinner = winnerId;
  state.roundReason = reason;

  if (winnerId !== null) {
    const winner = riderById(state, winnerId);
    winner.roundWins += 1;
    winner.score += SURVIVE_SCORE;
  }
  for (const r of state.riders) r.score += r.claimed * CLAIM_SCORE;
  state.events.push({ type: "round", winner: winnerId, reason });

  const champion = state.riders.find((r) => r.roundWins >= state.roundTarget) ?? null;
  if (champion) {
    champion.score += MATCH_BONUS;
    // 0 號永遠是玩家。
    const yours = champion.id === 0;
    state.outcome = yours ? "won" : "lost";
    state.reason = reason;
    state.msg = yours
      ? state.mode === "territory"
        ? "地盤是你的了。"
        : `${state.roundTarget} 勝達成，光網歸你。`
      : `${champion.name}拿下勝場。`;
    state.events.push({ type: "match", winner: champion.id, outcome: state.outcome });
  } else if (winnerId === null && state.mode === "territory") {
    state.outcome = "draw";
    state.reason = reason;
    state.msg = "佔格打平。";
    state.events.push({ type: "match", winner: null, outcome: "draw" });
  } else {
    const winner = winnerId === null ? null : riderById(state, winnerId);
    state.msg = winner ? `${winner.name}拿下這回合。` : "同歸於盡，這回合不算。";
  }
  return state;
}

function settleTerritory(state, reason) {
  const top = leaders(state);
  if (top.length === 1) return endRound(state, top[0].id, reason);
  // 並列第一：玩家在裡面才算平手，否則這回合是對手的。
  return endRound(state, top.some((r) => r.id === 0) ? null : top[0].id, reason);
}

/** 走一格。畫面用固定 tick 呼叫這個函式，它是唯一推進時間的地方。 */
export function step(state) {
  if (state.outcome !== "playing" || state.roundOver) return state;
  const s = clone(state);
  s.events = [];
  s.tick += 1;

  for (const r of s.riders) {
    if (!r.alive) continue;
    if (r.kind === "human") {
      if (r.queue.length) {
        const next = r.queue.shift();
        if (next !== OPPOSITE[r.dir]) r.dir = next;
      }
    } else {
      r.dir = decideDir(s, r);
    }
  }

  const moves = new Map();
  const doomed = [];
  for (const r of s.riders) {
    if (!r.alive) continue;
    const d = DIRS[r.dir];
    const nx = r.x + d.x;
    const ny = r.y + d.y;
    if (!inBounds(nx, ny)) {
      doomed.push([r, "wall", null]);
      continue;
    }
    const value = s.grid[idx(nx, ny)];
    if (value === PILLAR) doomed.push([r, "pillar", null]);
    else if (value === r.id + 1) doomed.push([r, "self", null]);
    else if (value !== EMPTY) doomed.push([r, "trail", value - 1]);
    else moves.set(r.id, { x: nx, y: ny });
  }

  // 同一格被兩台車同時搶 → 對撞，兩邊都出局。
  const byCell = new Map();
  for (const [id, p] of moves) {
    const cellKey = `${p.x},${p.y}`;
    byCell.set(cellKey, [...(byCell.get(cellKey) ?? []), id]);
  }
  for (const ids of byCell.values()) {
    if (ids.length < 2) continue;
    for (const id of ids) {
      moves.delete(id);
      doomed.push([riderById(s, id), "headon", null]);
    }
  }

  for (const [id, p] of moves) {
    const r = riderById(s, id);
    r.x = p.x;
    r.y = p.y;
    r.trail.push({ x: p.x, y: p.y });
    r.claimed += 1;
    s.grid[idx(p.x, p.y)] = r.id + 1;
  }

  for (const [rider, reason, killerId] of doomed) {
    crash(s, rider, reason);
    if (killerId !== null && killerId !== rider.id) {
      const killer = riderById(s, killerId);
      if (killer) {
        killer.kills += 1;
        killer.score += KILL_SCORE;
      }
    }
  }

  const alive = aliveRiders(s);

  if (s.mode === "territory") {
    const top = leaders(s);
    if (top.length === 1 && top[0].alive && top[0].claimed >= s.claimTarget) {
      return endRound(s, top[0].id, "claim");
    }
    if (!alive.length) return settleTerritory(s, "wiped");
    if (s.tick >= s.tickLimit) return settleTerritory(s, "time");
    // 玩家出局就直接結算，不必看 AI 自己畫完。
    if (!riderById(s, 0).alive) return settleTerritory(s, "out");
    return s;
  }

  if (alive.length === 1) return endRound(s, alive[0].id, "survive");
  if (alive.length === 0) return endRound(s, null, "mutual");
  return s;
}

/* ── 輸出 ─────────────────────────────────────────────── */

export function summarize(state) {
  const you = riderById(state, 0);
  return {
    mode: state.mode,
    modeName: state.mode === "territory" ? "佔格爭霸" : "生存對決",
    difficulty: state.difficulty,
    difficultyName: DIFFICULTIES[state.difficulty].name,
    arena: ARENAS[state.arena].name,
    round: state.round,
    roundTarget: state.roundTarget,
    tick: state.tick,
    tickMs: state.tickMs,
    tickLimit: state.tickLimit,
    ticksLeft: state.tickLimit ? Math.max(0, state.tickLimit - state.tick) : null,
    claimTarget: state.mode === "territory" ? state.claimTarget : null,
    claimed: you.claimed,
    kills: you.kills,
    alive: you.alive,
    aliveCount: aliveRiders(state).length,
    wins: state.riders.map((r) => r.roundWins),
    standings: state.riders.map((r) => ({
      id: r.id,
      name: r.name,
      color: r.color,
      kind: r.kind,
      alive: r.alive,
      claimed: r.claimed,
      wins: r.roundWins,
      score: r.score,
      deathReason: r.deathReason,
    })),
    score: you.score,
    roundOver: state.roundOver,
    roundWinner: state.roundWinner,
    roundReason: state.roundReason,
    outcome: state.outcome,
    reason: state.reason,
    msg: state.msg,
  };
}

export function getOutcome(state) {
  return state.outcome;
}
