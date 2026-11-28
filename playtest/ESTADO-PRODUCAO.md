# Estado de produção — IA do emulador

Nota de handoff **enxuta** (fonte de verdade para retomar o trabalho sem reler o histórico).
Regra de manutenção: este arquivo é **reescrito**, não anexado; se passar de ~90 linhas, podar. Relatório completo com números e causas: `playtest/RELATORIO-IA-25min.md`.
Logs de 25 min e frames não entram aqui nem no índice — só as tabelas (`*/metrics.md`, `*/gate.md`).

## Onde está (2026-11-28)

- Branch `arena/240a0717-emulator-vga` → **PR #14** (base `main`, 22 arquivos).
- `npm run check:all` = **403 verificações / 7 suítes**, todas verdes. `tsc --noEmit` e `vite build` limpos.
- Portão §12 na sessão de 25 min: **PASS** (11 salas · 232 ticks presos). Sessão-base (código antigo): **FAIL** (3 salas · 9.221 ticks).

## Como re-verificar (3 comandos, ~40 s)

```bash
npm run check:all                                    # suítes puras + simulações
npm run check:playtest                               # 5 min de jogo real + portão (exit != 0 se regredir)
node playtest/analyze.mjs playtest/out2              # re-genera métricas/portão de uma sessão salva
```

Playtest completo (25 min, ~140 s de relógio, 19 MB de log local):
`OUT_DIR=playtest/out2 GAME_MINUTES=25 SNAPSHOT_EVERY=1800 npx tsx playtest/aiPlaytest.ts`.
Precisa de `npm i --no-save romdev-core-host@0.14.1 romdev-platform-snes@0.12.2` (não são dependência do app).
**Não rode os 25 min para checar um reparo pontual** — o probe de 5 min (`check:playtest`) usa o mesmo portão com limiar escalado.

## As 11 causas, uma linha cada (mecanismo → onde vive)

| # | causa do travamento / do mau comportamento | mecanismo | casa |
|---|---|---|---|
| 1 | detector se anulava (re-ancorava em qualquer Δy; fuga zerava a própria evidência) | `StuckSentinel` (ganho só horizontal; pouso novo exige corredor; **parada no ar conta**) | `src/lib/actionGuardian.ts` |
| 2 | inversão de direção sem memória, e o estado de veto nunca decaía | `EscapeLadder` de 5 degraus **em ciclo** (`NUDGE→REVERSE_PUSH→SWEEP→MAP_READ→BLOCK_ROOM`) | idem |
| 3 | nenhuma aposta tinha orçamento; `secretPaths.clear()` apagava o `tested` | `HypothesisLedger` (3 vidas, escopo de sala) + `sealCurrentRoom`/`unbreakableGates` | idem + `localVisionAI` |
| 4 | um tamanho de pulo só + piso de 90 ms na UI | `JumpModulator` (frames por vão, corta em `neededPx`) + `AI_TICK_MIN_MS=17` | idem + `emulatorBridge` |
| 5 | munição na porta era chute (SELECT aleatório eterno) | `SlotDriver` (teto por casa do HUD, gira até bater, `gaveUp`) | idem |
| 6 | parasita X absorvido sem prova de abate | `PreyChaser` (lock-on, abate provado no ponto, `SWEEP_LOOT` limitado) | idem |
| 7 | custo de FPS: `getState()` + PNG + varredura rw×rh por quadro | cache de RAM 90 ms, `drawImage`, bordas só, bomba de rAF com trava/backoff | `emulatorBridge.ts`, `localVisionAI.ts` |
| 8 | inventário do prólogo de Ceres lido como "todas as habilidades" ligava rotas falsas | `inventoryTrusted`/`inventoryIssue` (inclui "14/16 hab. com 99 HP") | `snesWram.ts` |
| 9 | spawn na sala nova empurrando o batente de entrada → re-disparava a porta (240 flips) | `entryCalm` (veto de chegada) + ban do **par** de salas no alvo **e** nas portas da sala | `localVisionAI.ts` |
| 10 | ida-e-volta pela sala contava como progresso (amplitude ≠ saldo) | `oscillating`: 8+ inversões vs amostra atrasada, latch do corredor (`roomXMin/roomXMax`) | `actionGuardian.ts` |
| 11 | prazo da porta nunca vencia (`=== 120` + reset ao piscar o sensor) | `DoorAttemptBudget` (`>=` com trava por porta, janela de tolerância de 8 ticks) | idem, usado em `localVisionAI` |
| 12 | **fuga com a área explodindo**: sem objetivo de fuga o planificador mandava para dentro; o carimbo `locked` sumia com a rota de saída; e as minhas próprias defesas anti-vaivém viravam o vaivém no batente | replan forçado na subida do contador + rota BFS até a sala de origem em grafo permissivo (`ignoreLockedDoors`) + `escapeReachedHome` (nenhuma porta é alvo; `entryCalm`/ban voltam a valer) + `capStep=2` na escada e mapa fechado durante o `TIME` | `localVisionAI.ts` + `EscapeLadder` |

## Ainda não provado (não vender como pronto)

- **`SlotDriver` numa porta verde/amarela real**: SELECT em 0,1 % dos ticks da sessão — nenhuma porta dessas apareceu na janela. Coberto por teste unitário, **não** por prova de ROM.
- **`githubExport.ts`**: embute uma cópia minificada do laço de IA que **não** recebeu o `actionGuardian.ts` e não tem suíte. Documentado no cabeçalho do arquivo.
- **"X-Fusion"** é suposição do repositório; o cabeçalho do ROM é `SNESFOREVER.COM.BR`. Constantes de sala/POV vieram da leitura de WRAM desta ROM.
- CI: `checks.yml` roda as suítes (bloqueante) e o canário de playtest (`continue-on-error`) — o job de canário ainda não foi executado em runner real.
- **Modo fuga (`TIME`/auto-destruição) não tem prova de ROM**: a sessão de 25 min nunca entra em contagem (`countdown ticks = 0`; o timer só liga depois da Mother Brain). Coberto por `mapAgentSim` §M (8 verificações de grafo/navegação), não pelo hardware. Para fechar isto, forçar o byte `0x0943` no harness.
- 588 ticks "congelados" na sessão final são a luta do Draygon: isentados no portão e no `EscapeLadder` **só** por chefe (isentaria "inimigo vivo" qualquer, escondia o bug original).

## Arquivos que importam

`src/lib/actionGuardian.ts` (puro, ~1.150 linhas, sem import de DOM) · `src/lib/localVisionAI.ts` (~7,9k linhas, o laço) · `src/lib/snesWram.ts` (leitura validada) · `src/lib/emulatorBridge.ts` (pump/caches) · `src/components/EmulatorPlayer.tsx` (painel "Guarda de ação") · `scripts/guardianCheck.ts` (especificação executável dos itens 1–5, 10–12 — 86 verificações, seções A–K) · `playtest/{aiPlaytest.ts,analyze.mjs,control.ts,probe.ts}` · `playtest/RELATORIO-IA-25min.md` (diagnóstico completo, §1–§14).
