import { sendGameInput } from '../lib/emulatorBridge';
import type { AIKey } from '../types/emulator';

interface TouchButtonProps {
  label: string;
  controlKey: Exclude<AIKey, 'NONE'>;
  className?: string;
}

function TouchButton({ label, controlKey, className = '' }: TouchButtonProps) {
  return (
    <button
      type="button"
      onPointerDown={(e) => {
        e.preventDefault();
        sendGameInput(controlKey, true);
      }}
      onPointerUp={(e) => {
        e.preventDefault();
        sendGameInput(controlKey, false);
      }}
      onPointerCancel={() => sendGameInput(controlKey, false)}
      onPointerLeave={() => sendGameInput(controlKey, false)}
      className={`flex min-h-[46px] min-w-[46px] touch-none select-none items-center justify-center rounded-xl border border-[#2b3a57] bg-[#172033] text-xs font-bold text-[#eef3fb] transition-colors active:bg-[#6ee7b7] active:text-[#07151a] ${className}`}
    >
      {label}
    </button>
  );
}

export function TouchControls() {
  return (
    <div className="border-t border-[#24314a] bg-[#0b1120] px-4 py-4 select-none touch-none">
      <div className="mx-auto flex max-w-2xl flex-wrap items-center justify-between gap-4">
        {/* D-Pad */}
        <div className="grid grid-cols-3 grid-rows-3 gap-1.5" aria-label="Direcional">
          <div />
          <TouchButton label="▲" controlKey="UP" />
          <div />
          <TouchButton label="◀" controlKey="LEFT" />
          <TouchButton label="SEL" controlKey="SELECT" className="text-[10px] text-[#94a3bf]" />
          <TouchButton label="▶" controlKey="RIGHT" />
          <div />
          <TouchButton label="▼" controlKey="DOWN" />
          <div />
        </div>

        {/* Ombros e Start */}
        <div className="flex flex-col items-center gap-2">
          <div className="flex gap-2">
            <TouchButton label="L" controlKey="L" className="min-w-[54px]" />
            <TouchButton label="R" controlKey="R" className="min-w-[54px]" />
          </div>
          <TouchButton label="START" controlKey="START" className="min-w-[116px] text-[11px]" />
        </div>

        {/* ABXY */}
        <div className="grid grid-cols-3 grid-rows-3 gap-1.5" aria-label="Botões de ação">
          <div />
          <TouchButton label="X" controlKey="X" />
          <div />
          <TouchButton label="Y" controlKey="Y" />
          <div />
          <TouchButton label="A" controlKey="A" />
          <div />
          <TouchButton label="B" controlKey="B" />
          <div />
        </div>
      </div>
    </div>
  );
}
