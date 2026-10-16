const test = require("node:test");
const assert = require("node:assert/strict");
const { ScenarioEngine, validateScenario } = require("../public/sim-engine.js");
const SCENARIOS = require("../public/scenarios.js");

const run = (eng, seconds) => { for (let i = 0; i < seconds; i++) eng.tick(1); };

test("todos os cenários da biblioteca são válidos", () => {
  for (const sc of SCENARIOS) assert.deepEqual(validateScenario(sc), [], sc.id);
});

test("tendência depende só do tempo e chega ao alvo", () => {
  const sc = { id: "t", initial: "a", states: { a: { label: "A", vitals: { hr: 60 }, trends: { hr: { to: 120, duration: 60 } } } } };
  const e = new ScenarioEngine(sc);
  e.start();
  run(e, 30);
  assert.ok(e.vitals.hr > 60 && e.vitals.hr < 120, `meio da tendência: ${e.vitals.hr}`);
  run(e, 40);
  assert.equal(e.vitals.hr, 120);
  assert.deepEqual(e.trends, {});
});

test("ajuste manual cancela a tendência do parâmetro", () => {
  const sc = { id: "t", initial: "a", states: { a: { label: "A", vitals: { sbp: 120 }, trends: { sbp: { to: 70, duration: 100 } } } } };
  const e = new ScenarioEngine(sc);
  e.start();
  run(e, 10);
  e.override({ sbp: 130 });
  run(e, 50);
  assert.equal(e.vitals.sbp, 130);
  assert.ok(e.log.some((l) => l.kind === "manual"));
});

test("gatilho AND exige todos os eventos; contadores zeram ao entrar no estado", () => {
  const sc = {
    id: "t", initial: "a",
    events: [{ id: "x", label: "X" }, { id: "y", label: "Y" }],
    states: {
      a: { label: "A", transitions: [{ if: { all: [{ event: "x" }, { event: "y" }] }, goto: "b" }] },
      b: { label: "B", transitions: [{ if: { event: "x" }, goto: "c" }] },
      c: { label: "C", end: true },
    },
  };
  const e = new ScenarioEngine(sc);
  e.start();
  e.registerEvent("x");
  assert.equal(e.stateId, "a");
  e.registerEvent("y");
  assert.equal(e.stateId, "b");
  e.tick(1);
  assert.equal(e.stateId, "b", "x registrado em A não deve disparar o gatilho de B");
  e.registerEvent("x");
  assert.equal(e.stateId, "c");
  assert.equal(e.finished, true);
});

test("tempo-limite leva ao estado de deterioração", () => {
  const sc = { id: "t", initial: "a", states: { a: { label: "A", timeout: { after: 30, goto: "b" } }, b: { label: "B", end: true } } };
  const e = new ScenarioEngine(sc);
  e.start();
  run(e, 29);
  assert.equal(e.stateId, "a");
  run(e, 1);
  assert.equal(e.stateId, "b");
});

test("handler por condição dispara na borda e respeita cooldown", () => {
  const sc = {
    id: "t", initial: "a",
    handlers: [{ id: "h", when: { param: "spo2", op: "<", value: 90 }, cooldown: 60, actions: [{ add: { hr: 10 } }] }],
    states: { a: { label: "A", vitals: { spo2: 95, hr: 80 } } },
  };
  const e = new ScenarioEngine(sc);
  e.start();
  e.override({ spo2: 85 });
  e.tick(1);
  assert.equal(e.vitals.hr, 90);
  run(e, 5);
  assert.equal(e.vitals.hr, 90, "condição contínua não redispara");
  e.override({ spo2: 95 }); e.tick(1);
  e.override({ spo2: 85 }); e.tick(1);
  assert.equal(e.vitals.hr, 90, "cooldown impede novo disparo");
});

test("PCR: caminho ideal leva ao RCE e KPIs são cumpridos", () => {
  const sc = SCENARIOS.find((s) => s.id === "pcr_fv");
  const e = new ScenarioEngine(sc);
  e.start();
  e.tick(3); e.registerEvent("rcp");
  run(e, 60); e.registerEvent("choque");
  assert.equal(e.stateId, "s2");
  run(e, 100); e.registerEvent("adrenal"); e.registerEvent("choque");
  assert.equal(e.stateId, "s3");
  run(e, 100); e.registerEvent("amioda"); e.registerEvent("choque");
  assert.equal(e.stateId, "s4");
  assert.equal(e.vitals.rhythm, "sinusal");
  run(e, 200);
  assert.equal(e.stateId, "fim_ok");
  const m = e.metrics();
  assert.equal(m.outcome, "RCE");
  assert.equal(m.kpiAdherence, 1);
  assert.equal(m.counts.choque, 3);
});

test("Sepse: sem intervenção evolui para PCR; alerta de ATB antes de culturas", () => {
  const sc = SCENARIOS.find((s) => s.id === "sepse");
  const idle = new ScenarioEngine(sc);
  idle.start();
  run(idle, 1200);
  assert.equal(idle.stateId, "fim_pcr");
  assert.equal(idle.vitals.rhythm, "aesp");

  const e = new ScenarioEngine(sc);
  e.start();
  e.registerEvent("atb");
  assert.ok(e.log.some((l) => /antes das hemoculturas/.test(l.text)));
});

test("exportação CSV contém cabeçalho e uma linha por registro", () => {
  const e = new ScenarioEngine(SCENARIOS[0]);
  e.start(); e.registerEvent("o2"); run(e, 5);
  const lines = e.exportCSV().split("\n");
  assert.match(lines[0], /^t_s,relogio/);
  assert.equal(lines.length, e.log.length + 1);
});
