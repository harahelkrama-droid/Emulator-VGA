/**
 * Checagens da escolta de Metroid (o "seguir o ômega" em vez de atirar nele):
 *
 *   npm run check:escort
 *
 * Os cenários são os frames reais do usuário: (1) a sala azul da Tourian, onde a IA ficou
 * parada esperando um dreno que só existe no prólogo, e (2) a sala de lava, onde ela parou de
 * avançar. O teste é da DECISÃO (função pura) — as teclas são montadas no agente em cima dela.
 */
import {
  ESCORT_DRAIN_PATIENCE_TICKS,
  ESCORT_MEMORY_TICKS,
  ESCORT_MAX_DIST,
  ESCORT_MIN_DIST,
  decideEscort,
  metroidKillReady,
  type EscortDoor,
  type EscortInput,
  type EscortPlan,
} from '../src/lib/metroidEscort';

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
function section(t: string): void {
  console.log(`\n\x1b[1m${t}\x1b[0m`);
}

const DOORS: EscortDoor[] = [
  { key: 'LEFT@0:8', side: 'LEFT', x: 8, y: 136, open: true },
  { key: 'RIGHT@15:8', side: 'RIGHT', x: 248, y: 136, open: true },
  { key: 'UP@7:2', side: 'UP', x: 120, y: 40, open: false },
];

const base = (over: Partial<EscortInput>): EscortInput => ({
  samusX: 100,
  samusY: 136,
  entity: { x: 180, y: 120, vx: 0, vy: 0, hp: 400, kind: 'BIG' },
  ticksSinceSeen: 0,
  lastExitDir: null,
  doors: DOORS,
  canKill: false,
  drainResolvesRescue: false,
  roomHasPendingBusiness: false,
  ticksSinceProgress: 0,
  roomWidthPx: 256,
  ...over,
});
const run = (over: Partial<EscortInput>): EscortPlan => decideEscort(base(over));

section('A. O dreno do prólogo não pode virar espera eterna (bug da sala azul)');
{
  const p = run({ drainResolvesRescue: true, ticksSinceProgress: 10 });
  check('no prólogo, fica perto e deixa drenar', p.action === 'HOLD', p.action);
  check('enquanto espera, não para de vigiar o bicho', p.ignoreMobs);
  const stale = run({ drainResolvesRescue: true, ticksSinceProgress: ESCORT_DRAIN_PATIENCE_TICKS + 30 });
  check('depois da paciência, para de esperar e volta a andar', stale.action !== 'HOLD', stale.action);
  check('…escoltando (não fugindo)', stale.action === 'FOLLOW', stale.action);
  const noPrologue = run({ drainResolvesRescue: false, ticksSinceProgress: 0 });
  check('fora do prólogo não existe "esperar o resgate"', noPrologue.action === 'FOLLOW', noPrologue.action);
  const withBusiness = run({ drainResolvesRescue: true, roomHasPendingBusiness: true, ticksSinceProgress: 0 });
  check('com item/chefe pendente na sala, a escolta tem prioridade', withBusiness.action === 'FOLLOW', withBusiness.action);
}

section('B. Escoltar = ficar na zona do Metroid, sem atirar');
{
  const far = run({ entity: { x: 100 + ESCORT_MAX_DIST + 40, y: 120, vx: 0, vy: 0, hp: 400, kind: 'BIG' } });
  check('longe demais: anda atrás', far.action === 'FOLLOW' && far.dir === 'RIGHT', `${far.action}/${far.dir}`);
  const near = run({ entity: { x: 100 + 20, y: 120, vx: 0, vy: 0, hp: 400, kind: 'BIG' } });
  check('perto demais: abre distância (dreno dói)', near.action === 'FOLLOW' && near.dir === 'LEFT', `${near.action}/${near.dir}`);
  const zone = run({ entity: { x: 100 + (ESCORT_MIN_DIST + ESCORT_MAX_DIST) / 2, y: 120, vx: 0, vy: 0, hp: 400, kind: 'BIG' } });
  check('na zona: acompanha sem se mexer à toa', zone.action === 'FOLLOW' && zone.dir === null && zone.keepDistance, `${zone.action}/${zone.dir}`);
  const above = run({ entity: { x: 160, y: 60, vx: 0, vy: 0, hp: 400, kind: 'BIG' } });
  check('ele acima: alinha a altura (UP)', above.vertical === 'UP', String(above.vertical));
  const below = run({ entity: { x: 160, y: 200, vx: 0, vy: 0, hp: 400, kind: 'BIG' } });
  check('ele abaixo: desce', below.vertical === 'DOWN', String(below.vertical));
  check('escoltar nunca vira combate com mob', run({}).ignoreMobs === true);
}

section('C. Ele saiu da tela: correr atrás pela mesma porta');
{
  const gone = run({ entity: null, ticksSinceSeen: 40, lastExitDir: 'RIGHT' });
  check('vai atrás pela porta por onde ele saiu', gone.action === 'CHASE_DOOR' && gone.dir === 'RIGHT', gone.action);
  check('aponta o batente certo', gone.doorKey === 'RIGHT@15:8', String(gone.doorKey));
  const fleeing = run({ entity: { x: 246, y: 130, vx: 2, vy: 0, hp: 400, kind: 'OMEGA' } });
  check('ainda na tela, mas fugindo para o batente: já corre atrás', fleeing.action === 'CHASE_DOOR' && fleeing.dir === 'RIGHT', fleeing.action);
  const tooOld = run({ entity: null, ticksSinceSeen: ESCORT_MEMORY_TICKS + 10, lastExitDir: 'LEFT' });
  check('memória vencida não persegue fantasma', tooOld.action === 'NONE', tooOld.action);
  const noDoor = run({ entity: null, ticksSinceSeen: 5, lastExitDir: 'RIGHT', doors: [] });
  check('sem porta nenhuma: nada a comprometer', noDoor.action === 'NONE' || noDoor.doorKey === null, noDoor.action);
}

section('D. Matar só quando dá para matar');
{
  const noIce = run({ canKill: false, entity: { x: 140, y: 130, vx: 0, vy: 0, hp: 400, kind: 'LARVA' } });
  check('sem Ice Beam não se atira em Metroid (é o "perder tempo")', noIce.action === 'FOLLOW', noIce.action);
  const ice = run({ canKill: true, entity: { x: 140, y: 130, vx: 0, vy: 0, hp: 400, kind: 'LARVA' } });
  check('com gelo + míssil e ele no caminho: luta', ice.action === 'FIGHT' && ice.dir === 'RIGHT', `${ice.action}/${ice.dir}`);
  const farKill = run({ canKill: true, entity: { x: 100 + 200, y: 130, vx: 0, vy: 0, hp: 400, kind: 'LARVA' } });
  check('matável mas longe: ainda é escolta, não tiroteio', farKill.action === 'FOLLOW', farKill.action);
}

section('D2. "Dá para matar" é uma função só (escolta e ramo do ômega não podem divergir)');
{
  check('sem Ice Beam, nunca atirar (0x0002 é o bit do gelo)', !metroidKillReady(0x0001 | 0x0008, 40));
  check('gelo sem míssil também não', !metroidKillReady(0x0002, 0));
  check('gelo + míssil = pode matar', metroidKillReady(0x0002, 1));
}

section('E. O plano sempre diz por quê (o HUD precisa explicar a decisão)');
{
  const reasons = [
    run({}),
    run({ drainResolvesRescue: true }),
    run({ entity: null, ticksSinceSeen: 10, lastExitDir: 'LEFT' }),
    run({ canKill: true, entity: { x: 130, y: 130, vx: 0, vy: 0, hp: 400, kind: 'LARVA' } }),
  ];
  check('todo plano escolhido vem com motivo legível', reasons.every((r) => r.action === 'NONE' || r.reason.length > 8), JSON.stringify(reasons.map((r) => r.reason)));
  check('o motivo cita o Metroid (não um genérico "inimigo")', reasons.some((r) => /Metroid/i.test(r.reason)));
}

console.log(
  failures.length === 0
    ? `\n\x1b[1m\x1b[32mESCOLTA OK\x1b[0m  · ${passed} verificações\n`
    : `\n\x1b[1m\x1b[31m${failures.length} FALHA(S)\x1b[0m  · ${passed + failures.length} verificações\n\nFalhas:\n${failures.map((f) => `  - ${f}`).join('\n')}\n`,
);
process.exit(failures.length === 0 ? 0 : 1);
