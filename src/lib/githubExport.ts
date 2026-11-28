/**
 * Gera um index.html autocontido pronto para publicar no repositório GitHub Pages
 *
 * ATENÇÃO (camada de verificação): o laço de IA embutido aqui é uma cópia minificada e
 * independente do `LocalVisionAgent`, e **não** recebeu a `src/lib/actionGuardian.ts`
 * (âncora horizontal, escada de escape sem autofagocitose, orçamento de aposta, pulo por vão,
 * driver de SELECT). As correções do relatório do playtest de 25 min vivem no agente do app;
 * portá-las para cá é trabalho separado (a cópia não tem suíte de teste própria).
 * (harahelkrama-droid/Emulator-GBA), com IA local sem API que joga em tela cheia,
 * filtra elementos estáticos do cenário, analisa as 16 peças/armadura/reserva de energia,
 * memoriza rotas, evita colisão de saves em ROMs locais e registra o Service Worker PWA.
 */
export function buildStandaloneGitHubHtml(): string {
  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <meta name="theme-color" content="#090e1a">
  <meta name="mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <link rel="manifest" href="./manifest.webmanifest">
  <link rel="icon" type="image/svg+xml" href="./app-icon.svg">
  <link rel="apple-touch-icon" href="./app-icon.svg">
  <title>RetroPlay — Biblioteca de jogos</title>
  <style>
    :root{--bg:#090e1a;--panel:#111827;--panel2:#172033;--line:#24314a;--text:#eef3fb;--muted:#94a3bf;--mint:#6ee7b7}
    *{box-sizing:border-box}
    body{margin:0;background:#090e1a;color:var(--text);font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;min-height:100dvh;overflow-x:hidden}
    .wrap{max-width:1160px;margin:auto;padding:20px 18px 48px}
    .top{display:flex;align-items:center;justify-content:space-between;gap:16px;padding-bottom:18px;border-bottom:1px solid var(--line);margin-bottom:28px}
    .brand{display:flex;align-items:center;gap:10px;font-weight:800;font-size:19px;white-space:nowrap}
    .logo{width:36px;height:36px;border-radius:10px;background:var(--mint);display:grid;place-items:center;color:#07151a;font-size:17px;font-weight:900}
    .nav-link{color:var(--muted);text-decoration:none;font-size:13px;font-weight:600;white-space:nowrap}
    .nav-link:hover{color:var(--text)}
    .hero{padding:4px 0 24px}
    .hero h1{font-size:clamp(28px,4.5vw,46px);line-height:1.08;letter-spacing:-0.03em;margin:0 0 10px;max-width:18ch}
    .hero p{color:var(--muted);margin:0;max-width:640px}
    .section-head{display:flex;justify-content:space-between;align-items:end;gap:16px;margin:16px 0;flex-wrap:wrap}
    .section-head h2{font-size:20px;margin:0}
    .section-head p{margin:4px 0 0;color:var(--muted);font-size:13px}
    .library{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:16px}
    .empty-lib{grid-column:1/-1;border:1px dashed var(--line);background:var(--panel);border-radius:14px;padding:22px;color:var(--muted);font-size:13px}
    .game-card{border:1px solid var(--line);background:var(--panel);border-radius:14px;overflow:hidden;cursor:pointer}
    .cover-wrap{position:relative;width:100%;aspect-ratio:16/10;background:#0c1322;overflow:hidden;display:grid;place-items:center}
    .cover-bg{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;filter:blur(16px) brightness(.45);transform:scale(1.12)}
    .cover{position:relative;z-index:1;max-width:100%;max-height:100%;object-fit:contain;display:block}
    .card-info{padding:13px 14px}
    .card-title{font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .card-meta{display:flex;align-items:center;justify-content:space-between;margin-top:6px;color:var(--muted);font-size:12px}
    .detail-link{color:var(--mint);font-weight:600}
    .button{border:0;border-radius:10px;padding:10px 15px;min-height:42px;font:700 13px inherit;cursor:pointer;white-space:nowrap}
    .button:disabled{opacity:.45;cursor:not-allowed}
    .primary{background:var(--mint);color:#07151a}
    .secondary{background:var(--panel2);color:var(--text);border:1px solid var(--line)}
    .player{display:none;margin-top:26px;border:1px solid var(--line);border-radius:16px;overflow:hidden;background:var(--panel)}
    .player.visible{display:block}
    .player-head{padding:12px 16px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--line);gap:10px;flex-wrap:wrap}
    .screen-stage{background:#050811;padding:12px;display:flex;justify-content:center;align-items:center}
    .screen{position:relative;width:100%;max-width:880px;aspect-ratio:4/3;max-height:70vh;background:#000;display:flex;align-items:center;justify-content:center;overflow:hidden;border-radius:8px}
    .screen:fullscreen{max-width:none;max-height:none;width:100vw;height:100vh;border-radius:0}
    #game,#game>div,#game .ejs_parent{width:100%!important;height:100%!important;display:flex!important;align-items:center!important;justify-content:center!important;touch-action:none;user-select:none}
    #game canvas{max-width:100%!important;max-height:100%!important;object-fit:contain!important;margin:auto!important}
    .screen:fullscreen .ejs_menu_bar,.screen:fullscreen .ejs_menu_button,.screen:fullscreen .ejs_virtualGamepad_parent,.screen:fullscreen .ejs_context_menu,.screen:fullscreen [class*="ejs_menu"],.screen:fullscreen [class*="ejs_virtualGamepad"],.screen.fs-clean .ejs_menu_bar,.screen.fs-clean .ejs_virtualGamepad_parent{display:none!important;opacity:0!important;pointer-events:none!important}
    .screen:fullscreen.fs-landscape-rot #game{position:fixed!important;top:50%!important;left:50%!important;width:100dvh!important;height:100dvw!important;max-width:none!important;max-height:none!important;transform:translate(-50%,-50%) rotate(90deg)!important;transform-origin:center center!important}
    .player-foot{padding:10px 16px;color:var(--muted);display:flex;justify-content:space-between;gap:10px;align-items:center;font-size:12px;border-top:1px solid var(--line)}
    .save-panel{border-top:1px solid var(--line);padding:12px 16px;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
    .save-actions{display:flex;gap:8px;flex-wrap:wrap}
    .ai-box{border-top:1px solid var(--line);padding:12px 16px;display:grid;gap:10px;background:#0e1524}
    .ai-row{display:flex;align-items:center;gap:12px;flex-wrap:wrap;font-size:12px;color:var(--muted)}
    .ai-row b{color:var(--text);font-variant-numeric:tabular-nums}
    .ai-row select{background:#090e1a;color:var(--text);border:1px solid var(--line);border-radius:8px;padding:7px 10px;font:inherit;min-height:38px}
    .ai-preview{width:96px;height:64px;border-radius:6px;border:1px solid var(--line);background:#000;image-rendering:pixelated}
    .armor-bar{font-size:12px;color:var(--muted);border-top:1px solid var(--line);padding-top:8px;line-height:1.5}
    .armor-bar b{color:var(--text);font-variant-numeric:tabular-nums}
    .touch-pad{display:none;border-top:1px solid var(--line);padding:12px 16px;background:#0b1120;justify-content:space-between;align-items:center;gap:16px;user-select:none;touch-action:none}
    .touch-pad.open{display:flex;flex-wrap:wrap}
    .dpad,.abxy{display:grid;grid-template-columns:repeat(3,48px);grid-template-rows:repeat(3,48px);gap:4px}
    .tbtn{border:1px solid var(--line);background:var(--panel2);color:var(--text);border-radius:10px;font-weight:700;font-size:13px;display:grid;place-items:center;touch-action:none;user-select:none}
    .tbtn:active{background:var(--mint);color:#07151a}
    .modal{position:fixed;inset:0;z-index:20;background:#050811d6;display:none;place-items:center;padding:16px}
    .modal.open{display:grid}
    .dialog{width:min(720px,100%);max-height:90dvh;overflow:auto;border:1px solid var(--line);border-radius:16px;background:var(--panel)}
    .dialog-top{display:flex;justify-content:flex-end;padding:10px 14px 0}
    .close{background:transparent;color:var(--muted);border:0;font-size:24px;cursor:pointer;min-width:40px;min-height:40px}
    .dialog-body{display:grid;grid-template-columns:1fr 1.15fr;gap:20px;padding:8px 22px 22px;align-items:start}
    .dialog-cover{width:100%;border-radius:12px;aspect-ratio:16/10;object-fit:contain;background:#090e1a}
    .dialog-actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:16px}
    #toast{position:fixed;bottom:18px;left:50%;transform:translateX(-50%);background:#1c2840;border:1px solid var(--line);padding:10px 16px;border-radius:10px;color:#fff;display:none;z-index:40}
    @media(max-width:700px){.library{grid-template-columns:1fr 1fr;gap:10px}.dialog-body{grid-template-columns:1fr}.screen{max-height:56dvh}}
  </style>
</head>
<body>
<main class="wrap">
  <header class="top">
    <div class="brand"><div class="logo">▶</div>RetroPlay</div>
    <div style="display:flex;gap:16px;align-items:center">
      <a class="nav-link" href="./atualizacoes.html">Atualizações</a>
      <label class="button secondary" style="display:inline-flex;align-items:center;cursor:pointer">
        Abrir ROM<input id="romPicker" type="file" accept=".gba,.sfc,.smc" hidden>
      </label>
    </div>
  </header>
  <section class="hero">
    <h1>Jogue em tela cheia com IA local sem API.</h1>
    <p>Funciona em celular, notebook e PC sem chave nem limite. A IA joga em modo paisagem limpo, ignora objetos estáticos do cenário, analisa peças da armadura e foge da SA-X até estar pronta para o confronto final.</p>
  </section>
  <div class="section-head"><div><h2>Biblioteca</h2><p id="count">Carregando jogos…</p></div><span style="font-size:12px;color:var(--muted)">GBA · SNES</span></div>
  <section class="library" id="library"></section>
  <section class="player" id="player">
    <div class="player-head">
      <strong id="playingTitle">Jogo</strong>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="button secondary" id="touchToggle">Controle Touch</button>
        <button class="button secondary" id="fsBtn">Tela cheia</button>
        <button class="button secondary" id="closePlayer">Fechar jogo</button>
      </div>
    </div>
    <div class="screen-stage">
      <div class="screen" id="screenWrap">
        <div id="game"></div>
      </div>
    </div>
    <div class="touch-pad" id="touchPad">
      <div class="dpad"><div></div><button class="tbtn" data-k="UP">▲</button><div></div><button class="tbtn" data-k="LEFT">◀</button><button class="tbtn" data-k="SELECT" style="font-size:10px">SEL</button><button class="tbtn" data-k="RIGHT">▶</button><div></div><button class="tbtn" data-k="DOWN">▼</button><div></div></div>
      <div style="display:flex;gap:8px;flex-direction:column;align-items:center"><div style="display:flex;gap:8px"><button class="tbtn" data-k="L" style="width:52px;height:38px">L</button><button class="tbtn" data-k="R" style="width:52px;height:38px">R</button></div><button class="tbtn" data-k="START" style="width:92px;height:38px;font-size:11px">START</button></div>
      <div class="abxy"><div></div><button class="tbtn" data-k="X">X</button><div></div><button class="tbtn" data-k="Y">Y</button><div></div><button class="tbtn" data-k="A">A</button><div></div><button class="tbtn" data-k="B">B</button><div></div></div>
    </div>
    <div class="player-foot"><span id="footText">Preparando emulador…</span><span id="systemTag"></span></div>
    <div class="save-panel">
      <div><strong>Seus saves</strong><div id="saveStatus" style="color:var(--muted);font-size:12px">2 slots por jogo · neste navegador</div></div>
      <div class="save-actions">
        <button class="button secondary save-btn" data-save="1" disabled>Salvar 1</button>
        <button class="button secondary save-btn" data-save="2" disabled>Salvar 2</button>
        <button class="button secondary load-btn" data-load="1" disabled>Carregar 1</button>
        <button class="button secondary load-btn" data-load="2" disabled>Carregar 2</button>
        <button class="button secondary" id="resetGameBtn" disabled>Resetar Energia</button>
        <button class="button primary" id="aiToggle">Jogar com IA (Tela cheia)</button>
      </div>
    </div>
    <div class="ai-box">
      <div class="ai-row">
        <canvas id="aiPreview" class="ai-preview" width="96" height="64"></canvas>
        <span>Status: <b id="aiState">Pronta (Sem API)</b></span>
        <span>Ação: <b id="aiLastKey">—</b></span>
        <span>Tempo: <b id="aiLatency">— ms</b></span>
        <span>Cena: <b id="aiScene">—</b></span>
        <button class="button secondary" id="resetAiBtn" style="min-height:36px;padding:6px 12px">Resetar IA</button>
      </div>
      <div class="ai-row">
        <label>Perfil <select id="aiProfile"><option value="action">Ação / Metroid</option><option value="rpg">RPG / Pokémon</option></select></label>
        <label>Dificuldade <select id="aiDiff"><option value="Super / Super Fácil">Super / Super Fácil</option><option value="Easy / Fácil">Easy / Fácil</option><option value="Normal">Normal</option><option value="Hard / Difícil">Hard / Difícil</option></select></label>
        <span id="aiInfo" style="color:var(--muted)"></span>
      </div>
      <div class="armor-bar" id="armorInfo">Armadura &amp; Peças: aguardando leitura da memória…</div>
      <div class="armor-bar" id="knowledgeInfo">Banco de Conhecimento · Chefes e Poderes: aguardando coleta…</div>
    </div>
  </section>
</main>
<div class="modal" id="modal"><div class="dialog"><div class="dialog-top"><button class="close" id="closeModal">×</button></div><div class="dialog-body"><img class="dialog-cover" id="detailCover" alt="Capa"><div><div id="detailSystem" style="font-size:12px;color:var(--mint);font-weight:700"></div><h2 id="detailTitle" style="margin:6px 0 8px"></h2><p id="detailDescription" style="color:var(--muted);font-size:14px"></p><div class="dialog-actions"><button class="button primary" id="playGame">Jogar agora</button><button class="button secondary" id="modalCloseBtn">Voltar</button></div></div></div></div></div>
<div id="toast"></div>
<script>
(function(){const o=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(t,a){if(t==='webgl'||t==='webgl2'||t==='experimental-webgl')return o.call(this,t,Object.assign({},a||{},{preserveDrawingBuffer:true}));return o.call(this,t,a)};})();
const $=s=>document.querySelector(s);let selectedGame=null,currentGameKey='',readyTimer=null,lastBlobUrl=null;
function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function toast(t){const e=$('#toast');e.textContent=t;e.style.display='block';setTimeout(()=>e.style.display='none',2600)}
function systemName(f){return /\\.gba$/i.test(f)?'Game Boy Advance':'Super Nintendo'}
function showDetails(g){selectedGame=g;$('#detailTitle').textContent=g.title;$('#detailDescription').textContent=g.description||'Jogo da biblioteca RetroPlay.';$('#detailSystem').textContent=systemName(g.file);const cv=$('#detailCover');if(g.cover){cv.src=encodeURI(g.cover);cv.style.display='block'}else{cv.removeAttribute('src');cv.style.display='none'}$('#modal').classList.add('open')}
function renderLibrary(items){$('#count').textContent=items.length+' '+(items.length===1?'jogo':'jogos')+' na biblioteca';if(!items.length){$('#library').innerHTML='<div class="empty-lib">Nenhum jogo listado em <code>games.json</code> no momento. Use <strong>Abrir ROM</strong> no topo para jogar arquivos <code>.gba</code>, <code>.sfc</code> ou <code>.smc</code> do seu aparelho.</div>';return}$('#library').innerHTML=items.map((g,i)=>\`<article class="game-card" data-game="\${i}"><div class="cover-wrap">\${g.cover?\`<img class="cover-bg" src="\${esc(encodeURI(g.cover))}" alt=""><img class="cover" src="\${esc(encodeURI(g.cover))}" alt="Capa">\`:'<div>🎮</div>'}</div><div class="card-info"><div class="card-title">\${esc(g.title)}</div><div class="card-meta"><span>\${esc(systemName(g.file))}</span><span class="detail-link">Abrir</span></div></div></article>\`).join('');document.querySelectorAll('.game-card').forEach(el=>el.onclick=()=>showDetails(items[Number(el.dataset.game)]))}
fetch('games.json',{cache:'no-store'}).then(r=>r.ok?r.json():[]).then(d=>renderLibrary(Array.isArray(d)?d:[])).catch(()=>renderLibrary([]));
$('#romPicker').onchange=e=>{const f=e.target.files&&e.target.files[0];if(!f)return;selectedGame=null;if(lastBlobUrl){URL.revokeObjectURL(lastBlobUrl);lastBlobUrl=null}lastBlobUrl=URL.createObjectURL(f);startEmulator(lastBlobUrl,f.name,true);e.target.value=''};
function setSaveButtonsEnabled(on){document.querySelectorAll('.save-btn,.load-btn,#resetGameBtn').forEach(b=>b.disabled=!on)}
function destroyEmulator(){releaseAll();try{if(window.EJS_emulator){window.EJS_emulator.pause&&window.EJS_emulator.pause(true);window.EJS_emulator.gameManager&&window.EJS_emulator.gameManager.toggleMainLoop&&window.EJS_emulator.gameManager.toggleMainLoop(0)}}catch(_){}if(readyTimer){clearInterval(readyTimer);readyTimer=null}const old=document.getElementById('ejs-script');if(old)old.remove();$('#game').innerHTML='';delete window.EJS_emulator}
async function startEmulator(url,name,isLocal){const ext=name.split('.').pop().toLowerCase();if(!['gba','sfc','smc'].includes(ext)){toast('Formato não suportado.');return}stopAI();resetAIState();destroyEmulator();ramOff=-1;lastRgba=null;currentGameKey=isLocal?name:((selectedGame&&selectedGame.file)||name);setSaveButtonsEnabled(false);updateSlotStatus();renderKnowledge();$('#modal').classList.remove('open');$('#player').classList.add('visible');$('#playingTitle').textContent=name.replace(/\\.[^.]+$/,'');$('#systemTag').textContent=systemName(name);$('#footText').textContent='Verificando ROM e carregando emulador…';$('#player').scrollIntoView({behavior:'smooth',block:'start'});const gameUrl=isLocal?url:encodeURI(url);if(!isLocal){try{const pr=await fetch(gameUrl,{method:'HEAD',cache:'no-store'});const ct=(pr.headers.get('content-type')||'').toLowerCase();if(pr.status===404||ct.includes('text/html')){$('#footText').textContent='ROM não encontrada ('+url+'). Envie o arquivo ou clique em "Abrir ROM" no topo.';toast('ROM não encontrada no GitHub. Use "Abrir ROM".');return}}catch(_){}}$('#footText').textContent='Carregando emulador…';$('#game').innerHTML='<div id="emulator"></div>';window.EJS_player='#emulator';window.EJS_core=ext==='gba'?'gba':'snes';window.EJS_gameUrl=gameUrl;window.EJS_pathtodata='https://cdn.emulatorjs.org/stable/data/';window.EJS_startOnLoaded=true;window.EJS_language='pt-BR';window.EJS_color='#6ee7b7';window.EJS_defaultOptions={'save-state-location':'browser','save-state-slot':1};window.EJS_defaultControls={0:{0:{value:'x',value2:'BUTTON_2'},1:{value:'s',value2:'BUTTON_4'},2:{value:'v',value2:'SELECT'},3:{value:'enter',value2:'START'},4:{value:'up arrow',value2:'DPAD_UP'},5:{value:'down arrow',value2:'DPAD_DOWN'},6:{value:'left arrow',value2:'DPAD_LEFT'},7:{value:'right arrow',value2:'DPAD_RIGHT'},8:{value:'z',value2:'BUTTON_1'},9:{value:'a',value2:'BUTTON_3'},10:{value:'q',value2:'LEFT_TOP_SHOULDER'},11:{value:'e',value2:'RIGHT_TOP_SHOULDER'}},1:{},2:{},3:{}};window.EJS_Buttons={saveState:false,loadState:false,quickSave:false,quickLoad:false};readyTimer=setInterval(()=>{const gm=window.EJS_emulator&&window.EJS_emulator.gameManager;if(gm&&typeof gm.getState==='function'&&window.EJS_emulator.started){clearInterval(readyTimer);readyTimer=null;setSaveButtonsEnabled(true);$('#footText').textContent='Pronto · Setas, Z(A), X(B), A(X), S(Y), Enter(Start), V(Select)'}},350);const s=document.createElement('script');s.id='ejs-script';s.src='https://cdn.emulatorjs.org/stable/data/loader.js';s.onerror=()=>{if(readyTimer){clearInterval(readyTimer);readyTimer=null}$('#footText').textContent='Falha ao carregar o EmulatorJS. Verifique sua internet.';toast('Não foi possível baixar o núcleo do emulador.')};document.body.appendChild(s)}
$('#playGame').onclick=()=>{if(selectedGame)startEmulator(selectedGame.file,selectedGame.title+'.'+selectedGame.file.split('.').pop(),false)};
$('#closeModal').onclick=$('#modalCloseBtn').onclick=()=>$('#modal').classList.remove('open');
$('#closePlayer').onclick=()=>{stopAI();destroyEmulator();$('#player').classList.remove('visible')};
$('#touchToggle').onclick=()=>$('#touchPad').classList.toggle('open');
function syncFsOrientation(){const fs=Boolean(document.fullscreenElement);$('#screenWrap').classList.toggle('fs-landscape-rot',fs&&window.innerHeight>window.innerWidth);if(!fs&&screen.orientation&&screen.orientation.unlock){try{screen.orientation.unlock()}catch(_){}}}
document.addEventListener('fullscreenchange',syncFsOrientation);window.addEventListener('resize',syncFsOrientation);window.addEventListener('orientationchange',syncFsOrientation);
async function enterLandscapeFs(){const el=$('#screenWrap');if(!el)return;if(el.requestFullscreen&&!document.fullscreenElement){try{await el.requestFullscreen()}catch(_){}}if(screen.orientation&&screen.orientation.lock){try{await screen.orientation.lock('landscape')}catch(_){}}syncFsOrientation()}
$('#fsBtn').onclick=()=>enterLandscapeFs();
$('#screenWrap').ondblclick=()=>{if(document.fullscreenElement)document.exitFullscreen().catch(()=>{})};
function openSaveDB(){return new Promise((res,rej)=>{const r=indexedDB.open('RetroPlaySaves',2);r.onupgradeneeded=()=>{if(!r.result.objectStoreNames.contains('states'))r.result.createObjectStore('states',{keyPath:'id'});if(!r.result.objectStoreNames.contains('ai_knowledge'))r.result.createObjectStore('ai_knowledge',{keyPath:'id'})};r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)})}
async function readSlot(slot){const db=await openSaveDB();return new Promise((res,rej)=>{const tx=db.transaction('states','readonly'),q=tx.objectStore('states').get(currentGameKey+'::slot-'+slot);q.onsuccess=()=>res(q.result||null);q.onerror=()=>rej(q.error)})}
async function updateSlotStatus(){try{const [a,b]=await Promise.all([readSlot(1),readSlot(2)]);$('#saveStatus').textContent='Slot 1 '+(a?'salvo':'vazio')+' · Slot 2 '+(b?'salvo':'vazio')}catch(_){}}
async function readKnowledge(){try{const db=await openSaveDB();return await new Promise(res=>{const tx=db.transaction('ai_knowledge','readonly'),q=tx.objectStore('ai_knowledge').getAll();q.onsuccess=()=>res((q.result||[]).filter(r=>r.game===currentGameKey).sort((a,b)=>b.observedAt-a.observedAt));q.onerror=()=>res([])})}catch(_){return[]}}
async function renderKnowledge(){const rows=await readKnowledge(),el=$('#knowledgeInfo');if(!el)return;if(!rows.length){el.textContent='Banco de Conhecimento · Chefes e Poderes: cada Core-X ou habilidade coletada é salva aqui.';return}el.innerHTML='<b>Banco de Conhecimento ('+rows.length+'):</b> '+rows.map(r=>'<b>'+esc(r.powerName)+'</b> ('+esc(r.powerEffect)+' · '+esc(r.entityLabel)+')').join(' · ')}
async function upsertKnowledge(entries){if(!entries||!entries.length)return;try{const db=await openSaveDB();for(const e of entries){const id=currentGameKey+'::power::'+e.powerId;const ex=await new Promise(res=>{const tx=db.transaction('ai_knowledge','readonly'),q=tx.objectStore('ai_knowledge').get(id);q.onsuccess=()=>res(q.result||null);q.onerror=()=>res(null)});await new Promise((res,rej)=>{const tx=db.transaction('ai_knowledge','readwrite');tx.objectStore('ai_knowledge').put({id,game:currentGameKey,entityType:e.entityType,entityLabel:e.entityLabel,powerId:e.powerId,powerName:e.powerName,powerEffect:e.powerEffect,roomId:e.roomId,defeatedCount:(ex?ex.defeatedCount:0)+1,observedAt:Date.now()});tx.oncomplete=res;tx.onerror=()=>rej(tx.error)})}await renderKnowledge()}catch(_){}}
document.querySelectorAll('.save-btn').forEach(b=>b.onclick=async()=>{const slot=Number(b.dataset.save),gm=window.EJS_emulator&&window.EJS_emulator.gameManager;if(!gm)return;const d=await Promise.resolve(gm.getState());if(!d)return;const db=await openSaveDB();await new Promise((res,rej)=>{const tx=db.transaction('states','readwrite');tx.objectStore('states').put({id:currentGameKey+'::slot-'+slot,game:currentGameKey,slot,state:new Uint8Array(d).slice(),updated:Date.now()});tx.oncomplete=res;tx.onerror=()=>rej(tx.error)});toast('Slot '+slot+' salvo.');updateSlotStatus()});
document.querySelectorAll('.load-btn').forEach(b=>b.onclick=async()=>{const slot=Number(b.dataset.load),saved=await readSlot(slot),gm=window.EJS_emulator&&window.EJS_emulator.gameManager;if(!saved||!gm)return;await gm.loadState(new Uint8Array(saved.state));toast('Slot '+slot+' carregado.')});
const INPUT_MAP={B:{k:'x',c:'KeyX',kc:88,idx:0},Y:{k:'s',c:'KeyS',kc:83,idx:1},SELECT:{k:'v',c:'KeyV',kc:86,idx:2},START:{k:'Enter',c:'Enter',kc:13,idx:3},UP:{k:'ArrowUp',c:'ArrowUp',kc:38,idx:4},DOWN:{k:'ArrowDown',c:'ArrowDown',kc:40,idx:5},LEFT:{k:'ArrowLeft',c:'ArrowLeft',kc:37,idx:6},RIGHT:{k:'ArrowRight',c:'ArrowRight',kc:39,idx:7},A:{k:'z',c:'KeyZ',kc:90,idx:8},X:{k:'a',c:'KeyA',kc:65,idx:9},L:{k:'q',c:'KeyQ',kc:81,idx:10},R:{k:'e',c:'KeyE',kc:69,idx:11}};
let held=new Set();
function sendInput(key,down){if(key==='NONE'||!INPUT_MAP[key])return;const m=INPUT_MAP[key],gm=window.EJS_emulator&&window.EJS_emulator.gameManager;if(gm&&typeof gm.simulateInput==='function'){gm.simulateInput(0,m.idx,down?1:0);return}const ev=new KeyboardEvent(down?'keydown':'keyup',{key:m.k,code:m.c,bubbles:true,cancelable:true,composed:true});Object.defineProperty(ev,'keyCode',{get:()=>m.kc});Object.defineProperty(ev,'which',{get:()=>m.kc});document.dispatchEvent(ev)}
function setHeld(keys){const nxt=new Set(keys.filter(k=>k&&k!=='NONE'&&INPUT_MAP[k]));for(const k of held)if(!nxt.has(k))sendInput(k,false);for(const k of nxt)if(!held.has(k))sendInput(k,true);held=nxt}
function releaseAll(){for(const k of held)sendInput(k,false);held.clear()}
document.querySelectorAll('.tbtn').forEach(btn=>{const k=btn.dataset.k;btn.addEventListener('pointerdown',e=>{e.preventDefault();sendInput(k,true)});btn.addEventListener('pointerup',()=>sendInput(k,false));btn.addEventListener('pointercancel',()=>sendInput(k,false))});
let capC=document.createElement('canvas');capC.width=240;capC.height=160;let capX=capC.getContext('2d',{willReadFrequently:true}),ramOff=-1,lastCapAt=0,lastRgba=null;
function maskKey(m,fb){if(m&0x8000)return'B';if(m&0x4000)return'Y';if(m&0x2000)return'SELECT';if(m&0x1000)return'START';if(m&0x0080)return'A';if(m&0x0040)return'X';if(m&0x0020)return'L';if(m&0x0010)return'R';return fb}
const ITEM_PIECES=[[0x0001,'Varia','varia-suit','Resistência ao fogo, frio extremo e 50% menos dano'],[0x0020,'Gravity','gravity-suit','Resistência térmica, movimento livre em líquidos e 75% menos dano'],[0x0004,'Morph','morph-ball','Transforma em esfera para passagens estreitas'],[0x1000,'Bombs','bombs','Destrói blocos em Morph Ball e impulsiona saltos'],[0x0002,'Spring','spring-ball','Permite saltar diretamente em Morph Ball'],[0x0100,'Hi-Jump','hi-jump','Aumenta altura de salto e escalada'],[0x2000,'Speed','speed-booster','Corrida supersônica que rompe blocos de velocidade'],[0x0200,'SpaceJump','space-jump','Pulo infinito no ar para alcançar áreas altas'],[0x0008,'Screw','screw-attack','Escudo elétrico giratório no salto'],[0x4000,'Grapple','grapple-beam','Gancho para atravessar abismos'],[0x8000,'X-Ray','xray-scope','Revela blocos falsos e rotas secretas']];
const BEAM_PIECES=[[0x1000,'Charge','charge-beam','Disparo carregado contra chefes e Core-X'],[0x0002,'Ice','ice-beam','Congela Metroids e parasitas X para finalizar com míssil'],[0x0001,'Wave','wave-beam','Feixe atravessa paredes'],[0x0004,'Spazer','spazer-beam','Feixe triplo de alta cobertura'],[0x0008,'Plasma','plasma-beam','Feixe perfurante máximo contra SA-X']];
function analyzePieces(w){const got=[],eq=[],miss=[];for(const [bit,name] of ITEM_PIECES){const has=(w.im&bit)!==0,on=(w.ime&bit)!==0;if(has){got.push(name);if(on)eq.push(name)}else miss.push(name)}for(const [bit,name] of BEAM_PIECES){const has=(w.bm&bit)!==0,on=(w.bme&bit)!==0;if(has){got.push(name);if(on)eq.push(name)}else miss.push(name)}const suit=(w.ime&0x20)?'Gravity (75%)':(w.im&0x20)?'Gravity deseq.':(w.ime&1)?'Varia (50%)':(w.im&1)?'Varia deseq.':'Fusion (0%)';return{suit,total:16,collected:got.length,equipped:eq.length,got,miss}}
async function readWram(){if(window.EJS_core!=='snes')return null;const gm=window.EJS_emulator&&window.EJS_emulator.gameManager;if(!gm||!gm.getState)return null;const st=new Uint8Array(await Promise.resolve(gm.getState()));if(ramOff<0){let p=0;while(p<st.length-12){p=st.indexOf(82,p);if(p<0)break;if(st[p+1]===65&&st[p+2]===77&&st[p+3]===58){let j=p+4;while(j<p+24&&st[j]!==58)j++;if(st[j]===58){ramOff=j+1;break}}p++}}if(ramOff<0)return null;const u=a=>st[ramOff+a]|(st[ramOff+a+1]<<8);const gs=u(0x0998),hp=u(0x09c2),mhp=u(0x09c4);if(!((gs<=42&&mhp===0)||(mhp>=99&&mhp<=3000)))return null;const rw=Math.max(16,Math.min(256,u(0x07a5))),rh=Math.max(16,Math.min(256,u(0x07a7))),room=u(0x079b),enemies=[],items=[],plms=[],doors=[];let bt=null,bts=null,bgIgn=0;if(gs===8&&room>0){for(let slot=0;slot<32;slot++){const b=0x0f78+slot*0x40,id=u(b);if(!id)continue;const x=u(b+2),y=u(b+6),xr=u(b+10),yr=u(b+12),pr=u(b+14),ehp=u(b+20);if(x<=0||y<=0||x>rw*16+96||y>rh*16+96)continue;if((pr&0x0700)!==0||xr===0||yr===0||ehp===0||ehp===0xffff){bgIgn++;continue}enemies.push({slot,id,x,y,xr,yr,hp:ehp,props:pr})}for(let i=0;i<40;i++){const pid=u(0x1c37+i*2);if(!pid)continue;const bi=u(0x1c87+i*2)>>1,bx=bi%rw,by=Math.floor(bi/rw);plms.push({id:pid,bx,by});if(pid>=0xeed0&&pid<=0xf150)items.push({x:bx*16+8,y:by*16+8})}const tot=rw*rh;if(tot>0&&tot<=16384&&ramOff+0x16402+tot<=st.length){bt=new Uint8Array(tot);bts=new Uint8Array(tot);for(let i=0;i<tot;i++){bt[i]=((st[ramOff+0x10002+i*2]|(st[ramOff+0x10002+i*2+1]<<8))>>12)&15;bts[i]=st[ramOff+0x16402+i]}const tAt=(x,y)=>{let cx=x,cy=y;for(let h=0;h<8;h++){if(cx<0||cy<0||cx>=rw||cy>=rh)return 8;const idx=cy*rw+cx,t=bt[idx];if(t===5){const r=bts[idx];cx+=r===0?-1:r>=128?r-256:r;continue}if(t===13){const r=bts[idx];cy+=r===0?-1:r>=128?r-256:r;continue}return t}return 8},vis=new Uint8Array(tot);for(let y=0;y<rh;y++)for(let x=0;x<rw;x++){const idx=y*rw+x;if(bt[idx]!==9||vis[idx])continue;const cl=[{x,y}];vis[idx]=1;for(let h=0;h<cl.length;h++){const c=cl[h];for(const [dx,dy] of [[0,1],[0,-1],[1,0],[-1,0]]){const nx=c.x+dx,ny=c.y+dy;if(nx>=0&&ny>=0&&nx<rw&&ny<rh&&bt[ny*rw+nx]===9&&!vis[ny*rw+nx]){vis[ny*rw+nx]=1;cl.push({x:nx,y:ny})}}}let x0=rw,x1=-1,y0=rh,y1=-1;for(const c of cl){if(c.x<x0)x0=c.x;if(c.x>x1)x1=c.x;if(c.y<y0)y0=c.y;if(c.y>y1)y1=c.y}const mx=Math.round((x0+x1)/2),my=Math.round((y0+y1)/2),side=(y1-y0)>=(x1-x0)?(x0===0?'LEFT':x1===rw-1?'RIGHT':(tAt(x1+1,my)!==8&&tAt(x0-1,my)===8?'LEFT':'RIGHT')):(y0===0?'UP':'DOWN');let sol=0,cap=0;for(const c of cl){const ax=side==='LEFT'?c.x+1:side==='RIGHT'?c.x-1:c.x,ay=side==='UP'?c.y+1:side==='DOWN'?c.y-1:c.y,at=tAt(ax,ay);if(at===8)sol++;if(at===11||at===12||at===15)cap++}const hasP=plms.some(p=>Math.abs(p.bx-mx)<=3&&Math.abs(p.by-my)<=4&&(p.id<0xeed0||p.id>0xf150));const ebx=side==='LEFT'?Math.min(rw-1,x1+1):side==='RIGHT'?Math.max(0,x0-1):mx,eby=side==='UP'?Math.min(rh-1,y1+1):side==='DOWN'?Math.max(0,y0-1):y1;doors.push({key:side+'@'+x0+':'+y0+'-'+y1,side,bx:ebx,by:eby,x:ebx*16+8,y:eby*16+8,blocked:sol===cl.length&&!hasP&&cap===0})}}}const tmSt=u(0x0943),tmM=((st[ramOff+0x0946]>>4)&15)*10+(st[ramOff+0x0946]&15),tmS=((st[ramOff+0x0947]>>4)&15)*10+(st[ramOff+0x0947]&15);return{gs,hp,mhp,res:u(0x09d6),mres:u(0x09d4),mis:u(0x09c6),mmis:u(0x09c8),sup:u(0x09ca),msup:u(0x09cc),pb:u(0x09ce),hud:u(0x09d2),room,rw,rh,rwPx:rw*16,rhPx:rh*16,sx:u(0x0af6),sy:u(0x0afa),camX:u(0x0911),camY:u(0x0915),tm:tmSt>0&&tmSt<256,tmSec:Math.min(5999,tmM*60+tmS),im:u(0x09a4),ime:u(0x09a2),bm:u(0x09a8),bme:u(0x09a6),mScr:st[ramOff+0x00d1]||0,mCur:st[ramOff+0x0745]||0,cShoot:maskKey(u(0x09b2),'X'),cJump:maskKey(u(0x09b4),'A'),cRun:maskKey(u(0x09b6),'B'),cCancel:maskKey(u(0x09b8),'Y'),cSel:maskKey(u(0x09ba),'SELECT'),enemies,bgIgn,items,doors,bt,bts}}
function sampleC(w,e,rgba){if(!rgba)return null;const cx=Math.round(((e.x-w.camX)/256)*240),cy=Math.round(((e.y-w.camY)/224)*160);if(cx<-8||cx>248||cy<16||cy>168)return null;const rx=Math.max(10,Math.min(34,Math.round(e.xr*0.95))),ry=Math.max(10,Math.min(32,Math.round(e.yr*0.8))),x0=Math.max(0,cx-rx),x1=Math.min(239,cx+rx),y0=Math.max(24,cy-ry),y1=Math.min(159,cy+ry);if(x1<=x0||y1<=y0)return null;let tot=0,red=0,yg=0,sc=0,gld=0,pur=0,org=0,ng=0;for(let y=y0;y<=y1;y+=2)for(let x=x0;x<=x1;x+=2){const i=(y*240+x)*4,r=rgba[i],g=rgba[i+1],b=rgba[i+2];tot++;if(r>135&&r>g*1.7&&r>b*1.7)red++;if(g>105&&r>80&&b<90&&g>=r*0.88)yg++;if(g>120&&b>125&&Math.abs(r-g)<75&&b>=r*0.88)sc++;if(r>165&&g>120&&b<110)gld++;if(r>95&&b>115&&g<r*0.78&&g<b*0.78)pur++;if(r>145&&g>=60&&g<=155&&b<80)org++;if(g>135&&g>r*1.25&&g>b*1.55)ng++}if(!tot)return null;return{red:red/tot,yg:yg/tot,sc:sc/tot,gld:gld/tot,pur:pur/tot,org:org/tot,ng:ng/tot}}
async function capFrame(maxAge){const now=performance.now();if(lastRgba&&maxAge>0&&now-lastCapAt<maxAge)return lastRgba;const gm=window.EJS_emulator&&window.EJS_emulator.gameManager;let drew=false;if(gm&&typeof gm.screenshot==='function'){try{const raw=await gm.screenshot();if(raw&&raw.length>0){const bmp=await createImageBitmap(new Blob([new Uint8Array(raw).slice()],{type:'image/png'}));capX.fillStyle='#000';capX.fillRect(0,0,240,160);capX.imageSmoothingEnabled=false;capX.drawImage(bmp,0,0,240,160);bmp.close();drew=true}}catch(_){}}if(!drew){const cvs=Array.from(document.querySelectorAll('#game canvas')).sort((a,b)=>b.clientWidth*b.clientHeight-a.clientWidth*a.clientHeight)[0];if(!cvs||!cvs.width||!cvs.height){if(lastRgba)return lastRgba;throw new Error('A tela do emulador ainda está carregando.')}capX.fillStyle='#000';capX.fillRect(0,0,240,160);capX.imageSmoothingEnabled=false;capX.drawImage(cvs,0,0,240,160)}const pv=$('#aiPreview').getContext('2d');pv.imageSmoothingEnabled=false;pv.drawImage(capC,0,0,96,64);lastRgba=capX.getImageData(0,0,240,160).data;lastCapAt=performance.now();return lastRgba}
let step=0,dir='RIGHT',stall=0,ax=0,ay=0,prevX=0,prevY=0,vx=0,vy=0,yStreak=0,roomTicks=0,spawnX=0,spawnY=0,movedOnce=false,mProbes=0,blockedSpots=[],lhp=0,dmgTick=-99,pending=[],graph=new Map(),lastRoom=-1,entryDoorKey=null,activeDoorKey=null,lastDoorsSnap=[],pIm=0,pBm=0,pMm=0,pMs=0,pMh=0,jHold=0,jCd=0,sPulse=false,mPulse=false,itemTicks=0,eTrack=new Map(),dynIgn=0,lastCoreTick=-200,lastCoreRoom=-1,lastCoreRedTick=-200,lastCoreRedRoom=-1,omegaSeen=0,omegaGone=false,bigDrain=false,bigHealedTick=-300,dangerCells=new Set();
let uActive=false,uPhase='NONE',uDir='RIGHT',uX=0,uY=0,uTicks=0,uCd=0;
function resetU(cd){uActive=false;uPhase='NONE';uTicks=0;uCd=cd||0}
function resetAIState(){step=0;dir='RIGHT';stall=0;ax=0;ay=0;prevX=0;prevY=0;vx=0;vy=0;yStreak=0;roomTicks=0;spawnX=0;spawnY=0;movedOnce=false;mProbes=0;blockedSpots=[];lhp=0;dmgTick=-99;pending=[];graph.clear();lastRoom=-1;entryDoorKey=null;activeDoorKey=null;lastDoorsSnap=[];pIm=0;pBm=0;pMm=0;pMs=0;pMh=0;jHold=0;jCd=0;sPulse=false;mPulse=false;itemTicks=0;eTrack.clear();dynIgn=0;lastCoreTick=-200;lastCoreRoom=-1;lastCoreRedTick=-200;lastCoreRedRoom=-1;omegaSeen=0;omegaGone=false;bigDrain=false;bigHealedTick=-300;dangerCells.clear();resetU(0);$('#aiInfo').textContent='';$('#armorInfo').textContent='Armadura & Peças: aguardando leitura da memória…'}
function pulseJump(want,n){if(jHold>0){jHold--;if(jHold===0)jCd=2;return true}if(jCd>0){jCd--;return false}if(want){jHold=(n||3)-1;if(jHold===0)jCd=1;return true}return false}
function pulseShoot(want){if(!want){sPulse=false;return false}sPulse=!sPulse;return sPulse}
function getR(id){let n=graph.get(id);if(!n){n={id,exits:{},links:new Map(),doors:new Map()};graph.set(id,n)}return n}
function findUnexpRoom(cur){const q=[{id:cur,fn:null}],v=new Set([cur]);while(q.length){const c=q.shift(),n=graph.get(c.id);if(!n)continue;if(c.id!==cur)for(const d of n.doors.values())if(!d.locked&&d.target===undefined)return c.fn;for(const nr of n.links.values())if(nr&&!v.has(nr)){v.add(nr);q.push({id:nr,fn:c.fn||nr})}}return null}
function blk(w,bx,by){const bt=w.bt,bts=w.bts,rw=w.rw,rh=w.rh;if(!bt||!rw||!rh)return 8;let cx=bx,cy=by;for(let h=0;h<8;h++){if(cx<0||cy<0||cx>=rw||cy>=rh)return 8;const idx=cy*rw+cx,t=bt[idx];if(t===5){const r=bts?bts[idx]:255;cx+=r===0?-1:r>=128?r-256:r;continue}if(t===13){const r=bts?bts[idx]:255;cy+=r===0?-1:r>=128?r-256:r;continue}return t}return 8}\nfunction isG(w){if(!w.bt||!w.rw||!w.rh)return false;const bx=Math.max(0,Math.min(w.rw-1,Math.floor(w.sx/16))),by=Math.max(1,Math.min(w.rh-2,Math.floor(w.sy/16)));const t=blk(w,bx,by+1);return t===8||t===10||t===1||t===11||t===12||t===14||t===15||(t===9&&by===w.rh-1)}
function planRoom(w,targets){const bt=w.bt,rw=w.rw,rh=w.rh;if(!bt||!rw||!rh||!targets.length)return null;const tAt=(x,y)=>blk(w,x,y);const morph=(w.im&4)!==0,bombBr=(morph&&(w.im&0x1000)!==0)||w.pb>0,hasSpJ=(w.im&0x200)!==0,maxJ=hasSpJ?14:(w.im&0x100)?7:5;const air=(x,y)=>{if(x<0||y<0||x>=rw||y>=rh)return false;const t=tAt(x,y);if(t===8||t===10||t===14)return false;if(t===15)return bombBr;return true};const body=(x,y)=>air(x,y)&&(morph||air(x,y-1));const floor=(x,y)=>{if(x<0||y<0||x>=rw||y>=rh)return true;const t=tAt(x,y);return t===8||t===10||t===1||t===11||t===12||t===14||t===15||(t===9&&y===rh-1)};const stand=(x,y)=>body(x,y)&&floor(x,y+1)&&tAt(x,y+1)!==10;const haz=(x,y)=>tAt(x,y-1)===10||tAt(x,y-2)===10;const vertClr=(x,y0,y1)=>{for(let cy=y0;cy>=y1;cy--)if(!body(x,cy))return false;return true};const sight=(cx,cy,tx,ty)=>{const syS=ty===cy?0:ty>cy?1:-1;for(let y=cy;y!==ty;y+=syS)if(y!==cy&&!air(cx,y))return false;const sxS=tx===cx?0:tx>cx?1:-1;for(let x=cx;x!==tx;x+=sxS)if(x!==cx&&!air(x,ty))return false;return true};let sx=Math.max(0,Math.min(rw-1,Math.floor(w.sx/16))),sy=Math.max(1,Math.min(rh-2,Math.floor(w.sy/16)));const wasAir=!stand(sx,sy)&&body(sx,sy);if(!wasAir&&!stand(sx,sy)){let ok=false;for(let dy=0;dy<=16;dy++)if(stand(sx,sy+dy)){sy+=dy;ok=true;break}if(!ok)for(let dy=0;dy<=16&&!ok;dy++)for(const dx of [-1,1])if(stand(sx+dx,sy+dy)){sx+=dx;sy+=dy;ok=true;break}}const tot=rw*rh,dist=new Int32Array(tot).fill(0x3f3f3f3f),cls=new Uint8Array(tot),par=new Int32Array(tot).fill(-1),meta=new Array(tot).fill(null),hp=[sy*rw+sx];dist[sy*rw+sx]=0;const hPush=n=>{hp.push(n);let i=hp.length-1;while(i>0){const p=(i-1)>>1;if(dist[hp[p]]<=dist[hp[i]])break;const t=hp[p];hp[p]=hp[i];hp[i]=t;i=p}};const hPop=()=>{const top=hp[0],last=hp.pop();if(hp.length){hp[0]=last;let i=0;while(true){const l=i*2+1,r=l+1;let s=i;if(l<hp.length&&dist[hp[l]]<dist[hp[s]])s=l;if(r<hp.length&&dist[hp[r]]<dist[hp[s]])s=r;if(s===i)break;const t=hp[i];hp[i]=hp[s];hp[s]=t;i=s}}return top};const relax=(f,nx,ny,c,d,j,dr,sh,bm,ox,oy)=>{if(nx<0||ny<1||nx>=rw||ny>=rh-1)return;const ni=ny*rw+nx;if(cls[ni])return;const nc=dist[f]+c;if(nc<dist[ni]){dist[ni]=nc;par[ni]=f;meta[ni]={dir:d,jump:j,drop:dr,shoot:sh,bomb:Boolean(bm),wpBx:ox!==undefined?ox:nx,wpBy:oy!==undefined?oy:ny};hPush(ni)}};for(let exp=0;hp.length&&exp<4800;){const idx=hPop();if(cls[idx])continue;cls[idx]=1;exp++;const bx=idx%rw,by=Math.floor(idx/rw),isAirSt=idx===sy*rw+sx&&wasAir;if(isAirSt&&!hasSpJ){for(let f=0;f<=rh-2-by;f++){const fy=by+f;if(!body(bx,fy))break;for(const dr of [0,-1,1,-2,2]){const fx=bx+dr;if(fx<0||fx>=rw)continue;const sg=dr>0?1:-1;let clr=true;for(let sx2=0;sx2!==dr;sx2+=sg)if(!body(bx+sx2+sg,Math.max(1,fy-1))){clr=false;break}if(clr&&stand(fx,fy))relax(idx,fx,fy,1+Math.abs(dr)+Math.floor(f/2),dr!==0?(dr>0?'RIGHT':'LEFT'):(bx>=rw/2?'LEFT':'RIGHT'),false,true,false,false)}}for(let dy=-1;dy>=-4;dy--){const ny=by+dy;if(ny<1||!vertClr(bx,by,ny))break;for(let dx=-3;dx<=3;dx++){const tx=bx+dx;if(tx<0||tx>=rw||!stand(tx,ny)||haz(tx,ny))continue;const sg=dx>=0?1:-1;let clr=true;for(let cx=0;Math.abs(cx)<=Math.abs(dx);cx+=sg)if(!body(bx+cx,ny)){clr=false;break}if(clr)relax(idx,tx,ny,1+Math.abs(dx)+Math.abs(dy),dx!==0?(dx>0?'RIGHT':'LEFT'):(bx>=rw/2?'LEFT':'RIGHT'),true,false,false,false)}}}for(const dx of [-1,1]){const d=dx>0?'RIGHT':'LEFT',nx=bx+dx;if(nx<0||nx>=rw)continue;for(const dy of [0,-1,1]){const ny=by+dy;if(ny>=1&&ny<rh-1&&stand(nx,ny)){if(dy===-1&&!air(bx,by-1))continue;if(dy===1&&!air(nx,by))continue;const tt=tAt(nx,ny),bm=tt===15,gt=tt===12||bm,hz=dy<0&&haz(nx,ny)?4:0,nj=dy===-1&&tAt(nx,ny+1)!==1&&!haz(nx,ny);relax(idx,nx,ny,(nj?2:1)+(gt?3:0)+hz,d,nj,false,gt,bm)}}if(body(nx,by)&&!floor(nx,by+1))for(let f=1;f<=rh-2-by;f++){const fy=by+f;if(!body(nx,fy))break;if(stand(nx,fy)){relax(idx,nx,fy,1+Math.floor(f/2),d,false,true,false,false);break}for(const dr of f>=3?[dx,-dx,-2*dx]:[dx,-dx]){const fx=nx+dr;if(fx<0||fx>=rw)continue;const sg=dr>0?1:-1;let clr=true;for(let sx2=sg;Math.abs(sx2)<=Math.abs(dr);sx2+=sg)if(!body(nx+sx2,Math.max(1,fy-1))){clr=false;break}if(clr&&stand(fx,fy))relax(idx,fx,fy,2+Math.abs(dr)+Math.floor(f/2),d,false,true,false,false,nx,fy)}}}if(!isAirSt&&by+2<rh-1){const ft=tAt(bx,by+1);if((ft===11||ft===12||(ft===15&&bombBr))&&air(bx,by+2))for(let f=2;f<=rh-2-by;f++){const fy=by+f;if(!body(bx,fy))break;if(stand(bx,fy)){relax(idx,bx,fy,(ft===11?1:3)+Math.floor(f/2),bx>=rw/2?'LEFT':'RIGHT',false,true,ft===12,ft===15,bx,by+1);break}for(const dr of [-1,1])if(body(bx+dr,fy)&&stand(bx+dr,fy))relax(idx,bx+dr,fy,(ft===11?2:4)+Math.floor(f/2),dr>0?'RIGHT':'LEFT',false,true,ft===12,ft===15,bx,by+1)}}for(let dy=-1;dy>=-maxJ;dy--){const ny=by+dy;if(ny<1)break;const sc=vertClr(bx,by-1,ny);for(let dx=-4;dx<=4;dx++){if(!dx)continue;const tx=bx+dx;if(tx<0||tx>=rw||!stand(tx,ny)||(haz(tx,ny)&&tAt(tx,ny-1)===10))continue;const tt=tAt(tx,ny),bm=tt===15,gt=tt===12||bm,hz=haz(tx,ny)?4:0,sg=dx>0?1:-1,adjW=dy<=-3&&!air(bx+sg,by-1);if(sc&&!adjW){let clr=true;for(let cx=sg;Math.abs(cx)<=Math.abs(dx);cx+=sg)if(!body(bx+cx,ny)){clr=false;break}if(clr)relax(idx,tx,ny,2+Math.abs(dx)+Math.abs(dy)+(gt?3:0)+hz,dx>0?'RIGHT':'LEFT',true,false,gt,bm)}else{for(const so of [-1,1,-2,2]){const ox=bx+so;if(ox<0||ox>=rw)continue;const sgnO=so>0?1:-1;let clrO=true;for(let sx2=sgnO;Math.abs(sx2)<=Math.abs(so);sx2+=sgnO)if(!body(bx+sx2,by)){clrO=false;break}if(!clrO||!vertClr(ox,by-1,ny))continue;const sgnT=tx>=ox?1:-1;let clrT=true;for(let cx=ox;cx!==tx+sgnT;cx+=sgnT)if(!body(cx,ny)){clrT=false;break}if(!clrT)continue;relax(idx,tx,ny,4+Math.abs(so)+Math.abs(tx-ox)+Math.abs(dy)+(gt?3:0)+hz,so>0?'RIGHT':'LEFT',!stand(ox,by),false,gt,bm,ox,by);break}}}}if(hasSpJ){for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){if(!dx&&!dy)continue;const nx=bx+dx,ny=by+dy;if(!body(nx,ny))continue;const tt=tAt(nx,ny),bm=tt===15,gt=tt===12||bm,md=dx!==0?(dx>0?'RIGHT':'LEFT'):(bx>=rw/2?'LEFT':'RIGHT'),nj=(dy<0||!floor(nx,ny+1))&&!haz(nx,ny),nd=dy>0&&!floor(nx,ny+1),hz=haz(nx,ny)?4:0;relax(idx,nx,ny,(dy<=0?2:1)+(dx===0?1:0)+(gt?3:0)+hz,md,nj,nd,gt,bm)}}}let best=null;for(const t of targets){let bi=-1,bd=1e9;for(let dy=-3;dy<=3;dy++)for(let dx=-2;dx<=2;dx++){const cx=Math.max(0,Math.min(rw-1,t.bx+dx)),cy=Math.max(1,Math.min(rh-2,t.by+dy)),ci=cy*rw+cx;if(dist[ci]<0x3f3f3f3f&&sight(cx,cy,t.bx,t.by)){const c=dist[ci]+Math.abs(dx)+Math.abs(dy);if(c<bd){bd=c;bi=ci}}}if(bi>=0){const sc=t.priority*10000+bd;if(!best||sc<best.sc)best={key:t.key,idx:bi,sc}}}if(!best)return null;let cur=best.idx;if(cur===sy*rw+sx){const t=targets.find(x=>x.key===best.key);return{dir:t.bx<sx?'LEFT':'RIGHT',jump:t.by<sy-1,drop:t.by>sy+1,shoot:true,bomb:false,wpBx:t.bx,wpBy:t.by,goalKey:t.key}}let fc=cur;while(par[cur]!==-1&&par[cur]!==sy*rw+sx){cur=par[cur];fc=cur}const m=meta[fc];return m?{...m,goalKey:best.key}:null}
function decide(rgba,w,diff){
  step++;
  if(!w){
    if(uActive){
      uTicks++;const opp=uDir==='RIGHT'?'LEFT':'RIGHT';
      if(uPhase==='BACKSTEP'){const ks=[opp,'B'];if(uTicks>=5){uPhase='ASCEND';uTicks=0}return{keys:ks,scene:'Exploração · Busca em U (1/3)',ms:120}}
      if(uPhase==='ASCEND'){const ks=[uDir,'B'];if(pulseJump(true,4))ks.push('A');if(pulseShoot(true))ks.push('X');if(uTicks>=9){uPhase='DESCEND';uTicks=0}return{keys:ks,scene:'Exploração · Busca em U (2/3)',ms:120}}
      if(uTicks<=6){const ks=[opp,'B'];if(pulseShoot(true))ks.push('X');return{keys:ks,scene:'Exploração · Busca em U (3/3)',ms:120}}
      resetU(6);dir=opp;stall=0;
    }
    const ks=[dir,'B'];if(pulseJump(step%9===0,3))ks.push('A');if(pulseShoot(step%6===0))ks.push('X');return{keys:ks,scene:'Exploração visual',ms:125}
  }
  if((w.gs<=4&&w.room===0)||w.gs===12){
    resetU();if(w.gs===12)return{keys:['START'],scene:'Menu · Despausando',ms:130};
    mPulse=!mPulse;const pk=k=>mPulse?k:'NONE';
    if(w.gs<=2)return{keys:[pk('START')],scene:'Menu · Título',ms:125};
    if(w.mScr===1)return{keys:[w.mCur>0?pk('UP'):pk('A')],scene:'Menu · Arquivo X',ms:125};
    if(w.mScr===5){const k=w.mCur<6?pk('DOWN'):w.mCur>6?pk('UP'):pk('A');return{keys:[k],scene:w.mCur===6?'Menu · Português confirmado':'Menu · Selecionando Português',ms:120}}
    if(w.mScr===16)return{keys:[w.mCur>0?pk('UP'):pk('A')],scene:'Menu · Iniciar Jogo (PT)',ms:125};
    if(w.mScr===2||w.mScr===3){const dl=diff.toLowerCase();const t=dl.includes('super')?0:dl.includes('easy')||dl.includes('fácil')?1:dl.includes('omega')?4:dl.includes('hard')||dl.includes('difícil')?3:2;return{keys:[w.mCur<t?pk('DOWN'):w.mCur>t?pk('UP'):pk('A')],scene:'Menu · Dificuldade (PT)',ms:120}}
    return{keys:[pk(step%4===0?'START':'A')],scene:'Menu',ms:125}
  }
  if(w.gs===11){resetU();jHold=0;return{keys:[dir],scene:'Exploração · Porta',ms:110}}
  if(w.gs!==8){resetU();return{keys:[step%5===0?'A':'NONE'],scene:'Cena / Briefing (PT)',ms:120}}
  if(w.room!==lastRoom){const pr=lastRoom,pk=activeDoorKey;if(pr>0){const a=getR(pr),b=getR(w.room);a.exits[dir]=w.room;b.exits[dir==='RIGHT'?'LEFT':'RIGHT']=pr;const phys=lastDoorsSnap.filter(d=>Math.hypot(d.x-prevX,d.y-prevY)<=104).sort((x,y)=>Math.hypot(x.x-prevX,x.y-prevY)-Math.hypot(y.x-prevX,y.y-prevY))[0],lk=(phys&&phys.key)||pk;if(lk){a.links.set(lk,w.room);const pd=a.doors.get(lk);if(pd){pd.target=w.room;pd.locked=false}}}lastRoom=w.room;activeDoorKey=null;entryDoorKey=null;roomTicks=0;spawnX=w.sx;spawnY=w.sy;movedOnce=false;ax=w.sx;ay=w.sy;prevX=w.sx;prevY=w.sy;vx=0;vy=0;yStreak=0;stall=0;mProbes=0;blockedSpots=[];itemTicks=0;jHold=0;eTrack.clear();dynIgn=0;lastCoreRedTick=-200;lastCoreRedRoom=-1;resetU();const cn=getR(w.room);for(const d of w.doors){if(!cn.doors.has(d.key))cn.doors.set(d.key,{key:d.key,locked:d.blocked});else if(d.blocked)cn.doors.get(d.key).locked=true}if(pr>0&&w.doors.length){const nd=[...w.doors].sort((a,b)=>Math.hypot(a.x-w.sx,a.y-w.sy)-Math.hypot(b.x-w.sx,b.y-w.sy))[0];if(nd&&Math.hypot(nd.x-w.sx,nd.y-w.sy)<96){entryDoorKey=nd.key;cn.links.set(nd.key,pr);const ed=cn.doors.get(nd.key);if(ed)ed.target=pr}}dir=w.rwPx>0&&w.sx>w.rwPx*0.72?'LEFT':'RIGHT'}
  lastDoorsSnap=w.doors;
  roomTicks++;if(uCd>0)uCd--;
  if(!movedOnce&&Math.hypot(w.sx-spawnX,w.sy-spawnY)>=3)movedOnce=true;
  const learned=[];
  const isBigDrain=bigDrain&&w.hp<=20;
  if(bigDrain&&w.hp>lhp+45&&w.mhp>=pMh){bigHealedTick=step;bigDrain=false}
  const resetEv=!isBigDrain&&pMh>0&&(w.mhp<pMh||(pIm&~w.im)!==0||(pBm&~w.bm)!==0||(lhp===0&&w.hp>0));
  if(resetEv){eTrack.clear();dmgTick=-99;stall=0;itemTicks=0;blockedSpots=[];bigDrain=false;resetU()}
  else if(pMh>0&&(((w.im&~pIm)!==0)||((w.bm&~pBm)!==0)||w.mmis>pMm||w.msup>pMs||w.mhp>pMh)){
    const fromCore=step-lastCoreTick<=240&&(lastCoreRoom===w.room||lastCoreRoom<0);
    const eType=fromCore?'CORE_X_NAKED':'NONE',eLbl=fromCore?'Core-X derrotado':'Coleta de Item';
    for(const [bit,name,pid,eff] of ITEM_PIECES)if((w.im&~pIm&bit)!==0)learned.push({entityType:eType,entityLabel:eLbl,powerId:pid,powerName:name,powerEffect:eff,roomId:w.room});
    for(const [bit,name,pid,eff] of BEAM_PIECES)if((w.bm&~pBm&bit)!==0)learned.push({entityType:eType,entityLabel:eLbl,powerId:pid,powerName:name,powerEffect:eff,roomId:w.room});
    pending.forEach(p=>p.ready=true);for(const n of graph.values())for(const d of n.doors.values())d.locked=false;for(const t of eTrack.values()){t.ign=false;t.cTicks=0}blockedSpots=[]
  }
  pIm=w.im;pBm=w.bm;pMm=w.mmis;pMs=w.msup;pMh=w.mhp;
  let dmgNow=false;if(!resetEv&&lhp>0&&w.hp>0){if(lhp-w.hp>=6)dmgNow=true;if(lhp-w.hp>=25){dmgTick=step;dangerCells.add(w.room+':'+Math.floor(w.sx/16)+','+Math.floor(w.sy/16))}else if(w.hp>lhp+15)dmgTick=-99}lhp=w.hp;
  const seenSlots=new Set();dynIgn=0;
  for(const e of w.enemies){seenSlots.add(e.slot);let t=eTrack.get(e.slot);if(!t||t.id!==e.id){t={id:e.id,lx:e.x,ly:e.y,mv:0,ihp:e.hp,lhp:e.hp,seen:1,cTicks:0,hostile:false,ign:false,isCore:false,seenRed:false};eTrack.set(e.slot,t)}else{const mv=Math.hypot(e.x-t.lx,e.y-t.ly);t.mv+=mv;t.lx=e.x;t.ly=e.y;t.seen++;if(e.hp<t.ihp||e.hp<t.lhp||mv>=2||t.mv>=6||(dmgNow&&Math.hypot(e.x-w.sx,e.y-w.sy)<104)){t.hostile=true;t.ign=false}t.lhp=e.hp;const isBoss=e.hp>=450||(e.xr>=18&&e.yr>=18)||t.isCore;if(!t.hostile&&!isBoss&&((t.cTicks>=4&&e.hp>=t.ihp&&t.mv<=3)||(t.seen>=8&&t.mv<=2&&e.hp===t.ihp)))t.ign=true}if(t.ign)dynIgn++}
  for(const sl of eTrack.keys())if(!seenSlots.has(sl))eTrack.delete(sl);
  vx=w.sx-prevX;vy=w.sy-prevY;prevX=w.sx;
  if(Math.abs(vy)<=1)yStreak++;else yStreak=0;prevY=w.sy;
  if(!uActive){const hDist=Math.abs(w.sx-ax),vMoved=Math.abs(w.sy-ay)>=28;if(hDist>=20||vMoved){ax=w.sx;ay=w.sy;stall=0;if(hDist>=40)mProbes=0}else if(movedOnce){stall++}}
  const realEnemies=w.enemies.filter(e=>!(eTrack.get(e.slot)&&eTrack.get(e.slot).ign));
  const hasExit=w.doors.some(d=>!d.blocked),isEarly=w.mhp<=199&&(w.im&0x0021)===0;
  let omega=null,bigM=null,coreX=null,sax=null,larva=null;
  const sawRedC=lastCoreRedTick>0&&step-lastCoreRedTick<=260&&lastCoreRedRoom===w.room;
  const sawAnyC=lastCoreTick>0&&step-lastCoreTick<=260&&lastCoreRoom===w.room;
  for(const e of realEnemies){
    const d=Math.hypot(e.x-w.sx,e.y-w.sy),t=eTrack.get(e.slot),c=sampleC(w,e,rgba),lg=(e.xr>=18&&e.yr>=18)||e.xr>=22||e.yr>=26;
    if((w.tm&&isEarly&&(lg||e.hp>=200))||(isEarly&&lg&&c&&c.pur>0.05&&(c.gld>0.025||c.org>0.03))){if(!omega||d<omega.d)omega={...e,d};continue}
    if(lg&&c&&c.ng>0.13&&c.red>0.06){if(!bigM||d<bigM.d)bigM={...e,d};continue}
    let cs=null;
    const nakedLook=Boolean(c&&c.sc>=0.11&&c.gld>=0.03&&c.red<0.08);
    if(c&&e.hp>0&&e.hp<450&&(e.xr>=12||(t&&t.isCore)||(e.xr>=6&&(sawAnyC||nakedLook)))){
      const hg=c.gld>=0.025;
      if(c.red>=0.11&&hg)cs='VERMELHO';
      else if(c.yg>=0.11&&hg&&c.red<0.09&&c.sc<0.09&&!sawRedC)cs='AMARELO';
      else if((c.sc>=0.07&&hg&&c.red<0.08&&((t&&t.seenRed)||sawRedC||e.hp<=45))||(c.sc>=0.13&&c.gld>=0.04&&c.red<0.07))cs='PODER_EXPOSTO';
      else if((c.sc>=0.10&&hg&&c.red<0.09)||(t&&t.isCore&&!t.seenRed&&!sawRedC))cs='NORMAL';
    }else if(t&&t.isCore&&(t.seenRed||sawRedC))cs='PODER_EXPOSTO';
    if(cs){if(t){t.isCore=true;if(cs==='VERMELHO'){t.seenRed=true;lastCoreRedTick=step;lastCoreRedRoom=w.room}}if(cs==='VERMELHO'){lastCoreRedTick=step;lastCoreRedRoom=w.room}if(!coreX||cs==='PODER_EXPOSTO'||d<coreX.d)coreX={...e,d,stage:cs};continue}
    const ok=!t||t.hostile||t.mv>=2||t.seen<8||e.hp>=900;
    const hShape=e.xr>=6&&e.xr<=18&&e.yr>=15&&e.yr<=26&&e.yr>=e.xr;
    const isVaria=Boolean(c&&c.org+c.gld>=0.14&&c.red>=0.05&&c.ng<0.10);
    const isGrav=Boolean(c&&c.pur>=0.09&&c.pur>c.org*1.15&&c.red>=0.03);
    const postR=bigHealedTick>0&&step-bigHealedTick<600;
    const isMon=lg&&e.hp>=1200&&d<440&&((c!==null&&c.pur+c.red+c.org>=0.18)||(postR&&!hasExit&&step-bigHealedTick>200));
    const isHumanSax=Boolean(c)&&hShape&&e.hp>=900&&d<320&&ok&&(isVaria||isGrav);
    if(isMon||isHumanSax){
      const kind=isMon?'SAX_MONSTER':isGrav?'SAX_GRAVITY':'SAX_VARIA';
      if(!sax||d<sax.d)sax={...e,d,kind};continue;
    }
    if(e.hp>0&&e.hp<450&&e.xr>=11&&e.xr<=22&&c&&c.red>0.10&&c.ng>0.05){if(!larva||d<larva.d)larva={...e,d}}
  }
  let entity='';
  if(!w.tm)omegaGone=false;
  if(omega){omegaSeen++;omegaGone=false;entity='Omega Metroid'+(w.tm?' ('+Math.floor(w.tmSec/60)+':'+String(w.tmSec%60).padStart(2,'0')+')':'')}
  else if(omegaSeen>0&&w.tm){omegaGone=true;entity='Fuga pós-Omega ('+Math.floor(w.tmSec/60)+':'+String(w.tmSec%60).padStart(2,'0')+')'}
  else if(bigM){entity=bigHealedTick>0&&step-bigHealedTick<220?'Metroid Grande (Curando)':'Metroid Grande (Dreno)'}
  else if(coreX){lastCoreTick=step;lastCoreRoom=w.room;entity='Core-X ('+coreX.stage+')'}
  else if(sax){entity=sax.kind==='SAX_MONSTER'?'SA-X Monstro':sax.kind==='SAX_GRAVITY'?'SA-X Gravity':'SA-X Varia'}
  else if(larva){entity='Metroid'}
  if(bigM&&bigHealedTick<0){bigDrain=true;resetU();const ad=bigM.x>=w.sx?'RIGHT':'LEFT';return{keys:bigM.d>44?[ad]:['NONE'],scene:'Metroid Grande · Dreno para resgate',ms:140,entity,learned}}
  if(coreX&&coreX.stage==='PODER_EXPOSTO'){resetU();const cd=coreX.x>=w.sx?'RIGHT':'LEFT';dir=cd;const ks=[cd,w.cRun];if(w.hud!==0)ks.push(w.cCancel);if(pulseJump(coreX.y<w.sy-8||(Math.abs(coreX.x-w.sx)<40&&coreX.y<w.sy+4),3))ks.push(w.cJump);return{keys:ks,scene:'Core-X · Coletando Poder!',ms:115,entity,learned}}
  if(omega){resetU();const ad=omega.x>=w.sx?'RIGHT':'LEFT',pd=omega.d<68?(ad==='RIGHT'?'LEFT':'RIGHT'):ad;dir=pd;const ks=[pd,w.cRun];if(pulseShoot(true))ks.push(w.cShoot);if(pulseJump(omega.d<85||step%7===0,3))ks.push(w.cJump);return{keys:ks,scene:w.tm?'Omega Metroid · Temporizador!':'Omega Metroid · Prólogo',ms:120,entity,learned}}
  const isEsc=w.tm&&!omega;
  if(sax&&!omegaGone&&!isEsc){
    resetU();const stunned=bigHealedTick>0&&step-bigHealedTick<320,ready=(w.mhp+w.mres)>=600&&((w.ime|w.im)&0x21)&&((w.bme|w.bm)&0x1009)&&(w.msup>=10||w.mmis>=40);
    if(sax.kind!=='SAX_MONSTER'&&!stunned&&!ready){const esc=planRoom(w,w.doors.filter(d=>!d.blocked).map((d,i)=>({key:d.key,bx:d.bx,by:d.by,priority:Math.hypot(d.x-sax.x,d.y-sax.y)>140?0:i+1})));dir=esc?esc.dir:(sax.x>=w.sx?'LEFT':'RIGHT');const ks=[dir,w.cRun];if(pulseJump(!esc?.drop&&(esc?.jump||step%4===0),3))ks.push(w.cJump);if(pulseShoot(Boolean(esc?.shoot||stall>=2||step%3===0)))ks.push(w.cShoot);return{keys:ks,scene:'Fuga · '+entity,ms:120,entity,learned}}
    const aim=sax.x>=w.sx?'RIGHT':'LEFT',safe=sax.kind==='SAX_MONSTER'?88:64,ks=[sax.d<safe?(aim==='RIGHT'?'LEFT':'RIGHT'):aim];if((w.sup>0||w.mis>0)&&w.hud===0)ks.push(w.cSel);else if(pulseShoot(true))ks.push(w.cShoot);if(pulseJump(step%6===0,3))ks.push(w.cJump);return{keys:ks,scene:sax.kind==='SAX_MONSTER'?'Combate · SA-X Monstro':stunned?'Combate · SA-X Desativada!':'Combate · Confronto Final SA-X',ms:120,entity,learned}
  }
  if(coreX){resetU();const fd=coreX.x>=w.sx?'RIGHT':'LEFT',ks=[coreX.d<54?(fd==='RIGHT'?'LEFT':'RIGHT'):fd];if(coreX.y<w.sy-18)ks.push('UP');if((w.mis>0||w.sup>0)&&w.hud===0)ks.push(w.cSel);else if(pulseShoot(true))ks.push(w.cShoot);if(pulseJump(coreX.y<w.sy-24||coreX.d<48,3))ks.push(w.cJump);return{keys:ks,scene:'Combate · Core-X ('+coreX.stage+')',ms:120,entity,learned}}
  const it=w.items.map(i=>({...i,d:Math.hypot(i.x-w.sx,i.y-w.sy)})).sort((a,b)=>a.d-b.d)[0];
  if(it&&itemTicks<42){const ip=planRoom(w,[{key:'ITEM',bx:Math.floor(it.x/16),by:Math.floor(it.y/16),priority:0}]);if(ip||!w.bt){resetU();itemTicks++;dir=ip?ip.dir:(it.x>=w.sx?'RIGHT':'LEFT');const ks=[dir,w.cRun];if(pulseJump(ip?!ip.drop&&(ip.jump||ip.wpBy*16+8<w.sy-12):(it.y<w.sy-12||stall>=4),3))ks.push(w.cJump);if(pulseShoot(Boolean(ip?.shoot||stall>=5)))ks.push(w.cShoot);return{keys:ks,scene:'Coleta · Buscando Item',ms:120,entity,learned}}itemTicks=42}
  if(it&&itemTicks>=42){if(!pending.some(p=>p.room===w.room))pending.push({room:w.room,ready:false});itemTicks=0;dir=it.x>=w.sx?'LEFT':'RIGHT';ax=w.sx;ay=w.sy;stall=0}
  if(larva&&!uActive&&stall<12&&!omegaGone&&!isEsc){const fd=larva.x>=w.sx?'RIGHT':'LEFT',ks=[fd];if(larva.y<w.sy-16)ks.push('UP');const hasIce=(w.bme&2)!==0;if(hasIce&&step%4<2){if(w.hud!==0)ks.push(w.cCancel);else if(pulseShoot(true))ks.push(w.cShoot)}else if((w.mis>0||w.sup>0)&&w.hud===0)ks.push(w.cSel);else if(pulseShoot(true))ks.push(w.cShoot);if(pulseJump(larva.d<48||step%5===0,2))ks.push(w.cJump);return{keys:ks,scene:'Combate · Metroid',ms:120,entity,learned}}
  const foe=realEnemies.map(e=>({...e,d:Math.hypot(e.x-w.sx,e.y-w.sy)})).filter(e=>{if(e.hp<=0)return false;if(e.hp>=450)return e.d<300;if(e.d>=136)return false;const t=eTrack.get(e.slot);if(t&&!t.hostile&&t.mv<=1&&t.seen>=4)return e.d<64&&Math.abs(e.y-w.sy)<36;return true}).sort((a,b)=>a.d-b.d)[0];
  if(foe&&!uActive&&stall<12&&!omegaGone&&(!isEsc||foe.hp>=450)){const ft=eTrack.get(foe.slot);if(ft){ft.cTicks++;if(!ft.hostile&&ft.cTicks>=5&&foe.hp>=ft.ihp&&ft.mv<=3){ft.ign=true}}if(!ft||!ft.ign){const isB=foe.hp>=450,lh=w.mhp>0&&w.hp<w.mhp*0.3,fd=foe.x>=w.sx?'RIGHT':'LEFT',ks=[lh?(fd==='RIGHT'?'LEFT':'RIGHT'):isB&&foe.d<56?(fd==='RIGHT'?'LEFT':'RIGHT'):fd];if(foe.y<w.sy-18)ks.push('UP');if(isB&&(w.sup>0||w.mis>0)&&w.hud===0)ks.push(w.cSel);else if(pulseShoot(true))ks.push(w.cShoot);if(pulseJump(foe.d<52||(isB&&(foe.y<w.sy-24||step%7===0))||(lh&&step%5===0),isB?3:2))ks.push(w.cJump);return{keys:ks,scene:lh?'Combate · Vida baixa · Recuando':isB?'Combate · Enfrentando Chefe':'Combate · Inimigo confirmado',ms:120,entity,learned}}}
  if(!movedOnce&&roomTicks>=8&&roomTicks<=95&&vx===0&&vy===0)return{keys:[roomTicks%4===0?'A':dir],scene:'Exploração · Sincronizando sala',ms:120};
  if(uActive){
    if(w.hud!==0)return{keys:[dir,w.cCancel],scene:'Exploração · Busca em U',ms:115};
    const opp=uDir==='RIGHT'?'LEFT':'RIGHT';
    const cleared=uDir==='RIGHT'?w.sx>=uX+24:w.sx<=uX-24;
    const climbed=Math.abs(w.sy-uY)>=52&&yStreak>=5&&(uDir==='RIGHT'?w.sx>=uX-24:w.sx<=uX+24);
    if(cleared||climbed){dir=uDir;ax=w.sx;ay=w.sy;stall=0;mProbes=0;resetU(6);return{keys:[dir,w.cRun],scene:'Exploração · Caminho em U encontrado',ms:120}}
    uTicks++;
    if(uPhase==='BACKSTEP'){dir=opp;const ks=[opp,w.cRun];if(pulseShoot(uTicks%2===0))ks.push(w.cShoot);if(uTicks>=6){uPhase='ASCEND';uTicks=0}return{keys:ks,scene:'Exploração · Busca em U (1/3)',ms:120}}
    if(uPhase==='ASCEND'){dir=uDir;const ks=[uDir,w.cRun];if(pulseJump(true,4))ks.push(w.cJump);if(pulseShoot(true))ks.push(w.cShoot);if(uTicks>=10){uPhase='DESCEND';uTicks=0;jHold=0}return{keys:ks,scene:'Exploração · Busca em U (2/3)',ms:120}}
    if(uTicks<=8){const sw=uTicks<=4?uDir:opp;dir=sw;const ks=[sw,w.cRun];if(uTicks<=3&&(w.im&4))ks.push('DOWN');if(pulseShoot(true))ks.push(w.cShoot);return{keys:ks,scene:'Exploração · Busca em U (3/3)',ms:120}}
    if(!pending.some(p=>p.room===w.room))pending.push({room:w.room,ready:false});blockedSpots.push({x:uX,y:uY,dir:uDir});dir=opp;ax=w.sx;ay=w.sy;stall=0;jHold=0;resetU(10);return{keys:[opp,w.cRun],scene:'Exploração · Bloqueio confirmado',ms:160}
  }
  if(w.hud!==0&&(stall<14||stall>20||mProbes>=2))return{keys:[dir,w.cCancel],scene:'Exploração · Feixe',ms:115};
  if(stall>=5&&blockedSpots.some(b=>b.dir===dir&&Math.abs(b.x-w.sx)<28&&Math.abs(b.y-w.sy)<40)){if(!w.tm&&activeDoorKey){const rd=getR(w.room).doors.get(activeDoorKey);if(rd)rd.locked=true}dir=dir==='RIGHT'?'LEFT':'RIGHT';ax=w.sx;ay=w.sy;stall=0;return{keys:[dir,w.cRun],scene:'Exploração · Rota memorizada',ms:160}}
  const cn=getR(w.room),nextUnexp=findUnexpRoom(w.room),targets=[],hasSpJ=(w.im&0x200)!==0,grounded=isG(w);
  const sbx=Math.max(0,Math.min(w.rw-1,Math.floor(w.sx/16))),sby=Math.max(1,Math.min(w.rh-2,Math.floor(w.sy/16)));
  const bUp1=blk(w,sbx,sby-1),bUp2=blk(w,sbx,sby-2),isSol=t=>t===8||t===10||t===14||t===15;
  const ceilLow=isSol(bUp1)||isSol(bUp2)||bUp1===10||bUp2===10||blk(w,sbx-1,sby-2)===10||blk(w,sbx+1,sby-2)===10;
  for(const d of w.doors){if(d.blocked&&!w.tm)continue;const rec=cn.doors.get(d.key);if(rec&&rec.locked&&!w.tm)continue;let pr=3;if(!rec||rec.target===undefined)pr=d.key===entryDoorKey?2:0;else if(nextUnexp&&rec.target===nextUnexp)pr=1;targets.push({key:d.key,bx:d.bx,by:d.by,priority:pr})}
  if(!targets.length&&w.doors.length)for(const d of w.doors)targets.push({key:d.key,bx:d.bx,by:d.by,priority:d.key===entryDoorKey?2:0});
  const ps=planRoom(w,targets);if(ps)activeDoorKey=ps.goalKey;
  if(stall>=5){if(stall>=14&&stall<=20&&mProbes<2&&(w.mis>0||w.sup>0)){if(w.hud===0)return{keys:[dir,w.cSel],scene:'Exploração · Míssil',ms:120};const ks=[dir];if(pulseShoot(true)){ks.push(w.cShoot);mProbes++}return{keys:ks,scene:'Exploração · Disparando míssil',ms:120}}if(stall>=24){if(!w.tm&&activeDoorKey){const ad=w.doors.find(d=>d.key===activeDoorKey);if(ad&&Math.hypot(ad.x-w.sx,ad.y-w.sy)<=112){const rd=cn.doors.get(activeDoorKey);if(rd)rd.locked=true}}if(uCd===0&&(!w.tm||grounded)){uActive=true;uPhase='BACKSTEP';uDir=dir;uX=w.sx;uY=w.sy;uTicks=0;jHold=0;return{keys:[dir==='RIGHT'?'LEFT':'RIGHT',w.cRun],scene:'Exploração · Busca em U (1/3)',ms:120}}dir=dir==='RIGHT'?'LEFT':'RIGHT';ax=w.sx;ay=w.sy;stall=0;const ks=[dir,w.cRun];if(hasSpJ&&!ceilLow&&step%2===0)ks.push(w.cJump);return{keys:ks,scene:w.tm?'Fuga · Contornando obstáculo':'Exploração · Invertendo',ms:145}}const td=ps?w.doors.find(d=>d.key===ps.goalKey):null,nearD=td&&Math.hypot(td.x-w.sx,td.y-w.sy)<=44;const ks=[ps?ps.dir:dir,w.cRun];if(!nearD&&!ceilLow){if(hasSpJ){if(grounded?pulseJump(true,3):(step%2===0||vy>=0))ks.push(w.cJump)}else if(pulseJump(true,3))ks.push(w.cJump)}else if(ceilLow&&(w.im&4)&&grounded)ks.push('DOWN');if(pulseShoot(true))ks.push(w.cShoot);return{keys:ks,scene:nearD?'Exploração · Abrindo porta':w.tm?'Fuga · Contornando teto':'Exploração · Testando passagem',ms:120}}
  if(ps){dir=ps.dir;const td=w.doors.find(d=>d.key===ps.goalKey),nearD=td&&Math.hypot(td.x-w.sx,td.y-w.sy)<=56,wpX=ps.wpBx*16+8,flB=blk(w,sbx,sby+1);if((ps.bomb||(ps.drop&&flB===15))&&Math.abs(w.sx-wpX)<=14&&(grounded||(yStreak>=1&&Math.abs(vy)<=1))&&(w.im&0x1004)===0x1004){const bks=['DOWN'];if(pulseShoot(true))bks.push(w.cShoot);return{keys:bks,scene:'Exploração · Bomba no piso',ms:120}}const ks=Math.abs(w.sx-wpX)<10&&ps.drop?[dir]:[dir,w.cRun];const sh=grounded&&Math.abs(vx)===0&&movedOnce&&!ps.drop&&!ceilLow,asc=!ps.drop&&!(ceilLow&&!ps.jump)&&(ps.jump||(!ceilLow&&(ps.wpBy*16+8)<w.sy-12)||sh);if(hasSpJ&&asc&&(!nearD||(td&&td.y<w.sy-14))){if(grounded){if(pulseJump(true,3))ks.push(w.cJump)}else if(step%2===0||vy>=0){jHold=0;ks.push(w.cJump)}}else if(pulseJump(asc&&!nearD&&grounded,ps.jump?4:3))ks.push(w.cJump);if(pulseShoot(Boolean(nearD||ps.shoot||w.tm||step%5===0)))ks.push(w.cShoot);return{keys:ks,scene:w.tm?'Fuga c/ Temporizador!':'Exploração 0x'+w.room.toString(16)+' ('+w.sx+','+w.sy+')',ms:115}}
  const isV=w.rhPx>w.rwPx&&w.rwPx<=512,stepHit=grounded&&Math.abs(vx)===0&&(movedOnce||roomTicks>48)&&!ceilLow;
  const ks=[dir,w.cRun];if(grounded&&step%24===0&&!hasSpJ&&!w.tm)ks.push('DOWN');if(hasSpJ&&!ceilLow&&(w.tm||isV)){if(grounded?pulseJump(true,3):(step%2===0||vy>=0))ks.push(w.cJump)}else if(pulseJump(!ceilLow&&(stepHit||(grounded&&step%(isV?5:11)===0)),isV?4:3))ks.push(w.cJump);if(pulseShoot(w.tm||step%4===0))ks.push(w.cShoot);return{keys:ks,scene:w.tm?'Fuga c/ Temporizador!':'Exploração 0x'+w.room.toString(16)+' ('+w.sx+','+w.sy+')',ms:115};
}
let aiOn=false;const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function stopAI(){aiOn=false;releaseAll();$('#aiToggle').textContent='Jogar com IA (Tela cheia)';$('#aiState').textContent='Pronta (Sem API)';$('#screenWrap').classList.remove('fs-clean')}
async function runAI(){
  aiOn=true;$('#aiToggle').textContent='Pausar IA';$('#touchPad').classList.remove('open');$('#screenWrap').classList.add('fs-clean');
  await enterLandscapeFs();
  while(aiOn){
    try{const t0=performance.now(),w=await readWram(),age=w?((w.enemies.length>0||w.tm)?260:(document.fullscreenElement&&w.gs===8?3000:800)):220,rgba=await capFrame(age);const a=decide(rgba,w,$('#aiDiff').value);$('#aiState').textContent='Jogando (Sem API)';$('#aiLastKey').textContent=a.keys.join('+');$('#aiLatency').textContent=Math.round(performance.now()-t0)+' ms';$('#aiScene').textContent=a.scene;if(a.learned&&a.learned.length)await upsertKnowledge(a.learned);if(w&&w.mhp){const ap=analyzePieces(w);$('#aiInfo').textContent='HP '+w.hp+'/'+w.mhp+(w.mres?' · Res '+w.res+'/'+w.mres:'')+' · '+ap.suit+' · Mísseis '+w.mis+'/'+w.mmis+' · Super '+w.sup+(a.entity?' · Alvo: '+a.entity:'')+' · Ignorados '+(w.bgIgn+dynIgn)+' · Pendentes '+pending.length;$('#armorInfo').innerHTML='<b>Peças ('+ap.collected+'/'+ap.total+' · '+ap.equipped+' equip.):</b> '+(ap.got.length?esc(ap.got.join(', ')):'Nenhuma coletada')+(ap.miss.length?' · <b>Faltam:</b> '+esc(ap.miss.join(', ')):' · <b>Arsenal 100% completo!</b>')}setHeld(a.keys);await sleep(a.ms)}catch(e){$('#aiState').textContent=e.message;break}
  }
  stopAI();
}
$('#aiToggle').onclick=()=>{if(aiOn)stopAI();else runAI()};
$('#resetAiBtn').onclick=()=>{stopAI();resetAIState();toast('Memória da IA zerada.')};
$('#resetGameBtn').onclick=()=>{const gm=window.EJS_emulator&&window.EJS_emulator.gameManager;if(!gm)return;stopAI();resetAIState();if(typeof gm.restart==='function'){gm.restart();toast('Energia e jogo reiniciados.')}else{toast('Núcleo sem reinício rápido.')}};
if('serviceWorker' in navigator&&location.protocol.startsWith('http')){window.addEventListener('load',()=>navigator.serviceWorker.register('./service-worker.js').catch(()=>{}))}
</script>
</body>
</html>`;
}
