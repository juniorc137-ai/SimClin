# SimClin – Monitor Cardíaco para Simulação Clínica

Monitor multiparamétrico simulado (ECG, SpO₂, respiração, PA, temperatura) controlado
remotamente por um instrutor, via WebSocket, em salas identificadas por código de 4 dígitos.

```bash
npm install
npm start        # http://localhost:3000
npm test         # testes do motor de cenários (node:test, sem dependências extras)
```

## Arquitetura

| Componente | Arquivo | Função |
|---|---|---|
| Servidor de retransmissão | `server.js` | Express + WebSocket; o instrutor publica o estado e os monitores da sala o recebem |
| Monitor do paciente | `public/index.html` (tela *Monitor*) | Gera as ondas (ECG, pletismografia, respiração), alarmes visuais e sonoros |
| Aplicação do instrutor | `public/index.html` (tela *Instrutor*) | Modo manual (cenários rápidos, ritmo, vitais) e modo automático (*Roteiro*) |
| Motor de cenários | `public/sim-engine.js` | Máquina de estados com tendências, eventos, *handlers*, gatilhos e registro de sessão |
| Biblioteca de cenários | `public/scenarios.js` | Cenários programados (sepse, FA com RVR, PCR em FV) |

### Motor de cenários (modo automático)

O desenho reproduz, em versão aberta e simplificada, os conceitos documentados pela Laerdal
para o SimDesigner/LLEAP (*SimDesigner Help*, 2020, Rev. T):

| Conceito Laerdal | No SimClin | Comportamento |
|---|---|---|
| **Cenário**: evolução sequencial pré-programada de estados, com vários desfechos | objeto em `scenarios.js` | estados, eventos, handlers e indicadores |
| **Estado**: condição do paciente num período | `states.<id>` | `vitals` aplicados na entrada, `trends`, `transitions`, `timeout` |
| **Tendência** (*trend*): mudança de parâmetros que depende só do tempo | `trends: { sbp: { to, duration } }` ou `{ by, duration }` | interpolação suavizada até o alvo |
| **Evento**: intervenção dos participantes | `events[]` | botões "toque para registrar" na aba *Roteiro* |
| **Handler**: regra entre eventos e respostas automáticas | `handlers[]` com `on` (evento) ou `when` (condição) | ações `set`, `add`, `trend`, `log`, `goto` |
| **Gatilho** com AND/OR, contadores e limite de tempo | `transitions[].if`, `timeout` | `{all}`, `{any}`, `{not}`, `{event, count, scope}`, `{param, op, value}`, `{elapsed}` |
| Gatilhos zerados ao entrar num estado | contadores por estado | `scope: "session"` usa o contador da sessão inteira |
| Modo manual sobrepondo o automático | sliders/ritmos durante o roteiro | ajuste vira *override* registrado e cancela a tendência daquele parâmetro |
| Registro de eventos com carimbo de tempo e vitais | `log`, aba *Debriefing* | indicadores com tempo-alvo, trajetória de estados, comentários, exportação CSV/JSON |

O motor é determinístico (o tempo só avança por `tick(dt)`), o que permite testar
cenários automaticamente (`test/engine.test.js`) e reproduzir sessões.

### Como escrever um cenário

```js
{
  id: "meu_caso", title: "…", summary: "…", objectives: ["…"],
  baseline: { rhythm: "sinusal", hr: 90, spo2: 94, rr: 22, temp: 37, sbp: 110, dbp: 70 },
  events:   [{ id: "o2", label: "O₂ suplementar", cat: "Respiração" }],
  handlers: [{ id: "o2_resp", on: "o2", once: true,
               actions: [{ trend: { spo2: { by: 4, duration: 60 } } }], log: "SpO₂ melhora" }],
  initial: "s1",
  states: {
    s1: { label: "Apresentação", trends: { spo2: { to: 86, duration: 300 } },
          transitions: [{ if: { event: "o2" }, goto: "s2" }],
          timeout: { after: 360, goto: "pior" } },
    s2:   { label: "Melhora", end: true, outcome: "Estabilizado" },
    pior: { label: "Insuficiência respiratória", end: true, outcome: "Deterioração" },
  },
  kpis: [{ label: "O₂ ofertado", event: "o2", target: 120 }],
}
```

Valide com `SimEngine.validateScenario(cenario)` (lista vazia = válido) e adicione um
teste em `test/engine.test.js` cobrindo o caminho ideal e o caminho sem intervenção.

### Limites conhecidos

- Não há modelo fisiológico contínuo (equações cardiovasculares/respiratórias). As respostas
  são roteirizadas, como nos cenários de estados e tendências; para fisiologia acoplada, o
  caminho natural seria integrar um motor aberto como o Pulse Physiology Engine
  (Bray et al., 2019, doi:10.1007/s42399-019-00053-w).
- O motor roda no navegador do instrutor; se a página do instrutor for fechada, o roteiro
  em andamento é perdido (os monitores mantêm o último estado).
