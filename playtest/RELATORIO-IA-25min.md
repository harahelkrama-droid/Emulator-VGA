# Relatório técnico — playtest autônomo de 25 min · *Super Metroid: X-Fusion* (IA local da plataforma)

Data: 2026-11-28 · Branch: `arena/240a0717-emulator-vga` · ROM: `public/games/Super Metroid.sfc` (4 MB, header `SNESFOREVER.COM.BR`)
Evidências: `playtest/out/` (log por decisão, eventos, frames PNG, métricas) · Harness: `playtest/aiPlaytest.ts`, `playtest/control.ts`, `playtest/probe.ts`, `playtest/analyze.mjs`

---

## 0. TL;DR

1. **22 dos 25 minutos a IA passou empurrando a parede esquerda de uma única sala** (sala `0x8B7D`/35709), atirando com feixe comum num "bloco falso" na coordenada `(0,23)` — 5.678 das 10.259 decisões (55,3%) com exatamente o mesmo motivo.
2. **Um macro burro prova que a sala não era um obstáculo**: segurar `RIGHT` troca de sala em **180 frames (3,0 s de jogo)**. A IA, no mesmo estado exato reproduzido deterministicamente, gastou 22 min e ~9.200 decisões para não sair do lugar.
3. A causa raiz não é "pulo ruim": é uma **cadeia de 6 defeitos** (inventário fantasma lido do WRAM → detector de "bloco falso" que limpa a própria memória a cada tick → prioridade `COLLECT` que engole navegação/combate → detector de "estou perdido" que nunca atinge o limiar → escape forçado que escolhe a direção errada e zera a própria evidência → reset da U-Search dentro de `COLLECT`).
4. **Nenhum combate ocorreu em 25 min**: tabela de inimigos do WRAM retornou 0 em 100% dos ticks, `COMBAT` = 0 ticks, `SELECT` = 0 ticks (nunca selecionou míssil), 0 dano sofrido, 0 mortes. Não é mérito — é ausência de percepção + ausência de confronto.
5. Custo computacional é ótimo (média **0,586 ms/decisão**, p95 2 ms, máx 25 ms); o problema é 100% de **tomada de decisão**, não de performance.

---

## 1. Escopo: o que foi possível fazer e o que não foi

O pedido foi "jogar na aba atual do navegador, clicando na tela do emulador e pressionando Enter/Start". **Eu não tenho capacidade de enviar teclado/mouse para o browser do usuário** — o sandbox não expõe controle de navegador, então "clicar na sua aba" é fisicamente impossível para mim.

O que eu fiz, em vez disso — e que produz exatamente os dados pedidos (comportamento de exploração, combate e falhas da IA):

- **Subi a aplicação** (`npm run dev`, preview ativo na porta 3000). Nela o jogo abre, o EmulatorJS carrega o mesmo `Super Metroid.sfc` e o painel da IA fica disponível — o usuário pode jogar/assistir ali.
- **Reproduzi o laço de decisão da plataforma fora do browser** (`playtest/aiPlaytest.ts`): o *mesmo* `LocalVisionAgent.decide()` do app, o *mesmo* `readMetroidWram()`, o *mesmo* recorte de frame 240×160 do `emulatorBridge`, o *mesmo* calendário de decisão (teclas seguradas pela duração que o app dorme, 90–160 ms), só que rodando sobre um core snes9x (libretro/WASM) headless. Nada da IA foi stubado ou reescrito.
- **Joguei 25 minutos ininterruptos de tempo de jogo**: 90.006 frames emulados = 1.500,1 s de gameplay reais (10,8× o tempo real; 139 s de relógio). Menu, cutscene e sala são o jogo original — não uma simulação de brinquedo.
- **Rodei experimentos de controle** (`playtest/control.ts`, `playtest/probe.ts`) para separar "política ruim" de "o estado/emulador estava errado".

Fidelidade e o que muda em relação ao browser estão documentados na §10.

---

## 2. Arquitetura do harness

```
snes9x (romdev-core-host + romdev-platform-snes, WASM libretro)
   │  framebuffer 256x224 RGBA                      WRAM 0x20000 ($7E:0000)
   ▼                                                   ▼
letterbox 240x160 (igual emulatorBridge)      blob "RAM::" + WRAM  →  readMetroidWram()
   │  CapturedFrame {rgba, signature, fresh}          │  MetroidWramSnapshot
   ▼                                                   ▼
LocalVisionAgent.decide(frame, 'action', 'Super / Super Fácil', wram)  →  AIAction{keys[], time}
   │
   ▼  AIKey → RetroPad (A=pulo, B=tiro, X=corre, Y, L, R, START, SELECT, seta)
host.setInput({ports:[...]}) → step(N frames) → loop
```

- 1 decisão = `clamp(action.time, 90..160) ms` de teclas seguradas = 5–10 frames (média medida: **8,58 frames/decisão**, ~143 ms). É o mesmo ritmo do `EmulatorPlayer` (`sleep(Math.min(160, Math.max(90, action.time)))`).
- `fresh` alternado a cada tick para imitar o cache de frame do app (`maxCacheAgeMs` 220–800 ms conforme WRAM/inimigo/fullscreen).
- Log por tick em `session.jsonl` (10.259 linhas: keys, modo, motivo, sala, x/y, pose, HP, munição, portas, PLM, lost, cobertura, alvo, boss, countdown) e eventos em `events.jsonl` (ROOM, DAMAGE, DEATH, PHASE, AGENT_THROW).
- Screenshot PNG a cada 30 s de jogo em `playtest/out/frames/` — foi assim que este relatório foi escrito com a tela à vista.

---

## 3. Sessão em números

Fonte completa: `playtest/out/metrics.md` (gere com `node playtest/analyze.mjs`).

| métrica | valor |
|---|---|
| tempo de jogo | **1.500,1 s (25,00 min)** · 90.006 frames |
| decisões (ticks) | 10.259 |
| ticks em `gameState=8` (jogo ativo) | 9.638 (93,9%) |
| custo de decisão | média 0,586 ms · p95 2 ms · máx 25 ms |
| latência percebida | 8,58 frames ≈ 143 ms entre decisões |
| **salas visitadas** | **2** (35674 → 35709) — 3 transições no total |
| ticks na sala 35709 | 9.248 (**90,1%** da sessão) |
| ticks com `x = 37` na 35709 | 9.209 (**89,8%** ≈ 21,9 min) |
| maior período congelado (mesma sala + mesmo x) | 1.812 ticks ≈ 4,3 min (na prática contínuo por ~22 min) |
| \|Δx\| por decisão dentro da sala | média 0,23 px · **p95 = 0 px** · máx 43 px |
| estados (sala,x,y) distintos | 262 em 9.638 ticks |
| direções | LEFT 91,0% dos ticks · RIGHT 2,6% · UP 0,3% · DOWN 0,3% |
| botões | X (corre) 47,1% · B (tiro) 35,8% · A (pulo) 23,1% · **SELECT 0,0%** · START 0,6% · Y 0% |
| ocioso (`NONE`) | 554 ticks (5,4%) |
| modos | COLLECT 59,3% · EXPLORE 34,1% · CUTSCENE 4,7% · MENU 1,9% · **COMBAT 0%** |
| dano / mortes | 0 / 0 (HP travado em 99/99) |
| míssil disparado | 0 (mísseis 5/5 a sessão inteira; item do HUD nunca saiu de 0 = feixe) |
| inimigos percebidos | 0 em 100% dos ticks (PLMs: 0–1/sala) |
| detector "estou perdido" | severidade máx **1** (limiar 2) · `lost=true` em **0** ticks · causas: nenhuma |
| consulta ao mapa durante o travamento | 4 toques de START em 9.248 ticks |
| cobertura do mapa | pico 5% |
| backlog de portas trancadas | 0 (nunca registrou pendência) |
| auto-correções do caderno | 1 (`DOOR_COLOR_WRONG` → `HELPED`) |

---

## 4. Linha do tempo da sessão (tempo de jogo)

| t | o que aconteceu |
|---|---|
| 0:00–0:52 | título/seleção de arquivo. A IA saiu do menu **sozinha** (`MENU`, 192 ticks, "Entrando na seleção de arquivo") — sem macro. |
| 0:52–1:42 | cutscene de abertura do hack: modo `CUTSCENE`, "Pulando cena longa com X (padrão do hack)" — 452 ticks batendo X. Funcionou. |
| 1:42–2:37 | **sala 35674** (Ceres, 48×16 blocos): anda de x=18 a x=731 (713 px), atira, usa a porta da direita. Navegação legítima, sem travamento. 1 auto-correção registrada aqui (`DOOR_COLOR_WRONG`, porta `35674:LEFT@0:6-9` lida como BLUE e corrigida para PINK, raio 7→6 — `HELPED`). |
| 2:37 | entra na **sala 35709** (16×48 blocos — 1 tela de largura, 3 de altura) em x=216; o alvo `COLLECT` (bloco falso na parede esquerda) a puxa para x=37. |
| 2:40–25:00 | **travamento**: `x=37` permanente, y oscilando entre 144 e 384 (45 valores) — ela pula no lugar dentro do poço e cai de novo. Motivo dominante: `Atirando no bloco falso em (0,23) para revelar passagem` (5.678 ticks). Ciclos de 160 ticks: ~100 ticks de `COLLECT` atirando → `EXPLORE` "Forçando saída da sala (stuck=N ticks, dir=**LEFT**)" por 60 ticks → reseta contador → volta para `COLLECT`. 57+57+56... repetições idênticas, sempre `dir=LEFT`, contra a parede. |

Frame real da sala travada (controle, instante do travamento): Samus encostada na parede esquerda, corredor inteiro livre à direita, um vão/plataforma no centro-direita da tela. O mapa do jogo foi aberto 4 vezes em 22 minutos; a rota calculada era `FRONTIER · sala 0x8b7d` — **a própria sala onde ela já estava**, com rota de 1 passo, ou seja, um plano vazio.

---

## 5. O evento central, dissecado

### 5.1 Corrente causal (todas as peças verificadas no código)

| # | elo | onde |
|---|---|---|
| 1 | O WRAM lido como inventário ($7E:09A4/$7E:09A8) vale `0xfbbf`/`0x1007` numa Samus de 99 HP e 5 mísseis no prólogo de Ceres. O agente portanto **acredita ter as 16 habilidades**: Varia, Gravity, Morph, **X-Ray**, Space Jump, Hi-Jump, Speed Booster, Screw, Grapple, Spring Ball, Bombas e Wave/Ice/Spazer/Charge. | `src/lib/snesWram.ts:466-470` (offsets vanilla aplicados ao hack) |
| 2 | Com X-Ray "ligado", `detectSecretPaths()` varre **toda a borda da sala** e marca como "bloco falso" qualquer bloco sólido (tipo `0x8`) cujo byte BTS ≠ 0 — critério que pega parede de borda comum. Ela achou a célula `(0,23)`, exatamente o tijolo da parede esquerda na altura do pé dela. | `src/lib/localVisionAI.ts:4203-4247` |
| 3 | `detectSecretPaths()` chama `currNode.secretPaths.clear()` **todo tick**; `executeSecretPathTest()` marca `sp.tested = true` e... o `tested` é destruído no tick seguinte. Não existe contador de tentativas, cooldown, nem custo de falha para bloco falso (a regra de "3 tiros sem efeito" só existe para *portas*). | `:4212`, `:4318-4330`, `:4868-4871` |
| 4 | A prioridade do plano: `secretPathPending` → `resolvedMode = 'COLLECT'` **antes** de `BACKTRACK`/`COMBAT`/navegação. Dentro de `COLLECT`, o teste de caminho secreto é o primeiro `return`. Ou seja, o alvo fantasma sequestra a sessão inteira. | `:4868-4881`, `:4946-4955` |
| 5 | O detector de "estou perdido" nunca dispara: `progressStallTicks` só acumula enquanto `|x−anchorX| < 20` **e** `|y−anchorY| < 28`; como ela pula no fundo do poço, o deslocamento vertical passa de 28 px repetidamente → âncora é re-ancorada no ponto atual e o contador zera. Sem STALL, a severidade fica em 1 (só `noNewRoom`, +1); e `noProgress` está logicamente bloqueado por `noProgress && !noNewRoom`. Limiar de consulta do mapa é ≥2 → nunca ocorreu. | `:3102-3116`; `src/lib/mapStrategy.ts:225-227, 245-271` |
| 6 | A única mola de segurança restante — escape forçado — se autoboicota: ele dispara em `stuckInRoomTicks > 100`, escolhe a direção por `netMovement` de 30 amostras; com `|netMovement| < 10` ele inverte a *preferência de navegação* (não a direção do empurrão), escolhendo **LEFT, exatamente a parede contra a qual ela já estava presa**; roda por 60 ticks e então **zera `stuckInRoomTicks` e limpa `lastRoomPositions`**, apagando a evidência que alimentaria o passo 5 e reiniciando o ciclo de 160 ticks para sempre. | `:2504-2540` |
| 7 | E mesmo a U-Search (máquina de "subir/descender poço") foi neutralizada: `case 'COLLECT'` chama `this.resetUSearch()` na primeira linha. | `:4947` |

### 5.2 Experimento de controle (o mesmo estado, input burro)

`playtest/control.ts` fase A reproduziu o travamento **exatamente** (1.579 ticks; sala 35709, x=37, y=384, HP 99) — o laço é determinístico, então não é ruído do harness. Fase B, macros de 1–2 teclas partindo daquele frame:

| macro | resultado |
|---|---|
| `RIGHT` segurado 30 s | **trocou de sala em 180 frames (3,0 s)** → sala 35771, x=171 |
| `RIGHT`+`X` (corre) | travou em x=171 na 35771 (precisa de pulo — o próximo macro resolve) |
| `RIGHT`+`X`+pulo pulsado | +290 px de progresso |
| `RIGHT`+`DOWN` (morph) | **trocou de sala em 60 frames** → sala 35833 |
| `LEFT`+pulo | −184 px (volta para a parede) |
| `DOWN`+bombas, tiro para cima, porta-estouro | sem progresso nesta sala (sem bombas de verdade) |

Conclusão: a sala era trivialmente transponível para a direita; dois comandos diferentes de um humano casual (andar; andar+agachar) saem dela em 1–3 s. O custo da política atual não é "dificuldade", é **ausência de verificação de hipótese**.

### 5.3 Por que as suítes do repo não pegam isso

`npm run check:all` passou inteiro na mesma revisão (log em `playtest/out/check-all.log`): codex de chefes **89 ✓**, mapa **49 ✓**, autocorreção **43 ✓**, escolta **25 ✓**, agente de chefe **23 ✓**, simulação de navegação **77 ✓** — 306 verificações. Elas não pegam o travamento porque o mundo é sintético: o `mapAgentSim` planta o bloco falso *que existe*, entrega X-Ray *de propósito* e conta sucesso quando o agente vai até ele. Falta o inverso — "**se a hipótese do alvo for falsa, desista em N tentativas**" — que é justamente o que o frame real do hack quebra. Outra diferença: nas simulações o WRAM sintético é coerente (máscara de itens = máscara pedida pelo cenário); no ROM real a leitura é divergente (F2), e é essa divergência que arma o loop.

---

## 6. Catálogo de falhas observadas

Severidade: **P0** = destrói a sessão; **P1** = custo alto/risco; **P2** = qualidade/calibração.

| ID | falha | evidência | causa raiz | sev |
|---|---|---|---|---|
| F1 | LOOP INFINITO em sala travada | 9.209 ticks com `x=37`; p95 de \|Δx\| = 0 px | §5 elos 3+5+6 (sem *give-up*, evidência zerada) | P0 |
| F2 | Inventário fantasma (lê 16 habilidades quando não tem nenhuma) | `abil=16` o travamento inteiro; `itemsMask=0xfbbf`, `beamsMask=0x1007` com HUD 5/5 mísseis | offsets vanilla $7E:09A2–09CC aplicados a um hack que relocalizou a tabela | P0 |
| F3 | "Bloco falso" = parede | alvo `(0,23)` na parede esquerda, na altura do pé; 5.678 ticks de tiro | heurística `tipo 0x8 && bts≠0` em varredura de borda | P0 |
| F4 | Detector "estou perdido" estruturalmente incapaz | severidade 1 em 8.260 ticks, 0 em 1.999; `lost=true` 0 vezes | STALL zera com movimento vertical; `noProgress` suprimido por `noNewRoom` | P0 |
| F5 | Escape forçado escolhe a direção do empurrão e apaga a evidência | todos os 60+ ciclos com `dir=LEFT`; sawtooth de `stuck` 0→206 | inversão em cima de `preferredDirection` + `stuckInRoomTicks = 0` após 60 ticks | P1 |
| F6 | `COLLECT` canibaliza navegação, combate e U-Search | 0 ticks de `COMBAT`; `resetUSearch()` dentro de `COLLECT`; rota `FRONTIER` = sala atual | prioridade absoluta `secretPathPending`/`itemPending` | P1 |
| F7 | SELECT nunca é pressionado para trocar de munição | `SELECT` 0,0% · mísseis 5/5 · item do HUD 0 todo o tempo | fluxo de porta/bloco não exige arma secundária quando o alvo é "bloco falso"; sem teste de "tiro comum não fere → trocar" | P1 |
| F8 | Percepção de sala pobre: 0 inimigos em 100% dos ticks, 0–1 PLM/sala | `en=0`, `plm∈{0,1}`; `items=0` (nenhum item de sala detectado no prólogo) | tabela de inimigos `0x0F78+slot*0x40` e PLM `0x1C37…` (offsets vanilla) — o hack desloca | P1 |
| F9 | Sem memória de fracasso espacial | `dangerCells` nunca alimentado sem dano; backlog 0; 0 eventos de dano | só aprende célula perigosa quando apanha; travamento sem dano é invisível | P1 |
| F10 | Captura 240×160 para um vídeo 256×224 | 29+28 px de barra preta = **24% das colunas** entram na grade `GRID_COLS×GRID_ROWS` de `analyzeFrame` | `CAPTURE_W/H` fixos no `emulatorBridge.ts:52-53` (valores de GBA) | P2 |
| F11 | Latência de decisão alta para plataforma | 143 ms/decisão (8,6 frames) no app; +cache de frame de até 800 ms (3.000 ms em cutscene fullscreen) | cadência `sleep(90..160)` e `maxCacheAgeMs` no `EmulatorPlayer` | P2 |
| F12 | Custo O(largura×altura) por tick na varredura de borda | máx 25 ms/decisão (sala 128×16 → 2.048 células varridas por tick) | `for by, for bx { if (!isEdge) continue; }` | P2 |

---

## 7. O que a IA fez bem (para calibrar o diagnóstico)

- Saiu do título e da seleção de arquivo **sozinha** (`MENU`, 192 ticks) e **pulou a cutscene** batendo X no padrão do hack (452 ticks) — os dois pontos que antes travavam a sessão.
- Na primeira sala andou 713 px, usou tiro para limpar o caminho e achou a porta certa; `roomId`/`areaIndex`/`samusX/Y`/HP lidos corretamente (o pipeline WRAM está vivo, só com offsets parciais errados no hack).
- O caderno de autocorreção funcionou uma vez, no caso para o qual foi desenhado: cor de porta contradita pelo estado real → corrigiu `BLUE→PINK` e encolheu o raio da amostra, status `HELPED`.
- Zero travamentos em `AGENT_THROW` em 10.259 decisões; 0 decisões custaram mais que 25 ms; memória estável ao longo de 90.000 frames.
- Não desperdiçou munição especial nem tomou dano — mas aqui o "mérito" é omissão: não havia inimigo na percepção dela.

---

## 8. Correções propostas (em ordem de impacto)

**C1 — `tested` precisa sobreviver ao tick (mata F1/F3 em ~5 linhas).**
Em `detectSecretPaths()`, não limpar o mapa; em vez disso manter a marca por célula e adicionar orçamento de tentativa:

```ts
// era: currNode.secretPaths.clear();
const stale = new Set(currNode.secretPaths.keys());
// …para cada candidato: stale.delete(key); e preservar {tested, attempts} dos antigos.
const MAX_TRIES = 3;
if (sp.attempts >= MAX_TRIES) continue;       // nunca mais virar alvo nesta sala
sp.attempts++;                                // incrementado em executeSecretPathTest
this.unbreakableGates.add(`${roomId}:${bx}:${by}`); // reutiliza o mecanismo que já existe p/ porta
```

**C2 — STALL deve medir *progresso*, não deslocamento (§5 elo 5).**
Ancorar só quando houver progresso horizontal, e tratar `|Δy| > 28` como progresso apenas se a posição **final** da perna diverge do ponto de apoio (ou seja, se ela pousa em outro lugar). Alternativa mais barata: contar `stuckInRoomTicks` independentemente da âncora e usá-lo no `detectLost`:

```ts
const stalled = i.positionStallTicks >= LOST_STALL_TICKS || i.stuckInRoomTicks >= 120;
if (noProgress || noNewRoom) severity += 1;   // em vez de `noProgress && !noNewRoom`
```

**C3 — escape forçado: inverter o *empurrão*, não a *preferência*, e não apagar a prova (§5 elo 6).**

```ts
// netMovement ~ 0 ⇒ a direção do empurrão é a que está registrada em lastPushDir
this.forcedEscapeDir = this.lastPushDir === 'LEFT' ? 'RIGHT' : 'LEFT';
// após a janela de escape: NÃO zerar o contador; decair (stuckInRoomTicks = 40)
// e na 2ª tentativa seguida sem troca de sala, abrir o mapa (força severity 2)
```

**C4 — perfil de ROM para o WRAM (mata F2/F8 pela raiz).**
O header já é farejado (`SNESFOREVER.COM.BR`) para trocar o *checklist*; o mesmo perfil precisa trocar **offsets**. Validação barata, sem ROM nova: no primeiro tick em jogo, `itemsMask` deve bater com o menu de opções (o app já abre o menu para inventário) — se divergir, marcar `wram.inventoryUntrusted = true` e **desligar** todos os comportamentos condicionados a habilidade (X-Ray/secret path, space jump, lava por Gravity). Hoje `0xfbbf` habilita tudo isso de graça.

**C5 — teto global de permanência na sala (rede de segurança).**
Nada no agente limita "N ticks na mesma sala sem novo `roomId`". Com `stuckInRoomTicks >= 240` deveria: (1) inverter direção; (2) ler o mapa; (3) marcar célula como hostil; (4) se ainda assim 600 ticks, **sair da sala pela porta de entrada e marcar a sala como bloqueada no grafo** (backtracking forçado). Isso sozinho teria custado 10 s de jogo em vez de 22 min.

**C6 — orçamento de hipótese em toda ação repetitiva.**
A regra "3 tiros sem efeito na comporta → para de tratar como quebrável" existe; falta generalizar para *qualquer* ação cujo efeito esperado não é observado no tick seguinte (tiro em bloco, pulo em plataforma, SELECT em munição). O padrão do repo já é esse: medir o efeito real e abandonar o plano (é o `probeMode` do codex de chefes — falta no caminho de navegação).

**C7 — calibração SNES.** `CAPTURE_W/H` por core (256×224 para SNES, 240×160 para GBA) e varredura de borda em `detectSecretPaths` iterando só `edgeRows/edgeCols` já calculados (F10/F12).

**C8 — cadência.** Para plataforma/plataforma de plataforma: decidir a 60 Hz quando o WRAM está válido (o `decide()` custa 0,6 ms; 143 ms de latência é escolha do `sleep`, não limite do algoritmo), usando o frame cache só para a visão, já que a física/posição vem do WRAM (F11).

---

## 9. Desempenho do sistema

| aspecto | medição |
|---|---|
| decisão | média 0,586 ms · p95 2 ms · máx 25 ms (sala 128×16) |
| throughput do laço | 10,8× tempo real em headless (600+ fps de core, agente no meio) |
| latência de reação embutida no app | 90–160 ms de `sleep` + até 800 ms de frame cacheado (`maxCacheAgeMs`), ou seja **30–90 frames de voo cego** — suficiente para uma perna completa de pulo |
| consumo | estável, sem crescimento em 90.000 frames; `roomGraph`/`secretPaths` sem *eviction* (risco em sessão de horas, não medida aqui) |
| exceções | 0 `AGENT_THROW` |

---

## 10. Limitações do método (o que o harness **não** cobre)

1. Não é o EmulatorJS/libretro-js do browser: o estado vem do snes9x WASM, a renderização é a do core (sem WebGL/GPU), e `simulateInput` do EmulatorJS foi substituído por `setInput` do host. A física e o frame são os do jogo real; o *timing* de vsync não.
2. `readMetroidWram()` foi alimentado por um blob sintético `"RAM::" + WRAM(128 KB)` (o formato que ele espera do EmulatorJS). Consequência conhecida: salas que estendem `blockTypes` além de 128 KB (o guard `base+0x16402+totalBlocks`) perdem a análise de blocos — não foi o caso desta sessão.
3. O cache de frame é aproximado (alternado 50/50) em vez de seguir `maxCacheAgeMs` com `performance.now()`; e o `localStorage`/`IndexedDB` do app (caderno de autocorreção persistente, `ai_knowledge`) não existem no Node — o caderno desta sessão começou zerado.
4. Não houve humano comparando lado a lado na mesma sessão; os macros de controle são a comparação.
5. Sessão única (determinística). O `control.ts` confirma que o travamento se reproduz do zero, mas não mede variância entre sessões.

---

## 11. Reproduzir

```bash
npm install
npm install --no-save romdev-core-host romdev-platform-snes   # core snes9x WASM + host libretro

# 25 min de gameplay autônomo (139 s de relógio; ~10 MB de log)
GAME_MINUTES=25 MENU_BUDGET_TICKS=600 SNAPSHOT_EVERY=1800 npx tsx playtest/aiPlaytest.ts

# métricas da sessão
node playtest/analyze.mjs > playtest/out/metrics.md

# auditoria de percepção + macros de controle (prova de que a sala sai com RIGHT)
npx tsx playtest/probe.ts
npx tsx playtest/control.ts

# suítes próprias da plataforma (passam hoje)
npm run check:all
```

Artefatos: `playtest/out/session.jsonl` (10.259 decisões) · `events.jsonl` · `run.log` · `summary.json` · `frames/*.png` (tela amostrada durante a sessão) · `probe/probe.json` + `probe/*.png` · `control/control.json` + `control/*.png` · `out/metrics.md` · `out/check-all.log`.

---

## 12. O que este playtest deixou no repositório

Arquivos novos (nada do runtime do app foi modificado; `playtest/out/` foi adicionado ao `.gitignore` porque são 7 MB de log/frames de análise local):

| arquivo | papel |
|---|---|
| `playtest/aiPlaytest.ts` | o laço de playtest: snes9x headless + `LocalVisionAgent.decide()` + `readMetroidWram()` reais, log por tick, eventos (dano/morte/sala), snapshots PNG. `GAME_MINUTES`/`MENU_BUDGET_TICKS`/`SNAPSHOT_EVERY`/`AI_PROFILE`/`TARGET_DIFF` por env. |
| `playtest/control.ts` | reproduz o travamento do zero e testa macros de 1–2 teclas no mesmo estado — o que transforma "a IA andou mal" em "a sala saía com `RIGHT` em 3 s". |
| `playtest/probe.ts` | auditoria de percepção: o que o WRAM realmente contém (`0x09A4`…) versus o que o snapshot declara (habilidades, PLMs, tipos de bloco, portas) na sala do travamento. |
| `playtest/analyze.mjs` | gera `metrics.md` a partir do `session.jsonl` (carga de decisão, teclas, motivos, travamento, munição, severidade do "perdido"). |
| `playtest/boot.mjs` | smoke test do core (boot, fps, regiões de memória) — útil para revalidar o harness depois de um bump de dependência. |

Dependências do harness: `romdev-core-host` + `romdev-platform-snes` (snes9x WASM), instaladas com `--no-save` — não entraram no `package.json`. Se o harness virar parte estável do toolbox da plataforma, vale promovê-las a `devDependencies` e plugar `npx tsx playtest/aiPlaytest.ts --ticks=…` como `npm run check:playtest`, com uma asserção de regressão do tipo *"25 min de jogo ≥ N salas visitadas, zero sala com >240 ticks sem mudança de `roomId`"* — é o teste que faltava para a falha F1 não voltar.

Prova visual final: `playtest/out/frames/g0480s.png` (7:59) e `g1410s.png` (23:30) são pixel a pixel a mesma tela — Samus no mesmo tijolo, x=37, com o corredor inteiro livre à direita. Entre um frame e outro houve ~7.500 decisões da IA.

---

## 13. Re-teste depois das correções (o portão §12 executado nas duas pontas)

A sugestão do §12 — *"uma asserção de regressão do tipo '25 min ≥ N salas, zero sala com >240 ticks sem mudança de `roomId`'"* — foi implementada: `playtest/analyze.mjs` agora escreve `<dir>/gate.md` e marca `process.exitCode` quando reprova. Ela foi rodada **nas duas sessões**, mesmo harness, mesmo ROM, mesmos 25 min:

| métrica (25 min de jogo) | ANTES · `playtest/out` | DEPOIS · `playtest/out2` |
|---|---|---|
| **portão §12** | **FAIL** — R1: 3 salas · R2: 9.221 ticks preso @x=37 | **PASS** — R1: 11 salas · R2: 232 ticks |
| salas visitadas | 2 | 10 |
| estados (sala,x,y) distintos | 262 / 9.638 ticks | 4.080 / 10.608 ticks |
| cobertura do mapa | 5 % | 94 % |
| travamento *declarado* pelo agente | máx 206 ticks · ≥240 em **0** ticks | máx 491 ticks · ≥240 em **1.788** ticks |
| tecla dominante | LEFT 91,0 % · RIGHT 2,6 % | LEFT 63,3 % · RIGHT 29,6 % · UP 29,7 % |
| SELECT (girar slot de munição na porta) | 0,0 % | 0,1 % (8 ticks — as portas verdes/amarelas ainda não apareceram na janela) |
| dano | 0 eventos (ela nunca chegou em inimigo) | 24 eventos · 0 mortes |
| custo da decisão | 0,586 ms médio | 1,819 ms médio · 7,07 decisões/s ⇒ **1,3 % do núcleo**, nada no laço de render |

Duas coisas nesse quadro são o ponto do relatório, não detalhe:

1. **"travamento declarado ≥240 em 1.788 ticks" é a vitória.** O defeito original não era a agente ficar presa — era a plataforma *não saber*. Agora o `StuckSentinel` conta, o `EscapeLadder` sobe os cinco degraus e o resultado aparece na UI ("Guarda de ação"). O mesmo número na coluna ANTES é 0: cega.
2. **os 588 ticks congelados que restaram são a luta do Draygon** (`Combate · Draygon · Destruir as torres de energia`, 29,6 % da sessão). O portão isenta **só** luta de chefe — e essa isenção foi estreitada de propósito: a primeira versão isentava "qualquer inimigo vivo na sala", que é exatamente o que escondia os 9.221 ticks da sessão-base (havia um Readme na tela). O `EscapeLadder` usa a mesma regra: em briga a gente mede, não empurra.

Os quatro últimos reparos vieram do próprio portão, um por execução:

| # | sintoma medido no re-teste | causa no código | reparo |
|---|---|---|---|
| 8 | 8.226 ticks (66 % da sessão) atravessando `0x8B7D ↔ 0x8BBB` 240 vezes | o `gameState 0x0b` (transição) mantinha o direcional segurado até o fim; o spawn na sala nova acontecia **empurrando o batente por onde ela acabara de entrar** e re-disparava a porta. `planNextTarget` ainda dava à sala de origem o melhor score de fronteira. | veto de chegada (`entryCalm`: 14 ticks proibindo a porta de entrada, com a memória de colisão plantada em `recentBlockedSpots`) + banimento do **par** de salas (`bounceTally`/`bounceBan`, normalizado — contar por orientação `A->B`/`B->A` dividia o mesmo sintoma ao meio e nunca batia o limiar) aplicado também na lista de portas-alvo da sala, não só no `navTarget` |
| 9 | travamento parado em 90 ticks enquanto ela passava 9.160 ticks sentada em `0x8CB3 x=216` | o relógio do sentinela só andava **no chão** (`i.grounded`) — e na soleira de porta a heurística de chão deste hack lê "no ar" o tempo todo: ponto cego de 100 % no estado exato em que a sessão morria | `else if (i.grounded || (airborne && spread < 24))`: parada no ar também conta; subida de verdade continua se perdoando no pouso em chão novo |
| 10 | ida e volta pela sala sem sair do lugar, com o detector marcando stall = 48 | o critério é de **amplitude** (20 px): atravessar e voltar move 150 px por perna, a âncora anda a cada margem | `oscillating`: 8+ inversões de sentido com posição atual ≈ uma amostra atrasada (28 ticks) ⇒ latch do corredor da sala (`roomXMin/roomXMax`), âncora congelada e relógio andando. Travessia em linha reta **não** dispara (teste em `guardianCheck` I) |
| 11 | presa na soleira atirando para sempre, sem orçamento | só existia `noteDoorShot`, que age quando `door.blockedByWall` — a porta do caso não era "bloqueada por parede", logo nenhum contador valia | `doorAttempt`: 120 ticks na **mesma** porta sem troca de sala ⇒ porta marcada como trancada, destino trocado, releitura do mapa pedida (`forceMapReadTicks`), cena `Exploração · Porta desistida` |

Um reparo que **não** ficou: a primeira tentativa de resolver (8) foi "soltar o direcional depois de 5 ticks de scroll". Medido: pior — 67 % → 83 % dos ticks dentro do estado `0x0b`, porque neste hack a transição só anda com a tecla pressionada. A correção certa é vetar o *próximo passo* depois da chegada, não o input da transição.

`npm run check:all` fechou em **379 verificações / 7 suítes** (67 → 73 em `scripts/guardianCheck.ts`, com as seções H [o poço de 21,9 min em miniatura], I [pacing] e os dois ciclos da escada). `tsc --noEmit` limpo, `vite build` limpo.
