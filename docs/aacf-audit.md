# Auditoría de cumplimiento AACF — BRDP Manager v2

Rama `v2-multiproyecto`, commit `6e2c671`. Nivel objetivo: **T2** (herramienta interna aprobada por IS).
Marco: AACF 2.0.1, copia local de `Juanma-GA/cursoFSD` (`Proyecto-CCMS-Nav/aacf/`), sin acceso al MCP `aacf_fetch` desde este entorno.

> **Estado tras AACF 1** (rama `v2-multiproyecto`): resueltos HR6 (los tres recortes silenciosos, `e3052f4`), HR7 (frontend: `dd9bbac`, `3fa0c5a`; mensajes saneados del backend: `31d7daf`), HR20 (`dd9bbac`) y el punto 3 del checklist de seguridad (validación de entrada, `1c181d2`). Cada sección afectada lo dice en su sitio; lo que sigue abierto está en "Qué sigue abierto tras AACF 1", al final. El resto del informe describe el código en `6e2c671`.

Auditoría **de solo lectura**: no se ha cambiado código, configuración ni migraciones. Cada afirmación lleva `ruta:línea` comprobada en el código. Lo que no se ha podido comprobar sin ejecutar algo o sin acceder a otro sistema se marca **no comprobado** y se dice qué haría falta. Los tamaños (pequeño / medio / grande) indican el alcance del cambio, no un tiempo (HR14).

---

## Resumen (una página)

### Lo primero

1. **Fallo de permisos explotable: Suggest expone BRDP de proyectos a los que el usuario no tiene acceso.** `GET /api/projects/{id}/brdps/{brdp_id}/similar` solo comprueba el rol en el proyecto propio (`backend/app/api/routes/similar.py:73-83`). Las consultas de precedentes recorren *todos* los proyectos del mismo standard, sin comprobar pertenencia (`similar.py:218, 315, 388, 439, 508, 624, 723`). Devuelven título, Definición, Propuesta, regla y nombre del proyecto. Un usuario con rol viewer en cualquier proyecto S1000D 4.2 puede leer así las decisiones y reglas de los demás clientes de ese standard, y además se envían al LLM dentro del prompt de Suggest. Comparar sí filtra por pertenencia (`brdp_compare.py:89, 141`), así que el comportamiento no es coherente. No se ha corregido.
2. **El repositorio es público y contiene datos de clientes.** `gh api repos/Juanma-GA/brdp-manager` devuelve `visibility: public`. Están versionados el BREX de cliente de Lufthansa (`backend/tests/fixtures/brex/DMC-LHTSTD-A-00-00-00-000A-022A-D_001-00_SX-US.xml`), el BREX "CA" (`DMC-CAAA00000000AAA022AD-001-00-SX-ZZ.xml`), `scripts/prompt-eval/fixtures/lufthansa-extract-sample.xml`, los Schematron de las pruebas DITA (`backend/tests/fixtures/schematron/`) y casos con textos de Lufthansa (`scripts/prompt-eval/cases.json:1254-1257`). `CLAUDE.md:10` cita una IP interna. T2 exige "Data classification: Internal or below only". No se ha encontrado ningún secreto (credencial) en el repo ni en su historial; ver Parte 2.
3. **Las ediciones de Records pueden perderse sin aviso.** Al guardar un campo (`src/pages/RecordsPage.jsx:1420` → `handleUpdate`, `:660-689`), al verificar o revocar una regla (`:865-877`, `:917-928`) o al borrar (`:1014-1027`) no se captura ningún error. Si el servidor rechaza el cambio, la pantalla sigue mostrando el valor nuevo como si se hubiera guardado (HR7, HR20).

### Recuento

| Parte | Cumple | Parcial | No cumple | Desviación a decidir | No aplica |
|---|---|---|---|---|---|
| 1. Hard Rules HR0–HR21 (22) | 5 | 4 | 8 | 2 | 3 |
| 2. Checklist de seguridad web-app (8) | 5 | 1 | 1 | 1 | 0 |
| 3. Guardrails T2 (9) | 1 presente | 4 parciales | 4 ausentes | — | — |

Además, la Parte 2 recoge 8 hallazgos de seguridad fuera del checklist, la Parte 4 siete desviaciones de plantilla y diseño (todas a decidir) y la Parte 5 nueve violaciones sistemáticas.

### Bloqueantes para T2 (técnicos)

Permisos de `/similar` · clasificación de datos del repo · rate limiting y cuotas del LLM · registro de auditoría de acciones administrativas y de IA · CI con gates de seguridad · protección de `main`. Los trámites ATEXIS (IdAI, revisión IS, formación…) van aparte, en la Parte 3, sin veredicto.

---

## Parte 1 — Hard Rules HR0–HR21

`rules/atexis-hard-rules.md` define HR0–HR11, HR13–HR16 y HR18–HR21. **HR12 y HR17 no aparecen en el fichero**; se marcan "no aplica (no definida)" y quedan como pregunta.

| Regla | Veredicto | Evidencia | Qué haría falta | Tamaño |
|---|---|---|---|---|
| HR0 Config con UI de administración | **NO CUMPLE** | 23 ajustes en `backend/app/core/config.py:20-77`, sin UI de administración: Settings solo tiene Perfil, Usuarios y Papelera (`src/pages/SettingsPage.jsx:799-801`); `/api/config/ai-provider` es de solo lectura (`backend/app/api/routes/config.py:20-29`) y ya no se muestra en ninguna página. Los ajustes funcionales del frontend son constantes de código, no configuración (ver HR8). | Una sección de administración, al menos de solo lectura, con los ajustes funcionales (límites, umbrales, proveedor y modelo). Los secretos y la infraestructura (`database_url`, claves, rutas de claves JWT) no deberían editarse desde la UI: ver Decisión 4. | grande |
| HR1 Sin almacenamiento del navegador | **DESVIACIÓN A DECIDIR** | Solo quedan tres preferencias de interfaz: `src/layouts/AppLayout.jsx:22,29` (barra lateral plegada), `src/hooks/useResizableSplit.js:19-29` (ancho del panel), `src/pages/RecordsPage.jsx:261,268` (Historial abierto, `sessionStorage`). El access token vive en memoria (`src/context/AuthContext.jsx:22,28-32`); el refresh token, en una cookie HttpOnly (`backend/app/api/routes/auth.py:30-41`). Ningún estado autoritativo en el navegador. HR1 prohíbe "authoritative or persistent state"; `rules/javascript.mdc` prohíbe localStorage y sessionStorage sin excepción. | Si no se acepta la excepción: guardar las preferencias en `users`, como ya se hace con `preferred_language`. | pequeño |
| HR2 Arreglar y probar todo | CUMPLE (proceso) | Lint con 0 errores y 58 avisos (`npm run lint`, ejecutado hoy); suite backend y scripts de verificación por ronda. Abierto y documentado: `scripts/verify-suggest-rule.mjs:432` figuraba como fallido en la ronda de envoltorios; **no comprobado** si sigue fallando (habría que ejecutarlo con los simuladores). | — | — |
| HR3 Verificar contra el código | CUMPLE (proceso) | Este informe. | — | — |
| HR4 No simplificar en silencio | CUMPLE (proceso) | Los bloqueos están documentados en `CLAUDE.md`: s1kd-brexcheck sin poder instalarse aquí, `cdn.sheetjs.com` bloqueado. | — | — |
| HR5 Despliegue por procedimiento | **NO CUMPLE** | `Dockerfile:1-23` y `docker-compose.yml` solo construyen y sirven el frontend con nginx (`nginx.conf`, sin proxy a `/api`). No hay procedimiento de despliegue del backend FastAPI ni de Postgres. | Compose con frontend, backend, Postgres con pgvector y `alembic upgrade head`; nginx con proxy `/api`. | medio |
| HR6 Sin truncar contenido | **RESUELTO** (`e3052f4`; antes NO CUMPLE) | Ver tabla 1.3. Dos recortes silenciosos de contenido que ve el usuario (`backend/app/services/text_extract.py:117,170`) y un tope silencioso de resultados (`src/components/compare/BrdpCompareDialog.jsx:293`). El resto son recortes marcados de entradas para modelos. | Quitar los recortes silenciosos o decir lo que se ha cortado. Para las entradas de modelo, ver Decisión 10. | pequeño |
| HR7 Sin fallbacks silenciosos | **RESUELTO** (`dd9bbac`, `3fa0c5a`, `31d7daf`; antes NO CUMPLE; `schemaFacts.js` aceptado) | Ver tabla 1.4. En el backend, los trabajos y servicios escalan bien. En el frontend hay 9 puntos que degradan en silencio, entre ellos el guardado de campos de Records. | Mostrar el error y deshacer el cambio local en cada punto. | medio |
| HR8 Nada hardcodeado | **NO CUMPLE** | Ver tabla 1.5. Los ajustes del backend están bien en `Settings`, pero umbrales, lotes, reintentos, temperaturas y tiempos son constantes repartidas por el código (alguna triplicada). | Pasar los ajustes funcionales a `Settings` y servirlos al frontend. Ver Decisión 4. | medio |
| HR9 Borrar solo con confirmación registrada | PARCIAL | Ver tabla 1.6. Las BRDP se borran con borrado lógico, confirmación y registro en el historial. En cambio, proyecto, usuario, borrado permanente desde la Papelera y quitar un rol se borran de verdad y no quedan registrados; quitar un rol ni siquiera pide confirmación. | Registro de auditoría de esos borrados y confirmación al quitar un rol. Si se quiere, borrado lógico de proyectos (Decisión 13). | medio |
| HR10 Deep-merge | CUMPLE | `project_config` es plano (`backend/app/api/routes/projects.py:106-113`). Al crear: `{**defaults, **body}` sobre un dict plano (`:135`). Al editar se sustituye entero desde el estado completo del cliente (`projects.py:195`, `src/pages/ProjectConfigPage.jsx:774,831-835`). No hay ninguna configuración anidada. Nota: con dos editores a la vez, gana el último (sin merge). | — | — |
| HR11 Sin regex para decisiones críticas | **DESVIACIÓN A DECIDIR** | Ver tabla 1.7. Principio del proyecto: "lo que puede comprobar el código, lo comprueba el código". La mayoría de las expresiones son mecánicas (sintaxis de identificadores y de huecos); cuatro toman decisiones semánticas. | Decisiones 6 y 7. | — |
| HR12 | NO APLICA | No está definida en `atexis-hard-rules.md`. | Confirmar contra la versión del MCP (Decisión 15). | — |
| HR13 Sin código heredado ni duplicado | **NO CUMPLE** | Ver tabla 1.8. Las ramas few-shot que el Barrido 4 dejó como dudosas son inalcanzables; hay además código duplicado (helpers de trabajos triplicados, `RULE_STATUS_LABELS` ×3), un endpoint sin llamador y herramientas sin uso. | Borrar o unificar. | pequeño |
| HR14 Sin estimaciones | CUMPLE (proceso) | — | — | — |
| HR15 Textos localizables | PARCIAL | Hay capa i18n (`src/i18n/index.js`) y el JSX no tiene literales sueltos (búsqueda sin resultados). Pero: `src/components/compare/BrdpCompareDialog.jsx:96` escribe "context:" y "test:" en inglés; el backend da el origen como "Records: <proyecto>" o "Catalog" (`similar.py:262`), que se pinta tal cual (`src/components/assistant/ReferenceRow.jsx:40`); los `detail` del backend en inglés llegan a pantalla con `err.message` (por ejemplo `backend/app/api/routes/brdps.py:237`); el informe es inglés fijo (`src/api/buildBREXdocReport.js:73,134-135`). | Traducir esas cadenas y devolver códigos en lugar de texto desde el backend, como ya hacen el import y el test de reglas. El informe y las cabeceras del Excel: Decisión 14. | medio |
| HR16 Un despliegue a la vez | NO APLICA | No hay procedimiento de despliegue (HR5). | — | — |
| HR17 | NO APLICA | No está definida en `atexis-hard-rules.md`. | Decisión 15. | — |
| HR18 Sin timeouts duros en procesos agénticos | PARCIAL | Ver tabla 1.9. Los trabajos tienen vigilancia que escala (60 min → `failed` con mensaje). El proxy del LLM no tiene ningún límite ni vigilancia (`backend/app/api/routes/llm_proxy.py:63`, `timeout=None`; sin `AbortController` en `src/api/llmAPI.js`): una petición colgada deja la pantalla esperando indefinidamente. | Vigilancia con aviso en el proxy del LLM y en el cliente. | pequeño |
| HR19 Igual que HR18 | PARCIAL | Ídem. | Ídem. | pequeño |
| HR20 UI de mutación optimista | **RESUELTO** (`dd9bbac`; antes NO CUMPLE) | Ver tabla 1.10. Los campos de texto de Records se ven al momento pero no se deshacen si el guardado falla. El estado de la Propuesta, Verify y Revoke esperan a la respuesta pese a que el resultado se conoce de antemano. AI Extract sí cumple (con deshacer). | Aplicar el cambio al momento y deshacerlo si el servidor lo rechaza, como ya hace AI Extract. | medio |
| HR21 Humanizar textos | **NO CUMPLE** | `src/components/Header.jsx:30` muestra `user.global_role` crudo ("admin"/"user"); `BrdpCompareDialog.jsx:96` muestra `p.kind` (assert/report: son nombres de elemento XML, aceptables) y las etiquetas en inglés de HR15. | Traducir el rol. | pequeño |
| Extra: FastAPI y `from __future__ import annotations` | CUMPLE | Solo aparece en servicios (`app/services/rule_extract.py`, `rule_extract_jobs.py`, `text_extract.py`), ningún fichero de `app/api/routes/` lo usa. | — | — |

### 1.1 HR0 — ajustes y dónde se configuran

| Ajuste | Dónde | UI de administración |
|---|---|---|
| `environment`, `database_url`, `jwt_*_key_path`, `access_token_expire_minutes`, `refresh_token_expire_days`, `initial_admin_*` | `config.py:22-34` (env) | No |
| `active_llm_provider`, `mistral_*` (clave, endpoint, modelo, embeddings), `qwen_*` | `config.py:40-50` (env) | No. El proveedor y el modelo se leen en `/api/config/ai-provider` sin mostrarse |
| `cors_origins`, `sources_dir` | `config.py:53,59` | No |
| `excel_import_max_*` (3), `rule_extract_max_bytes`, `extract_text_max_words/chars` | `config.py:65-77` | No (los límites de texto se sirven en `GET …/ai-extract/limits`, `rule_extract.py:168-172`, y se muestran en el contador) |
| Temperaturas y `max_tokens` de cada uso del LLM | `src/prompts/shared.js:25-56`, `src/api/llmAPI.js:6` | No (constantes) |
| Lotes y concurrencia de AI Extract | `src/utils/ruleExtractDraft.js:15-16` | No (constantes) |
| Umbrales de similitud | `similar.py:29` (0,5), `rule_extract_jobs.py:736` (0,9) | No (constantes) |

### 1.2 HR1 — autenticación y almacenamiento (punto 13)

| Aspecto | Estado | Evidencia |
|---|---|---|
| Access token | En memoria (estado de React + ref), nunca en almacenamiento | `src/context/AuthContext.jsx:22,28-32`; `src/services/apiClient.js:14-16` |
| Refresh token | Cookie HttpOnly, `SameSite=lax`, `path=/api/auth`; `Secure` solo con `environment=production` | `auth.py:27-41` |
| Rotación del refresh | Sí: el token usado se revoca y se emite otro | `auth.py:100-104` |
| Reutilización de un refresh revocado | Devuelve 401, pero no revoca la familia de tokens (no detecta el robo) | `auth.py:91-92` |
| Logout | Revoca el refresh en el servidor y borra la cookie. El access token sigue siendo válido hasta que caduca (45 min por defecto) | `auth.py:107-120`, `config.py:29` |
| Cambio de contraseña | Revoca las demás sesiones | `auth.py:173-185` |
| `must_change_password` | Solo lo exige el frontend (`src/components/ChangePasswordForm.jsx:96`); la API acepta cualquier llamada con la contraseña temporal | `auth.py:171`, sin comprobación en `deps.py:19-50` |
| Estado autoritativo fuera de Postgres | Ninguno. El bloqueo por intentos de login vive en memoria del proceso (ver Parte 2.7) | `backend/app/core/rate_limit.py:19` |

### 1.3 HR6 — puntos de recorte

| Punto | Qué se corta | ¿Avisa? | Tipo |
|---|---|---|---|
| `text_extract.py:170` | La cita de texto libre se guarda cortada a 4 000 caracteres (`MAX_QUOTE_CHARS`, `:46`); el esquema admite 20 000 (`schemas/rule_extract.py:102`). Se muestra y queda en History | **No, silencioso** | contenido de usuario → NO CUMPLE |
| `text_extract.py:117` | Título propuesto cortado a 300 | **No, silencioso** | contenido mostrado → NO CUMPLE |
| `BrdpCompareDialog.jsx:293` | Resultados de búsqueda de Comparar limitados a 50 sin "+N" | **No, silencioso** | NO CUMPLE |
| `backend/app/services/embeddings.py:84-100` + `embedding_jobs.py:287-291` | Texto que se embebe, a unos 24 000 caracteres | Marcador en el texto enviado y aviso en el log; el usuario no lo ve | entrada de modelo → desviación |
| `src/prompts/shared.js:63-68` | Regla en Ask, a 6 000 caracteres | Marcador para el LLM; el usuario no lo ve | entrada de modelo → desviación |
| `rule_extract.py:97-131, 859-888, 941-947` | Resúmenes de reglas para AI Extract (rutas, valores, reglas detalladas, vista previa) | Marcadores "… [N more characters]", `rules_more`, "+N more" | entrada de modelo marcada → desviación |
| `schema_cards.py:33-61` | Fichas de esquema (hijos 40, atributos 30, enum 20, padres 60) | "(partial list: N of M)" en el prompt y en la UI; la navegación pide `full=true` | marcado → cumple la intención |
| `RecordsPage.jsx:111` | History a 160 caracteres | "Ver más" con el texto completo | presentación → cumple |
| `RuleExtractSection.jsx:106,223` | Rutas a 120 y cita a 90 en la tabla | Plegable o con "…"; el texto completo está en la fila | presentación → cumple |
| `llmAPI.js:6`, `shared.js:47,51` | `max_tokens` 4 000 / 16 000 / 8 000 | El corte se detecta y se muestra (`src/api/llmTruncation.js`) | El AACF prefiere JSON guiado (Decisión 11) |
| `excel_io.py:76` | Celda de más de 32 767 caracteres | Export rechazado con el motivo | cumple |
| `config.py:75-77` | Texto libre de más de 5 000 palabras | Rechazado, nunca cortado | cumple |

**AACF 1 (`e3052f4`)**: la cita se guarda entera (límite `Settings.extract_quote_max_chars`, 20 000; una cita más larga deja fuera esa decisión con un aviso de fichero que la nombra) y se muestra plegada con "Ver más"; el título se guarda entero y, por encima del límite de Título de una BRDP, la fila lleva "Título demasiado largo: acórtalo" y no se importa hasta acortarlo (409 `texts_too_long` en el servidor); Comparar muestra "50 de N" y "Mostrar más". Los recortes marcados de entradas a modelos se aceptan (Decisión 10).

### 1.4 HR7 — degradaciones silenciosas

| Punto | Qué pasa si falla |
|---|---|
| `RecordsPage.jsx:660-689` (+ `onBlur` en `:1420` y similares) | Guardar Título, Definición, Propuesta o motivo: sin `catch`. El valor nuevo se queda en pantalla y no se guardó |
| `RecordsPage.jsx:865-877`, `:917-928` | Verify y Revoke: `try/finally` sin `catch`; ningún mensaje |
| `RecordsPage.jsx:1014-1027` | Borrar BRDP: sin `catch` |
| `src/pages/ProjectsPage.jsx:202` (texto en `:226-228`) | Si falla el recuento, el diálogo de borrar proyecto dice "0 BRDP" justo antes de una acción destructiva |
| `RecordsPage.jsx:616` | Si fallan las aprobaciones, todas las BRDP aparecen como "To Do" |
| `RecordsPage.jsx:491` | Si fallan las cifras de cabecera, se quedan como estaban |
| `src/api/schemaFacts.js:18` | Ask sigue sin fichas de esquema y sin decirlo (documentado como intencionado) |
| `src/layouts/ProjectLayout.jsx:36` | Cualquier error, también de red, se muestra como "sin acceso" |
| `src/hooks/useVocabularyCheck.js:34`, `RecordsPage.jsx:949` | Si falla la carga del vocabulario o del catálogo, se muestra "no disponible" o una lista vacía |

**AACF 1**: todos los puntos de la tabla resueltos salvo `schemaFacts.js` (aceptado tal cual: Ask sigue sin fichas si fallan, Decisión del encargo). Records: los campos guardan lo escrito y lo marcan "No guardado" con el motivo, Reintentar y Descartar; Verify, Revoke, estado de la Propuesta y borrar se deshacen con el motivo (`dd9bbac`). Aprobaciones y cifras de cabecera: aviso con Reintentar y sin estado inventado (`dd9bbac`). Borrar proyecto: nunca "0 BRDP" y no se confirma sin recuento; ProjectLayout distingue "sin acceso" de "no se pudo conectar"; vocabulario y catálogo dicen que la carga falló, con Reintentar (`3fa0c5a`). Un único mecanismo de error (`src/components/ErrorNotice.jsx`, `role="alert"`).

Backend: los trabajos convierten cualquier excepción en `failed` con su motivo (`import_jobs.py:735-760`, `embedding_jobs.py:348-370`, `rule_extract_jobs.py:934-945`), y el proxy del LLM registra los errores (`llm_proxy.py:65-97`). Cumple.

### 1.5 HR8 — números y cadenas fijos

| Constante | Dónde | ¿Configurable? |
|---|---|---|
| `STALE_JOB_MINUTES = 60` (×3) | `import_jobs.py:96`, `embedding_jobs.py:96`, `rule_extract_jobs.py:90` | No |
| `EMBED_BATCH_SIZE = 32` (×2) | `embedding_jobs.py:82`, `rule_extract_jobs.py:92` | No |
| `_MAX_429_RETRIES = 5`, `timeout=60.0` | `embeddings.py:177,195` | No |
| `MIN_SIMILARITY = 0.5`, `REPETITION_SIMILARITY = 0.9` | `similar.py:29`, `rule_extract_jobs.py:736` | No |
| Intentos de login 5 en 15 min | `rate_limit.py:16-17` | No |
| Topes de las fichas | `schema_cards.py:33-61` | No |
| `MAX_TITLE_CHARS`, `MAX_QUOTE_CHARS` | `text_extract.py:45-46` | No |
| Temperaturas y `max_tokens` | `src/prompts/shared.js:25-56` | No |
| Lote 10, concurrencia 3 | `src/utils/ruleExtractDraft.js:15-16` | No |
| Sondeo 3 s / 1 s | `src/hooks/useImportJob.js:9`, `useEmbeddingJob.js:7`, `RuleExtractSection.jsx:52` | No |
| `SCHEMA_NAV_TIMEOUT_MS = 20000` | `src/utils/schemaNavigation.js:171` | No |
| Longitud mínima de contraseña 8 | `src/components/ChangePasswordForm.jsx:46` y `backend/app/schemas/auth.py:67` | No (duplicada) |
| URLs `http://www.s1000d.org/S1000D_x-y/xml_schema_*` | `src/utils/ruleSchemaContext.js` | Son identificadores fijados por el estándar, no configuración. Se proponen como excepción |

### 1.6 HR9 — borrados

| Operación | Tipo | Confirmación | ¿Queda registro? |
|---|---|---|---|
| Borrar BRDP (`brdps.py:282-301`) | lógico (Papelera) | `window.confirm` (`RecordsPage.jsx:1015`) | Sí, en History (`brdps.py:300`) |
| Reset Data (`brdps.py:304-334`) | lógico | diálogo (`ProjectConfigPage.jsx:695-712`) | Sí, una entrada por BRDP |
| Borrado permanente desde la Papelera (`trash.py:116-159`) | real | modal "irreversible" (`SettingsPage.jsx:758-767`) | **No.** History sobrevive (`ON DELETE SET NULL`), pero no queda constancia del borrado |
| Borrar proyecto (`projects.py:225-244`) | real, en cascada | escribir el nombre (`ProjectsPage.jsx:205-212`) | **No** |
| Borrar usuario (`users.py:145-186`) | real | `window.confirm` (`SettingsPage.jsx:263`) | **No** |
| Quitar rol de proyecto (`users.py:214`) | real | **ninguna** (`SettingsPage.jsx:223-226`) | **No** |
| Descartar aprobación (`approvals.py:457-475`) | real, sin History | — | **No.** No tiene llamador en el frontend (HR13) |
| Nueva extracción con otra sin importar | sustituye las candidatas | `window.confirm` (`RuleExtractSection.jsx:519`) | Datos de trabajo, no hace falta |
| Migración `0024_drop_notes` | real (tabla) | — | **no comprobado** si en la base de Juanma había notas: habría que consultar `notes` en un backup previo |
| `normalize_rule_wrappers.py` | reescribe reglas | `--dry-run` | Sí, en History |

### 1.7 HR11 — expresiones regulares que deciden algo

| Expresión | Dónde | Qué decide | Mecánica o semántica |
|---|---|---|---|
| `UNFILLED_MARKER_RE` (×2, en sincronía) | `src/utils/proposalMarkers.js:18`, `similar.py:57` | Bloquea Suggest Rule (400) si la Propuesta tiene huecos | mecánica (sintaxis de corchetes) |
| `_ID_RE`, `DEFAULT_RULE_RE`, `_COMMENT_ID_RE`, `_MARKED_IDENTIFIER_RE` | `rule_extract.py:143,148,448`, `rule_extract_jobs.py:291` | Identificador de origen y clasificación de AI Extract | mecánica (formato de identificador) |
| Detección de preguntas estructurales (`NOT_STRUCTURAL`, patrones) | `src/utils/structuralAnswer.js:69-117, 251` | Si una pregunta de Ask se responde sin IA | **semántica** (intención de la pregunta). Mitigación: la respuesta va etiquetada "sin IA" y la ficha está debajo |
| `_NO_CONTENT_RE` | `rule_extract.py:151` | Clasifica como "Sin contenido" (desmarcada) | **semántica** (frases en inglés). Mitigación: visible y se puede cambiar |
| `_ATTRIBUTION_RE` | `rule_extract.py:159` | Quita "Decision by …" para usar el objectUse como Propuesta | **semántica** |
| `ES_HINT`/`EN_HINT`/`PROTECTED_RE` | `src/utils/answerCleanup.js:26-73` | Reescribe "SCHEMA FACTS" en la respuesta mostrada según el idioma deducido | **semántica** (modifica la salida del LLM) |
| `MUST_NOT_RE` | `src/utils/ruleLint.js:51` | Aviso de "dice must not pero lo permite" | semántica, pero solo es un aviso |
| `SCHEMA_MENTION_MAP` | `src/utils/ruleSchemaContext.js:198` | Esquemas marcados de antemano en el selector | semántica, pero el usuario confirma |
| Extracción de nombres (disparadores, camelCase) | `src/validation/schemaValidation.js` | Avisos de vocabulario | heurística; solo avisa |

### 1.8 HR13 — código sin uso y duplicado

| Elemento | Evidencia |
|---|---|
| Ramas few-shot de `buildDeterministicBlockFromFewShot`, `BRDP_00313_LITERAL`, `renderSchLets`, `renderMessage` | `src/api/generateSchematronDITA.js:41-92`. El único llamador (`:914`) pasa entradas de aprobación, y `rule_xml` es `NOT NULL` (`backend/app/models/rule_approval.py:24`), así que siempre sale por `:82`. Inalcanzable |
| Claves `structure` / `generation_rules` | `public/brex-schema-summary-{4-2,4-1,3-0-1}.json`. Ningún código las lee; solo se citan en comentarios (`generateBREX.js:373`, `generateBREX41.js:244`) |
| `RULE_STATUS_LABELS` ×3 | Exportada en `src/prompts/shared.js:13` y copiada en `src/pages/ProjectConfigPage.jsx:30` y `GenerateBREXdocPage.jsx:16` |
| `_reap_if_stale` ×3, `STALE_JOB_MINUTES` ×3, `EMBED_BATCH_SIZE` ×2 | ver 1.5 y `import_jobs.py:100`, `embedding_jobs.py:165`, `rule_extract_jobs.py:838` |
| `_require_admin` ×2, `_get_job_in_project` ×2 | `users.py:26`/`projects.py:17`; `embedding_jobs.py:121`/`brdp_import.py:112` |
| `DELETE …/approvals/{format}` sin llamador | `approvals.py:457`; ninguna llamada `DELETE` a `approvals` en `src/` |
| Campo `history` de BRDP (v1) | `backend/app/models/brdp.py:59`, `backend/app/schemas/brdp.py:14,28,44`. El frontend no lo usa y cualquier editor lo puede escribir sin validar |
| Herramientas de TypeScript sin ficheros TS | `package.json` (`type-check`, `typescript`, `typescript-eslint`), `tsconfig*.json`; ningún `.ts`/`.tsx` en `src/` |
| Tailwind sin uso visible | `src/index.css:1-3`, `postcss.config.js`, `tailwind.config.js`; el CSS compilado lleva la cabecera "tailwindcss v4.2.4" (`dist/assets/index-*.css`), pero no se encontraron clases utilitarias en el JSX (la UI usa CSS Modules) |
| Gemelos intencionados (no cuentan) | `wrap_rule_xml`, `rule_wrappers`, `rule_format_check` (Python y JS, porque se ejecutan en dos sitios distintos); `escapeHtml` ×2 (`buildBREXdocReport.js`, la SPA y el HTML exportado) |

### 1.9 HR18/HR19 — tiempos, reintentos y sondeos

| Mecanismo | Dónde | ¿Avisa y escala? |
|---|---|---|
| Trabajo inactivo > 60 min → `failed` con mensaje | `import_jobs.py:96-111`, `embedding_jobs.py:165-175`, `rule_extract_jobs.py:838-845` | Sí (vigilancia) |
| 429 con hasta 5 reintentos, luego error visible | `embeddings.py:177-215` | Sí |
| Timeout de 60 s en embeddings | `embeddings.py:195` | Error visible |
| Proxy del LLM sin límite | `llm_proxy.py:63` | **No**: ni límite ni vigilancia. El cliente tampoco aborta (`llmAPI.js`) |
| Una ronda de corrección en el test de reglas | `src/utils/ruleTestRun.js` | Sí ("X de Y corregidos") |
| Un reintento por lote en AI Extract, luego "fallido" | `src/utils/ruleExtractDraft.js` | Sí |
| Texto libre dividido una vez si se corta | `src/prompts/extractFromTextPrompt.js` + `RuleExtractSection.jsx` | Sí (error con "Reintentar") |
| `PATH_SEARCH_BUDGET = 50000` | `src/utils/schemaPlacement.js:40` | Cuenta como "varios caminos": no recoloca y va a la corrección. Sin pérdida |
| Sondeo de trabajos sin tope | `useImportJob.js:34`, `useEmbeddingJob.js:45`, `RuleExtractSection.jsx:380-392` | El servidor marca `failed` a los 60 min |
| Tiempo máximo de la ficha de navegación (20 s) | `schemaNavigation.js:171-176` | Error con "Reintentar" |

### 1.10 HR20 — mutaciones de la interfaz

| Mutación | ¿Optimista? | ¿Resultado calculado en el servidor? |
|---|---|---|
| Campos de texto de Records | Se ven al momento (`RecordsPage.jsx:1418-1531`); **sin deshacer si falla** | No |
| Estado de la Propuesta (`RecordsPage.jsx:1504`) | No: espera a `refresh()` | No (debería ser optimista) |
| Verify / Revoke (`:865-928`) | No | No (debería serlo) |
| Borrar BRDP, restaurar y borrar en la Papelera | No | No |
| Crear BRDP o proyecto | No | Sí (id del servidor): excepción válida |
| Guardar configuración del proyecto | No (botón ocupado y luego verde) | No; decisión de diseño de C3b |
| Edición de candidatas de AI Extract | **Sí, con deshacer por campo** (`RuleExtractSection.jsx:395-420`) | — |
| Usuarios y roles | No | Contraseña temporal: sí; roles: no |

**AACF 1 (`dd9bbac`)**: campos de texto con deshacer ("No guardado" + Descartar; la tabla muestra el valor guardado), estado de la Propuesta, Verify, Revoke y borrar BRDP optimistas con deshacer y el motivo; restaurar y borrar en la Papelera también. Verify es optimista porque el cliente conoce el resultado (`approved`). Crear BRDP o proyecto y guardar la configuración siguen como estaban (excepciones válidas o decisión de diseño). Usuarios y roles no se han tocado (fuera del encargo).

---

## Parte 2 — Seguridad

### 2.1 Checklist de `templates/web-app.md`

| # | Punto | Veredicto | Evidencia | Qué haría falta | Tamaño |
|---|---|---|---|---|---|
| 1 | OIDC | **DESVIACIÓN A DECIDIR** | Autenticación propia: JWT RS256 y bcrypt (`backend/app/core/security.py:54-115`, `auth.py`). Sin Keycloak | Decisión 8 | grande |
| 2 | CORS restringido | CUMPLE | Orígenes explícitos (`config.py:53`, `main.py:39-45`) con `allow_credentials` | — | — |
| 3 | Validación de entrada | **RESUELTO** (`1c181d2`; antes PARCIAL; quedan `must_change_password` y las claves desconocidas de `project_config`, ver al final) | Pydantic en todos los cuerpos y límites en las subidas (`config.py:65-77`). Pero: `BRDPCreate.validation` es un `str` libre, sin `Literal` ni `CHECK` (`schemas/brdp.py:12`, `models/brdp.py:57`); textos sin longitud máxima; `history` escribible (`schemas/brdp.py:14,28`); `ProjectCreate.standard` sin comprobar contra la lista (`projects.py:116-139`); `project_config` es un dict libre; el `payload` del proxy del LLM es libre, así que el cliente elige modelo, `max_tokens` y cualquier parámetro (`llm_proxy.py:17-23`); `must_change_password` no se aplica en el servidor (1.2) | `Literal` y longitudes, quitar `history`, validar el standard, fijar modelo y `max_tokens` en el servidor | pequeño |
| 4 | SQL parametrizado | CUMPLE | ORM; `text()` solo con constantes (`main.py:82`, `core/migrations.py:31`); las f-strings de las migraciones usan nombres de tabla del propio código (`0012…:78`, `0013…:75`) | — | — |
| 5 | XSS | CUMPLE | Sin `dangerouslySetInnerHTML` ni `eval`. ReactMarkdown sin `rehype-raw` (`RecordsPage.jsx:1787-1791`). El informe escapa todo lo que inserta (`buildBREXdocReport.js:28, 217-226`) | — | — |
| 6 | CSRF | CUMPLE | La API usa el token en una cabecera, no cookies. La cookie de refresh es `SameSite=lax` y solo va a `/api/auth` (`auth.py:27-41`) | — | — |
| 7 | Rate limiting en endpoints sensibles | **NO CUMPLE** | Solo el login, en memoria de cada proceso y por email (`rate_limit.py:16-34`): no se comparte entre workers, se pierde al reiniciar y permite bloquear la cuenta de otro. Nada en `/api/llm-proxy`, embeddings, subidas ni AI Extract | Limitador compartido (Postgres o Redis) y cuotas por usuario (G12) | medio |
| 8 | Secretos en variables de entorno | CUMPLE | `config.py:31-48`; `.env` y `keys/` en `.gitignore` (`.gitignore`, `backend/.gitignore`). Búsqueda de patrones de secreto en todo el historial: sin resultados. La contraseña de desarrollo `AdminTest123!` está en 74 ficheros versionados (scripts, tests, seed): es solo de desarrollo, pero `backend/scripts/seed_dev_data.py` la crearía si se ejecutara en producción | — | — |

### 2.2 Hallazgos fuera del checklist

| Hallazgo | Evidencia | Gravedad |
|---|---|---|
| **Suggest lee otros proyectos sin permiso** | `similar.py:73-83` y las consultas citadas en el resumen; Comparar sí filtra (`brdp_compare.py:89,141`) | **alta, explotable** |
| **Repositorio público con datos de clientes e IP interna** | ver resumen, punto 2 | **alta** (clasificación de datos) |
| Proxy del LLM abierto a cualquier usuario autenticado, también sin proyectos, con `payload` libre, sin cuota y sin registro | `llm_proxy.py:49-55` | media |
| ~~Los mensajes de error de AI Extract incluyen el texto de la excepción y la primera línea del error de base de datos~~ **Resuelto** (`31d7daf`): código estable y referencia; el detalle, en el log | `rule_extract.py:87-99, 102-116` (Decisión 12) | baja |
| ~~El proxy devuelve al cliente el cuerpo del error del proveedor~~ **Resuelto** (`1c181d2`): código y referencia; el cuerpo, en el log | `llm_proxy.py:85-96` | baja |
| `/health` sin autenticación muestra la versión de migración | `main.py:80-84` | baja |
| El access token sigue valiendo tras el logout; un refresh reutilizado no revoca la familia | 1.2 | baja |
| `/docs` y `/openapi.json` abiertos (por defecto de FastAPI) | `main.py:33` | baja (cumple la Global Rule 9) |
| Fuera de este repo: `aacf/agents/codebase-hardening.agent.md` del repo público `cursoFSD` lleva una clave en texto plano (no se usa ni se copia aquí; ya avisado) | — | informativa |

### 2.3 `rules/security.mdc` y `rules/ai-output-safety.mdc`

| Tema | Estado | Evidencia |
|---|---|---|
| **Texto externo en prompts** (BREX, Schematron, Excel, PDF, Word, texto libre) | Puede contener instrucciones. Qué lo limita: el texto libre va entre `<<<TEXT` y `TEXT>>>` y se declara como datos (`extractFromTextPrompt.js:42-44`); de BREX y Schematron se envían resúmenes hechos por código, aunque objectUse, nonContextRule y comentarios van literales (`rule_extract.py:851-1037`); las BRDP importadas entran literales en Ask y Suggest (`src/prompts/askPrompt.js`). La salida solo puede ser texto o JSON con la forma validada (`src/prompts/llmJson.js` y sus parsers); las citas se comprueban contra el texto (`text_extract.py`); la clasificación la hace el código; todo pasa por revisión humana antes de importarse; el modelo no tiene herramientas. Hay un caso eval de inyección (`scripts/prompt-eval/cases.json:3365`). | PARCIAL: la defensa es de sistema, como pide el AACF |
| **Salida del LLM** | Se pinta como texto de React o con ReactMarkdown seguro. La regla XML tiene que estar bien formada y ser del formato para guardarse (`approvals.py:168, 210`, 422). El XPath se ejecuta con fontoxpath en el navegador, sobre documentos sintéticos; `doc()`, `document()` y similares no se ejecutan (`ruleTestEngine.js:164`). Una regla sugerida se guarda como Draft y la acepta una persona. Sin `eval`. | CUMPLE |
| **Clave del LLM** | Solo en el servidor (`config.py:41,48`). El cliente nunca la envía ni la recibe (`llm_proxy.py:17-23`). Los logs registran el endpoint y el cuerpo del error, nunca las cabeceras (`llm_proxy.py:69-95`, `embeddings.py:191-192`). | CUMPLE |
| **Datos de cliente hacia un modelo externo (LLM02)** | El endpoint por defecto es la API pública de Mistral (`config.py:41,46`). Los prompts llevan decisiones y reglas de los proyectos y, por el punto anterior, de otros proyectos. Embeddings y chat comparten residencia (`embeddings.py:138-146`). | Decisión 3 |
| **JSON guiado** | No se usa `response_format`; se piden JSON en el prompt y se leen con un lector tolerante (`src/prompts/llmJson.js`). | Decisión 11 |
| **Permisos** | Todo endpoint con `project_id` en la ruta usa `require_project_role` (`backend/app/api/deps.py:75-99`). Los globales con solo `get_current_user`: fichas de esquema y catálogo (datos públicos), plantilla Excel, `llm-proxy` (ver 2.2), `validate-brex`, `suggestion-feedback` y Papelera (estos dos comprueban el rol dentro: `suggestion_feedback.py:43-45`, `trash.py:57-66, 89-90, 128-129, 158-160`). Los recursos se comprueban contra su proyecto (`brdp_repository.py:150-159`, `embedding_jobs.py:121-124`, `brdp_import.py:112-115`, `rule_extract.py:131`). **La excepción es `/similar`.** | — |

---

## Parte 3 — Guardrails T2

| Guardrail | Estado | Qué hay | Qué falta |
|---|---|---|---|
| G1 Pre-commit hooks | **AUSENTE** | No hay `.pre-commit-config.yaml`, husky ni hooks (`.git/hooks` solo tiene `*.sample`) | Hook con detección de secretos, eslint y ruff, que pueda rechazar el commit |
| G2 Secret scanning como gate | PARCIAL | GitHub secret scanning y push protection activados (API del repo) | detect-secrets o Gitleaks en commit y en CI |
| G3 Dependencias | PARCIAL | `package-lock.json` versionado; `playwright-core` fijado; `npm audit` 0 | `npm ci` en el `Dockerfile:7` (hoy `npm install`); lockfile de Python (`pyproject.toml:6-24` solo tiene `>=`); SBOM; allowlist y periodo de espera; declarar **`@xmldom/xmldom` y `jszip`**, que usan los scripts y llegan por `mammoth`; Dependabot está desactivado |
| G5 Protección de rama | **AUSENTE** | `main` no está protegida (API: "Branch not protected"). En la práctica, el agente trabaja en `v2-multiproyecto` | PR y revisión obligatorias para `main` |
| G6 Humano en el bucle | PARCIAL | En la app: Accept, revisión antes de importar, confirmaciones, Verify | En desarrollo no hay revisión obligatoria antes de fusionar (G5) |
| G7 Auditoría de acciones de IA | PARCIAL | `brdp_history` (quién, qué, cuándo) en BRDP y reglas, con origen `llm`/`external_llm`/`extracted`/`copied`; `suggestion_feedback` | Registro de cada llamada al LLM (usuario, proyecto, tipo, tokens), de acciones administrativas y borrados (1.6), logging estructurado y SIEM |
| G10 Gates de seguridad en CI | **AUSENTE** | No hay CI (no existe `.github/`) | CI con lint, pytest, SCA (npm audit, pip-audit), SAST (semgrep o bandit) y DAST |
| G11 Grounding y temperatura baja | PRESENTE | Fichas de esquema, precedentes y vocabulario en los prompts; temperaturas de 0 a 0,7 (`shared.js:25-56`); comprobaciones deterministas después | — |
| G12 Rate limits y cuotas | **AUSENTE** | — | Cuotas por usuario y proyecto en el LLM y los embeddings, con vigilancia (2.1 #7) |

### Checklist T2 (`governance/tier-checklists.md`)

| Punto técnico | Estado |
|---|---|
| Audit logging activo | PARCIAL (G7) |
| Rate limiting configurado | NO (2.1 #7) |
| Clasificación de datos: Internal o inferior | **NO comprobado / en riesgo**: repo público con datos de clientes (resumen, punto 2) |
| Ejecución en VM compartida de IT | **no comprobado** (habría que ver el despliegue real) |
| GDPR: sin datos personales sin DPIA | Se guardan emails y nombres de usuario (`users`); **no comprobado** si hace falta DPIA |

**Trámites ATEXIS pendientes para Juanma (sin veredicto):** registro de la iniciativa en IdAI con justificación · revisión y aprobación de IS · evaluación de riesgo (LOW/STANDARD) · formación de los usuarios · alta en el AI Tool Registry · revisión mensual de uso · mapeo de controles ISO 27001 · revisión trimestral en IdAI.

---

## Parte 4 — Desviaciones de plantilla y diseño

Todas son decisiones de Juanma; no se recomienda migrar.

| Tema | Qué se usa hoy | Tamaño de adoptarlo | Qué se pierde si no se adopta |
|---|---|---|---|
| TypeScript | JS/JSX; hay `tsconfig*.json` y `typescript` sin ningún fichero TS | grande | Tipos en la frontera con la API y las reglas de `javascript.mdc` sobre TypeScript |
| Tailwind + shadcn/ui | CSS Modules por componente y `src/index.css` con variables propias (`:5`); Tailwind 4 instalado sin uso visible; sin shadcn | grande | Los componentes y la consistencia visual del registro ATEXIS |
| Zustand | Context (`AuthContext`), estado local y React Query para el estado del servidor (`useImportJob`, `useEmbeddingJob`, `useTrash`) | medio | Poco: React Query ya cubre el estado del servidor como pide `javascript.mdc` |
| Estructura `frontend/` + `backend/` | Frontend en la raíz (`src/`) y backend en `backend/` | pequeño a medio | La consistencia con la plantilla; algunos scripts dependen de rutas relativas |
| Keycloak OIDC | Usuarios, contraseñas y JWT propios | grande | SSO, MFA, alta y baja corporativas y política de contraseñas centralizada |
| Tokens de diseño DTCG (OKLCH) | Variables CSS en hex (`index.css:5-…`) y hex directos en los módulos (`#2563eb` aparece 33 veces) | medio | Un único origen de colores y espaciados; temas |
| Branding ATEXIS | Azul principal `#2563eb` (en el AACF es el color "Info", no el primario `#2E74B5`); `#2e74b5` solo en `LoginPage.module.css` y `RecordsPage.module.css`; fuente IBM Plex Sans (`index.css:40`) en lugar de Inter + JetBrains Mono | pequeño a medio | La identidad visual ATEXIS |

---

## Parte 5 — Violaciones sistemáticas (`global_rules.md`, `javascript.mdc`, `python.mdc`)

| Regla | Patrón | Ejemplo | Recuento |
|---|---|---|---|
| Global 4: rastro de auditoría | Operaciones administrativas sin registro | `projects.py:225-244` | 7 endpoints (borrar proyecto, usuario, rol, borrados permanentes, crear usuario, resetear contraseña, cambiar rol) |
| Global 5: no exponer detalles internos | Excepción o error del proveedor devueltos al cliente | `rule_extract.py:95-99` | ~~2 sitios~~ resuelto (`31d7daf`, `1c181d2`): middleware `app/core/errors.py` con referencia |
| Global 6 / python.mdc: versiones fijadas | Dependencias de Python con `>=` y sin lockfile | `backend/pyproject.toml:6-24` | 15 de 15 |
| Global 10: paginación | Listados sin paginar en el servidor | `brdps.py:125` | 7 (BRDP, aprobaciones ×2, proyectos, usuarios, Papelera, catálogo) |
| javascript.mdc: cliente de API centralizado y errores en la capa de servicio | Llamadas `authFetchJson` y manejo de errores en páginas y componentes | `RecordsPage.jsx:661` | 81 llamadas en 11 ficheros |
| javascript.mdc: índice como `key` en listas dinámicas | `key={i}` | `RuleExtractSection.jsx:204` | 20 |
| python.mdc: anotaciones de tipo | Funciones sin anotación de retorno o de parámetros | `backend/app/services/excel_io.py:107` | 37 de 362 |
| python.mdc: docstrings estilo Google | Docstrings en prosa, sin `Args:`/`Returns:` | en todo `backend/app` | 0 con secciones de unos 260 docstrings |
| python.mdc: logging estructurado (JSON) | No hay configuración de logging | `backend/app/main.py` | — |
| Global 8: tests | Backend con pytest (36 ficheros); frontend sin test runner (scripts Node y Playwright, una decisión documentada) | — | Cobertura **no comprobada** (habría que medirla con `pytest --cov` y un runner de JS) |

---

## Decisiones para Juanma

Cada una se responde con sí o no.

1. ¿Debe Suggest mostrar (y mandar al LLM) BRDP de proyectos a los que el usuario no tiene acceso? (Si no: filtrar por `has_project_role` como en Comparar.)
2. ¿Puede el repositorio seguir siendo público con los BREX de Lufthansa y CA, los Schematron de las pruebas DITA, los textos de Lufthansa en el juego de pruebas y la IP interna de `CLAUDE.md`?
3. ¿Se acepta enviar datos de proyectos de cliente a la API pública de Mistral? (Si no: el despliegue T2 usa un endpoint privado o autoalojado.)
4. ¿Se exige una UI de administración (HR0) para los ajustes funcionales, aceptando `.env` para secretos e infraestructura?
5. ¿Se aceptan las tres preferencias de interfaz en localStorage/sessionStorage como excepción a HR1 y a `javascript.mdc`?
6. ¿Se mantiene "lo que puede comprobar el código, lo comprueba el código" frente a HR11 para las expresiones mecánicas (identificadores, huecos de la Propuesta)?
7. ¿Se acepta que decidan con patrones el enrutado de preguntas a respuesta sin IA, la clase "Sin contenido", el recorte de "Decision by…" y la limpieza de "SCHEMA FACTS"?
8. ¿Se adopta Keycloak OIDC?
9. ¿Se adopta TypeScript?
10. ¿Se aceptan los recortes marcados de entradas a modelos (embeddings, regla en Ask, resúmenes de AI Extract, fichas) como excepción de HR6?
11. ¿Se pasa a JSON guiado (`response_format`) en lugar de `max_tokens` con lector tolerante?
12. En AI Extract y el proxy, ¿se devuelve el motivo técnico al cliente (HR7) en lugar de un mensaje saneado (Global Rule 5)?
13. ¿Pasan los borrados de proyecto y de usuario a borrado lógico? (Si no: basta con registrarlos.)
14. ¿El informe y las cabeceras del Excel en inglés quedan como excepción a HR15 por ser formato de intercambio?
15. ¿Hay una versión del AACF (MCP) que defina HR12 y HR17?
16. ¿Se protege `main` en GitHub con PR y revisión obligatorias?
17. ¿Se adoptan Tailwind y shadcn/ui?
18. ¿Se adopta Zustand?
19. ¿Se reorganiza el repo en `frontend/` y `backend/`?
20. ¿Se adoptan los tokens DTCG y el branding ATEXIS (`#2E74B5`, Inter y JetBrains Mono)?
21. ¿Se exige `must_change_password` también en el servidor?
22. ¿Se quitan del repo las herramientas de TypeScript y Tailwind sin uso (si las respuestas 9 y 17 son "no")?

## Arreglos propuestos

En orden: primero los bloqueantes de T2.

| # | Arreglo | Regla | Tamaño | ¿Bloquea T2? |
|---|---|---|---|---|
| 1 | Filtrar los precedentes de `/similar` por pertenencia al proyecto (o según la Decisión 1) | Seguridad / permisos | medio | **sí** |
| 2 | Clasificación de datos del repo según la Decisión 2: repo privado, o fixtures de cliente fuera del repo (y del historial) | T2 clasificación | medio | **sí** |
| 3 | Rate limiting compartido y cuotas por usuario en LLM, embeddings y login | 2.1 #7, G12 | medio | **sí** |
| 4 | Registro de auditoría de llamadas al LLM, acciones administrativas y borrados | G7, HR9, Global 4 | medio | **sí** |
| 5 | CI (lint, pytest, SCA, SAST, secret scan) y pre-commit | G1, G2, G10 | medio | **sí** |
| 6 | Proteger `main` | G5 | pequeño | **sí** |
| 7 | Lockfile de Python, `npm ci` en el Dockerfile, declarar `@xmldom/xmldom` y `jszip`, activar Dependabot | G3 | pequeño | sí (G3 es de T2) |
| 8 | ~~Guardados de Records (campos, Verify, Revoke, borrar) con error visible y deshacer~~ **hecho** (`dd9bbac`) | HR7, HR20 | pequeño | no |
| 9 | ~~Diálogo de borrar proyecto: no mostrar "0" si falla el recuento~~ **hecho** (`3fa0c5a`) | HR7, HR9 | pequeño | no |
| 10 | `must_change_password` en el servidor | seguridad | pequeño | no |
| 11 | ~~Validación de entrada: `validation` como `Literal`, longitudes, quitar `history`, validar el standard, fijar modelo y `max_tokens` del proxy en el servidor~~ **hecho** (`1c181d2`) | 2.1 #3 | pequeño | no |
| 12 | ~~Quitar los recortes silenciosos: cita 4 000, título 300, búsqueda de Comparar 50~~ **hecho** (`e3052f4`) | HR6 | pequeño | no |
| 13 | Vigilancia con aviso en el proxy del LLM y en el cliente | HR18/19 | pequeño | no |
| 14 | Traducir el rol (`Header.jsx:30`), "context:/test:" y "Records:/Catalog"; códigos en vez de texto en los errores del backend | HR15, HR21 | medio | no |
| 15 | Limpieza de HR13: ramas few-shot, claves sin lector, duplicados, endpoint sin uso, columna `history` | HR13 | pequeño | no |
| 16 | Procedimiento de despliegue completo (backend, Postgres, migraciones, proxy `/api`) | HR5 | medio | no |
| 17 | Constantes funcionales a `Settings` (HR8) y UI de administración (HR0) | HR8, HR0 | medio / grande | no |
| 18 | Paginación en el servidor de los listados grandes | Global 10 | medio | no |
| 19 | Revocar el access token al hacer logout y detectar la reutilización de un refresh | 1.2 | pequeño | no |
| 20 | Confirmación al quitar un rol | HR9 | pequeño | no |

---

## Qué sigue abierto tras AACF 1

- **Validación de entrada**: `must_change_password` sigue sin aplicarse en el servidor (arreglo 10). `project_config` comprueba la forma (objeto con valores de texto) pero admite claves desconocidas y no comprueba formatos ni longitudes de cada valor: decidir qué claves y formatos son válidos es una decisión de producto. `validation` es un `Literal` en la API, sin `CHECK` en la base de datos (sin migración, como pedía el encargo); el import de Excel no cambia.
- **Longitudes**: una BRDP ya guardada por encima de los límites nuevos se lee y se exporta igual; solo al editar ese campo se pide acortarlo.
- **Recortes marcados de entradas a modelos** (embeddings, regla en Ask, resúmenes de AI Extract, fichas): aceptados (Decisión 10).
- **`src/api/schemaFacts.js`**: Ask sigue sin fichas de esquema si fallan, sin decirlo; aceptado en el encargo.
- **Errores del backend en inglés**: los motivos que el backend escribe para el usuario sin código (p. ej. "A BRDP with identifier … already exists") se muestran tal cual; traducirlos es el arreglo 14.
- **Usuarios y roles** (HR20, HR9): sin cambios.
- Todo lo demás de "Arreglos propuestos" que no está marcado como hecho.

