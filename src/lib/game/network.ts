import { supabase } from '@/integrations/supabase/client';
import type { RealtimeChannel } from '@supabase/supabase-js';
import type { PlayerState, ShootEvent, HitEvent, DeathEvent, BuyEvent, RespawnEvent } from './types';

export type NetworkEvent =
  | { type: 'state'; payload: PlayerState }
  | { type: 'shoot'; payload: ShootEvent }
  | { type: 'hit'; payload: HitEvent }
  | { type: 'death'; payload: DeathEvent }
  | { type: 'buy'; payload: BuyEvent }
  | { type: 'respawn'; payload: RespawnEvent }
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
      },
    });

    this.channel
      .on('broadcast', { event: 'state' }, ({ payload }) => this.emit('state', payload))
      .on('broadcast', { event: 'shoot' }, ({ payload }) => this.emit('shoot', payload))
      .on('broadcast', { event: 'hit' }, ({ payload }) => this.emit('hit', payload))
      .on('broadcast', { event: 'death' }, ({ payload }) => this.emit('death', payload))
      .on('broadcast', { event: 'buy' }, ({ payload }) => this.emit('buy', payload))
      .on('broadcast', { event: 'respawn' }, ({ payload }) => this.emit('respawn', payload))
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

  async cleanup() {
    await supabase.removeChannel(this.channel);
  }
}
