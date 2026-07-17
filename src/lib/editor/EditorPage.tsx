// src/components/editor/EditorPage.tsx
//
// UE5/Unity tarzı 4 panelli editör: Toolbar (üst) - Hierarchy (sol) -
// Viewport (orta) - Inspector (sağ) - Asset Browser (alt). Bu sayfa `/editor`
// route'unda yaşar; `/game` route'unun (gerçek oynanış) HİÇBİR parçası
// DEĞİLDİR — oyuncular bunu asla görmez, sadece harita/içerik üreten kişi
// tarayıcıda bu adrese gider.

import { useEffect, useRef, useState, useCallback } from 'react';
import { EditorEngine } from '@/lib/editor/EditorEngine';
import {
  type LevelData, type LevelEntity, type BoxEntity, type LightEntity,
  createEmptyLevel, exportLevelJSON, exportMapWallsSource, parseLevelJSON,
} from '@/lib/editor/levelSchema';
import type { AssetRecord } from '@/lib/editor/AssetLibrary';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuTrigger, DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';

const KIND_LABEL: Record<LevelEntity['kind'], string> = {
  box: 'Kutu',
  spawnPoint: 'Spawn',
  bombsite: 'Bombsite',
  light: 'Işık',
  model: 'Model',
};

export function EditorPage() {
  const viewportRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<EditorEngine | null>(null);
  const modelFileInputRef = useRef<HTMLInputElement>(null);
  const textureFileInputRef = useRef<HTMLInputElement>(null);
  const levelFileInputRef = useRef<HTMLInputElement>(null);

  const [level, setLevel] = useState<LevelData>(() => createEmptyLevel('Yeni Harita'));
  const [selected, setSelected] = useState<LevelEntity | null>(null);
  const [assets, setAssets] = useState<AssetRecord[]>([]);
  const [mode, setMode] = useState<'translate' | 'rotate' | 'scale'>('translate');
  const [status, setStatus] = useState('Hazır.');

  useEffect(() => {
    const engine = new EditorEngine();
    engineRef.current = engine;
    if (viewportRef.current) engine.mount(viewportRef.current);

    engine.onLevelChange = (lvl) => setLevel({ ...lvl, entities: [...lvl.entities] });
    engine.onSelectionChange = (entity) => setSelected(entity);
    engine.newLevel('Yeni Harita');

    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return; // input alanlarındayken kısayolları tetikleme
      if (e.key === 'w' || e.key === 'W') { setMode('translate'); engine.setTransformMode('translate'); }
      if (e.key === 'e' || e.key === 'E') { setMode('rotate'); engine.setTransformMode('rotate'); }
      if (e.key === 'r' || e.key === 'R') { setMode('scale'); engine.setTransformMode('scale'); }
      if (e.key === 'Delete' || e.key === 'Backspace') engine.removeSelected();
    };
    window.addEventListener('keydown', onKeyDown);

    return () => {
      window.removeEventListener('keydown', onKeyDown);
      engine.unmount();
      engineRef.current = null;
    };
  }, []);

  const refreshAssets = useCallback(() => {
    setAssets(engineRef.current?.assets.list() ?? []);
  }, []);

  const handleImportModel = useCallback(async (file: File) => {
    setStatus(`İçe aktarılıyor: ${file.name}...`);
    try {
      const record = await engineRef.current!.assets.importModelFile(file);
      refreshAssets();
      const r = record.report!;
      setStatus(
        `Import OK: ${file.name} | ${r.triangles.toLocaleString('tr-TR')} üçgen | ` +
        `${r.materials} malzeme | ~${(r.textureBytesEstimate / (1024 * 1024)).toFixed(1)} MB doku`,
      );
    } catch (err) {
      setStatus(`Model import hatası: ${(err as Error).message}`);
    }
  }, [refreshAssets]);

  const handleImportTexture = useCallback(async (file: File) => {
    try {
      await engineRef.current!.assets.importTextureFile(file);
      refreshAssets();
      setStatus(`Doku eklendi: ${file.name}`);
    } catch (err) {
      setStatus(`Doku import hatası: ${(err as Error).message}`);
    }
  }, [refreshAssets]);

  const patchSelected = useCallback((patch: Partial<LevelEntity>) => {
    if (!selected) return;
    engineRef.current?.applyEntityUpdate(selected.id, patch);
    setSelected((prev) => (prev ? { ...prev, ...patch } as LevelEntity : prev));
  }, [selected]);

  const handleExportJSON = () => {
    const json = exportLevelJSON(level);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${level.name || 'harita'}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setStatus('Seviye JSON olarak indirildi.');
  };

  const handleLoadJSON = async (file: File) => {
    try {
      const text = await file.text();
      const parsed = parseLevelJSON(text);
      engineRef.current?.loadLevel(parsed);
      setStatus(`Yüklendi: ${parsed.name}`);
    } catch (err) {
      setStatus(`Yükleme hatası: ${(err as Error).message}`);
    }
  };

  const handleCopyMapWalls = async () => {
    const source = exportMapWallsSource(level);
    try {
      await navigator.clipboard.writeText(source);
      setStatus('MAP_WALLS kaynak kodu panoya kopyalandı — constants.ts içine yapıştırabilirsin.');
    } catch {
      setStatus('Pano erişimi engellendi. Konsola yazdırıldı, oradan kopyala.');
      console.log(source);
    }
  };

  return (
    <div className="flex h-screen w-screen flex-col bg-[#1a1d23] text-zinc-200 select-none">
      {/* ---------------- TOOLBAR ---------------- */}
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-zinc-800 bg-[#20242c] px-3">
        <span className="mr-2 text-sm font-semibold text-zinc-400">Sahne Editörü</span>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="secondary">+ Ekle</Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem onSelect={() => engineRef.current?.addBox(true)}>Kutu (Solid / Duvar)</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => engineRef.current?.addBox(false)}>Prop (Solid olmayan)</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => engineRef.current?.addSpawnPoint('t')}>T Spawn</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => engineRef.current?.addSpawnPoint('ct')}>CT Spawn</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => engineRef.current?.addBombsite('A')}>Bombsite A</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => engineRef.current?.addBombsite('B')}>Bombsite B</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => engineRef.current?.addLight()}>Işık</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => modelFileInputRef.current?.click()}>Model İçe Aktar (.glb/.gltf)</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => textureFileInputRef.current?.click()}>Doku İçe Aktar (.png/.jpg)</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <ToggleGroup
          type="single"
          value={mode}
          onValueChange={(v) => { if (v) { setMode(v as typeof mode); engineRef.current?.setTransformMode(v as typeof mode); } }}
        >
          <ToggleGroupItem value="translate" title="Taşı (W)">Taşı</ToggleGroupItem>
          <ToggleGroupItem value="rotate" title="Döndür (E)">Döndür</ToggleGroupItem>
          <ToggleGroupItem value="scale" title="Ölçekle (R)">Ölçek</ToggleGroupItem>
        </ToggleGroup>

        <div className="mx-2 h-6 w-px bg-zinc-700" />

        <Button size="sm" variant="ghost" onClick={handleExportJSON}>Kaydet (JSON)</Button>
        <Button size="sm" variant="ghost" onClick={() => levelFileInputRef.current?.click()}>Yükle (JSON)</Button>
        <Button size="sm" variant="ghost" onClick={handleCopyMapWalls}>MAP_WALLS Kopyala (CS2)</Button>

        <div className="mx-2 h-6 w-px bg-zinc-700" />
        <Button size="sm" variant="destructive" onClick={() => engineRef.current?.removeSelected()}>Seçiliyi Sil (Del)</Button>

        <span className="ml-auto max-w-[38ch] truncate text-xs text-zinc-500">{status}</span>

        <input ref={modelFileInputRef} type="file" accept=".glb,.gltf" hidden
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleImportModel(f); e.target.value = ''; }} />
        <input ref={textureFileInputRef} type="file" accept="image/png,image/jpeg,image/webp" hidden
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleImportTexture(f); e.target.value = ''; }} />
        <input ref={levelFileInputRef} type="file" accept="application/json" hidden
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleLoadJSON(f); e.target.value = ''; }} />
      </div>

      {/* ---------------- BODY: Hierarchy / Viewport / Inspector ---------------- */}
      <div className="flex min-h-0 flex-1">
        {/* HIERARCHY */}
        <div className="w-56 shrink-0 border-r border-zinc-800 bg-[#20242c]">
          <div className="border-b border-zinc-800 px-3 py-2 text-xs font-semibold uppercase text-zinc-500">
            Hierarchy ({level.entities.length})
          </div>
          <ScrollArea className="h-[calc(100%-2rem)]">
            <div className="flex flex-col p-1">
              {level.entities.map((e) => (
                <button
                  key={e.id}
                  onClick={() => engineRef.current?.select(e.id)}
                  className={`flex items-center justify-between rounded px-2 py-1 text-left text-sm hover:bg-zinc-700/50 ${selected?.id === e.id ? 'bg-zinc-700 text-white' : 'text-zinc-300'}`}
                >
                  <span className="truncate">{e.name}</span>
                  <span className="ml-2 shrink-0 text-[10px] text-zinc-500">{KIND_LABEL[e.kind]}</span>
                </button>
              ))}
              {level.entities.length === 0 && (
                <div className="px-2 py-4 text-center text-xs text-zinc-600">Sahne boş. "+ Ekle" ile başla.</div>
              )}
            </div>
          </ScrollArea>
        </div>

        {/* VIEWPORT */}
        <div className="relative min-w-0 flex-1">
          <div ref={viewportRef} className="absolute inset-0" />
          <div className="pointer-events-none absolute bottom-2 left-2 text-[11px] text-zinc-500">
            Sol tık: seç · Sürükle: orbit · Sağ tık: pan · Tekerlek: zoom · W/E/R: mod
          </div>
        </div>

        {/* INSPECTOR */}
        <div className="w-72 shrink-0 border-l border-zinc-800 bg-[#20242c]">
          <div className="border-b border-zinc-800 px-3 py-2 text-xs font-semibold uppercase text-zinc-500">Inspector</div>
          <ScrollArea className="h-[calc(100%-2rem)]">
            {!selected ? (
              <div className="px-3 py-4 text-center text-xs text-zinc-600">Bir nesne seç.</div>
            ) : (
              <InspectorFields entity={selected} onChange={patchSelected} />
            )}
          </ScrollArea>
        </div>
      </div>

      {/* ---------------- ASSET BROWSER ---------------- */}
      <div className="h-32 shrink-0 border-t border-zinc-800 bg-[#20242c]">
        <div className="border-b border-zinc-800 px-3 py-1 text-xs font-semibold uppercase text-zinc-500">
          Asset Browser ({assets.length})
        </div>
        <ScrollArea className="h-[calc(100%-1.75rem)]">
          <div className="flex gap-2 p-2">
            {assets.map((a) => (
              <div key={a.id} className="flex w-28 shrink-0 flex-col items-center gap-1 rounded border border-zinc-700 p-2 text-center">
                <div className="flex h-12 w-12 items-center justify-center rounded bg-zinc-800 text-[10px] text-zinc-500">
                  {a.kind === 'model' ? '3D' : 'IMG'}
                </div>
                <span className="w-full truncate text-[11px]">{a.name}</span>
                {a.kind === 'model' && (
                  <Button size="sm" variant="secondary" className="h-6 w-full text-[11px]"
                    onClick={() => engineRef.current?.addModelInstance(a.id, a.name)}>
                    Sahneye Koy
                  </Button>
                )}
              </div>
            ))}
            {assets.length === 0 && (
              <div className="px-2 py-3 text-xs text-zinc-600">Henüz asset import edilmedi.</div>
            )}
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}

function NumberField({ label, value, onChange, step = 0.1 }: { label: string; value: number; onChange: (v: number) => void; step?: number }) {
  return (
    <div className="flex items-center gap-2">
      <Label className="w-6 shrink-0 text-xs text-zinc-500">{label}</Label>
      <Input
        type="number"
        step={step}
        value={Number.isFinite(value) ? value : 0}
        onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
        className="h-7 text-xs"
      />
    </div>
  );
}

function InspectorFields({ entity, onChange }: { entity: LevelEntity; onChange: (patch: Partial<LevelEntity>) => void }) {
  return (
    <div className="flex flex-col gap-3 p-3">
      <div>
        <Label className="text-xs text-zinc-500">İsim</Label>
        <Input value={entity.name} onChange={(e) => onChange({ name: e.target.value })} className="h-7 text-xs" />
      </div>

      <Separator />
      <div className="text-xs font-semibold text-zinc-500">Konum</div>
      <div className="grid grid-cols-3 gap-1">
        <NumberField label="X" value={entity.position.x} onChange={(v) => onChange({ position: { ...entity.position, x: v } })} />
        <NumberField label="Y" value={entity.position.y} onChange={(v) => onChange({ position: { ...entity.position, y: v } })} />
        <NumberField label="Z" value={entity.position.z} onChange={(v) => onChange({ position: { ...entity.position, z: v } })} />
      </div>

      <div className="text-xs font-semibold text-zinc-500">Döndürme (Y°)</div>
      <NumberField label="Y°" value={entity.rotationY} onChange={(v) => onChange({ rotationY: v })} step={1} />

      <div className="text-xs font-semibold text-zinc-500">Ölçek</div>
      <div className="grid grid-cols-3 gap-1">
        <NumberField label="X" value={entity.scale.x} onChange={(v) => onChange({ scale: { ...entity.scale, x: v } })} />
        <NumberField label="Y" value={entity.scale.y} onChange={(v) => onChange({ scale: { ...entity.scale, y: v } })} />
        <NumberField label="Z" value={entity.scale.z} onChange={(v) => onChange({ scale: { ...entity.scale, z: v } })} />
      </div>

      <Separator />

      {entity.kind === 'box' && (
        <BoxFields entity={entity} onChange={onChange as (p: Partial<BoxEntity>) => void} />
      )}
      {entity.kind === 'light' && (
        <LightFields entity={entity} onChange={onChange as (p: Partial<LightEntity>) => void} />
      )}
      {entity.kind === 'spawnPoint' && (
        <div className="text-xs text-zinc-500">Takım: <span className="text-zinc-200">{entity.team === 't' ? 'Terörist' : 'Counter-Terörist'}</span></div>
      )}
      {entity.kind === 'bombsite' && (
        <div className="text-xs text-zinc-500">Etiket: <span className="text-zinc-200">{entity.label}</span></div>
      )}
      {entity.kind === 'model' && (
        <div className="text-xs text-zinc-500">Asset: <span className="text-zinc-200">{entity.assetName}</span></div>
      )}
    </div>
  );
}

function BoxFields({ entity, onChange }: { entity: BoxEntity; onChange: (p: Partial<BoxEntity>) => void }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="text-xs font-semibold text-zinc-500">Malzeme (GGX/PBR)</div>
      <div className="flex items-center gap-2">
        <Label className="w-16 shrink-0 text-xs text-zinc-500">Renk</Label>
        <input type="color" value={entity.color} onChange={(e) => onChange({ color: e.target.value })} className="h-7 w-full rounded" />
      </div>
      <NumberField label="Met" value={entity.metalness} step={0.05} onChange={(v) => onChange({ metalness: Math.max(0, Math.min(1, v)) })} />
      <NumberField label="Rgh" value={entity.roughness} step={0.05} onChange={(v) => onChange({ roughness: Math.max(0, Math.min(1, v)) })} />
      <label className="flex items-center gap-2 text-xs text-zinc-400">
        <input type="checkbox" checked={entity.solid} onChange={(e) => onChange({ solid: e.target.checked })} />
        Solid (oyuncu içinden geçemez, CS2 export'una dahil)
      </label>
    </div>
  );
}

function LightFields({ entity, onChange }: { entity: LightEntity; onChange: (p: Partial<LightEntity>) => void }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="text-xs font-semibold text-zinc-500">Işık</div>
      <div className="flex items-center gap-2">
        <Label className="w-16 shrink-0 text-xs text-zinc-500">Renk</Label>
        <input type="color" value={entity.color} onChange={(e) => onChange({ color: e.target.value })} className="h-7 w-full rounded" />
      </div>
      <NumberField label="Int" value={entity.intensity} step={0.1} onChange={(v) => onChange({ intensity: Math.max(0, v) })} />
      <NumberField label="Dst" value={entity.distance} step={1} onChange={(v) => onChange({ distance: Math.max(0, v) })} />
    </div>
  );
}
