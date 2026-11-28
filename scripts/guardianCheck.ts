/**
 * Verificação da camada de verificação (`src/lib/actionGuardian.ts`).
 *
 *   npm run check:guardian
 *
 * Cada bloco abaixo é uma das causas do relatório do playtest de 25 min
 * (`playtest/RELATORIO-IA-25min.md`) transformada em teste. Elas não são "testes de unidade por
 * gosto": são as cinco afirmações que o agente precisava fazer e não fazia — e que, no ROM real,
 * custaram 21,9 minutos preso em x=37 atirando na mesma parede.
 *
 * O suíte é puro: sem DOM, sem emulador, sem WRAM. Roda em ~50 ms.
 */
import {
  ActionGuardian,
  HypothesisLedger,
  StuckSentinel,
  EscapeLadder,
  JumpModulator,
  SlotDriver,
  PreyChaser,
  DoorAttemptBudget,
  cellKey,
  targetKey,
  type SentinelInput,
} from '../src/lib/actionGuardian';

let passed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? `  ${detail}` : ''}`);
  }
}

function section(t: string): void {
  console.log(`\n\x1b[1m${t}\x1b[0m`);
}

const baseInput = (over: Partial<SentinelInput>): SentinelInput => ({
  tick: 0,
  roomId: 0x10,
  x: 100,
  y: 144,
  keys: ['RIGHT'],
  grounded: true,
  ...over,
});

/* ============================ A. travamento: pular no lugar não é progresso ============ */
section('A. StuckSentinel: o âncora não pode ser desarmada pelo próprio movimento de pulo');
{
  const s = new StuckSentinel();
  // F1 do relatório: `progressStallTicks` zerava em qualquer |Δy| > 28 → a Samus pulando no
  // lugar (28 px de ápice) reiniciava o contador para sempre e `lost` nunca disparava.
  let v = s.current;
  // o que o ROM real mostrou: 1000 ticks em x=37, pulo no lugar (28 px de ápice) a cada par de
  // ticks. O chão só existe no pouso — no resto ela está subindo/caindo.
  for (let t = 0; t < 1000; t++) {
    const onGround = t % 2 === 0;
    v = s.feed(baseInput({ tick: t, x: 37, y: onGround ? 144 : 116, grounded: onGround, keys: ['LEFT'] }));
  }
  check('pular no lugar contra a parede acumula travamento', v.stallTicks >= 400, `stall=${v.stallTicks}`);
  check('e o deslocamento horizontal é o que manda (netDx ~ 0)', Math.abs(v.lastNetDx) <= 5, `netDx=${v.lastNetDx}`);
  check('severidade subiu até o topo', v.severity >= 3, `sev=${v.severity}`);
  check('a direção do EMPURRÃO é medida (LEFT), não a preferida do plano', v.pushDir === 'LEFT', `push=${v.pushDir}`);
  check('presa na parede esquerda da sala', v.pinnedEdge === 'LEFT', `edge=${v.pinnedEdge}`);

  const s2 = new StuckSentinel();
  let v2 = s2.current;
  for (let t = 0; t < 40; t++) v2 = s2.feed(baseInput({ tick: t, x: 60 + t * 5, y: 144, keys: ['RIGHT'] }));
  check('andar 5 px por tick é progresso: travamento ~zero', v2.stallTicks <= 3, `stall=${v2.stallTicks}`);
  check('e o tempo de sala não congela (limiar suave, não reset)', v2.roomTicks <= 120, `roomTicks=${v2.roomTicks}`);

  const s3 = new StuckSentinel();
  for (let t = 0; t < 60; t++) s3.feed(baseInput({ tick: t, x: 37, y: 144, keys: ['LEFT'] }));
  s3.forgive();
  check('forgive() zera o travamento', s3.current.stallTicks === 0, `stall=${s3.current.stallTicks}`);
  check('mas NÃO zera o tempo de sala (perdoar ≠ esquecer)', s3.current.roomTicks >= 55, `roomTicks=${s3.current.roomTicks}`);
  check('e zera o empurrão, para não inverter uma direção que já mudou', s3.current.pushDir === null, `push=${s3.current.pushDir}`);

  const s4 = new StuckSentinel();
  for (let t = 0; t < 30; t++) s4.feed(baseInput({ tick: t, x: 37, y: 144, keys: ['LEFT'], inCombat: true }));
  check('combate NÃO desliga a medição', s4.current.stallTicks >= 25, `stall=${s4.current.stallTicks}`);
  s4.feed(baseInput({ tick: 30, roomId: 0x11, x: 37, y: 144, keys: ['LEFT'], roomChanged: true }));
  check('troca de sala zera tudo (única coisa que zera de fato)', s4.current.stallTicks === 0 && s4.current.roomTicks === 0);
}

/* ============================ B. escada de escape: sem apagar a própria prova ============ */
section('B. EscapeLadder: cada degrau pressupõe o fracasso do anterior');
{
  const s = new StuckSentinel();
  const l = new EscapeLadder();
  const rungs: string[] = [];
  let v = s.current;
  // a sala do playtest: 1.314 ticks empurrando a esquerda de 0x8b7d sem um pixel de ganho
  for (let t = 0; t < 1000; t++) {
    v = s.feed(baseInput({ tick: t, x: 37, y: 144, keys: ['LEFT'] }));
    const plan = l.next(t, v, false, { inCombat: false, canReadMap: true });
    if (plan.engaged) rungs.push(plan.rung);
  }
  const seen = [...new Set(rungs)];
  check('subiu por todos os degraus, na ordem', JSON.stringify(seen) === JSON.stringify(['NUDGE', 'REVERSE_PUSH', 'SWEEP', 'MAP_READ', 'BLOCK_ROOM']), seen.join('>'));
  check('o topo da escada bloqueia a sala no grafo (não existe "para sempre")', seen[seen.length - 1] === 'BLOCK_ROOM');
  check('o travamento continuou crescendo durante a escada', v.stallTicks > 900, `stall=${v.stallTicks}`);
  check('o empurrão invertido é o oposto do medido', l.next(1000, { ...v, pushDir: 'LEFT' }, false, { inCombat: false, canReadMap: true }).dir !== 'LEFT');
  check('sem travamento, sem escada', l.next(0, new StuckSentinel().current, false, { inCombat: false, canReadMap: true }).engaged === false);

  const l2 = new EscapeLadder();
  const stalled = { ...v, pushDir: 'RIGHT' as const };
  const before = l2.next(1000, stalled, false, { inCombat: true, canReadMap: true });
  check('em combate a escada não intervém (o codex manda no corpo)', !before.engaged && before.rung === 'NONE', `rung=${before.rung}`);

  // sala nova → escada nova (o `stuckInRoomTicks` antigo sobrevivia à sala e disparava escape
  // na sala seguinte, que é o oposto do que se quer)
  const l3 = new EscapeLadder();
  l3.next(0, { ...v, stallTicks: 500 }, false, { inCombat: false, canReadMap: false });
  check('sem permissão de menu, o degrau MAP_READ é pulado', l3.currentRung === 'BLOCK_ROOM', `rung=${l3.currentRung}`);
  check('e a troca de sala reseta a escada', l3.next(1, v, true, { inCombat: false, canReadMap: true }).engaged === false);
}

/* ============================ C. orçamento de aposta: "já tentei, não insisto" ============ */
section('C. HypothesisLedger: toda jogada tem orçamento e o resultado é conferido');
{
  const h = new HypothesisLedger();
  const key = targetKey(0x8b7d, 'XRAY', 0, 23);
  // F3 do relatório: `secretPaths.clear()` a cada tick apagava o `tested` → 5.678 ticks no mesmo
  // bloco. Aqui: abrir é idempotente, e morrer é para sempre (dentro da sala).
  for (let t = 0; t < 20; t++) h.open(key, 'SECRET_BLOCK', 0x8b7d, 3, 'bloco falso (0,23)');
  check('reabrir a mesma aposta não zera o histórico', h.get(key)!.attempts === 0, `attempts=${h.get(key)!.attempts}`);
  for (let i = 0; i < 3; i++) {
    h.attempt(key, i);
    h.settle(key, false, i); // "o bloco continua sólido"
  }
  check('três tentativas sem efeito matam a aposta', h.isDead(key), JSON.stringify(h.snapshot(1)[0]));
  check('e o cadastro responde quantas apostas morreram', h.deadCount() === 1);
  for (let t = 3; t < 50; t++) h.open(key, 'SECRET_BLOCK', 0x8b7d, 3);
  check('morta é morta: reabrir não ressuscita no tick seguinte', h.isDead(key));
  h.open(targetKey(0x1, 'DOOR_AMMO', 40, 30), 'DOOR_AMMO', 1, 3);
  h.attempt(targetKey(0x1, 'DOOR_AMMO', 40, 30), 1);
  h.settle(targetKey(0x1, 'DOOR_AMMO', 40, 30), true, 2);
  check('efeito esperado recredita a aposta (nada é morto por engano)', !h.isDead(targetKey(0x1, 'DOOR_AMMO', 40, 30)));
  h.attempt(targetKey(0x1, 'DOOR_AMMO', 40, 30), 3);
  h.settle(targetKey(0x1, 'DOOR_AMMO', 40, 30), false, 4);
  check('mas o crédito não é infinito: volta a morrer no orçamento', !h.isDead(targetKey(0x1, 'DOOR_AMMO', 40, 30)), 'falha 1 < orçamento 3');
  h.resetRoom(0x8b7d);
  check('reabrir a sala (item novo) limpa as apostas daquela sala', h.get(key) === undefined);

  // chaves não colidem entre salas
  check('cellKey/targetKey carregam a sala (sem colisão entre 0x10 e 0x11)', cellKey(0x10, 3, 4) !== cellKey(0x11, 3, 4));

  // poda determinística: 1.314 salas não podem estourar a memória nem o tempo de decisão
  const big = new HypothesisLedger(64);
  for (let i = 0; i < 500; i++) {
    const k = targetKey(i, 'ITEM_ROUTE', i, i);
    big.open(k, 'ITEM_ROUTE', i, 1);
    big.attempt(k, i);
    big.settle(k, false, i);
  }
  check('o mapa de apostas é limitado (sem crescimento com o tamanho do mundo)', big.size() <= 64, `size=${big.size()}`);
}

/* ============================ D. pulo com altura = ==================================== */
section('D. JumpModulator: o vão define a duração do aperto, e o ápice o corta');
{
  const j = new JumpModulator();
  // F5: `nextJump(want, 3)` em tudo quanto é lugar — um tamanho único, sempre quase cheio
  const tiny = j.plan(140, 144, true, 125); // quina a 4 px
  const small = j.plan(120, 144, true, 125); // 24 px
  const mid = j.plan(90, 144, true, 125); // 54 px
  const full = j.plan(50, 144, true, 125); // 94 px
  check('vão mínimo = toque (3 frames)', tiny.holdFrames === 3, `f=${tiny.holdFrames}`);
  check('vão pequeno = pulo curto (6 frames)', small.holdFrames === 6, `f=${small.holdFrames}`);
  check('vão médio = 14 frames', mid.holdFrames === 14, `f=${mid.holdFrames}`);
  check('vão alto = pulo cheio (22 frames)', full.holdFrames === 22, `f=${full.holdFrames}`);
  check('apertos monotonically crescentes com o vão', tiny.holdMs < small.holdMs && small.holdMs < mid.holdMs && mid.holdMs < full.holdMs);
  check('o toque fino dura menos que um tick de 90 ms (era o que a UI não deixava expressar)', tiny.holdMs < 90, `${tiny.holdMs} ms`);
  check('holdMs bate com frames de jogo (16,67 ms/frame)', Math.abs(mid.holdMs - 14 * (1000 / 60)) < 2, `${mid.holdMs}`);
  check('holdTicks nunca passa de 6 (não hipoteca a reação)', full.holdTicks <= 6, `t=${full.holdTicks}`);

  // corte antecipado: já subiu o suficiente → solta
  const j2 = new JumpModulator();
  j2.plan(90, 144, true, 125); // decolagem em y=144
  const rising = j2.plan(90, 110, false, 125); // subiu 34 px, faltam 20 → segura
  const apex = j2.plan(90, 88, false, 125); // subiu 56 px > 54 do vão → solta
  check('subindo sem altura suficiente: segurar', !rising.release, `why=${rising.why}`);
  check('altura do vão alcançada: soltar o botão', apex.release, `why=${apex.why}`);
  check('e o motivo diz por quê (o painel precisa explicar a decisão)', /soltando o pulo/.test(apex.why));

  const j3 = new JumpModulator();
  const over = j3.plan(-400, 144, true, 125); // vão de 544 px: acima do pulo simples
  check('vão impossível não vira "pule mais forte" (tema 26 frames e avisa)', over.holdFrames === 26 && /encadeie/.test(over.why), over.why);
}

/* ====================== E. SELECT é seletor rotativo, não "aperto e torço" ============== */
section('E. SlotDriver: gira até a casa certa e sabe quando o HUD não tem aquela casa');
{
  const sl = new SlotDriver();
  sl.setOwnedAmmo(true, true, true);
  check('com os três especiais o seletor tem 4 casas', sl.state.ownedSlots === 4, `s=${sl.state.ownedSlots}`);
  // comporta verde = SUPER MÍSSIL = slot 2: um toque só nunca chega
  const a = sl.plan(0, 0, 2, true);
  const b = sl.plan(1, 1, 2, true);
  const c = sl.plan(2, 2, 2, true);
  check('do feixe para o super míssil: 2 toques, um por tick', a.tapSelect && b.tapSelect, `${JSON.stringify([a.tapSelect, b.tapSelect])}`);
  check('no terceiro tick o HUD já bateu: para de girar', !c.tapSelect && !c.restoreBeam && c.why.includes('selecionado'), c.why);
  check('enquanto gira, o pedido fica armado (ninguém devolve ao feixe no meio)', sl.armed(2) && !sl.armed(99));

  const sl2 = new SlotDriver();
  sl2.setOwnedAmmo(true, false, false);
  check('sem super míssil na ROM, o seletor tem 2 casas', sl2.state.ownedSlots === 2, `s=${sl2.state.ownedSlots}`);
  const g1 = sl2.plan(0, 0, 2, false);
  check('e o pedido impossível é recusado na hora, sem queimar SELECT', !g1.tapSelect && g1.gaveUp, g1.why);
  check('com o especial zerado ela também desiste (não gasta)', sl2.plan(1, 0, 1, false).gaveUp);

  const sl3 = new SlotDriver();
  sl3.setOwnedAmmo(true, true, false);
  for (let i = 0; i < 6; i++) sl3.plan(i, (i % 3) as 0 | 1 | 2, 3, true);
  check('deu a volta completa sem achar a casa → desiste com vergonha', sl3.state.gaveUp, JSON.stringify(sl3.state));

  const sl4 = new SlotDriver();
  sl4.setOwnedAmmo(true, true, true);
  sl4.plan(0, 2, 0, true);
  check('de slot 2 para o feixe: devolver o item (cancel), não girar', sl4.state.taps === 0);
}

/* =================== F. matou o X: encostar é o que coleta, atirar desperdiça ================== */
section('F. PreyChaser: travar no alvo, matar, e absorver o parasita antes de voltar a andar');
{
  const p = new PreyChaser();
  const mob = { slot: 3, x: 120, y: 140, hp: 2, xRadius: 12, yRadius: 12 };
  const ctx = { wantFight: true, needHeal: false, needAmmo: false, maxHealth: 99 };
  const e1 = p.decide(0, [mob], { x: 100, y: 144 }, ctx);
  check('trava no alvo (lock-on, não re-escolha a cada tick)', e1.kind === 'ENGAGE' && e1.slot === 3, JSON.stringify(e1));
  const e2 = p.decide(1, [{ ...mob, x: 116 }], { x: 100, y: 144 }, ctx);
  check('mantém o alvo mesmo com outro mais perto no tick seguinte', e2.kind === 'ENGAGE' && e2.slot === 3, JSON.stringify(e2));

  // X solto: hitbox pequena, hp ~0, perto → ABSORVER (andar), nunca atirar
  const drifter = { slot: 7, x: 118, y: 138, hp: 1, xRadius: 8, yRadius: 8 };
  const a1 = p.decide(2, [drifter], { x: 100, y: 144 }, ctx);
  check('X solto vira ABSORV (encostar), não alvo de tiro', a1.kind === 'ABSORB', JSON.stringify(a1));
  check('e a mira acompanha o X (ele flutua)', a1.kind === 'ABSORB' && (a1.aim === null || a1.aim === 'UP'));

  // abate do alvo travado → janela de coleta no ponto do corpo
  const p2 = new PreyChaser();
  p2.decide(0, [mob], { x: 100, y: 144 }, ctx);
  const heal = { wantFight: true, needHeal: true, needAmmo: false, maxHealth: 99 };
  // ela está a 60 px do corpo: a varredura tem que começar
  const after = p2.decide(1, [], { x: 40, y: 144 }, heal);
  check('abate com vida baixa abre a varredura do ponto onde ele caiu', after.kind === 'SWEEP_LOOT' && after.dir === 'RIGHT', JSON.stringify(after));
  let n = 1;
  let last: ReturnType<PreyChaser['decide']> = after;
  while (last.kind === 'SWEEP_LOOT' && n < 200) last = p2.decide(++n, [], { x: Math.min(100, 40 + n * 6), y: 144 }, heal);
  check('e a varredura tem prazo (não dura a sala inteira)', n < 70, `tick=${n}`);

  // a lista encolheu por outro motivo (inimigo saiu do recorte) NÃO é abate
  const p3 = new PreyChaser();
  p3.decide(0, [mob, { ...mob, slot: 4, x: 200 }], { x: 100, y: 144 }, ctx);
  const fake = p3.decide(1, [mob], { x: 100, y: 144 }, { ...ctx, needAmmo: true });
  check('inimigo que sumiu da visão não conta como abate', fake.kind !== 'SWEEP_LOOT', JSON.stringify(fake));

  // sem licença de luta (chefe/SA-X/escolta mandando), o predador se calado
  const p4 = new PreyChaser();
  p4.decide(0, [mob], { x: 100, y: 144 }, { ...ctx, needAmmo: true });
  const licensed = p4.decide(1, [], { x: 100, y: 144 }, { wantFight: false, needHeal: true, needAmmo: true, maxHealth: 99 });
  check('roteiro de chefe manda no corpo: o caçador não assume', licensed.kind === 'NONE', JSON.stringify(licensed));
  const noNeed = p4.decide(2, [drifter], { x: 116, y: 144 }, { wantFight: true, needHeal: false, needAmmo: false, maxHealth: 99 });
  check('X encostando é coleta mesmo com vida cheia (é cura e é munição)', noNeed.kind === 'ABSORB', JSON.stringify(noNeed));
}

/* ============ G. facade: orçamento por tick e o retrato que a UI precisa mostrar ============ */
section('G. ActionGuardian: O(1) por tick e auditável');
{
  const g = new ActionGuardian();
  const sameBet = targetKey(0x10, 'XRAY', 320, 320);
  const t0 = performance.now();
  for (let t = 0; t < 20000; t++) {
    g.sentinel.feed(baseInput({ tick: t, x: 37 + (t % 3), y: 144, keys: ['LEFT'] }));
    g.jumpHold(100, 144, t % 7 === 0, 125);
    if (t % 20 === 0) {
      g.hypotheses.open(sameBet, 'SECRET_BLOCK', 0x10, 3);
      g.hypotheses.attempt(sameBet, t);
      g.hypotheses.settle(sameBet, false, t);
    }
  }
  const ms = performance.now() - t0;
  check(`20.000 ticks de guardião em ${(ms / 20000).toFixed(4)} ms/tick (< 0,05 ms)`, ms / 20000 < 0.05, `${ms.toFixed(1)} ms no total`);
  const snap = g.snapshot();
  check('o snapshot traz o que a tela precisa (stall, degrau, apostas mortas)', snap.stallTicks > 0 && snap.deadCount > 0 && typeof snap.escape.step === 'number', JSON.stringify({ s: snap.stallTicks, d: snap.deadCount }));
  check('e descreve o pulo em frames+px, não em "3 ticks"', typeof snap.jump.holdFrames === 'number' && snap.jump.holdFrames !== 3, JSON.stringify(snap.jump));
  g.reset();
  check('reset limpa a camada inteira (nada sobrevive a um novo jogo)', g.snapshot().stallTicks === 0 && g.snapshot().deadCount === 0);
}

/* ===== H. o cenário do playtest, em miniatura: 1.314 ticks preso tem que virar fuga ===== */
section('H. Regression do poço de 21,9 min (sala 0x8b7d): travamento com desfecho');
{
  // Reconstrução fiel do trecho medido: x preso em 37, LEFT segurado em 91 % dos ticks,
  // pulos no lugar a cada ~8 ticks, roomId inalterado por 1.314 ticks. O que se exige não é
  // "ela saiu da sala" (isso depende do mundo), é que a pilha de decisões tenha subido até o
  // degrau que muda de rota — o que, no código antigo, nunca acontecia.
  const g = new ActionGuardian();
  let stallMax = 0;
  let reachedBlock = false;
  let reversalSeen = 0;
  let firstBlockTick = -1;
  let mapReadAfterBlock = 0;
  let blockEpisodes = 0;
  let prevRung = 'NONE';
  for (let t = 0; t < 1314; t++) {
    const onGround = t % 8 < 4;
    const v = g.sentinel.feed(
      baseInput({
        tick: t,
        roomId: 0x8b7d,
        x: 37,
        y: onGround ? 144 : 120,
        grounded: onGround,
        keys: t % 3 === 0 ? ['RIGHT'] : ['LEFT'],
      }),
    );
    stallMax = Math.max(stallMax, v.stallTicks);
    const plan = g.ladder.next(t, v, false, { inCombat: false, canReadMap: true });
    if (plan.engaged) {
      if (plan.rung === 'BLOCK_ROOM') {
        reachedBlock = true;
        if (firstBlockTick < 0) firstBlockTick = t;
        if (prevRung !== 'BLOCK_ROOM') blockEpisodes++;
      }
      if (plan.rung === 'REVERSE_PUSH' && plan.dir === 'RIGHT') reversalSeen++;
      if (firstBlockTick >= 0 && t > firstBlockTick && plan.rung === 'MAP_READ') mapReadAfterBlock++;
    }
    if (plan.rung !== 'NONE') prevRung = plan.rung;
  }
  check('o travamento do poço é detectado (stall ≥ 400)', stallMax >= 400, `máx=${stallMax}`);
  check('inverteu o empurrão para RIGHT em vez de inverter a preferência de rota', reversalSeen >= 8, `${reversalSeen} ticks`);
  check('e terminou bloqueando a sala no grafo (o "nunca mais" que faltava)', reachedBlock);
  check('a regra do relatório: nenhuma sala pode ter >240 ticks sem troca de roomId — aqui a escada força o desfecho', g.snapshot().escape.rung === 'BLOCK_ROOM', `rung=${g.snapshot().escape.rung}`);
  // regressão achada pelo playtest: o topo da escada era ABSORVENTE — BLOCK_ROOM prendia o degrau
  // e o MAP_READ do meio, única coisa que consulta o mapa quando ela está perdida, nunca mais era
  // oferecido (na simulação de navegação isso atrasou o START para além da porta de teste).
  check('BLOCK_ROOM não é absorvente: a escada dá ciclo e insiste em novos degraus', blockEpisodes >= 2, `${blockEpisodes} episódios`);
  check('e o degrau MAP_READ volta a ser oferecido depois de bloquear a sala', mapReadAfterBlock > 0, `${mapReadAfterBlock} ticks`);
}

section('I. pacing: ida e volta pela sala não é progresso');
{
  // Atravessar a sala e voltar: a amplitude é grande, o |Δx| por passo é grande, e mesmo assim
  // ela não saiu do lugar. Foi o modo final da sessão depois de fechar o vaivém de porta
  // (9.331 ticks numa sala, detector marcando stall = 48 porque a âncora andava a cada margem).
  const g = new ActionGuardian();
  let oscillated = false;
  let stallMax = 0;
  for (let t = 0; t < 400; t++) {
    const leg = Math.floor(t / 14) % 2;
    const k = t % 14;
    const x = leg === 0 ? 40 + k * 11 : 190 - k * 11;
    const v = g.sentinel.feed(
      baseInput({ tick: t, roomId: 0x1234, x, y: 144, grounded: true, keys: leg === 0 ? ['RIGHT'] : ['LEFT'] }),
    );
    stallMax = Math.max(stallMax, v.stallTicks);
    if (v.oscillating) oscillated = true;
  }
  check('ida e volta vira `oscillating`', oscillated);
  check('e o travamento cresce mesmo com amplitude grande (a âncora não anda)', stallMax >= 120, `máx=${stallMax}`);

  // travessia legítima: mesmo ritmo de passo, mas ela sai pela outra ponta
  const g2 = new ActionGuardian();
  let clean = true;
  for (let t = 0; t < 120; t++) {
    const v = g2.sentinel.feed(baseInput({ tick: t, roomId: 0x1234, x: 40 + t * 11, y: 144, grounded: true, keys: ['RIGHT'] }));
    if (v.oscillating || v.stallTicks > 4) clean = false;
  }
  check('travessia em linha reta NÃO é oscillating', clean);

  // soleira de porta: o heurístico de chão deste hack lê "no ar" o tempo todo. Se o relógio só
  // andar em solo, o travamento fica cego exatamente no estado onde ela congela.
  const g3 = new ActionGuardian();
  let airStall = 0;
  for (let t = 0; t < 200; t++) {
    const v = g3.sentinel.feed(baseInput({ tick: t, roomId: 0x77, x: 216, y: 144, grounded: false, keys: ['RIGHT'] }));
    airStall = Math.max(airStall, v.stallTicks);
  }
  check('parada no ar também conta travamento (soleira de porta não é ponto cego)', airStall >= 150, `máx=${airStall}`);
}

section('J. DoorAttemptBudget: a soleira tem prazo, e piscar o sensor não dá anistia');
{
  const b = new DoorAttemptBudget(120);
  let fired = 0;
  for (let t = 0; t < 119; t++) if (b.feed(t, 0x8cb3, 'RIGHT@13:9')) fired++;
  check('119 ticks na mesma porta não desistem ainda', fired === 0, `${fired}`);
  check('o 120º tick dá o prazo por encerrado', b.feed(119, 0x8cb3, 'RIGHT@13:9') === true);
  check('e a porta fica registrada no estado para a UI', b.state.doorKey === '36019:RIGHT@13:9', b.state.doorKey);
  // A REGRESSÃO QUE ESTA CLASSE NASCEU PARA MATAR: o contador inline comparava `=== 120` e
  // zerava ao sair da soleira. Uma piscada do "near door" a cada 2 ticks e o prazo nunca vencia
  // — foram 9.160 ticks sentado em 0x8CB3 x=216.
  const flicker = new DoorAttemptBudget(120);
  let flickerFired = 0;
  for (let t = 0; t < 600; t++) {
    const near = t % 2 === 0 ? 'RIGHT@13:9' : null;
    if (flicker.feed(t, 0x8cb3, near)) flickerFired++;
  }
  check('com o sensor piscando a cada outro tick, o prazo ainda vence', flickerFired >= 1, `${flickerFired} disparos`);
  // sair de verdade (ir procurar outra porta) não pode acumular dívida para sempre
  const away = new DoorAttemptBudget(120);
  for (let t = 0; t < 100; t++) away.feed(t, 0x8cb3, 'RIGHT@13:9');
  for (let t = 100; t < 140; t++) away.feed(t, 0x8cb3, null);
  check('40 ticks fora da soleira apagam a conta (ela foi fazer outra coisa)', away.state.ticks === 0, `${away.state.ticks}`);
  // porta nova = aposta nova; não herda o fracasso da anterior
  const other = new DoorAttemptBudget(120);
  for (let t = 0; t < 119; t++) other.feed(t, 0x8cb3, 'RIGHT@13:9');
  for (let t = 119; t < 130; t++) other.feed(t, 0x8cb3, 'LEFT@1:9');
  check('trocar de porta reinicia o orçamento (a culpa não é da nova porta)', other.state.ticks === 11, `${other.state.ticks}`);
  {
    const once = new DoorAttemptBudget(3);
    for (let t = 0; t < 2; t++) once.feed(t, 1, 'K');
    const first = once.feed(3, 1, 'K');
    const second = once.feed(4, 1, 'K');
    check('o `feed` devolve `true` uma vez só por porta (sem spam de desistência)', first === true && second === false, `${first}/${second}`);
    check('e o estado declara que aquela porta já foi dada por perdida', once.gaveUp === true);
  }
  {
    // janela de tolerância: 8 ticks fora não jogam fora 119 ticks dentro
    const grace = new DoorAttemptBudget(120);
    for (let t = 0; t < 119; t++) grace.feed(t, 1, 'K');
    for (let t = 119; t < 125; t++) grace.feed(t, 1, null);
    check('ausência curta preserva a conta acumulada', grace.state.ticks === 119, `${grace.state.ticks}`);
  }
  check('o guardião expõe o estado no snapshot (a UI mostra a tentativa)', 'doorAttempt' in new ActionGuardian().snapshot());
}

section('K. capStep: na fuga com contador a escada não bloqueia a sala nem abre o mapa');
{
  const mk = () => {
    const g = new ActionGuardian();
    // travamento longo, sem progresso, sem sala nova
    for (let t = 0; t < 700; t++) {
      g.sentinel.feed(baseInput({ tick: t, roomId: 0x55, x: 30 + (t % 7), y: 144, grounded: true, keys: ['RIGHT'] }));
    }
    return g;
  };
  const capped = mk();
  const rungs = new Set<string>();
  for (let t = 700; t < 1300; t++) {
    capped.sentinel.feed(baseInput({ tick: t, roomId: 0x55, x: 30 + (t % 7), y: 144, grounded: true, keys: ['RIGHT'] }));
    const p = capped.ladder.next(t, capped.sentinel.current, false, { inCombat: false, canReadMap: true, capStep: 2 });
    rungs.add(p.rung);
  }
  check('com capStep=2 a escada nunca chega em MAP_READ/BLOCK_ROOM', !rungs.has('MAP_READ') && !rungs.has('BLOCK_ROOM'), [...rungs].join(','));
  check('e CICLA os degraus de movimento em vez de pinar no mais alto', rungs.has('REVERSE_PUSH') && rungs.has('SWEEP'), [...rungs].join(','));

  const free = mk();
  const rungsFree = new Set<string>();
  for (let t = 700; t < 1300; t++) {
    free.sentinel.feed(baseInput({ tick: t, roomId: 0x55, x: 30 + (t % 7), y: 144, grounded: true, keys: ['RIGHT'] }));
    rungsFree.add(free.ladder.next(t, free.sentinel.current, false, { inCombat: false, canReadMap: true }).rung);
  }
  check('sem o teto, o mesmo cenário sobe até bloquear a sala (a isenção é o que muda)', rungsFree.has('BLOCK_ROOM'), [...rungsFree].join(','));
}

console.log(
  failures.length === 0
    ? `\n\x1b[1m\x1b[32mGUARDA DE AÇÃO OK\x1b[0m  · ${passed} verificações\n`
    : `\n\x1b[1m\x1b[31m${failures.length} FALHA(S)\x1b[0m  · ${passed + failures.length} verificações\n\nFalhas:\n${failures.map((f) => `  - ${f}`).join('\n')}\n`,
);
process.exit(failures.length === 0 ? 0 : 1);
