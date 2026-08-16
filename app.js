import {
  ARENAS,
  CRASH_MSG,
  DIFFICULTIES,
  GRID_W,
  createGame,
  getOutcome,
  nextRound,
  riderById,
  step,
  summarize,
  turn,
} from "./game.js";
import { GameAudio } from "./audio.js";
import { loadProgress, saveProgress } from "./persist.js";

const $ = (q) => document.querySelector(q);
const audio = new GameAudio();

const KEY_TO_DIR = {
  ArrowUp: "N", ArrowDown: "S", ArrowLeft: "W", ArrowRight: "E",
  w: "N", s: "S", a: "W", d: "E", W: "N", S: "S", A: "W", D: "E",
};

const HEAD_ANGLE = { E: 0, S: Math.PI / 2, W: Math.PI, N: -Math.PI / 2 };
const READY_MS = 1560;

const board = $("#stage");
const ctx = board.getContext("2d");

let progress = {
  best: { survival: 0, territory: 0 },
  mode: "survival",
  difficulty: "normal",
  rivals: 1,
  muted: false,
};
let mode = "survival";
let difficulty = "normal";
let rivals = 1;

let state = null;
let running = false;
let paused = false;
let ready = false;
let readyLeft = 0;
let acc = 0;
let tickPart = 0;
let lastFrame = 0;
let clock = 0;
let shake = 0;
let particles = [];

let size = 360;
let cell = 12;
let ground = null;
let groundKey = "";
let wall = null;
let committed = [];

/* ── 尺寸與底圖 ───────────────────────────────────────── */

function dpr() {
  return Math.min(devicePixelRatio || 1, 2);
}

function layer() {
  const canvas = document.createElement("canvas");
  const ratio = dpr();
  canvas.width = Math.round(size * ratio);
  canvas.height = Math.round(size * ratio);
  const c = canvas.getContext("2d");
  c.setTransform(ratio, 0, 0, ratio, 0, 0);
  return { canvas, c };
}

function resize() {
  const ratio = dpr();
  const width = Math.max(220, Math.round(board.getBoundingClientRect().width));
  if (board.width !== Math.round(width * ratio)) {
    board.width = Math.round(width * ratio);
    board.height = Math.round(width * ratio);
    board.style.height = `${width}px`;
    ground = null;
    wall = null;
  }
  size = width;
  cell = width / GRID_W;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
}

const px = (v) => (v + 0.5) * cell;

/** 場地底圖只在尺寸或場地變動時重畫，之後每幀貼上去就好。 */
function buildGround() {
  const wanted = `${Math.round(size)}:${state ? state.arena : -1}`;
  if (ground && groundKey === wanted) return;
  groundKey = wanted;
  const { canvas, c } = layer();
  ground = canvas;

  c.fillStyle = "#04070f";
  c.fillRect(0, 0, size, size);

  const halo = c.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size * 0.72);
  halo.addColorStop(0, "rgba(24, 78, 122, 0.42)");
  halo.addColorStop(1, "rgba(2, 5, 12, 0)");
  c.fillStyle = halo;
  c.fillRect(0, 0, size, size);

  c.strokeStyle = "rgba(80, 200, 255, 0.13)";
  c.lineWidth = 1;
  for (let i = 1; i < GRID_W; i += 1) {
    const p = Math.round(i * cell) + 0.5;
    c.beginPath();
    c.moveTo(p, 0);
    c.lineTo(p, size);
    c.stroke();
    c.beginPath();
    c.moveTo(0, p);
    c.lineTo(size, p);
    c.stroke();
  }

  c.strokeStyle = "rgba(120, 230, 255, 0.55)";
  c.lineWidth = Math.max(2, cell * 0.18);
  c.strokeRect(c.lineWidth / 2, c.lineWidth / 2, size - c.lineWidth, size - c.lineWidth);

  for (const p of ARENAS[state.arena].pillars) {
    const x = p.x * cell;
    const y = p.y * cell;
    c.fillStyle = "rgba(16, 34, 56, 0.95)";
    c.fillRect(x, y, cell, cell);
    c.strokeStyle = "rgba(150, 235, 255, 0.5)";
    c.lineWidth = Math.max(1, cell * 0.1);
    c.strokeRect(x + c.lineWidth / 2, y + c.lineWidth / 2, cell - c.lineWidth, cell - c.lineWidth);
  }
}

/* ── 光牆圖層：只在有新格子時補畫，不每幀重來 ─────────── */

function segment(c, color, from, to, alpha = 1) {
  c.save();
  c.globalCompositeOperation = "lighter";
  c.lineCap = "square";
  c.lineJoin = "round";
  for (const [width, fade, tint] of [
    [cell * 1.5, 0.12 * alpha, color],
    [cell * 0.66, 0.5 * alpha, color],
    [cell * 0.24, 0.85 * alpha, "#ffffff"],
  ]) {
    c.strokeStyle = tint;
    c.globalAlpha = fade;
    c.lineWidth = width;
    c.beginPath();
    c.moveTo(px(from.x), px(from.y));
    c.lineTo(px(to.x), px(to.y));
    c.stroke();
  }
  c.restore();
}

function rebuildWall() {
  const built = layer();
  wall = built.canvas;
  committed = state.riders.map(() => 0);
  commitWall();
}

/** 最後一段留在主畫布上跟著頭內插，其餘全部烙進光牆圖層。 */
function commitWall() {
  if (!wall) return;
  const c = wall.getContext("2d");
  state.riders.forEach((r, i) => {
    const limit = r.alive ? r.trail.length - 2 : r.trail.length - 1;
    while (committed[i] < limit) {
      segment(c, r.color, r.trail[committed[i]], r.trail[committed[i] + 1]);
      committed[i] += 1;
    }
  });
}

/* ── 光車 ─────────────────────────────────────────────── */

function headPos(rider) {
  const cur = rider.trail.at(-1);
  const prev = rider.trail.at(-2) ?? cur;
  const t = rider.alive && !ready ? tickPart : 1;
  return { x: prev.x + (cur.x - prev.x) * t, y: prev.y + (cur.y - prev.y) * t };
}

function drawRider(rider) {
  const head = headPos(rider);
  const hx = px(head.x);
  const hy = px(head.y);

  if (rider.alive) {
    const tail = rider.trail.at(-2);
    if (tail) segment(ctx, rider.color, tail, head);
  }

  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  const glow = ctx.createRadialGradient(hx, hy, 0, hx, hy, cell * 2.4);
  glow.addColorStop(0, rider.alive ? rider.color : "rgba(255,120,80,0.9)");
  glow.addColorStop(1, "rgba(0,0,0,0)");
  ctx.globalAlpha = rider.alive ? 0.5 : 0.2;
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(hx, hy, cell * 2.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  if (!rider.alive) return;

  ctx.save();
  ctx.translate(hx, hy);
  ctx.rotate(HEAD_ANGLE[rider.dir] ?? 0);
  const long = cell * 1.5;
  const wide = cell * 0.78;
  ctx.fillStyle = rider.color;
  ctx.beginPath();
  ctx.moveTo(long * 0.5, 0);
  ctx.lineTo(-long * 0.34, -wide / 2);
  ctx.lineTo(-long * 0.2, 0);
  ctx.lineTo(-long * 0.34, wide / 2);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.arc(long * 0.12, 0, Math.max(1, cell * 0.16), 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/* ── 粒子 ─────────────────────────────────────────────── */

function burst(x, y, color) {
  for (let i = 0; i < 26; i += 1) {
    const a = (Math.PI * 2 * i) / 26 + Math.random();
    const speed = cell * (0.03 + Math.random() * 0.07);
    particles.push({
      x: px(x), y: px(y),
      vx: Math.cos(a) * speed, vy: Math.sin(a) * speed,
      life: 1, ttl: 460 + Math.random() * 380,
      size: cell * (0.18 + Math.random() * 0.35),
      color,
    });
  }
  if (particles.length > 300) particles = particles.slice(-300);
}

function updateParticles(dt) {
  for (const p of particles) {
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.vx *= 0.93;
    p.vy *= 0.93;
    p.life -= dt / p.ttl;
  }
  particles = particles.filter((p) => p.life > 0);
}

function drawParticles() {
  if (!particles.length) return;
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  for (const p of particles) {
    ctx.globalAlpha = Math.max(0, p.life) * 0.85;
    ctx.fillStyle = p.color;
    const s = p.size * (0.5 + p.life);
    ctx.fillRect(p.x - s / 2, p.y - s / 2, s, s);
  }
  ctx.restore();
}

/* ── 畫面 ─────────────────────────────────────────────── */

function banner(title, sub) {
  ctx.save();
  ctx.fillStyle = "rgba(3, 8, 18, 0.66)";
  ctx.fillRect(0, size * 0.34, size, size * 0.3);
  ctx.textAlign = "center";
  ctx.fillStyle = "#8ef1ff";
  ctx.font = `700 ${Math.round(size * 0.11)}px "Noto Sans TC", system-ui, sans-serif`;
  ctx.fillText(title, size / 2, size / 2 + size * 0.02);
  if (sub) {
    ctx.fillStyle = "#93a7c9";
    ctx.font = `${Math.round(size * 0.04)}px "Noto Sans TC", system-ui, sans-serif`;
    ctx.fillText(sub, size / 2, size * 0.585);
  }
  ctx.restore();
}

function draw() {
  if (!state) return;
  resize();
  buildGround();
  if (!wall) rebuildWall();

  ctx.clearRect(0, 0, size, size);
  ctx.save();
  if (shake > 0) {
    ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);
    shake *= 0.85;
    if (shake < 0.4) shake = 0;
  }
  ctx.drawImage(ground, 0, 0, size, size);
  ctx.drawImage(wall, 0, 0, size, size);
  for (const rider of state.riders) drawRider(rider);
  drawParticles();
  ctx.restore();

  if (ready) {
    const count = Math.max(1, Math.ceil(readyLeft / 520));
    banner(String(count), `第 ${state.round} 回合 · ${ARENAS[state.arena].name}`);
  } else if (paused && getOutcome(state) === "playing" && !state.roundOver) {
    banner("暫停", "再按一次繼續");
  }
}

/* ── 迴圈 ─────────────────────────────────────────────── */

function advance() {
  state = step(state);
  commitWall();
  for (const e of state.events) {
    if (e.type === "crash") {
      const rider = riderById(state, e.id);
      burst(e.x, e.y, rider.color);
      shake = Math.max(shake, cell * (e.id === 0 ? 1.1 : 0.7));
      audio.play(e.id === 0 ? "crash" : "kill", { volume: e.id === 0 ? 0.6 : 0.45 });
    } else if (e.type === "round") {
      audio.play("round", { volume: 0.45 });
    } else if (e.type === "match") {
      audio.play(e.outcome === "won" ? "win" : "lose", { volume: 0.6 });
    }
  }
  renderHud();
  setMessage();
  if (state.roundOver) void finishRound();
}

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.max(0, Math.min(120, lastFrame ? now - lastFrame : 16));
  lastFrame = now;
  clock += dt;

  if (running && !paused && state) {
    if (ready) {
      readyLeft -= dt;
      if (readyLeft <= 0) {
        ready = false;
        acc = 0;
      }
    } else if (!state.roundOver && getOutcome(state) === "playing") {
      acc += dt;
      let guard = 4;
      while (acc >= state.tickMs && guard > 0 && !state.roundOver && getOutcome(state) === "playing") {
        acc -= state.tickMs;
        guard -= 1;
        advance();
      }
      tickPart = state.roundOver ? 1 : Math.min(1, acc / state.tickMs);
    }
  }
  updateParticles(dt);
  draw();
}

/* ── HUD ──────────────────────────────────────────────── */

function chip(label, value, sub = "", tone = "") {
  return `<div class="chip ${tone}"><b>${label}</b><span>${value}</span>${sub ? `<i>${sub}</i>` : ""}</div>`;
}

function renderHud() {
  const v = summarize(state);
  const best = progress.best[state.mode] ?? 0;
  const wins = v.standings.map((r) => r.wins).join(" · ");
  $("#hud").innerHTML = [
    v.mode === "survival"
      ? chip("回合", `第 ${v.round} 回合`, v.arena)
      : chip("倒數", `${Math.ceil((v.ticksLeft * v.tickMs) / 1000)}s`, v.arena),
    v.mode === "survival"
      ? chip("勝場", wins, `${v.roundTarget} 勝制`)
      : chip("佔格", `${v.claimed}/${v.claimTarget}`, `已跑 ${v.tick} 格`, v.claimed > v.claimTarget * 0.7 ? "good" : ""),
    chip("擊墜", v.kills, `存活 ${v.aliveCount}`, v.alive ? "" : "bad"),
    chip("分數", v.score, `最佳 ${best}`, v.score > best ? "good" : ""),
  ].join("");

  $("#riders").innerHTML = v.standings
    .map(
      (r) => `<div class="rider ${r.alive ? "" : "down"}">
        <i style="--tint:${r.color}"></i>
        <b>${r.name}</b>
        <span>${state.mode === "survival" ? `${r.wins} 勝` : `${r.claimed} 格`}</span>
      </div>`,
    )
    .join("");
}

function setMessage() {
  const v = summarize(state);
  const el = $("#msg");
  el.textContent = v.msg;
  el.className = `msg ${v.outcome === "won" ? "good" : v.outcome === "lost" ? "bad" : ""}`;
}

/* ── 頁內確認（不使用瀏覽器原生 dialog） ───────────────── */

let confirmResolve = null;

function askConfirm({ title, body, okLabel = "確定", cancelLabel = "取消" }) {
  $("#confirm-title").textContent = title;
  $("#confirm-body").textContent = body;
  $("#confirm-ok").textContent = okLabel;
  $("#confirm-cancel").textContent = cancelLabel;
  $("#confirm").hidden = false;
  $("#confirm-cancel").focus();
  return new Promise((resolve) => {
    confirmResolve = resolve;
  });
}

function closeConfirm(answer) {
  $("#confirm").hidden = true;
  const resolve = confirmResolve;
  confirmResolve = null;
  if (resolve) resolve(answer);
}

$("#confirm-ok").onclick = () => closeConfirm(true);
$("#confirm-cancel").onclick = () => closeConfirm(false);
$("#confirm").onclick = (e) => {
  if (e.target === $("#confirm")) closeConfirm(false);
};

/* ── 操作 ─────────────────────────────────────────────── */

function flashPad(dirKey) {
  const btn = document.querySelector(`.pad-btn[data-dir="${dirKey}"]`);
  if (!btn) return;
  btn.classList.add("lit");
  setTimeout(() => btn.classList.remove("lit"), 110);
}

function input(dirKey) {
  if (!running || paused || !state || state.roundOver || getOutcome(state) !== "playing") return;
  if (ready) {
    ready = false;
    acc = 0;
  }
  const next = turn(state, dirKey);
  if (next === state) return;
  state = next;
  flashPad(dirKey);
  audio.play("turn", { volume: 0.2 });
}

function setPaused(on) {
  if (!running || !state || state.roundOver || getOutcome(state) !== "playing") return;
  paused = on;
  acc = 0;
  audio.duck(on);
  $("#pause").setAttribute("aria-pressed", String(on));
  $("#pause").textContent = on ? "▶" : "॥";
}

for (const btn of document.querySelectorAll(".pad-btn[data-dir]")) {
  btn.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    input(btn.dataset.dir);
  });
}

$("#pause").onclick = () => setPaused(!paused);

document.addEventListener("keydown", (e) => {
  if ($("#game").hidden || !$("#confirm").hidden || !$("#overlay").hidden) return;
  if (e.key === " ") {
    e.preventDefault();
    setPaused(!paused);
    return;
  }
  const dirKey = KEY_TO_DIR[e.key];
  if (!dirKey) return;
  e.preventDefault();
  input(dirKey);
});

let swipeFrom = null;
board.addEventListener("pointerdown", (e) => {
  swipeFrom = { x: e.clientX, y: e.clientY };
});
board.addEventListener("pointerup", (e) => {
  if (!swipeFrom) return;
  const dx = e.clientX - swipeFrom.x;
  const dy = e.clientY - swipeFrom.y;
  swipeFrom = null;
  if (Math.abs(dx) < 16 && Math.abs(dy) < 16) return;
  input(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "E" : "W") : dy > 0 ? "S" : "N");
});
board.addEventListener("pointercancel", () => {
  swipeFrom = null;
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden) setPaused(true);
});
addEventListener("blur", () => setPaused(true));
addEventListener("resize", () => {
  ground = null;
  wall = null;
});

/* ── 回合與比賽結束 ───────────────────────────────────── */

const ROUND_COPY = {
  survive: "最後一台車還在跑。",
  mutual: "兩台車同時爆掉，這回合不算。",
  claim: "地盤先佔滿。",
  time: "時間到，比佔格。",
  wiped: "全員出局，比佔格。",
  out: "你出局了，直接結算。",
};

function overlayButton(label, className, onClick) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = className;
  btn.textContent = label;
  btn.onclick = onClick;
  return btn;
}

async function finishRound() {
  running = false;
  tickPart = 1;
  commitWall();
  const v = summarize(state);
  const over = v.outcome !== "playing";
  const you = v.standings[0];

  if (over) {
    progress.best[state.mode] = Math.max(progress.best[state.mode] ?? 0, v.score);
    await saveProgress(progress);
  }

  const yourDeath = you.deathReason ? CRASH_MSG[you.deathReason] : null;
  const title = over
    ? v.outcome === "won"
      ? "光網歸你"
      : v.outcome === "draw"
        ? "平手"
        : "你被抹掉了"
    : v.roundWinner === 0
      ? `第 ${v.round} 回合 · 你贏了`
      : v.roundWinner === null
        ? `第 ${v.round} 回合 · 同歸於盡`
        : `第 ${v.round} 回合 · ${v.standings[v.roundWinner].name}贏了`;

  $("#overlay-title").textContent = title;
  $("#overlay-body").textContent = [yourDeath, ROUND_COPY[v.roundReason] ?? ""].filter(Boolean).join(" ");
  $("#overlay-stats").innerHTML = [
    ["模式", `${v.modeName} · ${v.difficultyName}`],
    ...v.standings.map((r) => [
      r.name,
      state.mode === "survival" ? `${r.wins} 勝 · ${r.claimed} 格` : `${r.claimed} 格`,
    ]),
    ["分數", v.score],
    ["本機最佳", progress.best[state.mode] ?? 0],
  ]
    .map(([k, val]) => `<li><span>${k}</span><b>${val}</b></li>`)
    .join("");

  const actions = $("#overlay-actions");
  actions.innerHTML = "";
  if (over) {
    actions.append(
      overlayButton("再來一場", "primary", () => {
        $("#overlay").hidden = true;
        newMatch();
      }),
      overlayButton("回大廳", "ghost", () => {
        $("#overlay").hidden = true;
        toLobby();
      }),
    );
  } else {
    actions.append(
      overlayButton("下一回合", "primary", () => {
        $("#overlay").hidden = true;
        state = nextRound(state);
        startRound();
      }),
      overlayButton("回大廳", "ghost", () => {
        $("#overlay").hidden = true;
        toLobby();
      }),
    );
  }
  $("#overlay").hidden = false;
  actions.firstChild.focus();
}

/* ── 場次 ─────────────────────────────────────────────── */

function startRound() {
  particles = [];
  shake = 0;
  ground = null;
  wall = null;
  running = true;
  paused = false;
  ready = true;
  readyLeft = READY_MS;
  acc = 0;
  tickPart = 0;
  $("#pause").setAttribute("aria-pressed", "false");
  $("#pause").textContent = "॥";
  audio.play("ready", { volume: 0.4 });
  renderHud();
  setMessage();
  draw();
}

function newMatch() {
  state = createGame({ mode, difficulty, rivals, seed: Date.now() % 99991 });
  startRound();
}

function enterGame() {
  $("#lobby").hidden = true;
  $("#game").hidden = false;
  newMatch();
}

function toLobby() {
  running = false;
  $("#game").hidden = true;
  $("#lobby").hidden = false;
  renderLobby();
}

$("#quit").onclick = async () => {
  const wasPaused = paused;
  setPaused(true);
  const ok = await askConfirm({
    title: "離開這場對決？",
    body: "這一場的比分不會列入紀錄，最佳成績仍然保留。",
    okLabel: "離開",
    cancelLabel: "繼續玩",
  });
  if (!ok) {
    if (!wasPaused) setPaused(false);
    return;
  }
  toLobby();
};

/* ── 大廳 ─────────────────────────────────────────────── */

function pickRow(container, items, current, onPick) {
  container.innerHTML = "";
  for (const item of items) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.setAttribute("role", "radio");
    btn.setAttribute("aria-checked", String(item.value === current));
    btn.innerHTML = `${item.label}<i>${item.hint}</i>`;
    btn.onclick = () => {
      audio.play("click", { volume: 0.3 });
      onPick(item.value);
      renderLobby();
    };
    container.append(btn);
  }
}

function renderLobby() {
  for (const btn of document.querySelectorAll("#mode-pick button")) {
    btn.setAttribute("aria-checked", String(btn.dataset.mode === mode));
  }
  pickRow(
    $("#diff-pick"),
    Object.entries(DIFFICULTIES).map(([value, d]) => ({
      value,
      label: d.name,
      hint: `${(1000 / d.tickMs).toFixed(1)} 格/秒`,
    })),
    difficulty,
    (v) => {
      difficulty = v;
      progress.difficulty = v;
      void saveProgress(progress);
    },
  );
  pickRow(
    $("#rival-pick"),
    [
      { value: 1, label: "1 台", hint: "單挑" },
      { value: 2, label: "2 台", hint: "混戰" },
      { value: 3, label: "3 台", hint: "全場亂鬥" },
    ],
    rivals,
    (v) => {
      rivals = v;
      progress.rivals = v;
      void saveProgress(progress);
    },
  );
  $("#best-survival").textContent = progress.best.survival ?? 0;
  $("#best-territory").textContent = progress.best.territory ?? 0;
}

for (const btn of document.querySelectorAll("#mode-pick button")) {
  btn.onclick = () => {
    mode = btn.dataset.mode;
    progress.mode = mode;
    audio.play("click", { volume: 0.3 });
    void saveProgress(progress);
    renderLobby();
  };
}

$("#start").onclick = async () => {
  await audio.start();
  audio.setEnabled(!progress.muted);
  enterGame();
};

$("#sound").onclick = () => {
  const on = $("#sound").getAttribute("aria-pressed") !== "true";
  $("#sound").setAttribute("aria-pressed", String(on));
  $("#sound").textContent = on ? "♫ 音效" : "♪ 靜音";
  audio.setEnabled(on);
  progress.muted = !on;
  void saveProgress(progress);
};

/* ── 啟動 ─────────────────────────────────────────────── */

async function boot() {
  const saved = await loadProgress();
  progress = {
    best: { survival: 0, territory: 0, ...(saved.best ?? {}) },
    mode: saved.mode === "territory" ? "territory" : "survival",
    difficulty: DIFFICULTIES[saved.difficulty] ? saved.difficulty : "normal",
    rivals: [1, 2, 3].includes(saved.rivals) ? saved.rivals : 1,
    muted: !!saved.muted,
  };
  mode = progress.mode;
  difficulty = progress.difficulty;
  rivals = progress.rivals;
  if (progress.muted) {
    $("#sound").setAttribute("aria-pressed", "false");
    $("#sound").textContent = "♪ 靜音";
    audio.setEnabled(false);
  }
  renderLobby();
  requestAnimationFrame(frame);
}

void boot();
