# BRDP Manager — Instalación en Ubuntu / Debian

Para Ubuntu 22.04 y 24.04 y Debian 12, sin Docker: PostgreSQL con pgvector, el backend como servicio de systemd y nginx con HTTPS delante.

Antes de empezar, lee [README.md](README.md): requisitos, por qué hace falta HTTPS y **el aviso sobre los datos de cliente del repositorio**.

**Probado** de principio a fin en un Ubuntu 24.04 limpio (PostgreSQL 16.15, pgvector 0.6.0, Python 3.12, Node 22, nginx 1.24). Ubuntu 22.04 y Debian 12 solo cambian en el paso 1 (de dónde salen Python y PostgreSQL); ese paso está revisado, no ejecutado en esas versiones.

Convenciones:

- Todo se ejecuta como un usuario con `sudo`.
- `brdp.example.local` es el nombre del servidor: cámbialo por el real.
- Los valores entre `<…>` son tuyos: `<CONTRASEÑA_BD>`, `<CLAVE_MISTRAL>`, `<CORREO_ADMIN>`.
- Rutas: el código en `/opt/brdp/app`, el frontend compilado en `/var/www/brdp`, los certificados en `/etc/ssl/brdp`.

---

## 1. Paquetes

**Ubuntu 24.04** (todo viene en los repositorios del sistema):

```bash
sudo apt update
sudo apt install -y git curl nginx openssl \
                    postgresql-16 postgresql-16-pgvector \
                    python3.12 python3.12-venv
```

**Ubuntu 22.04**: Python 3.10 y PostgreSQL 14 son demasiado viejos. Añade los repositorios de PostgreSQL (PGDG) y de Python (deadsnakes):

```bash
sudo apt update
sudo apt install -y git curl nginx openssl ca-certificates gnupg software-properties-common
# PostgreSQL 16 y pgvector (repositorio oficial apt.postgresql.org)
sudo install -d /usr/share/postgresql-common/pgdg
sudo curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc
echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" | sudo tee /etc/apt/sources.list.d/pgdg.list
# Python 3.11
sudo add-apt-repository -y ppa:deadsnakes/ppa
sudo apt update
sudo apt install -y postgresql-16 postgresql-16-pgvector python3.11 python3.11-venv
```

**Debian 12**: trae Python 3.11 (`python3.11 python3.11-venv`). Para PostgreSQL 16 y pgvector, añade el repositorio PGDG igual que en 22.04 (las cuatro líneas de PostgreSQL de arriba) e instala `postgresql-16 postgresql-16-pgvector`.

**Node.js 22** (solo para compilar el frontend), en las tres:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v      # v22.x
```

En el resto de la guía, `python3.12` es el Python que hayas instalado (`python3.11` en 22.04 y Debian).

---

## 2. Base de datos y pgvector

### 2.1 Comprobar que pgvector está instalado

Antes de crear nada:

```bash
sudo -u postgres psql -Atc "SELECT name, default_version FROM pg_available_extensions WHERE name = 'vector';"
```

Tiene que devolver una línea (`vector|0.6.0` o parecido). Si no devuelve nada, falta el paquete `postgresql-16-pgvector` (paso 1). Sin él, la migración y el paso siguiente fallan con:

```
ERROR:  extension "vector" is not available
DETAIL:  Could not open extension control file "/usr/share/postgresql/16/extension/vector.control": No such file or directory.
```

### 2.2 Crear el usuario y la base

```bash
sudo -u postgres psql -v ON_ERROR_STOP=1 <<'SQL'
CREATE ROLE brdp LOGIN PASSWORD '<CONTRASEÑA_BD>';
CREATE DATABASE brdp_manager OWNER brdp;
\c brdp_manager
CREATE EXTENSION IF NOT EXISTS vector;
SQL
```

La extensión la crea `postgres` porque `brdp` no es superusuario: si lo intentara `brdp`, saldría `permission denied to create extension "vector"`. La migración `0001` vuelve a pedirla con `IF NOT EXISTS`, así que no falla.

PostgreSQL de Ubuntu acepta contraseña desde `127.0.0.1` (`scram-sha-256` en `/etc/postgresql/16/main/pg_hba.conf`); no hace falta tocar nada. PostgreSQL escucha solo en `localhost`: déjalo así.

**Si vas a traer datos** ([migracion-datos.md](migracion-datos.md)), crea la base igual, pero **no** ejecutes `alembic upgrade head` en el paso 4.5: la restauración trae el esquema.

---

## 3. Usuario del sistema y código

```bash
sudo useradd --system --create-home --home-dir /opt/brdp --shell /usr/sbin/nologin brdp
sudo -u brdp git clone -b v2-multiproyecto https://github.com/Juanma-GA/brdp-manager.git /opt/brdp/app
```

- Si el repositorio pasa a privado, `git clone` pedirá credenciales: usa un token de solo lectura de GitHub, no una contraseña personal.
- La carpeta `/opt/brdp` queda con permisos `750`: nginx (usuario `www-data`) no puede entrar. Por eso el frontend compilado se copia a `/var/www/brdp` (paso 5).
- El backend lee ficheros de todo el repositorio (`public/`, `sources/S*/`, `backend/schema_cards/`): hay que clonarlo entero, no solo `backend/`.

---

## 4. Backend

### 4.1 Entorno de Python e instalación

```bash
cd /opt/brdp/app/backend
sudo -u brdp python3.12 -m venv .venv
sudo -u brdp .venv/bin/pip install --require-hashes -r requirements.lock.txt
```

- `requirements.lock.txt` es el de producción: versiones exactas con sus hashes. No uses `requirements-dev.lock.txt` (lleva las herramientas de tests) ni `pip install -e`.
- Con inspección SSL en la red, añade `--cert /etc/ssl/brdp/corporate-root.pem` (ver 4.4).

### 4.2 El fichero `backend/.env`

Crea `/opt/brdp/app/backend/.env` con este contenido (son todas las variables que lee `backend/app/core/config.py`; las que no cambies pueden quedarse comentadas, con su valor por defecto):

```bash
sudo -u brdp tee /opt/brdp/app/backend/.env >/dev/null <<'EOF'
# --- Obligatorias en el servidor ---
ENVIRONMENT=production
DATABASE_URL=postgresql+asyncpg://brdp:<CONTRASEÑA_BD>@localhost:5432/brdp_manager
CORS_ORIGINS=["https://brdp.example.local"]

ACTIVE_LLM_PROVIDER=mistral
MISTRAL_API_KEY=<CLAVE_MISTRAL>
MISTRAL_ENDPOINT=https://api.mistral.ai/v1/chat/completions
MISTRAL_MODEL=mistral-medium-latest
MISTRAL_EMBED_ENDPOINT=https://api.mistral.ai/v1/embeddings
MISTRAL_EMBED_MODEL=mistral-embed

# --- Sesiones (claves del paso 4.3, relativas a backend/) ---
JWT_PRIVATE_KEY_PATH=keys/jwt_private.pem
JWT_PUBLIC_KEY_PATH=keys/jwt_public.pem
#ACCESS_TOKEN_EXPIRE_MINUTES=45
#REFRESH_TOKEN_EXPIRE_DAYS=14

# --- Solo con ACTIVE_LLM_PROVIDER=qwen (los embeddings solo funcionan con mistral) ---
#QWEN_API_KEY=
#QWEN_ENDPOINT=
#QWEN_CHAT_MODEL=qwen-plus

# --- Límites (por defecto valen) ---
#LLM_REQUEST_TIMEOUT_SECONDS=300
#LLM_CALLS_PER_MINUTE=120
#LLM_CALLS_PER_DAY=3000
#LLM_MAX_TOKENS=16000
#EXCEL_IMPORT_MAX_BYTES=10485760
#EXCEL_IMPORT_MAX_UNCOMPRESSED_BYTES=209715200
#EXCEL_IMPORT_MAX_ROWS=20000
#RULE_EXTRACT_MAX_BYTES=20971520
#EXTRACT_TEXT_MAX_WORDS=5000
#EXTRACT_TEXT_MAX_CHARS=200000
#EXTRACT_QUOTE_MAX_CHARS=20000
#BRDP_TITLE_MAX_CHARS=2000
#BRDP_TEXT_MAX_CHARS=32767
#PROJECT_NAME_MAX_CHARS=200
#UI_DETAIL_WIDTH_MIN=360
#UI_DETAIL_WIDTH_MAX=4000

# --- No definir ---
# SOURCES_DIR (por defecto <repo>/sources; vacía rompe la validación de BREX)
# INITIAL_ADMIN_EMAIL / INITIAL_ADMIN_PASSWORD (el paso 7 las pide por consola)
# TEST_DATABASE_URL (solo tests)
EOF
sudo chmod 600 /opt/brdp/app/backend/.env
```

Qué significa cada una: tabla de [README.md](README.md#variables-del-backend-backendenv).

- La app busca `.env` en el directorio de trabajo: el servicio arranca en `/opt/brdp/app/backend` (paso 4.6).
- `ENVIRONMENT=production` es lo que hace `Secure` la cookie de sesión: con él, el acceso tiene que ser por HTTPS (paso 6).
- Si `RULE_EXTRACT_MAX_BYTES` o `EXCEL_IMPORT_MAX_BYTES` suben por encima de 20 MB, sube también `client_max_body_size` en nginx.

### 4.3 Claves JWT

```bash
cd /opt/brdp/app/backend
sudo -u brdp .venv/bin/python scripts/generate_rsa_keypair.py
```

Escribe `keys/jwt_private.pem` (permisos 600) y `keys/jwt_public.pem`. Las claves no están en git y no se copian de otra instalación: se generan en cada servidor. El script se niega a sobrescribir unas claves que ya existen (cambiarlas cierra todas las sesiones).

### 4.4 Solo con inspección SSL (Zscaler): el certificado corporativo

Si no hay inspección SSL en la red, salta este paso.

Copia el certificado raíz corporativo (`.pem`, te lo da Seguridad/IT) y crea un fichero con los certificados públicos de Python más el corporativo:

```bash
sudo install -d -m 755 /etc/ssl/brdp
sudo cp <ruta>/corporate-root.pem /etc/ssl/brdp/corporate-root.pem
cat "$(/opt/brdp/app/backend/.venv/bin/python -m certifi)" /etc/ssl/brdp/corporate-root.pem \
  | sudo tee /etc/ssl/brdp/ca-bundle.pem >/dev/null
sudo chmod 644 /etc/ssl/brdp/corporate-root.pem /etc/ssl/brdp/ca-bundle.pem
```

Ese `ca-bundle.pem` se da al servicio en el paso 4.6 (`SSL_CERT_FILE`), **no** en `.env`. Sin él, en el log del backend sale `SSLCertVerificationError` / `[SSL: CERTIFICATE_VERIFY_FAILED]` en cada llamada a la IA.

### 4.5 Esquema de la base

Solo para una instalación nueva (sin traer datos):

```bash
cd /opt/brdp/app/backend
sudo -u brdp .venv/bin/alembic upgrade head
sudo -u brdp .venv/bin/alembic current      # debe terminar en "(head)"
```

Si falla con `extension "vector" is not available`, vuelve al paso 2.1.

### 4.6 El backend como servicio

Crea `/etc/systemd/system/brdp-backend.service`:

```ini
[Unit]
Description=BRDP Manager backend (FastAPI)
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
Type=simple
User=brdp
Group=brdp
WorkingDirectory=/opt/brdp/app/backend
ExecStart=/opt/brdp/app/backend/.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000 --proxy-headers
Restart=on-failure
RestartSec=5
# Solo con inspección SSL (paso 4.4). Es una variable del proceso, no de .env.
#Environment=SSL_CERT_FILE=/etc/ssl/brdp/ca-bundle.pem

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now brdp-backend
sudo systemctl status brdp-backend
curl -s http://127.0.0.1:8000/health
```

`/health` tiene que devolver `{"status":"ok","migrations":{"current":"0031","head":"0031","up_to_date":true}}` (el número cambia con las versiones; lo importante es `up_to_date: true`). El log: `journalctl -u brdp-backend -f`.

- Un solo proceso es suficiente: no añadas `--workers`.
- uvicorn escucha solo en `127.0.0.1`: desde fuera se entra por nginx.
- Si la base está por detrás de la última migración, el backend arranca igual y lo avisa en el log (`Database is behind the latest migration … run alembic upgrade head`).

---

## 5. Frontend

```bash
cd /opt/brdp/app
sudo -u brdp npm ci
sudo -u brdp npm run build                    # genera dist/
sudo install -d -m 755 /var/www/brdp
sudo rm -rf /var/www/brdp/*
sudo cp -r /opt/brdp/app/dist/. /var/www/brdp/
```

- `npm ci` instala exactamente `package-lock.json` (también las herramientas de compilación, que hacen falta para `npm run build`). Nunca `npm audit fix --force`.
- Con inspección SSL, `npm ci` falla con `SELF_SIGNED_CERT_IN_CHAIN`: lánzalo con el certificado corporativo, por ejemplo `sudo -u brdp env NODE_EXTRA_CA_CERTS=/etc/ssl/brdp/corporate-root.pem npm ci` (si hay un proxy HTTP, añade también `HTTPS_PROXY=…` dentro del `env`).
- El frontend llama a `/api` en el mismo nombre de servidor: no hay que configurarle nada.

---

## 6. Proxy y HTTPS (nginx)

### 6.1 Certificado

Pon el certificado del servidor (de la PKI interna) y su clave:

```bash
sudo install -d -m 755 /etc/ssl/brdp
sudo cp <ruta>/brdp.crt /etc/ssl/brdp/brdp.crt      # con la cadena intermedia, si la hay
sudo cp <ruta>/brdp.key /etc/ssl/brdp/brdp.key
sudo chmod 600 /etc/ssl/brdp/brdp.key
```

Solo para probar mientras llega el certificado bueno (el navegador avisará):

```bash
sudo openssl req -x509 -newkey rsa:2048 -nodes -days 30 -subj "/CN=brdp.example.local" \
     -addext "subjectAltName=DNS:brdp.example.local" \
     -keyout /etc/ssl/brdp/brdp.key -out /etc/ssl/brdp/brdp.crt
```

### 6.2 Configuración de nginx

El `nginx.conf` de la raíz del repo es el de Docker (solo frontend): no sirve aquí. Crea `/etc/nginx/sites-available/brdp`:

```nginx
server {
    listen 80;
    server_name brdp.example.local;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name brdp.example.local;

    ssl_certificate     /etc/ssl/brdp/brdp.crt;
    ssl_certificate_key /etc/ssl/brdp/brdp.key;

    # Excel hasta 10 MB y BREX/Schematron de AI Extract hasta 20 MB.
    client_max_body_size 25m;

    root /var/www/brdp;
    index index.html;

    location /api/ {
        proxy_pass http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # La IA puede tardar hasta LLM_REQUEST_TIMEOUT_SECONDS (300 s)
        # y puede responder en streaming: margen de tiempo y sin búfer.
        proxy_read_timeout 330s;
        proxy_send_timeout 330s;
        proxy_buffering off;
    }

    location = /health {
        proxy_pass http://127.0.0.1:8000;
    }

    # El lector de PDF de AI Extract carga un worker .mjs como módulo: el
    # navegador exige un tipo JavaScript y nginx no conoce esa extensión
    # (sin esto la sirve como application/octet-stream y leer un PDF falla).
    location ~* \.mjs$ {
        default_type text/javascript;
        try_files $uri =404;
    }

    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/brdp /etc/nginx/sites-enabled/brdp
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

Si hay cortafuegos (`ufw`): `sudo ufw allow 'Nginx Full'`.

**No hay alternativa por HTTP**: con `ENVIRONMENT=production` la sesión no se mantiene sin HTTPS (ver [README.md](README.md#por-qué-hace-falta-https)), y no se debe desactivar.

---

## 7. Primer administrador

Solo en una instalación nueva. Si traes datos, los usuarios viajan con la base: salta este paso.

```bash
cd /opt/brdp/app/backend
sudo -u brdp .venv/bin/python scripts/create_admin_user.py
```

Pide el correo y la contraseña (dos veces) y crea un usuario con rol global `admin`. Se niega a tocar un correo que ya exista.

**El correo tiene que tener un dominio real** (por ejemplo, el corporativo). El script comprueba el correo igual que el login y, con un dominio reservado como `.local`, `.localhost`, `.test` o `.invalid` (`admin@brdp.local`), sale con «Invalid email … special-use or reserved name» sin crear nada.

(También acepta `INITIAL_ADMIN_EMAIL`/`INITIAL_ADMIN_PASSWORD` del entorno o del `.env`; si las pones en el `.env`, bórralas después.)

---

## 8. Catálogos y ficheros que necesita la app

Ficheros: no hay que copiar nada aparte. El backend usa, dentro del propio repositorio:

- `sources/S3.0.1`, `sources/S4.1`, `sources/S4.2`: los XSD del BREX (validación en Generar).
- `public/brdp-template-*.xlsx`: plantillas que se descargan y que también usa Sugerir Regla.
- `backend/schema_cards/`: fichas de esquema de cada standard (Preguntar, test de reglas).

**Catálogos oficiales de BRDP**: una instalación nueva tiene la tabla `brdp_catalog` vacía. Cárgalos desde `backend/catalog_sources/` (si traes datos, ya vienen en la base: no hace falta):

```bash
cd /opt/brdp/app/backend
sudo -u brdp .venv/bin/python scripts/import_brdp_catalog.py catalog_sources/s1000d_4.2.xlsx "S1000D 4.2"
sudo -u brdp .venv/bin/python scripts/import_brdp_catalog.py catalog_sources/s1000d_4.1.xlsx "S1000D 4.1"
sudo -u brdp .venv/bin/python scripts/import_brdp_catalog.py catalog_sources/s1000d_301_attributes_catalog.xlsx "S1000D 3.0.1"
sudo -u brdp .venv/bin/python scripts/import_brdp_catalog.py catalog_sources/dita_1.3.xlsx "DITA 1.3 Xpath2.0"
sudo -u brdp .venv/bin/python scripts/import_brdp_catalog.py catalog_sources/dita_1.3.xlsx "DITA 1.3 Xpath3.0"
```

Cada uno dice `Imported N rows for '…': N created, 0 updated`; repetirlo no duplica nada. Resultado esperado: 427, 552, 27, 100 y 100 filas. (`s1000d_30_attributes_catalog.xlsx` no se carga: «S1000D 3.0» no es un standard de la app.)

Los catálogos cargados no tienen embeddings: la primera vez que se use Sugerir en un proyecto, la app pide pulsar «Compute embeddings» y los calcula junto con las BRDP.

---

## 9. Comprobación final

1. **Salud del backend a través de nginx**:
   ```bash
   curl -s https://brdp.example.local/health
   ```
   (con un certificado de prueba, `curl -sk`). Debe dar `"status":"ok"` y `"up_to_date":true`.
2. **Login desde otro equipo**: abre `https://brdp.example.local` en un navegador, entra con el administrador y **recarga la página**: tienes que seguir dentro (si vuelve al login, mira «Problemas típicos»).
3. **Una llamada al LLM**: en un proyecto, abre una BRDP y haz una pregunta en «Preguntar» (Ask). Tiene que responder. Si falla, mira `journalctl -u brdp-backend -n 50`. Cada llamada queda registrada en la tabla `llm_calls`:
   ```bash
   sudo -u postgres psql -d brdp_manager -c "SELECT created_at, kind, result, upstream_status FROM llm_calls WHERE kind = 'chat' ORDER BY created_at DESC LIMIT 5;"
   ```
   La última fila debe tener `result = ok`.
4. **Embeddings**: crea una BRDP en estado *Validated* y pulsa «Compute embeddings» en el aviso de Registros: tiene que terminar sin error.

---

## 10. Copias de seguridad

Diaria, con el `cron` del usuario `postgres`:

```bash
sudo install -d -o postgres -g postgres -m 700 /var/backups/brdp
sudo crontab -u postgres -e
```

Añade:

```cron
30 2 * * * pg_dump -d brdp_manager -Fc -f /var/backups/brdp/brdp_$(date +\%F).dump && find /var/backups/brdp -name 'brdp_*.dump' -mtime +14 -delete
```

(El `\%` es obligatorio dentro de cron.) Guarda 14 días.

Guarda también, **fuera del servidor y en un sitio seguro**: `backend/.env` y `backend/keys/`. No están en git. Las copias de la base contienen usuarios (contraseñas cifradas) y datos de cliente: trátalas como confidenciales.

Comprobar una copia: `sudo -u postgres pg_restore -l /var/backups/brdp/brdp_<fecha>.dump | head`. Restaurar: como en [migracion-datos.md](migracion-datos.md) (paso 3), sobre una base vacía.

---

## 11. Actualizar a una versión nueva

Haz antes una copia de la base (paso 10, a mano). Después:

```bash
cd /opt/brdp/app
sudo -u brdp git pull
cd backend
sudo -u brdp .venv/bin/pip install --require-hashes -r requirements.lock.txt
sudo -u brdp .venv/bin/alembic upgrade head
cd ..
sudo -u brdp npm ci
sudo -u brdp npm run build
sudo rm -rf /var/www/brdp/*
sudo cp -r /opt/brdp/app/dist/. /var/www/brdp/
sudo systemctl restart brdp-backend
curl -s http://127.0.0.1:8000/health
```

`alembic upgrade head` no hace nada si no hay migraciones nuevas. Los usuarios con la app abierta deben recargar la página.

---

## 12. Problemas típicos

| Síntoma | Causa y arreglo |
|---|---|
| Al recargar la página vuelve al login (o a los 45 minutos) | Se entra por HTTP. Con `ENVIRONMENT=production` la cookie es `Secure`: entra por `https://`. En el propio servidor por `http://localhost` sí funciona: no sirve como prueba |
| `create_admin_user.py` dice «Invalid email … special-use or reserved name» | El dominio es reservado (`.local`, `.test`…). Vuelve a ejecutarlo con un dominio real (paso 7) |
| «No se pudo conectar con el servidor» | Backend parado: `systemctl status brdp-backend`, `journalctl -u brdp-backend -n 100` |
| `502 Bad Gateway` en `/api` | Igual: el backend no responde en `127.0.0.1:8000` |
| El backend no arranca: no encuentra `keys/jwt_private.pem` | Falta el paso 4.3, o `WorkingDirectory` no es `/opt/brdp/app/backend` |
| El backend no arranca: error de conexión o de contraseña con PostgreSQL | `DATABASE_URL` en `.env` (usuario, contraseña, `postgresql+asyncpg://`) |
| «Faltan las tablas… migración no aplicada» o `/health` con `up_to_date: false` | `alembic upgrade head` (paso 4.5) |
| `extension "vector" is not available` | Falta pgvector (paso 2.1) |
| `permission denied to create extension "vector"` | La extensión la tiene que crear `postgres` (paso 2.2) |
| La IA falla con `SSLCertVerificationError` en el log | Inspección SSL: falta `Environment=SSL_CERT_FILE=…` en el servicio (paso 4.4). En `.env` no sirve |
| `npm ci` falla con `SELF_SIGNED_CERT_IN_CHAIN` | Inspección SSL: `NODE_EXTRA_CA_CERTS` (paso 5) |
| La IA corta a los 60 s | Falta `proxy_read_timeout 330s` en nginx |
| Subir un Excel o un BREX da `413` | Falta `client_max_body_size 25m` en nginx |
| La página da `500` o `403` | nginx no puede leer los ficheros: sirve `/var/www/brdp`, no `/opt/brdp/app/dist` (paso 5) |
| Adjuntar un PDF en AI Extract no hace nada o da error | nginx sirve el `.mjs` del lector de PDF con un tipo que no es JavaScript: falta el bloque `location ~* \.mjs$` (paso 6.2) |
| Una ruta como `/projects/…` da `404` al recargar | Falta `try_files $uri $uri/ /index.html;` |
| Sugerir pide «Compute embeddings» | Normal tras cargar catálogos o validar BRDP: pulsarlo |
