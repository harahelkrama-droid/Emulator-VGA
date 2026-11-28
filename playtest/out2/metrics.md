# Sessão de playtest — métricas

Fonte: `playtest/out2/session.jsonl` (12264 decisões)

## Cobertura

| métrica | valor |
|---|---|
| frames emulados | 90000 |
| tempo de jogo | 1500.0 s (25.00 min) |
| ticks dentro do jogo (gameState=8) | 10608 (86.5%) |
| decisões por segundo de jogo | 7.07 |
| frames entre decisões (média) | 7.03 → 117 ms de latência |
| custo da decisão | média 1.819 ms · p95 6 ms · máx 31 ms |
| frame novo vs reaproveitado | 50.0% fresco |

## Progresso

| métrica | valor |
|---|---|
| salas visitadas | 10 |
| sala 36081 | 5723 ticks (46.7%), ticks 2824–12227, 722 posições-x |
| sala 36151 | 3116 ticks (25.4%), ticks 907–12265, 219 posições-x |
| sala 35833 | 1097 ticks (8.9%), ticks 532–2565, 308 posições-x |
| sala 36019 | 737 ticks (6.0%), ticks 1141–11494, 171 posições-x |
| sala 35895 | 482 ticks (3.9%), ticks 1053–2674, 290 posições-x |
| sala 0 | 319 ticks (2.6%), ticks 1–319, 1 posições-x |
| sala 36116 | 301 ticks (2.5%), ticks 3532–12256, 134 posições-x |
| sala 35957 | 278 ticks (2.3%), ticks 1111–6502, 145 posições-x |
| sala 35674 | 95 ticks (0.8%), ticks 321–415, 43 posições-x |
| sala 35709 | 62 ticks (0.5%), ticks 416–477, 45 posições-x |
| sala 35771 | 54 ticks (0.4%), ticks 478–531, 46 posições-x |
| maior período congelado (mesma sala + mesmo x) | 588 ticks ≈ 69 s |
| |Δx| por decisão dentro da sala | média 4.43 px · p95 18 px · máx 41 px |
| estados (sala,x,y) distintos | 4080 em 10608 |
| cobertura do mapa | 94% |
| backlog de portas trancadas | 3 |
| deaths / dano | 0 mortes, 24 eventos de dano |

## Teclas

| tecla | ticks | % da sessão |
|---|---|---|
| LEFT | 7762 | 63.3% |
| RIGHT | 3631 | 29.6% |
| UP | 3642 | 29.7% |
| DOWN | 53 | 0.4% |
| A | 2612 | 21.3% |
| B | 6493 | 52.9% |
| X | 3700 | 30.2% |
| Y | 0 | 0.0% |
| SELECT | 8 | 0.1% |
| START | 131 | 1.1% |
| NONE | 1070 | 8.7% |

## Modos / decisões

| modo | ticks | % |
|---|---|---|
| EXPLORE | 7691 | 62.7% |
| COMBAT | 3656 | 29.8% |
| MENU | 462 | 3.8% |
| CUTSCENE | 455 | 3.7% |

| motivo (top 12) | ticks | % |
|---|---|---|
| Contornando obstáculo com segurança | 1135 | 9.3% |
| Entrando na próxima sala | 1084 | 8.8% |
| Tiro carregado · empurrão, não dano no alvo · torres são alvos fixos · 190px (dano 288) | 305 | 2.5% |
| Mísseis · empurrão, não dano no alvo · torres são alvos fixos · 167px (dano 0) | 284 | 2.3% |
| Contornando obstáculo por cima em busca de passagem | 275 | 2.2% |
| Avançando diálogo inicial da missão | 250 | 2.0% |
| Recuando do bloqueio para iniciar contorno em U | 240 | 2.0% |
| Pulando cena longa com X (padrão do hack) | 205 | 1.7% |
| Tiro carregado · empurrão, não dano no alvo · torres são alvos fixos · 190px (dano 576) | 141 | 1.1% |
| Tiro carregado · empurrão, não dano no alvo · torres são alvos fixos · 95px (dano 288) | 114 | 0.9% |
| Tiro carregado · empurrão, não dano no alvo · torres são alvos fixos · 126px (dano 576) | 111 | 0.9% |
| Fechando o mapa | 92 | 0.8% |

## Detector de "estou perdido"

| severidade | ticks |
|---|---|
| 0 | 6649 |
| 1 | 4912 |
| 2 | 86 |
| 3 | 617 |
| lost=true | 703 ticks |
| causas reportadas | CORNER, STALL |

## Munição / inventário observado

- mísseis: 0→1→2→3→4→5 · supers: 0 · power bombs: 0
- item do HUD selecionado: 0,1 (0 = feixe)
- nº de habilidades declaradas pelo WRAM: 0,16
- energia: 0–99 / 99
- inimigos na tela: 0,1 · PLMs: 0,1,7,3,5,2,4,8,15,14 · portas: 0,1,3,2,4

## Eventos

- ROOM: 71
- DAMAGE: 24
- PHASE: 2
- RUN_START: 1
- contador de travamento da sala: máx 491 ticks; ≥100 em 2908 ticks (23.7%)


## Portão de regressão (§12)

- PASS · R1 salas visitadas: 11 (mínimo 5 em 25 min)
- PASS · R2 maior trecho preso (mesma sala, sem 20 px de ganho horizontal, fora de luta de chefe): 232 ticks @tick 877 sala 35833 x=117
- contexto · maior período na mesma sala (em movimento conta): 735 ticks @sala 36081
- contexto · SELECT pressionado em 0.1% dos ticks (porta verde/amarela exige girar o slot)
- contexto · decisões por segundo de jogo: 8.18 · custo médio 1.82 ms/decisão
- contexto · travamento declarado pelo agente: máx 491 ticks, ≥240 em 1788 ticks
- contexto · correções de si mesma registradas: 4
- contexto · ticks com aperto curto (≤3 frames): 0 de 12264 (0.0%)

**GATE: PASS**
