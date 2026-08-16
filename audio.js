const SFX = {
  turn: "./assets/audio/turn.ogg",
  boost: "./assets/audio/boost.ogg",
  crash: "./assets/audio/crash.ogg",
  kill: "./assets/audio/kill.ogg",
  ready: "./assets/audio/ready.ogg",
  round: "./assets/audio/round.ogg",
  win: "./assets/audio/win.ogg",
  lose: "./assets/audio/lose.ogg",
  click: "./assets/audio/click.ogg",
};

const MUSIC = "./assets/audio/music.ogg";
const MUSIC_VOLUME = 0.2;

export class GameAudio {
  constructor() {
    this.enabled = true;
    this.ctx = null;
    this.buffers = new Map();
    this.music = null;
    this.musicGain = null;
  }

  /** 必須由使用者手勢觸發（瀏覽器 autoplay 政策）。 */
  async start() {
    this.ctx ??= new AudioContext();
    await this.ctx.resume();
    await Promise.all(Object.entries(SFX).map(([name, url]) => this.#load(name, url)));
    await this.#startMusic();
  }

  async #load(name, url) {
    if (this.buffers.has(name)) return;
    try {
      const res = await fetch(url);
      this.buffers.set(name, await this.ctx.decodeAudioData(await res.arrayBuffer()));
    } catch {
      this.buffers.set(name, null);
    }
  }

  async #startMusic() {
    if (this.music || !this.ctx) return;
    try {
      const res = await fetch(MUSIC);
      const buffer = await this.ctx.decodeAudioData(await res.arrayBuffer());
      const source = this.ctx.createBufferSource();
      const gain = this.ctx.createGain();
      source.buffer = buffer;
      source.loop = true;
      gain.gain.value = this.enabled ? MUSIC_VOLUME : 0;
      source.connect(gain).connect(this.ctx.destination);
      source.start();
      this.music = source;
      this.musicGain = gain;
    } catch {}
  }

  play(name, { volume = 0.5, rate = 1 } = {}) {
    const buffer = this.buffers.get(name);
    if (!this.enabled || !this.ctx || !buffer) return;
    const source = this.ctx.createBufferSource();
    const gain = this.ctx.createGain();
    source.buffer = buffer;
    source.playbackRate.value = rate;
    gain.gain.value = volume;
    source.connect(gain).connect(this.ctx.destination);
    source.start();
  }

  setEnabled(on) {
    this.enabled = on;
    if (this.musicGain) this.musicGain.gain.value = on ? MUSIC_VOLUME : 0;
  }

  /** 暫停時把音樂壓小聲，回來再拉回去。 */
  duck(on) {
    if (!this.musicGain) return;
    this.musicGain.gain.value = this.enabled ? (on ? MUSIC_VOLUME * 0.28 : MUSIC_VOLUME) : 0;
  }
}
