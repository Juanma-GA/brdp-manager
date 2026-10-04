import { useTranslation } from 'react-i18next';
import { catalogEditionLabel, catalogEditionTitle } from '../utils/catalogEdition.js';
import styles from '../pages/RecordsPage.module.css';

// Small label next to a BRDP identifier: the other S1000D edition whose
// catalog has it ("4.1"), with the full explanation on hover. Not part of
// the identifier. Renders nothing when the BRDP has no catalog_edition.
export default function CatalogEditionTag({ edition, standard }) {
  const { t } = useTranslation();
  if (!edition) return null;
  const title = catalogEditionTitle(t, edition, standard);
  return (
    <span className={styles.catalogEditionTag} title={title} aria-label={title} data-testid="catalog-edition-tag">
      {catalogEditionLabel(edition)}
    </span>
  );
}
