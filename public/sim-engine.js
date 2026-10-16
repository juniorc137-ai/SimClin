/* ════════════════════════════════════════════════════════════════════════
 * SimClin – Motor de Cenários (Scenario Engine)
 *
 * Arquitetura inspirada no modelo documentado pela Laerdal (SimDesigner/LLEAP):
 *   • Cenário  = evolução sequencial pré-programada de estados do paciente,
 *                com qualquer número de desfechos possíveis;
 *   • Estado   = condição do paciente num período (sinais vitais + ritmo);
 *   • Tendência (trend) = mudança pré-programada de parâmetros que depende
 *                apenas do tempo;
 *   • Evento   = algo que ocorre durante o cenário, em geral uma intervenção
 *                dos participantes (registrada pelo instrutor, "tap to log");
 *   • Handler  = regra entre eventos/condições e respostas automáticas;
 *   • Gatilho  = condição (eventos com AND/OR, contadores, parâmetros, tempo)
 *                que leva o cenário a um novo estado. Gatilhos são zerados
 *                ao entrar em um estado.
 *
 * O motor é determinístico (o tempo só avança via tick(dt)) para permitir
 * testes automatizados e reprodutibilidade de sessões.
 * Funciona no navegador (window.SimEngine) e no Node (module.exports).
 * ════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.SimEngine = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Limites fisiológicos/do monitor e precisão de exibição de cada parâmetro
  const PARAMS = {
    hr:   { min: 0,  max: 260, dec: 0, label: "FC" },
    spo2: { min: 0,  max: 100, dec: 0, label: "SpO₂" },
    rr:   { min: 0,  max: 60,  dec: 0, label: "FR" },
    temp: { min: 30, max: 43,  dec: 1, label: "Temp" },
    sbp:  { min: 0,  max: 260, dec: 0, label: "PAS" },
    dbp:  { min: 0,  max: 160, dec: 0, label: "PAD" },
  };
  const NUMERIC = Object.keys(PARAMS);
  const VITAL_KEYS = ["rhythm", ...NUMERIC];

  const clamp = (k, v) => Math.min(PARAMS[k].max, Math.max(PARAMS[k].min, v));
  const round = (k, v) => { const f = 10 ** PARAMS[k].dec; return Math.round(v * f) / f; };
  const OPS = {
    "<": (a, b) => a < b, "<=": (a, b) => a <= b,
    ">": (a, b) => a > b, ">=": (a, b) => a >= b,
    "==": (a, b) => a === b, "!=": (a, b) => a !== b,
  };

  // Pressão arterial média (PAM ≈ PAD + (PAS − PAD)/3)
  const map = (v) => (v.sbp || v.dbp) ? Math.round(v.dbp + (v.sbp - v.dbp) / 3) : 0;

  function fmtClock(s) {
    s = Math.max(0, Math.floor(s));
    return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  }

  class ScenarioEngine {
    /**
     * @param {object} scenario definição do cenário (ver scenarios.js)
     * @param {object} [opts]   { onChange(vitals), onLog(entry) }
     */
    constructor(scenario, opts = {}) {
      if (!scenario || !scenario.states || !scenario.initial) throw new Error("Cenário inválido");
      if (!scenario.states[scenario.initial]) throw new Error(`Estado inicial inexistente: ${scenario.initial}`);
      this.sc = scenario;
      this.opts = opts;
      this.eventDefs = new Map((scenario.events || []).map((e) => [e.id, e]));
      this.reset();
    }

    // ── Ciclo de vida ────────────────────────────────────────────────────
    reset() {
      this.t = 0;                 // tempo de simulação (s)
      this.running = false;
      this.started = false;
      this.finished = false;
      this.vitals = { rhythm: "sinusal", hr: 72, spo2: 98, rr: 16, temp: 36.5, sbp: 120, dbp: 80, ...(this.sc.baseline || {}) };
      this.trends = {};           // param → {from,to,t0,duration}
      this.totalCounts = {};      // contadores da sessão inteira (debriefing)
      this.stateCounts = {};      // contadores desde a entrada no estado (gatilhos)
      this.firstAt = {};          // evento → instante do 1º registro
      this.handlerFired = {};     // handler → nº de disparos
      this.condPrev = {};         // handler → último valor da condição (borda)
      this.handlerLast = {};      // handler → instante do último disparo
      this.log = [];
      this.stateId = null;
      this.stateT0 = 0;
      this.path = [];             // estados percorridos
    }

    start() {
      if (this.finished) return;
      if (!this.started) {
        this.started = true;
        this._log("sistema", `Cenário iniciado: ${this.sc.title}`);
        this._enterState(this.sc.initial, "início");
      }
      this.running = true;
    }
    pause()  { if (this.running) { this.running = false; this._log("sistema", "Pausado"); } }
    resume() { if (this.started && !this.finished && !this.running) { this.running = true; this._log("sistema", "Retomado"); } }

    get state() { return this.stateId ? this.sc.states[this.stateId] : null; }
    get stateElapsed() { return this.t - this.stateT0; }

    // ── Avanço do tempo ──────────────────────────────────────────────────
    /** Avança dt segundos. Retorna true se algum sinal vital exibido mudou. */
    tick(dt) {
      if (!this.running || dt <= 0) return false;
      const before = JSON.stringify(this.vitals);
      // Integra em passos ≤ 1 s para não "pular" gatilhos de limiar
      let rest = dt;
      while (rest > 1e-9 && this.running) {
        const h = Math.min(1, rest);
        rest -= h;
        this.t += h;
        this._applyTrends();
        this._runConditionHandlers();
        this._checkTransitions();
      }
      return JSON.stringify(this.vitals) !== before;
    }

    // ── Eventos (intervenções registradas pelo instrutor) ────────────────
    registerEvent(id, extra = {}) {
      if (!this.started || this.finished) return false;
      const def = this.eventDefs.get(id);
      this.totalCounts[id] = (this.totalCounts[id] || 0) + 1;
      this.stateCounts[id] = (this.stateCounts[id] || 0) + 1;
      if (this.firstAt[id] === undefined) this.firstAt[id] = this.t;
      const label = def ? def.label : id;
      this._log("evento", label + (extra.value !== undefined ? ` (${extra.value})` : ""), { event: id, value: extra.value });

      // Handlers disparados por evento
      for (const h of this._activeHandlers()) {
        if (h.on !== id) continue;
        if (h.once && this.handlerFired[h.id]) continue;
        if (h.if && !this._cond(h.if)) continue;
        this._fireHandler(h);
      }
      this._checkTransitions();
      return true;
    }

    // ── Modo manual: ajuste direto pelo instrutor ────────────────────────
    /** Sobrepõe valores e cancela tendências ativas desses parâmetros. */
    override(patch, source = "instrutor") {
      const changed = [];
      for (const k of Object.keys(patch)) {
        if (!VITAL_KEYS.includes(k)) continue;
        if (k !== "rhythm") delete this.trends[k];
        const v = k === "rhythm" ? patch[k] : round(k, clamp(k, +patch[k]));
        if (this.vitals[k] !== v) { this.vitals[k] = v; changed.push(`${PARAMS[k] ? PARAMS[k].label : "Ritmo"}=${v}`); }
      }
      if (changed.length && this.started) this._log("manual", `Ajuste ${source}: ${changed.join(", ")}`);
      this._emit();
    }

    /** Comentário do instrutor com carimbo de tempo (para o debriefing). */
    comment(text) {
      const s = String(text || "").trim();
      if (s && this.started) this._log("comentario", s.slice(0, 500));
    }

    /** Salto manual de estado (o instrutor sempre pode intervir). */
    gotoState(id, reason = "instrutor") {
      if (!this.sc.states[id]) return;
      if (!this.started) this.start();
      this._enterState(id, reason);
    }

    // ── Internos ─────────────────────────────────────────────────────────
    _enterState(id, reason) {
      const st = this.sc.states[id];
      this.stateId = id;
      this.stateT0 = this.t;
      this.stateCounts = {};      // gatilhos zerados na entrada do estado
      this.path.push({ id, t: this.t });
      this._log("estado", `→ ${st.label}` + (reason ? ` [${reason}]` : ""), { state: id });
      if (st.vitals) this._set(st.vitals, true);
      if (st.trends) this._startTrends(st.trends);
      if (st.onEnter) this._doActions(st.onEnter);
      if (st.end) {
        this.finished = true;
        this.running = false;
        this._log("sistema", `Cenário finalizado (${st.outcome || st.label})`);
      }
      this._emit();
    }

    _set(values, cancelTrends) {
      for (const k of Object.keys(values)) {
        if (!VITAL_KEYS.includes(k)) continue;
        if (k === "rhythm") { this.vitals.rhythm = values[k]; continue; }
        if (cancelTrends) delete this.trends[k];
        this.vitals[k] = round(k, clamp(k, values[k]));
      }
    }

    _startTrends(spec) {
      for (const k of Object.keys(spec)) {
        if (!PARAMS[k]) continue;
        const s = spec[k];
        const to = s.by !== undefined ? this.vitals[k] + s.by : s.to;
        this.trends[k] = {
          from: this.vitals[k], to: clamp(k, to), t0: this.t,
          duration: Math.max(0.001, s.duration || 1),
        };
      }
    }

    _applyTrends() {
      let any = false;
      for (const k of Object.keys(this.trends)) {
        const tr = this.trends[k];
        const f = Math.min(1, (this.t - tr.t0) / tr.duration);
        // Interpolação suavizada (ease-in-out): evita "degraus" pouco fisiológicos
        const e = f < 0.5 ? 2 * f * f : 1 - ((-2 * f + 2) ** 2) / 2;
        this.vitals[k] = round(k, clamp(k, tr.from + (tr.to - tr.from) * e));
        if (f >= 1) delete this.trends[k];
        any = true;
      }
      if (any) this._emit();
    }

    _activeHandlers() {
      const st = this.state;
      return [...(this.sc.handlers || []), ...((st && st.handlers) || [])];
    }

    _runConditionHandlers() {
      for (const h of this._activeHandlers()) {
        if (!h.when) continue;
        const now = this._cond(h.when);
        const prev = !!this.condPrev[h.id];
        this.condPrev[h.id] = now;
        if (!now || prev) continue;                // dispara só na borda de subida
        if (h.once && this.handlerFired[h.id]) continue;
        if (h.cooldown && this.handlerLast[h.id] !== undefined && this.t - this.handlerLast[h.id] < h.cooldown) continue;
        this._fireHandler(h);
      }
    }

    _fireHandler(h) {
      this.handlerFired[h.id] = (this.handlerFired[h.id] || 0) + 1;
      this.handlerLast[h.id] = this.t;
      if (h.log) this._log("resposta", h.log, { handler: h.id });
      this._doActions(h.actions || []);
    }

    _doActions(actions) {
      for (const a of actions) {
        if (a.set) this._set(a.set, true);
        if (a.add) {
          const p = {};
          for (const k of Object.keys(a.add)) if (PARAMS[k]) p[k] = this.vitals[k] + a.add[k];
          this._set(p, true);
        }
        if (a.trend) this._startTrends(a.trend);
        if (a.log) this._log("resposta", a.log);
        if (a.goto) { this._enterState(a.goto, "resposta automática"); return; }
      }
      this._emit();
    }

    _checkTransitions() {
      const st = this.state;
      if (!st || this.finished) return;
      for (const tr of st.transitions || []) {
        if (this._cond(tr.if)) { this._enterState(tr.goto, tr.reason || "gatilho"); return; }
      }
      if (st.timeout && this.stateElapsed >= st.timeout.after) {
        this._enterState(st.timeout.goto, st.timeout.reason || `tempo-limite ${fmtClock(st.timeout.after)}`);
      }
    }

    /** Avalia condições: {all:[…]}, {any:[…]}, {not:…}, {event,count}, {param,op,value}, {elapsed}. */
    _cond(c) {
      if (!c) return false;
      if (c.all) return c.all.every((x) => this._cond(x));
      if (c.any) return c.any.some((x) => this._cond(x));
      if (c.not) return !this._cond(c.not);
      if (c.event) {
        const n = (c.scope === "session" ? this.totalCounts : this.stateCounts)[c.event] || 0;
        return n >= (c.count || 1);
      }
      if (c.param) {
        const v = c.param === "map" ? map(this.vitals) : this.vitals[c.param];
        return (OPS[c.op] || OPS["=="])(v, c.value);
      }
      if (c.elapsed !== undefined) return this.stateElapsed >= c.elapsed;
      return false;
    }

    _log(kind, text, extra = {}) {
      const entry = {
        t: Math.round(this.t * 10) / 10, clock: fmtClock(this.t), wall: new Date().toISOString(),
        kind, text, state: this.stateId, vitals: { ...this.vitals }, ...extra,
      };
      this.log.push(entry);
      if (this.opts.onLog) this.opts.onLog(entry);
    }

    _emit() { if (this.opts.onChange) this.opts.onChange({ ...this.vitals }); }

    // ── Debriefing ───────────────────────────────────────────────────────
    /** Indicadores de desempenho: tempo até as intervenções-chave e cumprimento. */
    metrics() {
      const kpis = (this.sc.kpis || []).map((k) => {
        const t = this.firstAt[k.event];
        const done = t !== undefined;
        return {
          label: k.label, event: k.event, target: k.target,
          time: done ? t : null, clock: done ? fmtClock(t) : "—",
          met: done && (k.target === undefined || t <= k.target),
        };
      });
      return {
        scenario: this.sc.title, duration: this.t, clock: fmtClock(this.t),
        outcome: this.finished && this.state ? (this.state.outcome || this.state.label) : null,
        path: this.path.map((p) => ({ ...p, label: this.sc.states[p.id].label, clock: fmtClock(p.t) })),
        counts: { ...this.totalCounts }, kpis,
        kpiAdherence: kpis.length ? kpis.filter((k) => k.met).length / kpis.length : null,
      };
    }

    exportCSV() {
      const head = ["t_s", "relogio", "hora_real", "tipo", "descricao", "estado", ...VITAL_KEYS];
      const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
      const rows = this.log.map((e) => [e.t, e.clock, e.wall, e.kind, e.text, e.state, ...VITAL_KEYS.map((k) => e.vitals[k])].map(esc).join(","));
      return [head.join(","), ...rows].join("\n");
    }

    exportJSON() {
      return JSON.stringify({ scenario: this.sc.id, title: this.sc.title, metrics: this.metrics(), log: this.log }, null, 2);
    }
  }

  /** Valida a estrutura de um cenário; retorna lista de erros (vazia = ok). */
  function validateScenario(sc) {
    const errs = [];
    if (!sc.id) errs.push("id ausente");
    if (!sc.states || !sc.states[sc.initial]) errs.push("estado inicial inválido");
    const evs = new Set((sc.events || []).map((e) => e.id));
    const walk = (c, where) => {
      if (!c) return;
      (c.all || c.any || []).forEach((x) => walk(x, where));
      if (c.not) walk(c.not, where);
      if (c.event && !evs.has(c.event)) errs.push(`${where}: evento desconhecido "${c.event}"`);
      if (c.param && c.param !== "map" && !PARAMS[c.param]) errs.push(`${where}: parâmetro desconhecido "${c.param}"`);
    };
    const checkActions = (acts, where) => (acts || []).forEach((a) => {
      if (a.goto && !sc.states[a.goto]) errs.push(`${where}: goto inexistente "${a.goto}"`);
    });
    const checkHandlers = (hs, where) => (hs || []).forEach((h) => {
      if (!h.id) errs.push(`${where}: handler sem id`);
      if (h.on && !evs.has(h.on)) errs.push(`${where}/${h.id}: evento desconhecido "${h.on}"`);
      walk(h.when, `${where}/${h.id}`); walk(h.if, `${where}/${h.id}`);
      checkActions(h.actions, `${where}/${h.id}`);
    });
    checkHandlers(sc.handlers, "handlers");
    for (const [id, st] of Object.entries(sc.states || {})) {
      (st.transitions || []).forEach((tr, i) => {
        if (!sc.states[tr.goto]) errs.push(`${id}.transitions[${i}]: goto inexistente "${tr.goto}"`);
        walk(tr.if, `${id}.transitions[${i}]`);
      });
      if (st.timeout && !sc.states[st.timeout.goto]) errs.push(`${id}.timeout: goto inexistente`);
      checkHandlers(st.handlers, id);
      checkActions(st.onEnter, `${id}.onEnter`);
    }
    (sc.kpis || []).forEach((k) => { if (!evs.has(k.event)) errs.push(`kpi: evento desconhecido "${k.event}"`); });
    return errs;
  }

  return { ScenarioEngine, validateScenario, PARAMS, VITAL_KEYS, fmtClock, map };
});
