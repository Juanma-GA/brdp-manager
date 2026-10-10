import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

// Consolidation C1, Part 3: the width of a side panel next to a flexible
// pane, set by dragging (or with the keyboard on) the divider between them.
// `size` is the side panel's width in px, always kept inside its limits:
// the panel never narrower than `minSize`, the other pane never narrower
// than `minOther`. When the container is too narrow for both minimums, the
// panel keeps its own minimum and the other pane shrinks.
//
// The chosen width is an interface preference that follows the person
// (AACF 3, HR1): the caller passes the stored width (`storedSize`, null =
// none) and saves it with `onSave(width | null)`. It is saved only when a
// change ends -- pointer release, a keyboard change (on key up, so holding
// an arrow sends one save), or a reset -- never on every pixel. Double-click
// (or reset()) goes back to `defaultSize` and deletes the stored width. A
// stored width wider than the window allows is clipped when shown; the
// saved value does not change until the person moves the divider.
const KEYBOARD_STEP = 16;
const KEYBOARD_BIG_STEP = 64;
const KEYBOARD_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'Home', 'End']);

export function useResizableSplit({ storedSize, onSave, defaultSize, minSize, minOther, dividerSize }) {
  const containerRef = useRef(null);
  const [requested, setRequested] = useState(() => storedSize ?? defaultSize);
  const [containerWidth, setContainerWidth] = useState(null);
  const [dragging, setDragging] = useState(false);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return undefined;
    const measure = () => setContainerWidth(el.getBoundingClientRect().width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const maxSize = containerWidth === null ? Infinity : Math.max(minSize, containerWidth - minOther - dividerSize);
  const clamp = useCallback((value) => Math.min(Math.max(value, minSize), maxSize), [minSize, maxSize]);
  const size = clamp(requested);

  // The width a keyboard change left pending, saved on key up.
  const pendingKeyboardSave = useRef(null);

  const commit = useCallback(
    (value) => {
      const next = clamp(value);
      setRequested(next);
      return next;
    },
    [clamp]
  );

  const reset = useCallback(() => {
    pendingKeyboardSave.current = null;
    setRequested(defaultSize);
    onSave?.(null);
  }, [defaultSize, onSave]);

  // The panel is on the right: its width is the distance from the pointer
  // (the divider's centre) to the container's right edge.
  const sizeAt = useCallback(
    (clientX) => {
      const rect = containerRef.current.getBoundingClientRect();
      return rect.right - clientX - dividerSize / 2;
    },
    [dividerSize]
  );

  const onPointerDown = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    e.currentTarget.focus();
    setDragging(true);
  };
  const onPointerMove = (e) => {
    if (!dragging) return;
    setRequested(clamp(sizeAt(e.clientX)));
  };
  const onPointerUp = (e) => {
    if (!dragging) return;
    setDragging(false);
    onSave?.(Math.round(commit(sizeAt(e.clientX))));
  };
  const onKeyDown = (e) => {
    const step = e.shiftKey ? KEYBOARD_BIG_STEP : KEYBOARD_STEP;
    // Arrows move the divider: left widens the panel, right narrows it.
    if (e.key === 'ArrowLeft') pendingKeyboardSave.current = commit(size + step);
    else if (e.key === 'ArrowRight') pendingKeyboardSave.current = commit(size - step);
    else if (e.key === 'Home') pendingKeyboardSave.current = commit(maxSize);
    else if (e.key === 'End') pendingKeyboardSave.current = commit(minSize);
    else if (e.key === 'Enter') reset();
    else return;
    e.preventDefault();
  };
  const savePendingKeyboardChange = () => {
    if (pendingKeyboardSave.current === null) return;
    const value = pendingKeyboardSave.current;
    pendingKeyboardSave.current = null;
    onSave?.(Math.round(value));
  };
  const onKeyUp = (e) => {
    if (KEYBOARD_KEYS.has(e.key)) savePendingKeyboardChange();
  };

  // No text selection while dragging.
  useEffect(() => {
    if (!dragging) return undefined;
    const previous = document.body.style.userSelect;
    document.body.style.userSelect = 'none';
    return () => {
      document.body.style.userSelect = previous;
    };
  }, [dragging]);

  return {
    containerRef,
    size,
    dragging,
    reset,
    dividerProps: {
      role: 'separator',
      tabIndex: 0,
      'aria-orientation': 'vertical',
      'aria-valuenow': Math.round(size),
      'aria-valuemin': minSize,
      'aria-valuemax': Number.isFinite(maxSize) ? Math.round(maxSize) : undefined,
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel: onPointerUp,
      onDoubleClick: reset,
      onKeyDown,
      onKeyUp,
      onBlur: savePendingKeyboardChange,
    },
  };
}
