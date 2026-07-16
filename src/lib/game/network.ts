// src/lib/game/network.ts
//
// ════════════════════════════════════════════════════════════════════════════
//  Transport Katmanı — Supabase Realtime Broadcast (Wire Format)
// ════════════════════════════════════════════════════════════════════════════
//
// Bu dosya YALNIZCA taşıma katmanıdır. AAA netcode mantığı (prediction,
// reconciliation, lag comp) `netcode.ts` içindedir. Burada sadece:
//   1) Supabase channel'ı kurulumu
//   2) Paketlerin broadcast'ı
//   3) Presence (katılım/ayrılma)
// yapılır.
//
// Paket formatları `types.ts` ve `netcode.ts`'ten gelir; bunlar JSON olarak
// gönderilir (Supabase broadcast JSON destekler; daha sıkı bir binary format
// istenirse Uint8Array'e dönüştürülebilir — Three.js'in Vector3 sınıfı
// JSON-safe değildir, bu yüzden `Vector3Like` (saf {x,y,z}) kullanıyoruz).

import { supabase } from '@/integrations/supabase/client';
import type { RealtimeChannel } from '@supabase/supabase-js';
import type { PlayerState, ShootEvent, HitEvent, DeathEvent, BuyEvent, RespawnEvent } from './types';
import type { InputCommand, StateSnapshot } from './netcode';

export type NetworkEvent =
  | { type: 'state'; payload: PlayerState | StateSnapshot }
  | { type: 'shoot'; payload: ShootEvent }
  | { type: 'hit'; payload: HitEvent }
  | { type: 'death'; payload: DeathEvent }
  | { type: 'buy'; payload: BuyEvent }
  | { type: 'respawn'; payload: RespawnEvent }
  | { type: 'input'; payload: InputCommand }
  | { type: 'state-snapshot'; payload: StateSnapshot }
  | { type: 'presence'; payload: unknown }
  | { type: 'join'; payload: { key: string; newPresences: unknown[] } }
  | { type: 'leave'; payload: { key: string; leftPresences: unknown[] } }
  | { type: 'status'; payload: string };

export type NetworkListener = (event: NetworkEvent) => void;

export class GameNetwork {
  private channel: RealtimeChannel;
  private listeners: NetworkListener[] = [];
  private playerId: string;

  constructor(roomId: string, playerId: string, playerState: PlayerState) {
    this.playerId = playerId;
    this.channel = supabase.channel(`room:${roomId}`, {
      config: {
        presence: { key: playerId },
        broadcast: { ack: false, self: false },
      },
    });

    this.channel
      // Eski state event'i (geriye uyumlu)
      .on('broadcast', { event: 'state' }, ({ payload }) => this.emit('state', payload))
      // Yeni state-snapshot event'i (AAA netcode için)
      .on('broadcast', { event: 'state-snapshot' }, ({ payload }) => this.emit('state-snapshot', payload as StateSnapshot))
      // Input event'i (client → server)
      .on('broadcast', { event: 'input' }, ({ payload }) => this.emit('input', payload as InputCommand))
      // Diğer event'ler
      .on('broadcast', { event: 'shoot' }, ({ payload }) => this.emit('shoot', payload))
      .on('broadcast', { event: 'hit' }, ({ payload }) => this.emit('hit', payload))
      .on('broadcast', { event: 'death' }, ({ payload }) => this.emit('death', payload))
      .on('broadcast', { event: 'buy' }, ({ payload }) => this.emit('buy', payload))
      .on('broadcast', { event: 'respawn' }, ({ payload }) => this.emit('respawn', payload))
      // Presence (kimler bağlı)
      .on('presence', { event: 'sync' }, () => {
        this.emit('presence', this.channel.presenceState());
      })
      .on('presence', { event: 'join' }, ({ key, newPresences }) => {
        this.emit('join', { key, newPresences });
      })
      .on('presence', { event: 'leave' }, ({ key, leftPresences }) => {
        this.emit('leave', { key, leftPresences });
      })
      .subscribe(async (status) => {
        if (status === 'SUBSCRIBED') {
          await this.channel.track(playerState);
        }
        this.emit('status', status);
      });
  }

  on(listener: NetworkListener) {
    this.listeners.push(listener);
  }

  off(listener: NetworkListener) {
    const i = this.listeners.indexOf(listener);
    if (i > -1) this.listeners.splice(i, 1);
  }

  private emit<T extends NetworkEvent['type']>(type: T, payload: Extract<NetworkEvent, { type: T }>['payload']) {
    for (const l of this.listeners) {
      l({ type, payload } as NetworkEvent);
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  //  Public API — eski metodlar (geriye uyumlu)
  // ══════════════════════════════════════════════════════════════════════

  sendState(state: PlayerState) {
    void this.channel.send({ type: 'broadcast', event: 'state', payload: state });
  }

  sendShoot(event: ShootEvent) {
    void this.channel.send({ type: 'broadcast', event: 'shoot', payload: event });
  }

  sendHit(event: HitEvent) {
    void this.channel.send({ type: 'broadcast', event: 'hit', payload: event });
  }

  sendDeath(event: DeathEvent) {
    void this.channel.send({ type: 'broadcast', event: 'death', payload: event });
  }

  sendBuy(event: BuyEvent) {
    void this.channel.send({ type: 'broadcast', event: 'buy', payload: event });
  }

  sendRespawn(event: RespawnEvent) {
    void this.channel.send({ type: 'broadcast', event: 'respawn', payload: event });
  }

  // ══════════════════════════════════════════════════════════════════════
  //  Yeni AAA netcode metodları
  // ══════════════════════════════════════════════════════════════════════

  /**
   * Input komutu gönder (client → server). Rate-limit'li (60 Hz).
   * NOT: production'da unreliable channel kullanılır; Supabase broadcast
   * reliable'dır ama "fire and forget" semantiği yeterli.
   */
  sendInput(cmd: InputCommand) {
    void this.channel.send({ type: 'broadcast', event: 'input', payload: cmd });
  }

  /**
   * State snapshot gönder (server → all). 20 Hz (50 ms).
   * ackSeq içerdiği için client prediction buffer'ı reconcile edebilir.
   */
  sendStateSnapshot(snap: StateSnapshot) {
    void this.channel.send({ type: 'broadcast', event: 'state-snapshot', payload: snap });
  }

  async cleanup() {
    await supabase.removeChannel(this.channel);
  }
}
