import { GameEngine } from '@/lib/game/engine';
import { GameNetwork } from '@/lib/game/network';
import { WEAPONS, KILL_REWARD } from '@/lib/game/constants';
import type { PlayerState, Team, KillFeedEntry } from '@/lib/game/types';
import { useCallback, useEffect, useRef, useState } from 'react';
import { GameHUD } from './GameHUD';

function generateId() {
  return Math.random().toString(36).slice(2, 10);
}

function randomName() {
  const adjectives = ['Hızlı', 'Sessiz', 'Vahşi', 'Gizli', 'Ölümcül', 'Çabuk', 'Soylu', 'Yabani'];
  const nouns = ['Kurt', 'Kartal', 'Yılan', 'Aslan', 'Kaplan', 'Avci', 'Mermi', 'Hayalet'];
  return `${adjectives[Math.floor(Math.random() * adjectives.length)]}${nouns[Math.floor(Math.random() * nouns.length)]}`;
}

export function GameCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<GameEngine | null>(null);
  const networkRef = useRef<GameNetwork | null>(null);

  const [playerName, setPlayerName] = useState(randomName());
  const [team, setTeam] = useState<Team>('ct');
  const [started, setStarted] = useState(false);
  const [isLocked, setIsLocked] = useState(false);

  const [localState, setLocalState] = useState<PlayerState | null>(null);
  const [remoteStates, setRemoteStates] = useState<Record<string, PlayerState>>({});
  const [killFeed, setKillFeed] = useState<KillFeedEntry[]>([]);
  const [showBuy, setShowBuy] = useState(false);

  const playerIdRef = useRef(generateId());
  const remoteNameRef = useRef<Record<string, string>>({});

  const addKill = useCallback((killer: string, victim: string, weapon: string) => {
    const entry: KillFeedEntry = {
      id: generateId(),
      killer,
      victim,
      weapon,
      timestamp: Date.now(),
    };
    setKillFeed((prev) => [entry, ...prev].slice(0, 6));
    setTimeout(() => {
      setKillFeed((prev) => prev.filter((e) => e.id !== entry.id));
    }, 5000);
  }, []);

  // Pointer lock tracking
  useEffect(() => {
    const onLockChange = () => {
      const locked = document.pointerLockElement === canvasRef.current;
      setIsLocked(locked);
      if (locked) setShowBuy(false);
    };
    document.addEventListener('pointerlockchange', onLockChange);
    return () => document.removeEventListener('pointerlockchange', onLockChange);
  }, []);

  // Initialize engine + network
  useEffect(() => {
    if (!started) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const pid = playerIdRef.current;

    const engine = new GameEngine(canvas, pid, playerName, team, {
      onShoot: (event) => networkRef.current?.sendShoot({ ...event, id: pid }),
      onHit: (targetId, damage) => networkRef.current?.sendHit({ id: pid, targetId, damage }),
      onDeath: (killerId, victimId, weaponId) => {
        networkRef.current?.sendDeath({ killerId, victimId, weaponId });
      },
      onStateChange: (state) => {
        setLocalState({ ...state });
        networkRef.current?.sendState(state);
      },
    });
    engineRef.current = engine;

    const network = new GameNetwork('default', pid, engine.state);
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
          if (e.targetId === pid) {
            currentEngine.takeDamage(e.damage, e.id);
          }
          break;
        }
        case 'death': {
          const e = event.payload as { killerId: string; victimId: string; weaponId: string };
          const killerName =
            remoteNameRef.current[e.killerId] ||
            (e.killerId === pid ? playerName : e.killerId);
          const victimName =
            remoteNameRef.current[e.victimId] ||
            (e.victimId === pid ? playerName : e.victimId);
          addKill(killerName, victimName, WEAPONS[e.weaponId]?.name || e.weaponId);

          if (e.killerId === pid && e.victimId !== pid) {
            currentEngine.addMoney(KILL_REWARD);
            currentEngine.addKill();
          }
          break;
        }
        case 'buy': {
          // Sadece görsel / ses için; şimdilik sessiz
          break;
        }
        case 'leave': {
          const { key } = event.payload as { key: string };
          currentEngine.removeRemotePlayer(key);
          delete remoteNameRef.current[key];
          setRemoteStates((prev) => {
            const next = { ...prev };
            delete next[key];
            return next;
          });
          break;
        }
      }
    });

    engine.start();
    engine.lockPointer();

    return () => {
      engine.cleanup();
      void network.cleanup();
      engineRef.current = null;
      networkRef.current = null;
    };
  }, [started, playerName, team, addKill]);

  // Buy menu toggle
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'KeyB') return;
      const engine = engineRef.current;
      if (!engine || !started) return;

      if (showBuy) {
        setShowBuy(false);
        if (!engine.state.isDead) engine.lockPointer();
      } else if (engine.isLocked() && !engine.state.isDead) {
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
    if (!engine.state.isDead) engine.lockPointer();
  };

  const startGame = () => {
    if (!playerName.trim()) return;
    setStarted(true);
  };

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-black">
      <canvas ref={canvasRef} className="block h-full w-full" />

      {!started && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/80 text-white">
          <div className="w-full max-w-sm rounded-xl bg-neutral-900/90 p-6 shadow-2xl">
            <h1 className="mb-2 text-center text-3xl font-black tracking-tight">CS CLONE</h1>
            <p className="mb-6 text-center text-sm text-gray-400">3D çok oyunculu arena shooter</p>

            <label className="mb-1 block text-sm text-gray-300">Oyuncu Adı</label>
            <input
              value={playerName}
              onChange={(e) => setPlayerName(e.target.value)}
              className="mb-4 w-full rounded-lg border border-white/10 bg-white/5 px-4 py-2 text-white outline-none focus:border-orange-500"
              maxLength={16}
            />

            <label className="mb-2 block text-sm text-gray-300">Takım</label>
            <div className="mb-6 flex gap-3">
              <button
                onClick={() => setTeam('t')}
                className={`flex-1 rounded-lg py-2 font-bold transition ${
                  team === 't' ? 'bg-orange-600 text-white' : 'bg-white/10 text-gray-300 hover:bg-white/15'
                }`}
              >
                TERÖRİST
              </button>
              <button
                onClick={() => setTeam('ct')}
                className={`flex-1 rounded-lg py-2 font-bold transition ${
                  team === 'ct' ? 'bg-blue-600 text-white' : 'bg-white/10 text-gray-300 hover:bg-white/15'
                }`}
              >
                CT
              </button>
            </div>

            <button
              onClick={startGame}
              className="w-full rounded-lg bg-green-600 py-3 text-lg font-bold text-white transition hover:bg-green-500"
            >
              OYNA
            </button>

            <div className="mt-4 text-center text-xs text-gray-500">
              WASD hareket • Mouse nişan • Sol tık ateş • Sağ tık scope • R reload • B satın al • Tab skor
            </div>
          </div>
        </div>
      )}

      {started && !isLocked && !showBuy && (
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

      <GameHUD state={localState} remoteStates={remoteStates} killFeed={killFeed} showBuy={showBuy} onBuy={handleBuy} />
    </div>
  );
}
