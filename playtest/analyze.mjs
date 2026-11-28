// Métricas da sessão headless (playtest/out/session.jsonl + events.jsonl).
// Uso: node playtest/analyze.mjs [caminho-da-pasta]
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve('playtest/out');
const rows = fs
  .readFileSync(path.join(dir, 'session.jsonl'), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l));
const events = fs.existsSync(path.join(dir, 'events.jsonl'))
  ? fs
      .readFileSync(path.join(dir, 'events.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
  : [];

const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(1)}%` : '—');
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const p = (a, q) => (a.length ? a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * q))] : 0);

const run = rows.filter((r) => r.phase === 'RUN');
const inGame = run.filter((r) => r.gs === 8);

const rooms = new Map();
for (const r of rows) {
  const k = r.room ?? -1;
  const e = rooms.get(k) || { room: k, ticks: 0, firstTick: r.tick, lastTick: r.tick, xs: new Set() };
  e.ticks++;
  e.lastTick = r.tick;
  if (r.x != null) e.xs.add(r.x);
  rooms.set(k, e);
}

let best = null;
let cur = null;
for (const r of rows) {
  const k = `${r.room}@${r.x}`;
  if (cur && cur.k === k) cur.n++;
  else {
    if (cur && (!best || cur.n > best.n)) best = cur;
    cur = { k, n: 1, from: r.tick, to: r.tick };
  }
}
if (cur && (!best || cur.n > best.n)) best = cur;

const moves = [];
for (let i = 1; i < inGame.length; i++) {
  if (inGame[i].room === inGame[i - 1].room) moves.push(Math.abs(inGame[i].x - inGame[i - 1].x));
}

const reasons = new Map();
for (const r of rows) reasons.set(r.reason, (reasons.get(r.reason) || 0) + 1);

const keysHit = { LEFT: 0, RIGHT: 0, UP: 0, DOWN: 0, A: 0, B: 0, X: 0, Y: 0, SELECT: 0, START: 0, NONE: 0 };
for (const r of rows) {
  const ks = String(r.keys || '').split('+');
  for (const k of ks) if (k in keysHit) keysHit[k]++;
  if (ks.length === 1 && ks[0] === 'NONE') keysHit.NONE++;
}

const lines = [];
const L = (s = '') => lines.push(s);

L('# Sessão de playtest — métricas');
L('');
L(`Fonte: \`${path.relative(process.cwd(), path.join(dir, 'session.jsonl'))}\` (${rows.length} decisões)`);
L('');
L('## Cobertura');
L('');
L('| métrica | valor |');
L('|---|---|');
L(`| frames emulados | ${rows.at(-1).f} |`);
L(`| tempo de jogo | ${(rows.at(-1).gms / 1000).toFixed(1)} s (${(rows.at(-1).gms / 60000).toFixed(2)} min) |`);
L(`| ticks dentro do jogo (gameState=8) | ${inGame.length} (${pct(inGame.length, rows.length)}) |`);
L(`| decisões por segundo de jogo | ${(inGame.length / (rows.at(-1).gms / 1000)).toFixed(2)} |`);
L(`| frames entre decisões (média) | ${mean(rows.map((r) => r.holdFrames)).toFixed(2)} → ${((mean(rows.map((r) => r.holdFrames)) * 1000) / 60).toFixed(0)} ms de latência |`);
L(`| custo da decisão | média ${mean(rows.map((r) => r.dms)).toFixed(3)} ms · p95 ${p(rows.map((r) => r.dms), 0.95)} ms · máx ${Math.max(...rows.map((r) => r.dms))} ms |`);
L(`| frame novo vs reaproveitado | ${pct(rows.filter((r) => r.fresh).length, rows.length)} fresco |`);
L('');
L('## Progresso');
L('');
L('| métrica | valor |');
L('|---|---|');
L(`| salas visitadas | ${[...rooms.keys()].filter((k) => k > 0).length} |`);
for (const e of [...rooms.values()].sort((a, b) => b.ticks - a.ticks)) {
  L(
    `| sala ${e.room} | ${e.ticks} ticks (${pct(e.ticks, rows.length)}), ticks ${e.firstTick}–${e.lastTick}, ${e.xs.size} posições-x |`,
  );
}
L(`| maior período congelado (mesma sala + mesmo x) | ${best.n} ticks ≈ ${((best.n * mean(rows.map((r) => r.holdFrames)) * 1000) / 60 / 1000).toFixed(0)} s |`);
L(`| |Δx| por decisão dentro da sala | média ${mean(moves).toFixed(2)} px · p95 ${p(moves, 0.95)} px · máx ${Math.max(...moves)} px |`);
L(`| estados (sala,x,y) distintos | ${new Set(inGame.map((r) => `${r.room}@${r.x},${r.y}`)).size} em ${inGame.length} |`);
L(`| cobertura do mapa | ${Math.max(...inGame.map((r) => r.cover || 0))}% |`);
L(`| backlog de portas trancadas | ${Math.max(...inGame.map((r) => r.backlog || 0))} |`);
L(`| deaths / dano | ${events.filter((e) => e.kind === 'DEATH').length} mortes, ${events.filter((e) => e.kind === 'DAMAGE').length} eventos de dano |`);
L('');
L('## Teclas');
L('');
L('| tecla | ticks | % da sessão |');
L('|---|---|---|');
for (const [k, v] of Object.entries(keysHit)) L(`| ${k} | ${v} | ${pct(v, rows.length)} |`);
L('');
L('## Modos / decisões');
L('');
const modes = new Map();
for (const r of rows) modes.set(r.mode, (modes.get(r.mode) || 0) + 1);
L('| modo | ticks | % |');
L('|---|---|---|');
for (const [m, v] of [...modes.entries()].sort((a, b) => b[1] - a[1])) L(`| ${m} | ${v} | ${pct(v, rows.length)} |`);
L('');
L('| motivo (top 12) | ticks | % |');
L('|---|---|---|');
for (const [reason, n] of [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
  L(`| ${String(reason).replace(/\|/g, '/')} | ${n} | ${pct(n, rows.length)} |`);
}
L('');
L('## Detector de "estou perdido"');
L('');
const sev = new Map();
for (const r of rows) sev.set(r.lostSev, (sev.get(r.lostSev) || 0) + 1);
L('| severidade | ticks |');
L('|---|---|');
for (const [s, n] of [...sev.entries()].sort((a, b) => a[0] - b[0])) L(`| ${s} | ${n} |`);
L(`| lost=true | ${rows.filter((r) => r.lost).length} ticks |`);
L(`| causas reportadas | ${[...new Set(rows.map((r) => r.lostCause).filter(Boolean))].join(', ') || 'nenhuma'} |`);
L('');
L('## Munição / inventário observado');
L('');
const inv = (k) => [...new Set(rows.map((r) => r[k]).filter((v) => v != null))].sort((a, b) => a - b);
L(`- mísseis: ${inv('mis').join('→') || '—'} · supers: ${inv('sup').join('→')} · power bombs: ${inv('pb').join('→')}`);
L(`- item do HUD selecionado: ${[...new Set(rows.map((r) => r.hud))].join(',')} (0 = feixe)`);
L(`- nº de habilidades declaradas pelo WRAM: ${[...new Set(rows.map((r) => r.abil))].join(',')}`);
L(`- energia: ${Math.min(...rows.filter((r) => r.hp != null).map((r) => r.hp))}–${Math.max(...rows.filter((r) => r.hp != null).map((r) => r.hp))} / ${Math.max(...rows.filter((r) => r.hpMax != null).map((r) => r.hpMax))}`);
L(`- inimigos na tela: ${[...new Set(rows.map((r) => r.en))].join(',') || '—'} · PLMs: ${[...new Set(rows.map((r) => r.plm))].join(',')} · portas: ${[...new Set(rows.map((r) => r.doors))].join(',')}`);
L('');
L('## Eventos');
L('');
const kinds = new Map();
for (const e of events) kinds.set(e.kind, (kinds.get(e.kind) || 0) + 1);
for (const [k, n] of [...kinds.entries()].sort((a, b) => b[1] - a[1])) L(`- ${k}: ${n}`);
const stuckVals = rows.map((r) => r.stuck || 0);
L(`- contador de travamento da sala: máx ${Math.max(...stuckVals)} ticks; ≥100 em ${stuckVals.filter((s) => s >= 100).length} ticks (${pct(stuckVals.filter((s) => s >= 100).length, rows.length)})`);
L('');
console.log(lines.join('\n'));

// ── portão de regressão (§12 do relatório) ───────────────────────────────────────────────
// Impresso no final e espelhado em `<dir>/gate.md`, para que um `npm run check:playtest` futuro
// possa ler PASS/FAIL sem abrir o resto. As duas regras são as que o playtest de 25 min violou:
//   R1  ≥ 5 salas diferentes em 25 min de jogo
//   R2  nenhuma sequência de >240 ticks na mesma sala sem ganho horizontal (≥20 px) nem troca de
//       sala — é o "presa em x=37 por 21,9 min" virando critério objetivo
{
  const g = [];
  const say = (s) => {
    g.push(s);
  };
  const inGameRows = rows.filter((r) => r.gs === 8);
  const seq = inGameRows.length ? inGameRows : rows;
  let run = 1,
    worstRun = 1,
    worstAt = null,
    anchorX = seq[0]?.x ?? 0,
    anchorY = seq[0]?.y ?? 0,
    anchorRoom = seq[0]?.room ?? -1,
    frozenRun = 1,
    worstFrozen = 1,
    worstFrozenAt = null;
  for (let i = 1; i < seq.length; i++) {
    const r = seq[i];
    const prev = seq[i - 1];
    const sameRoom = r.room === prev.room;
    if (!sameRoom) {
      run = 1;
      frozenRun = 1;
      anchorRoom = r.room;
      anchorX = r.x;
      anchorY = r.y;
      continue;
    }
    run++;
    // GANHO SÓ HORIZONTAL, de propósito. Deixei entrar "|Δy| ≥ 40" e o portão passou a perdoar o
    // sintoma exato do relatório: no poço ela quicava 40 px por pulo, então "ganhou altura" a cada
    // 8 ticks e os 9.221 ticks viraram 145. Escalada de verdade troca de sala ou anda na horizontal;
    // pulo no lugar não. (A isenção que ficou é a de luta de chefe.)
    const gained = Math.abs(r.x - anchorX) >= 20;
    // (a isenção de combate foi testada e REJEITADA: ela mascara o laço de 9.221 ticks da
    // sessão-base, porque havia inimigo na tela. O portão é deliberadamente mais duro que o
    // StuckSentinel — é o "piso" do relatório, não a regra do agente.)
    if (gained) {
      anchorX = r.x;
      anchorY = r.y;
      frozenRun = 1;
    } else if (r.boss != null) {
      // BRIGA DE CHEFE é a única isenção. "Qualquer inimigo vivo na sala" foi testado e rejeitado:
      // é exatamente o que escondia os 9.221 ticks da sessão-base (havia Readme na tela). O chefe,
      // não — e é a mesma regra que o EscapeLadder usa para não intervir no meio da luta.
      frozenRun = 1;
      anchorX = r.x;
      anchorY = r.y;
    } else {
      frozenRun++;
      if (frozenRun > worstFrozen) {
        worstFrozen = frozenRun;
        worstFrozenAt = { tick: r.tick, room: r.room, x: r.x };
      }
    }
    if (run > worstRun) {
      worstRun = run;
      worstAt = { tick: r.tick, room: r.room, from: prev.tick };
    }
  }
  // OS LIMIARES ESCALAM COM A JANELA: `npm run check:playtest` roda 5 min de jogo, o relatório
  // cobrou 25. Fixar "≥5 salas" faria o probe rápido reprovar por comprimento, não por defeito —
  // e um portão que reclama do tamanho é um portão que vão desligar.
  const gameSec = Math.max(...rows.map((r) => r.gms || 0)) / 1000;
  const minutes = gameSec / 60;
  const minRooms = Math.max(3, Math.round(minutes / 4));
  const maxFrozen = Math.max(240, Math.round(minutes * 10));
  const roomCount = rooms.size;
  const r1 = roomCount >= minRooms;
  const r2 = worstFrozen <= maxFrozen;
  const selPct = (keysHit.SELECT || 0) / Math.max(1, rows.length);
  say('## Portão de regressão (§12)');
  say('');
  say(
      `- ${r1 ? 'PASS' : 'FAIL'} · R1 salas visitadas: ${roomCount} (mínimo ${minRooms} em ${minutes.toFixed(0)} min)`,
    );
  say(
    `- ${r2 ? 'PASS' : 'FAIL'} · R2 maior trecho preso (mesma sala, sem 20 px de ganho horizontal, fora de luta de chefe): ${worstFrozen} ticks · limite ${maxFrozen}${worstFrozenAt ? ` @tick ${worstFrozenAt.tick} sala ${worstFrozenAt.room} x=${worstFrozenAt.x}` : ''}`,
  );
  say(`- contexto · maior período na mesma sala (em movimento conta): ${worstRun} ticks${worstAt ? ` @sala ${worstAt.room}` : ''}`);
  say(`- contexto · SELECT pressionado em ${(100 * selPct).toFixed(1)}% dos ticks (porta verde/amarela exige girar o slot)`);
  say(`- contexto · decisões por segundo de jogo: ${(rows.length / Math.max(1, gameSec)).toFixed(2)} · custo médio ${mean(rows.map((r) => r.dms || 0)).toFixed(2)} ms/decisão`);
  say(`- contexto · travamento declarado pelo agente: máx ${Math.max(...stuckVals)} ticks, ≥240 em ${stuckVals.filter((s) => s >= 240).length} ticks`);
  say(`- contexto · correções de si mesma registradas: ${Math.max(...rows.map((r) => r.corr ?? 0), 0)}`);
  say(`- contexto · ticks com aperto curto (≤3 frames): ${rows.filter((r) => (r.holdFrames ?? 9) <= 3).length} de ${rows.length} (${pct(rows.filter((r) => (r.holdFrames ?? 9) <= 3).length, rows.length)})`);
  say('');
  say(r1 && r2 ? '**GATE: PASS**' : '**GATE: FAIL**');
  fs.writeFileSync(path.join(dir, 'gate.md'), g.join('\n') + '\n');
  console.log('\n' + g.join('\n'));
  process.exitCode = r1 && r2 ? 0 : 1;
}
