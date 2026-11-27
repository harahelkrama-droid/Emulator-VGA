# RetroPlay

Biblioteca web responsiva para jogos de Game Boy Advance e Super Nintendo. Cada jogo aparece como um cartão com capa e detalhes; o botão **Jogar agora** abre o jogo no emulador no navegador. O runtime EmulatorJS é carregado pela internet.

## Estrutura

- `index.html` — galeria responsiva, detalhes e player.
- `atualizacoes.html` — notas das melhorias publicadas e do roadmap planejado.
- `games.json` — catálogo lido pela página; o assistente `.pyw` o atualiza automaticamente.
- `games/` — ROMs que você tem autorização para redistribuir.
- `assets/` — capas em PNG/JPG/JPEG/WEBP.
- `atualizar_github.pyw` — assistente Windows para adicionar jogos/capas e publicar alterações.

## Publicar/atualizar no Windows

1. Deixe `atualizar_github.pyw` junto com `index.html` e `README.md` na pasta do projeto.
2. Coloque ROMs autorizadas em `games/` e capas em `assets/`; use o mesmo nome-base para associá-las automaticamente.
3. Execute o `.pyw` (requer Python 3 e Git for Windows, já autenticado na sua conta GitHub).
4. Ele usa a pasta onde está o próprio script, clona o repositório `harahelkrama-droid/Emulador` temporariamente, copia apenas os arquivos necessários, atualiza `games.json` e tenta publicar na branch `main`.
5. Responda **Sim** para incluir os jogos/capas locais ou **Não** para publicar apenas o site e preservar a galeria remota.

O script não exige selecionar a pasta do repositório nem que a pasta do projeto seja um clone Git. Ele não envia arquivos auxiliares aleatórios; publica apenas os arquivos do site (`index.html`, `README.md`, `service-worker.js`, `manifest.webmanifest`, `app-icon.svg`, `.gitignore`, `.nojekyll`), `games.json` e mídias autorizadas nas pastas `games/` e `assets/`. O nome do arquivo da ROM vira o título do cartão.

## Saves no navegador

O player oferece dois slots de save state por jogo. **Salvar 1/2** e **Carregar 1/2** guardam os estados no IndexedDB do navegador; não baixam arquivos e não enviam saves ao GitHub. Os slots são separados pelo caminho do jogo. Eles ficam apenas naquele navegador/dispositivo, não sincronizam entre aparelhos e podem ser apagados se os dados do site forem limpos. O formato é um save state do EmulatorJS, diferente do save interno que o próprio jogo grava na bateria/SRAM.

## Jogar offline

O site vira uma PWA com cache offline. É necessário abrir online uma vez; depois, mantenha esta página aberta e clique em **Preparar offline** para guardar a página, o catálogo, as capas e as ROMs no navegador. Em seguida, abra cada jogo enquanto ainda estiver online para que os arquivos do EmulatorJS também sejam armazenados. Depois disso, a página e os jogos preparados podem abrir sem conexão no mesmo navegador/dispositivo. Se aparecer a mensagem para atualizar, recarregue a página online uma vez. O cache pode ser removido pelo navegador ou pelo sistema se faltar armazenamento; para novos jogos ou atualizações, conecte-se novamente. O primeiro download de ROMs e núcleos consome dados.

## Agente de IA local (protótipo experimental)

A página oferece **Gemini 2.5 Flash (online)** e **Ollama `qwen2.5vl:3b` (local)**. Antes de carregar o EmulatorJS, configura um mapa padrão conhecido (setas, Z/X/A/S, Q/E, Enter e V) e pede confirmação antes de ligar a IA. O motor escolhido é lembrado neste navegador; sem rede, o app troca automaticamente do Gemini para Ollama quando detecta desconexão/erro de rede. A imagem é reduzida a 240×160 e enviada como JPEG 0,5; a saída solicitada é JSON curto. Ollama usa contexto/lote reduzidos e `keep_alive:10m`. Para baixar o modelo local, rode `ollama pull qwen2.5vl:3b`. O perfil RPG/Pokémon ou Ação/Metroid ajusta o prompt.

O ciclo experimental começa em **Super Fácil → Fácil → Normal → Difícil**. A IA tenta escolher o nível no menu; só avança quando classifica claramente a tela como vitória. Se não encontrar a opção ou ficar em dúvida, pausa e pergunta. Ao terminar a quarta etapa, encerra o ciclo. Isso depende da ROM e precisa ser testado no jogo real; não há garantia de que a IA reconhecerá corretamente cada menu/vitória.

A chave Gemini é inserida na interface e salva no `localStorage` deste navegador, nunca no repositório. Ela é enviada ao endpoint Gemini por cabeçalho HTTPS e as imagens são processadas pelo Google; restrinja a chave à Gemini API, defina quotas e limpe-a em computadores compartilhados. O motor cloud limita chamadas a no máximo uma por segundo (até 60 por minuto) para evitar ciclos mais agressivos; isso ainda pode gerar consumo/quota significativo. A opção Ollama precisa de permissão CORS para a origem do site. No Windows, prefira permitir somente as origens necessárias: `setx OLLAMA_ORIGINS "https://harahelkrama-droid.github.io,http://localhost:4173"`; feche completamente e reinicie o Ollama. Evite `OLLAMA_ORIGINS=*` em produção.

O código mantém a captura pequena e as chamadas assíncronas; **não existe garantia de zero RAM, zero impacto na taxa de quadros ou resposta abaixo de 1 segundo**. Gemini depende de internet e latência externa; Ollama usa memória/CPU/GPU locais. A IA é experimental e pode interpretar a cena errado. `ia_jogador.pyw` continua disponível como auxiliar separado; o atualizador do GitHub não envia esse script local.

## GitHub Pages

Em **Settings → Pages**, escolha **Deploy from a branch**, branch `main` e pasta `/ (root)`. Após a publicação, abra o endereço HTTPS do Pages. HTTPS é recomendado para gamepads e recursos do navegador.

## Direitos autorais e limites

Este projeto não fornece ROMs. Só publique ROMs e artes que você criou ou tem autorização expressa para redistribuir. O repositório público permite que qualquer pessoa veja e baixe os arquivos. `.gitignore` ignora ROMs por padrão; o assistente só força o envio das ROMs selecionadas após uma confirmação. GitHub bloqueia arquivos individuais acima de 100 MB. Considere também limites de tamanho do repositório e as regras dos titulares de direitos.
