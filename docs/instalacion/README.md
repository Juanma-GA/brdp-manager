# BRDP Manager — Instalación en servidor

Guías para instalar BRDP Manager directamente en un servidor (sin Docker) y para traer los datos de una instalación existente.

## Antes de empezar: el repositorio contiene datos de cliente

**El repositorio `Juanma-GA/brdp-manager` es público y contiene datos de cliente**: un BREX real de Lufthansa (`backend/tests/fixtures/brex/DMC-LHTSTD-…xml`), reglas y Schematron de Navantia (`backend/tests/fixtures/schematron/`, `scripts/rule-test-fixtures/navantia-*`, `scripts/prompt-eval/fixtures/`) y otros ficheros de prueba con datos de proyectos reales.

Antes de desplegar, alguien con autoridad (no IT) tiene que decidir una de estas dos cosas:

- quitar esos ficheros del repositorio (y de su historial), o
- pasar el repositorio a privado.

Las guías no lo resuelven: solo lo avisan. Ninguno de esos ficheros hace falta para que la app funcione en el servidor (son pruebas). Lo que sí hace falta y no se puede borrar: `sources/S3.0.1`, `sources/S4.1`, `sources/S4.2`, `public/`, `backend/schema_cards/` y `backend/catalog_sources/`.

## Qué guía usar

| Servidor | Guía |
|---|---|
| Ubuntu 22.04 / 24.04, Debian 12 | [linux-ubuntu.md](linux-ubuntu.md) |
| RHEL 9, Rocky Linux 9, AlmaLinux 9 | [linux-rhel.md](linux-rhel.md) |
| Windows Server 2019 / 2022 | [windows-server.md](windows-server.md) |
| Traer los datos de la instalación actual (Postgres en Docker en Windows) | [migracion-datos.md](migracion-datos.md), después de instalar con una de las anteriores |

Estado de las guías:

- **Ubuntu 24.04**: ejecutada de principio a fin en un servidor limpio (paquetes, base de datos, backend, frontend, nginx con HTTPS, login en un navegador real, llamada al LLM, copia de seguridad).
- **Migración de datos**: volcado, restauración en una base nueva, recuentos y arranque de la app ejecutados en Linux. El volcado desde Docker en Windows está revisado, no ejecutado.
- **RHEL y Windows Server**: revisadas contra el código, **no probadas en un servidor real**. Los pasos que dependen solo del sistema operativo llevan la marca «No probado en un servidor real».

## Cómo es la app en el servidor

```
Navegador ──HTTPS──▶ proxy (nginx o IIS) ──┬── /         → ficheros estáticos (dist/, compilado una vez)
                                            └── /api/, /health → backend FastAPI en 127.0.0.1:8000 ──▶ PostgreSQL
                                                                      └──▶ Mistral (chat y embeddings)
```

- El backend es **un solo proceso** (uvicorn). Los trabajos largos (importar Excel, calcular embeddings, AI Extract) corren dentro de él y su estado se guarda en la base de datos.
- Node.js **solo hace falta para compilar** el frontend. En producción no se ejecuta.
- Todos los datos viven en PostgreSQL. El navegador no guarda nada.

## Requisitos comunes

| Qué | Versión | De dónde sale |
|---|---|---|
| Python | 3.11 o 3.12 (3.13 también instala) | `backend/pyproject.toml` (`requires-python = ">=3.11"`); el lockfile `backend/requirements.lock.txt` está generado para 3.11 en modo universal. Probado: instala con hashes en 3.11, 3.12 y 3.13 |
| Node.js | 22 LTS (mínimo 20.19 o 22.12) | `vite` 8 y `@vitejs/plugin-react` 6 piden `^20.19.0 \|\| >=22.12.0` |
| PostgreSQL | 16 recomendado (15 o más). **Igual o mayor** que la versión de la base que se migre | |
| pgvector | la que traiga el paquete de tu PostgreSQL (probado con 0.6.0) | Obligatorio: la migración `0001` ejecuta `CREATE EXTENSION IF NOT EXISTS vector` |
| Proxy con HTTPS | nginx (Linux) o IIS con URL Rewrite + ARR (Windows) | Ver abajo |
| Certificado HTTPS | uno de la PKI interna vale | Ver abajo |
| Git | cualquiera | Para descargar y actualizar el código |
| Acceso a Mistral | la clave (`<CLAVE_MISTRAL>`) o el endpoint privado | Chat y embeddings |

Espacio: el código con `node_modules` y el entorno de Python ocupa unos 600 MB; la base de datos, lo que tenga el proyecto (unos pocos cientos de MB con miles de BRDP).

### Por qué hace falta HTTPS

Con `ENVIRONMENT=production` el backend envía la cookie de sesión (`refresh_token`, ruta `/api/auth`) con la marca `Secure` (`backend/app/api/routes/auth.py`). El navegador no envía una cookie `Secure` por HTTP. Por HTTP el login entra, pero **al recargar la página o a los 45 minutos vuelve a la pantalla de login**.

Comprobado en un navegador real: por `https://` la sesión sobrevive a una recarga; por `http://` no.

No se debe desactivar `Secure` ni dejar `ENVIRONMENT` en `development` en un servidor: la solución es HTTPS, aunque sea con un certificado interno.

Ojo: en el propio servidor, por `http://localhost` o `http://127.0.0.1`, el navegador sí acepta la cookie `Secure` (esas direcciones cuentan como seguras). Que funcione ahí no prueba nada: hay que probar desde otro equipo con el nombre real.

### Qué necesita el proxy delante de `/api`

| Ajuste | Valor | Por qué |
|---|---|---|
| Tamaño máximo de la petición | 25 MB | Excel hasta 10 MB (`EXCEL_IMPORT_MAX_BYTES`), BREX/Schematron de AI Extract hasta 20 MB (`RULE_EXTRACT_MAX_BYTES`), más el sobrecoste del envío |
| Tiempo de espera de lectura | 330 s | Una llamada a la IA puede tardar hasta `LLM_REQUEST_TIMEOUT_SECONDS` (300 s) |
| Búfer de la respuesta | desactivado | El proxy del LLM puede responder en streaming (`text/event-stream`) |
| Rutas | `/api/` y `/health` al backend; el resto, ficheros de `dist/` con vuelta a `index.html` | La app es de una sola página (las rutas `/projects/...` no existen como ficheros) |

### Red corporativa con inspección SSL (Zscaler)

Si la red inspecciona el tráfico HTTPS, el servidor necesita el certificado raíz corporativo en `.pem`:

- **Backend (Python)**: la variable `SSL_CERT_FILE` va **en el entorno del servicio** (systemd `Environment=` o variable del servicio de Windows), **no en `backend/.env`**: la app lee el `.env` en su configuración, pero no lo pasa al entorno del proceso, y quien necesita la variable es la librería de HTTP. Sin ella, cada llamada a Mistral falla y en el log del backend sale `SSLCertVerificationError` / `CERTIFICATE_VERIFY_FAILED`.
- **Compilación (npm)**: `NODE_EXTRA_CA_CERTS` con el mismo `.pem` al ejecutar `npm ci`. Sin él, `npm ci` falla con `SELF_SIGNED_CERT_IN_CHAIN` o `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`.
- **pip**: `pip install` acepta `--cert <ruta.pem>`.

`SSL_CERT_FILE` **sustituye** a la lista de certificados que trae Python. Si el servidor también llega a sitios sin inspeccionar, usa un fichero que tenga los dos: los certificados públicos de Python más el corporativo (cada guía explica cómo crearlo).

## Variables del backend (`backend/.env`)

El backend lee estas variables del fichero `backend/.env` (o del entorno). La lista sale de `backend/app/core/config.py`; las guías dan un `.env` de producción completo.

| Variable | Por defecto | Qué es |
|---|---|---|
| `ENVIRONMENT` | `development` | Pon `production` en el servidor (cookie `Secure`) |
| `DATABASE_URL` | `postgresql+asyncpg://brdp:brdp@localhost:5432/brdp_manager` | Conexión a PostgreSQL (siempre `postgresql+asyncpg://`). El valor por defecto es el de desarrollo: en el servidor, con `<CONTRASEÑA_BD>` |
| `JWT_PRIVATE_KEY_PATH` / `JWT_PUBLIC_KEY_PATH` | `keys/jwt_private.pem` / `keys/jwt_public.pem` | Claves que firman las sesiones (relativas a `backend/`) |
| `ACCESS_TOKEN_EXPIRE_MINUTES` | `45` | Duración del token de acceso |
| `REFRESH_TOKEN_EXPIRE_DAYS` | `14` | Duración de la sesión (cookie) |
| `REFRESH_TOKEN_REUSE_GRACE_SECONDS` | `30` | Segundos que un token de sesión ya renovado sigue valiendo (una recarga a mitad de una renovación, dos pestañas a la vez). Cerrar sesión nunca lo deja usar. `0` = desactivado |
| `INITIAL_ADMIN_EMAIL` / `INITIAL_ADMIN_PASSWORD` | vacías | Solo para `scripts/create_admin_user.py`; no las dejes en el fichero |
| `ACTIVE_LLM_PROVIDER` | `mistral` | `mistral` o `qwen`. Los embeddings (Sugerir, comparar parecidas) solo funcionan con `mistral` |
| `MISTRAL_API_KEY` | vacía | `<CLAVE_MISTRAL>` |
| `MISTRAL_ENDPOINT` | `https://api.mistral.ai/v1/chat/completions` | Endpoint de chat (cámbialo si hay uno privado) |
| `MISTRAL_MODEL` | `mistral-medium-latest` | Modelo de chat |
| `MISTRAL_EMBED_ENDPOINT` | `https://api.mistral.ai/v1/embeddings` | Endpoint de embeddings |
| `MISTRAL_EMBED_MODEL` | `mistral-embed` | Modelo de embeddings (cambiarlo obliga a recalcular todos) |
| `QWEN_API_KEY` / `QWEN_ENDPOINT` / `QWEN_CHAT_MODEL` | vacía / vacía / `qwen-plus` | Solo con `ACTIVE_LLM_PROVIDER=qwen` |
| `CORS_ORIGINS` | `["http://localhost:5173","http://localhost:80"]` | Lista JSON. Pon la dirección pública: `["https://brdp.example.local"]` |
| `SOURCES_DIR` | `<repo>/sources` | No la definas (si la dejas vacía, rompe la validación de BREX) |
| `EXCEL_IMPORT_MAX_BYTES` | `10485760` (10 MB) | Tamaño máximo de un Excel |
| `EXCEL_IMPORT_MAX_UNCOMPRESSED_BYTES` | `209715200` (200 MB) | Tamaño descomprimido máximo de un Excel |
| `EXCEL_IMPORT_MAX_ROWS` | `20000` | Filas máximas de un Excel |
| `RULE_EXTRACT_MAX_BYTES` | `20971520` (20 MB) | Tamaño máximo de un BREX/Schematron en AI Extract. Si lo subes, sube también el límite del proxy |
| `EXTRACT_TEXT_MAX_WORDS` / `EXTRACT_TEXT_MAX_CHARS` | `5000` / `200000` | Límites del texto libre en AI Extract |
| `EXTRACT_QUOTE_MAX_CHARS` | `20000` | Longitud máxima de una cita en AI Extract |
| `BRDP_TITLE_MAX_CHARS` / `BRDP_TEXT_MAX_CHARS` | `2000` / `32767` | Longitud máxima del Título y de los demás textos |
| `PROJECT_NAME_MAX_CHARS` | `200` | Longitud máxima del nombre de proyecto |
| `LLM_MAX_TOKENS` | `16000` | Máximo de tokens que acepta el proxy del LLM |
| `LLM_REQUEST_TIMEOUT_SECONDS` | `300` | Espera máxima a la IA; el proxy necesita algo más (330 s) |
| `LLM_CALLS_PER_MINUTE` / `LLM_CALLS_PER_DAY` | `120` / `3000` | Límite de llamadas a la IA por usuario (0 = sin límite) |
| `UI_DETAIL_WIDTH_MIN` / `UI_DETAIL_WIDTH_MAX` | `360` / `4000` | Límites del ancho del panel de detalle |

No pongas en el servidor `TEST_DATABASE_URL` (solo la usan los tests, que no se ejecutan ahí) ni un `MISTRAL_ENDPOINT` hacia un simulador (`127.0.0.1:8902`): eso solo se usa en desarrollo.
