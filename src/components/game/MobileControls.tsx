import { useEffect, useRef } from 'react';

interface MobileControlsProps {
  onMove: (x: number, y: number) => void;
  onLook: (dx: number, dy: number) => void;
  onFire: (v: boolean) => void;
  onAim: (v: boolean) => void;
  onReload: () => void;
  onThrowFlash: () => void;
  onThrowHE: () => void;
  onOpenBuy: () => void;
  onWeapon: (id: string) => void;
}

/**
 * Sol yarım ekran = joystick (dokunulan yer joystick merkezi olur — dinamik).
 * Sağ yarım ekran = bakış (swipe).
 * Butonlar bunlardan bağımsız pointer-events-auto ile yakalar.
 */
export function MobileControls(props: MobileControlsProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const knobRef = useRef<HTMLDivElement>(null);
  const baseRef = useRef<HTMLDivElement>(null);

  const joyTouchId = useRef<number | null>(null);
  const lookTouchId = useRef<number | null>(null);
  const joyCenter = useRef<{ x: number; y: number } | null>(null);
  const lookLast = useRef<{ x: number; y: number } | null>(null);

  // KRİTİK: Props her renderda yeni referans olduğu için önceki sürümde
  // `useEffect(..., [props])` ~20Hz `setLocalState` yüzünden sürekli teardown/
  // re-attach yapıyordu. Touchstart ile touchmove arasında re-render olursa
  // dinleyiciler kayboluyor, joystick "takılı" gibi görünüyordu.
  // Çözüm: propsRef ile stable [] deps.
  const propsRef = useRef(props);
  propsRef.current = props;

  useEffect(() => {
    const root = rootRef.current;
    const knob = knobRef.current;
    const base = baseRef.current;
    if (!root || !knob || !base) return;

    const RADIUS = 60;

    const isButton = (target: EventTarget | null) =>
      target instanceof Element && !!target.closest('[data-touch-btn]');

    const onStart = (e: TouchEvent) => {
      for (const t of Array.from(e.changedTouches)) {
        if (isButton(t.target)) continue;
        const half = window.innerWidth / 2;
        if (t.clientX < half && joyTouchId.current === null) {
          joyTouchId.current = t.identifier;
          joyCenter.current = { x: t.clientX, y: t.clientY };
          base.style.left = `${t.clientX}px`;
          base.style.top = `${t.clientY}px`;
          base.style.opacity = '1';
          knob.style.transform = `translate(-50%, -50%)`;
        } else if (t.clientX >= half && lookTouchId.current === null) {
          lookTouchId.current = t.identifier;
          lookLast.current = { x: t.clientX, y: t.clientY };
        }
        e.preventDefault();
      }
    };

    const onMove = (e: TouchEvent) => {
      for (const t of Array.from(e.changedTouches)) {
        if (t.identifier === joyTouchId.current && joyCenter.current) {
          let dx = t.clientX - joyCenter.current.x;
          let dy = t.clientY - joyCenter.current.y;
          const len = Math.hypot(dx, dy);
          if (len > RADIUS) { dx = (dx / len) * RADIUS; dy = (dy / len) * RADIUS; }
          knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
          propsRef.current.onMove(dx / RADIUS, dy / RADIUS);
        } else if (t.identifier === lookTouchId.current && lookLast.current) {
          const dx = t.clientX - lookLast.current.x;
          const dy = t.clientY - lookLast.current.y;
          lookLast.current = { x: t.clientX, y: t.clientY };
          propsRef.current.onLook(dx * 4, dy * 4);
        }
      }
      e.preventDefault();
    };

    const onEnd = (e: TouchEvent) => {
      for (const t of Array.from(e.changedTouches)) {
        if (t.identifier === joyTouchId.current) {
          joyTouchId.current = null;
          joyCenter.current = null;
          propsRef.current.onMove(0, 0);
          knob.style.transform = 'translate(-50%, -50%)';
          base.style.opacity = '0';
        } else if (t.identifier === lookTouchId.current) {
          lookTouchId.current = null;
          lookLast.current = null;
        }
      }
    };

    root.addEventListener('touchstart', onStart, { passive: false });
    root.addEventListener('touchmove', onMove, { passive: false });
    root.addEventListener('touchend', onEnd);
    root.addEventListener('touchcancel', onEnd);
    return () => {
      root.removeEventListener('touchstart', onStart);
      root.removeEventListener('touchmove', onMove);
      root.removeEventListener('touchend', onEnd);
      root.removeEventListener('touchcancel', onEnd);
    };
     
  }, []);

  const btn =
    'select-none rounded-full bg-black/55 backdrop-blur text-white font-bold text-[10px] flex items-center justify-center border border-white/25 active:bg-white/20 pointer-events-auto touch-none';

  return (
    <>
      {/* Root captures all touches (below buttons via lower z-index) */}
      <div ref={rootRef} className="absolute inset-0 z-10 touch-none" />

      {/* Joystick base (appears where user touches) */}
      <div
        ref={baseRef}
        className="pointer-events-none absolute z-20 h-32 w-32 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white/10 opacity-0 transition-opacity"
        style={{ left: 100, top: 100 }}
      >
        <div
          ref={knobRef}
          className="absolute left-1/2 top-1/2 h-14 w-14 rounded-full bg-white/50"
          style={{ transform: 'translate(-50%, -50%)' }}
        />
      </div>

      {/* Right side action stack */}
      <div className="pointer-events-none absolute bottom-6 right-4 z-30 flex flex-col items-end gap-2">
        <div className="flex gap-2">
          <button data-touch-btn className={`${btn} h-11 w-11`}
            onTouchStart={(e) => { e.preventDefault(); e.stopPropagation(); props.onThrowFlash(); }}>FLASH</button>
          <button data-touch-btn className={`${btn} h-11 w-11`}
            onTouchStart={(e) => { e.preventDefault(); e.stopPropagation(); props.onThrowHE(); }}>HE</button>
        </div>
        <div className="flex items-end gap-2">
          <button data-touch-btn className={`${btn} h-11 w-11`}
            onTouchStart={(e) => { e.preventDefault(); e.stopPropagation(); props.onReload(); }}>R</button>
          <button data-touch-btn className={`${btn} h-12 w-12`}
            onTouchStart={(e) => { e.preventDefault(); e.stopPropagation(); props.onAim(true); }}
            onTouchEnd={(e) => { e.preventDefault(); e.stopPropagation(); props.onAim(false); }}>SCOPE</button>
          <button data-touch-btn className={`${btn} !h-20 !w-20 !bg-red-600/70 !text-sm`}
            onTouchStart={(e) => { e.preventDefault(); e.stopPropagation(); props.onFire(true); }}
            onTouchEnd={(e) => { e.preventDefault(); e.stopPropagation(); props.onFire(false); }}>ATEŞ</button>
        </div>
      </div>

      {/* Top bar: weapon slots + buy */}
      <div className="pointer-events-none absolute right-4 top-4 z-30 flex flex-col items-end gap-2">
        <button data-touch-btn className={`${btn} h-9 w-16`}
          onTouchStart={(e) => { e.preventDefault(); e.stopPropagation(); props.onOpenBuy(); }}>SATIN AL</button>
        <div className="flex gap-1">
          {[
            { id: 'pistol', label: '1' },
            { id: 'rifle', label: '2' },
            { id: 'sniper', label: '3' },
            { id: 'knife', label: '4' },
          ].map((w) => (
            <button key={w.id} data-touch-btn className={`${btn} h-9 w-9`}
              onTouchStart={(e) => { e.preventDefault(); e.stopPropagation(); props.onWeapon(w.id); }}>{w.label}</button>
          ))}
        </div>
      </div>
    </>
  );
}
