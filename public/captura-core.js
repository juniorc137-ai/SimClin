/* ════════════════════════════════════════════════════════════════════════
 * SimClin Captura – núcleo de regras (sem DOM)
 *
 * Funções puras usadas pela página captura.html: agenda (recorrência e
 * conflitos de sala/equipamento), pontuação de avaliações, amostragem dos
 * dados do simulador na linha do tempo, relatórios de uso e desempenho e
 * exportações (CSV, iCalendar).
 *
 * Funciona no navegador (window.CapturaCore) e no Node (module.exports),
 * para ser testado com node:test.
 * ════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.CapturaCore = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const DAY = 86400000;

  const uid = (p = "") => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  function fmtClock(s) {
    s = Math.max(0, Math.floor(s || 0));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
    const mm = String(m).padStart(2, "0"), ss = String(x).padStart(2, "0");
    return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  }

  // ── Agenda ─────────────────────────────────────────────────────────────
  /**
   * Expande uma reserva em ocorrências. recur = { freq: "diaria"|"semanal"|"mensal", until }
   * Limite de um ano (como no calendário do sistema de referência).
   * @returns {{start:number,end:number,index:number}[]}
   */
  function expandRecurrence(res) {
    const start = +new Date(res.start), end = +new Date(res.end);
    const dur = Math.max(0, end - start);
    const out = [{ start, end: start + dur, index: 0 }];
    const r = res.recur;
    if (!r || !r.freq || r.freq === "nenhuma" || !r.until) return out;
    const limit = Math.min(+new Date(r.until) + DAY - 1, start + 366 * DAY);
    for (let i = 1; i < 400; i++) {
      const d = new Date(start);
      if (r.freq === "diaria") d.setDate(d.getDate() + i);
      else if (r.freq === "semanal") d.setDate(d.getDate() + 7 * i);
      else if (r.freq === "mensal") d.setMonth(d.getMonth() + i);
      else break;
      if (+d > limit) break;
      if ((r.skip || []).includes(i)) continue;
      out.push({ start: +d, end: +d + dur, index: i });
    }
    return out;
  }

  const overlaps = (a, b) => a.start < b.end && b.start < a.end;

  /**
   * Conflitos de uma reserva candidata com as existentes: mesma sala no mesmo
   * horário, ou equipamento permanente (capital) já reservado. Insumos
   * (consumíveis) não geram conflito.
   */
  function findConflicts(reservations, cand, resources = []) {
    const capital = new Set(resources.filter((r) => r.kind === "capital").map((r) => r.id));
    const candOcc = expandRecurrence(cand);
    const out = [];
    for (const other of reservations) {
      if (other.id === cand.id || other.status === "negada") continue;
      const sharedRes = (cand.resourceIds || []).filter((id) => capital.has(id) && (other.resourceIds || []).includes(id));
      const sameRoom = cand.locationId && cand.locationId === other.locationId;
      if (!sameRoom && !sharedRes.length) continue;
      const occ = expandRecurrence(other);
      for (const a of candOcc) {
        const b = occ.find((o) => overlaps(a, o));
        if (b) { out.push({ reservation: other, at: a.start, room: !!sameRoom, resources: sharedRes }); break; }
      }
    }
    return out;
  }

  // ── Avaliações ─────────────────────────────────────────────────────────
  /**
   * Itens: check (feito/não feito), escala (0..max), multipla (opção com pontos),
   * texto (não pontua). Item crítico não cumprido marca a avaliação como "crítica".
   */
  function itemMax(it) {
    if (it.kind === "check") return +it.points || 1;
    if (it.kind === "escala") return +it.max || 5;
    if (it.kind === "multipla") return Math.max(0, ...(it.options || []).map((o) => +o.points || 0));
    return 0;
  }

  function scoreEvaluation(form, answers = {}) {
    let points = 0, max = 0, answered = 0, criticalMissed = [];
    for (const it of form.items || []) {
      const m = itemMax(it), a = answers[it.id];
      max += m;
      if (a !== undefined && a !== null && a !== "") answered++;
      let p = 0;
      if (it.kind === "check") p = a === true ? m : 0;
      else if (it.kind === "escala") p = Math.min(m, Math.max(0, +a || 0));
      else if (it.kind === "multipla") { const o = (it.options || [])[a]; p = o ? +o.points || 0 : 0; }
      points += p;
      if (it.critical && m && p < m) criticalMissed.push(it.text);
    }
    return {
      points, max, answered, total: (form.items || []).length,
      pct: max ? Math.round((points / max) * 1000) / 10 : null,
      criticalMissed,
    };
  }

  // ── Dados do simulador ─────────────────────────────────────────────────
  /** Última amostra com t <= alvo (amostras ordenadas por t). */
  function sampleAt(samples, t) {
    if (!samples || !samples.length || t < samples[0].t) return null;
    let lo = 0, hi = samples.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (samples[mid].t <= t) lo = mid; else hi = mid - 1;
    }
    return samples[lo];
  }

  /** Acrescenta amostra só quando algum valor muda ou a cada `every` s. */
  function pushSample(samples, t, vitals, every = 5) {
    const keys = ["rhythm", "hr", "spo2", "rr", "temp", "sbp", "dbp"];
    const last = samples[samples.length - 1];
    const s = { t: Math.round(t * 10) / 10 };
    keys.forEach((k) => { if (vitals[k] !== undefined) s[k] = vitals[k]; });
    if (last && t - last.t < every && keys.every((k) => last[k] === s[k])) return false;
    if (last && s.t <= last.t) { Object.assign(last, s, { t: last.t }); return true; }
    samples.push(s);
    return true;
  }

  // ── Relatórios ─────────────────────────────────────────────────────────
  const monthKey = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; };

  /** Horas de simulação gravadas por sala, curso e mês; horas-participante. */
  function usageReport(sessions) {
    const by = { location: {}, course: {}, month: {} };
    let hours = 0, personHours = 0;
    for (const s of sessions) {
      const h = (s.duration || 0) / 3600;
      hours += h;
      personHours += h * (s.participantIds || []).length;
      const add = (bucket, k) => { bucket[k || "—"] = (bucket[k || "—"] || 0) + h; };
      add(by.location, s.locationId); add(by.course, s.courseId); add(by.month, monthKey(s.startedAt));
    }
    return { sessions: sessions.length, hours, personHours, ...by };
  }

  /** Desempenho por estudante: média percentual por avaliação e geral. */
  function learnerReport(sessions, evaluations, people) {
    const evById = new Map(evaluations.map((e) => [e.id, e]));
    const rows = new Map();
    for (const s of sessions) {
      for (const r of s.results || []) {
        const ev = evById.get(r.evaluationId);
        if (!ev) continue;
        const sc = scoreEvaluation(ev, r.answers);
        if (sc.pct === null) continue;
        const ids = r.subjectId === "equipe" ? (s.participantIds || []) : [r.subjectId];
        for (const pid of ids) {
          if (!rows.has(pid)) rows.set(pid, { personId: pid, sessions: new Set(), scores: [], critical: 0 });
          const row = rows.get(pid);
          row.sessions.add(s.id); row.scores.push(sc.pct); if (sc.criticalMissed.length) row.critical++;
        }
      }
    }
    const name = (id) => (people.find((p) => p.id === id) || {}).name || id;
    return [...rows.values()].map((r) => ({
      personId: r.personId, name: name(r.personId), sessions: r.sessions.size, evaluations: r.scores.length,
      mean: Math.round((r.scores.reduce((a, b) => a + b, 0) / r.scores.length) * 10) / 10,
      min: Math.min(...r.scores), critical: r.critical,
    })).sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
  }

  /** Contagem de anotações por categoria (marcadores comportamentais). */
  function annotationReport(sessions) {
    const out = {};
    for (const s of sessions) for (const a of s.annotations || []) {
      if (a.source === "simulador") continue;
      const k = a.cat || "Sem categoria"; out[k] = (out[k] || 0) + 1;
    }
    return out;
  }

  // ── Exportação/importação ──────────────────────────────────────────────
  function toCSV(rows, head) {
    const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    head = head || (rows[0] ? Object.keys(rows[0]) : []);
    return [head.map(esc).join(";"), ...rows.map((r) => head.map((h) => esc(r[h])).join(";"))].join("\r\n");
  }

  /** Lê CSV de participantes (separador , ou ;) com colunas nome, email, papel. */
  function parseRosterCSV(text) {
    const lines = String(text).replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim());
    if (!lines.length) return [];
    const sep = (lines[0].match(/;/g) || []).length >= (lines[0].match(/,/g) || []).length ? ";" : ",";
    const split = (l) => {
      const out = []; let cur = "", q = false;
      for (let i = 0; i < l.length; i++) {
        const c = l[i];
        if (q) { if (c === '"' && l[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
        else if (c === '"') q = true; else if (c === sep) { out.push(cur); cur = ""; } else cur += c;
      }
      out.push(cur); return out.map((x) => x.trim());
    };
    const norm = (s) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
    const head = split(lines[0]).map(norm);
    const col = (...names) => head.findIndex((h) => names.some((n) => h.includes(n)));
    let iName = col("nome", "name"), iMail = col("email", "e-mail"), iRole = col("papel", "role", "funcao");
    const hasHead = iName >= 0 || iMail >= 0;
    if (!hasHead) { iName = 0; iMail = 1; iRole = 2; }
    const roleOf = (r) => {
      r = norm(r || "");
      if (/doc|prof|instr|teacher|faculty/.test(r)) return "docente";
      if (/pacient|ator|sp\b/.test(r)) return "pe";
      if (/admin/.test(r)) return "admin";
      return "estudante";
    };
    return lines.slice(hasHead ? 1 : 0).map(split).map((c) => ({
      name: c[iName] || c[iMail] || "", email: iMail >= 0 ? c[iMail] || "" : "", role: roleOf(iRole >= 0 ? c[iRole] : ""),
    })).filter((p) => p.name);
  }

  function toICS(occurrences, prodId = "-//SimClin//Captura//PT") {
    const z = (ts) => new Date(ts).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const tx = (s) => String(s || "").replace(/[\\;,]/g, (m) => "\\" + m).replace(/\n/g, "\\n");
    const ev = occurrences.map((o) => [
      "BEGIN:VEVENT", `UID:${o.uid}@simclin`, `DTSTAMP:${z(Date.now())}`, `DTSTART:${z(o.start)}`, `DTEND:${z(o.end)}`,
      `SUMMARY:${tx(o.title)}`, o.location ? `LOCATION:${tx(o.location)}` : null, o.description ? `DESCRIPTION:${tx(o.description)}` : null,
      "END:VEVENT",
    ].filter(Boolean).join("\r\n"));
    return ["BEGIN:VCALENDAR", "VERSION:2.0", `PRODID:${prodId}`, "CALSCALE:GREGORIAN", ...ev, "END:VCALENDAR"].join("\r\n");
  }

  /** Sessões cujo vídeo passou do prazo de retenção (dias; 0 = sem limite). */
  function expiredMedia(sessions, scenarios, globalDays, now = Date.now()) {
    const out = [];
    for (const s of sessions) {
      const sc = scenarios.find((x) => x.id === s.scenarioId);
      const days = sc && +sc.retentionDays > 0 ? +sc.retentionDays : +globalDays || 0;
      if (days > 0 && (s.media || []).length && now - s.startedAt > days * DAY) out.push(s);
    }
    return out;
  }

  /**
   * Câmera fixa da sala por link: identifica o tipo de transmissão pela URL e aponta
   * o que impede o navegador de abri-la. Navegadores não tocam RTSP/RTMP; essas câmeras
   * precisam de um conversor (MediaMTX, go2rtc) que entregue WebRTC (WHEP), HLS ou MJPEG.
   */
  const CAM_KINDS = { webrtc: "WebRTC (WHEP)", hls: "HLS (.m3u8)", mjpeg: "MJPEG", imagem: "Imagem atualizada (snapshot)", video: "Arquivo de vídeo (MP4/WebM)" };
  function detectStreamKind(url) {
    const u = String(url || "").trim().toLowerCase();
    if (/^(rtsp|rtsps|rtmp|rtmps|rtp|srt|udp):/.test(u)) return "rtsp";
    if (!/^https?:\/\//.test(u)) return "invalido";
    const path = u.split(/[?#]/)[0];
    if (/\/whep\/?$/.test(path) || /[?&](whep|webrtc)\b/.test(u)) return "webrtc";
    if (/\.m3u8$/.test(path)) return "hls";
    if (/\.(mjpe?g)$/.test(path) || /(mjpg|mjpeg|videostream\.cgi|video\.cgi|action=stream|\/stream\.(cgi|jpg)$)/.test(u)) return "mjpeg";
    if (/\.(jpe?g|png|webp)$/.test(path) || /(snapshot|snap\.cgi|action=snapshot|image\.cgi|\/jpg\/image)/.test(u)) return "imagem";
    if (/\.(mp4|webm|ogv|ogg|mov)$/.test(path)) return "video";
    return "desconhecido";
  }
  function checkCamUrl(url, kind, page = {}) {
    const u = String(url || "").trim(), k = kind && kind !== "auto" ? kind : detectStreamKind(u), problems = [];
    if (k === "invalido") problems.push("Informe um endereço completo começando com http:// ou https://.");
    if (k === "rtsp") problems.push("Navegadores não abrem RTSP/RTMP. Converta a câmera com um servidor como MediaMTX ou go2rtc e use o link WebRTC (WHEP), HLS (.m3u8) ou MJPEG que ele fornece.");
    let host = "";
    try { host = new URL(u).hostname; } catch (e) { /* inválido */ }
    const local = /^(localhost|127\.|\[?::1\]?$)/.test(host);
    if (page.protocol === "https:" && /^http:/i.test(u) && !local) problems.push("Esta página está em https e o link da câmera em http: o navegador bloqueia conteúdo misto. Use um link https ou abra o HelseCapture pelo servidor local (http).");
    if (/^[a-z]+:\/\/[^/]*:[^/]*@/i.test(u)) problems.push("Usuário e senha no link podem ser bloqueados pelo navegador; prefira um link com token ou liberado na rede da sala.");
    return { kind: k, ok: !problems.length || (problems.length === 1 && /senha/.test(problems[0])), problems };
  }

  return {
    uid, fmtClock, expandRecurrence, findConflicts, overlaps, itemMax, scoreEvaluation,
    sampleAt, pushSample, usageReport, learnerReport, annotationReport, toCSV, parseRosterCSV,
    toICS, expiredMedia, monthKey, CAM_KINDS, detectStreamKind, checkCamUrl,
  };
});
