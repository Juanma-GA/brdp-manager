# Código sin uso: registro del borrado (Barrido final 4)

El inventario de la Consolidación C2 (Parte 2) listaba el código de v1 y los restos sin uso de v2. En el Barrido final 4 se borró. Este fichero queda como registro: qué se borró, en qué commit y qué se conservó y por qué.

Ninguna pieza borrada tenía relación con el login: la autenticación de v2 (JWT, `backend/app/api/routes/auth.py`) está viva y v1 no tenía.

## Borrado

| Qué | Commit |
|---|---|
| Cadena del chat de v1: `ChatPanel.jsx`, `TypingDots.jsx` (con su CSS), `useChat.js`, `generateSuggestedRule.js`; `sendMessageStream` y `buildSystemPrompt` de `llmAPI.js` | `32e297e` |
| Caminos LLM muertos de los generadores (`buildBREXPromptChunk*`, `generateSingleRule*`, `extractXML`, `escapeXMLContent*`, `splitMultipleObjectPaths*`; en DITA `STRICT_RULES`, `buildSchematronPrompt`, `buildFewShotBlock`, `processChunkResponse` y sus ayudantes); la clave `few_shot_examples` de los cuatro `public/*-schema-summary*.json`; `public/brex-schema-summary-sch.json` (sus 16 URL master reales pasan a `scripts/rule-test-fixtures/master-schema-urls-3-0-1.json`, que es lo único que usaba un test); `scripts/test-schematron-dita.mjs` | `1f8ecd1` |
| `useAPIKey.js` y `AIConfigSection.jsx` (guardaban la clave del proveedor en `localStorage`) | `f1f7901` |
| Páginas, componentes, hooks, contextos y datos de v1: `BRDPPage`, `DetailPanel`, `BRDPTable`, `FilterPills`, `SearchBar`, `RuleApprovalCell`, `GenerateModal`, `BREXdocModal`, `AboutSection`, `ProjectConfigSection`, `ResetDataSection`, `ToastContainer` (todos con su CSS), `useTableLogic`, `useBRDPs`, `useLocalNotes`, `useProjectConfig`, `BRDPContext`, `ToastContext`, `validateBREX.js`, `brdpSchema.js`, `mockBRDPs.js`, `services/api.js` | `dc4e1c5` |
| `server.js` (Express + SQLite), `src/db/`, el script `npm start`, las dependencias `express`, `cors`, `better-sqlite3`, `win-ca` y `dotenv` (esta última sin ningún import), el proxy `/mistral-proxy` de `vite.config.ts` y `src/api/approvals.js` (los generadores exigen ahora las aprobaciones del proyecto; su carga por defecto apuntaba a una ruta de Express que v2 nunca tuvo) | `2752ec3` |
| Export `useInvalidateEmbeddingJob` | `b6f9309` |
| Notas por BRDP del backend: `routes/notes.py`, modelo, esquema, la tabla (migración nueva `0024_drop_notes.py`) y sus tests | `385d655` |
| Detectores (knip y vulture): 53 exports que solo usaba su propio módulo dejan de exportarse; `autoprefixer` (devDependency sin uso); `CLASSIFICATIONS` y `TEXT_SOURCES` en `rule_extract_jobs.py`; tres constantes y un contador sin uso en `backend/scripts/generate_schema_cards.py` | `c006f29` |

## Conservado, y por qué

- (Borradas en la Limpieza, `9a64e12`: las ramas few-shot de `buildDeterministicBlockFromFewShot`, ahora `approvedRuleBlock`, y las claves `structure`/`generation_rules` de `public/brex-schema-summary-*.json`.)
- `src/api/llmAPI.js` (`sendMessage`), `mammoth` y `pdfjs-dist`: vivos (Ask, Suggest, test de reglas, AI Extract; lectura de .docx/.pdf).
- Exports usados solo por los tests de `scripts/` (p. ej. `answerNameCheckHasWarnings`, `ENGINE_REASON_CODES`): la convención del repo es exportar para poder probar desde Node.
- Endpoints de backend: todos tienen al menos un llamador en `src/` (las notas y, en la Limpieza, `DELETE …/approvals/{format}` no lo tenían y se retiraron).
- `backend/scripts/*`: herramientas de operación, generación de datos y verificación; no forman parte de la app.
- `@xmldom/xmldom` y `jszip`: los usan scripts de `scripts/` sin estar en `package.json` (llegan como dependencias de `mammoth`). No es código muerto; queda anotado.
