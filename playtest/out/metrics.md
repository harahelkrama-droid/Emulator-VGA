# Sessão de playtest — métricas

Fonte: `playtest/out/session.jsonl` (10259 decisões)

## Cobertura

| métrica | valor |
|---|---|
| frames emulados | 90006 |
| tempo de jogo | 1500.1 s (25.00 min) |
| ticks dentro do jogo (gameState=8) | 9638 (93.9%) |
| decisões por segundo de jogo | 6.42 |
| frames entre decisões (média) | 8.58 → 143 ms de latência |
| custo da decisão | média 0.586 ms · p95 2 ms · máx 25 ms |
| frame novo vs reaproveitado | 50.0% fresco |

## Progresso

| métrica | valor |
|---|---|
| salas visitadas | 2 |
| sala 35709 | 9248 ticks (90.1%), ticks 1013–10260, 18 posições-x |
| sala 0 | 599 ticks (5.8%), ticks 1–599, 1 posições-x |
| sala 35674 | 412 ticks (4.0%), ticks 601–1012, 102 posições-x |
| maior período congelado (mesma sala + mesmo x) | 1812 ticks ≈ 259 s |
| |Δx| por decisão dentro da sala | média 0.23 px · p95 0 px · máx 43 px |
| estados (sala,x,y) distintos | 262 em 9638 |
| cobertura do mapa | 5% |
| backlog de portas trancadas | 0 |
| deaths / dano | 0 mortes, 0 eventos de dano |

## Teclas

| tecla | ticks | % da sessão |
|---|---|---|
| LEFT | 9331 | 91.0% |
| RIGHT | 269 | 2.6% |
| UP | 26 | 0.3% |
| DOWN | 30 | 0.3% |
| A | 2372 | 23.1% |
| B | 3668 | 35.8% |
| X | 4837 | 47.1% |
| Y | 0 | 0.0% |
| SELECT | 0 | 0.0% |
| START | 59 | 0.6% |
| NONE | 554 | 5.4% |

## Modos / decisões

| modo | ticks | % |
|---|---|---|
| COLLECT | 6085 | 59.3% |
| EXPLORE | 3500 | 34.1% |
| CUTSCENE | 482 | 4.7% |
| MENU | 192 | 1.9% |

| motivo (top 12) | ticks | % |
|---|---|---|
| Atirando no bloco falso em (0,23) para revelar passagem | 5678 | 55.3% |
| Pulando cena longa com X (padrão do hack) | 452 | 4.4% |
| Atirando no bloco falso em (47,8) para revelar passagem | 101 | 1.0% |
| Entrando na seleção de arquivo | 76 | 0.7% |
| Forçando saída da sala (stuck=102 ticks, dir=LEFT) | 57 | 0.6% |
| Forçando saída da sala (stuck=104 ticks, dir=LEFT) | 57 | 0.6% |
| Forçando saída da sala (stuck=124 ticks, dir=LEFT) | 57 | 0.6% |
| Forçando saída da sala (stuck=139 ticks, dir=LEFT) | 57 | 0.6% |
| Forçando saída da sala (stuck=117 ticks, dir=LEFT) | 56 | 0.5% |
| Forçando saída da sala (stuck=132 ticks, dir=LEFT) | 56 | 0.5% |
| Forçando saída da sala (stuck=154 ticks, dir=LEFT) | 56 | 0.5% |
| Forçando saída da sala (stuck=169 ticks, dir=LEFT) | 56 | 0.5% |

## Detector de "estou perdido"

| severidade | ticks |
|---|---|
| 0 | 1999 |
| 1 | 8260 |
| lost=true | 0 ticks |
| causas reportadas | nenhuma |

## Munição / inventário observado

- mísseis: 0→5 · supers: 0 · power bombs: 0
- item do HUD selecionado: 0 (0 = feixe)
- nº de habilidades declaradas pelo WRAM: 0,16
- energia: 0–99 / 99
- inimigos na tela: 0 · PLMs: 0,1 · portas: 0,1,3

## Eventos

- ROOM: 3
- PHASE: 2
- RUN_START: 1
- contador de travamento da sala: máx 206 ticks; ≥100 em 3597 ticks (35.1%)


## Portão de regressão (§12)

- FAIL · R1 salas visitadas: 3 (mínimo 6 em 25 min)
- FAIL · R2 maior trecho preso (mesma sala, sem 20 px de ganho horizontal, fora de luta de chefe): 9221 ticks · limite 250 @tick 10260 sala 35709 x=37
- contexto · maior período na mesma sala (em movimento conta): 9230 ticks @sala 35709
- contexto · SELECT pressionado em 0.0% dos ticks (porta verde/amarela exige girar o slot)
- contexto · decisões por segundo de jogo: 6.84 · custo médio 0.59 ms/decisão
- contexto · travamento declarado pelo agente: máx 206 ticks, ≥240 em 0 ticks
- contexto · ticks com contagem regressiva da área (modo fuga): 0 · a janela nunca entrou em fuga — o portão NÃO cobre o modo fuga (ver mapAgentSim §M)
- contexto · correções de si mesma registradas: 1
- contexto · ticks com aperto curto (≤3 frames): 0 de 10259 (0.0%)

**GATE: FAIL**
