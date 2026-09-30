// "Nombres navegables en las respuestas de Ask sin IA": state of the
// floating schema card -- the breadcrumb stack, the element the card is
// anchored to, and the cards already loaded (utils/schemaNavigation.js's
// createCardStore: in memory only, a UI cache -- HR1 does not apply). A
// card already loaded is never fetched again on Back or when the user
// comes back to it; the cache is emptied and the card closed when
// `resetKey` (the selected BRDP and the project) or the standard changes.
import { useEffect, useMemo, useState } from 'react';
import { backStack, createCardStore, currentTarget, goToStack, openStack, pushStack } from '../utils/schemaNavigation.js';

export function useSchemaNavigation({ standard, resetKey, fetchCards, fetchAttribute }) {
  const [stack, setStack] = useState([]);
  const [anchor, setAnchor] = useState(null);
  const [, setCards] = useState(null);
  const store = useMemo(
    () => createCardStore({ standard, fetchCards, fetchAttribute, onChange: setCards }),
    [standard, fetchCards, fetchAttribute]
  );

  useEffect(() => {
    store.reset();
    setStack([]);
    setAnchor(null);
  }, [store, resetKey]);

  const open = (target, anchorElement) => {
    setAnchor(anchorElement || null);
    setStack(openStack(target));
    store.load(target);
  };
  const navigate = (target) => {
    setStack((s) => pushStack(s, target));
    store.load(target);
  };
  const back = () => setStack((s) => backStack(s));
  const goTo = (index) => setStack((s) => goToStack(s, index));
  const target = currentTarget(stack);
  const retry = () => {
    if (target) store.load(target, { force: true });
  };
  // Closing keeps the cache; focus goes back to the link that opened it.
  const close = () => {
    setStack([]);
    if (anchor && typeof anchor.focus === 'function' && anchor.isConnected) anchor.focus();
    setAnchor(null);
  };

  return {
    stack,
    anchor,
    target,
    card: target ? store.get(target) || { status: 'loading' } : null,
    isOpen: stack.length > 0,
    open,
    navigate,
    back,
    goTo,
    retry,
    close,
  };
}
