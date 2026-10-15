# BRDP Manager — Instalación en RHEL / Rocky / Alma 9

Para Red Hat Enterprise Linux 9, Rocky Linux 9 y AlmaLinux 9, sin Docker: PostgreSQL 16 con pgvector (repositorio PGDG), el backend como servicio de systemd y nginx con HTTPS delante, con SELinux activo y firewalld.

Antes de empezar, lee [README.md](README.md): requisitos, por qué hace falta HTTPS y **el aviso sobre los datos de cliente del repositorio**.

> **No probado en un servidor real.** Esta guía está revisada contra el código y sigue los mismos pasos que la de Ubuntu, que sí está probada de principio a fin. Lo que es propio de RHEL (dnf, PGDG, SELinux, firewalld, rutas de `/usr/pgsql-16`) está escrito según la documentación de cada paquete, pero no se ha ejecutado. Si un paso falla, anótalo para corregir la guía.

Convenciones:

- Todo se ejecuta como un usuario con `sudo`.
- `brdp.example.local` es el nombre del servidor: cámbialo por el real.
- Los valores entre `<…>` son tuyos: `<CONTRASEÑA_BD>`, `<CLAVE_MISTRAL>`.
- Rutas: el código en `/opt/brdp/app`, el frontend compilado en `/var/www/brdp`, los certificados en `/etc/pki/tls`.
- En RHEL los programas de PostgreSQL 16 están en `/usr/pgsql-16/bin` y los datos en `/var/lib/pgsql/16/data`.

---

## 1. Paquetes

En RHEL, el servidor tiene que estar suscrito con los repositorios `BaseOS` y `AppStream` (Rocky/Alma los traen activados).

```bash
sudo dnf install -y git curl openssl tar policycoreutils-python-utils
# Python 3.11 (AppStream)
sudo dnf install -y python3.11 python3.11-pip
# nginx 1.24 (AppStream); si el módulo no existe en tu versión, basta "dnf install nginx"
sudo dnf module enable -y nginx:1.24
sudo dnf install -y nginx
# Node.js 22 (AppStream, RHEL 9.5 o posterior), solo para compilar el frontend
sudo dnf module enable -y nodejs:22
sudo dnf install -y nodejs
node -v      # v22.x
```

Si tu versión no tiene el módulo `nodejs:22`, instala Node 22 desde NodeSource (`curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash -` y `sudo dnf install -y nodejs`).

**PostgreSQL 16 y pgvector** (repositorio oficial PGDG; el PostgreSQL de AppStream no trae pgvector):

```bash
sudo dnf install -y https://download.postgresql.org/pub/repos/yum/reporpms/EL-9-x86_64/pgdg-redhat-repo-latest.noarch.rpm
sudo dnf -qy module disable postgresql
sudo dnf install -y postgresql16-server postgresql16 pgvector_16
sudo /usr/pgsql-16/bin/postgresql-16-setup initdb
sudo systemctl enable --now postgresql-16
```

---

## 2. Base de datos y pgvector

### 2.1 Comprobar que pgvector está instalado

```bash
sudo -u postgres psql -Atc "SELECT name, default_version FROM pg_available_extensions WHERE name = 'vector';"
```

Tiene que devolver una línea (`vector|0.8.x` o parecido). Si no devuelve nada, falta el paquete `pgvector_16`. Sin él, el paso siguiente y la migración fallan con:

```
ERROR:  extension "vector" is not available
DETAIL:  Could not open extension control file "/usr/pgsql-16/share/extension/vector.control": No such file or directory.
```

### 2.2 Acceso con contraseña desde `localhost`

El backend se conecta a `127.0.0.1` con usuario y contraseña. Abre `/var/lib/pgsql/16/data/pg_hba.conf` y comprueba que las líneas `host` de `127.0.0.1/32` y `::1/128` usan `scram-sha-256` (si dicen `ident`, cámbialo):

```
host    all             all             127.0.0.1/32            scram-sha-256
host    all             all             ::1/128                 scram-sha-256
```

```bash
sudo systemctl reload postgresql-16
```

PostgreSQL escucha solo en `localhost` (`listen_addresses` por defecto): déjalo así.

### 2.3 Crear el usuario y la base

```bash
sudo -u postgres psql -v ON_ERROR_STOP=1 <<'SQL'
CREATE ROLE brdp LOGIN PASSWORD '<CONTRASEÑA_BD>';
CREATE DATABASE brdp_manager OWNER brdp;
\c brdp_manager
CREATE EXTENSION IF NOT EXISTS vector;
SQL
```

La extensión la crea `postgres` porque `brdp` no es superusuario (si lo intentara `brdp`: `permission denied to create extension "vector"`). La migración `0001` vuelve a pedirla con `IF NOT EXISTS`.

**Si vas a traer datos** ([migracion-datos.md](migracion-datos.md)), crea la base igual, pero **no** ejecutes `alembic upgrade head` en el paso 4.5.

---

## 3. Usuario del sistema y código

```bash
sudo useradd --system --create-home --home-dir /opt/brdp --shell /sbin/nologin brdp
sudo -u brdp git clone -b v2-multiproyecto https://github.com/Juanma-GA/brdp-manager.git /opt/brdp/app
```

- Si el repositorio pasa a privado, usa un token de solo lectura de GitHub.
- `/opt/brdp` queda con permisos que nginx (usuario `nginx`) no puede leer: el frontend se copia a `/var/www/brdp` (paso 5), que además tiene ya el contexto SELinux correcto.
- El backend lee ficheros de todo el repositorio (`public/`, `sources/S*/`, `backend/schema_cards/`): clónalo entero.

---

## 4. Backend

### 4.1 Entorno de Python e instalación

```bash
cd /opt/brdp/app/backend
sudo -u brdp python3.11 -m venv .venv
sudo -u brdp .venv/bin/pip install --require-hashes -r requirements.lock.txt
```

Usa `requirements.lock.txt` (producción). No uses `requirements-dev.lock.txt` ni `pip install -e`. Con inspección SSL, añade `--cert /etc/pki/tls/certs/corporate-root.pem`.

### 4.2 El fichero `backend/.env`

Igual que en Ubuntu: todas las variables que lee `backend/app/core/config.py`, con su valor por defecto comentado.

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

Qué significa cada una: tabla de [README.md](README.md#variables-del-backend-backendenv). `ENVIRONMENT=production` hace `Secure` la cookie de sesión: con él, el acceso tiene que ser por HTTPS (paso 6).

### 4.3 Claves JWT

```bash
cd /opt/brdp/app/backend
sudo -u brdp .venv/bin/python scripts/generate_rsa_keypair.py
```

Escribe `keys/jwt_private.pem` (600) y `keys/jwt_public.pem`. Se generan en cada servidor; no se copian de otra instalación.

### 4.4 Solo con inspección SSL (Zscaler): el certificado corporativo

```bash
sudo cp <ruta>/corporate-root.pem /etc/pki/tls/certs/corporate-root.pem
cat "$(/opt/brdp/app/backend/.venv/bin/python -m certifi)" /etc/pki/tls/certs/corporate-root.pem \
  | sudo tee /etc/pki/tls/certs/brdp-ca-bundle.pem >/dev/null
sudo chmod 644 /etc/pki/tls/certs/corporate-root.pem /etc/pki/tls/certs/brdp-ca-bundle.pem
sudo restorecon -v /etc/pki/tls/certs/corporate-root.pem /etc/pki/tls/certs/brdp-ca-bundle.pem
```

`brdp-ca-bundle.pem` se da al servicio en el paso 4.6 (`SSL_CERT_FILE`), **no** en `.env`. Sin él, en el log sale `SSLCertVerificationError` en cada llamada a la IA.

### 4.5 Esquema de la base

Solo en una instalación nueva:

```bash
cd /opt/brdp/app/backend
sudo -u brdp .venv/bin/alembic upgrade head
sudo -u brdp .venv/bin/alembic current      # debe terminar en "(head)"
```

### 4.6 El backend como servicio

Crea `/etc/systemd/system/brdp-backend.service`:

```ini
[Unit]
Description=BRDP Manager backend (FastAPI)
After=network-online.target postgresql-16.service
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
#Environment=SSL_CERT_FILE=/etc/pki/tls/certs/brdp-ca-bundle.pem

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now brdp-backend
sudo systemctl status brdp-backend
curl -s http://127.0.0.1:8000/health
```

`/health` debe dar `"status":"ok"` y `"up_to_date":true`. El log: `journalctl -u brdp-backend -f`. Un solo proceso: no añadas `--workers`.

SELinux: un servicio de systemd que arranca un programa de `/opt` corre sin confinar (`unconfined_service_t`), así que el backend no necesita reglas propias. Si `systemctl status` dice `Permission denied` al arrancar `uvicorn`, revisa `sudo ausearch -m avc -ts recent` y `sudo restorecon -Rv /opt/brdp`.

---

## 5. Frontend

```bash
cd /opt/brdp/app
sudo -u brdp npm ci
sudo -u brdp npm run build                    # genera dist/
sudo install -d -m 755 /var/www/brdp
sudo rm -rf /var/www/brdp/*
sudo cp -r /opt/brdp/app/dist/. /var/www/brdp/
sudo restorecon -Rv /var/www/brdp
```

- `restorecon` deja los ficheros con el contexto `httpd_sys_content_t`, el que nginx puede leer. `cp` desde `/opt` puede dejarlos con otro contexto y nginx daría `403`.
- Con inspección SSL, `npm ci` falla con `SELF_SIGNED_CERT_IN_CHAIN`: `sudo -u brdp env NODE_EXTRA_CA_CERTS=/etc/pki/tls/certs/corporate-root.pem npm ci`.
- Nunca `npm audit fix --force`.

---

## 6. Proxy y HTTPS (nginx)

### 6.1 Certificado

```bash
sudo cp <ruta>/brdp.crt /etc/pki/tls/certs/brdp.crt        # con la cadena intermedia, si la hay
sudo cp <ruta>/brdp.key /etc/pki/tls/private/brdp.key
sudo chmod 600 /etc/pki/tls/private/brdp.key
sudo restorecon -v /etc/pki/tls/certs/brdp.crt /etc/pki/tls/private/brdp.key
```

Para probar mientras llega el certificado bueno:

```bash
sudo openssl req -x509 -newkey rsa:2048 -nodes -days 30 -subj "/CN=brdp.example.local" \
     -addext "subjectAltName=DNS:brdp.example.local" \
     -keyout /etc/pki/tls/private/brdp.key -out /etc/pki/tls/certs/brdp.crt
```

### 6.2 Configuración de nginx

Crea `/etc/nginx/conf.d/brdp.conf` (el `nginx.conf` de la raíz del repo es el de Docker: no sirve aquí):

```nginx
server {
    listen 80;
    server_name brdp.example.local;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name brdp.example.local;

    ssl_certificate     /etc/pki/tls/certs/brdp.crt;
    ssl_certificate_key /etc/pki/tls/private/brdp.key;

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

### 6.3 SELinux y cortafuegos

```bash
# nginx tiene que poder conectarse al backend (127.0.0.1:8000). Sin esto: 502 y
# "connect() to 127.0.0.1:8000 failed (13: Permission denied)" en /var/log/nginx/error.log.
sudo setsebool -P httpd_can_network_connect 1

sudo firewall-cmd --permanent --add-service=http --add-service=https
sudo firewall-cmd --reload

sudo nginx -t
sudo systemctl enable --now nginx
sudo systemctl reload nginx
```

No desactives SELinux (`setenforce 0`) para «arreglar» un `403` o un `502`: casi siempre es `restorecon` (paso 5) o el booleano de arriba.

**No hay alternativa por HTTP**: con `ENVIRONMENT=production` la sesión no se mantiene sin HTTPS (ver [README.md](README.md#por-qué-hace-falta-https)), y no se debe desactivar.

---

## 7. Primer administrador

Solo en una instalación nueva (si traes datos, los usuarios viajan con la base):

```bash
cd /opt/brdp/app/backend
sudo -u brdp .venv/bin/python scripts/create_admin_user.py
```

Pide correo y contraseña y crea un usuario con rol global `admin`. **El correo tiene que tener un dominio real**: el login rechaza dominios reservados (`.local`, `.localhost`, `.test`, `.invalid`), aunque el script los acepte.

---

## 8. Catálogos y ficheros que necesita la app

No hay que copiar ficheros aparte: el backend usa `sources/S3.0.1`, `sources/S4.1`, `sources/S4.2` (XSD del BREX), `public/brdp-template-*.xlsx` y `backend/schema_cards/` del propio repositorio.

Catálogos oficiales (instalación nueva; si traes datos ya vienen en la base):

```bash
cd /opt/brdp/app/backend
sudo -u brdp .venv/bin/python scripts/import_brdp_catalog.py catalog_sources/s1000d_4.2.xlsx "S1000D 4.2"
sudo -u brdp .venv/bin/python scripts/import_brdp_catalog.py catalog_sources/s1000d_4.1.xlsx "S1000D 4.1"
sudo -u brdp .venv/bin/python scripts/import_brdp_catalog.py catalog_sources/s1000d_301_attributes_catalog.xlsx "S1000D 3.0.1"
sudo -u brdp .venv/bin/python scripts/import_brdp_catalog.py catalog_sources/dita_1.3.xlsx "DITA 1.3 Xpath2.0"
sudo -u brdp .venv/bin/python scripts/import_brdp_catalog.py catalog_sources/dita_1.3.xlsx "DITA 1.3 Xpath3.0"
```

Resultado esperado: 427, 552, 27, 100 y 100 filas. Sus embeddings se calculan con «Compute embeddings» la primera vez que se use Sugerir.

---

## 9. Comprobación final

1. `curl -s https://brdp.example.local/health` (con certificado de prueba, `curl -sk`): `"status":"ok"` y `"up_to_date":true`.
2. Desde otro equipo, `https://brdp.example.local`: entra con el administrador y **recarga la página**; tienes que seguir dentro.
3. Una pregunta en «Preguntar» (Ask) dentro de una BRDP: tiene que responder. Comprobación en la base:
   ```bash
   sudo -u postgres psql -d brdp_manager -c "SELECT created_at, kind, result, upstream_status FROM llm_calls WHERE kind = 'chat' ORDER BY created_at DESC LIMIT 5;"
   ```
   La última fila debe tener `result = ok`.
4. Una BRDP *Validated* y «Compute embeddings»: tiene que terminar sin error.

---

## 10. Copias de seguridad

```bash
sudo install -d -o postgres -g postgres -m 700 /var/backups/brdp
sudo crontab -u postgres -e
```

```cron
30 2 * * * /usr/pgsql-16/bin/pg_dump -d brdp_manager -Fc -f /var/backups/brdp/brdp_$(date +\%F).dump && find /var/backups/brdp -name 'brdp_*.dump' -mtime +14 -delete
```

Guarda también, fuera del servidor y en un sitio seguro, `backend/.env` y `backend/keys/` (no están en git). Las copias contienen usuarios y datos de cliente: confidenciales. Restaurar: [migracion-datos.md](migracion-datos.md), paso 3.

---

## 11. Actualizar a una versión nueva

Primero una copia de la base (paso 10, a mano). Después:

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
sudo restorecon -Rv /var/www/brdp
sudo systemctl restart brdp-backend
curl -s http://127.0.0.1:8000/health
```

---

## 12. Problemas típicos

| Síntoma | Causa y arreglo |
|---|---|
| Al recargar la página vuelve al login | Se entra por HTTP: la cookie es `Secure`. Entra por `https://` |
| El login dice que el correo no es válido | Dominio reservado (`.local`, `.test`…): crea el usuario con un dominio real |
| `502 Bad Gateway` y `connect() … failed (13: Permission denied)` en `/var/log/nginx/error.log` | SELinux: `setsebool -P httpd_can_network_connect 1` |
| `502 Bad Gateway` y `Connection refused` | Backend parado: `systemctl status brdp-backend`, `journalctl -u brdp-backend -n 100` |
| La página da `403` | Contexto SELinux de `/var/www/brdp`: `restorecon -Rv /var/www/brdp` |
| No se llega al servidor desde otro equipo | firewalld: paso 6.3 |
| El backend no se conecta a PostgreSQL (`password authentication failed` o `Ident authentication failed`) | `pg_hba.conf` (paso 2.2) o la contraseña de `DATABASE_URL` |
| `extension "vector" is not available` | Falta `pgvector_16` (paso 1) |
| La IA falla con `SSLCertVerificationError` en el log | Falta `Environment=SSL_CERT_FILE=…` en el servicio (paso 4.4) |
| `npm ci` falla con `SELF_SIGNED_CERT_IN_CHAIN` | `NODE_EXTRA_CA_CERTS` (paso 5) |
| La IA corta a los 60 s / subir un fichero da `413` | Faltan `proxy_read_timeout 330s` / `client_max_body_size 25m` |
| `/health` con `up_to_date: false` | `alembic upgrade head` |
| Adjuntar un PDF en AI Extract no hace nada o da error | nginx sirve el `.mjs` del lector de PDF con un tipo que no es JavaScript: falta el bloque `location ~* \.mjs$` (paso 6.2) |
