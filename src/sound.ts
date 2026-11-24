// Synthesised soundscape — no audio files needed.
export class Soundscape {
  private ctx: AudioContext | null = null;
  private wind: GainNode | null = null;
  private surf: GainNode | null = null;
  private rain: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private fx: GainNode | null = null; // one-shots + dialogue; swapped out on reset so nothing keeps playing

  get context() { return this.ctx; }
  /** Destination for one-shot sounds and voices. */
  get bus(): AudioNode { return this.fx!; }

  /** Cut every one-shot sound and voice immediately (used when Begin restarts the performance). */
  resetFx() {
    if (!this.ctx) return;
    this.fx?.disconnect();
    this.fx = this.ctx.createGain();
    this.fx.connect(this.ctx.destination);
  }

  start() {
    if (this.ctx) { this.ctx.resume(); return; }
    const ctx = new AudioContext();
    this.ctx = ctx;
    this.resetFx();
    const len = ctx.sampleRate * 3;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.noise = buf;

    const loop = (type: BiquadFilterType, freq: number, q = 1) => {
      const src = ctx.createBufferSource();
      src.buffer = buf; src.loop = true;
      const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
      const g = ctx.createGain(); g.gain.value = 0;
      src.connect(f).connect(g).connect(ctx.destination);
      src.start();
      return { g, f };
    };
    const surf = loop('lowpass', 380);
    // slow swell on the surf
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.12;
    const lfoGain = ctx.createGain(); lfoGain.gain.value = 0.05;
    lfo.connect(lfoGain).connect(surf.g.gain); lfo.start();
    const wind = loop('bandpass', 520, 0.7);
    const windLfo = ctx.createOscillator(); windLfo.frequency.value = 0.07;
    const windDepth = ctx.createGain(); windDepth.gain.value = 220;
    windLfo.connect(windDepth).connect(wind.f.frequency); windLfo.start();
    const rain = loop('highpass', 3200);
    this.surf = surf.g; this.wind = wind.g; this.rain = rain.g;
    this.setStorm(1);
  }

  setStorm(level: number) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const l = Math.max(0, Math.min(5, level)) / 5;
    this.surf!.gain.linearRampToValueAtTime(0.07 + 0.12 * l, t + 2.5);
    this.wind!.gain.linearRampToValueAtTime(0.01 + 0.16 * l * l, t + 2.5);
    this.rain!.gain.linearRampToValueAtTime(level >= 3 ? 0.012 + 0.03 * l : 0, t + 2.5);
  }

  private burst(filter: BiquadFilterType, freq: number, dur: number, peak: number, attack = 0.02) {
    if (!this.ctx || !this.noise) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const src = ctx.createBufferSource(); src.buffer = this.noise;
    const f = ctx.createBiquadFilter(); f.type = filter; f.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(this.fx!);
    src.start(t); src.stop(t + dur + 0.1);
  }

  thunder(strength = 1) { this.burst('lowpass', 140, 3.2, 0.9 * strength, 0.08); }
  staticHiss() { this.burst('highpass', 2500, 1.1, 0.18); }
  thud() {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator(); o.frequency.setValueAtTime(110, t); o.frequency.exponentialRampToValueAtTime(40, t + 0.25);
    const g = ctx.createGain(); g.gain.setValueAtTime(0.5, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
    o.connect(g).connect(this.fx!); o.start(t); o.stop(t + 0.4);
  }
  chime() {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    [660, 880].forEach((hz, i) => {
      const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = hz;
      const g = ctx.createGain(); g.gain.setValueAtTime(0, t + i * 0.12); g.gain.linearRampToValueAtTime(0.12, t + i * 0.12 + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.12 + 0.5);
      o.connect(g).connect(this.fx!); o.start(t + i * 0.12); o.stop(t + i * 0.12 + 0.6);
    });
  }
  horn() {
    if (!this.ctx) return;
    const ctx = this.ctx;
    [0, 1.9].forEach((off) => {
      const t = ctx.currentTime + off;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 700;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.22, t + 0.15);
      g.gain.setValueAtTime(0.22, t + 1.3); g.gain.exponentialRampToValueAtTime(0.0001, t + 1.7);
      lp.connect(g).connect(this.fx!);
      [98, 147].forEach((hz) => { const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = hz; o.connect(lp); o.start(t); o.stop(t + 1.8); });
    });
  }
}
