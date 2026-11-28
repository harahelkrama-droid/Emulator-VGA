// Smoke test: boot the repo ROM in the snes9x WASM core and dump frames.
import fs from 'node:fs';
import path from 'node:path';
import { LibretroHost } from 'romdev-core-host';
import * as snes from 'romdev-platform-snes';

const ROM = path.resolve('public/games/Super Metroid.sfc');
const OUT = path.resolve('playtest/out');
fs.mkdirSync(OUT, { recursive: true });

const host = new LibretroHost({ log: () => {} });
await host.loadCore(snes.core.jsPath, snes.core.wasmPath);
await host.loadMedia({ platform: 'snes', path: ROM });

console.log('status', JSON.stringify(host.getStatus()));

const N = Number(process.env.FRAMES || 600);
const t0 = Date.now();
for (let i = 0; i < N; i++) {
  host.setInput({ ports: [{}] });
  host.renderOneFrame();
  if (i % 150 === 0) {
    const { pngBase64, width, height } = host.screenshot();
    fs.writeFileSync(path.join(OUT, `f${String(i).padStart(5, '0')}.png`), Buffer.from(pngBase64, 'base64'));
    console.log('frame', i, width + 'x' + height);
  }
}
const dt = Date.now() - t0;
console.log(`frames=${N} ms=${dt} fps=${(N / (dt / 1000)).toFixed(1)}`);

// memory probing
for (const region of ['system_ram', 'snes_oam', 'snes_cgram', 'save_ram']) {
  try {
    const sz = host.regionSize(region);
    const bytes = host.readMemory(region, 0, Math.min(64, sz || 64));
    console.log('region', region, 'size', sz, 'head', Buffer.from(bytes).toString('hex').slice(0, 64));
  } catch (e) {
    console.log('region', region, 'ERR', e.message.slice(0, 80));
  }
}
try {
  const ram = host.readMemory('system_ram', 0, 0x20000);
  console.log('wram 0x0918 (samus x?)', ram[0x0918] | (ram[0x0919] << 8), 'y', ram[0x091a] | (ram[0x091b] << 8));
  console.log('wram 0x0998 (gameState)', ram[0x0998] | (ram[0x0999] << 8));
  console.log('wram 0x0a28 (health)', ram[0x0a28] | (ram[0x0a29] << 8));
  let nonzero = 0;
  for (let i = 0; i < 0x20000; i += 7) if (ram[i]) nonzero++;
  console.log('wram nonzero samples', nonzero);
  fs.writeFileSync(path.join(OUT, 'wram.bin'), Buffer.from(ram));
} catch (e) {
  console.log('wram ERR', e.message.slice(0, 120));
}
