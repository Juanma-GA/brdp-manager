# Inventario de código sin uso (Consolidación C2, Parte 2)

Solo inventario: **no se borra nada en este encargo**. Una parte de este código se reutilizará para AI Extract.

## Cómo se ha obtenido

**Frontend**
- Grafo de imports desde `src/main.jsx`, siguiendo todo `import … from`, `import()` y `export … from` relativos. Un fichero no alcanzable desde ahí no se carga nunca en la app.
- Para cada `export` de los ficheros alcanzables, búsqueda de su nombre en el resto de `src/` y en `scripts/`.

**Backend**
- `ast` sobre `backend/app`: funciones y clases de primer nivel que no se usan en ningún otro sitio de `app/`. No hay ninguna, descontando los handlers de rutas registrados por decorador.
- Para cada endpoint de `app/api/routes/*.py`, búsqueda de su ruta en `src/`.

**Columnas de las tablas**
- **Quién lo importa**: `nadie`, o solo código que a su vez no se usa.
- **Versión**:
  - v1: app Express + SQLite de un solo proyecto (`server.js`, `src/services/api.js`, `BRDPPage`).
  - v2: FastAPI + Postgres, multiproyecto.
- **Reutilización prevista**:
  - AI Extract;
  - login/Keycloak;
  - otra;
  - ninguna.
- **Recomendación**:
  - *mantener para AI Extract*;
  - *borrar en el barrido final*;
  - *revisar*.

Ninguna pieza sin uso tiene relación con **login/Keycloak**. La autenticación de v2 (JWT en `backend/app/api/routes/auth.py`, `ChangePasswordForm.jsx`, `ForceChangePasswordPage.jsx`) está viva. v1 no tenía autenticación, así que no hay nada de v1 que un futuro Keycloak pudiera aprovechar.

---

## 1. Cadena del chat antiguo (v1): `ChatPanel.jsx` → `useChat.js` → `generateSuggestedRule.js`

Sustituida por Ask y los Suggest de v2:
- `useAskAssistant.js`;
- `useSuggestions.js`;
- `src/prompts/*`.

| Fichero / export | Quién lo importa | Versión | Reutilización | Recomendación |
|---|---|---|---|---|
| `src/components/ChatPanel.jsx` (+ `ChatPanel.module.css`) | nadie | v1 | ninguna | borrar en el barrido final |
| `src/components/TypingDots.jsx` (+ CSS) | solo `ChatPanel.jsx` | v1 | ninguna | borrar en el barrido final |
| `src/hooks/useChat.js` | nadie | v1 | ninguna | borrar en el barrido final |
| `src/api/generateSuggestedRule.js` | solo `useChat.js` | v1 | ninguna. Suggest Rule de v2 usa `suggestRulePrompt.js` + `ruleFormatRules.js`. | borrar en el barrido final |
| `llmAPI.js` → `sendMessageStream` | solo `useChat.js` | v1 (adaptado a `/api/llm-proxy`) | ninguna | borrar en el barrido final (el fichero se queda: `sendMessage` está vivo) |
| `llmAPI.js` → `buildSystemPrompt` (export) | nadie. Tiene bugs conocidos: `comment`/`comments` y el UUID en vez del identificador (ver CLAUDE.md, Ask). | v1 | ninguna | borrar en el barrido final |

## 2. Prompts de los generadores y `generateSingleRule*`

**Confirmado: Generate ya no llama al LLM.**
- `generateBREX()`, `generateBREX41()`, `generateBREX301()` y `generateSchematronDITA()` son ensambladores deterministas.
- Inyectan tal cual el `rule_xml` de las filas `approved` y dejan un comentario `pendingApprovalComment` para las demás. Ver el comentario sobre `generateBREX()` en `generateBREX.js`.
- `generateBREXSch()` convierte ese BREX con `brexToSchematron()`, sin LLM.

**`src/prompts/ruleFormatRules.js` es la única fuente viva de reglas de formato.**
- La usa Suggest Rule (`suggestRulePrompt.js`).
- Sus únicas referencias a `buildBREXPromptChunk*` son comentarios que explican de dónde se copiaron las reglas.

Todo lo que sigue solo lo alcanza `generateSuggestedRule.js` (sección 1):

| Fichero / export | Quién lo usa | Versión | Reutilización | Recomendación |
|---|---|---|---|---|
| `generateBREX.js` → `buildBREXPromptChunk`, `generateSingleRule`, `extractXML`, y las internas `escapeXMLContent` y `splitMultipleObjectPaths` | `generateSuggestedRule.js`. `extractXML` también lo importan `generateBREX41.js` y `generateSchematronDITA.js`, pero solo desde sus `generateSingleRule*`. | v1 (prompt LLM de Generate) | ninguna | borrar en el barrido final. **No** borrar `parseRuleFragment`: lo usa `assembleChunks` (vivo). |
| `generateBREX41.js` → `buildBREXPromptChunk41`, `generateSingleRule41`, internas `escapeXMLContent41` y `splitMultipleObjectPaths41` | `generateSuggestedRule.js` | v1 | ninguna | borrar en el barrido final. `loadSchemaSummary41` se queda: la usa `generateBREX41()`. |
| `generateBREX301.js` → `buildBREXPromptChunk301`, `generateSingleRule301`, internas `escapeXMLContent301` y `splitMultipleObjPaths301` | `generateSuggestedRule.js` | v1 | ninguna | borrar en el barrido final. `sanitizeNonContextComments301` se queda: la usa `assembleChunks301` (vivo). |
| `generateSchematronDITA.js` → `STRICT_RULES`, `buildSchematronPrompt`, `buildFewShotBlock`, `generateSingleRule`, `processChunkResponse`, `extractPatternBlocks`, `extractTraceabilityComments`, `extractCheckIds`, `extractCommentedIds`, `idCoversBRDP` | `generateSuggestedRule.js`. (El script `test-schematron-dita-lets.mjs`, que también lo usaba, se borró en C3: probaba este camino muerto y un camino por id curado de `generateSchematronDITA()` que ya no existe.) | v1 (camino LLM de DITA) | ninguna | borrar en el barrido final, junto con `scripts/test-schematron-dita.mjs`, que solo prueba este prompt. **No** borrar `buildDeterministicBlockFromFewShot`, `renderSchLets`, `renderMessage`, `escapeXmlText` ni `sanitizeForXmlComment`: las usa el ensamblado vivo (el nombre `…FromFewShot` es histórico; hoy renderiza una fila aprobada). |
| `few_shot_examples` en `public/brex-schema-summary-4-2.json`, `-4-1.json`, `-3-0-1.json` y `public/schematron-dita-schema-summary.json` | solo los constructores de prompt de esta tabla | v1 | ninguna | borrar la clave en el barrido final. El resto de cada JSON (cabeceras, `sch_header`, vocabulario) lo usa Generate. |
| `public/brex-schema-summary-sch.json` | nadie (solo un comentario de `ruleSchemaContext.js` que cita su contenido como fuente de las URL master) | v1 | ninguna | revisar: el dato citado (las 16 URL master de `BRDP-A1-00100`) ya está en `scripts/test-rule-schema-context.mjs`. Si se confirma, borrar. |

## 3. `useAPIKey.js` y la configuración de IA en el navegador

| Fichero / export | Quién lo importa | Versión | Reutilización | Recomendación |
|---|---|---|---|---|
| `src/hooks/useAPIKey.js` | nadie | v1: guarda API key, modelo y proveedor en `localStorage` y en `/api/settings` de Express | ninguna. En v2 la clave vive en el servidor (`/api/llm-proxy`, `GET /api/config/ai-provider`). | borrar en el barrido final. Es uno de los hallazgos HR1 de la auditoría AACF de CLAUDE.md. |
| `src/components/AIConfigSection.jsx` (+ CSS) | nadie | v1 (pantalla de Settings) | ninguna | borrar en el barrido final |

## 4. AI Extract

| Fichero / export | Quién lo importa | Versión | Reutilización | Recomendación |
|---|---|---|---|---|
| `src/components/AIExtractModal/AIExtractModal.jsx` (+ CSS) | nadie | v1 | **AI Extract** | mantener para AI Extract. **Al reutilizarlo**, quitar la lectura de `brdp_api_key`, `brdp_provider` y demás de `localStorage` (HR1) y usar el proveedor del servidor, como Ask. |
| `src/api/extractBRDPs.js` y sus exports `extractTextFromDOCX`, `extractTextFromPDF`, `extractTextFromFile`, `generateIds` | `AIExtractModal.jsx` | v1 con transporte v2: llama a `sendMessage` → `/api/llm-proxy` | **AI Extract** | mantener para AI Extract. `generateIds` crea ids `BRDP-EXT-NNNNN` en el cliente; v2 ya tiene `GET …/brdps/next-ext-identifier`, así que **revisar** al reutilizar. |
| `src/api/llmAPI.js` → `sendMessage` | vivo (Ask, Suggest, test de reglas) | v2 | AI Extract también | mantener |
| Dependencias `mammoth` y `pdfjs-dist` | `extractBRDPs.js` | — | **AI Extract** | mantener |

## 5. Páginas y componentes de v1 (`BRDPPage` y compañía)

| Fichero / export | Quién lo importa | Versión | Reutilización | Recomendación |
|---|---|---|---|---|
| `src/pages/BRDPPage.jsx` (+ CSS) | nadie: no tiene ruta en `App.jsx` | v1 | ninguna. `RecordsPage.jsx` la sustituye. | borrar en el barrido final |
| `src/components/DetailPanel.jsx` (+ CSS) | solo `BRDPPage.jsx` | v1 | ninguna | borrar en el barrido final |
| `src/components/BRDPTable.jsx`, `FilterPills.jsx`, `SearchBar.jsx` (+ CSS) | solo `BRDPPage.jsx` | v1 | ninguna | borrar en el barrido final |
| `src/components/RuleApprovalCell.jsx` | solo `BRDPTable.jsx` y `DetailPanel.jsx` | v1 | ninguna (v2: `RuleStatusStepper`/`RuleStatusCell`) | borrar en el barrido final |
| `src/hooks/useTableLogic.js` | solo `BRDPPage.jsx` | v1 | ninguna | borrar en el barrido final |
| `src/hooks/useBRDPs.js` | nadie | v1 | ninguna | borrar en el barrido final |
| `src/hooks/useLocalNotes.js` | solo `DetailPanel.jsx` | v1 (`/api/notes/:id` de Express + `localStorage`) | ninguna (ver sección 7: notas) | borrar en el barrido final |
| `src/hooks/useProjectConfig.js` | `BRDPPage.jsx`, `GenerateModal.jsx`, `ProjectConfigSection.jsx` | v1 | ninguna | borrar en el barrido final |
| `src/context/BRDPContext.jsx` (`BRDPProvider`) | solo código v1 (`ChatPanel`, `DetailPanel`, `RuleApprovalCell`, `useChat`, `BRDPPage`). Ningún `Provider` la monta en `App.jsx`. | v1 | ninguna | borrar en el barrido final |
| `src/context/ToastContext.jsx` (`ToastProvider`), `src/components/ToastContainer.jsx` | solo los hooks v1 anteriores; nadie monta el provider | v1 | ninguna | borrar en el barrido final |
| `src/components/GenerateModal.jsx` (+ CSS) | nadie | v1 (v2: `GeneratePage.jsx`) | ninguna | borrar en el barrido final |
| `src/api/validateBREX.js` | solo `GenerateModal.jsx`. `GeneratePage.jsx` llama a `/api/validate-brex` directamente. | v1 | ninguna | borrar en el barrido final |
| `src/components/BREXdocModal/BREXdocModal.jsx` (+ CSS) | nadie (ya anotado en CLAUDE.md) | v1 (v2: `GenerateBREXdocPage.jsx`) | ninguna | borrar en el barrido final |
| `src/components/AboutSection.jsx`, `ProjectConfigSection.jsx`, `ResetDataSection.jsx` (+ CSS) | nadie | v1 (pantalla de Settings) | ninguna. En v2 la gestión de datos vive en `ProjectConfigPage.jsx`. `DataManagementSection.jsx` (+ CSS) ya se borró al pasar el Excel al backend. | borrar en el barrido final |
| `src/data/brdpSchema.js` (`BRDP_FIELDS`) | nadie | v1 | ninguna | borrar en el barrido final |
| `src/data/mockBRDPs.js` | solo v1: `BRDPContext`, `useBRDPs` y `ResetDataSection`. La plantilla genérica de S1000D 5.0/6.0 la genera ahora el backend (`GET /api/brdp-template.xlsx`, filas copiadas a `backend/app/services/generic_template_rows.json`). | v1 | ninguna | borrar en el barrido final |
| `src/services/api.js` | solo código v1 (`BRDPContext`, `useAPIKey`, `useBRDPs`, `useLocalNotes`, `useProjectConfig`). Llama a `/api/brdps`, `/api/config`, `/api/settings` y `/api/notes` de Express. | v1 | ninguna | borrar en el barrido final. `src/services/apiClient.js` (v2, `authFetch`) está vivo. |
| `src/db/database.js`, `src/db/schema.sql` | solo `server.js` | v1 (SQLite) | ninguna | borrar junto con `server.js` en el barrido final (sección 6, decidido en C3) |

## 6. Piezas de v1 fuera de `src/`

| Pieza | Uso | Versión | Reutilización | Recomendación |
|---|---|---|---|---|
| `server.js` (Express + SQLite + `/api/proxy` + `/api/validate-brex` + estáticos de `dist/`) y el script `npm start` | ningún código de v2 depende de él. El frontend v2 habla con FastAPI (en desarrollo, a través del proxy `/api` de `vite.config.js` al puerto 8000). | v1 | ninguna | **Decidido (Juanma, C3): se borra en el barrido final** -- v2 lo servirá nginx. Con él se van `src/db/`, las dependencias `express`, `cors`, `better-sqlite3` y `win-ca`, el script `npm start` y las notas de entorno de CLAUDE.md sobre `better-sqlite3` y `win-ca`. Aquí no se borra nada. |
| Proxy `'/mistral-proxy'` en `vite.config.js` | nada en `src/` lo llama (`llmAPI.js` usa `/api/llm-proxy`) | v1 | ninguna | borrar en el barrido final. Además expone un endpoint de Mistral en la configuración del repo. |
| `src/api/approvals.js` | `generateSchematronDITA.js`, `generateBREX*.js` (su `fetchApprovalsMap`), `RuleApprovalCell` y `ChatPanel`. Llama a `/api/approvals/…` de **Express**, que no existe en FastAPI. | v1 | ninguna | **revisar**: en v2 los generadores reciben siempre `approvals` desde `GeneratePage.jsx`, así que su `fetchApprovalsMap` por defecto (que usa este fichero) solo se ejecutaría si alguien llamara al generador sin ese parámetro, y entonces fallaría contra v2. Al borrar lo de v1, hacer que `approvals` sea obligatorio y quitar este fichero. |

## 7. Exports sin uso dentro de módulos vivos

| Export | Quién lo usa | Versión | Recomendación |
|---|---|---|---|
| `useEmbeddingJob.js` → `useInvalidateEmbeddingJob` | nadie | v2 | borrar en el barrido final |
| `schemaValidation.js` → `answerNameCheckHasWarnings`; `ruleTestReasons.js` → `ENGINE_REASON_CODES`, `VERDICT_REASON_CODES` | solo scripts de test | v2 | mantener (los tests los usan para comprobar que toda clave tiene texto). |
| Varios exports de `src/utils` y `src/prompts` usados solo dentro de su fichero y por los tests (`detectStructuralQuestion`, `extractXPathNames`, `SCHEMA_ISSUE_KEYS`, `ruleDependsOnTitle`, `missesRuleProblem`…) | uso interno + tests | v2 | mantener: se exportan para poder probarlos desde Node, que es la convención del repo. |

## 8. Backend

| Pieza | Uso desde el frontend v2 | Recomendación |
|---|---|---|
| Funciones y clases de `backend/app` | todas se usan en algún sitio de `app/` (ninguna sin referencias) | — |
| `GET/PUT /api/projects/{id}/brdps/{id}/notes` (`routes/notes.py`, modelo de notas) | **ninguna llamada** en `src/`: la interfaz v2 no muestra notas. Solo `test_brdps_notes_approvals.py` lo ejercita. | **Decidido (Juanma, C3): las notas se retiran en el barrido final** -- la ruta (`routes/notes.py`), el modelo, el esquema, la tabla (con una migración que la elimine) y sus tests. Aquí no se borra nada. |
| El resto de endpoints: auth, users, projects, brdps, import, approvals, `/test`, trash, catalog, embeddings, similar, suggestion-feedback, llm-proxy, config, schema-cards (+ `attribute`, `relation`, `structure`), validate-brex | todos con al menos un llamador en `src/` | — |
| `backend/scripts/*`: `create_admin_user`, `generate_rsa_keypair`, `import_brdp_catalog`, `enrich_dita_catalog`, `generate_schema_*`, `dump_*`, `seed_*`, `verify_similar_tests_survive_full_catalog` | herramientas de operación, de generación de datos o de verificación; no forman parte de la app | mantener |
