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
}

export function MobileControls(props: MobileControlsProps) {
  const joyRef = useRef<HTMLDivElement>(null);
  const knobRef = useRef<HTMLDivElement>(null);
  const lookRef = useRef<HTMLDivElement>(null);
  const activeTouches = useRef<Record<number, 'joy' | 'look'>>({});
  const joyStart = useRef<{ x: number; y: number } | null>(null);
  const lookLast = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const joy = joyRef.current;
    const knob = knobRef.current;
    const look = lookRef.current;
    if (!joy || !knob || !look) return;

    const RADIUS = 55;

    const onStart = (e: TouchEvent) => {
      for (const t of Array.from(e.changedTouches)) {
        const jr = joy.getBoundingClientRect();
        const inJoy =
          t.clientX >= jr.left - 20 && t.clientX <= jr.right + 20 &&
          t.clientY >= jr.top - 20 && t.clientY <= jr.bottom + 20;
        if (inJoy && !Object.values(activeTouches.current).includes('joy')) {
          activeTouches.current[t.identifier] = 'joy';
          joyStart.current = { x: jr.left + jr.width / 2, y: jr.top + jr.height / 2 };
        } else {
          activeTouches.current[t.identifier] = 'look';
          lookLast.current = { x: t.clientX, y: t.clientY };
        }
      }
    };

    const onMove = (e: TouchEvent) => {
      for (const t of Array.from(e.changedTouches)) {
        const kind = activeTouches.current[t.identifier];
        if (kind === 'joy' && joyStart.current) {
          let dx = t.clientX - joyStart.current.x;
          let dy = t.clientY - joyStart.current.y;
          const len = Math.hypot(dx, dy);
          if (len > RADIUS) { dx = (dx / len) * RADIUS; dy = (dy / len) * RADIUS; }
          knob.style.transform = `translate(${dx}px, ${dy}px)`;
          props.onMove(dx / RADIUS, dy / RADIUS);
        } else if (kind === 'look' && lookLast.current) {
          const dx = t.clientX - lookLast.current.x;
          const dy = t.clientY - lookLast.current.y;
          lookLast.current = { x: t.clientX, y: t.clientY };
          props.onLook(dx * 3, dy * 3);
        }
      }
    };

    const onEnd = (e: TouchEvent) => {
      for (const t of Array.from(e.changedTouches)) {
        const kind = activeTouches.current[t.identifier];
        if (kind === 'joy') {
          knob.style.transform = 'translate(0,0)';
          props.onMove(0, 0);
          joyStart.current = null;
        } else if (kind === 'look') {
          lookLast.current = null;
        }
        delete activeTouches.current[t.identifier];
      }
    };

    look.addEventListener('touchstart', onStart, { passive: false });
    look.addEventListener('touchmove', onMove, { passive: false });
    look.addEventListener('touchend', onEnd);
    look.addEventListener('touchcancel', onEnd);
    return () => {
      look.removeEventListener('touchstart', onStart);
      look.removeEventListener('touchmove', onMove);
      look.removeEventListener('touchend', onEnd);
      look.removeEventListener('touchcancel', onEnd);
    };
  }, [props]);

  const btnBase =
    'select-none rounded-full bg-black/50 backdrop-blur text-white font-bold text-xs flex items-center justify-center border border-white/20 active:bg-white/20';

  return (
    <>
      {/* Look area covers full screen but sits behind buttons */}
      <div ref={lookRef} className="absolute inset-0 z-10" />

      {/* Joystick */}
      <div ref={joyRef} className="pointer-events-none absolute bottom-8 left-8 z-20 h-32 w-32 rounded-full bg-white/10 backdrop-blur">
        <div ref={knobRef} className="absolute left-1/2 top-1/2 h-14 w-14 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white/40" />
      </div>

      {/* Action buttons (right side) */}
      <div className="pointer-events-none absolute bottom-8 right-6 z-20 flex flex-col items-end gap-3">
        <div className="flex gap-3">
          <button
            className={`${btnBase} pointer-events-auto h-12 w-12`}
            onTouchStart={(e) => { e.preventDefault(); props.onThrowFlash(); }}
          >FLASH</button>
          <button
            className={`${btnBase} pointer-events-auto h-12 w-12`}
            onTouchStart={(e) => { e.preventDefault(); props.onThrowHE(); }}
          >HE</button>
        </div>
        <div className="flex items-end gap-3">
          <button
            className={`${btnBase} pointer-events-auto h-12 w-12`}
            onTouchStart={(e) => { e.preventDefault(); props.onReload(); }}
          >R</button>
          <button
            className={`${btnBase} pointer-events-auto h-14 w-14`}
            onTouchStart={(e) => { e.preventDefault(); props.onAim(true); }}
            onTouchEnd={(e) => { e.preventDefault(); props.onAim(false); }}
          >SCOPE</button>
          <button
            className={`${btnBase} pointer-events-auto h-20 w-20 !bg-red-600/70`}
            onTouchStart={(e) => { e.preventDefault(); props.onFire(true); }}
            onTouchEnd={(e) => { e.preventDefault(); props.onFire(false); }}
          >ATEŞ</button>
        </div>
      </div>

      {/* Top-right buy button */}
      <button
        className={`${btnBase} pointer-events-auto absolute right-4 top-4 z-20 h-10 w-14`}
        onTouchStart={(e) => { e.preventDefault(); props.onOpenBuy(); }}
      >SATIN AL</button>
    </>
  );
}
