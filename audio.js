export class GameAudio {
  constructor() {
    this.enabled = true;
    this.started = false;
    this.music = new Audio("./assets/audio/music.ogg");
    this.music.loop = true;
    this.music.volume = 0.28;
    this.fx = {
      click: Object.assign(new Audio("./assets/audio/click.ogg"), { volume: 0.4 }),
      ok: Object.assign(new Audio("./assets/audio/ok.ogg"), { volume: 0.45 }),
      hit: Object.assign(new Audio("./assets/audio/hit.ogg"), { volume: 0.5 }),
      soft: Object.assign(new Audio("./assets/audio/soft.ogg"), { volume: 0.4 }),
      coin: Object.assign(new Audio("./assets/audio/coin.ogg"), { volume: 0.45 }),
    };
  }
  async start() {
    this.started = true;
    if (!this.enabled) return;
    try { await this.music.play(); } catch {}
  }
  setEnabled(on) {
    this.enabled = on;
    if (!on) this.music.pause();
    else if (this.started) void this.start();
  }
  play(name) {
    if (!this.enabled || !this.fx[name]) return;
    const a = this.fx[name];
    a.currentTime = 0;
    void a.play().catch(() => {});
  }
}
