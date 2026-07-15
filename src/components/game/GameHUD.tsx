import { useEffect, useState } from 'react';
import { WEAPONS } from '@/lib/game/constants';
import type { PlayerState, KillFeedEntry } from '@/lib/game/types';
import akImg from '@/assets/weapons/ak47.png';
import awpImg from '@/assets/weapons/awp.png';
import m4Img from '@/assets/weapons/m4.png';
import glockImg from '@/assets/weapons/glock.png';
import deagleImg from '@/assets/weapons/deagle.png';
import knifeImg from '@/assets/weapons/knife.png';

const WEAPON_IMG: Record<string, string> = {
  rifle: akImg,
  sniper: awpImg,
  m4: m4Img,
  pistol: glockImg,
  deagle: deagleImg,
  knife: knifeImg,
};

interface GameHUDProps {
  state: PlayerState | null;
  remoteStates: Record<string, PlayerState>;
  killFeed: KillFeedEntry[];
  showBuy: boolean;
  onBuy: (weaponId: string) => void;
  onCloseBuy?: () => void;
}

export function GameHUD({ state, remoteStates, killFeed, showBuy, onBuy, onCloseBuy }: GameHUDProps) {
  const [showScores, setShowScores] = useState(false);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code === 'Tab') {
        e.preventDefault();
        setShowScores(true);
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Tab') setShowScores(false);
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

  if (!state) return null;

  const all = [state, ...Object.values(remoteStates)];
  const tScore = all.filter((p) => p.team === 't').reduce((a, b) => a + b.kills, 0);
  const ctScore = all.filter((p) => p.team === 'ct').reduce((a, b) => a + b.kills, 0);

  return (
    <div className="pointer-events-none absolute inset-0">
      {/* Crosshair (+) with center gap */}
      {!state.isDead && (
        <div className="absolute left-1/2 top-1/2 h-6 w-6 -translate-x-1/2 -translate-y-1/2">
          {/* dot */}
          <div className="absolute left-1/2 top-1/2 h-[2px] w-[2px] -translate-x-1/2 -translate-y-1/2 bg-emerald-400" />
          {/* top */}
          <div className="absolute left-1/2 top-0 h-[7px] w-[2px] -translate-x-1/2 bg-emerald-400 shadow-[0_0_2px_rgba(0,0,0,0.9)]" />
          {/* bottom */}
          <div className="absolute bottom-0 left-1/2 h-[7px] w-[2px] -translate-x-1/2 bg-emerald-400 shadow-[0_0_2px_rgba(0,0,0,0.9)]" />
          {/* left */}
          <div className="absolute left-0 top-1/2 h-[2px] w-[7px] -translate-y-1/2 bg-emerald-400 shadow-[0_0_2px_rgba(0,0,0,0.9)]" />
          {/* right */}
          <div className="absolute right-0 top-1/2 h-[2px] w-[7px] -translate-y-1/2 bg-emerald-400 shadow-[0_0_2px_rgba(0,0,0,0.9)]" />
        </div>
      )}

      {/* Weapon viewmodel image */}
      {WEAPON_IMG[state.weaponId] && !state.isDead && (
        <img
          src={WEAPON_IMG[state.weaponId]}
          alt={WEAPONS[state.weaponId]?.name}
          className="pointer-events-none absolute bottom-24 right-4 h-40 w-auto select-none drop-shadow-2xl sm:bottom-28 sm:right-8 sm:h-56"
          style={{ transform: state.isScoped ? 'translateY(140%)' : 'none', transition: 'transform 120ms' }}
        />
      )}

      {/* Bottom HUD */}
      <div className="absolute bottom-0 left-0 right-0 flex items-end justify-between p-4 sm:p-6">
        <div className="rounded-lg bg-black/60 p-3 text-white backdrop-blur">
          <div className="text-xs text-gray-300">CAN</div>
          <div className="text-2xl font-bold">{state.health}</div>
          <div className="mt-1 h-2 w-28 overflow-hidden rounded bg-gray-700 sm:w-32">
            <div
              className="h-full bg-red-500 transition-all"
              style={{ width: `${state.health}%` }}
            />
          </div>
        </div>

        <div className="rounded-lg bg-black/60 p-3 text-center text-white backdrop-blur">
          <div className="text-base font-bold">{WEAPONS[state.weaponId]?.name}</div>
          <div className="text-2xl font-mono">
            {state.ammo} <span className="text-sm text-gray-400">/ {state.maxAmmo}</span>
          </div>
          {state.isReloading && <div className="text-xs text-yellow-400">DOLDURULUYOR...</div>}
        </div>

        <div className="rounded-lg bg-black/60 p-3 text-right text-white backdrop-blur">
          <div className="text-xs text-gray-300">PARA</div>
          <div className="text-2xl font-bold text-green-400">${state.money}</div>
          <div className="text-xs text-gray-300">{state.team === 't' ? 'TERÖRİST' : 'ANTI-TERÖR'}</div>
        </div>
      </div>

      {/* Top score */}
      <div className="absolute left-1/2 top-4 -translate-x-1/2 rounded-lg bg-black/60 px-6 py-2 text-white backdrop-blur">
        <div className="flex gap-8 text-xl font-bold">
          <span className="text-orange-500">T {tScore}</span>
          <span className="text-blue-500">CT {ctScore}</span>
        </div>
      </div>

      {/* Kill feed */}
      <div className="absolute right-4 top-16 flex flex-col gap-1">
        {killFeed.map((k) => (
          <div key={k.id} className="rounded bg-black/60 px-3 py-1 text-right text-sm text-white">
            <span className="font-bold text-orange-400">{k.killer}</span>{' '}
            <span className="text-gray-400">[{k.weapon}]</span>{' '}
            <span className="font-bold text-blue-400">{k.victim}</span>
          </div>
        ))}
      </div>

      {/* You died message */}
      {state.isDead && (
        <div className="absolute left-1/2 top-1/3 -translate-x-1/2 text-center text-white">
          <div className="text-4xl font-bold text-red-500">ÖLDÜN</div>
          <div className="mt-2 text-sm text-gray-300">3 saniye sonra respawn olacaksın</div>
        </div>
      )}

      {/* Scoreboard */}
      {showScores && (
        <div className="pointer-events-auto absolute inset-0 flex items-center justify-center bg-black/60">
          <div className="mx-4 w-full max-w-2xl rounded-lg bg-black/85 p-4 text-white sm:p-6">
            <h2 className="mb-4 text-center text-xl font-bold">SKOR TABLOSU</h2>
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="text-gray-400">
                  <th className="pb-2">İsim</th>
                  <th className="pb-2">Takım</th>
                  <th className="pb-2">Öldürme</th>
                  <th className="pb-2">Ölüm</th>
                  <th className="pb-2">Para</th>
                </tr>
              </thead>
              <tbody>
                {all
                  .sort((a, b) => b.kills - a.kills)
                  .map((p) => (
                    <tr key={p.id} className={p.team === 't' ? 'text-orange-400' : 'text-blue-400'}>
                      <td className="py-1">
                        {p.name} {p.id === state.id ? '(Sen)' : ''}
                      </td>
                      <td className="py-1">{p.team.toUpperCase()}</td>
                      <td className="py-1">{p.kills}</td>
                      <td className="py-1">{p.deaths}</td>
                      <td className="py-1">${p.money}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Buy menu */}
      {showBuy && (
        <div className="pointer-events-auto absolute inset-0 flex items-center justify-center bg-black/70">
          <div className="mx-4 w-full max-w-md rounded-lg bg-black/90 p-6 text-white">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-xl font-bold">SATIN AL</h2>
              <button
                onClick={() => onCloseBuy?.()}
                className="rounded bg-red-600 px-3 py-1 text-sm font-bold text-white transition hover:bg-red-500"
              >
                ✕ KAPAT
              </button>
            </div>
            <div className="space-y-2">
              {Object.values(WEAPONS).map((w) => (
                <button
                  key={w.id}
                  onClick={() => onBuy(w.id)}
                  disabled={state.money < w.cost}
                  className="flex w-full items-center justify-between rounded bg-white/10 p-3 text-left transition hover:bg-white/20 disabled:opacity-40"
                >
                  <span className="font-bold">{w.name}</span>
                  <span className={state.money >= w.cost ? 'text-green-400' : 'text-red-400'}>
                    ${w.cost}
                  </span>
                </button>
              ))}
            </div>
            <button
              onClick={() => onCloseBuy?.()}
              className="mt-4 w-full rounded bg-white/10 py-2 text-sm font-bold text-white transition hover:bg-white/20"
            >
              KAPAT (B)
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
