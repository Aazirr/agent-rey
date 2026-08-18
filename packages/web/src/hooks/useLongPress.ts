/**
 * Long-press to enter selection mode — the standard mobile idiom for "select
 * these, then act on them", and far better on a phone than a row of tiny icons.
 *
 * The fiddly parts, all of which break the interaction if missed:
 *  - a press that turns into a scroll must NOT fire, so movement past a small
 *    threshold cancels it
 *  - the click that follows a long-press must be swallowed, or releasing your
 *    finger also opens the thing you were trying to select
 *  - `contextmenu` is suppressed while pressing, or Android/desktop pop their own
 *    menu over the selection you just made
 *  - right-click is wired to the same handler so the feature exists on desktop
 */

import { useCallback, useEffect, useRef } from 'react';

const HOLD_MS = 450;
/** Past this much movement it is a scroll, not a press. */
const MOVE_TOLERANCE_PX = 10;

export interface LongPressHandlers {
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerUp: (e: React.PointerEvent) => void;
  onPointerLeave: (e: React.PointerEvent) => void;
  onPointerMove: (e: React.PointerEvent) => void;
  onPointerCancel: (e: React.PointerEvent) => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onClick: (e: React.MouseEvent) => void;
}

export function useLongPress(
  onLongPress: () => void,
  onClick?: () => void,
  enabled = true,
): LongPressHandlers {
  const timer = useRef<number | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);

  const clear = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    start.current = null;
  }, []);

  useEffect(() => clear, [clear]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (!enabled) return;
      // Only a primary press; a two-finger gesture is not a long press.
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      fired.current = false;
      start.current = { x: e.clientX, y: e.clientY };
      timer.current = window.setTimeout(() => {
        fired.current = true;
        timer.current = null;
        // Haptic confirmation where supported; silently ignored elsewhere.
        navigator.vibrate?.(15);
        onLongPress();
      }, HOLD_MS);
    },
    [enabled, onLongPress],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (timer.current === null || !start.current) return;
      const dx = Math.abs(e.clientX - start.current.x);
      const dy = Math.abs(e.clientY - start.current.y);
      // Scrolling a list must never select a row.
      if (dx > MOVE_TOLERANCE_PX || dy > MOVE_TOLERANCE_PX) clear();
    },
    [clear],
  );

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp: clear,
    onPointerLeave: clear,
    onPointerCancel: clear,
    onContextMenu: (e: React.MouseEvent) => {
      // Right-click is the desktop equivalent; also stops the OS menu covering
      // the selection on a long press.
      e.preventDefault();
      if (!enabled) return;
      if (!fired.current) {
        fired.current = true;
        onLongPress();
      }
    },
    onClick: (e: React.MouseEvent) => {
      if (fired.current) {
        // Swallow the click that a long press produces on release.
        e.preventDefault();
        e.stopPropagation();
        fired.current = false;
        return;
      }
      onClick?.();
    },
  };
}
