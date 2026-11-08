// Short synthesized effects: no assets or network requests. Events are coalesced by the simulation.
const EFFECTS = {
  blaster: { notes: [480], end: 100, duration: .055, type: 'square', volume: .07, cooldown: .09 },
  cannon: { notes: [130], end: 35, duration: .18, type: 'triangle', volume: .5, cooldown: .18 },
  frost: { notes: [900, 1200], end: 450, duration: .18, type: 'sine', volume: .12, cooldown: .25 },
  sniper: { notes: [1600], end: 130, duration: .16, type: 'sawtooth', volume: .09, cooldown: .18 },
  impact: { notes: [85], end: 25, duration: .14, type: 'triangle', volume: .35, cooldown: .15 },
  base: { notes: [150, 110], end: 55, duration: .18, type: 'sawtooth', volume: .16, cooldown: .35 },
  build: { notes: [330, 660], duration: .09, type: 'triangle', volume: .2, cooldown: .08 },
  upgrade: { notes: [440, 660, 880], duration: .12, type: 'sine', volume: .24, cooldown: .15 },
  sell: { notes: [660, 440], duration: .1, type: 'sine', volume: .2, cooldown: .1 },
  wave: { notes: [220, 330, 440], duration: .14, type: 'triangle', volume: .22, cooldown: .5 },
  boss: { notes: [110, 116, 110], duration: .25, type: 'sawtooth', volume: .12, cooldown: .5 },
  clear: { notes: [523, 659, 784], duration: .16, type: 'sine', volume: .22, cooldown: .5 },
  won: { notes: [523, 659, 784, 1047], duration: .22, type: 'triangle', volume: .23, cooldown: 1 },
  lost: { notes: [330, 247, 165, 110], duration: .25, type: 'triangle', volume: .25, cooldown: 1 },
};
const INTERFACE = new Set(['build', 'upgrade', 'sell']);

export class Audio {
  constructor(button) {
    this.button = button;
    this.enabled = true;
    this.last = new Map();
    this.voices = 0;
    try { this.enabled = localStorage.getItem('bastion.sound') !== 'off'; } catch { /* Storage can be disabled. */ }
    button.onclick = () => {
      this.enabled = !this.enabled;
      try { localStorage.setItem('bastion.sound', this.enabled ? 'on' : 'off'); } catch { /* Preference remains in memory. */ }
      this.unlock(); this.sync();
      if (this.enabled) this.play('build');
    };
    // AudioContext must be created/resumed by a user gesture (also handles browser interruptions).
    const unlock = () => this.unlock();
    document.addEventListener('pointerdown', unlock, { capture: true });
    document.addEventListener('keydown', unlock, { capture: true });
    document.addEventListener('visibilitychange', () => this.sync());
    this.sync();
  }

  unlock() {
    if (!this.enabled || this.button.disabled) return;
    try {
      if (!this.context) {
        const Context = globalThis.AudioContext || globalThis.webkitAudioContext;
        if (!Context) throw new Error('Web Audio is unavailable');
        this.context = new Context();
        this.master = this.context.createGain();
        this.master.gain.value = .3;
        const limiter = this.context.createDynamicsCompressor();
        this.master.connect(limiter); limiter.connect(this.context.destination);
      }
      if (this.context.state === 'suspended') this.context.resume().catch(() => {});
      this.sync();
    } catch {
      this.button.disabled = true;
      this.button.textContent = 'Sound unavailable';
      this.button.title = 'This browser could not start audio';
    }
  }

  sync() {
    if (!this.button.disabled) {
      this.button.textContent = this.enabled ? 'Sound on' : 'Sound off';
      this.button.setAttribute('aria-pressed', String(this.enabled));
      this.button.setAttribute('aria-label', this.enabled ? 'Mute sound effects' : 'Enable sound effects');
    }
    if (this.master) this.master.gain.setTargetAtTime(this.enabled && !document.hidden ? .3 : 0, this.context.currentTime, .015);
  }

  play(kind) {
    const effect = EFFECTS[kind], ctx = this.context;
    if (!effect || !this.enabled || document.hidden || ctx?.state !== 'running') return;
    const now = ctx.currentTime;
    if (now - (this.last.get(kind) ?? -Infinity) < effect.cooldown || this.voices + effect.notes.length > 16) return;
    this.last.set(kind, now);
    effect.notes.forEach((frequency, i) => {
      const start = now + i * .09, stop = start + effect.duration;
      const oscillator = ctx.createOscillator(), gain = ctx.createGain();
      oscillator.type = effect.type;
      oscillator.frequency.setValueAtTime(frequency, start);
      oscillator.frequency.exponentialRampToValueAtTime(effect.end || frequency, stop);
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(effect.volume, start + .004);
      gain.gain.exponentialRampToValueAtTime(.001, stop);
      oscillator.connect(gain); gain.connect(this.master);
      this.voices++;
      oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); this.voices--; };
      oscillator.start(start); oscillator.stop(stop + .01);
    });
  }

  update(game, paused) {
    // Always drain, even when muted, so unmuting never replays old combat.
    const events = game.soundEvents;
    for (const kind of events) if (!paused || INTERFACE.has(kind)) this.play(kind);
    events.clear();
  }
}
