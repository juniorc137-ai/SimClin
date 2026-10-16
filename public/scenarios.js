/* ════════════════════════════════════════════════════════════════════════
 * SimClin – Biblioteca de cenários programados (modo automático)
 *
 * Cada cenário segue o formato lido por sim-engine.js:
 *   events   : menu de intervenções que o instrutor registra ("tap to log")
 *   handlers : respostas automáticas a eventos (on) ou a condições (when)
 *   states   : estados do paciente, com vitals, trends, transitions, timeout
 *   kpis     : indicadores de desempenho para o debriefing (tempo-alvo em s)
 *
 * Os tempos são comprimidos em relação à prática real (sessão de 15–20 min).
 * Referências clínicas: Surviving Sepsis Campaign 2021 (Evans et al., Crit
 * Care Med 2021;49:e1063–e1143); AHA Guidelines for CPR and ECC 2020
 * (Panchal et al., Circulation 2020;142:S366–S468) e atualização focada 2023
 * (Perman et al., Circulation 2024;149:e254–e273).
 * ════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.SCENARIO_PROGRAMS = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Resposta compensatória genérica (exemplo análogo ao descrito no
  // SimDesigner Help: "SpO₂ < 97% → FC aumenta 10 bpm"), aqui com limiar 90%.
  const hypoxiaTachy = {
    id: "hipoxia_taqui", when: { param: "spo2", op: "<", value: 90 }, cooldown: 60,
    actions: [{ add: { hr: 8 } }], log: "Resposta compensatória: hipoxemia → taquicardia",
  };

  const SEPSE = {
    id: "sepse",
    title: "Choque séptico – pacote da 1ª hora",
    summary: "Mulher, 68 a, pneumonia comunitária, confusa, pele moteada. Avaliar reconhecimento de choque e execução do pacote de 1 hora.",
    objectives: [
      "Reconhecer sepse com hipoperfusão (PAM < 65 mmHg)",
      "Coletar lactato e hemoculturas antes do antimicrobiano",
      "Iniciar antimicrobiano e cristaloide 30 mL/kg precocemente",
      "Iniciar noradrenalina se PAM < 65 mmHg após volume",
    ],
    baseline: { rhythm: "tachycardia", hr: 118, spo2: 93, rr: 24, temp: 38.8, sbp: 92, dbp: 52 },
    events: [
      { id: "o2",       label: "O₂ suplementar",            cat: "Via aérea/Respiração" },
      { id: "monit",    label: "Monitorização + acesso IV", cat: "Circulação" },
      { id: "lactato",  label: "Lactato sérico",            cat: "Diagnóstico" },
      { id: "hemocult", label: "Hemoculturas",              cat: "Diagnóstico" },
      { id: "atb",      label: "Antimicrobiano amplo",      cat: "Tratamento" },
      { id: "volume",   label: "Cristaloide 30 mL/kg",      cat: "Tratamento" },
      { id: "nora",     label: "Noradrenalina",             cat: "Tratamento" },
      { id: "ajuda",    label: "Chamar ajuda / UTI",        cat: "Comunicação" },
    ],
    handlers: [
      hypoxiaTachy,
      { id: "o2_resp", on: "o2", once: true, actions: [{ trend: { spo2: { by: 4, duration: 60 }, rr: { by: -2, duration: 90 } } }],
        log: "O₂ → SpO₂ em melhora" },
      { id: "atb_antes_cult", on: "atb", once: true, if: { not: { event: "hemocult", scope: "session" } },
        actions: [], log: "⚠ Antimicrobiano administrado antes das hemoculturas" },
    ],
    initial: "s1",
    states: {
      s1: {
        label: "Sepse com hipoperfusão",
        hint: "Paciente piora progressivamente se nada for feito.",
        vitals: { rhythm: "tachycardia", hr: 118, spo2: 93, rr: 24, temp: 38.8, sbp: 92, dbp: 52 },
        trends: { sbp: { to: 78, duration: 300 }, dbp: { to: 42, duration: 300 }, hr: { to: 130, duration: 300 } },
        transitions: [{ if: { all: [{ event: "volume" }, { event: "atb" }] }, goto: "s2", reason: "volume + antimicrobiano" }],
        timeout: { after: 480, goto: "s3" },
      },
      s2: {
        label: "Resposta parcial ao volume",
        hint: "PAM permanece < 65 mmHg: esperado iniciar vasopressor.",
        trends: { sbp: { to: 86, duration: 120 }, dbp: { to: 50, duration: 120 }, hr: { to: 112, duration: 150 } },
        transitions: [{ if: { event: "nora", scope: "session" }, goto: "s4", reason: "vasopressor" }],
        timeout: { after: 300, goto: "s3" },
      },
      s3: {
        label: "Choque refratário",
        hint: "Hipotensão grave, hipoxemia. Última janela de resgate.",
        vitals: { rhythm: "tachycardia" },
        trends: { sbp: { to: 66, duration: 90 }, dbp: { to: 36, duration: 90 }, hr: { to: 142, duration: 90 }, spo2: { to: 87, duration: 120 }, rr: { to: 32, duration: 90 } },
        transitions: [{ if: { all: [{ event: "nora", scope: "session" }, { event: "volume", scope: "session" }, { event: "atb", scope: "session" }] }, goto: "s4", reason: "resgate" }],
        timeout: { after: 300, goto: "fim_pcr" },
      },
      s4: {
        label: "Estabilização hemodinâmica",
        trends: { sbp: { to: 108, duration: 150 }, dbp: { to: 64, duration: 150 }, hr: { to: 98, duration: 180 }, spo2: { to: 95, duration: 120 }, rr: { to: 20, duration: 150 }, temp: { to: 38.2, duration: 180 } },
        timeout: { after: 180, goto: "fim_ok", reason: "observação concluída" },
      },
      fim_ok:  { label: "Desfecho favorável – transferência à UTI", end: true, outcome: "Estabilizado" },
      fim_pcr: { label: "PCR em AESP", end: true, outcome: "Óbito/PCR",
        vitals: { rhythm: "aesp", hr: 0, spo2: 0, rr: 0, sbp: 0, dbp: 0 } },
    },
    kpis: [
      { label: "Lactato coletado",           event: "lactato",  target: 300 },
      { label: "Hemoculturas coletadas",     event: "hemocult", target: 420 },
      { label: "Antimicrobiano iniciado",    event: "atb",      target: 480 },
      { label: "Cristaloide 30 mL/kg",       event: "volume",   target: 480 },
      { label: "Noradrenalina se PAM < 65",  event: "nora",     target: 780 },
    ],
  };

  const FA_RVR = {
    id: "fa_rvr",
    title: "FA com RVR → instabilidade",
    summary: "Homem, 72 a, palpitações há 6 h. Avaliar reconhecimento de instabilidade e cardioversão elétrica sincronizada.",
    objectives: [
      "Obter ECG de 12 derivações e identificar FA com RVR",
      "Reconhecer sinais de instabilidade (hipotensão, hipoperfusão)",
      "Realizar cardioversão sincronizada com sedoanalgesia",
    ],
    baseline: { rhythm: "afib", hr: 138, spo2: 95, rr: 20, temp: 36.7, sbp: 108, dbp: 70 },
    events: [
      { id: "ecg12",   label: "ECG 12 derivações",          cat: "Diagnóstico" },
      { id: "acesso",  label: "Acesso IV + monitorização",  cat: "Circulação" },
      { id: "ctrl_fc", label: "Controle de FC (β-bloq./BCC)", cat: "Tratamento" },
      { id: "sedacao", label: "Sedoanalgesia",              cat: "Tratamento" },
      { id: "cv_sinc", label: "Cardioversão sincronizada",  cat: "Tratamento" },
      { id: "ajuda",   label: "Chamar ajuda",               cat: "Comunicação" },
    ],
    handlers: [
      { id: "cv_sem_sed", on: "cv_sinc", once: true, if: { not: { event: "sedacao", scope: "session" } },
        actions: [], log: "⚠ Cardioversão sem sedoanalgesia registrada" },
    ],
    initial: "s1",
    states: {
      s1: {
        label: "FA com RVR – estável",
        vitals: { rhythm: "afib", hr: 138, spo2: 95, rr: 20, sbp: 108, dbp: 70 },
        transitions: [{ if: { event: "ctrl_fc" }, goto: "s2", reason: "controle de FC" }],
        timeout: { after: 240, goto: "s3", reason: "deterioração" },
      },
      s2: {
        label: "FA com FC controlada",
        trends: { hr: { to: 96, duration: 120 }, sbp: { to: 118, duration: 120 }, dbp: { to: 74, duration: 120 } },
        timeout: { after: 180, goto: "fim_ok" },
      },
      s3: {
        label: "FA instável (hipotensão)",
        hint: "Instabilidade: indicação de cardioversão sincronizada.",
        trends: { hr: { to: 168, duration: 60 }, sbp: { to: 76, duration: 90 }, dbp: { to: 44, duration: 90 }, spo2: { to: 90, duration: 90 }, rr: { to: 26, duration: 60 } },
        transitions: [{ if: { event: "cv_sinc" }, goto: "s4", reason: "cardioversão" }],
        timeout: { after: 300, goto: "fim_mau" },
      },
      s4: {
        label: "Ritmo sinusal pós-cardioversão",
        vitals: { rhythm: "sinusal", hr: 88 },
        trends: { sbp: { to: 112, duration: 90 }, dbp: { to: 70, duration: 90 }, spo2: { to: 96, duration: 90 }, rr: { to: 18, duration: 90 } },
        timeout: { after: 150, goto: "fim_ok" },
      },
      fim_ok:  { label: "Desfecho favorável", end: true, outcome: "Estabilizado" },
      fim_mau: { label: "Choque cardiogênico", end: true, outcome: "Deterioração não tratada",
        vitals: { rhythm: "vt", hr: 176, sbp: 62, dbp: 34, spo2: 85 } },
    },
    kpis: [
      { label: "ECG 12 derivações",          event: "ecg12",   target: 120 },
      { label: "Sedoanalgesia antes da CVE", event: "sedacao" },
      { label: "Cardioversão sincronizada",  event: "cv_sinc", target: 360 },
    ],
  };

  const PCR_FV = {
    id: "pcr_fv",
    title: "PCR em FV/TV sem pulso (ACLS)",
    summary: "Homem, 58 a, colapso na enfermaria. Avaliar RCP de alta qualidade, desfibrilação precoce e drogas no tempo correto.",
    objectives: [
      "Iniciar compressões torácicas imediatamente",
      "Desfibrilar precocemente o ritmo chocável",
      "Administrar adrenalina após o 2º choque e amiodarona após o 3º",
      "Reconhecer o RCE e iniciar cuidados pós-PCR",
    ],
    baseline: { rhythm: "vf", hr: 0, spo2: 0, rr: 0, temp: 36.4, sbp: 0, dbp: 0 },
    events: [
      { id: "rcp",      label: "Iniciar RCP",               cat: "RCP" },
      { id: "choque",   label: "Desfibrilação",             cat: "RCP" },
      { id: "adrenal",  label: "Adrenalina 1 mg IV/IO",     cat: "Drogas" },
      { id: "amioda",   label: "Amiodarona 300 mg",         cat: "Drogas" },
      { id: "via_aerea",label: "Via aérea avançada",        cat: "Via aérea" },
      { id: "checa",    label: "Checagem de ritmo/pulso",   cat: "RCP" },
      { id: "ajuda",    label: "Acionar código azul",       cat: "Comunicação" },
    ],
    handlers: [
      { id: "choque_sem_rcp", on: "choque", once: true, if: { not: { event: "rcp", scope: "session" } },
        actions: [], log: "⚠ Choque antes de iniciar compressões" },
    ],
    initial: "s1",
    states: {
      s1: {
        label: "Colapso – FV",
        vitals: { rhythm: "vf", hr: 0, spo2: 0, rr: 0, sbp: 0, dbp: 0 },
        transitions: [{ if: { all: [{ event: "rcp", scope: "session" }, { event: "choque" }] }, goto: "s2", reason: "1º choque" }],
        timeout: { after: 240, goto: "fim_mau" },
      },
      s2: {
        label: "FV persistente após 1º choque",
        transitions: [{ if: { all: [{ event: "choque" }, { event: "adrenal", scope: "session" }] }, goto: "s3", reason: "2º choque + adrenalina" }],
        timeout: { after: 300, goto: "fim_mau" },
      },
      s3: {
        label: "FV refratária",
        transitions: [{ if: { all: [{ event: "choque" }, { event: "amioda", scope: "session" }] }, goto: "s4", reason: "3º choque + amiodarona" }],
        timeout: { after: 300, goto: "fim_mau" },
      },
      s4: {
        label: "RCE – cuidados pós-PCR",
        vitals: { rhythm: "sinusal", hr: 108, spo2: 88, rr: 12, sbp: 84, dbp: 52 },
        trends: { spo2: { to: 95, duration: 120 }, sbp: { to: 104, duration: 150 }, dbp: { to: 64, duration: 150 }, hr: { to: 96, duration: 150 } },
        timeout: { after: 180, goto: "fim_ok" },
      },
      fim_ok:  { label: "RCE sustentado", end: true, outcome: "RCE" },
      fim_mau: { label: "Assistolia", end: true, outcome: "Sem RCE",
        vitals: { rhythm: "asystole", hr: 0, spo2: 0, rr: 0, sbp: 0, dbp: 0 } },
    },
    kpis: [
      { label: "Início da RCP",        event: "rcp",     target: 10 },
      { label: "1º choque",            event: "choque",  target: 120 },
      { label: "1ª adrenalina",        event: "adrenal", target: 300 },
      { label: "Amiodarona",           event: "amioda",  target: 480 },
    ],
  };

  return [SEPSE, FA_RVR, PCR_FV];
});
