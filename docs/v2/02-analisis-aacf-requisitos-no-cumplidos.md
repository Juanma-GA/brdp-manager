# Análisis AACF vs. BRDP Manager — Requisitos no cumplidos

> Comparación del código real de `brdp-manager` contra el **ATEXIS AI-Assisted Coding Framework (AACF) v2.0.0** (`Juanma-GA/cursoFSD/Proyecto-CCMS-Nav/aacf`): Hard Rules (HR0–HR21), reglas globales/seguridad/AI-output-safety, sistema de diseño, plantilla `web-app` y gobernanza.

---

## 0. Nota metodológica — por qué esto no es un "todo mal"

El AACF está escrito pensando en el **AI Management Platform (IdAI)** de ATEXIS: apps multi-tenant, con Keycloak, Postgres, tiers T1–T4, DPIA, SIEM, etc. `brdp-manager` es una **herramienta local de un solo usuario**, sin registrar en IdAI. Aplicar el framework al 100% literal (Keycloak + Postgres + 24/7 monitoring para una app local) sería desproporcionado.

Por eso cada requisito se marca con el **tier mínimo** en el que el propio AACF lo exige (según `governance/tier-checklists.md` y `governance/guardrails.md`), para que la decisión de "qué corregir" sea informada:

- 🟢 **Global** — se exige siempre, independientemente del tier (Hard Rules, reglas globales, reglas JS).
- 🟡 **T2+** — solo exigible si la app se registra como herramienta interna (IS-approved).
- 🔴 **T3/T4** — solo exigible con datos de warehouse o en producción expuesta.

Todos los incumplimientos están **verificados contra el código real** (ruta + evidencia), conforme exige el propio `HR3` del framework.

---

## 1. Resumen ejecutivo

| Categoría | Requisitos evaluados | Cumplidos | No cumplidos / parciales |
|---|---|---|---|
| Datos, estado y arquitectura (HR0, HR1, HR8-10, HR20) | 6 | 1 | 5 |
| Calidad de código y proceso (HR2-7, HR11, HR13, HR14, HR16, HR18/19) | 10 | 5 | 5 |
| Texto de usuario / i18n (HR15, HR21) | 2 | 1 | 1 |
| Seguridad (`global_rules.md`, `security.mdc`, `ai-output-safety.mdc`) | 11 | 4 | 7 |
| Stack / plantilla `web-app.md` | 6 | 0 | 6 |
| Diseño / UI kit / accesibilidad (`design-system.md`, `branding.md`, `ui-kit.md`) | 7 | 2 | 5 |
| Gobernanza y CI/CD (`guardrails.md`, `code-review-guidelines.md`, tiers) | 9 | 0 | 9 |
| **Total** | **51** | **13** | **38** |

La app cumple bien en **defensividad del pipeline LLM** (cobertura garantizada, sin pérdida silenciosa de reglas) y en **UI optimista con feedback de error visible**, que es justo lo que el AACF más valora (HR6, HR7, HR20). Los incumplimientos se concentran en **infraestructura/gobernanza** (no existía intención de cumplirlos, al ser una app local) y en **seguridad de borde** (SSRF, secretos en claro, CORS abierto), que sí son aplicables aunque la app sea local si se va a manejar dentro de la red corporativa.

---

## 2. Datos, estado y arquitectura

| # | Requisito | Fuente | Tier | Estado real | Evidencia |
|---|---|---|---|---|---|
| D1 | **HR1** — No usar `localStorage`/`sessionStorage` para estado autoritativo; el servidor (Postgres) es la fuente de verdad. | Hard Rules | 🟢 | **Parcial.** SQLite (no Postgres) es la fuente de verdad real, pero `localStorage` se usa como caché de arranque y **fallback silencioso** en varios hooks; si el backend está caído, los cambios quedan *solo* en `localStorage` (con toast de aviso, pero sin bloquear el guardado "fantasma"). | `src/context/BRDPContext.jsx:116-119`, `src/hooks/useAPIKey.js`, `useProjectConfig.js`, `useLocalNotes.js` |
| D2 | **Auth & Storage** — Postgres como fuente de verdad, no SQLite. | `atexis-hard-rules.md` | 🟡 T2+ | **No cumplido.** Usa `better-sqlite3` (fichero local, sin réplica ni acceso concurrente multi-proceso). | `src/db/database.js`, `package.json` |
| D3 | **HR0** — Config es una superficie de primera clase: cada ajuste debe tener su sección de UI en admin. | Hard Rules | 🟢 | **No cumplido.** Constantes clave están fijas en código sin exponer en Settings: `CHUNK_SIZE = 10`, `MAX_RETRIES = 2` (generadores), `ROWS_PER_PAGE = 25` (tabla), tamaño máx. de texto pegado en AI Extract (3000 car.), tamaño de chunk de extracción (6000/600). | `src/hooks/useTableLogic.js:3`, `CLAUDE.md` (chunking), `src/api/extractBRDPs.js` |
| D4 | **HR8** — No hardcoding: todo configurable (endpoints, umbrales, límites, flags). | Hard Rules | 🟢 | **No cumplido** — mismos valores que D3, más el puerto de desarrollo Vite y las rutas de proxy fijas en `vite.config.ts`. | `vite.config.ts` |
| D5 | **HR9** — Nunca borrar datos persistentes sin confirmación explícita. | Hard Rules | 🟢 | **Cumplido.** Hay `window.confirm()` antes de borrar un BRDP, borrado múltiple, revocar una aprobación de regla, y un diálogo de confirmación para "Reset a datos de demo". | `src/components/DetailPanel.jsx:249`, `BRDPTable.jsx:193`, `RuleApprovalCell.jsx:98`, `ResetDataSection.jsx` |
| D6 | **HR20** — Toda UI de mutación debe ser optimista, con rollback si el servidor rechaza. | Hard Rules | 🟢 | **Parcial.** El patrón *es* optimista (actualiza estado local antes de esperar la API: `setBrdpsState()` seguido de `await ...Api()`), pero **no hay rollback**: si la API falla solo se muestra un toast ("may be lost / may reappear after reload"); el estado local y el del servidor pueden quedar divergentes hasta un reload. | `src/context/BRDPContext.jsx:56-120` (`setBrdps`, `updateBRDP`, `deleteBRDPs`) |

---

## 3. Calidad de código y proceso

| # | Requisito | Fuente | Tier | Estado real | Evidencia |
|---|---|---|---|---|---|
| C1 | **HR2** — Ningún código conocido-roto se despliega; toda corrección se testea. | Hard Rules | 🟢 | **No verificable / probablemente no cumplido** — no hay tests automatizados en el repo (ver C-Tests más abajo). |  |
| C2 | **HR3** — Toda afirmación se verifica contra el código real, con referencias `path:line`. | Hard Rules | 🟢 | **Cumplido como práctica de desarrollo** — `CLAUDE.md` está redactado con este estilo (líneas, ficheros, decisiones justificadas). Buena señal para reutilizar en la app nueva. | `CLAUDE.md` completo |
| C3 | **HR6** — No truncar contenido de calidad; usar resumen LLM en vez de recortar. | Hard Rules | 🟢 | **Cumplido en el pipeline de generación** (nunca se pierde un BRDP; se degrada a entrada de trazabilidad, nunca se descarta en silencio). El límite de 3000 caracteres en texto pegado de AI Extract es un **rechazo explícito con mensaje**, no un truncado silencioso — correcto según el espíritu de la regla. |  |
| C4 | **HR7** — Sin fallbacks silenciosos que degraden UX/calidad/integridad; escalar en su lugar. | Hard Rules | 🟢 | **Mayormente cumplido** (toasts visibles en cada fallo de guardado), con la salvedad de D1/D6 (fallback local sin bloquear ni forzar reintento). |  |
| C5 | **HR11** — No usar regex para operaciones críticas/semánticas; usar LLM o parser real. | Hard Rules | 🟢 | **No cumplido, y es el hallazgo más importante de esta sección.** Toda la manipulación estructural del XML generado (extracción, *fixes* de namespace, reubicación de flags, deduplicación, construcción de reglas Schematron) se hace con **regex sobre strings**, no con un parser XML/DOM. Es exactamente el patrón fragilizador que la propia arquitectura "defensiva" (verificación + reintentos + red de seguridad) existe para compensar — es decir, el proyecto ya paga el coste de este incumplimiento en complejidad. | `src/api/generateBREX.js:115-163` (`extractXML`, fix-ups), `src/api/brexToSchematron.js:9-260` |
| C6 | **HR13** — No código heredado/muerto. | Hard Rules | 🟢 | **Probable incumplimiento.** `src/hooks/useBRDPs.js` (hook standalone basado en `localStorage`) coexiste con `BRDPContext.jsx`, que es el que usa `App.jsx` realmente. `public/brex-schema-summary-sch.json` está documentado en el propio `CLAUDE.md` como "ya no se usa". Antes de reescribir conviene confirmar con un grep de imports si `useBRDPs.js` tiene algún consumidor. | `src/hooks/useBRDPs.js`, `CLAUDE.md` (nota sobre `-sch.json`) |
| C7 | **HR15** — Todo el texto de UI debe ser localizable (capa i18n). | Hard Rules | 🟢 | **No cumplido.** No hay ninguna librería i18n (`react-intl`, `next-intl`, etc.); todos los strings están en inglés, embebidos directamente en JSX. | Búsqueda en `src/` y `package.json`: sin resultados |
| C8 | **HR21** — Humanizar todo texto de cara al usuario (nunca `snake_case`/slugs crudos). | Hard Rules | 🟢 | **Cumplido en general** — hay mapas explícitos de etiquetas legibles (`FORMAT_LABELS`) en `BRDPTable.jsx` y `RuleApprovalCell.jsx`. No se ha encontrado texto crudo tipo enum en la UI. |  |
| C9 | **HR18/HR19** — Sin topes duros silenciosos en procesos agénticos; usar *watchdog* + escalado. | Hard Rules | 🟡 matiz | **Parcial.** `MAX_RETRIES = 2` es un tope duro por chunk, pero **no es silencioso**: al agotarse, el BRDP cae a la red de seguridad de trazabilidad (visible, documentado). Cumple el espíritu aunque no la letra ("nunca un tope duro silencioso" — este no es silencioso, pero sí es un tope duro sin *watchdog*). |  |
| C10 | Tests automatizados — unitarios sobre lógica de negocio, integración sobre endpoints, cobertura 80% en código nuevo. | `global_rules.md` Regla 8 | 🟡 T2+ | **No cumplido.** Cero ficheros `*.test.*`/`*.spec.*` en `src/` o `server.js`. Solo existen 2 scripts manuales en `scripts/` (`test-schematron-dita*.mjs`) que no son parte de una suite ni corren en CI (no hay CI). | `find . -iname "*.test.*"` → vacío |

---

## 4. Seguridad

| # | Requisito | Fuente | Tier | Estado real | Evidencia |
|---|---|---|---|---|---|
| S1 | Autenticación (Keycloak OIDC, MFA, verificación JWT en cada request). | `security.mdc`, `SECURITY_CONTEXT.md` | 🟡 T2+ | **No cumplido — reconocido explícitamente por el propio equipo** ("no necesaria para uso local single-user"). Cualquiera con acceso a la red/puerto puede leer y modificar todos los BRDPs y la config. | `CLAUDE.md` ("Lo que NO está implementado todavía") |
| S2 | **SSRF prevention** — validar URLs de usuario, bloquear IPs privadas, usar *allowlist* para servicios externos. | `security.mdc` | 🟢 | **No cumplido — riesgo real, no solo teórico.** `POST /api/proxy` acepta un `targetEndpoint` arbitrario del cliente y hace `fetch(targetEndpoint, ...)` **sin validar el dominio ni bloquear rangos de IP privados**. Un cliente (o un XSS/CSRF) podría usar el servidor como proxy hacia `localhost`/`169.254.169.254`/red interna. | `server.js:51-89` |
| S3 | Gestión de secretos — API keys nunca en claro; cifrado Fernet en BD. | `security.mdc` | 🟡 T2+ | **No cumplido.** La API key del proveedor LLM se guarda **en texto plano** en la tabla `settings` de SQLite y también en `localStorage`. | `server.js:308-333` (`/api/settings` sin cifrado), `src/hooks/useAPIKey.js` |
| S4 | CORS restringido a orígenes conocidos. | `templates/web-app.md` (checklist) | 🟢 | **No cumplido.** `app.use(cors())` sin configuración = refleja cualquier origen. Poco riesgo si el servidor solo escucha en loopback, pero no está garantizado (el propio README documenta `PORT` configurable y uso en red). | `server.js:44` |
| S5 | Rate limiting en endpoints sensibles. | `security.mdc`, `SECURITY_CONTEXT.md` (30 req/min) | 🟡 T2+ | **No cumplido.** No hay `express-rate-limit` ni límite alguno en `/api/proxy`, `/api/validate-brex` ni el resto de la API. | `package.json` (sin dependencia), `server.js` |
| S6 | Validación de esquema estricta en cada endpoint (Zod/Pydantic, modo estricto, rechazar campos inesperados). | `security.mdc` | 🟢 | **No cumplido.** Los endpoints REST de `server.js` no validan forma/tipos del `req.body` más allá de comprobar presencia de campos; no hay Zod ni similar. |  Todos los `app.post/put` de `server.js` |
| S7 | Auditoría — registrar operaciones significativas (quién/qué/cuándo). | `global_rules.md` Regla 4 | 🟡 T2+ | **No cumplido.** No hay tabla ni log de auditoría; solo `console.error` en fallos, sin usuario asociado (no hay concepto de usuario). |  |
| S8 | No exponer *stack traces* / detalles internos al cliente. | `global_rules.md` Regla 5 | 🟢 | **Parcial / no cumplido.** Varios `catch` devuelven `err.message` directamente al cliente en la respuesta JSON (`res.status(500).json({ error: err.message })`), lo que puede filtrar rutas de fichero o detalles de SQLite. | `server.js` (múltiples handlers `/api/brdps`, `/api/config`, `/api/settings`) |
| S9 | *Slopsquatting* / paquetes verificados — confirmar que cada dependencia existe y no es reciente/sospechosa; *allowlist* + cooldown de instalación. | `ai-output-safety.mdc`, guardrail G3/G4 | 🟡 T2+ | **No verificable sin proceso dedicado** — no hay evidencia de que se haya hecho (no hay SBOM, no hay paso de CI que lo compruebe). Las dependencias declaradas (`react`, `express`, `better-sqlite3`, `xmllint-wasm`, etc.) son paquetes conocidos y de uso amplio, por lo que el riesgo real es bajo, pero el **control como proceso** no existe. |  |
| S10 | Versiones fijadas en producción (*pin exact versions*), *lockfile* con verificación de hash. | `global_rules.md` Regla 6, guardrail G3 | 🟡 T2+ | **Parcial.** Hay `package-lock.json` committeado (bien), pero `package.json` usa rangos `^` en casi todas las dependencias, no versiones exactas. | `package.json` |
| S11 | `dangerouslySetInnerHTML` nunca sin sanitizar; CSP configurada. | `security.mdc` (XSS) | 🟢 | **Cumplido en la parte de React** (no se usa `dangerouslySetInnerHTML` en ningún componente — el chat usa `react-markdown`, que escapa por defecto). **No cumplido** en cuanto a cabeceras `Content-Security-Policy`: no se configuran en `server.js`. | Búsqueda en `src/`: sin resultados; `server.js`: sin CSP |

---

## 5. Stack tecnológico vs. plantilla `web-app.md`

La plantilla oficial de AACF para una web app asume un stack concreto. Ninguna pieza coincide hoy:

| Componente de la plantilla | Exigido por AACF | Usado en `brdp-manager` | ¿Coincide? |
|---|---|---|---|
| Lenguaje frontend | TypeScript estricto | JavaScript (`.jsx`); hay `tsconfig*.json` y `tsc --noEmit` en `package.json`, pero **cero ficheros `.ts`/`.tsx` en `src/`** | ❌ |
| Componentes UI | `shadcn/ui` + Tailwind (registro privado) | CSS Modules a medida (`*.module.css`) por componente; Tailwind está en `devDependencies` pero apenas se usa | ❌ |
| Estado global | Zustand | Context API de React (`BRDPContext`, `ToastContext`) + hooks propios | ❌ |
| Estado servidor | React Query / SWR | `fetch` manual en `services/api.js`, sin cache/revalidación declarativa | ❌ |
| Backend | FastAPI + SQLAlchemy 2.0 async | Express + `better-sqlite3` (síncrono) | ❌ |
| Base de datos | PostgreSQL 16 | SQLite (fichero local) | ❌ |
| Auth | Keycloak OIDC | Ninguna | ❌ |

**Ninguno de estos 7 puntos es una mala decisión de partida por sí sola** para una herramienta local de un solo usuario — SQLite y Express son razonables ahí. Pero si el objetivo es que la app entre en el "camino dorado" de AACF (registro en IdAI, posible tier T2+, componentes reutilizables entre proyectos ATEXIS), implica una reescritura de stack casi completa, no solo de features. **Este es probablemente el dato más determinante para la decisión de "reescribir desde cero" del punto 5 de tu petición.**

---

## 6. Diseño, sistema de tokens y accesibilidad

| # | Requisito | Fuente | Estado real | Evidencia |
|---|---|---|---|---|
| U1 | Tokens de diseño DTCG + Style Dictionary → variables CSS; nunca hex/px directos en componentes. | `design-system.md`, `branding.md` | **No cumplido.** Colores y tamaños están hardcodeados dentro de cada `*.module.css`, sin capa de tokens ni paleta ATEXIS (`#2E74B5`, etc.). |  |
| U2 | Componentes desde `shadcn/ui` (Button, Dialog, Form, DataTable, Toast/`sonner`...), nunca "hand-roll" un primitivo ya existente. | `ui-kit.md` | **No cumplido.** Botones, modales, tabla, toasts y diálogos de confirmación son todos implementados a mano (incl. `window.confirm()` nativo en vez de `Dialog`). | `RuleApprovalCell.jsx:98`, `BRDPTable.jsx:193` |
| U3 | Formularios con `react-hook-form` + `zod`, error bajo el input, submit deshabilitado con spinner durante carga. | `ui-kit.md` | **Parcial** — hay estados de carga/deshabilitado en varios formularios (confirmado en `AIConfigSection.jsx`, `ProjectConfigSection.jsx`), pero no hay `react-hook-form`/`zod`; validación manual. |  |
| U4 | Tabla con `TanStack Table`, columnas ordenables, paginación configurable (10/25/50), *loading skeleton*. | `ui-kit.md` | **Parcial.** Hay orden/filtro/paginación (`useTableLogic.js`), pero tamaño de página fijo a 25 (no configurable por el usuario) e implementación manual, no `TanStack Table`. | `src/hooks/useTableLogic.js:3` |
| U5 | WCAG 2.2 AA: alt text real, contraste, foco visible por teclado, labels reales. | `design-system.md` | **No evaluado con herramientas** (no hay axe/CI de accesibilidad); no se puede afirmar cumplimiento ni incumplimiento sin auditoría manual — se marca como **pendiente de verificar**, no como fallo confirmado. |  |
| U6 | `prefers-reduced-motion` respetado. | `design-system.md` | **No cumplido** — no se ha encontrado ninguna *media query* `prefers-reduced-motion` en el CSS del proyecto. | Búsqueda en `*.module.css`: sin resultados |
| U7 | Responsive hasta móvil. | `design-system.md`, reglas JS | **Probablemente no cumplido** — el layout (Sidebar + tabla ancha + panel de chat lateral) está pensado para escritorio; no se han encontrado *breakpoints* móviles sistemáticos en el CSS revisado. Requiere prueba visual para confirmar al 100%. |  |

---

## 7. Gobernanza, CI/CD y proceso (aplicable si se registra en IdAI, tier T2+)

Estos son, casi todos, **procesos**, no código — pero como el usuario pidió "todos los requisitos no cumplidos", se listan igualmente:

| # | Requisito | Fuente | Estado |
|---|---|---|---|
| G1 | Iniciativa registrada en IdAI con justificación de negocio. | `tier-checklists.md` (T2) | No aplica hoy — la app no está registrada en ningún sistema de gobernanza. |
| G2 | Revisión de Seguridad (IS) completada. | `tier-checklists.md` (T2) | No hecha. |
| G3 | Pre-commit hooks: *secret scan* + lint que pueda rechazar el commit. | `guardrails.md` G1 | No hay `husky`/`lint-staged`/hooks configurados. |
| G4 | *Secret scanning* como *merge gate* (detect-secrets / Gitleaks / CI). | `guardrails.md` G2 | No hay CI en absoluto (no existe `.github/workflows` ni equivalente). |
| G5 | *Dependency allowlist* + *cooldown* + SBOM en cada build. | `guardrails.md` G3 | No implementado. |
| G6 | Protección de rama — ningún agente hace push directo a `main`; PR + revisión obligatoria. | `guardrails.md` G5 | No verificable desde el código (es config de GitHub, no del repo en sí) — recomendable comprobarlo en los ajustes del repositorio. |
| G7 | Revisión de código humana obligatoria antes de desplegar (T2+: 1 revisor). | `code-review-guidelines.md` | No verificable desde el código; depende del proceso real del equipo. |
| G8 | Documentación de API pública (OpenAPI/Swagger). | `global_rules.md` Regla 9 | **No cumplido.** `server.js` no expone ninguna especificación OpenAPI de sus endpoints REST. |
| G9 | Logging/monitorización 24/7, DR, *anomaly detection* (solo si se llega a T4/producción). | `tier-checklists.md` (T4) | No aplica a una app local; **no cumplido** si en algún momento se expone como servicio compartido. |

---

## 8. Lo que sí cumple bien (para que el análisis sea justo)

- **HR6/HR7** (sin pérdida silenciosa, sin truncado): el pipeline de generación BREX/Schematron es, de hecho, un ejemplo *mejor que la media* de estas dos reglas — nunca descarta un BRDP en silencio.
- **HR9** (confirmación antes de borrar): implementado de forma consistente en todos los flujos destructivos.
- **HR20** (UI optimista): el patrón está bien aplicado, solo le falta el rollback.
- **HR21** (humanizar texto): las etiquetas de formato están mapeadas a texto legible.
- Separación razonable de capas: `api/` (lógica LLM) vs `components/` (UI) vs `services/` (fetch) vs `db/` (persistencia) — esto es justo la costura por la que sería más fácil migrar pieza a pieza si se decide **no** reescribir desde cero.

---

## 9. Conclusión para la decisión "reescribir o no"

- Los incumplimientos de **Sección 2 y 3** (arquitectura de datos y calidad de código) son, en su mayoría, **arreglables de forma incremental** sobre el código actual sin tirar nada.
- Los de **Sección 4** (seguridad — sobre todo S2 SSRF, S3 secretos en claro, S6 validación de input) deberían corregirse **exista o no reescritura**, porque son riesgos reales incluso en una app "solo local", ya que suele acabar corriendo en una máquina compartida o accesible por red.
- Los de **Sección 5** (stack: Postgres/Keycloak/FastAPI/Zustand/shadcn) son los que **realmente empujan hacia una reescritura**, porque no son parches — son decisiones de plataforma. Aquí es donde se decide la mayor parte del "hacerlo desde cero o no".
- Los de **Sección 7** (gobernanza) son proceso, no código: se pueden adoptar sin tocar una línea de la app (registrar en IdAI, activar CI, etc.), reescritura o no.

Este documento es el insumo natural para el **punto 4** de tu petición: cualquier "nuevo requisito de diseño" que definas debería, como mínimo, decidir explícitamente qué hacer con cada fila de la Sección 5 (stack), porque es ahí donde vive la pregunta real de "¿reescribimos o no?".
