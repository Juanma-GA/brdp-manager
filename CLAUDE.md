# CLAUDE.md — Contexto para Claude Code

Este fichero describe la arquitectura y patrones del proyecto para que Claude Code tenga contexto completo antes de hacer cualquier cambio.

## ⚠️ El AACF (framework ATEXIS) tiene prioridad sobre este fichero

Este proyecto está sujeto al **ATEXIS AI-Assisted Coding Framework (AACF)** (repo `Juanma-GA/cursoFSD`, carpeta `Proyecto-CCMS-Nav/aacf/`; copia local leída el 2026-09-18, `aacf/VERSION = 2.0.1`). **Donde el AACF y este `CLAUDE.md` entren en conflicto, gana el AACF** — este fichero se corrige para reflejarlo, nunca al revés.

- **Hard Rules HR0–HR21** (`aacf/rules/atexis-hard-rules.md`) son no negociables — autocomprobar cualquier cambio contra ellas antes de darlo por terminado (ver también `aacf/agents/code-reviewer.agent.md` y `security-reviewer.agent.md` para el criterio de revisión). Resumen relevante para este proyecto: HR1 (nunca localStorage/sessionStorage para estado autoritativo — Postgres es la fuente de verdad), HR6 (nunca truncar contenido de calidad, resumir con LLM), HR7 (nunca un fallback que degrade silenciosamente, escalar), HR8 (nada hardcodeado), HR9 (soft-delete / confirmación explícita antes de borrar), HR10 (deep-merge, nunca shallow-merge de config anidada), HR15/HR21 (i18n + humanizar texto de UI, nunca tokens crudos), HR20 (UI de mutación optimista).
- El framework se sirve normalmente vía el MCP `aacf_fetch` (`http://10.117.139.1:8200/mcp`, solo red corporativa/VPN); esa herramienta **no está disponible en este entorno de ejecución remoto**, así que se trabaja con la copia local del repo `cursoFSD` — puede estar desactualizada. Verificar `aacf/VERSION` contra el MCP en cuanto haya acceso, y no mezclar ficheros de versiones distintas del framework si difiere.
- **Conflicto detectado y todavía sin resolver**: el patrón "Hooks de datos" descrito más abajo en este fichero (ver "Patrones a seguir") usa localStorage como caché de estado autoritativo, lo que viola HR1. No se ha tocado código todavía — ver "Auditoría de cumplimiento AACF (pendiente)" al final de este fichero para el detalle y el plan.

## ⚠️ Rama actual: `v2-multiproyecto` — backend real distinto al descrito abajo

Todo el resto de este fichero (arquitectura Express+SQLite, sin auth, un solo proyecto) describe **v1**. El trabajo activo desde hace muchas rondas vive en la rama `v2-multiproyecto`, que tiene un backend **completamente distinto**, ya en producción dentro del repo:

- **Backend real**: `backend/` — FastAPI + Postgres (`asyncpg` + SQLAlchemy async) + Alembic (`backend/alembic/versions/`, 12 migraciones a fecha de hoy). Nada de SQLite ni Express para el backend de datos (el frontend sigue siendo Vite/React).
- **Multi-proyecto real** con auth JWT: access token en el body de `/api/auth/login`, refresh token en cookie HttpOnly (nunca localStorage — ver `backend/app/api/routes/auth.py`). Roles `admin` / `editor` / `viewer` por proyecto vía `UserProjectRole` (`backend/app/models/user_project_role.py`) — un admin global puede todo, un editor solo en sus proyectos.
- **Estructura backend**: `backend/app/models/*` (BRDP, Project, User, UserProjectRole, RuleApproval, BRDPHistory, BRDPCatalog, ImportJob, AppSettings, RefreshToken), `backend/app/api/routes/*` (un fichero por recurso: `projects.py`, `brdps.py`, `approvals.py`, `brdp_import.py`, `trash.py`, `brdp_catalog.py`, `auth.py`, `users.py`, `app_settings.py`, `similar.py`, `suggestion_feedback.py`, `llm_proxy.py`, `notes.py`, `config.py`, `validate_brex.py`), `backend/app/services/*` (`import_jobs.py`, `embeddings.py`, `history.py`, `rule_formats.py`), `backend/app/repositories/brdp_repository.py` (capa de acceso a BRDP — todas las queries pasan por aquí, incluido el filtro de soft-delete `ACTIVE_BRDP_FILTER`).
- **Soft-delete real**: borrar una BRDP la manda a Papelera (`deleted_at`/`deleted_by`), no la elimina. Borrado permanente vía `/api/trash/{id}` (admin, o editor si es de su proyecto).
- **Import de Excel** (`backend/app/services/import_jobs.py` + `backend/app/schemas/brdp_import.py`) es un job asíncrono en background (`BackgroundTasks`, no bloqueante): `/import/analyze` (fase 1, solo lectura, devuelve avisos) → `/import/apply` (fase 2, devuelve `job_id`, se sondea `/import/status/{job_id}`). Un `running` job antiguo (>60 min, `STALE_JOB_MINUTES`) se marca `failed` automáticamente al leerlo (`_reap_if_stale`) — cubre crashes; una interrupción limpia (`asyncio.CancelledError`, p.ej. un `--reload` de uvicorn) tiene su propio handler explícito porque `CancelledError` hereda de `BaseException`, no de `Exception`, desde Python 3.8.
- **Documentación de diseño original** (útil como contexto histórico, pero YA DESACTUALIZADA frente al código real tras ~106 rondas de iteración — no la trates como fuente de verdad, el código y los tests son la fuente de verdad): `docs/v2/01-arquitectura-y-estructura.md` (snapshot de v1, la base de la decisión de reescribir), `docs/v2/02-analisis-aacf-requisitos-no-cumplidos.md`, `docs/v2/03-especificacion-v2-para-claude-code.md` (spec original de v2).

### Cómo levantar el entorno de desarrollo real (v2)

```bash
service postgresql start   # o `service postgresql status` si ya está arrancado
cd backend && source .venv/bin/activate && uvicorn app.main:app --host 0.0.0.0 --port 8000   # backend, puerto 8000
cd /home/user/brdp-manager && npx vite --port 5173 --strictPort                              # frontend, puerto 5173
```

El `.venv` de `backend/` ya existe con todas las dependencias instaladas. `uvicorn` normalmente se lanza SIN `--reload` en este entorno — si editas código Python del backend con el servidor ya arrancado, hay que reiniciarlo a mano (matar el proceso real, `ps aux | grep "[u]vicorn app.main:app"` para el PID exacto — `pkill -f uvicorn` se automata a sí mismo porque su propio argv contiene el patrón) para que recoja los cambios; Vite sí hace HMR normal sobre `src/`.

Hay un proyecto de desarrollo sembrado ("Demo Project (S1000D 4.2)") y un admin de pruebas (`admin@example.com` / `AdminTest123!`, ver `backend/scripts/seed_dev_data.py`) — usarlos para verificación con navegador real en vez de crear datos nuevos cada vez, salvo que el propio caso de prueba lo requiera (y luego limpiar lo creado).

### Cómo verificar cambios (no hay test runner JS)

- **Backend**: `cd backend && source .venv/bin/activate && python -m pytest -q` (a fecha de hoy: 198 tests, Postgres real, sin mocks salvo el transporte HTTP de Mistral).
- **Frontend**: no existe vitest/jest ni script `test` en `package.json`. Toda verificación de UI se hace con scripts Node ad hoc usando `playwright-core` (Chromium real en `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`) contra el Vite dev server real y Postgres real — login real, `fetch` con refresh de cookie, screenshots. No inventar un framework de test nuevo; seguir ese patrón.
- `npm run lint` (ESLint) y `npm run build` (Vite) deben quedar limpios antes de dar por cerrada cualquier tarea de frontend.

### Últimos cambios relevantes (para no repetir investigación)

- **`_normSpace()` en `brexToSchematron.js`** ahora respeta el contenido entre comillas (no colapsa espacios significativos dentro de literales de cadena), reutilizando el patrón de escaneo "char a char, trackeando si se está dentro de comillas" que ya usan `_isSafePattern`/`_splitTopLevel` en el mismo fichero. Si aparece otro sitio del código que normaliza espacios sobre texto que puede contener literales entre comillas, reutilizar esta misma técnica, no inventar otra.
- **`rule_override`** en `ImportRowResult` (`backend/app/schemas/brdp_import.py` + `_classify_row` en `backend/app/services/import_jobs.py`): mismo patrón que `catalog_override` ya existente, pero para la columna Rule — avisa en la fase de análisis si un `action == "update"` va a reemplazar una Rule ya existente por una distinta. La comparación ya NO normaliza espacios sobre el string completo (ese enfoque tenía el mismo bug que `_normSpace()` de arriba: colapsaba espacios significativos dentro de un valor de atributo junto con la indentación). Ahora es una comparación estructural real con `lxml` (`_rule_xml_structurally_equal`/`_elements_structurally_equal` en `import_jobs.py`, mismo patrón de `<root>` tolerante que `_xml_well_formed_error` en `approvals.py`): tag, atributos y texto/tail no-blanco comparados byte a byte; solo se ignora texto/tail puramente en blanco entre hermanos (indentación real). Frontend: `ProjectConfigPage.jsx` (`ruleOverrideRows`), i18n en `src/i18n/index.js` (`config.dataManagement.ruleOverride*`, `summaryRuleOverrides`).
- **Renombrado de Project Standards** (migración `0012_rename_project_standards.py`, mismo patrón que `0002_canonicalize_project_standard.py`): los 7 strings canónicos pasan a ser 6 — `BREX — S1000D 3.0.1/4.1/4.2` → `S1000D 3.0.1/4.1/4.2`, `Schematron 1.0 — DITA` → `DITA 1.3`, y **`Schematron 1.0 — S1000D` desaparece como standard independiente** (migra a `S1000D 3.0.1`, el BREX real que siempre generó por dentro). `STANDARD_TO_RULE_FORMAT` (`rule_formats.py`/`ruleFormats.js`) ya no tiene entrada `SCH-S1000D`; `_CATALOG_STANDARD_ALIASES`/`_resolve_catalog_standard()` en `brdp_catalog.py` se eliminaron (ya no hace falta alias, no hay un standard Schematron separado al que apuntar).
- **Selector BREX / Schematron en `GeneratePage.jsx`**: para un proyecto `S1000D 3.0.1/4.1/4.2` ya no hay un formato de generación fijo por standard — un selector (`outputKind`, `BREX` | `Schematron (XPath 2.0)`) elige entre generar el BREX real o su conversión determinista a Schematron, alimentados por el MISMO conjunto de reglas aprobadas bajo el formato BREX del standard (`BREX-3.0.1`/`BREX-4.1`/`BREX-4.2`) — sin re-aprobación al cambiar. `generateBREXSch.js` ya no asume `generateBREX301` siempre: acepta `options.baseGenerator` (por defecto `generateBREX301`, retrocompatible) para que el llamador elija el generador base real (`generateBREX`/`generateBREX41`/`generateBREX301`) según el standard del proyecto. `DITA 1.3` no tiene selector (sin cambios, sigue sin equivalente BREX).
- **`GeneratePage.module.css` — layout sin scroll de página**: `.page` sigue ahora el mismo patrón flex que `RecordsPage.module.css`/`ProjectConfigPage.module.css` (`flex:1; min-height:0; display:flex; flex-direction:column`, con `overflow-y:auto` como fallback — nunca se activa en el caso normal, solo evita contenido inalcanzable si la ventana queda más baja que el propio formulario). `.card` (formulario) lleva `flex-shrink:0` para no comprimirse nunca; `.outputCard` es el item `flex:1` que ocupa el resto (mismo rol que `.tableWrap`), y dentro de él `.xmlOutput` pasó de `max-height:420px` fijo a `flex:1;min-height:0` — es el único hijo que crece/hace scroll interno (`.outputMeta`/`.xsdSection`/`.outputActions` llevan `flex-shrink:0` para quedar fijos). Verificado con Playwright a 1366×800 (portátil típico): 25 reglas no fuerzan scroll de página, 1 regla no deja el panel absurdamente vacío, y encoger la ventana por debajo de la altura del formulario activa el fallback de scroll en vez de cortar contenido sin forma de llegar a él.
- **`DITA 1.3` habilitado en `STANDARD_TO_RULE_FORMAT`** (`rule_formats.py`/`ruleFormats.js`, nueva entrada `"DITA 1.3": "SCH-DITA"`): antes de esta ronda DITA era el único standard SIN entrada en el mapa ("no hay equivalente BREX"), pero `generateSchematronDITA.js` sí tiene su propio camino de generación 100% determinista (sin LLM) que inyecta verbatim el `rule_xml` de cada fila `approved` bajo formato `SCH-DITA` — sin la entrada en el mapa, ningún BRDP de un proyecto DITA podía llegar nunca a `approved` (el import rechazaba cualquier Rule/Rule Status con "This project's standard has no rule format"). Auditados los 7 puntos que dependían del mapa: `import_jobs.py` (genérico, sin nada específico de BREX), `similar.py`/Suggest Rule (antes daba 400 explícito para DITA, no "sin resultados"; ahora indexa `SCH-DITA` real), `import_brdp_catalog.py` (`DITA 1.3` ya estaba en `_KNOWN_STANDARDS` desde el renombrado, nada que tocar), `ProjectConfigPage.jsx`/`RecordsPage.jsx` (el gating de UI ya era genérico sobre `STANDARD_TO_RULE_FORMAT[standard]`, "funciona solo" con la entrada nueva).
  - **Bug real encontrado (no asumido) verificando el editor manual**: `_xml_well_formed_error` (`approvals.py`) y `checkWellFormed` (`generateBREX.js`) envolvían el fragmento en un `<root>` plano sin namespaces — un `<sch:pattern>`/`<sch:rule>`/`<sch:assert>` real usa el prefijo `sch:` que NUNCA se autodeclara (solo se declara una vez, en el `<sch:schema xmlns:sch="...">` que añade `finalizeSchematronDocument` al final), así que todo Schematron nativo genuino fallaba como "no bien formado" al guardarlo o importarlo. Arreglado con `_wrap_rule_xml_fragment`/`wrapRuleXmlFragment` (backend y frontend, mismo criterio, mantenerlos en sync): detecta genéricamente cualquier prefijo `prefix:name` usado en el fragmento (nunca hardcodea "sch") y lo declara con una URI ficticia solo para que el parser lo acepte — mismo patrón ya usado por `_buildHeader` en `brexToSchematron.js` para namespaces de documento completo, aplicado aquí a un fragmento suelto. Usado también por `_rule_xml_structurally_equal` (mismo problema al comparar dos fragmentos Schematron para `rule_override`).
  - **Verificación end-to-end con datos reales (Navantia S80, `nav_dtm_xpath2_import_v3.xlsx`: 36 BRDPs, 8 `Verified` con Schematron nativo SIN prefijo -- `<pattern>`/`<rule>`/`<assert>` a secas, caso real distinto del `<sch:pattern>` prefijado de los few-shot curados) encontró y arregló DOS bugs reales más, ninguno hipotético:
    1. **Namespace roto para contenido sin prefijo** (`generateSchematronDITA.js`): `finalizeSchematronDocument` envolvía los bloques en `<sch:schema xmlns:sch="...">` SOLO con el prefijo `sch:` declarado, sin namespace por defecto. Un bloque `rule_xml` inyectado verbatim SIN prefijo (el caso real de Navantia) quedaba entonces en "sin namespace" al anidarse ahí -- confirmado con `lxml`/`DOMParser`: `<pattern>` parseaba como elemento suelto en vez de `{http://purl.oclc.org/dsdl/schematron}pattern`. XML bien formado, pero invisible para cualquier procesador Schematron/XSLT2 real. Arreglado declarando TAMBIÉN `xmlns="http://purl.oclc.org/dsdl/schematron"` por defecto en el wrapper (legal en XML: un elemento puede estar en el scope de un prefijo y del namespace por defecto a la vez apuntando a la misma URI) -- mismo fix en el fallback JS y en `public/schematron-dita-schema-summary.json`'s `sch_header.root_open`. Además, `checkWellFormedSchematron`'s `checkDuplicateIds`/`checkRulesAndChecks`/`lintVocabulary` tenían el prefijo `sch:` hardcodeado en sus regexes -- para contenido sin prefijo esto significaba CERO patterns/rules/checks encontrados y por tanto "0 errores" no porque estuviera confirmado correcto, sino porque el check nunca miraba ese contenido. Arreglado con una constante `SCH = "(?:sch:)?"` reutilizada en esas regexes (NO en `checkRootHeader`, que sólo mira el wrapper determinista, siempre con prefijo). De paso, con el check ya mirando contenido real, `lintVocabulary` sacó falsos positivos legítimos de XPath 2.0 (`string-join`, `if`/`then`/`else`, `for`, `number`, `doc-available`) que no estaban en `XPATH_FUNCTIONS`/`XPATH_KEYWORDS` -- **comportamiento concreto confirmado antes/después con las mismas 8 reglas reales**: antes de añadirlos, `result.vocabularyWarnings` traía líneas como `"BRDP-EXT-00001: uses unconfirmed element/attribute 'string-join'"` para cada una de esas 6 palabras (avisos no bloqueantes, pero visibles en la UI de Generate bajo "vocabulary warnings") -- no eran errores de bien-formación (`result.valid` ya daba `true`), sino ruido del lint heurístico tratando una función/keyword XPath 2.0 estándar como si fuera un nombre de elemento/atributo DITA sin confirmar. Tras añadirlos a `XPATH_FUNCTIONS`/`XPATH_KEYWORDS`, la misma llamada sobre el mismo contenido da `vocabularyWarnings: []` -- cero avisos, nada más cambió (ni `result.valid`, ni el XML generado, ni el resto de warnings reales como `footnote`/`video`/`audio` de otro fixture, que siguen apareciendo sin tocar).
    2. **`isConfigComplete` en `GeneratePage.jsx` bloqueaba el botón Generate PERMANENTEMENTE para todo proyecto DITA 1.3**: dependía de `project.project_config?.modelIdentCode` sin importar el standard, pero la página de Project Configuration de DITA (`DITA_FIELDS` en `ProjectConfigPage.jsx`) solo muestra/guarda `projectName` -- `modelIdentCode` nunca se puede rellenar para DITA (ni por la UI ni por los defaults de creación del backend, `_DEFAULT_PROJECT_CONFIG`). Confirmado en vivo: un proyecto DITA recién creado nunca tiene `modelIdentCode` en su `project_config`, así que el botón Generate quedaba deshabilitado para siempre, bloqueando toda la feature en su último paso. Arreglado: `isConfigComplete` ahora exige `projectName` para DITA, `modelIdentCode` para los tres standards S1000D reales (sin cambio ahí).
    - **Hallazgo adicional, ya corregido en el mismo momento**: `finalizeSchematronDocument` también aplicaba `escapeSchTestAttributes`/`sanitizeXmlCommentBodies` (una "segunda capa de defensa" heredada de una arquitectura anterior basada en LLM) sobre el documento COMPLETO ya ensamblado, incluidos los bloques `rule_xml` verbatim de reglas ya aprobadas. Confirmado con datos reales: esto rompía silenciosamente la garantía "verbatim" -- un comentario XML propio y legítimo dentro de una regla real de Navantia (`<!-- La columna de exención ... -->`) perdía su espacio inicial/final al pasar por `sanitizeForXmlComment`. Dado que TODO `rule_xml` que llega a `approved` ya pasó por `_xml_well_formed_error`/`checkWellFormed` en el momento de guardarse (tanto import como editor manual, doble verificación cliente+servidor), y `buildTraceabilityComment` ya sanitiza su propio texto generado, esta segunda pasada global no defendía de nada en la arquitectura actual (100% determinista, sin LLM en el camino principal) y solo podía corromper contenido ya válido. Eliminadas ambas funciones (`escapeSchTestAttributes`, `escapeAttrLiteral`, `sanitizeXmlCommentBodies`) por no tener ya ningún llamador.
    - Scripts de verificación ad hoc (mismo patrón que `test-schematron-dita.mjs`, mantenidos en el repo): `scripts/verify-dita-navantia-e2e.mjs` (flujo completo real: crear proyecto, importar el xlsx real vía UI, comprobar las 8 aprobaciones byte a byte, editor manual real, Generate real, Suggest Rule real, caso límite Verified-sin-Validar, `rule_override` con contenido real), `scripts/verify-sch-namespace-fix.mjs` (namespace + regexes contra datos reales, incluido un documento mixto prefijado+sin prefijo), `scripts/verify-dita-config-complete-fix.mjs` (regresión del fix de `isConfigComplete`), `scripts/mock-mistral-embed-server.mjs` (mock local del endpoint de embeddings de Mistral para poder correr un Apply real con filas `Validated` en este entorno sin clave real de Mistral -- mismo criterio "mockear solo el transporte HTTP de Mistral" que usa la suite de pytest).
    - **Nota sobre "byte a byte"**: la comparación real encontró que el import vía UI (SheetJS en el navegador) preserva `\r\n` tal cual está en la celda de Excel, mientras que `openpyxl` (usado para extraer los datos de referencia con Python) normaliza `\r\n`→`\n` al parsear XML, por spec de XML 1.0. No es un bug de la app -- ambos representan el mismo salto de línea, y las comparaciones estructurales reales (`_rule_xml_structurally_equal`) ya normalizan esto vía parseo XML -- pero si se escribe otro script de verificación que compare contenido extraído con Python contra lo que trae la app, normalizar `\r\n`→`\n` en ambos lados antes de comparar, o el diff sale en falso.
- **Ronda siguiente sobre el mismo generador DITA — filename con `modelIdentCode` + comentarios de trazabilidad con UUID en vez de identificador legible** (`GeneratePage.jsx` + `generateSchematronDITA.js`): mismo patrón de bug que `isConfigComplete` de la ronda anterior — un campo específico de S1000D asumido para todos los standards, sin caso especial para DITA. Dos bugs reales, confirmados con el mismo proyecto Navantia S80:
  1. **`handleDownload`** calculaba `mic` (el prefijo del nombre de fichero) SIEMPRE desde `project_config.modelIdentCode`, que para DITA nunca existe (ver el fix de `isConfigComplete`) -- confirmado con un fichero real: `UNKNOWN_2026-09-19_dita.sch`, mientras que el `<sch:title>` interno del propio documento sí traía el nombre real del proyecto. Arreglado centralizando la lógica "qué campo identifica el proyecto según el standard" en un único valor derivado, `configIdentifierValue` (`projectName` para DITA, `modelIdentCode` para los tres S1000D reales), reutilizado tanto por `isConfigComplete` como por `handleDownload` -- evita una tercera copia divergente de ese mapeo. Confirmado en vivo: el mismo proyecto ahora descarga `Navantia S80_2026-09-19_dita.sch`. Caso límite confirmado por construcción, no por prueba adicional: un proyecto DITA sin `Project Name` relleno nunca puede llegar a esta pantalla con el botón Generate habilitado (lo bloquea `isConfigComplete`, mismo valor derivado), así que el fallback a `'UNKNOWN'` en el nombre de fichero es inalcanzable vía UI normal -- mismo estatus que el fallback ya existente para S1000D con `modelIdentCode` vacío, no un caso nuevo a resolver.
  2. **`buildTraceabilityComment`** (`generateSchematronDITA.js`) usaba `${brdp.id}` -- el UUID interno de Postgres del objeto `brdp` tal como llega desde `GET /api/projects/{id}/brdps` (`BRDPOut`, que sí trae también `identifier`) -- en vez de `${brdp.identifier}`, el id legible (`BRDP-EXT-00010`). Confirmado con un `.sch` real: los comentarios de trazabilidad salían como `<!-- 3b32ddb1-...: no se pudo generar... -->` en vez de `<!-- BRDP-EXT-00010: no se pudo generar... -->`. Arreglado cambiando esa única línea (único call site de `buildTraceabilityComment`, dentro del bucle principal de `generateSchematronDITA()`) -- **NO tocadas** las líneas equivalentes de `buildFewShotBlock`/`buildDeterministicBlockFromFewShot` (`${ex.id}`/`${entry.id}`), que operan sobre el catálogo curado de few-shot donde `id` YA es el identificador legible, no un UUID -- son objetos de origen distinto, no el mismo bug. Verificado con las 28 filas `To Do` reales de Navantia: cada comentario de trazabilidad muestra el identificador correcto correspondiente a esa fila exacta (no solo "tiene forma de BRDP-EXT-algo"), y ningún UUID de Postgres aparece en ningún punto del documento generado.
  - Ambos fixes verificados end-to-end con el mismo script `scripts/verify-dita-navantia-e2e.mjs` (ampliado esta ronda: comprueba el nombre de fichero real vía el evento `download` real de Playwright, y las 28 identidades `To Do` una por una en vez de una comprobación puntual) -- sin cambios en backend, suite de 205 tests sigue en verde.

## Qué es esta app

BRDP Manager es una app React + Express para gestionar Business Rules Decision Points (BRDPs) de proyectos S1000D/DITA. Sus funciones principales son:

- CRUD de BRDPs con persistencia en SQLite
- Generación de BREX DM (S1000D 4.2 y 3.0.1) y Schematron 1.0 vía LLM
- Extracción de BRDPs desde documentos (DOCX/PDF) o texto pegado (AI Extract)
- Asistente AI con contexto del dataset de BRDPs

## Arquitectura

```
Browser (React) → Express server.js (puerto 3000)
                  ├── GET /*           → sirve dist/ (Vite build)
                  ├── POST /api/proxy  → LLM externo (Mistral/Anthropic/OpenAI)
                  ├── /api/brdps       → SQLite (better-sqlite3)
                  ├── /api/config      → SQLite
                  ├── /api/settings    → SQLite
                  └── /api/notes/:id   → SQLite
```

### Modos de ejecución

- **Desarrollo**: `npm run dev` → Vite dev server en puerto 5173, proxy Vite para Mistral
- **Producción**: `npm run build && npm start` → Express en puerto 3000

### Detección de entorno en frontend

```javascript
if (import.meta.env.PROD) {
  // llama a /api/proxy (Express)
} else if (import.meta.env.DEV) {
  // llama a /mistral-proxy (Vite proxy)
}
```

### Nota de entorno: `better-sqlite3` (módulo nativo)

`better-sqlite3` se compila de forma nativa. En Node muy reciente (24+) puede no haber binario precompilado y fallar el build (requiere C++ build tools). Soluciones: `npm install better-sqlite3@latest` (trae prebuilt para Node nuevo) o usar Node LTS 20/22. No es un problema del código de la app.

### Nota de entorno: proxy corporativo con inspección SSL (ATEXIS)

Dos problemas relacionados pero distintos, ambos con la misma causa raíz (el proxy corporativo con inspección SSL — confirmado Zscaler — re-firma el tráfico HTTPS con su propio CA raíz, que ni npm ni Node reconocen por defecto). Detalle completo orientado al usuario en el README ("Troubleshooting: Corporate Network / SSL-Inspecting Proxy"):

1. **`npm install` falla con `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`** — afecta a cualquier instalación o adición de dependencia futura. Es un problema de la propia herramienta npm, no del código de la app. Fix permanente: `npm config set cafile "ruta\al\certificado-corporativo.pem"` (pedir el `.pem` del CA raíz a IT, o exportarlo de `certmgr.msc` → Entidades de certificación raíz de confianza). Fix rápido/temporal si no se tiene el `.pem` a mano: `npm config set strict-ssl false` → `npm install` → `npm config set strict-ssl true` inmediatamente después — nunca dejarlo desactivado.
2. **La propia app (`npm start`) falla con el mismo error de certificado** — problema distinto: Node en runtime no usa la config de npm ni el almacén de certificados de Windows por defecto. **Ya resuelto en el código** vía `win-ca` (`server.js`, se activa solo si `process.platform === 'win32'`, no-op en Linux/Mac) — no requiere ninguna acción manual, a diferencia del problema 1.

## Ficheros clave

| Fichero | Responsabilidad |
|---|---|
| `server.js` | Express: static files + proxy LLM + REST API SQLite |
| `src/db/database.js` | Conexión SQLite con better-sqlite3, WAL mode |
| `src/db/schema.sql` | Definición de tablas: brdps, config, settings, notes |
| `src/services/api.js` | Capa de servicio frontend: fetch a endpoints REST |
| `src/api/generateBREX.js` | Generador BREX S1000D 4.2 + helpers compartidos |
| `src/api/generateBREX41.js` | Generador BREX S1000D 4.1 |
| `src/api/generateBREX301.js` | Generador BREX S1000D 3.0.1 |
| `src/api/generateBREXSch.js` | Generador Schematron 1.0 — S1000D (enfoque A2, ver abajo) |
| `src/api/brexToSchematron.js` | Conversor determinista BREX → Schematron (sin LLM) |
| `src/api/generateSchematronDITA.js` | Generador Schematron 1.0 — DITA (pipeline directo LLM, ver abajo) |
| `src/api/buildBREXdocReport.js` | Constructor del informe BREXdoc |
| `src/api/extractBRDPs.js` | AI Extract: DOCX/PDF/texto plano → BRDPs |
| `src/api/llmAPI.js` | Cliente LLM agnóstico (Anthropic/OpenAI/Mistral/Custom) |
| `src/context/BRDPContext.jsx` | Estado global de BRDPs + carga desde API |
| `src/hooks/useBRDPs.js` | Hook de BRDPs (usa BRDPContext internamente) |
| `src/hooks/useAPIKey.js` | Hook de configuración AI (lee/escribe settings API) |
| `src/hooks/useProjectConfig.js` | Hook de configuración del proyecto (lee/escribe config API) |
| `src/hooks/useLocalNotes.js` | Hook de notas (sync con API, fallback localStorage) |
| `src/components/GenerateModal.jsx` | Modal de generación: selector de formato + llamada al generador |
| `src/components/AIExtractModal/` | Modal de AI Extract (fichero o texto plano) |

## Schema JSON (few-shot para LLM)

Los generadores de BREX cargan su estructura + ejemplos few-shot desde `public/`:

- `brex-schema-summary-4-2.json` — estructura 4.2 + ejemplos few-shot
- `brex-schema-summary-4-1.json` — estructura 4.1 + ejemplos few-shot (reutiliza los mismos few-shot examples que 4.2 — son datos planos BRDP→XPath, no dependen del issue)
- `brex-schema-summary-3-0-1.json` — estructura 3.0.1 + ejemplos few-shot
- `brex-schema-summary-sch.json` — **ya no se usa** (el Schematron se genera por conversión determinista, no por LLM directo). Se conserva por si se quisiera retomar la generación directa.

Los ejemplos few-shot van en `few_shot_examples` y se inyectan en el system prompt vía `buildBREXPrompt*()`. El schema JSON completo se serializa SIN el array few-shot (para no duplicar tokens); los ejemplos van en un bloque separado.

- `public/schematron-dita-schema-summary.json` — equivalente DITA, con estructura distinta (no hay `dmodule_opening_tag` ni `objectPath`): `sch_header` (esqueleto determinista del `<sch:schema>`), `topic_types` (mapa estructural de los 6 tipos: topic/concept/task/machineryTask/map/bookmap, confirmado contra los XSD reales de `sources/D1.3/schema/`), `vocabulary_by_domain` (content models reales por dominio DITA — hazard-d, taskreq-d, hi-d, ut-d, elementos base — usado también por el lint de vocabulario, ver abajo) y `few_shot_examples` (29 reglas Schematron reales, validadas en oXygen).

## Generadores BREX / Schematron — arquitectura defensiva

Los generadores (4.2, 4.1, 3.0.1, Schematron vía 3.0.1) comparten la **misma arquitectura defensiva**, diseñada para que con datasets grandes (+400 BRDPs) el LLM no trunque el XML, no invente IDs, no salte BRDPs ni produzca XML/XPath inválido.

### Patrón común

1. **Chunking** — `CHUNK_SIZE = 10` BRDPs por llamada LLM, `MAX_RETRIES = 2`.
   - Chunk 1: genera el DM completo (header + reglas del chunk).
   - Chunks 2..N: generan solo las reglas.
   - Un chunk con respuesta vacía NO se descarta: sus BRDPs pasan al reintento individual.
2. **Verificación por chunk** — detecta reglas faltantes e inventadas; elimina inventadas; reintenta faltantes individualmente.
3. **Barrido final de cobertura** — tras procesar todos los chunks, recalcula qué BRDPs faltan en el documento completo y los reintenta.
4. **Red de seguridad anti-pérdida** — si un BRDP sigue sin poder generarse como regla, se emite como entrada de trazabilidad para que NUNCA desaparezca en silencio. La cobertura siempre es total.
5. **Finalización determinista** — una pasada final que corrige de forma determinista lo que el LLM tiende a romper (ver por versión).

Helpers compartidos: `extractXML()` y `checkWellFormed()` se importan SIEMPRE desde `./generateBREX.js`. NUNCA duplicarlos.

### BREX 4.2 (`generateBREX.js`)

- Elemento de regla: `<structureObjectRule>`; ref BRDP: `<brDecisionRef brDecisionIdentNumber="..."/>`; flag: `allowedObjectFlag` (0/1/2) en `objectPath`.
- Reglas sin contexto: elemento formal `<nonContextRule>` (con `simplePara`). El `id` es `xs:ID` (único en TODO el documento).
- Red de seguridad: `<nonContextRule>` formal.
- `finalizeDocument(xml, projectConfig, schemaSummary)` aplica, en orden:
  - `forceDmoduleTag` — fuerza el tag de apertura de `dmodule` (evita corrupción de namespace por el LLM).
  - `fixFlagPlacement` — mueve `allowedObjectFlag` de `structureObjectRule` a `objectPath`.
  - `promoteOrphanSplitRules` — sufijos de split (`-b`/`-c`) sin base → renombra a base.
  - `forceDmCodeFields` (`resolveDmCodeFields`) — fuerza atributos del `dmCode`: respeta `modelIdentCode`/`systemDiffCode` de config (en mayúsculas) y hardcodea el resto (`systemCode=00`, `disassyCodeVariant=0A`, `itemLocationCode=D`, etc.).
  - `dropRedundantNonContextRules` — si un BRDP existe como `structureObjectRule`, elimina su `nonContextRule` homónimo (evita id `xs:ID` duplicado).
  - `dedupeNonContextRules` — dedup de `nonContextRule` por id.

### BREX 4.1 (`generateBREX41.js`)

- Mismo mecanismo core que 4.2 (`<structureObjectRule>`, `allowedObjectFlag` 0/1/2 en `objectPath`, `<nonContextRule>` formal) — confirmado idéntico contra el XSD real (`sources/S4.1/brex4.1.xsd` vs `sources/S4.2/brex.xsd`).
- **Sin `brDecisionRef` ni `brSeverityLevel`** (no existen en el XSD 4.1, confirmado con cero apariciones): la trazabilidad BRDP→regla es solo el atributo `id` de `structureObjectRule`/`nonContextRule`. Todas las funciones de `generateBREX.js` que hardcodeaban estas referencias (plantillas few-shot, `splitMultipleObjectPaths`, el fix-up de `<brDecisionIdentNumber>`, el "safety net" de `nonContextRule`) se adaptaron quitándolas por completo — NO solo renombrándolas.
- Todas las funciones internas llevan sufijo `41` (mismo patrón que `301` en `generateBREX301.js`): `buildBREXPrompt41`, `buildBREXPromptChunk41`, `finalizeDocument41`, etc.
- `extractXML()` y `checkWellFormed()` se importan desde `./generateBREX.js` (no se duplican), igual que hace `generateBREX301.js`.
- `finalizeDocument41(xml, projectConfig, schemaSummary)` aplica el mismo orden que 4.2 (`forceDmoduleTag41`, `fixFlagPlacement41`, `promoteOrphanSplitRules41`, `forceDmCodeFields41`/`resolveDmCodeFields41`, `dropRedundantNonContextRules41`, `dedupeNonContextRules41`) — ninguna de estas funciones tocaba `brDecisionRef`/`brSeverityLevel` en origen, así que no necesitaron más cambio que el renombrado.

### BREX 3.0.1 (`generateBREX301.js`)

- Elemento de regla: `<objrule>`; flag: `objappl` (0/1, NO 2) en `objpath`; header `avee` con elementos hijos de patrón estricto.
- NO existe `nonContextRules` en el XSD 3.0.1 → las reglas sin contexto se representan como comentarios XML `<!-- nonContextRule id="...": ... -->`.
- Red de seguridad: comentario `nonContextRule` (no elemento).
- `finalizeDocument301(xml, projectConfig, schemaSummary)` aplica: `forceDmoduleTag301`, `fixObjapplPlacement301`, `promoteOrphanSplitRules301`, `forceAveeFields301` (`resolveAveeFields301`), `dedupeNonContextComments301`.

### Schematron 1.0 — S1000D (`generateBREXSch.js` + `brexToSchematron.js`) — enfoque A2

El Schematron NO se genera con el LLM directamente (era frágil). En su lugar:

1. `generateBREXSch` reutiliza internamente `generateBREX301` para producir un BREX 3.0.1 (con toda su robustez).
2. Lo convierte a Schematron ISO con `brexToSchematron()`, que es **100% determinista** (port del XSL de referencia de Docuneering, Apache-2.0).

`brexToSchematron.js` es robusto frente a XPaths complejos generados por LLM:

- `_isSafePattern(ctx)` — valida que un `context` sea un patrón XSLT legal (balance de `()`/`[]`, sin `..`/ejes inversos como paso del patrón, sin operadores colgando).
- `_splitTopLevel(path)` — split consciente de la profundidad de corchetes para separar parent/step (evita romper rutas con `/` dentro de predicados).
- Si el `context` calculado no es un patrón válido, hace fallback a `context="/dmodule"` y mueve la ruta al `test` (donde `..`/ejes inversos SÍ son válidos como XPath).
- `_buildHeader(brexXml)` — declara dinámicamente los namespaces que use el BREX (p. ej. `ns2`), además de los base.

Opciones de `brexToSchematron(brexXml, options)`: `preserveBrdpId` (usa el id del BRDP en el assert en vez de uno secuencial) y `carryComments` (arrastra los comentarios `nonContextRule` del BREX 301 al `.sch` como trazabilidad).

El motor `brexToSchematron.js` es independiente y reutilizable (p. ej. para un futuro botón de migración BREX→Schematron sobre un BREX subido por el usuario).

### Schematron 1.0 — DITA (`generateSchematronDITA.js`) — pipeline directo, sin BREX

DITA no tiene un equivalente a BREX, así que aquí el pipeline es **directo**: BRDP → LLM → Schematron final, sin conversión determinista intermedia (a diferencia de S1000D, que pasa por BREX 3.0.1 → `brexToSchematron()`). Esto hace que la validación post-generación sea la única red de seguridad real.

- **Opción B**: un único `.sch` combinado por proyecto con múltiples `<sch:pattern>`, cada uno auto-limitado por su propio `context` XPath — no hay detección explícita de tipo de topic; una regla simplemente no dispara si su contexto no existe en el documento validado.
- Mismo patrón de chunking/verificación/reintento/barrido de cobertura que `generateBREX.js` (`CHUNK_SIZE=10`, `MAX_RETRIES=2`), simplificado: como cada chunk solo emite bloques `<sch:pattern>` autocontenidos, no existe el caso especial "chunk 1 = documento completo" de BREX; el ensamblado es un simple array de bloques.
- El header `<sch:schema>` se añade de forma determinista al final (`finalizeSchematronDocument`), nunca lo genera el LLM.
- **Red de seguridad**: si un BRDP no tiene gancho estructural real en DITA, se emite un comentario XML de trazabilidad (mismo patrón real usado para desactivar `BRDP-D1-00089` en el dataset curado) — nunca se fuerza ni se inventa una regla.
- `checkWellFormedSchematron(xml, schemaSummary)` — implementación propia sin `DOMParser` (funciona igual en navegador y en Node, útil para test scripts aislados), con 7 comprobaciones: balance de tags, `<sch:schema>` raíz correcto (namespace + `queryBinding="xslt2"`), ids de `sch:assert`/`sch:report` únicos en TODO el documento, `context` no vacío y patrón XSLT válido (reutiliza `_isSafePattern()`, exportado desde `brexToSchematron.js`), `test` no vacío + cada `sch:rule` con al menos un `sch:assert`/`sch:report`, `role` restringido a valores conocidos, sin placeholders — más un **lint de vocabulario no bloqueante**: compara los nombres de elemento/atributo usados en `context`/`test` contra `vocabulary_by_domain` del schema summary y avisa (sin bloquear) si alguno no está confirmado contra el XSD real.
- `options.callLLM` y `options.schemaSummary` son inyectables (no solo vía `fetch`/`sendMessageStream`), pensado para poder testear el generador de forma aislada fuera de la app.

## AI Extract (`extractBRDPs.js` + `AIExtractModal.jsx`)

Extrae BRDPs desde un documento o texto pegado.

- **Entrada (modo único, sin tipos de documento):** fichero `.docx`/`.pdf` O texto plano pegado. En el modal, `inputMode` ∈ `'file' | 'text'`; si hay `rawText`, tiene prioridad sobre el fichero.
- **Extracción de texto:**
  - DOCX → `mammoth.extractRawText`.
  - PDF → `pdfjs-dist` (paquete npm, NO CDN) con worker local vía Vite (`pdfjs-dist/build/pdf.worker.min.mjs?url`). Importante: NO volver a cargar pdf.js por CDN con `import()` dinámico — la build UMD deja `GlobalWorkerOptions` undefined y rompe la lectura.
- **Pipeline:** texto → chunks (6000 chars, overlap 600) → `buildExtractionPrompt(chunkText)` (prompt único) → `sendMessage` (temp 0.2) → parseo JSON → dedup por similitud → IDs secuenciales `BRDP-EXT-NNNNN`.
- **IDs de origen:** el prompt único pide que, si el texto trae un identificador de regla (`BRDP-S1-...`, `BR002`, etc.), se mencione en el campo `comment` (NO se conserva como id; los ids de salida son automáticos).
- **Validación de texto pegado:** máximo 3000 caracteres (aproximadamente una página). Textos más largos deben subirse como fichero `.docx` o `.pdf`.
- **Errores:** los fallos de chunk NO se tragan en silencio — se registran (`console.error`) y, si no se extrae nada, se propaga el primer error real.

## Patrones a seguir

### Hooks de datos

> ⚠️ **Este patrón viola HR1 del AACF** ("no localStorage/sessionStorage para estado autoritativo o persistente — Postgres es la fuente de verdad"). Se documenta tal cual está implementado hoy, no como recomendación a seguir en código nuevo. Ver "Auditoría de cumplimiento AACF (pendiente)" al final de este fichero — la reconciliación se hace en una ronda dedicada, no de forma ad hoc.

1. Estado inicial desde localStorage (carga instantánea).
2. `useEffect` que hace fetch a la API al montar (fuente de verdad).
3. Saves van a la API + localStorage en paralelo.
4. La interfaz pública del hook no cambia aunque cambie el backend.

NUNCA acceder a localStorage directamente desde componentes — siempre usar los hooks.

### Proxy LLM

El frontend siempre manda a `/api/proxy` en producción. El body tiene esta forma:

```javascript
{ targetEndpoint, apiKey, provider, payload }
```

donde `payload` es el body ya construido. El servidor Express solo añade headers de autenticación y reenvía.

### Base de datos

- Motor: SQLite vía `better-sqlite3` (síncrono), WAL mode.
- Fichero: `data/brdp.db` (ignorado en git).
- Tablas: `brdps`, `config`, `settings`, `notes`.
- Campo `comments` en DB = campo `comment` en frontend (compatibilidad legacy). `GET /api/brdps` devuelve ambos.

### Selectores de versión en GenerateModal

```javascript
const isBREX42 = format === 'BREX — S1000D 4.2';
const isBREX41 = format === 'BREX — S1000D 4.1';
const isBREX301 = format === 'BREX — S1000D 3.0.1';
const isSchS1000D = format === 'Schematron 1.0 — S1000D';
const isSchDITA = format === 'Schematron 1.0 — DITA';
```

Schematron 1.0 se divide en dos formatos independientes en el selector: "Schematron 1.0 — S1000D" (implementado, `generateBREXSch.js`) y "Schematron 1.0 — DITA" (implementado, `generateSchematronDITA.js` — ver "Schematron 1.0 — DITA" arriba). A diferencia de S1000D, DITA no usa `xmllint-wasm` ni validación XSD/DTD en tiempo real (decisión explícita: no es necesaria); la única validación post-generación es `checkWellFormedSchematron()`.

Añadir un nuevo formato BREX requiere: nuevo generador + schema JSON + rama en `handleGenerate()` + actualizar `disabled`/"Coming soon".

### Guardia de validación en el chat

`useChat.js` intercepta en `sendUserMessage()` los mensajes con triggers de cambio de estado (`validationTriggers`) y responde sin llamar al LLM. Segunda capa de restricción en el `basePrompt`.

## Lo que NO está implementado todavía

- S1000D 5.0, 6.0 (selector existe, botón deshabilitado con "Coming soon").
- Botón de migración BREX→Schematron sobre un BREX subido (el motor `brexToSchematron.js` ya está listo; falta la UI).
- Migración automática de localStorage a SQLite en primera ejecución.
- Autenticación (no necesaria para uso local single-user).
- Docker con SQLite (el docker-compose actual usa nginx sin backend).

## Auditoría de cumplimiento AACF (pendiente — no tocar sin luz verde)

Primera pasada de lectura completa del AACF (2026-09-18) contra el código real de `v2-multiproyecto`. Esto son **hallazgos, no fixes** — se abordarán en una ronda dedicada cuando el usuario dé la prioridad; no se ha modificado ningún fichero de código fuente en esta ronda.

### HR1 — localStorage como estado autoritativo (conflicto confirmado)

Contradice tanto la Hard Rule HR1 como `SECURITY_CONTEXT.md` del propio framework ("no data persists in localStorage/sessionStorage — database only"). Afecta a:

- `src/context/BRDPContext.jsx` y `src/hooks/useBRDPs.js` — cachean el dataset completo de BRDPs.
- `src/hooks/useProjectConfig.js` — cachea la config del proyecto.
- `src/hooks/useLocalNotes.js` — notas.
- `src/hooks/useAPIKey.js` + `src/components/AIExtractModal/AIExtractModal.jsx` — **guardan la API key del LLM en localStorage** (además de HR1, roza la gestión de secretos de `ai-output-safety.mdc`: un secreto persistido sin cifrar en el navegador).
- `src/layouts/AppLayout.jsx` (`sidebarCollapsed`) — preferencia de UI pura, probablemente el único caso defendible tal cual (no es "estado autoritativo o persistente" en el sentido de la regla).

El propio patrón "Hooks de datos" de la sección "Patrones a seguir" de este fichero es la causa raíz: documenta explícitamente el patrón que el AACF prohíbe. Al reconciliar: la API (Postgres) debe quedar como única fuente de verdad; localStorage, si se conserva para algo, solo como cache explícitamente no autoritativo (con invalidación clara), nunca como estado del que la app depende para funcionar sin red.

### Otros puntos a revisar (menor prioridad, sin confirmar aún como violación real)

- **HR20 (UI de mutación optimista)** — no verificado todavía si las mutaciones de BRDP reflejan el cambio antes de la respuesta del servidor o esperan al round-trip completo.
- **HR21 (humanizar texto de UI)** — parcialmente cubierto (hay capa i18n real, ver `src/i18n/index.js`), pero no se ha auditado si se renderiza en algún sitio un token crudo (enum, slug, snake_case) sin pasar por humanización.
- **AI Extract / HR6** — el límite de 3000 caracteres en texto pegado es una validación de entrada con escalado explícito al usuario (subir como fichero en su lugar), no un truncado silencioso de contenido de calidad — probablemente conforme con HR6 tal cual está, pero pendiente de una revisión más amplia por si hay otro punto del código que sí trunque contenido en vez de resumir.
- **Design system (`styles/design-system.md`, `ui-kit.md`, `branding.md`)** — el AACF asume shadcn/ui + Tailwind + tokens DTCG (OKLCH) + Zustand como "golden path" de UI; este proyecto no usa nada de eso. No es en sí una violación de una Hard Rule, pero es una divergencia del framework que el usuario debe decidir si adoptar (migración de UI, coste alto) o mantener como excepción documentada.

### Nota de seguridad fuera del alcance de este repo (informativa)

Al leer `aacf/agents/codebase-hardening.agent.md` del repo `cursoFSD` (público en GitHub) se encontró una API key en texto plano embebida en el fichero (`RAG_MCP_KEY` para el MCP de políticas corporativas en `10.117.139.1:8200`). No se ha usado ni se usará esa clave desde aquí. Se avisó directamente al usuario en la conversación; no aplica ninguna acción sobre `brdp-manager`, se deja constancia aquí solo para no perder el hallazgo.
