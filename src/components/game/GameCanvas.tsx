import { GameEngine } from '@/lib/game/engine';
import { GameNetwork } from '@/lib/game/network';
import { WEAPONS, KILL_REWARD } from '@/lib/game/constants';
import type { PlayerState, Team, KillFeedEntry } from '@/lib/game/types';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GameHUD } from './GameHUD';
import { MobileControls } from './MobileControls';


function generateId() {
  return Math.random().toString(36).slice(2, 10);
}

function useIsMobile() {
  return useMemo(() => typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches, []);
}

export function GameCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<GameEngine | null>(null);
  const networkRef = useRef<GameNetwork | null>(null);
  const weaponKickRef = useRef(0);
  const isMobile = useIsMobile();

  const [playerName, setPlayerName] = useState('');
  const [assignedTeam, setAssignedTeam] = useState<Team | null>(null);

  const [started, setStarted] = useState(false);
  const [isLocked, setIsLocked] = useState(false);

  const [localState, setLocalState] = useState<PlayerState | null>(null);
  const [remoteStates, setRemoteStates] = useState<Record<string, PlayerState>>({});
  const [killFeed, setKillFeed] = useState<KillFeedEntry[]>([]);
  const [showBuy, setShowBuy] = useState(false);
  const [flashOpacity, setFlashOpacity] = useState(0);

  const playerIdRef = useRef(generateId());
  const remoteNameRef = useRef<Record<string, string>>({});

  const addKill = useCallback((killer: string, victim: string, weapon: string) => {
    const entry: KillFeedEntry = { id: generateId(), killer, victim, weapon, timestamp: Date.now() };
    setKillFeed((prev) => [entry, ...prev].slice(0, 6));
    setTimeout(() => setKillFeed((prev) => prev.filter((e) => e.id !== entry.id)), 5000);
  }, []);

  const triggerFlash = useCallback((duration: number) => {
    setFlashOpacity(1);
    const start = performance.now();
    const tick = () => {
      const t = (performance.now() - start) / duration;
      if (t >= 1) { setFlashOpacity(0); return; }
      setFlashOpacity(1 - t);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, []);

  useEffect(() => {
    const onLockChange = () => {
      const locked = document.pointerLockElement === canvasRef.current;
      setIsLocked(locked);
      if (locked) setShowBuy(false);
    };
    document.addEventListener('pointerlockchange', onLockChange);
    return () => document.removeEventListener('pointerlockchange', onLockChange);
  }, []);

  useEffect(() => {
    if (!started) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const pid = playerIdRef.current;

    if (!assignedTeam) return;
    const engine = new GameEngine(canvas, pid, playerName, assignedTeam, {
      onShoot: (event) => networkRef.current?.sendShoot({ ...event, id: pid }),
      onHit: (targetId, damage) => networkRef.current?.sendHit({ id: pid, targetId, damage }),
      onDeath: (killerId, victimId, weaponId) => {
        networkRef.current?.sendDeath({ killerId, victimId, weaponId });
      },
      onStateChange: (state) => {
        setLocalState({ ...state });
        networkRef.current?.sendState(state);
      },
      onFlash: (duration) => triggerFlash(duration),
      onWeaponKick: (amount) => { weaponKickRef.current = Math.min(1, weaponKickRef.current + amount); },
    });
    engineRef.current = engine;

    const network = new GameNetwork('default', pid, engine.getState());
    networkRef.current = network;

    network.on((event) => {
      const currentEngine = engineRef.current;
      if (!currentEngine) return;
      switch (event.type) {
        case 'state': {
          const state = event.payload as PlayerState;
          if (state.id === pid) break;
          currentEngine.updateRemotePlayer(state);
          remoteNameRef.current[state.id] = state.name;
          setRemoteStates((prev) => ({ ...prev, [state.id]: state }));
          break;
        }
        case 'hit': {
          const e = event.payload as { id: string; targetId: string; damage: number };
          if (e.targetId === pid) currentEngine.takeDamage(e.damage, e.id);
          break;
        }
        case 'death': {
          const e = event.payload as { killerId: string; victimId: string; weaponId: string };
          const killerName = remoteNameRef.current[e.killerId] || (e.killerId === pid ? playerName : e.killerId);
          const victimName = remoteNameRef.current[e.victimId] || (e.victimId === pid ? playerName : e.victimId);
          addKill(killerName, victimName, WEAPONS[e.weaponId]?.name || e.weaponId);
          if (e.killerId === pid && e.victimId !== pid) {
            currentEngine.addMoney(KILL_REWARD);
            currentEngine.addKill();
          }
          break;
        }
        case 'leave': {
          const { key } = event.payload as { key: string };
          currentEngine.removeRemotePlayer(key);
          delete remoteNameRef.current[key];
          setRemoteStates((prev) => { const next = { ...prev }; delete next[key]; return next; });
          break;
        }
      }
    });

    engine.start();
    if (!isMobile) engine.lockPointer();

    return () => {
      engine.cleanup();
      void network.cleanup();
      engineRef.current = null;
      networkRef.current = null;
    };

  }, [started, playerName, assignedTeam, addKill, triggerFlash, isMobile]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'KeyB') return;
      const engine = engineRef.current;
      if (!engine || !started) return;
      if (showBuy) {
        setShowBuy(false);
        if (!engine.getState().isDead) engine.lockPointer();
      } else if (engine.isLocked() && !engine.getState().isDead) {
        engine.unlockPointer();
        setShowBuy(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showBuy, started]);

  const handleBuy = (weaponId: string) => {
    const engine = engineRef.current;
    if (!engine) return;
    if (engine.buyWeapon(weaponId)) {
      networkRef.current?.sendBuy({ id: playerIdRef.current, weaponId });
    }
    setShowBuy(false);
    if (!isMobile && !engine.getState().isDead) engine.lockPointer();
  };

  const startGame = () => {
    if (!playerName.trim() || !assignedTeam) return;
    // WebAudio unlock (user gesture required)
    import('@/lib/game/audio').then((m) => m.gameAudio.unlock());
    setStarted(true);
  };

  return (
    <div className="relative h-[100dvh] w-screen overflow-hidden bg-black touch-none select-none">
      <canvas ref={canvasRef} className="block h-full w-full" />

      {!started && (
        <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-black via-neutral-950 to-black p-4 text-white">
          <div className="w-full max-w-md rounded-2xl border border-white/10 bg-neutral-950/90 p-8 shadow-2xl backdrop-blur">
            <h1 className="mb-1 text-center text-5xl font-black tracking-tight">
              <span className="text-orange-500">CS 2</span> <span className="text-blue-500">MOBILE</span>
            </h1>
            <p className="mb-8 text-center text-xs uppercase tracking-[0.3em] text-gray-500">Counter-Strike Web</p>

            <label className="mb-2 block text-xs font-bold uppercase tracking-widest text-gray-400">Oyuncu Adı</label>
            <input
              value={playerName}
              onChange={(e) => setPlayerName(e.target.value)}
              placeholder="Adını yaz..."
              className="mb-6 w-full rounded-lg border border-white/10 bg-white/5 px-4 py-3 text-white outline-none placeholder:text-gray-600 focus:border-orange-500"
              maxLength={16}
              autoFocus
            />

            <div className="mb-6">
              <div className="mb-2 text-xs font-bold uppercase tracking-widest text-gray-400">Takım Seç</div>
              <div className="grid grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={() => setAssignedTeam('t')}
                  className={`rounded-lg border-2 p-4 text-center transition ${
                    assignedTeam === 't'
                      ? 'border-orange-500 bg-orange-500/20'
                      : 'border-white/10 bg-white/5 hover:border-orange-500/50'
                  }`}
                >
                  <div className="text-lg font-black text-orange-500">T</div>
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-gray-300">Terörist</div>
                </button>
                <button
                  type="button"
                  onClick={() => setAssignedTeam('ct')}
                  className={`rounded-lg border-2 p-4 text-center transition ${
                    assignedTeam === 'ct'
                      ? 'border-blue-500 bg-blue-500/20'
                      : 'border-white/10 bg-white/5 hover:border-blue-500/50'
                  }`}
                >
                  <div className="text-lg font-black text-blue-500">CT</div>
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-gray-300">Anti-Terör</div>
                </button>
              </div>
            </div>

            <button
              onClick={startGame}
              disabled={!playerName.trim() || !assignedTeam}
              className="w-full rounded-lg bg-green-600 py-3 text-lg font-black uppercase tracking-widest text-white transition hover:bg-green-500 disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-gray-500"
            >
              Oyna
            </button>
          </div>
        </div>
      )}


      {started && !isMobile && !isLocked && !showBuy && (
        <div
          onClick={() => engineRef.current?.lockPointer()}
          className="absolute inset-0 flex cursor-pointer items-center justify-center bg-black/50 text-white"
        >
          <div className="text-center">
            <p className="text-xl font-bold">Devam etmek için tıkla</p>
            <p className="text-sm text-gray-300">B ile satın al menüsünü aç</p>
          </div>
        </div>
      )}

      {/* Flash overlay */}
      {flashOpacity > 0 && (
        <div
          className="pointer-events-none absolute inset-0 bg-white"
          style={{ opacity: flashOpacity }}
        />
      )}

      <GameHUD state={localState} remoteStates={remoteStates} killFeed={killFeed} showBuy={showBuy} onBuy={handleBuy} onCloseBuy={() => { setShowBuy(false); if (!isMobile && !engineRef.current?.getState().isDead) engineRef.current?.lockPointer(); }} />

      {started && isMobile && (
        <MobileControls
          onMove={(x, y) => engineRef.current?.mobileMove(x, y)}
          onLook={(dx, dy) => engineRef.current?.mobileLook(dx, dy)}
          onFire={(v) => engineRef.current?.mobileSetFire(v)}
          onAim={(v) => engineRef.current?.mobileSetAim(v)}
          onReload={() => engineRef.current?.mobileReload()}
          onThrowFlash={() => engineRef.current?.mobileThrow('flash')}
          onThrowHE={() => engineRef.current?.mobileThrow('he')}
          onOpenBuy={() => setShowBuy(true)}
          onWeapon={(id) => engineRef.current?.setWeapon(id)}
        />
      )}
    </div>
  );
}
