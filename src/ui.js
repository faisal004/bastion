// DOM HUD, shop, selection panel and overlays.
// Writes to the DOM only when a displayed value actually changes.
import * as C from './config.js';

const $ = (id) => document.getElementById(id);
const MODE_LABEL = { first: 'First', last: 'Last', strong: 'Strongest', close: 'Closest' };
const ENEMY_ICON = { grunt: '●', runner: '▲', tank: '■', swarm: '•', flyer: '◆', boss: '⬢' };

export class UI {
  constructor(game, view, ctl, actions) {
    this.game = game; this.view = view; this.ctl = ctl; this.actions = actions;
    this.cache = new Map();
    this.elSeq = 0;
    this.titleDismissed = false;
    this.lastOverlay = '';
    this.selKey = '';
    this.buildShop();

    $('btn-next').onclick = () => actions.nextWave();
    $('btn-pause').onclick = () => actions.togglePause();
    $('btn-speed').onclick = () => actions.cycleSpeed();
    $('btn-restart').onclick = () => actions.restart();
    $('overlay').addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-act]');
      if (!b) return;
      const a = b.dataset.act;
      if (a === 'play') { this.titleDismissed = true; }
      else if (a === 'resume') actions.togglePause();
      else if (a === 'restart') actions.restart(true);
    });
    $('sel').addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-act]');
      if (!b) return;
      const a = b.dataset.act;
      if (a === 'upgrade') actions.upgrade();
      else if (a === 'sell') actions.sell();
      else if (a === 'mode') actions.cycleMode();
    });
  }

  set(id, prop, val) {
    const key = (typeof id === 'string' ? id : (id._uiKey ||= 'el' + (++this.elSeq))) + '.' + prop;
    if (this.cache.get(key) === val) return;
    this.cache.set(key, val);
    const el = typeof id === 'string' ? $(id) : id;
    if (prop === 'text') el.textContent = val;
    else if (prop === 'html') el.innerHTML = val;
    else if (prop === 'class') el.className = val;
    else if (prop === 'disabled') el.disabled = val;
  }

  buildShop() {
    const shop = $('shop');
    shop.innerHTML = '';
    this.cards = {};
    for (const type of C.TOWER_TYPES) {
      const d = C.TOWERS[type];
      const L = d.levels[0];
      const card = document.createElement('button');
      card.className = 'card';
      card.dataset.type = type;
      const stat = d.fire === 'pulse' ? `slow ${Math.round(L.slow * 100)}% · range ${L.range}`
        : d.fire === 'shell' ? `${L.dmg} splash · ${L.rate}/s · range ${L.range}`
        : `${L.dmg} dmg · ${L.rate}/s · range ${L.range}`;
      card.innerHTML = `
        <span class="swatch" style="--c:${d.color}"></span>
        <span class="card-body">
          <span class="card-top"><b>${d.name}</b><span class="cost">${d.cost}g</span></span>
          <span class="card-desc">${d.desc}</span>
          <span class="card-stat">${stat}</span>
        </span>
        <kbd>${d.key}</kbd>`;
      card.onclick = () => this.actions.selectBuild(type);
      shop.appendChild(card);
      this.cards[type] = card;
    }
  }

  toast(text, kind = '') {
    const el = document.createElement('div');
    el.className = 'toast ' + kind;
    el.textContent = text;
    $('toasts').appendChild(el);
    setTimeout(() => el.classList.add('out'), 1800);
    setTimeout(() => el.remove(), 2300);
  }

  update() {
    const g = this.game, v = this.view, ctl = this.ctl;
    this.set('lives', 'text', String(g.lives));
    this.set('gold', 'text', g.stress ? '∞' : String(g.gold));
    this.set('wave', 'text', `${g.wave}/${C.MAX_WAVE}`);
    this.set('score', 'text', g.score.toLocaleString());
    this.set('s-lives', 'class', 'stat' + (g.baseHit > 0 ? ' hurt' : '') + (g.lives <= 5 ? ' low' : ''));

    // next wave button
    let label, dis = !g.canCallWave();
    if (g.stress) { label = 'Stress test running'; dis = true; }
    else if (g.state === 'ready') label = 'Start Wave 1';
    else if (g.wave >= C.MAX_WAVE) label = 'Final wave';
    else if (!g.waveInProgress && g.intermission > 0) label = `Wave ${g.wave + 1} in ${Math.ceil(g.intermission)}s  ▸`;
    else if (dis) label = `Wave ${g.wave} incoming…`;
    else label = `Call wave ${g.wave + 1} early ▸`;
    this.set('btn-next', 'text', label);
    this.set('btn-next', 'disabled', dis || g.state === 'won' || g.state === 'lost');
    this.set('btn-pause', 'text', ctl.paused ? 'Resume' : 'Pause');
    this.set('btn-speed', 'text', ctl.speed + '×');
    this.set('btn-restart', 'text', ctl.restartArmed ? 'Confirm?' : 'Restart');

    // upcoming wave preview
    const nextW = Math.min(C.MAX_WAVE, g.wave + (g.waveInProgress ? 0 : 1));
    if (nextW >= 1) {
      const counts = C.describeWave(nextW);
      const html = `<span class="lbl">${g.waveInProgress ? 'Now' : 'Next'}</span>` +
        Object.entries(counts).map(([t, n]) =>
          `<span class="chip" style="--c:${C.ENEMIES[t].color}" title="${C.ENEMIES[t].name}">${ENEMY_ICON[t]} ${n}</span>`).join('');
      this.set('preview', 'html', html);
    }

    for (const type of C.TOWER_TYPES) {
      const card = this.cards[type];
      const cls = 'card' + (v.placing === type ? ' active' : '') + (g.gold < C.TOWERS[type].cost ? ' poor' : '');
      this.set(card, 'class', cls);
    }

    this.updateSelection();

    while (g.messages.length) {
      const m = g.messages.shift();
      this.toast(m.text, m.kind);
    }

    this.updateOverlay();
  }

  updateSelection() {
    const g = this.game, t = this.view.selected;
    const box = $('sel');
    if (!t) { this.set(box, 'class', 'hidden'); this.selKey = ''; return; }
    this.set(box, 'class', '');
    const st = g.stats(t);
    const upCost = g.upgradeCost(t);
    const key = `${t.id}|${t.level}|${t.mode}|${upCost != null && g.gold >= upCost}`;
    if (key === this.selKey) {
      const k = String(t.kills), d = Math.floor(t.damage).toLocaleString();
      if (this.selKills.textContent !== k) this.selKills.textContent = k;
      if (this.selDmg.textContent !== d) this.selDmg.textContent = d;
      return;
    }
    this.selKey = key;
    const next = t.def.levels[t.level + 1];
    const row = (k, a, b) => `<div class="row"><span>${k}</span><b>${a}${b != null && b !== a ? ` <em>→ ${b}</em>` : ''}</b></div>`;
    let rows = '';
    if (t.def.fire === 'pulse') {
      rows += row('Pulse dmg', st.dmg, next && next.dmg);
      rows += row('Slow', Math.round(st.slow * 100) + '%', next && Math.round(next.slow * 100) + '%');
      rows += row('Pulses/s', st.rate, next && next.rate);
    } else {
      rows += row('Damage', st.dmg, next && next.dmg);
      rows += row('Rate', st.rate + '/s', next && next.rate + '/s');
      if (st.splash) rows += row('Splash', st.splash, next && next.splash);
    }
    rows += row('Range', st.range, next && next.range);
    rows += `<div class="row"><span>Kills</span><b id="sel-kills">${t.kills}</b></div>`;
    rows += `<div class="row"><span>Damage dealt</span><b id="sel-dmg">${Math.floor(t.damage).toLocaleString()}</b></div>`;
    const canUp = upCost != null && g.gold >= upCost;
    box.innerHTML = `
      <div class="sel-head"><span class="swatch" style="--c:${t.def.color}"></span>
        <b>${t.def.name}</b><span class="lvl">Lv ${t.level + 1}/3</span></div>
      ${rows}
      ${t.def.fire !== 'pulse' ? `<button data-act="mode" class="wide">Target: ${MODE_LABEL[t.mode]} <kbd>T</kbd></button>` : ''}
      <div class="sel-actions">
        <button data-act="upgrade" class="primary" ${canUp ? '' : 'disabled'}>${upCost == null ? 'Max level' : `Upgrade ${upCost}g`} <kbd>U</kbd></button>
        <button data-act="sell" class="danger">Sell +${g.sellValue(t)}g <kbd>X</kbd></button>
      </div>`;
    this.selKills = $('sel-kills');
    this.selDmg = $('sel-dmg');
  }

  updateOverlay() {
    const g = this.game, ctl = this.ctl;
    let mode = '';
    if (!this.titleDismissed) mode = 'title';
    else if (g.state === 'lost') mode = 'lost';
    else if (g.state === 'won') mode = 'won';
    else if (ctl.paused) mode = 'paused';
    const key = mode + '|' + (mode === 'lost' || mode === 'won' ? g.score : '');
    if (key === this.lastOverlay) return;
    this.lastOverlay = key;
    const ov = $('overlay');
    if (!mode) { ov.className = 'overlay hidden'; ov.innerHTML = ''; return; }
    ov.className = 'overlay';
    if (mode === 'title') {
      ov.innerHTML = `<div class="panel">
        <h1>BASTION</h1>
        <p class="sub">Hold the fortress through 50 waves.</p>
        <ul class="how">
          <li>Pick a tower (<kbd>1</kbd>–<kbd>4</kbd>) and click open ground to build.</li>
          <li>Click a tower to upgrade <kbd>U</kbd>, sell <kbd>X</kbd> or retarget <kbd>T</kbd>.</li>
          <li>Armored tanks shrug off Blaster fire. Cannons can't hit flyers.</li>
          <li><kbd>Space</kbd> pause · <kbd>F</kbd> speed · <kbd>N</kbd> next wave · scroll to zoom, drag to pan.</li>
        </ul>
        <button data-act="play" class="primary big">Play</button></div>`;
    } else if (mode === 'paused') {
      ov.innerHTML = `<div class="panel small"><h2>Paused</h2>
        <button data-act="resume" class="primary big">Resume</button>
        <button data-act="restart">Restart</button></div>`;
    } else {
      const won = mode === 'won';
      ov.innerHTML = `<div class="panel small ${won ? 'win' : 'lose'}">
        <h2>${won ? 'Victory' : 'Defeat'}</h2>
        <p class="sub">${won ? `All ${C.MAX_WAVE} waves repelled.` : `The fortress fell on wave ${g.wave}.`}</p>
        <div class="final"><span>Score</span><b>${g.score.toLocaleString()}</b></div>
        <div class="final"><span>Enemies slain</span><b>${g.kills.toLocaleString()}</b></div>
        <button data-act="restart" class="primary big">Play again</button></div>`;
    }
  }
}
