// src/lib/game/objectPool.ts
//
// Jenerik nesne havuzu. Amaç: sıcak yolda (her atışta, her karede) `new`/`dispose`
// çağırıp GC (garbage collector) baskısı yaratmak yerine, sabit sayıda nesneyi
// önceden yaratıp yeniden kullanmak.
//
// engine.ts'teki mevcut desenle tutarlı: bulletHoles zaten 120 sınırıyla en
// eskiyi disposeObject3D ediyordu — bu, "sınırı aş, dispose et" yaklaşımıydı.
// ObjectPool bunun bir adım ilerisi: dispose bile etmiyor, aynı GPU kaynağını
// (instance slotu, THREE.Sound vb.) yeniden kullanıyor.

export class ObjectPool<T> {
  private free: T[] = [];
  private inUse = new Set<T>();
  private readonly factory: () => T;
  private readonly reset: (item: T) => void;
  private readonly maxSize: number;

  constructor(factory: () => T, reset: (item: T) => void, initialSize: number, maxSize: number) {
    if (initialSize > maxSize) {
      throw new RangeError(`ObjectPool: initialSize (${initialSize}) > maxSize (${maxSize}) olamaz.`);
    }
    this.factory = factory;
    this.reset = reset;
    this.maxSize = maxSize;
    for (let i = 0; i < initialSize; i++) this.free.push(factory());
  }

  acquire(): T {
    let item: T;
    if (this.free.length > 0) {
      item = this.free.pop()!;
    } else if (this.inUse.size < this.maxSize) {
      item = this.factory();
    } else {
      // Havuz sert limite ulaştı: en eski aktif elemanı zorla geri al.
      // Bu, "sonsuza kadar birik ve belleği patlat" senaryosunu yapısal olarak imkansız kılar.
      const oldest = this.inUse.values().next().value as T;
      this.release(oldest);
      item = this.free.pop()!;
    }
    this.inUse.add(item);
    return item;
  }

  release(item: T) {
    if (!this.inUse.has(item)) return; // double-release koruması
    this.inUse.delete(item);
    this.reset(item);
    this.free.push(item);
  }

  get activeCount() { return this.inUse.size; }
  get freeCount() { return this.free.length; }
  forEachActive(fn: (item: T) => void) { this.inUse.forEach(fn); }
  forEachFree(fn: (item: T) => void) { this.free.forEach(fn); }
}
