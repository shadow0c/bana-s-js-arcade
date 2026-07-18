// src/lib/game/editorBridgeClient.ts
//
// OYUN TARAFI editör-köprüsü istemcisi. `game-editor-workspace` reposundaki
// `@game-engine/core`'un `EditorGameBridge`'i İLE AYNI JSON protokolünü
// konuşur — ama bu dosya o pakete BAĞIMLI DEĞİLDİR (oyun repo'su ayrı bir
// repo olarak kalsın, motor paketini npm bağımlılığı yapmaya gerek yok diye
// protokol burada küçük ve bağımsız bir şekilde yeniden uygulanmıştır).
//
// Kapsam (dürüstçe): şu an yalnızca MAP_WALLS'tan türeyen duvarları
// senkronlar (id: "wall-<index>"). Editörde yeni eklenen (oyunda karşılığı
// olmayan) nesneler bu ilk sürümde oyuna geri YANSIMAZ — bunun için oyunun
// runtime'da dinamik nesne yaratabilmesi gerekir, bu ayrı bir iş.
//
// Varsayılan olarak DEVRE DIŞI: yalnızca `VITE_EDITOR_BRIDGE_URL` env
// değişkeni tanımlıysa bağlanır. Prod ortamında bu değişkeni TANIMLAMA —
// oyuncuların istemcisi editöre bağlanmaya çalışmasın.

interface BridgeMessage {
  type: 'scene:request' | 'scene:full' | 'scene:entityUpdate' | 'ping' | 'pong';
  role: 'editor' | 'game';
  payload?: unknown;
}

interface WallEntity {
  id: string;
  name: string;
  transform: { position: { x: number; y: number; z: number }; rotationY: number; scale: { x: number; y: number; z: number } };
  userData: { __kind: 'box'; solid: true; color: string };
}

export class EditorBridgeClient {
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private shouldReconnect = true;

  /** @param getWallSnapshot Şu anki duvarları (index-hizalı) döndürür - engine.ts sağlar. */
  /** @param onWallUpdate Editörden gelen "wall-N" güncellemesini uygular - engine.ts sağlar. */
  constructor(
    private readonly url: string,
    private readonly getWallSnapshot: () => Array<{ x: number; y: number; z: number; w: number; h: number; d: number }>,
    private readonly onWallUpdate: (index: number, transform: WallEntity['transform']) => void,
  ) {}

  connect() {
    this.shouldReconnect = true;
    this.open();
  }

  private open() {
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      return; // geçersiz URL vb. - sessizce vazgeç, oyunu bloklama
    }
    this.ws = ws;

    ws.addEventListener('message', (event) => {
      let msg: BridgeMessage;
      try { msg = JSON.parse(event.data as string); } catch { return; }

      if (msg.type === 'scene:request') {
        this.sendFullScene();
      } else if (msg.type === 'scene:entityUpdate') {
        const update = msg.payload as { id: string; patch: { transform?: WallEntity['transform'] } };
        const match = /^wall-(\d+)$/.exec(update.id);
        if (match && update.patch.transform) {
          this.onWallUpdate(Number(match[1]), update.patch.transform);
        }
      }
    });

    ws.addEventListener('close', () => {
      if (this.shouldReconnect) this.reconnectTimer = setTimeout(() => this.open(), 2000);
    });
    ws.addEventListener('error', () => ws.close());
  }

  disconnect() {
    this.shouldReconnect = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
  }

  private sendFullScene() {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const walls = this.getWallSnapshot();
    const entities: WallEntity[] = walls.map((w, i) => ({
      id: `wall-${i}`,
      name: `Wall ${i}`,
      transform: { position: { x: w.x, y: w.h / 2, z: w.z }, rotationY: 0, scale: { x: w.w, y: w.h, z: w.d } },
      userData: { __kind: 'box', solid: true, color: '#8a8a8a' },
    }));
    const message: BridgeMessage = {
      type: 'scene:full',
      role: 'game',
      payload: { formatVersion: 1, name: 'Oyun Haritası (canlı)', entities },
    };
    this.ws.send(JSON.stringify(message));
  }
}
