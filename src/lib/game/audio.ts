// Basit WebAudio tabanlı silah/oyun sesleri (asset gerektirmez)
class GameAudio {
  private ctx: AudioContext | null = null;

  private ensure() {
    if (!this.ctx) {
      const AC = (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext);
      this.ctx = new AC();
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx;
  }

  unlock() { this.ensure(); }

  private noiseBuffer(duration: number) {
    const ctx = this.ensure();
    const buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * duration), ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    return buffer;
  }

  shoot(weaponId: string) {
    try {
      const ctx = this.ensure();
      const now = ctx.currentTime;

      // Low thud (bass punch)
      const osc = ctx.createOscillator();
      const oscGain = ctx.createGain();
      osc.type = 'square';
      const startFreq = weaponId === 'sniper' ? 180 : weaponId === 'pistol' ? 260 : 220;
      osc.frequency.setValueAtTime(startFreq, now);
      osc.frequency.exponentialRampToValueAtTime(40, now + 0.08);
      oscGain.gain.setValueAtTime(0.5, now);
      oscGain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
      osc.connect(oscGain).connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.15);

      // Noise burst
      const noise = ctx.createBufferSource();
      noise.buffer = this.noiseBuffer(0.2);
      const filt = ctx.createBiquadFilter();
      filt.type = 'highpass';
      filt.frequency.value = 1200;
      const nGain = ctx.createGain();
      const peak = weaponId === 'sniper' ? 0.9 : weaponId === 'rifle' || weaponId === 'm4' ? 0.7 : 0.55;
      nGain.gain.setValueAtTime(peak, now);
      nGain.gain.exponentialRampToValueAtTime(0.001, now + (weaponId === 'sniper' ? 0.35 : 0.13));
      noise.connect(filt).connect(nGain).connect(ctx.destination);
      noise.start(now);
      noise.stop(now + 0.4);
    } catch { /* ignore */ }
  }

  reload() {
    try {
      const ctx = this.ensure();
      const now = ctx.currentTime;
      // click-clack: two short square blips
      for (let i = 0; i < 2; i++) {
        const t = now + i * 0.18;
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = 'square';
        osc.frequency.setValueAtTime(90, t);
        g.gain.setValueAtTime(0.35, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.07);
        osc.connect(g).connect(ctx.destination);
        osc.start(t);
        osc.stop(t + 0.08);
      }
    } catch { /* ignore */ }
  }

  hit() {
    try {
      const ctx = this.ensure();
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(800, now);
      osc.frequency.exponentialRampToValueAtTime(200, now + 0.1);
      g.gain.setValueAtTime(0.25, now);
      g.gain.exponentialRampToValueAtTime(0.001, now + 0.1);
      osc.connect(g).connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.12);
    } catch { /* ignore */ }
  }

  explosion() {
    try {
      const ctx = this.ensure();
      const now = ctx.currentTime;
      const noise = ctx.createBufferSource();
      noise.buffer = this.noiseBuffer(0.6);
      const filt = ctx.createBiquadFilter();
      filt.type = 'lowpass';
      filt.frequency.setValueAtTime(2000, now);
      filt.frequency.exponentialRampToValueAtTime(200, now + 0.5);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.9, now);
      g.gain.exponentialRampToValueAtTime(0.001, now + 0.6);
      noise.connect(filt).connect(g).connect(ctx.destination);
      noise.start(now);
      noise.stop(now + 0.7);
    } catch { /* ignore */ }
  }

  flashBang() {
    try {
      const ctx = this.ensure();
      const now = ctx.currentTime;
      const noise = ctx.createBufferSource();
      noise.buffer = this.noiseBuffer(0.3);
      const g = ctx.createGain();
      g.gain.setValueAtTime(1, now);
      g.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
      noise.connect(g).connect(ctx.destination);
      noise.start(now);
      noise.stop(now + 0.3);
      // ringing sine
      const ring = ctx.createOscillator();
      const rg = ctx.createGain();
      ring.type = 'sine';
      ring.frequency.value = 4500;
      rg.gain.setValueAtTime(0.3, now);
      rg.gain.exponentialRampToValueAtTime(0.001, now + 1.5);
      ring.connect(rg).connect(ctx.destination);
      ring.start(now);
      ring.stop(now + 1.5);
    } catch { /* ignore */ }
  }
}

export const gameAudio = new GameAudio();
