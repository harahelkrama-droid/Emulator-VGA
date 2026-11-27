# RetroPlay (`harahelkrama-droid/Emulator-GBA`)

Biblioteca web responsiva para jogos de **Game Boy Advance** e **Super Nintendo** com **IA local integrada sem necessidade de API**, leitura de memória WRAM em tempo real, filtragem de objetos estáticos do cenário, análise de peças de armadura/habilidades e controle de reset de energia.

## Estrutura do projeto

- `index.html` / `src/` — aplicação React + Vite completa (biblioteca, player EmulatorJS, saves IndexedDB, IA local e exportador de `index.html` único para GitHub Pages).
- `public/atualizacoes.html` — notas de versão e roadmap.
- `public/games.json` — catálogo lido pela biblioteca.
- `public/games/` — ROMs autorizadas localmente (ignoradas no Git por padrão pelo `.gitignore`).
- `public/assets/` — capas em PNG/JPG/JPEG/WEBP.
- `public/manifest.webmanifest`, `public/service-worker.js`, `public/app-icon.svg` — suporte PWA e cache offline resiliente.

## Cuidado importante ao publicar no GitHub Pages

1. O `.gitignore` ignora arquivos `*.gba`, `*.sfc` e `*.smc` por padrão para evitar envio acidental de ROMs sem autorização.
2. **Atenção ao `games.json`**: se o seu repositório no GitHub não incluir os arquivos em `games/`, mantenha `games.json` como `[]` no GitHub Pages (caso contrário, clicar em um cartão gerará erro 404 ao carregar a ROM) e use o botão **Abrir ROM** para jogar arquivos locais, ou envie ROMs autorizadas junto com o `games.json` correspondente.
3. Para publicar apenas o site estático atualizado no GitHub Pages (`Settings → Pages → Deploy from a branch → main / root`), clique em **Baixar index.html p/ GitHub** dentro do app e substitua `index.html`, `atualizacoes.html`, `manifest.webmanifest`, `service-worker.js` e `app-icon.svg` na raiz do repositório.

## Codex de Chefes (guia estratégico consultável)

`src/lib/bossCodex.ts` é uma base de conhecimento declarativa com **como vencer** cada chefe de Super Metroid / *X-Fusion*: Ridley (Ceres e Norfair), Torizo, Spore Spawn, Kraid, Crocomire, Phantoon, Botwoon, Draygon, Golden Torizo, Mother Brain e as entidades do mod (SA-X, Core-X, Metroid, Omega, Metroid Grande).

Cada entrada do codex declara:

- **assinatura** de reconhecimento (HP, tamanho da hitbox, mobilidade, paleta do sprite, rótulo do classificador de entidades);
- **ponto fraco** e **fila de munição** preferida, com **proibições** do guia (Phantoon nunca recebe Super Míssil — liga o modo fúria; o Golden Torizo agarra míssil normal no ar quando está parado);
- **janela de vulnerabilidade** medida por sensores reais (nível/queda de cor no sprite, crescimento da hitbox, HP caindo) com tolerância de fogo às cegas (`blindFireAfterTicks`);
- **posição e movimentação** exigidas pela luta (canto seguro no Spore Spawn, plataformas no Kraid, Space Jump no Ridley, empurrar o Crocomire para a parede de espinhos, emboscar o buraco do Botwoon);
- **faseamento** (Mother Brain em 3 fases, Ridley descarrega Super Mísseis e depois sustenta) e **eventos roteirizados** (deixar o Metroid Grande drenar; no prólogo o Ridley não morre — ele foge).

Três princípios de projeto:

1. **Prior + verificação.** O guia é um *prior*; o agente mede o dano real por tipo de munição e, se o prior não estiver ferindo, rotaciona para a alternativa. Se ~30 s de plano não tiraram 1 HP, ele abandona o plano e entra em modo de sondagem (`probeMode`).
2. **Identidade pegajosa.** O rótulo do chefe não pisca a cada tick: só muda quando outro candidato vence com folga. Após a primeira vitória, a sala fica vinculada à estratégia (`bossRoomBindings`) e o registro vai para o IndexedDB (`ai_knowledge`) com o nome do chefe e a tática vencedora.
3. **Converte em teclas, não em sugestão.** A diretiva vira `keys[]` reais: seleciona o slot de munição no HUD com SELECT antes de atirar, segura o gatilho por 3 ticks para carregar, mira no ponto fraco e respeita a distância de segurança do chefe.

Durante a luta o player mostra o painel **“Plano do Chefe”** com fase, arma escolhida, ponto fraco, estado da janela, dano acumulado, fonte do conhecimento e avisos de rotação/sondagem.

### Verificação (sem precisar do emulador)

```bash
npm run check:bosses   # 89 checagens do codex puro (reconhecimento, janelas, proibições, faseamento, custo < 0,02 ms/tick)
npm run check:agent    # 23 checagens do agente inteiro contra uma WRAM sintética com física de brinquedo
```

`check:agent` usa `scripts/bossAgentSim.ts`, que simula a sala (Samus anda/pula, SELECT cicla o item do HUD, o HP do chefe só cai com a janela aberta — cor pintada no frame). Para inspecionar um tick a tick: `DUMP=torizo-kill npx tsx scripts/bossAgentSim.ts` (ou `DUMP=all`).

## Exploração com o mapa do jogo e checklist de objetivo

O pedido do projeto é: **reativar as energias, pegar todos os bônus (mísseis, bombas, tanques de
energia), derrotar os chefes e depois voltar onde não dava para passar** quando a habilidade
necessária existir. `src/lib/mapStrategy.ts` (puro) implementa isso em três peças:

**1. Detector de "estou perdido" (`detectLost`).** Não é "ficou parado": são três sinais
diferentes, cada um com recuperação própria — `OSCILLATION` (vai e volta entre as mesmas salas),
`STALL` (empurrando a mesma parede), `NO_PROGRESS` (anda, anda e não descobre sala nem item
novos). Severidade ≥ 2 libera a consulta do mapa; durante luta de chefe ou cutscene, nada
interrompe (severidade 3 ainda assim espera o refratário).

**2. Ler o mapa do jogo (`readMapScreen`).** No Super Metroid o mapa é **START** (o SELECT só
cicla item especial — manual, seções 1 e 6), e a tela pinta sala descoberta em rosa, sala
ainda não mapeada em azul, com o ponto de Samus piscando em branco. O agente abre o mapa, lê a
tela de verdade e fecha em ~4 ticks (~0,5 s):

- **cobertura** (quanto do que o mapa revela já está rosa) — a partir de 92% o mapa é
  considerado esgotado e a consulta para de acontecer;
- **direção do desconhecido**: o centróide da massa azul em relação ao ponto de Samus vira um
  viés (`RIGHT`/`LEFT` também ajusta `preferredDirection`, porque metade da heurística do
  agente só pensa em esquerda/direita).

O classificador rejeita tela que não é mapa (pouca tinta ou texto concentrado demais), então
uma leitura errada não engana o plano — e há refratário adaptativo: se uma leitura não rendeu
sala nova, a próxima espera 3× mais (até o teto do ciclo periódico), porque reler o mesmo mapa
sem ter aprendido nada é só tempo parado.

**3. Objetivo e rota (`planNextTarget`, `buildChecklist`).** O grafo de salas ganha valor por
sala (item pendente, painel de energia a acionar, chefe não vencido, sala nova, perigo já
sofrido ali) e a rota é BFS **só por portas que dá para abrir agora**. A cor de cada porta é
reconhecida do frame (`classifyDoorColor`) e mapeada nas regras do manual:

| Cor da porta | Abre com | Falta o quê? |
|---|---|---|
| Azul | feixe ou bomba | — |
| Vermelha | 5 mísseis | Missile Launcher + munição |
| Verde | 1 super míssil | Super Missiles + munição |
| Amarela | 1 power bomb | Power Bombs + munição |
| Rosa | já aberta | — |

Daí o comportamento pedido: com 4 mísseis, a comporta vermelha **não recebe tiro nem tempo** —
ela entra no backlog com o motivo exato ("faltam 1 míssel(is)") e a sala do outro lado continua
como alvo futuro. Quando a munição aparece, `reopenBacklog()` reabre a entrada, o grafo
desmarca a porta como trancada (`refreshLockedDoors`) e o agente volta lá. Sem isso o grafo
guardaria um "não" para sempre.

O checklist compara com os totais do vanilla (14 tanques de energia, 4 reservas, 46 expansões de
míssil = 230, 10 de super = 50, 10 de power bomb = 50) mais as 14 habilidades, chefes e
painéis. Quando nada mais está pendente, entra no modo retorno: rota BFS de volta à primeira
sala da sessão — não é só uma mudança de rótulo.

O painel **“Mapa & Objetivos”** mostra alvo e rota, barra de cobertura, portas da sala atual com
a cor reconhecida, o backlog ("voltar quando tiver o item") e o que falta do checklist.

```bash
npm run check:map    # 36 checagens do módulo (portas, tela de mapa pintada, rota, backlog, checklist)
npm run check:nav    # 34 checagens do agente num mundo de várias salas: mapa real + salas com lava
npm run check:all    # tudo: codex de chefes + mapa + as duas simulações de agente
```

## Recursos da IA Local (Sem API)

- **Visão + WRAM SNES**: captura o quadro real sem tela preta (`preserveDrawingBuffer`) e lê posição, portas, blocos quebráveis, itens, munição e reserva de energia.
- **Filtro de cenário estático**: ignora objetos de fundo sem hitbox (`xRadius/yRadius === 0`), flags intangíveis (`$7E:0F86`) e alvos imóveis que não recebem dano após tentativas de ataque.
- **Análise de armadura e peças**: acompanha em tempo real todas as 16 peças principais (Varia Suit, Gravity Suit, Morph Ball, Bombs, Spring Ball, Hi-Jump, Speed Booster, Space Jump, Screw Attack, Charge, Ice, Wave, Spazer, Plasma, Grapple Beam e X-Ray Scope) além de Tanques de Energia, Reserva de Energia e Mísseis.
- **Reset de energia**: botão dedicado no player e detecção automática quando o jogador reinicia o jogo, carrega save ou recupera a barra de energia após derrota.
- **Chefes pelo método certo**: ver **Codex de Chefes** acima — munição, ponto fraco, timing e posicionamento por chefe, com verificação do dano real.
- **Sala limpa primeiro**: a conferência periódica de inventário não abre o menu com inimigo vivo na tela, e a luta de chefe não é interrompida por ela.

## Saves no navegador

Os 2 slots de save state por jogo ficam armazenados no `IndexedDB` (`RetroPlaySaves`) separados por chave de jogo (ROMs abertas localmente via **Abrir ROM** usam o próprio nome de arquivo sem sobrescrever jogos da biblioteca).
