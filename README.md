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

## Recursos da IA Local (Sem API)

- **Visão + WRAM SNES**: captura o quadro real sem tela preta (`preserveDrawingBuffer`) e lê posição, portas, blocos quebráveis, itens, munição e reserva de energia.
- **Filtro de cenário estático**: ignora objetos de fundo sem hitbox (`xRadius/yRadius === 0`), flags intangíveis (`$7E:0F86`) e alvos imóveis que não recebem dano após tentativas de ataque.
- **Análise de armadura e peças**: acompanha em tempo real todas as 16 peças principais (Varia Suit, Gravity Suit, Morph Ball, Bombs, Spring Ball, Hi-Jump, Speed Booster, Space Jump, Screw Attack, Charge, Ice, Wave, Spazer, Plasma, Grapple Beam e X-Ray Scope) além de Tanques de Energia, Reserva de Energia e Mísseis.
- **Reset de energia**: botão dedicado no player e detecção automática quando o jogador reinicia o jogo, carrega save ou recupera a barra de energia após derrota.

## Saves no navegador

Os 2 slots de save state por jogo ficam armazenados no `IndexedDB` (`RetroPlaySaves`) separados por chave de jogo (ROMs abertas localmente via **Abrir ROM** usam o próprio nome de arquivo sem sobrescrever jogos da biblioteca).
