import { GameEngine } from '@/lib/game/engine';
import { GameNetwork } from '@/lib/game/network';
import { WEAPONS, KILL_REWARD } from '@/lib/game/constants';
import type { PlayerState, Team, KillFeedEntry } from '@/lib/game/types';
import { SceneInspector } from '@/lib/game/inspector/Inspector';
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
  const inspectorRef = useRef<SceneInspector | null>(null);
  const isMobile = useIsMobile();

  const [playerName, setPlayerName] = useState('');
  const [assignedTeam, setAssignedTeam] = useState<Team | null>(null);

  // Hydration-safe: pick name+team only after mount
  useEffect(() => {
    setPlayerName(randomName());
    setAssignedTeam(randomTeam());
  }, []);
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

    // Sahne Inspector'ı: masaüstünde `~` (backtick) tuşuyla açılır/kapanır.
    // Mobilde devre dışı (dokunmatik editör deneyimi ayrı bir iş, kapsam dışı).
    const inspector = !isMobile ? new SceneInspector(engine) : null;
    inspectorRef.current = inspector;
    const onToggleInspector = (e: KeyboardEvent) => {
      if (e.key === '`') inspector?.toggle();
    };
    if (inspector) window.addEventListener('keydown', onToggleInspector);

    return () => {
      if (inspector) {
        window.removeEventListener('keydown', onToggleInspector);
        inspector.disposeAll();
        inspector.close();
      }
      inspectorRef.current = null;
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
        <div className="absolute inset-0 flex items-center justify-center bg-black/85 p-4 text-white">
          <div className="w-full max-w-sm rounded-2xl bg-gradient-to-b from-neutral-900 to-neutral-950 p-6 shadow-2xl ring-1 ring-white/10">
            <h1 className="mb-1 text-center text-4xl font-black tracking-tight">
              <span className="text-orange-500">CS 2</span> <span className="text-blue-500">MOBILE</span>
            </h1>
            <p className="mb-6 text-center text-xs text-gray-400">Tarayıcıda 3D çok oyunculu FPS</p>

            <label className="mb-1 block text-sm text-gray-300">Oyuncu Adı</label>
            <input
              value={playerName}
              onChange={(e) => setPlayerName(e.target.value)}
              className="mb-4 w-full rounded-lg border border-white/10 bg-white/5 px-4 py-2 text-white outline-none focus:border-orange-500"
              maxLength={16}
            />

            <div className="mb-6 rounded-lg bg-white/5 p-3 text-center">
              <div className="text-xs text-gray-400">Takımın (rastgele atandı)</div>
              <div className={`mt-1 text-xl font-black ${assignedTeam === 't' ? 'text-orange-500' : assignedTeam === 'ct' ? 'text-blue-500' : 'text-gray-500'}`}>
                {assignedTeam === 't' ? 'TERÖRİST' : assignedTeam === 'ct' ? 'ANTI-TERÖRİST' : '...'}
              </div>
            </div>

            <button
              onClick={startGame}
              className="w-full rounded-lg bg-green-600 py-3 text-lg font-bold text-white transition hover:bg-green-500"
            >
              OYNA
            </button>

            <div className="mt-4 text-center text-[11px] leading-relaxed text-gray-500">
              {isMobile ? (
                <>Sol joystick: hareket • Sağ ekran: nişan • ATEŞ butonu • F Flash • G HE</>
              ) : (
                <>WASD hareket • Mouse nişan • Sol tık ateş • Sağ tık scope • R reload • B satın al • F Flash • G HE • Tab skor • ~ Sahne Editörü</>
              )}
            </div>
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
