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
| Captura e debriefing | `public/captura.html` | Agenda, gravação multicâmera, anotações, debriefing, avaliações e relatórios |
| Regras da captura | `public/captura-core.js` | Recorrência e conflitos de agenda, pontuação, amostragem, relatórios, CSV/iCalendar |

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

## HelseCapture (gestão, gravação e debriefing)

`/captura.html` (botão **HelseCapture · Agenda · Debriefing** na tela inicial), com a identidade
visual Helse Solutions (barra marinho, menu lateral por módulos, tipografia IBM Plex, tema claro
e escuro; ícone HelseCapture em `public/img/`, botões de captura em vermelho vivo), reproduz, em implementação aberta, o fluxo de um sistema de gestão de simulação do tipo SimCapture:

| Etapa | No HelseCapture |
|---|---|
| Agenda | Calendário mensal de salas, reservas únicas ou recorrentes (até 1 ano), conflito de sala e de equipamento permanente, aprovação de pedidos de docentes, exportação `.ics` |
| Cursos e pessoas | Turmas com estudantes e docentes, importação/exportação CSV (ponte com Moodle/Canvas) |
| Cenários | Objetivos, simulador, biblioteca de anotações com atalhos, avaliações vinculadas, prazo de retenção; importa os cenários do motor |
| Gravação ao vivo | Até 4 vídeos sincronizados (webcams, captura de tela do monitor/PEP, fonte de teste) + microfone, via `MediaRecorder`; anotações por teclas 1–9 ou texto; avaliação ao vivo; transcrição opcional (Web Speech API) |
| Dados do simulador | A estação entra na sala de 4 dígitos e grava sinais vitais, mudanças de estado e intervenções registradas no roteiro (`{type:"event"}` retransmitido pelo servidor) |
| Debriefing | Reprodução sincronizada (grade, lado a lado, imagem sobre imagem, câmera única; 0,5–2×), linha do tempo com FC/SpO₂/PAS e marcadores, sinais vitais sobrepostos ao vídeo, notas |
| Avaliações | Checklists (feito/não feito), escalas, múltipla escolha, texto; itens críticos; tipos antes/após/reflexão (estudante) e avaliador/monitoramento (docente) |
| Relatórios | Horas por sala/curso/mês, horas-participante, desempenho por estudante, análise por item, anotações por categoria, exportação CSV |
| Perfis | Administrador, docente e estudante (estudante vê só as próprias sessões e responde os próprios instrumentos) |

Os dados ficam no navegador (IndexedDB): os vídeos são gravados em blocos de 2 s, de modo que
uma gravação interrompida é recuperada ao reabrir a página. A câmera exige contexto seguro
(`https://` ou `http://localhost`). Não há contas nem servidor de arquivos: para uso
multiusuário institucional seria preciso um back-end com autenticação, armazenamento de
vídeo e LTI 1.3. A gravação de pessoas exige consentimento e prazo de retenção (LGPD,
Lei 13.709/2018), ambos presentes na interface.


### Biblioteca de exemplo baseada em evidências

O botão **Carregar biblioteca** (Painel › Comece por aqui) cria 5 cursos, 13 cenários e 24 avaliações e
checklists (`public/captura-biblioteca.js`) construídos a partir de 24 artigos de *Clinical Simulation in
Nursing*, v. 105 (2025), incluindo a revisão 2025 dos padrões INACSL (prebriefing, facilitação, debriefing e
integridade profissional), e das diretrizes clínicas que eles usam (AHA 2020, ACOG 2020, ESC 2023). Cada
cenário e avaliação guarda suas referências completas com DOI; a lista consolidada aparece em **Cenários**.
Os itens são redação própria alinhada às fontes; instrumentos protegidos não são reproduzidos.

### Câmera fixa da sala por link

Em **Configurações › Salas › Câmeras** (ou em **Sessão ao vivo › + Câmera da sala por link**) cada sala
guarda o link das suas câmeras IP, que aparecem como fontes prontas ao iniciar uma sessão naquela sala.
O navegador aceita **WebRTC (WHEP)**, **HLS (.m3u8)**, **MJPEG**, imagem atualizada (snapshot) e MP4/WebM.
Câmeras só **RTSP** precisam de um conversor na rede da sala (MediaMTX ou go2rtc), que publica o mesmo
vídeo em WebRTC/HLS. HLS, MJPEG e snapshot passam por um canvas e exigem CORS liberado; uma página em
https não abre câmeras em http (conteúdo misto), então use o servidor local nesse caso.
