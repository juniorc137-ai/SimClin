const test = require("node:test");
const assert = require("node:assert/strict");
const C = require("../public/captura-core.js");

const H = 3600000, DAY = 86400000;
const t0 = new Date("2026-11-02T08:00:00").getTime(); // segunda-feira

test("reserva semanal expande até a data-limite e respeita exclusões", () => {
  const r = { start: new Date(t0).toISOString(), end: new Date(t0 + 2 * H).toISOString(), recur: { freq: "semanal", until: "2026-11-30" } };
  const occ = C.expandRecurrence(r);
  assert.equal(occ.length, 5); // 2, 9, 16, 23 e 30/11
  assert.equal(occ[4].start - occ[0].start, 28 * DAY);
  assert.equal(occ[0].end - occ[0].start, 2 * H);
  const skipped = C.expandRecurrence({ ...r, recur: { ...r.recur, skip: [2] } });
  assert.deepEqual(skipped.map((o) => o.index), [0, 1, 3, 4]);
});

test("recorrência é limitada a um ano", () => {
  const r = { start: new Date(t0).toISOString(), end: new Date(t0 + H).toISOString(), recur: { freq: "diaria", until: "2030-01-01" } };
  assert.ok(C.expandRecurrence(r).length <= 367);
});

test("conflito: mesma sala sobreposta, equipamento permanente, mas não insumo", () => {
  const resources = [{ id: "man", kind: "capital" }, { id: "kit", kind: "consumivel" }];
  const a = { id: "a", locationId: "s1", resourceIds: ["man", "kit"], start: new Date(t0).toISOString(), end: new Date(t0 + 2 * H).toISOString() };
  const sameRoom = { id: "b", locationId: "s1", resourceIds: [], start: new Date(t0 + H).toISOString(), end: new Date(t0 + 3 * H).toISOString() };
  const otherRoomKit = { id: "c", locationId: "s2", resourceIds: ["kit"], start: new Date(t0 + H).toISOString(), end: new Date(t0 + 3 * H).toISOString() };
  const otherRoomMan = { ...otherRoomKit, id: "d", resourceIds: ["man"] };
  const after = { id: "e", locationId: "s1", start: new Date(t0 + 2 * H).toISOString(), end: new Date(t0 + 3 * H).toISOString() };
  assert.equal(C.findConflicts([a], sameRoom, resources).length, 1);
  assert.equal(C.findConflicts([a], otherRoomKit, resources).length, 0);
  assert.deepEqual(C.findConflicts([a], otherRoomMan, resources)[0].resources, ["man"]);
  assert.equal(C.findConflicts([a], after, resources).length, 0, "encostar no fim não é conflito");
  assert.equal(C.findConflicts([{ ...a, status: "negada" }], sameRoom, resources).length, 0);
});

test("conflito com ocorrência futura de série recorrente", () => {
  const serie = { id: "s", locationId: "s1", start: new Date(t0).toISOString(), end: new Date(t0 + 2 * H).toISOString(), recur: { freq: "semanal", until: "2026-12-31" } };
  const t = t0 + 14 * DAY + H;
  const cand = { id: "x", locationId: "s1", start: new Date(t).toISOString(), end: new Date(t + H).toISOString() };
  assert.equal(C.findConflicts([serie], cand).length, 1);
});

test("pontuação: check, escala, múltipla escolha, texto e item crítico", () => {
  const form = { items: [
    { id: "a", kind: "check", points: 2, critical: true },
    { id: "b", kind: "escala", max: 4 },
    { id: "c", kind: "multipla", options: [{ label: "Sim", points: 2 }, { label: "Não", points: 0 }] },
    { id: "d", kind: "texto" },
  ] };
  const full = C.scoreEvaluation(form, { a: true, b: 4, c: 0, d: "ok" });
  assert.deepEqual([full.points, full.max, full.pct, full.criticalMissed.length], [8, 8, 100, 0]);
  const part = C.scoreEvaluation(form, { a: false, b: 2, c: 1 });
  assert.deepEqual([part.points, part.pct, part.answered], [2, 25, 3]);
  assert.equal(part.criticalMissed.length, 1);
  assert.equal(C.scoreEvaluation({ items: [{ id: "x", kind: "texto" }] }, {}).pct, null);
});

test("amostragem do simulador: última amostra até o instante e deduplicação", () => {
  const s = [];
  C.pushSample(s, 0, { hr: 80, spo2: 98 });
  assert.equal(C.pushSample(s, 1, { hr: 80, spo2: 98 }), false, "sem mudança e antes do intervalo");
  C.pushSample(s, 2, { hr: 90, spo2: 98 });
  C.pushSample(s, 9, { hr: 90, spo2: 98 });
  assert.equal(s.length, 3);
  assert.equal(C.sampleAt(s, -1), null);
  assert.equal(C.sampleAt(s, 1.9).hr, 80);
  assert.equal(C.sampleAt(s, 2).hr, 90);
  assert.equal(C.sampleAt(s, 100).t, 9);
});

test("relatórios de uso e de desempenho (equipe conta para todos)", () => {
  const ev = { id: "e", items: [{ id: "a", kind: "check", points: 1 }, { id: "b", kind: "check", points: 1 }] };
  const sessions = [
    { id: "1", startedAt: t0, duration: 1800, locationId: "s1", courseId: "c", participantIds: ["p1", "p2"],
      results: [{ evaluationId: "e", subjectId: "p1", answers: { a: true, b: true } }, { evaluationId: "e", subjectId: "equipe", answers: { a: true } }],
      annotations: [{ cat: "Equipe" }, { cat: "Equipe" }, { cat: "x", source: "simulador" }] },
    { id: "2", startedAt: t0 + 40 * DAY, duration: 3600, locationId: "s2", courseId: "c", participantIds: ["p1"], results: [] },
  ];
  const u = C.usageReport(sessions);
  assert.equal(u.hours, 1.5);
  assert.equal(u.personHours, 2);
  assert.deepEqual(Object.keys(u.month).sort(), ["2026-11", "2026-12"]);
  const lr = C.learnerReport(sessions, [ev], [{ id: "p1", name: "Ana" }, { id: "p2", name: "Bia" }]);
  assert.deepEqual(lr.map((r) => [r.name, r.mean, r.evaluations]), [["Ana", 75, 2], ["Bia", 50, 1]]);
  assert.deepEqual(C.annotationReport(sessions), { Equipe: 2 });
});

test("importação de participantes por CSV com cabeçalho, aspas e ponto e vírgula", () => {
  const csv = '﻿Nome;E-mail;Papel\n"Souza, Ana";ana@x.br;Estudante\nRafael;r@x.br;Professor\n\n';
  assert.deepEqual(C.parseRosterCSV(csv), [
    { name: "Souza, Ana", email: "ana@x.br", role: "estudante" },
    { name: "Rafael", email: "r@x.br", role: "docente" },
  ]);
  assert.deepEqual(C.parseRosterCSV("Bia,b@x.br").map((p) => p.name), ["Bia"]);
});

test("exportações CSV e iCalendar escapam o conteúdo", () => {
  assert.equal(C.toCSV([{ a: 'x"y', b: 1 }]), '"a";"b"\r\n"x""y";"1"');
  const ics = C.toICS([{ uid: "1", start: t0, end: t0 + H, title: "Sepse; turma A", location: "Sala 1" }]);
  assert.match(ics, /BEGIN:VCALENDAR[\s\S]*SUMMARY:Sepse\\; turma A[\s\S]*END:VCALENDAR/);
  assert.match(ics, /DTSTART:\d{8}T\d{6}Z/);
});

test("retenção: prazo do cenário prevalece sobre o global", () => {
  const now = t0 + 40 * DAY;
  const sessions = [
    { id: "1", startedAt: t0, scenarioId: "curto", media: [{ id: "m" }] },
    { id: "2", startedAt: t0, scenarioId: "livre", media: [{ id: "m2" }] },
    { id: "3", startedAt: t0, scenarioId: "curto", media: [] },
  ];
  const scenarios = [{ id: "curto", retentionDays: 30 }, { id: "livre", retentionDays: 0 }];
  assert.deepEqual(C.expiredMedia(sessions, scenarios, 0, now).map((s) => s.id), ["1"]);
  assert.deepEqual(C.expiredMedia(sessions, scenarios, 60, now).map((s) => s.id), ["1"]);
  assert.deepEqual(C.expiredMedia(sessions, scenarios, 10, now).map((s) => s.id), ["1", "2"]);
});
