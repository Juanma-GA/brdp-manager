import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { attributeCardModel, crumbLabel, cutNames, elementCardModel, targetKey, targetLabel } from '../../utils/schemaNavigation.js';
import styles from '../../pages/RecordsPage.module.css';
import { InlineLinkButton } from './SchemaAnswerLinks';

// "Nombres navegables en las respuestas de Ask sin IA": the floating card
// opened from a name in an answer taken from the schema. Element cards show
// children, parents and attributes (with the values of closed lists),
// grouped by schema variant as the structural answers do; attribute cards
// show its values and the elements that have it. Every name in the card is
// a link to its own card. State (breadcrumb, cache) lives in
// hooks/useSchemaNavigation.js; nothing here adds to the Ask thread.

const CARD_WIDTH = 380;
const MARGIN = 12;

// Fixed position next to the anchor link, below it when there is room,
// else above; always inside the viewport (the card scrolls inside).
function cardPosition(anchor) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const width = Math.min(CARD_WIDTH, vw - 2 * MARGIN);
  const rect = anchor && anchor.isConnected ? anchor.getBoundingClientRect() : null;
  if (!rect) return { left: Math.max(MARGIN, (vw - width) / 2), top: MARGIN, width, maxHeight: vh - 2 * MARGIN };
  const left = Math.min(Math.max(MARGIN, rect.left), vw - width - MARGIN);
  const below = vh - rect.bottom - MARGIN - 4;
  const above = rect.top - MARGIN - 4;
  if (below >= 240 || below >= above) {
    return { left, top: rect.bottom + 4, width, maxHeight: Math.max(160, below) };
  }
  const maxHeight = Math.max(160, above);
  return { left, bottom: vh - rect.top + 4, width, maxHeight };
}

// A name inside the card: a link to its own card.
function NameLink({ target, onNavigate }) {
  return (
    <InlineLinkButton className={styles.schemaNavName} onActivate={() => onNavigate(target)} testId={`schema-nav-link-${targetKey(target)}`}>
      <code>{targetLabel(target)}</code>
    </InlineLinkButton>
  );
}

// A list of element names cut at 20 with an expandable "+N more".
function NameList({ names, kind = 'element', onNavigate, listId }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const { shown, hidden } = cutNames(names, { expanded });
  return (
    <span data-testid={listId ? `schema-nav-list-${listId}` : undefined}>
      {shown.map((name, idx) => (
        <span key={name}>
          {idx > 0 && ', '}
          <NameLink target={{ kind, name }} onNavigate={onNavigate} />
        </span>
      ))}
      {hidden > 0 && (
        <>
          {' '}
          <button type="button" className={styles.linkButton} onClick={() => setExpanded(true)} data-testid="schema-nav-more">
            {t('records.assistant.schemaNav.more', { count: hidden })}
          </button>
        </>
      )}
      {expanded && cutNames(names).hidden > 0 && (
        <>
          {' '}
          <button type="button" className={styles.linkButton} onClick={() => setExpanded(false)} data-testid="schema-nav-less">
            {t('records.assistant.schemaNav.less')}
          </button>
        </>
      )}
    </span>
  );
}

// Attributes of an element: one line each, "@x (required) — values: a, b".
function AttributeList({ attributes, onNavigate }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const sorted = [...attributes].sort((a, b) => a.name.localeCompare(b.name));
  const { shown, hidden } = cutNames(
    sorted.map((a) => a.name),
    { expanded }
  );
  const byName = new Map(sorted.map((a) => [a.name, a]));
  return (
    <ul className={styles.schemaNavAttributes}>
      {shown.map((name) => {
        const a = byName.get(name);
        return (
          <li key={name}>
            <NameLink target={{ kind: 'attribute', name }} onNavigate={onNavigate} />
            {a.required && ` (${t('records.assistant.schemaFactRequired')})`}
            {a.enum && a.enum.length > 0 && ` — ${t('records.assistant.schemaNav.values')}: ${a.enum.join(', ')}`}
          </li>
        );
      })}
      {hidden > 0 && (
        <li>
          <button type="button" className={styles.linkButton} onClick={() => setExpanded(true)} data-testid="schema-nav-more">
            {t('records.assistant.schemaNav.more', { count: hidden })}
          </button>
        </li>
      )}
    </ul>
  );
}

// Children or attributes of an element, by mode (see elementCardModel).
function KindSection({ title, kindModel, isAttribute, onNavigate, testId }) {
  const { t } = useTranslation();
  const list = (items) =>
    isAttribute ? <AttributeList attributes={items} onNavigate={onNavigate} /> : <NameList names={items} onNavigate={onNavigate} listId={testId} />;
  return (
    <section className={styles.schemaNavSection} data-testid={`schema-nav-${testId}`}>
      <h5>{title}</h5>
      {kindModel.mode === 'none' && <span className={styles.muted}>{t('records.assistant.schemaFactNone')}</span>}
      {kindModel.mode === 'single' && list(kindModel.common)}
      {kindModel.mode === 'common' && (
        <>
          <div className={styles.schemaNavGroupLabel}>{t('records.assistant.schemaNav.inEverySchema')}</div>
          {list(kindModel.common)}
          {kindModel.groups.map((g) => (
            <div key={g.schemas.join(',')} className={styles.schemaNavGroup}>
              <div className={styles.schemaNavGroupLabel}>{t('records.assistant.schemaNav.alsoIn', { schemas: g.schemas.join(', ') })}</div>
              {list(g.items)}
            </div>
          ))}
        </>
      )}
      {kindModel.mode === 'bySchema' && (
        <>
          <div className={styles.schemaNavGroupLabel}>{t('records.assistant.schemaNav.dependsOnSchema')}</div>
          {kindModel.groups.map((g) => (
            <div key={g.schemas.join(',')} className={styles.schemaNavGroup}>
              <div className={styles.schemaNavGroupLabel}>{g.schemas.join(', ')}:</div>
              {g.items.length ? list(g.items) : <span className={styles.muted}>{t('records.assistant.schemaFactNone')}</span>}
            </div>
          ))}
        </>
      )}
    </section>
  );
}

function ElementBody({ entry, onNavigate }) {
  const { t } = useTranslation();
  const model = elementCardModel(entry);
  return (
    <>
      <p className={styles.schemaNavMeta}>
        {model.multiVariant
          ? t('records.assistant.schemaFactDefinedIn', { count: model.schemaCount })
          : `${t('records.assistant.schemaFactSchemas')}: ${model.schemas.join(', ')}`}
      </p>
      <KindSection title={t('records.assistant.schemaNav.children')} kindModel={model.children} onNavigate={onNavigate} testId="children" />
      <section className={styles.schemaNavSection} data-testid="schema-nav-parents">
        <h5>{t('records.assistant.schemaNav.parents')}</h5>
        {model.parents.length ? (
          <NameList names={model.parents} onNavigate={onNavigate} listId="parents" />
        ) : (
          <span className={styles.muted}>{t('records.assistant.schemaNav.rootElement')}</span>
        )}
      </section>
      <KindSection
        title={t('records.assistant.schemaNav.attributes')}
        kindModel={model.attributes}
        isAttribute
        onNavigate={onNavigate}
        testId="attributes"
      />
    </>
  );
}

function AttributeBody({ name, owners, onNavigate }) {
  const { t } = useTranslation();
  const model = attributeCardModel(owners);
  if (!model.exists) return <p className={styles.muted}>{t('records.assistant.schemaNav.attributeNotFound', { name })}</p>;
  const ownersModel = model.owners;
  return (
    <>
      <section className={styles.schemaNavSection} data-testid="schema-nav-values">
        <h5>{t('records.assistant.schemaNav.values')}</h5>
        {model.values.length === 1 ? (
          model.values[0].values ? (
            <span>{model.values[0].values.join(', ')}</span>
          ) : (
            <span className={styles.muted}>{t('records.assistant.schemaNav.noClosedList')}</span>
          )
        ) : (
          model.values.map((g, idx) => (
            <div key={idx} className={styles.schemaNavGroup}>
              <div className={styles.schemaNavGroupLabel}>
                {t('records.assistant.schemaNav.valuesOn')} <NameList names={g.elements} onNavigate={onNavigate} />:
              </div>
              {g.values ? <span>{g.values.join(', ')}</span> : <span className={styles.muted}>{t('records.assistant.schemaNav.noClosedList')}</span>}
            </div>
          ))
        )}
      </section>
      <section className={styles.schemaNavSection} data-testid="schema-nav-owners">
        <h5>{t('records.assistant.schemaNav.owners')}</h5>
        {ownersModel.mode === 'same' && <NameList names={ownersModel.common} onNavigate={onNavigate} listId="owners" />}
        {ownersModel.mode === 'common' && (
          <>
            <div className={styles.schemaNavGroupLabel}>{t('records.assistant.schemaNav.inEverySchema')}</div>
            <NameList names={ownersModel.common} onNavigate={onNavigate} listId="owners" />
            {ownersModel.groups.map((g) => (
              <div key={g.schemas.join(',')} className={styles.schemaNavGroup}>
                <div className={styles.schemaNavGroupLabel}>{t('records.assistant.schemaNav.alsoIn', { schemas: g.schemas.join(', ') })}</div>
                <NameList names={g.items} onNavigate={onNavigate} />
              </div>
            ))}
          </>
        )}
        {ownersModel.mode === 'bySchema' && (
          <>
            <div className={styles.schemaNavGroupLabel}>{t('records.assistant.schemaNav.dependsOnSchema')}</div>
            {ownersModel.groups.map((g) => (
              <div key={g.schemas.join(',')} className={styles.schemaNavGroup}>
                <div className={styles.schemaNavGroupLabel}>{g.schemas.join(', ')}:</div>
                <NameList names={g.items} onNavigate={onNavigate} />
              </div>
            ))}
          </>
        )}
      </section>
    </>
  );
}

export default function SchemaNavCard({ nav, standard }) {
  const { t } = useTranslation();
  const cardRef = useRef(null);
  const [position, setPosition] = useState(null);
  const [copyState, setCopyState] = useState(null);
  const { isOpen, anchor, target, card, stack } = nav;

  useLayoutEffect(() => {
    if (!isOpen) return undefined;
    const update = () => setPosition(cardPosition(anchor));
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [isOpen, anchor]);

  // Focus on open; Esc closes like Cerrar.
  useEffect(() => {
    if (!isOpen) return undefined;
    cardRef.current?.focus();
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        nav.close();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // nav.close is recreated every render; the listener only needs the open state.
  }, [isOpen]);

  // The "copied" note belongs to the card on screen.
  const key = target ? targetKey(target) : null;
  useEffect(() => setCopyState(null), [key]);

  if (!isOpen || !target || !position) return null;

  const copyName = async () => {
    try {
      await navigator.clipboard.writeText(targetLabel(target));
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
  };

  const status = card?.status || 'loading';
  return (
    <div
      ref={cardRef}
      className={styles.schemaNavCard}
      style={position}
      role="dialog"
      aria-label={t('records.assistant.schemaNav.dialogLabel', { name: targetLabel(target), standard })}
      tabIndex={-1}
      data-testid="schema-nav-card"
    >
      <div className={styles.schemaNavHeader}>
        <nav className={styles.schemaNavCrumbs} aria-label={t('records.assistant.schemaNav.breadcrumb')} data-testid="schema-nav-breadcrumb">
          {stack.map((crumb, idx) => (
            <span key={`${targetKey(crumb)}-${idx}`}>
              {idx > 0 && <span className={styles.schemaNavCrumbSep}> › </span>}
              {idx === stack.length - 1 ? (
                <strong aria-current="page">{crumbLabel(crumb)}</strong>
              ) : (
                <button type="button" className={styles.linkButton} onClick={() => nav.goTo(idx)}>
                  {crumbLabel(crumb)}
                </button>
              )}
            </span>
          ))}
        </nav>
        <div className={styles.schemaNavActions}>
          {stack.length > 1 && (
            <button type="button" className={styles.linkButton} onClick={nav.back} data-testid="schema-nav-back">
              {t('records.assistant.schemaNav.back')}
            </button>
          )}
          <button type="button" className={styles.linkButton} onClick={copyName} data-testid="schema-nav-copy">
            {t('records.assistant.schemaNav.copyName')}
          </button>
          <button type="button" className={styles.linkButton} onClick={nav.close} data-testid="schema-nav-close">
            {t('records.assistant.schemaNav.close')}
          </button>
        </div>
      </div>
      {copyState && (
        <p className={copyState === 'copied' ? styles.muted : styles.vocabWarning} data-testid="schema-nav-copy-state" role="status">
          {copyState === 'copied'
            ? t('records.assistant.schemaNav.copied', { name: targetLabel(target) })
            : t('records.assistant.schemaNav.copyFailed')}
        </p>
      )}
      <h4 className={styles.schemaNavTitle} data-testid="schema-nav-title">
        <code>{targetLabel(target)}</code>
      </h4>
      <div className={styles.schemaNavBody}>
        {status === 'loading' && (
          <p className={styles.muted} data-testid="schema-nav-loading">
            {t('records.assistant.schemaNav.loading')}
          </p>
        )}
        {status === 'error' && (
          <div className={styles.vocabWarning} role="alert" data-testid="schema-nav-error">
            {t('records.assistant.schemaNav.loadFailed', {
              error: card.error === 'timeout' ? t('records.assistant.schemaNav.timeout') : card.error,
            })}{' '}
            <button type="button" className={styles.linkButton} onClick={nav.retry} data-testid="schema-nav-retry">
              {t('records.assistant.schemaNav.retry')}
            </button>
          </div>
        )}
        {status === 'unavailable' && <p className={styles.muted}>{t('records.assistant.schemaNav.unavailable', { standard })}</p>}
        {status === 'ready' && target.kind === 'element' && card.data.missing && (
          <p className={styles.muted}>{t('records.assistant.schemaNav.elementNotFound', { name: target.name, standard })}</p>
        )}
        {status === 'ready' && target.kind === 'element' && card.data.entry && (
          <ElementBody key={key} entry={card.data.entry} onNavigate={nav.navigate} />
        )}
        {status === 'ready' && target.kind === 'attribute' && (
          <AttributeBody key={key} name={target.name} owners={card.data.owners} onNavigate={nav.navigate} />
        )}
      </div>
    </div>
  );
}
