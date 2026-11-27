import { useEffect, useState } from 'react';
import { Download, FileArchive, FolderOpen, Gamepad2 } from 'lucide-react';
import { EmulatorPlayer } from './components/EmulatorPlayer';
import { GameDetailModal } from './components/GameDetailModal';
import { buildStandaloneGitHubHtml } from './lib/githubExport';
import { buildZipArchive, type ZipFileEntry } from './lib/zipBuilder';
import type { GameItem } from './types/emulator';

function formatSystem(file: string): string {
  return /\.gba$/i.test(file) ? 'Game Boy Advance' : 'Super Nintendo';
}

export default function App() {
  const [games, setGames] = useState<GameItem[]>([]);
  const [loadingGames, setLoadingGames] = useState(true);
  const [modalGame, setModalGame] = useState<GameItem | null>(null);
  const [activeGame, setActiveGame] = useState<GameItem | null>(null);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [activeSection, setActiveSection] = useState<'library' | 'player' | 'export'>('library');

  const notify = (msg: string) => {
    setToastMsg(msg);
    window.setTimeout(() => {
      setToastMsg((curr) => (curr === msg ? null : curr));
    }, 2800);
  };

  useEffect(() => {
    fetch('/games.json', { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : []))
      .then((data) => {
        if (Array.isArray(data)) {
          setGames(data);
        }
      })
      .catch(() => {
        setGames([]);
      })
      .finally(() => setLoadingGames(false));
  }, []);

  const handleOpenLocalRom = (file: File | undefined) => {
    if (!file) return;
    const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
    if (!['gba', 'sfc', 'smc'].includes(ext)) {
      notify('Formato inválido. Selecione um arquivo .gba, .sfc ou .smc.');
      return;
    }
    const blobUrl = URL.createObjectURL(file);
    const localItem: GameItem = {
      title: file.name.replace(/\.[^.]+$/, ''),
      file: blobUrl,
      description: 'ROM carregada diretamente do seu aparelho.',
      isLocalBlob: true,
    };
    setModalGame(null);
    setActiveGame(localItem);
    setActiveSection('player');
    window.setTimeout(() => {
      document.getElementById('active-player')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 60);
  };

  const handleStartGame = (game: GameItem) => {
    setModalGame(null);
    setActiveGame(game);
    setActiveSection('player');
    window.setTimeout(() => {
      document.getElementById('active-player')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 60);
  };

  const handleDownloadGitHubHtml = () => {
    const html = buildStandaloneGitHubHtml();
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'index.html';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    notify('index.html atualizado gerado para o repositório GitHub.');
  };

  const handleDownloadGitHubZip = async () => {
    try {
      const staticFiles = [
        'atualizacoes.html',
        'manifest.webmanifest',
        'service-worker.js',
        'app-icon.svg',
        'games.json',
      ];
      const entries: ZipFileEntry[] = [
        { name: 'index.html', data: buildStandaloneGitHubHtml() },
      ];
      const fetched = await Promise.all(
        staticFiles.map(async (name) => {
          const res = await fetch(`/${name}`, { cache: 'no-store' });
          if (!res.ok) return null;
          return { name, data: new Uint8Array(await res.arrayBuffer()) };
        }),
      );
      for (const item of fetched) {
        if (item) entries.push(item);
      }
      const zipBytes = buildZipArchive(entries);
      const zipCopy = new Uint8Array(zipBytes.length);
      zipCopy.set(zipBytes);
      const blob = new Blob([zipCopy], { type: 'application/zip' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'Emulator-GBA-atualizado.zip';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      notify(`Pacote .zip gerado com ${entries.length} arquivos para o GitHub.`);
    } catch {
      notify('Não foi possível gerar o pacote .zip.');
    }
  };

  return (
    <div className="min-h-dvh bg-[#090e1a] text-[#eef3fb]">
      <div className="mx-auto max-w-6xl px-4 pb-16 pt-4 sm:px-6">
        {/* Top Bar Contract: 3 zonas */}
        <header className="flex items-center justify-between gap-8 border-b border-[#24314a] pb-4">
          <a
            href="#biblioteca"
            onClick={(e) => {
              e.preventDefault();
              setActiveSection('library');
            }}
            className="flex shrink-0 items-center gap-2.5 text-lg font-extrabold tracking-tight text-[#eef3fb] whitespace-nowrap"
          >
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#6ee7b7] text-[#07151a]">
              <Gamepad2 className="h-4 w-4" />
            </span>
            RetroPlay
          </a>

          <nav className="hidden items-center gap-6 text-sm font-medium text-[#94a3bf] md:flex">
            <a
              href="#biblioteca"
              onClick={(e) => {
                e.preventDefault();
                setActiveSection('library');
                document.getElementById('biblioteca')?.scrollIntoView({ behavior: 'smooth' });
              }}
              className={`whitespace-nowrap shrink-0 transition-colors hover:text-[#eef3fb] ${
                activeSection === 'library' ? 'text-[#eef3fb]' : ''
              }`}
            >
              Biblioteca
            </a>
            <a
              href="#active-player"
              onClick={(e) => {
                e.preventDefault();
                setActiveSection('player');
                if (!activeGame && games[0]) {
                  handleStartGame(games[0]);
                } else {
                  document.getElementById('active-player')?.scrollIntoView({ behavior: 'smooth' });
                }
              }}
              className={`whitespace-nowrap shrink-0 transition-colors hover:text-[#eef3fb] ${
                activeSection === 'player' ? 'text-[#eef3fb]' : ''
              }`}
            >
              Emulador
            </a>
            <a
              href="#github-sync"
              onClick={(e) => {
                e.preventDefault();
                setActiveSection('export');
                document.getElementById('github-sync')?.scrollIntoView({ behavior: 'smooth' });
              }}
              className={`whitespace-nowrap shrink-0 transition-colors hover:text-[#eef3fb] ${
                activeSection === 'export' ? 'text-[#eef3fb]' : ''
              }`}
            >
              GitHub Pages
            </a>
          </nav>

          <div className="shrink-0">
            <label className="inline-flex min-h-[42px] cursor-pointer items-center gap-2 rounded-xl bg-[#6ee7b7] px-4 py-2 text-xs font-bold text-[#07151a] whitespace-nowrap transition-transform hover:brightness-105 active:scale-[0.98]">
              <FolderOpen className="h-4 w-4" />
              Abrir ROM
              <input
                type="file"
                accept=".gba,.sfc,.smc"
                className="hidden"
                onChange={(e) => {
                  handleOpenLocalRom(e.target.files?.[0]);
                  e.target.value = '';
                }}
              />
            </label>
          </div>
        </header>

        {/* Hero enxuto */}
        <section className="pt-8 pb-6">
          <h1 className="max-w-2xl text-balance text-3xl font-extrabold tracking-tight text-[#eef3fb] sm:text-5xl sm:leading-[1.06]">
            Emulador SNES e GBA com IA local sem API.
          </h1>
          <p className="mt-3 max-w-2xl text-sm leading-relaxed text-[#94a3bf] sm:text-base">
            Funciona em celular, notebook e PC sem chave paga nem limite de requisições. A IA analisa o quadro real do jogo e envia comandos direto ao núcleo do emulador.
          </p>
        </section>

        {/* Biblioteca */}
        <section id="biblioteca" className="pt-2">
          <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 className="text-lg font-bold text-[#eef3fb]">Biblioteca</h2>
              <p className="text-xs text-[#94a3bf]">
                {loadingGames
                  ? 'Carregando catálogo…'
                  : `${games.length} ${games.length === 1 ? 'título disponível' : 'títulos disponíveis'} · GBA e SNES`}
              </p>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3.5 sm:grid-cols-3 lg:grid-cols-4">
            {games.map((g) => (
              <button
                key={g.file}
                type="button"
                onClick={() => setModalGame(g)}
                className="group overflow-hidden rounded-2xl border border-[#24314a] bg-[#111827] text-left transition-transform duration-150 hover:-translate-y-1 hover:border-[#4b638f] focus-visible:outline-2 focus-visible:outline-[#6ee7b7]"
              >
                <div className="relative flex aspect-[16/10] w-full items-center justify-center overflow-hidden bg-[#0c1322]">
                  {g.cover ? (
                    <>
                      <img
                        src={g.cover}
                        alt=""
                        aria-hidden="true"
                        className="absolute inset-0 h-full w-full scale-110 object-cover opacity-35 blur-md"
                      />
                      <img
                        src={g.cover}
                        alt={`Capa de ${g.title}`}
                        referrerPolicy="no-referrer"
                        className="relative z-10 max-h-full max-w-full object-contain"
                      />
                    </>
                  ) : (
                    <Gamepad2 className="h-8 w-8 text-[#94a3bf]" />
                  )}
                </div>
                <div className="p-3.5">
                  <div className="truncate text-sm font-bold text-[#eef3fb]">{g.title}</div>
                  <div className="mt-1 flex items-center justify-between gap-2 text-xs text-[#94a3bf]">
                    <span className="truncate">{formatSystem(g.file)}</span>
                    <span className="shrink-0 font-semibold text-[#6ee7b7]">Jogar</span>
                  </div>
                </div>
              </button>
            ))}
          </div>
        </section>

        {/* Player ativo */}
        {activeGame && (
          <EmulatorPlayer
            game={activeGame}
            onClose={() => {
              setActiveGame(null);
              setActiveSection('library');
            }}
            onNotify={notify}
          />
        )}

        {/* Exportar para o repositório GitHub */}
        <section
          id="github-sync"
          className="mt-12 flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-[#24314a] bg-[#111827] p-5"
        >
          <div className="max-w-2xl">
            <h2 className="text-base font-bold text-[#eef3fb]">Atualizar seu repositório GitHub Pages</h2>
            <p className="mt-1 text-xs leading-relaxed text-[#94a3bf]">
              Baixe o pacote <code className="font-mono-data text-[#eef3fb]">.zip</code> completo (com <code className="font-mono-data text-[#eef3fb]">index.html</code>, <code className="font-mono-data text-[#eef3fb]">atualizacoes.html</code>, <code className="font-mono-data text-[#eef3fb]">service-worker.js</code>, <code className="font-mono-data text-[#eef3fb]">manifest.webmanifest</code>, <code className="font-mono-data text-[#eef3fb]">app-icon.svg</code> e <code className="font-mono-data text-[#eef3fb]">games.json</code>) para enviar ao repositório <code className="font-mono-data text-[#eef3fb]">harahelkrama-droid/Emulator-GBA</code>.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              onClick={handleDownloadGitHubZip}
              className="inline-flex min-h-[44px] items-center gap-2 rounded-xl bg-[#6ee7b7] px-4 py-2.5 text-xs font-bold text-[#07151a] whitespace-nowrap transition-transform hover:brightness-105 active:scale-[0.98]"
            >
              <FileArchive className="h-4 w-4" />
              Baixar .zip p/ GitHub
            </button>
            <button
              type="button"
              onClick={handleDownloadGitHubHtml}
              className="inline-flex min-h-[44px] items-center gap-2 rounded-xl border border-[#24314a] bg-[#172033] px-4 py-2.5 text-xs font-bold text-[#eef3fb] whitespace-nowrap transition-colors hover:border-[#6ee7b7] hover:text-[#6ee7b7]"
            >
              <Download className="h-4 w-4" />
              Só index.html
            </button>
          </div>
        </section>
      </div>

      <GameDetailModal
        game={modalGame}
        onClose={() => setModalGame(null)}
        onPlay={handleStartGame}
      />

      {toastMsg && (
        <div
          role="status"
          className="fixed bottom-5 left-1/2 z-50 -translate-x-1/2 rounded-xl border border-[#24314a] bg-[#172033] px-4 py-2.5 text-xs font-semibold text-[#eef3fb] shadow-lg"
        >
          {toastMsg}
        </div>
      )}
    </div>
  );
}
