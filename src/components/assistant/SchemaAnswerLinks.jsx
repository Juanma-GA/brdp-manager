import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { targetKey, targetLabel } from '../../utils/schemaNavigation.js';
import styles from '../../pages/RecordsPage.module.css';

// "Nombres navegables" / "+N más desplegable": the links inside an answer
// taken from the schema. A name opens the floating schema card; a "+N more"
// expands the names its list cut, in place, each one a link as well.

export function SchemaNameLink({ target, onOpen }) {
  return (
    <button
      type="button"
      className={styles.schemaNameLink}
      onClick={(e) => onOpen(target, e.currentTarget)}
      data-testid={`schema-link-${targetKey(target)}`}
    >
      <code>{targetLabel(target)}</code>
    </button>
  );
}

// `cut` = { id, kind, hidden } (utils/structuralAnswer.js's cutList), placed
// right after the list's last shown name. Every
// list keeps its own state; a new answer remounts the whole answer, so all
// lists start folded again. A name the vocabulary does not have (never the
// case for names taken from the schema) stays plain text.
export function AnswerMoreNames({ cut, vocabulary, onOpen }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  if (!expanded) {
    return (
      <>
        {' '}
        <button
          type="button"
          className={styles.linkButton}
          onClick={() => setExpanded(true)}
          data-testid={`answer-more-${cut.id}`}
        >
          {t('records.assistant.schemaNav.more', { count: cut.hidden.length })}
        </button>
      </>
    );
  }
  const known = cut.kind === 'attribute' ? vocabulary?.attributes : vocabulary?.elements;
  return (
    <span data-testid={`answer-more-list-${cut.id}`}>
      {cut.hidden.map((name) => {
        const target = { kind: cut.kind, name };
        return (
          <span key={name}>
            {', '}
            {known?.has(name) ? <SchemaNameLink target={target} onOpen={onOpen} /> : <code>{targetLabel(target)}</code>}
          </span>
        );
      })}{' '}
      <button
        type="button"
        className={styles.linkButton}
        onClick={() => setExpanded(false)}
        data-testid={`answer-less-${cut.id}`}
      >
        {t('records.assistant.schemaNav.less')}
      </button>
    </span>
  );
}
