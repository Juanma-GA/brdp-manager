# CLAUDE.md — Contexto para Claude Code

Este fichero describe la arquitectura y patrones del proyecto para que Claude Code tenga contexto completo antes de hacer cualquier cambio.

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
| `src/api/generateBREXSch.js` | Generador Schematron 1.0 (enfoque A2, ver abajo) |
| `src/api/brexToSchematron.js` | Conversor determinista BREX → Schematron (sin LLM) |
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

### Schematron 1.0 (`generateBREXSch.js` + `brexToSchematron.js`) — enfoque A2

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
const isSch = format === 'Schematron 1.0';
```

Añadir un nuevo formato BREX requiere: nuevo generador + schema JSON + rama en `handleGenerate()` + actualizar `disabled`/"Coming soon".

### Guardia de validación en el chat

`useChat.js` intercepta en `sendUserMessage()` los mensajes con triggers de cambio de estado (`validationTriggers`) y responde sin llamar al LLM. Segunda capa de restricción en el `basePrompt`.

## Lo que NO está implementado todavía

- S1000D 5.0, 6.0 (selector existe, botón deshabilitado con "Coming soon").
- Botón de migración BREX→Schematron sobre un BREX subido (el motor `brexToSchematron.js` ya está listo; falta la UI).
- Migración automática de localStorage a SQLite en primera ejecución.
- Autenticación (no necesaria para uso local single-user).
- Docker con SQLite (el docker-compose actual usa nginx sin backend).
