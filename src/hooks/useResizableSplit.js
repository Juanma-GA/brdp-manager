import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

// Consolidation C1, Part 3: the width of a side panel next to a flexible
// pane, set by dragging (or with the keyboard on) the divider between them.
// `size` is the side panel's width in px, always kept inside its limits:
// the panel never narrower than `minSize`, the other pane never narrower
// than `minOther`. When the container is too narrow for both minimums, the
// panel keeps its own minimum and the other pane shrinks.
//
// The chosen width is a UI preference of this browser, not data: it lives
// in localStorage only (HR1 is about authoritative state), and every access
// is wrapped because storage can be missing or blocked. Double-click (or
// reset()) goes back to `defaultSize` and forgets the stored width.
const KEYBOARD_STEP = 16;
const KEYBOARD_BIG_STEP = 64;

function readStored(key) {
  try {
    const value = Number(window.localStorage.getItem(key));
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function writeStored(key, value) {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, String(Math.round(value)));
  } catch {
    // Not stored: the width still applies for this page view.
  }
}

export function useResizableSplit({ storageKey, defaultSize, minSize, minOther, dividerSize }) {
  const containerRef = useRef(null);
  const [requested, setRequested] = useState(() => readStored(storageKey) ?? defaultSize);
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

  const commit = useCallback(
    (value) => {
      const next = clamp(value);
      setRequested(next);
      writeStored(storageKey, next);
    },
    [clamp, storageKey]
  );

  const reset = useCallback(() => {
    setRequested(defaultSize);
    writeStored(storageKey, null);
  }, [defaultSize, storageKey]);

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
    commit(sizeAt(e.clientX));
  };
  const onKeyDown = (e) => {
    const step = e.shiftKey ? KEYBOARD_BIG_STEP : KEYBOARD_STEP;
    // Arrows move the divider: left widens the panel, right narrows it.
    if (e.key === 'ArrowLeft') commit(size + step);
    else if (e.key === 'ArrowRight') commit(size - step);
    else if (e.key === 'Home') commit(maxSize);
    else if (e.key === 'End') commit(minSize);
    else if (e.key === 'Enter') reset();
    else return;
    e.preventDefault();
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
    },
  };
}
