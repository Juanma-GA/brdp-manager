# CLAUDE.md — Contexto para Claude Code

Este fichero describe la arquitectura y patrones del proyecto para que Claude Code tenga contexto completo antes de hacer cualquier cambio.

## ⚠️ El AACF (framework ATEXIS) tiene prioridad sobre este fichero

Este proyecto está sujeto al **ATEXIS AI-Assisted Coding Framework (AACF)** (repo `Juanma-GA/cursoFSD`, carpeta `Proyecto-CCMS-Nav/aacf/`; copia local leída el 2026-09-18, `aacf/VERSION = 2.0.1`). **Donde el AACF y este `CLAUDE.md` entren en conflicto, gana el AACF** — este fichero se corrige para reflejarlo, nunca al revés.

- **Hard Rules HR0–HR21** (`aacf/rules/atexis-hard-rules.md`) son no negociables — autocomprobar cualquier cambio contra ellas antes de darlo por terminado (ver también `aacf/agents/code-reviewer.agent.md` y `security-reviewer.agent.md` para el criterio de revisión). Resumen relevante para este proyecto: HR1 (nunca localStorage/sessionStorage para estado autoritativo — Postgres es la fuente de verdad), HR6 (nunca truncar contenido de calidad, resumir con LLM), HR7 (nunca un fallback que degrade silenciosamente, escalar), HR8 (nada hardcodeado), HR9 (soft-delete / confirmación explícita antes de borrar), HR10 (deep-merge, nunca shallow-merge de config anidada), HR15/HR21 (i18n + humanizar texto de UI, nunca tokens crudos), HR20 (UI de mutación optimista).
- El framework se sirve normalmente vía el MCP `aacf_fetch` (`http://10.117.139.1:8200/mcp`, solo red corporativa/VPN); esa herramienta **no está disponible en este entorno de ejecución remoto**, así que se trabaja con la copia local del repo `cursoFSD` — puede estar desactualizada. Verificar `aacf/VERSION` contra el MCP en cuanto haya acceso, y no mezclar ficheros de versiones distintas del framework si difiere.
- **Conflicto HR1 resuelto** (Barrido final 4): el patrón "Hooks de datos" de v1 (localStorage como caché de estado autoritativo) y los ficheros que lo usaban se han borrado. Ver "Auditoría de cumplimiento AACF" al final de este fichero.

## ⚠️ Rama actual: `v2-multiproyecto` — backend real distinto al descrito abajo

El trabajo activo vive en la rama `v2-multiproyecto`. La app v1 (Express + SQLite, sin auth, un solo proyecto) se borró del repo en el Barrido final 4; lo que queda de este fichero describe v2:

- **Backend real**: `backend/` — FastAPI + Postgres (`asyncpg` + SQLAlchemy async) + Alembic (`backend/alembic/versions/`, 24 migraciones a fecha de hoy). El frontend es Vite/React.
- **Multi-proyecto real** con auth JWT: access token en el body de `/api/auth/login`, refresh token en cookie HttpOnly (nunca localStorage — ver `backend/app/api/routes/auth.py`). Roles `admin` / `editor` / `viewer` por proyecto vía `UserProjectRole` (`backend/app/models/user_project_role.py`) — un admin global puede todo, un editor solo en sus proyectos.
- **Estructura backend**: `backend/app/models/*` (BRDP, Project, User, UserProjectRole, RuleApproval, BRDPHistory, BRDPCatalog, ImportJob, EmbeddingJob, RuleExtractJob, RefreshToken…), `backend/app/api/routes/*` (un fichero por recurso: `projects.py`, `brdps.py`, `approvals.py`, `brdp_import.py`, `trash.py`, `brdp_catalog.py`, `auth.py`, `users.py`, `similar.py`, `suggestion_feedback.py`, `llm_proxy.py`, `config.py`, `validate_brex.py`, `schema_cards.py`, `rule_extract.py`, `embedding_jobs.py`, `excel.py`, `brdp_compare.py`), `backend/app/services/*` (`import_jobs.py`, `embeddings.py`, `history.py`, `rule_formats.py`), `backend/app/repositories/brdp_repository.py` (capa de acceso a BRDP — todas las queries pasan por aquí, incluido el filtro de soft-delete `ACTIVE_BRDP_FILTER`).
- **Soft-delete real**: borrar una BRDP la manda a Papelera (`deleted_at`/`deleted_by`), no la elimina. Borrado permanente vía `/api/trash/{id}` (admin, o editor si es de su proyecto).
- **Import de Excel** (`backend/app/services/import_jobs.py` + `backend/app/schemas/brdp_import.py`) es un job asíncrono en background (`BackgroundTasks`, no bloqueante): `/import/analyze` (fase 1, solo lectura, devuelve avisos) → `/import/apply` (fase 2, devuelve `job_id`, se sondea `/import/status/{job_id}`). Un `running` job antiguo (>60 min, `STALE_JOB_MINUTES`) se marca `failed` automáticamente al leerlo (`_reap_if_stale`) — cubre crashes; una interrupción limpia (`asyncio.CancelledError`, p.ej. un `--reload` de uvicorn) tiene su propio handler explícito porque `CancelledError` hereda de `BaseException`, no de `Exception`, desde Python 3.8.
- **Documentación de diseño original** (útil como contexto histórico, pero YA DESACTUALIZADA frente al código real tras ~106 rondas de iteración — no la trates como fuente de verdad, el código y los tests son la fuente de verdad): `docs/v2/01-arquitectura-y-estructura.md` (snapshot de v1, la base de la decisión de reescribir), `docs/v2/02-analisis-aacf-requisitos-no-cumplidos.md`, `docs/v2/03-especificacion-v2-para-claude-code.md` (spec original de v2).

**Instalación en servidor (producción, sin Docker) y migración de datos**: guías para IT en [`docs/instalacion/`](docs/instalacion/README.md) (Ubuntu/Debian, RHEL 9, Windows Server, y paso de la base de Docker al servidor). Si cambia algo que afecta al despliegue (variables de `backend/app/core/config.py`, scripts de `backend/scripts/`, requisitos del proxy, versiones), actualízalas.

### Cómo levantar el entorno de desarrollo real (v2)

```bash
service postgresql start   # o `service postgresql status` si ya está arrancado
cd backend && source .venv/bin/activate && uvicorn app.main:app --host 0.0.0.0 --port 8000   # backend, puerto 8000
cd /home/user/brdp-manager && npx vite --port 5173 --strictPort                              # frontend, puerto 5173
```

El `.venv` de `backend/` ya existe con todas las dependencias instaladas. `uvicorn` normalmente se lanza SIN `--reload` en este entorno — si editas código Python del backend con el servidor ya arrancado, hay que reiniciarlo a mano (matar el proceso real, `ps aux | grep "[u]vicorn app.main:app"` para el PID exacto — `pkill -f uvicorn` se automata a sí mismo porque su propio argv contiene el patrón) para que recoja los cambios; Vite sí hace HMR normal sobre `src/`.

**Dependencias fijadas** (Protecciones 1): frontend con `npm ci` (instala exactamente `package-lock.json`; el `Dockerfile` también); backend con `pip install --require-hashes -r backend/requirements-dev.lock.txt` (desarrollo y tests) o `requirements.lock.txt` (servidor), sin instalar la app como paquete (todo corre desde `backend/`). Los lockfiles salen de `backend/pyproject.toml` (que conserva sus rangos) con uv, válidos en Windows y Linux (`--universal`, con hashes); para regenerarlos, desde `backend/`: `uv pip compile pyproject.toml [--extra dev] --universal --python-version 3.11 --generate-hashes -o requirements[-dev].lock.txt` -- uv conserva las versiones ya fijadas; `--upgrade-package <nombre>` sube una. Nunca `npm audit fix --force`.

Hay un proyecto de desarrollo sembrado ("Demo Project (S1000D 4.2)") y un admin de pruebas (`admin@example.com` / `AdminTest123!`, ver `backend/scripts/seed_dev_data.py`) — usarlos para verificación con navegador real en vez de crear datos nuevos cada vez, salvo que el propio caso de prueba lo requiera (y luego limpiar lo creado).

### Cómo verificar cambios: `npm run check:all`

Un solo comando comprueba todo lo que no necesita navegador; igual en Linux y en PowerShell (son scripts de Node, sin sintaxis de shell):

- `npm run check` -- lint, build, `test:js`, `check:prompts` y `lint:templates`, por ese orden, parando en el primer fallo.
- `npm run check:all` -- lo mismo más `test:backend`. No se usa en cada encargo (ver "Reglas de cierre de cada encargo").

### Reglas de cierre de cada encargo (desde Mejoras C; sustituyen a las anteriores)

1. Siempre: `npm run check`.
2. `npm run test:backend` solo si el encargo toca `backend/` (código, migraciones o tests). Una vez, al final.
3. Navegador: el script `verify-*` nuevo del encargo y, como mucho, los dos o tres que cubren las pantallas que el encargo cambia. Ninguno más.
4. Juego de pruebas contra el simulador: una pasada, solo de los casos nuevos o modificados.
5. Si un script antiguo falla: una ejecución sobre el commit anterior al encargo. Si allí también falla, va a la lista del informe y no se arregla en el encargo. Si allí pasa, es una regresión y se arregla.
6. Informe: qué se hizo, qué no y por qué, lo que el encargo pida expresamente, y el resumen final del comando tal cual. Sin repetir lo que ya está en los commits.
7. Si un encargo va a pasar de dos partes grandes o el contexto se va a resumir a mitad, decirlo al terminar la primera parte y entregar por partes.
8. La regresión completa (`check:all`, todos los scripts de navegador, juego de pruebas entero) se hace en un encargo aparte antes del despliegue, no en cada encargo.
- Por separado: `npm run lint`, `npm run build`, `npm run test:js` (todos los `scripts/test-*.mjs` uno a uno, con tiempo máximo por fichero; `-- <texto>` filtra por nombre, `-- --timeout 300` cambia el máximo), `npm run check:prompts` (snapshot de prompts), `npm run lint:templates` (plantillas curadas; falla con cualquier hallazgo), `npm run test:backend` (pytest; `-- -k similar -x` pasa argumentos a pytest).
- Código de salida: 0 todo bien; 1 algo falla; 2 falta algo del entorno (Python del backend; base de datos de pruebas sin definir, caída o sin migrar; `TEST_DATABASE_URL` que no se puede usar; o faltan las claves JWT de `backend/keys/`, que no están en git), que no es un fallo de la app pero tampoco "todo comprobado".
- `check`/`check:all` paran en el primer fallo; con `-- --keep-going` ejecutan todos los pasos y listan todos los fallos. El resumen dice qué Python se usó (ruta completa y si es `backend/.venv` o uno del sistema). Tiempos máximos: 180 s por fichero de `test:js`, 3600 s para `test:backend` (en el portátil Windows de Juanma todo va 4-5 veces más lento que aquí).
- **Windows** (Protecciones 1c): los scripts no pueden usar el `.pathname` de una URL de fichero (`fileURLToPath`), rutas `/tmp` (`shot()` de `scripts/lib/shots.mjs`, o `os.tmpdir()`), `.venv/bin` (`backendPython()`), ni programas que Windows no tiene (`ps`, `xmllint`, `psql`, un shell): lo vigila `scripts/test-windows-safety.mjs`. Los scripts de `backend/scripts` que imprimen reconfiguran stdout a UTF-8 y ningún fichero de texto se abre sin `encoding=` (`backend/tests/test_windows_safety.py`). Los ficheros de prueba se leen con `readTextFile` (`scripts/lib/textFile.mjs`), que normaliza CRLF; `.gitattributes` los fija a LF.
- **Backend**: `test:backend` usa el Python del backend (`$BACKEND_PYTHON`, si no `backend/.venv` -- `bin/python` en Linux, `Scripts\python.exe` en Windows --, si no `python3`/`python`) y **su propia base de datos, nunca la de la app**: `TEST_DATABASE_URL` (entorno o `backend/.env`), con nombre acabado en `_test` y distinta de `DATABASE_URL` (localhost/127.0.0.1/::1 cuentan como el mismo servidor). Lo impone `backend/tests/conftest.py` antes de importar la app (también con `pytest` a mano: una línea y ningún test); las reglas viven en `backend/tests/_testdb.py`. Se crea o se pone al día con `npm run test:db:create` (`backend/scripts/create_test_db.py`: crea `brdp_manager_test` en el mismo servidor, pgvector, migraciones; la primera vez añade `TEST_DATABASE_URL` a `backend/.env`; sin permisos, imprime el SQL para un administrador). Antes de pytest, `check_test_db.py` comprueba en una línea que la base de tests responde y está en la última migración. Postgres real, sin mocks salvo el transporte HTTP de Mistral. En este entorno el rol `brdp` no tiene `CREATEDB`: la base de tests ya existe (`brdp_manager_test`); tras una migración nueva, `npm run test:db:create` la pone al día. Los scripts de navegador y el juego de pruebas de prompts siguen usando el backend arrancado (su `DATABASE_URL`).
- **Frontend**: no hay vitest/jest. La verificación de UI se hace con scripts Node ad hoc usando `playwright-core` (Chromium real: el de `CHROMIUM_PATH` si está definida; si no, el navegador por defecto de Playwright -- en este entorno `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers` lo resuelve solo) contra el Vite dev server real y Postgres real -- login real, `fetch` con refresh de cookie, screenshots. No inventar un framework de test nuevo; seguir ese patrón. Un `scripts/test-*.mjs` nuevo entra solo en `test:js`.

### Historial de cambios (para no repetir investigación)

- El historial de cada encargo (qué se hizo, por qué, hallazgos y verificación) está en [`docs/historial-cambios.md`](docs/historial-cambios.md).
- Es muy grande: búscalo con `grep -n` (por commit, por fichero o por palabra) y lee solo los tramos que salgan; **nunca lo leas entero**.
- Las entradas nuevas van al final de ese fichero, cortas: qué, por qué, commit y tests. Las reglas que sigan vigentes van aquí arriba, en una línea.

### Reglas vigentes sacadas del historial

- **Simuladores de Mistral**: desde este entorno `api.mistral.ai` está bloqueado; se verifica con `scripts/mock-mistral-chat-server.mjs` (puerto 8902) y `scripts/mock-mistral-embed-server.mjs` (8901), con uvicorn arrancado con `MISTRAL_ENDPOINT=http://localhost:8902` y `MISTRAL_EMBED_ENDPOINT=http://localhost:8901`; al terminar, uvicorn vuelve a su configuración normal.
- **Scripts que reinician uvicorn** (p. ej. `verify-rule-extract-safe-import.mjs`, `verify-llm-limit.mjs`): lo arrancan con el entorno del proceso, así que hay que lanzarlos con `MISTRAL_ENDPOINT`/`MISTRAL_EMBED_ENDPOINT` exportados, o el resto de la tanda irá contra el Mistral real.
- **`pkill -f mock-mistral-embed-server`** mata también `mock-mistral-embed-server-delayed.mjs` (mismo patrón): parar los mocks por PID.
- **Tras `verify-brdp-compare.mjs`**, ejecutar `backend/scripts/seed_compare_verification.py cleanup`: su fila de catálogo DITA sin embedding bloquea Suggest en cualquier proyecto DITA.
- **Embeddings del simulador**: si cambia `mock-mistral-embed-server.mjs`, los embeddings ya guardados en la base de desarrollo dejan de ser comparables: ponerlos a NULL (`embedding`, `embedding_text_hash`) para que se recalculen.
- **Comparar contenido extraído con Python con lo que trae la app**: normalizar `\r\n`→`\n` en los dos lados (openpyxl normaliza, SheetJS/la app no siempre).
- **Juego de pruebas contra Mistral real** (lo ejecuta Juanma): `PROMPT_EVAL_EMAIL=… PROMPT_EVAL_PASSWORD=… node scripts/run-prompt-eval.mjs --runs 3`, con el backend apuntando al Mistral real; sin argumentos, `node scripts/compare-prompt-eval.mjs` compara la última pasada con la anterior de otro commit.

## Qué es esta app

BRDP Manager gestiona Business Rules Decision Points (BRDPs) de proyectos S1000D y DITA: frontend React (Vite) y backend FastAPI + Postgres, multiproyecto con usuarios y roles. Funciones principales:

- BRDPs por proyecto (Records), con historial, papelera e import/export de Excel.
- Reglas por BRDP (BREX 4.2/4.1/3.0.1 o Schematron DITA) con estados To Do / Draft / Verified, test de reglas con ejemplos y Generate (BREX o Schematron del proyecto, ensamblado sin IA).
- Asistente: Ask, Suggest Title / Definition / Proposal / Rule, Comparar y AI Extract.

## Arquitectura

```
Navegador (React, Vite) ──/api──▶ FastAPI (backend/app/main.py, puerto 8000) ──▶ Postgres
                                   └── /api/llm-proxy ──▶ proveedor LLM (clave y endpoint solo en el servidor)
```

- **Desarrollo**: `npx vite` (puerto 5173) con el proxy `/api` de `vite.config.ts` hacia uvicorn en el 8000 (ver "Cómo levantar el entorno de desarrollo real" arriba).
- **Producción**: `npm run build` genera `dist/`; los estáticos los sirve nginx (`nginx.conf`, `Dockerfile`) y la API, FastAPI.
- El frontend nunca guarda datos ni claves en el navegador: todo va a la API (Postgres es la fuente de verdad, HR1). La autenticación es JWT (access token en memoria, refresh token en cookie HttpOnly; `src/services/apiClient.js`).

### Nota de entorno: proxy corporativo con inspección SSL (ATEXIS)

`npm install` falla con `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` detrás del proxy corporativo con inspección SSL (Zscaler re-firma el tráfico HTTPS con su propio CA raíz, que npm no reconoce). No es un problema del código. Fix permanente: `npm config set cafile "ruta\al\certificado-corporativo.pem"` (pedir el `.pem` del CA raíz a IT, o exportarlo de `certmgr.msc` → Entidades de certificación raíz de confianza). Fix temporal: `npm config set strict-ssl false` → `npm install` → `npm config set strict-ssl true` inmediatamente después, nunca dejarlo desactivado. Detalle en el README ("Troubleshooting: Corporate Network / SSL-Inspecting Proxy").

## Ficheros clave

| Fichero | Responsabilidad |
|---|---|
| `src/App.jsx`, `src/layouts/` | Rutas y layouts (proyectos, Records, Configuration, Generate, Settings) |
| `src/pages/RecordsPage.jsx` | BRDPs de un proyecto: tabla, panel de detalle, reglas, asistente |
| `src/pages/ProjectConfigPage.jsx` | Configuración del proyecto, Excel, AI Extract, borrar datos |
| `src/pages/GeneratePage.jsx` | Generate: carga las reglas del proyecto y llama al generador |
| `src/services/apiClient.js` | `authFetch`/`authFetchJson` con refresco del token |
| `src/api/llmAPI.js` | `sendMessage` a `/api/llm-proxy` |
| `src/api/generateBREX.js`, `generateBREX41.js`, `generateBREX301.js` | Ensamblado del BREX 4.2 / 4.1 / 3.0.1 con las reglas aprobadas |
| `src/api/generateBREXSch.js` + `brexToSchematron.js` | Schematron de un proyecto S1000D: BREX convertido sin IA |
| `src/api/generateSchematronDITA.js` | Ensamblado del Schematron DITA con las reglas aprobadas |
| `src/api/buildBREXdocReport.js` | Informe (Generate Report) |
| `src/prompts/` | Todos los prompts (funciones puras; snapshot en `scripts/check-prompt-snapshot.mjs`) |
| `src/validation/schemaValidation.js` | Comprobación de nombres, estructura, XPath y formato de regla contra el esquema |
| `src/utils/ruleTest*.js` | Motor y montaje del test de reglas |
| `src/hooks/` | Estado de Ask, Suggest, test de reglas, embeddings, import, vocabulario |
| `src/components/extract/` | AI Extract: BREX/Schematron o texto/documento → candidatas → importación |
| `backend/app/` | API, modelos, servicios y migraciones (ver "Rama actual" arriba) |

## Datos de esquema en `public/`

- `brex-schema-summary-4-2.json`, `-4-1.json`, `-3-0-1.json`: Generate usa su `dmodule_opening_tag` (las claves `structure`/`generation_rules`, sin lector, se borraron en la Limpieza).
- `schematron-dita-schema-summary.json`: `sch_header` (esqueleto del `<sch:schema>`). Los avisos de vocabulario de Generate usan `schema-vocabulary-dita.json`, como el resto de la app (`topic_types`/`vocabulary_by_domain`, que solo leía el lint antiguo, se borraron).
- `schema-vocabulary-*.json` (vocabulario por standard) y las plantillas curadas `brdp-template-*.xlsx`.

## Generate: ensamblado determinista

Generate no llama a la IA. `GeneratePage.jsx` carga las reglas del proyecto (`/api/projects/{id}/approvals/{formato}/export`) y se las pasa al generador en `options.approvals` (obligatorio; sin él, el generador falla con un error). Entran las reglas Verified (y las Draft si se desmarca "Incluir solo reglas verificadas", `src/utils/generatePlan.js`); cada BRDP sin regla que entre deja un comentario `pendingApprovalComment` con su identificador.

### BREX 4.2 / 4.1 / 3.0.1

- 4.2 `<structureObjectRule>` con `brDecisionRef` y `allowedObjectFlag` en `objectPath`; 4.1 igual sin `brDecisionRef` ni `brSeverityLevel` (no existen en su XSD); 3.0.1 `<objrule>` con `objappl` (0/1) en `objpath`, y las reglas sin contexto como comentario `<!-- nonContextRule … -->` (el XSD 3.0.1 no tiene elemento).
- Las piezas de cada regla se separan con `splitRuleXmlPieces` (`src/utils/ruleWrappers.js`, gemelo de `rule_wrappers.py`) y los bloques de contexto del mismo esquema se unen en uno (`mergeContextBlocks`). El bloque general va sin `rulesContext`/`context`.
- Las URL de esquema siguen el "Schema location" del proyecto (`rewriteApprovedRulesSchemaUrls`, informe en la página).
- Una pasada final (`finalizeDocument`/`41`/`301`) fuerza la cabecera del DM (`forceDmoduleTag`, `dmCode`/`avee` desde la configuración) como red de seguridad.
- `extractXML`/`checkWellFormed` y `pendingApprovalComment` viven en `generateBREX.js` y los importan los demás generadores.

### Schematron S1000D (`generateBREXSch.js` + `brexToSchematron.js`)

Genera el BREX con el generador del standard del proyecto (`options.baseGenerator`) y lo convierte a Schematron ISO con `brexToSchematron()`, 100 % determinista (port del XSL de Docuneering, Apache-2.0): `_isSafePattern` valida el `context`, `_splitTopLevel` separa padre y paso respetando los corchetes, un `context` que no es patrón XSLT cae a `context="/dmodule"` con la ruta en el `test`, y `_buildHeader` declara los namespaces que use el BREX.

### Schematron DITA (`generateSchematronDITA.js`)

Un único `.sch` por proyecto con un `<sch:pattern>` por regla aprobada, inyectada tal cual (`approvedRuleBlock`). `dedupeSharedLets`/`collectNamespaces` declaran una vez las funciones y prefijos compartidos (con `sch:ns`, también los de XPath -- xs, fn, math… -- que una regla usa sin declarar; un prefijo desconocido sin declarar da aviso rojo); `finalizeSchematronDocument` añade la cabecera con el `queryBinding` del dialecto (`xslt2`/`xslt3`); `checkWellFormedSchematron` comprueba el resultado (sin `DOMParser`) y da avisos de vocabulario no bloqueantes.

## AI Extract (Project Configuration, `src/components/extract/`)

Crea BRDPs a partir de reglas que ya existen o de un texto. La IA propone; el código comprueba y clasifica; la persona decide qué se importa. Nada se escribe hasta "Importar seleccionadas".

- **Dos entradas**, el mismo trabajo (`rule_extract_jobs`, `source_kind`) y la misma tabla de revisión:
  - **BREX o Schematron** (`POST …/ai-extract/parse`, fichero XML): las reglas se leen del texto del fichero (`app/services/rule_extract.py`, lxml sin entidades ni red), agrupadas por identificador; la nonContextRule es parte de la regla y su texto da la Propuesta literal; un objectUse único también; las `sch:let`/`sch:ns` globales viajan con cada pattern que las usa, con su comentario.
  - **Texto o documento** (`POST …/ai-extract/text`): texto pegado o .txt/.md/.docx/.pdf leído en el navegador (`src/utils/documentText.js`), como máximo 5 000 palabras (rechazado, nunca cortado). Paso 1 en la página: la IA devuelve cada decisión con su cita literal (`src/prompts/extractFromTextPrompt.js`); el código comprueba que la cita está en el texto, fusiona repetidas y toma el identificador de la cita o de su párrafo (`app/services/text_extract.py`).
- **Clasificación por código** (`app/services/rule_extract_jobs.py`): Ya existe (igual / cambia; también por contenido, desmarcada: `match_by_content` -- para las Nueva EXT, y para las de catálogo / otra edición / otra especificación / regla por defecto / prefijo propio cuyo identificador no está en el proyecto solo si la regla es igual, si sus varias reglas están cada una en una BRDP distinta -- sin reclasificar, desmarcada -- o como aviso de parecido), De catálogo, De catálogo de otra edición (id original; la opción "marcada" con sufijo se retiró), Otra especificación, Regla por defecto, Nueva EXT (siguiente número libre), Sin contenido; candidatas parecidas por embeddings como aviso. Las opciones de cada fila son solo las válidas para ella.
- **Textos** (`set_texts`): cada campo sale del proyecto, del catálogo, del fichero o de la IA (`text_sources`, visible en la tabla); la IA solo redacta lo que falta, por lotes de 10 desde la página (`src/utils/ruleExtractDraft.js`), y cada lote se guarda al momento (salir y volver reanuda). Una edición a mano nunca la pisa la IA. "Detener" termina los lotes en curso y se guarda en el trabajo (`drafting_stopped`): no se reanuda sola hasta "Continuar redacción".
- **La página y su trabajo**: las claves de candidata se repiten entre trabajos (`c00000…`), así que cada lista, guardado y lote va con el id de su trabajo y se descarta si la página ya enseña otro. Si la tabla muestra menos filas de las que leyó el trabajo, nombra las que faltan (`…/candidate-keys` y el `manifest` del trabajo) y "Recargar" dice lo que encontró. Una extracción nueva con otra sin importar pide confirmación.
- **Repetidas en texto libre** (`check_repetitions`): mismo título normalizado o fragmentos con similitud ≥ `REPETITION_SIMILARITY` (0,9) → la posterior queda desmarcada con "Posible repetición de «…»"; nunca se fusiona.
- **Importación** (`POST …/apply`, una transacción): bloqueada mientras alguna fila marcada tenga textos pendientes o fallidos (409 en el servidor); comprueba Marcadas = Creadas + Actualizadas + Omitidas. Reglas: Draft y Pending, o "Ya en vigor" (Validated + Verified) solo para reglas válidas. Texto: nunca regla, Propuesta Pending. Cada BRDP gana un evento `extracted_from` en History (fichero, identificador de origen y, para texto, la cita), que también sirve para reconocer lo ya importado al repetir.
- **Prompts** (snapshot `scripts/check-prompt-snapshot.mjs`): `extractFromRulesPrompt.js`, `extractFromTextPrompt.js` (`buildFindDecisionsPrompt` a temperatura 0.1, `buildExtractFromTextPrompt`); juego de pruebas con tipos `extract-from-rules` y `extract-from-text`.

## Patrones a seguir

- **Datos**: todo dato vive en Postgres y se lee/escribe por la API (`authFetchJson`, React Query donde hay sondeo). Nada de `localStorage`/`sessionStorage` en `src/`, sin excepciones (HR1, AACF 3): las preferencias de interfaz van a `users.ui_preferences` con `saveUiPreference` (`AuthContext.jsx`).
- **LLM**: siempre `sendMessage` (`src/api/llmAPI.js`) → `POST /api/llm-proxy`; el backend elige proveedor, endpoint y clave de su propia configuración. Cada llamada (y cada embedding) queda en `llm_calls` y el chat tiene un límite por usuario (Protecciones 2a): una operación nueva que llame a la IA pasa `shouldCancel` a `sendMessage` si el usuario puede cancelarla mientras espera. Los prompts son funciones puras en `src/prompts/` y cualquier cambio pasa por `scripts/check-prompt-snapshot.mjs`.
- **Generate**: un formato nuevo necesita su generador, su entrada en `BREX_STANDARDS`/`STANDARD_TO_RULE_FORMAT` y en `GeneratePage.jsx`.

## Lo que NO está implementado todavía

- S1000D 5.0, 6.0 (se pueden crear proyectos, pero no hay formato de reglas ni Generate).
- Botón de migración BREX→Schematron sobre un BREX subido (el motor `brexToSchematron.js` ya está listo; falta la UI).
- `docker-compose.yml`/`Dockerfile` solo sirven el frontend con nginx; falta el servicio del backend FastAPI y Postgres.

## Auditoría de cumplimiento AACF

Informe completo (HR0–HR21, checklist de seguridad, guardrails T2, desviaciones y decisiones pendientes): [`docs/aacf-audit.md`](docs/aacf-audit.md), auditoría de solo lectura sobre `6e2c671`.
Los arreglos se deciden uno a uno a partir de sus listas "Decisiones para Juanma" y "Arreglos propuestos"; no tocar código por esa auditoría sin luz verde.
AACF 1 ya ha resuelto HR6 (recortes silenciosos), HR7, HR20 y el punto 3 del checklist (validación de entrada); AACF 2, casi toda la tabla HR9 (borrado lógico de proyectos y usuarios, confirmación al quitar un rol); AACF 3, HR1 sin excepciones, HR15/HR21 (salvo el informe y las cabeceras del Excel, Decisión 14) y la marca ATEXIS sobre el CSS propio. El propio documento marca cada punto con su commit y lista lo que sigue abierto.
