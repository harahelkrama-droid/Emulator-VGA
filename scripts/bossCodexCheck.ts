/**
 * Autoverificação do Codex de Chefes.
 *
 *   npm run check:bosses
 *
 * Cobre integridade dos dados, reconhecimento por assinatura, janelas de vulnerabilidade,
 * proibições de munição (Phantoon/Golden Torizo), rotação por evidência, faseamento por HP,
 * finalização secreta do Draygon e o fallback genérico. Não precisa de emulador: o codex é puro.
 */
import {
  BOSS_STRATEGIES,
  createFightMemory,
  matchBossStrategy,
  planBossFight,
  type BossAmmo,
  type BossColors,
  type BossObservation,
  type BossPlanResult,
  type LoadoutView,
} from '../src/lib/bossCodex';

let passed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const FULL_LOADOUT: LoadoutView = {
  hasMissiles: true,
  missileCount: 45,
  hasSupers: true,
  superCount: 12,
  hasPowerBombs: true,
  powerBombCount: 6,
  hasChargeBeam: true,
  hasIceBeam: true,
  hasWaveBeam: true,
  hasSpazerBeam: true,
  hasPlasmaBeam: true,
  beamsEquippedMask: 0x100a, // charge + plasma + spazer + wave
  hasGrapple: true,
  hasSpaceJump: true,
  hasScrewAttack: true,
  hasVaria: true,
  hasGravity: false,
};

const NO_AMMO: LoadoutView = {
  ...FULL_LOADOUT,
  missileCount: 0,
  superCount: 0,
  powerBombCount: 0,
  hasChargeBeam: false,
};

function obs(patch: Partial<BossObservation> = {}): BossObservation {
  return {
    hp: 600,
    spanX: 20,
    spanY: 22,
    movedPx: 40,
    colors: null,
    entity: undefined,
    samusHp: 300,
    samusMaxHp: 399,
    countdownActive: false,
    openExits: 2,
    grabbedImmobilized: false,
    bossStationary: false,
    stationsDestroyed: 0,
    resumedAfterCutscene: false,
    fightable: false,
    prologueState: false,
    coreExposed: false,
    ...patch,
  };
}

function colors(patch: Partial<BossColors>): BossColors {
  return {
    red: 0,
    yellowGreen: 0,
    silverCyan: 0,
    gold: 0,
    purple: 0,
    orange: 0,
    neonGreen: 0,
    ...patch,
  };
}

function run(observation: BossObservation, loadout: LoadoutView, ticks: number, strategyId: string | null = null): BossPlanResult {
  let memory = null;
  let out: BossPlanResult | null = null;
  for (let i = 0; i < ticks; i++) {
    out = planBossFight({
      observation,
      roomId: 0x42,
      loadout,
      boundStrategyId: strategyId,
      memory,
      targetX: 300,
      targetY: 120,
      samusX: 180,
      samusY: 120,
    });
    memory = out.memory;
  }
  return out as BossPlanResult;
}

console.log('\n\x1b[1m1. Integridade dos dados\x1b[0m');
{
  const ids = BOSS_STRATEGIES.map((s) => s.id);
  check('IDs únicos', new Set(ids).size === ids.length);
  check('Toda estratégia tem fase', BOSS_STRATEGIES.every((s) => s.phases.length > 0));
  check(
    'Toda fase tem nota explicativa (>60 chars)',
    BOSS_STRATEGIES.every((s) => s.phases.every((p) => p.note.length > 60)),
  );
  check(
    'Toda fase tem fila de munição não-vazia',
    BOSS_STRATEGIES.every((s) => s.phases.every((p) => p.ammo.length > 0)),
  );
  const known = new Set<BossAmmo>([
    'BASIC_BEAM', 'CHARGE_BEAM', 'WAVE_BEAM', 'ICE_BEAM', 'SPAZER_BEAM', 'PLASMA_BEAM',
    'MISSILE', 'SUPER_MISSILE', 'POWER_BOMB', 'GRAPPLE_FINISH', 'HYPER_BEAM',
  ]);
  check(
    'Munições citadas existem no vocabulário',
    BOSS_STRATEGIES.every((s) =>
      s.phases.every(
        (p) =>
          p.ammo.every((a) => known.has(a)) &&
          (p.ammoWhileClosed ?? []).every((a) => known.has(a)) &&
          (p.forbidden ?? []).every((a) => known.has(a)),
      ),
    ),
  );
  check('16 entradas catalogadas', BOSS_STRATEGIES.length >= 16, `${BOSS_STRATEGIES.length}`);
  for (const id of [
    'ridley-ceres', 'torizo', 'spore-spawn', 'kraid', 'crocomire', 'phantoon', 'botwoon',
    'draygon', 'golden-torizo', 'ridley-norfour', 'mother-brain', 'sax-humanoid', 'core-x',
    'metroid', 'generic-boss',
  ]) {
    check(`codex contém '${id}'`, ids.includes(id));
  }
}

console.log('\n\x1b[1m2. Reconhecimento por assinatura\x1b[0m');
{
  const phantoon = matchBossStrategy(
    obs({ hp: 520, spanX: 18, spanY: 20, movedPx: 60, colors: colors({ purple: 0.2, red: 0.02 }) }),
  );
  check('Phantoon (roxo, móvel, HP alto)', phantoon.strategy.id === 'phantoon', phantoon.strategy.id);

  const torizo = matchBossStrategy(
    obs({ hp: 480, spanX: 14, spanY: 18, movedPx: 0, colors: colors({ gold: 0.1, orange: 0.02 }) }),
  );
  check('Torizo (dourado, enraizado)', torizo.strategy.id === 'torizo', torizo.strategy.id);

  const gold = matchBossStrategy(
    obs({ hp: 900, spanX: 14, spanY: 18, movedPx: 70, colors: colors({ gold: 0.24, orange: 0.09 }) }),
  );
  check('Golden Torizo vence Torizo quando dourado + móvel', gold.strategy.id === 'golden-torizo', gold.strategy.id);

  const spore = matchBossStrategy(
    obs({ hp: 300, spanX: 26, spanY: 24, movedPx: 0, colors: colors({ yellowGreen: 0.3, red: 0.01 }) }),
  );
  check('Spore Spawn (verde-amarelado, estático, largo)', spore.strategy.id === 'spore-spawn', spore.strategy.id);

  const blob = matchBossStrategy(obs({ hp: 600, spanX: 9, spanY: 9, movedPx: 3, colors: null, entity: 'NONE' }));
  check('Blob desconhecido cai no fallback genérico', blob.strategy.id === 'generic-boss', blob.strategy.id);

  const ridleyPrologue = matchBossStrategy(
    obs({ hp: 400, spanX: 24, spanY: 22, movedPx: 50, colors: colors({ red: 0.2 }), prologueState: true }),
  );
  check('Ridley do prólogo ≠ Ridley de Norfair', ridleyPrologue.strategy.id === 'ridley-ceres', ridleyPrologue.strategy.id);

  const saxByEntity = matchBossStrategy(
    obs({ hp: 999, spanX: 10, spanY: 20, movedPx: 80, entity: 'SAX_VARIA', colors: colors({ orange: 0.2, red: 0.08 }) }),
  );
  check('SA-X reconhecida pela entidade do classificador', saxByEntity.strategy.id === 'sax-humanoid', saxByEntity.strategy.id);
}

console.log('\n\x1b[1m3. Proibições do guia (a parte que mais importa)\x1b[0m');
{
  const ph = run(
    obs({ hp: 520, spanX: 18, spanY: 20, movedPx: 60, colors: colors({ purple: 0.2 }) }),
    FULL_LOADOUT,
    40,
  );
  check('Phantoon nunca seleciona Super Míssil', ph.directive.ammo !== 'SUPER_MISSILE', ph.directive.ammo);
  check('Phantoon usa míssil normal ou carregado', ph.directive.ammo === 'MISSILE' || ph.directive.ammo === 'CHARGE_BEAM', ph.directive.ammo);

  const stillPh = run(
    obs({ hp: 520, spanX: 18, spanY: 20, movedPx: 60, colors: colors({ purple: 0.2 }), bossStationary: true }),
    FULL_LOADOUT,
    40,
  );
  check('Phantoon continua sem Super mesmo parado', stillPh.directive.ammo !== 'SUPER_MISSILE', stillPh.directive.ammo);

  // Golden Torizo parado agarra míssil normal no ar e devolve.
  const gt = run(
    obs({
      hp: 900, spanX: 14, spanY: 18, movedPx: 70, bossStationary: true,
      colors: colors({ gold: 0.24, orange: 0.09 }),
    }),
    FULL_LOADOUT,
    40,
    'golden-torizo',
  );
  check('Golden Torizo parado: míssil normal proibido', gt.directive.ammo !== 'MISSILE', gt.directive.ammo);
  check('Golden Torizo usa Super Míssil ou carregado', gt.directive.ammo === 'SUPER_MISSILE' || gt.directive.ammo === 'CHARGE_BEAM', gt.directive.ammo);

  const gtMoving = run(
    obs({ hp: 900, spanX: 14, spanY: 18, movedPx: 70, bossStationary: false, colors: colors({ gold: 0.2 }) }),
    FULL_LOADOUT,
    3,
    'golden-torizo',
  );
  check('Golden Torizo em movimento: míssil liberado', gtMoving.directive.ammo === 'MISSILE' || gtMoving.directive.ammo === 'SUPER_MISSILE', gtMoving.directive.ammo);

  // Ridley do prólogo: não gasta Super Míssil e não persegue quando a vida cai a 29.
  const ridley = run(obs({ hp: 500, spanX: 24, spanY: 22, movedPx: 60, samusHp: 25, prologueState: true }), FULL_LOADOUT, 20, 'ridley-ceres');
  check('Ridley Ceres: sem Super Míssil', ridley.directive.ammo !== 'SUPER_MISSILE', ridley.directive.ammo);
  check('Ridley Ceres: doNotKill ativo', ridley.directive.doNotKill === true);
  check('Ridley Ceres: vida em 29 → não persegue', ridley.directive.movement === 'DO_NOT_CHASE', ridley.directive.movement);
}

console.log('\n\x1b[1m4. Janela de vulnerabilidade e preparação\x1b[0m');
{
  const closed = run(
    obs({ hp: 400, spanX: 26, spanY: 24, movedPx: 0, colors: colors({ yellowGreen: 0.3, orange: 0.01 }) }),
    FULL_LOADOUT,
    4,
    'spore-spawn',
  );
  check('Spore Spawn com casco fechado: papel SETUP', closed.directive.role === 'SETUP', closed.directive.role);
  check('Spore Spawn fechado: recua para o canto', closed.directive.movement === 'RETREAT_TO_CORNER', closed.directive.movement);
  check('Spore Spawn fechado: não queima Super Míssil', closed.directive.ammo !== 'SUPER_MISSILE', closed.directive.ammo);
  check('Spore Spawn fechado: conserva munição pesada', closed.directive.conserveHeavyAmmo === true || closed.directive.ammo === 'BASIC_BEAM');

  // Agora o casco abre: laranja sobe muito → janela aberta → Super Míssil.
  let memory = null;
  let openResult: BossPlanResult | null = null;
  for (let i = 0; i < 3; i++) {
    openResult = planBossFight({
      roomId: 0x42,
      observation: obs({ hp: 400, spanX: 26, spanY: 24, movedPx: 0, colors: colors({ yellowGreen: 0.3, orange: 0.3 }) }),
      loadout: FULL_LOADOUT,
      boundStrategyId: 'spore-spawn',
      memory,
      targetX: 300, targetY: 120, samusX: 180, samusY: 120,
    });
    memory = openResult.memory;
  }
  check('Spore Spawn com casco aberto: mira o núcleo', openResult?.directive.weakPoint === 'INNER_CORE', String(openResult?.directive.weakPoint));
  check('Spore Spawn aberto: gasta Super Míssil', openResult?.directive.ammo === 'SUPER_MISSILE', String(openResult?.directive.ammo));

  // Botwoon some da tela → emboscada no último buraco visto.
  let mem2 = null;
  let amb: BossPlanResult | null = null;
  for (const visible of [true, true, false, false, false]) {
    amb = planBossFight({
      roomId: 0x42,
      observation: obs({ hp: visible ? 500 : 0, spanX: visible ? 16 : 0, spanY: 16, movedPx: 80, colors: colors({ silverCyan: 0.1 }) }),
      loadout: FULL_LOADOUT,
      boundStrategyId: 'botwoon',
      memory: mem2,
      targetX: 410, targetY: 90, samusX: 200, samusY: 120,
    });
    mem2 = amb.memory;
  }
  check('Botwoon: emboscada ativa quando a cabeça some', amb?.directive.ambush?.active === true);
  check('Botwoon: lembra a última posição da cabeça', amb?.directive.ambush?.x === 410, JSON.stringify(amb?.directive.ambush));
  check('Botwoon: movimento de emboscada', amb?.directive.movement === 'AMBUSH', String(amb?.directive.movement));
}

console.log('\n\x1b[1m5. Verificação empírica (rotação por dano real)\x1b[0m');
{
  // Chefe genérico: se o míssil não fere mas o Super fere, o agente troca.
  let memory = createFightMemory('generic-boss', obs({ hp: 900 }));
  memory.evidence = {
    MISSILE: { probes: 40, damage: 0 },
    SUPER_MISSILE: { probes: 10, damage: 120 },
  };
  memory.currentAmmo = 'MISSILE';
  const rotated = planBossFight({
      roomId: 0x42,
    observation: obs({ hp: 900, spanX: 20, spanY: 20, movedPx: 10, colors: null, entity: 'NONE' }),
    loadout: FULL_LOADOUT,
    boundStrategyId: 'generic-boss',
    memory,
    targetX: 300, targetY: 120, samusX: 200, samusY: 120,
  });
  check('Rotaciona para a munição que comprovadamente fere', rotated.directive.ammo === 'SUPER_MISSILE', rotated.directive.ammo);
  check('Explica a troca no rotationNote', typeof rotated.directive.rotationNote === 'string' && rotated.directive.rotationNote.includes('Mísseis'), String(rotated.directive.rotationNote));
  check('Marca rotated=true', rotated.directive.rotated === true);

  // Crocomire: sem dano de HP nenhum, a estratégia NÃO deve ser considerada errada.
  const croc = run(
    obs({ hp: 400, spanX: 26, spanY: 20, movedPx: 0, colors: colors({ gold: 0.05, red: 0.01 }) }),
    FULL_LOADOUT,
    60,
    'crocomire',
  );
  check('Crocomire: não rotaciona (vitória por empurrão, não por HP)', croc.directive.rotated === false);
  check('Crocomire: empurra para a direita', croc.directive.movement === 'PUSH_EAST', croc.directive.movement);
  check('Crocomire: dano de HP acumulado fica zerado', croc.memory.totalDamageDealt === 0);

  // Dano real observado aumenta os contadores da luta.
  let mem3 = null;
  let dmg: BossPlanResult | null = null;
  let hp = 900;
  for (let i = 0; i < 6; i++) {
    hp -= 20;
    dmg = planBossFight({
      roomId: 0x42,
      observation: obs({ hp, spanX: 20, spanY: 20, movedPx: 10, colors: null, entity: 'NONE' }),
      loadout: FULL_LOADOUT,
      boundStrategyId: 'generic-boss',
      memory: mem3,
      targetX: 300, targetY: 120, samusX: 200, samusY: 120,
    });
    mem3 = dmg.memory;
  }
  check('Acumula dano causado na memória da luta', (dmg?.memory.totalDamageDealt ?? 0) >= 100, String(dmg?.memory.totalDamageDealt));
  check('Acerta contagem de golpes', (dmg?.memory.hitsLanded ?? 0) >= 5, String(dmg?.memory.hitsLanded));
}

console.log('\n\x1b[1m6. Faseamento por HP e eventos\x1b[0m');
{
  const mbEarly = run(obs({ hp: 800, spanX: 24, spanY: 24, movedPx: 0, colors: colors({ red: 0.1 }) }), FULL_LOADOUT, 3, 'mother-brain');
  check('Mother Brain: começa no tanque de vidro', mbEarly.directive.phaseId === 'glass-tank', mbEarly.directive.phaseId);
  check('Mother Brain: míssil é a arma da fase 1', mbEarly.directive.ammo === 'MISSILE', mbEarly.directive.ammo);

  const mbLate = (() => {
    let mem = null;
    let res: BossPlanResult | null = null;
    for (const hp of [800, 500, 300]) {
      res = planBossFight({
      roomId: 0x42,
        observation: obs({ hp, spanX: 24, spanY: 24, movedPx: 0, colors: colors({ red: 0.1 }) }),
        loadout: FULL_LOADOUT, boundStrategyId: 'mother-brain', memory: mem,
        targetX: 300, targetY: 100, samusX: 200, samusY: 120,
      });
      mem = res.memory;
    }
    return res as BossPlanResult;
  })();
  check('Mother Brain: cai para o corpo gigante com HP baixo', mbLate.directive.phaseId === 'giant-body', mbLate.directive.phaseId);

  const mbHyper = run(
    obs({ hp: 300, spanX: 24, spanY: 24, movedPx: 0, resumedAfterCutscene: true, colors: colors({ red: 0.1 }) }),
    FULL_LOADOUT, 3, 'mother-brain',
  );
  check('Mother Brain: pós-cutscene → Hyper Beam', mbHyper.directive.phaseId === 'hyper-beam', mbHyper.directive.phaseId);
  check('Mother Brain: mira para cima no Hyper Beam', mbHyper.directive.aim === 'UP', mbHyper.directive.aim);

  const draygonPre = run(obs({ hp: 700, spanX: 20, spanY: 16, movedPx: 40, stationsDestroyed: 0, colors: colors({ silverCyan: 0.12 }) }), FULL_LOADOUT, 3, 'draygon');
  check('Draygon: primeiro destrói as torres', draygonPre.directive.phaseId === 'cut-stations', draygonPre.directive.phaseId);

  const draygonGrab = run(
    obs({ hp: 700, spanX: 20, spanY: 16, movedPx: 40, stationsDestroyed: 2, grabbedImmobilized: true, colors: colors({ silverCyan: 0.12 }) }),
    FULL_LOADOUT, 1, 'draygon',
  );
  check('Draygon: grapple só depois das torres + agarrada', draygonGrab.directive.finisher === 'DRAYGON_GRAPPLE', String(draygonGrab.directive.finisher));
  check('Draygon: sem torres destruídas não tenta o grapple', draygonPre.directive.finisher === null);

  const grabNoStations = run(
    obs({ hp: 700, spanX: 20, spanY: 16, movedPx: 40, stationsDestroyed: 0, grabbedImmobilized: true, colors: colors({ silverCyan: 0.12 }) }),
    FULL_LOADOUT, 3, 'draygon',
  );
  check('Draygon: agarrada sem torres → segue o plano de torres', grabNoStations.directive.finisher === null && grabNoStations.directive.phaseId === 'cut-stations');

  // Ridley final: supera descarrega → depois sustentação com Space Jump.
  const ridEarly = run(obs({ hp: 1200, spanX: 26, spanY: 24, movedPx: 70, colors: colors({ red: 0.15 }) }), FULL_LOADOUT, 3, 'ridley-norfour');
  check('Ridley final: Super Mísseis primeiro', ridEarly.directive.ammo === 'SUPER_MISSILE', ridEarly.directive.ammo);
  check('Ridley final: fica no ar', ridEarly.directive.movement === 'AIRBORNE', ridEarly.directive.movement);
  const ridLate = (() => {
    let mem = null;
    let res: BossPlanResult | null = null;
    for (const hp of [1200, 900, 500]) {
      res = planBossFight({
      roomId: 0x42,
        observation: obs({ hp, spanX: 26, spanY: 24, movedPx: 70, colors: colors({ red: 0.15 }) }),
        loadout: { ...FULL_LOADOUT, superCount: 0 }, boundStrategyId: 'ridley-norfour', memory: mem,
        targetX: 300, targetY: 90, samusX: 200, samusY: 120,
      });
      mem = res.memory;
    }
    return res as BossPlanResult;
  })();
  check('Ridley final: sem Super → tiro carregado', ridLate.directive.ammo === 'CHARGE_BEAM', ridLate.directive.ammo);

  // SA-X: foge sem loadout, luta quando o agente julga que dá.
  const saxFlee = run(obs({ hp: 1400, spanX: 10, spanY: 20, movedPx: 90, entity: 'SAX_VARIA', fightable: false, colors: colors({ orange: 0.2, red: 0.08 }) }), FULL_LOADOUT, 3, 'sax-humanoid');
  check('SA-X sem estar pronto: desengajar', saxFlee.directive.movement === 'DO_NOT_CHASE', saxFlee.directive.movement);
  check('SA-X fugindo: não gasta míssil', saxFlee.directive.ammo === 'BASIC_BEAM' || saxFlee.directive.ammo === 'CHARGE_BEAM', saxFlee.directive.ammo);
  const saxFight = run(obs({ hp: 1400, spanX: 10, spanY: 20, movedPx: 90, entity: 'SAX_VARIA', fightable: true, colors: colors({ orange: 0.2, red: 0.08 }) }), FULL_LOADOUT, 3, 'sax-humanoid');
  check('SA-X pronta: luta com Super Míssil', saxFight.directive.ammo === 'SUPER_MISSILE', saxFight.directive.ammo);

  // Metroid: precisa de Ice Beam equipado para a preparação.
  const metroid = run(obs({ hp: 200, spanX: 14, spanY: 14, movedPx: 30, entity: 'METROID_LARVA', colors: colors({ red: 0.2, neonGreen: 0.1 }) }), FULL_LOADOUT, 3, 'metroid');
  check('Metroid: exige Ice Beam como preparação', metroid.directive.requireBeam === 'ICE', String(metroid.directive.requireBeam));
  const metroidNoIce = run(
    obs({ hp: 200, spanX: 14, spanY: 14, movedPx: 30, entity: 'METROID_LARVA', colors: colors({ red: 0.2, neonGreen: 0.1 }) }),
    { ...FULL_LOADOUT, hasIceBeam: false, beamsEquippedMask: 0 }, 3, 'metroid',
  );
  check('Metroid sem Ice: cai para dano direto', metroidNoIce.directive.ammo !== 'ICE_BEAM', metroidNoIce.directive.ammo);

  // Core-X: núcleo exposto → parar de atirar e coletar.
  const coreCollect = run(obs({ hp: 40, spanX: 8, spanY: 8, movedPx: 20, coreExposed: true, entity: 'CORE_X_NAKED', colors: colors({ silverCyan: 0.2, gold: 0.06 }) }), FULL_LOADOUT, 3, 'core-x');
  check('Core-X exposto: persegue o núcleo', coreCollect.directive.phaseId === 'collect', coreCollect.directive.phaseId);
  check('Core-X exposto: movimento CHASE', coreCollect.directive.movement === 'CHASE', coreCollect.directive.movement);
  check('Core-X exposto: sinaliza coleta', coreCollect.directive.collectWhenExposed === true);
  const coreFight = run(obs({ hp: 200, spanX: 12, spanY: 12, movedPx: 20, coreExposed: false, entity: 'CORE_X_SILVER', colors: colors({ silverCyan: 0.15, gold: 0.05 }) }), FULL_LOADOUT, 3, 'core-x');
  check('Core-X fechado: abre com míssil', coreFight.directive.phaseId === 'crack-shell' && coreFight.directive.ammo === 'MISSILE', `${coreFight.directive.phaseId}/${coreFight.directive.ammo}`);

  // Metroid Grande: evento de dreno, nunca atira.
  const bigM = run(obs({ hp: 300, spanX: 30, spanY: 30, movedPx: 0, entity: 'BIG_METROID', colors: colors({ neonGreen: 0.3, red: 0.1 }) }), FULL_LOADOUT, 8, 'big-metroid');
  check('Metroid Grande: papel HOLD', bigM.directive.role === 'HOLD', bigM.directive.role);
  check('Metroid Grande: não atira', bigM.directive.mayFire === false);
  check('Metroid Grande: deixa drenar', bigM.directive.letDrain === true);
}

console.log('\n\x1b[1m7. Falta de recursos e robustez\x1b[0m');
{
  const poor = run(obs({ hp: 520, spanX: 18, spanY: 20, movedPx: 60, colors: colors({ purple: 0.2 }) }), NO_AMMO, 5);
  const isBeam = ['BASIC_BEAM', 'CHARGE_BEAM', 'SPAZER_BEAM', 'PLASMA_BEAM', 'WAVE_BEAM', 'ICE_BEAM'].includes(poor.directive.ammo);
  check('Sem míssis nenhum: nunca trava (fica no feixe)', isBeam, poor.directive.ammo);
  check('Slot de HUD coerente (0 = feixe)', poor.directive.desiredSlot === 0, String(poor.directive.desiredSlot));

  const phClosed = run(obs({ hp: 520, spanX: 18, spanY: 20, movedPx: 60, colors: colors({ purple: 0.2, red: 0 }) }), FULL_LOADOUT, 5, 'phantoon');
  check('Phantoon com olho fechado: cutuca e guarda o míssil', phClosed.directive.ammo === 'BASIC_BEAM' && phClosed.directive.conserveHeavyAmmo === true, `${phClosed.directive.ammo}/${phClosed.directive.conserveHeavyAmmo}`);
  const phPatience = run(obs({ hp: 520, spanX: 18, spanY: 20, movedPx: 60, colors: colors({ purple: 0.2, red: 0 }) }), FULL_LOADOUT, 20, 'phantoon');
  check('Phantoon: tolerância de cegueira vencida → míssil', phPatience.directive.ammo === 'MISSILE', phPatience.directive.ammo);
  const phOpen = run(obs({ hp: 520, spanX: 18, spanY: 20, movedPx: 60, colors: colors({ purple: 0.2, red: 0.18 }) }), FULL_LOADOUT, 5, 'phantoon');
  check('Phantoon com olho aberto: usa míssil (nunca Super)', phOpen.directive.ammo === 'MISSILE', phOpen.directive.ammo);

  // Janela "quente": um frame sem cor não deve fechar o momento de atacar.
  let warmMem = null;
  let warm: BossPlanResult | null = null;
  for (const orange of [0.3, 0.3, 0.0, 0.0]) {
    warm = planBossFight({
      roomId: 0x42,
      observation: obs({ hp: 400, spanX: 26, spanY: 24, movedPx: 0, colors: colors({ yellowGreen: 0.3, orange }) }),
      loadout: FULL_LOADOUT, boundStrategyId: 'spore-spawn', memory: warmMem,
      targetX: 300, targetY: 120, samusX: 200, samusY: 120,
    });
    warmMem = warm.memory;
  }
  check('Janela permanece "quente" após 2 frames ruins', warm?.directive.windowOpen === true, JSON.stringify({ open: warm?.directive.windowOpen, note: warm?.directive.windowLabel }));

  const noColors = run(obs({ hp: 520, spanX: 18, spanY: 20, movedPx: 60, colors: null }), FULL_LOADOUT, 5, 'phantoon');
  check('Sem pixels (frame velho): janela assume aberta e atira', noColors.directive.mayFire === true);

  const single = planBossFight({
      roomId: 0x42,
    observation: obs({ hp: 1, spanX: 20, spanY: 20, movedPx: 5 }),
    loadout: FULL_LOADOUT, boundStrategyId: null, memory: null,
    targetX: 200, targetY: 120, samusX: 200, samusY: 120,
  });
  check('Primeiro tick nunca lança exceção', Boolean(single.directive));
  check('Sem NaN na distância', Number.isFinite(single.directive.distance));

  const zeroHp = run(obs({ hp: 0, spanX: 20, spanY: 20, movedPx: 5 }), FULL_LOADOUT, 4, 'torizo');
  check('HP zerado encerra a luta', zeroHp.finished === true);
}

console.log('\n\x1b[1m8. Custos e latência\x1b[0m');
{
  const t0 = performance.now();
  let mem = null;
  for (let i = 0; i < 5000; i++) {
    const r = planBossFight({
      roomId: 0x42,
      observation: obs({ hp: 600 - (i % 400), spanX: 20, spanY: 22, movedPx: i, colors: colors({ purple: 0.1 + (i % 5) / 100 }) }),
      loadout: FULL_LOADOUT, boundStrategyId: null, memory: mem,
      targetX: 300, targetY: 120, samusX: 200, samusY: 120,
    });
    mem = r.memory;
  }
  const ms = performance.now() - t0;
  check(`5.000 planos em ${(ms / 5000).toFixed(4)} ms/tick (< 0,05 ms)`, ms / 5000 < 0.05, `${ms.toFixed(1)} ms total`);
}

console.log(`\n\x1b[1m${failures.length === 0 ? '\x1b[32mTODOS OS TESTES PASSARAM' : `\x1b[31m${failures.length} FALHA(S)`}\x1b[0m  · ${passed} verificações`);
if (failures.length > 0) {
  console.log('\nFalhas:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
