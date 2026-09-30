import { useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { schemaSuggestions, targetKey, targetLabel } from '../../utils/schemaNavigation.js';
import styles from '../../pages/RecordsPage.module.css';

// "Buscador del esquema" in the Ask header: suggestions from the project's
// schema vocabulary (utils/schemaNavigation.js's schemaSuggestions -- the
// same vocabulary that decides which names in an answer are links); choosing
// one opens the floating schema card (SchemaNavCard) on that name, with a new
// breadcrumb. Nothing is added to the Ask thread and no AI is called.
// Keyboard: ↑/↓ move through the suggestions, Enter opens the highlighted
// one, Esc closes the list (with the list closed, Esc is the card's).
export default function SchemaSearch({ vocabulary, standard, onOpen }) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [listOpen, setListOpen] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef(null);
  const listId = useId();
  const { items, noMatch } = schemaSuggestions(text, vocabulary);
  const showList = listOpen && items.length > 0;
  const activeIndex = Math.min(active, Math.max(items.length - 1, 0));

  const choose = (item) => {
    setListOpen(false);
    onOpen(item, inputRef.current);
  };

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!items.length) return;
      e.preventDefault();
      if (!listOpen) {
        setListOpen(true);
        setActive(0);
        return;
      }
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActive((activeIndex + step + items.length) % items.length);
    } else if (e.key === 'Enter') {
      if (showList) {
        e.preventDefault();
        choose(items[activeIndex]);
      }
    } else if (e.key === 'Escape' && listOpen) {
      // Only the list: the open card (if any) stays.
      e.preventDefault();
      e.stopPropagation();
      setListOpen(false);
    }
  };

  const unavailable = !vocabulary;
  return (
    <div className={styles.schemaSearch}>
      <input
        ref={inputRef}
        type="search"
        className={styles.schemaSearchInput}
        value={text}
        placeholder={t('records.assistant.schemaSearch.placeholder')}
        aria-label={t('records.assistant.schemaSearch.label', { standard })}
        title={unavailable ? t('records.assistant.vocabCheckUnavailable', { standard }) : undefined}
        disabled={unavailable}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={showList}
        aria-controls={listId}
        aria-activedescendant={showList ? `${listId}-${activeIndex}` : undefined}
        onChange={(e) => {
          setText(e.target.value);
          setListOpen(true);
          setActive(0);
        }}
        onKeyDown={onKeyDown}
        // A click reopens the list; focus alone does not (focus comes back
        // here when the card closes, and the list should not pop up then).
        onClick={() => setListOpen(true)}
        onBlur={() => setListOpen(false)}
        data-testid="schema-search-input"
      />
      {showList && (
        <ul id={listId} role="listbox" className={styles.schemaSearchList} data-testid="schema-search-list">
          {items.map((item, idx) => (
            <li
              key={targetKey(item)}
              id={`${listId}-${idx}`}
              role="option"
              aria-selected={idx === activeIndex}
              className={idx === activeIndex ? styles.schemaSearchOptionActive : styles.schemaSearchOption}
              // Keep the focus in the box: a blur would close the list first.
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(idx)}
              onClick={() => choose(item)}
              data-testid={`schema-search-option-${targetKey(item)}`}
            >
              <code>{targetLabel(item)}</code>
              <span className={styles.schemaSearchKind}>
                {t(item.kind === 'attribute' ? 'records.assistant.schemaSearch.attribute' : 'records.assistant.schemaSearch.element')}
              </span>
            </li>
          ))}
        </ul>
      )}
      {listOpen && noMatch && (
        <div className={styles.schemaSearchNoMatch} role="status" data-testid="schema-search-no-match">
          {t('records.assistant.schemaSearch.noMatch', { standard })}
        </div>
      )}
    </div>
  );
}
