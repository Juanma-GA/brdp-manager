# BRDP Manager — Instalación en Windows Server

Para Windows Server 2019 y 2022, sin Docker: PostgreSQL 16 con pgvector, el backend como servicio de Windows e IIS con HTTPS delante.

Antes de empezar, lee [README.md](README.md): requisitos, por qué hace falta HTTPS y **el aviso sobre los datos de cliente del repositorio**.

> **No probado en un servidor real.** Esta guía está revisada contra el código y sigue los mismos pasos que la de Ubuntu, que sí está probada de principio a fin. Lo propio de Windows (instaladores, compilación de pgvector, NSSM, IIS con ARR, permisos con `icacls`) no se ha ejecutado. Si un paso falla, anótalo para corregir la guía.

Decisiones de esta guía:

- **Proxy: IIS con URL Rewrite + Application Request Routing (ARR).** Es el servidor web de Microsoft, con soporte, que usa el almacén de certificados de Windows y la PKI corporativa sin herramientas extra; nginx para Windows es una compilación que su propio proyecto no considera de producción.
- **Servicio: NSSM.** Windows no puede ejecutar un programa de Python como servicio por sí solo; NSSM (gratuito, muy extendido) lo envuelve, lo reinicia si se cae, guarda su salida en un fichero y permite dar al servicio variables de entorno propias (`SSL_CERT_FILE`).

Convenciones:

- Todo se ejecuta en **PowerShell como administrador**, salvo donde se indica.
- `brdp.example.local` es el nombre del servidor: cámbialo por el real.
- Los valores entre `<…>` son tuyos: `<CONTRASEÑA_BD>`, `<CONTRASEÑA_POSTGRES>`, `<CONTRASEÑA_SERVICIO>`, `<CLAVE_MISTRAL>`, `<HUELLA_CERTIFICADO>`.
- Rutas: el código en `C:\BRDP\app`, el frontend compilado en `C:\inetpub\brdp`, certificados en `C:\BRDP\certs`, el log del backend en `C:\BRDP\logs`.

---

## 1. Paquetes

Descarga e instala (con las opciones por defecto salvo lo que se indica):

| Programa | Versión | Notas |
|---|---|---|
| Git for Windows | la actual | |
| Python | 3.12 (64 bits), de python.org | Marca «Install for all users» y «Add python.exe to PATH». Queda en `C:\Program Files\Python312` |
| Node.js | 22 LTS (MSI de nodejs.org) | Solo para compilar el frontend |
| PostgreSQL | 16 (instalador de EDB para Windows) | Pide una contraseña para el usuario `postgres`: `<CONTRASEÑA_POSTGRES>`. Puerto 5432. Servicio `postgresql-x64-16` |
| Visual Studio 2022 Build Tools | con la carga «Desktop development with C++» | Solo para compilar pgvector (paso 2.1) |
| NSSM | 2.24 (nssm.cc), copia `win64\nssm.exe` a `C:\BRDP\tools\nssm.exe` | Paso 4.6 |
| IIS | rol de Windows | Paso 6 |
| URL Rewrite 2.1 y Application Request Routing 3.0 | MSI de iis.net | Paso 6 |

Abre una consola nueva y comprueba:

```powershell
git --version
python --version          # Python 3.12.x
node -v                   # v22.x
$env:Path += ";C:\Program Files\PostgreSQL\16\bin"
psql --version            # psql (PostgreSQL) 16.x
```

Para no repetir el último paso, añade `C:\Program Files\PostgreSQL\16\bin` al `PATH` del sistema (Configuración avanzada del sistema → Variables de entorno).

---

## 2. Base de datos y pgvector

### 2.1 pgvector

El instalador de EDB no trae pgvector: hay que compilarlo una vez. Abre **«x64 Native Tools Command Prompt for VS 2022»** como administrador (es `cmd`, no PowerShell) y ejecuta:

```bat
set "PGROOT=C:\Program Files\PostgreSQL\16"
cd %TEMP%
git clone --branch v0.8.0 https://github.com/pgvector/pgvector.git
cd pgvector
nmake /F Makefile.win
nmake /F Makefile.win install
```

Comprueba, de vuelta en PowerShell:

```powershell
psql -U postgres -h localhost -Atc "SELECT name, default_version FROM pg_available_extensions WHERE name = 'vector';"
```

Tiene que devolver `vector|0.8.0`. Si no devuelve nada, pgvector no está instalado y la migración fallará con:

```
ERROR:  extension "vector" is not available
DETAIL:  Could not open extension control file "C:/Program Files/PostgreSQL/16/share/extension/vector.control": No such file or directory.
```

### 2.2 Crear el usuario y la base

```powershell
psql -U postgres -h localhost -v ON_ERROR_STOP=1 -c "CREATE ROLE brdp LOGIN PASSWORD '<CONTRASEÑA_BD>';"
psql -U postgres -h localhost -v ON_ERROR_STOP=1 -c "CREATE DATABASE brdp_manager OWNER brdp;"
psql -U postgres -h localhost -v ON_ERROR_STOP=1 -d brdp_manager -c "CREATE EXTENSION IF NOT EXISTS vector;"
```

(Cada `psql` pide la contraseña de `postgres`.) La extensión la crea `postgres` porque `brdp` no es superusuario (si lo intentara `brdp`: `permission denied to create extension "vector"`).

PostgreSQL de EDB acepta contraseña desde `127.0.0.1` y escucha en todas las interfaces: si el servidor no tiene que aceptar conexiones de fuera, deja el puerto 5432 cerrado en el cortafuegos de Windows (lo está por defecto).

**Si vas a traer datos** ([migracion-datos.md](migracion-datos.md)), crea la base igual, pero **no** ejecutes `alembic upgrade head` en el paso 4.5.

---

## 3. Usuario del sistema y código

El servicio del backend corre con un usuario local sin privilegios, `brdp`:

```powershell
$pass = Read-Host -AsSecureString "Contraseña para el usuario brdp"
New-LocalUser -Name brdp -Password $pass -PasswordNeverExpires -UserMayNotChangePassword -Description "BRDP Manager backend"

New-Item -ItemType Directory -Force C:\BRDP, C:\BRDP\certs, C:\BRDP\logs, C:\BRDP\tools | Out-Null
git clone -b v2-multiproyecto https://github.com/Juanma-GA/brdp-manager.git C:\BRDP\app
```

- Si el repositorio pasa a privado, usa un token de solo lectura de GitHub.
- El backend lee ficheros de todo el repositorio (`public\`, `sources\S*\`, `backend\schema_cards\`): clónalo entero.
- El clon se hace como administrador; en el paso 4.7 se da al usuario `brdp` acceso de lectura.

---

## 4. Backend

### 4.1 Entorno de Python e instalación

```powershell
cd C:\BRDP\app\backend
python -m venv .venv
.venv\Scripts\python -m pip install --require-hashes -r requirements.lock.txt
```

`requirements.lock.txt` (producción) vale en Windows y en Linux (lleva los paquetes propios de Windows marcados). No uses `requirements-dev.lock.txt` ni `pip install -e`. Con inspección SSL, añade `--cert C:\BRDP\certs\corporate-root.pem`.

### 4.2 El fichero `backend\.env`

Créalo con el Bloc de notas (`notepad C:\BRDP\app\backend\.env`) y guárdalo como **UTF-8**. **No** lo crees con `>` ni `Out-File` en Windows PowerShell 5.1: escriben UTF-16 y el backend no arranca (`UnicodeDecodeError: 'utf-8' codec can't decode byte 0xff`).

Son todas las variables que lee `backend/app/core/config.py`, con su valor por defecto comentado:

```ini
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

# --- Sesiones (claves del paso 4.3, relativas a backend\) ---
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
# SOURCES_DIR (por defecto <repo>\sources; vacía rompe la validación de BREX)
# INITIAL_ADMIN_EMAIL / INITIAL_ADMIN_PASSWORD (el paso 7 las pide por consola)
# TEST_DATABASE_URL (solo tests)
```

Qué significa cada una: tabla de [README.md](README.md#variables-del-backend-backendenv). `ENVIRONMENT=production` hace `Secure` la cookie de sesión: con él, el acceso tiene que ser por HTTPS (paso 6). La app busca `.env` en el directorio de trabajo: el servicio arranca en `C:\BRDP\app\backend` (paso 4.6).

### 4.3 Claves JWT

```powershell
cd C:\BRDP\app\backend
.venv\Scripts\python scripts\generate_rsa_keypair.py
```

Escribe `keys\jwt_private.pem` y `keys\jwt_public.pem`. Se generan en cada servidor; no se copian de otra instalación. Los permisos se cierran en el paso 4.7.

### 4.4 Solo con inspección SSL (Zscaler): el certificado corporativo

Copia el certificado raíz corporativo (formato `.pem`, Base64) a `C:\BRDP\certs\corporate-root.pem` y crea un fichero con los certificados públicos de Python más el corporativo:

```powershell
$certifi = & C:\BRDP\app\backend\.venv\Scripts\python -m certifi
$bundle = (Get-Content -Raw $certifi) + "`n" + (Get-Content -Raw C:\BRDP\certs\corporate-root.pem)
[IO.File]::WriteAllText("C:\BRDP\certs\ca-bundle.pem", $bundle, (New-Object Text.UTF8Encoding $false))
```

`C:\BRDP\certs\ca-bundle.pem` se da al servicio en el paso 4.6 (`SSL_CERT_FILE`), **no** en `.env`. Sin él, en el log del backend sale `SSLCertVerificationError` en cada llamada a la IA.

### 4.5 Esquema de la base

Solo en una instalación nueva:

```powershell
cd C:\BRDP\app\backend
.venv\Scripts\alembic upgrade head
.venv\Scripts\alembic current        # debe terminar en "(head)"
```

### 4.6 El backend como servicio (NSSM)

```powershell
$nssm = "C:\BRDP\tools\nssm.exe"
& $nssm install brdp-backend "C:\BRDP\app\backend\.venv\Scripts\uvicorn.exe"
& $nssm set brdp-backend AppParameters "app.main:app --host 127.0.0.1 --port 8000 --proxy-headers"
& $nssm set brdp-backend AppDirectory "C:\BRDP\app\backend"
& $nssm set brdp-backend DisplayName "BRDP Manager backend"
& $nssm set brdp-backend Start SERVICE_AUTO_START
& $nssm set brdp-backend DependOnService postgresql-x64-16
& $nssm set brdp-backend AppStdout "C:\BRDP\logs\backend.log"
& $nssm set brdp-backend AppStderr "C:\BRDP\logs\backend.log"
& $nssm set brdp-backend AppRotateFiles 1
& $nssm set brdp-backend AppRotateBytes 10485760
& $nssm set brdp-backend ObjectName ".\brdp" "<CONTRASEÑA_SERVICIO>"
# Solo con inspección SSL (paso 4.4). Es una variable del servicio, no de .env:
# & $nssm set brdp-backend AppEnvironmentExtra "SSL_CERT_FILE=C:\BRDP\certs\ca-bundle.pem"
```

`<CONTRASEÑA_SERVICIO>` es la del usuario `brdp` del paso 3. Al ponerle el usuario, NSSM le da el derecho «Iniciar sesión como servicio»; si no, dáselo en `secpol.msc` → Directivas locales → Asignación de derechos de usuario.

No lo arranques todavía: primero los permisos (paso 4.7).

### 4.7 Permisos

El usuario `brdp` tiene que poder leer el código y escribir el log; `.env` y `keys` solo los leen `brdp` y los administradores:

```powershell
icacls C:\BRDP\app /grant "brdp:(OI)(CI)RX" /T /Q
icacls C:\BRDP\logs /grant "brdp:(OI)(CI)M" /Q
icacls C:\BRDP\app\backend\.env /inheritance:r /grant:r "brdp:R" "*S-1-5-32-544:F" "*S-1-5-18:F"
icacls C:\BRDP\app\backend\keys /inheritance:r /grant:r "brdp:(OI)(CI)R" "*S-1-5-32-544:(OI)(CI)F" "*S-1-5-18:(OI)(CI)F" /T
```

`*S-1-5-32-544` es el grupo de administradores y `*S-1-5-18` la cuenta SYSTEM (se usan sus identificadores para que valga en un Windows en español o en inglés).

```powershell
Start-Service brdp-backend
Get-Service brdp-backend
Invoke-RestMethod http://127.0.0.1:8000/health
```

`/health` debe devolver `status = ok` y `migrations.up_to_date = True`. El log: `Get-Content C:\BRDP\logs\backend.log -Tail 50 -Wait`. Un solo proceso: no añadas `--workers`. uvicorn escucha solo en `127.0.0.1`: desde fuera se entra por IIS.

---

## 5. Frontend

```powershell
cd C:\BRDP\app
npm ci
npm run build                                # genera dist\
New-Item -ItemType Directory -Force C:\inetpub\brdp | Out-Null
Remove-Item C:\inetpub\brdp\* -Recurse -Force -Exclude web.config
Copy-Item C:\BRDP\app\dist\* C:\inetpub\brdp -Recurse -Force
```

- `npm ci` instala exactamente `package-lock.json`. Nunca `npm audit fix --force`.
- Con inspección SSL, `npm ci` falla con `SELF_SIGNED_CERT_IN_CHAIN` o `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`: antes, `$env:NODE_EXTRA_CA_CERTS = "C:\BRDP\certs\corporate-root.pem"` en la misma consola.
- El `-Exclude web.config` conserva la configuración de IIS del paso 6.3 al actualizar.

---

## 6. Proxy y HTTPS (IIS)

### 6.1 IIS, URL Rewrite y ARR

```powershell
Install-WindowsFeature Web-Server, Web-Static-Content, Web-Default-Doc, Web-Http-Errors, Web-Http-Redirect -IncludeManagementTools
# Después, instala los dos MSI descargados de iis.net:
msiexec /i C:\BRDP\tools\rewrite_amd64_en-US.msi /quiet
msiexec /i C:\BRDP\tools\requestRouter_amd64.msi /quiet
```

Activa ARR como proxy, con el tiempo de espera y sin búfer de respuesta (a nivel de servidor):

```powershell
$appcmd = "$env:windir\system32\inetsrv\appcmd.exe"
& $appcmd set config -section:system.webServer/proxy /enabled:"True" /preserveHostHeader:"True" /timeout:"00:05:30" /responseBufferLimit:"0" /commit:apphost
```

- `timeout 00:05:30` = 330 s: la IA puede tardar hasta `LLM_REQUEST_TIMEOUT_SECONDS` (300 s).
- `responseBufferLimit 0`: el proxy del LLM puede responder en streaming.

### 6.2 Certificado y sitio

Importa el certificado del servidor (`.pfx` con su clave, de la PKI interna) y anota su huella:

```powershell
$pfxpass = Read-Host -AsSecureString "Contraseña del .pfx"
Import-PfxCertificate -FilePath C:\BRDP\certs\brdp.pfx -CertStoreLocation Cert:\LocalMachine\My -Password $pfxpass
Get-ChildItem Cert:\LocalMachine\My | Where-Object Subject -like "*brdp.example.local*" | Format-List Subject, Thumbprint, NotAfter
```

Crea el sitio con HTTPS y HTTP (el HTTP solo redirige):

```powershell
Import-Module IISAdministration
Stop-IISSite -Name "Default Web Site" -Confirm:$false
New-IISSite -Name brdp -PhysicalPath C:\inetpub\brdp -BindingInformation "*:443:brdp.example.local" -Protocol https -CertificateThumbPrint "<HUELLA_CERTIFICADO>" -CertStoreLocation "Cert:\LocalMachine\My" -SslFlag Sni
New-IISSiteBinding -Name brdp -BindingInformation "*:80:brdp.example.local" -Protocol http
New-NetFirewallRule -DisplayName "BRDP HTTP/HTTPS" -Direction Inbound -Protocol TCP -LocalPort 80,443 -Action Allow
```

### 6.3 `C:\inetpub\brdp\web.config`

Créalo con el Bloc de notas (UTF-8):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<configuration>
  <system.webServer>
    <rewrite>
      <rules>
        <!-- HTTP a HTTPS -->
        <rule name="http-to-https" stopProcessing="true">
          <match url="(.*)" />
          <conditions><add input="{HTTPS}" pattern="off" /></conditions>
          <action type="Redirect" url="https://{HTTP_HOST}/{R:1}" redirectType="Permanent" />
        </rule>
        <!-- /api/... y /health al backend -->
        <rule name="backend" stopProcessing="true">
          <match url="^(api/.*|health)$" />
          <action type="Rewrite" url="http://127.0.0.1:8000/{R:1}" />
        </rule>
        <!-- La app es de una sola página: cualquier otra ruta que no sea un fichero va a index.html -->
        <rule name="spa" stopProcessing="true">
          <match url=".*" />
          <conditions logicalGrouping="MatchAll">
            <add input="{REQUEST_FILENAME}" matchType="IsFile" negate="true" />
            <add input="{REQUEST_FILENAME}" matchType="IsDirectory" negate="true" />
          </conditions>
          <action type="Rewrite" url="/index.html" />
        </rule>
      </rules>
    </rewrite>
    <security>
      <requestFiltering>
        <!-- 25 MB: Excel hasta 10 MB, BREX/Schematron de AI Extract hasta 20 MB -->
        <requestLimits maxAllowedContentLength="26214400" />
      </requestFiltering>
    </security>
    <!-- Sin compresión dinámica: retendría las respuestas en streaming -->
    <urlCompression doDynamicCompression="false" />
    <staticContent>
      <!-- .mjs: el worker del lector de PDF se carga como módulo y necesita un tipo JavaScript -->
      <remove fileExtension=".mjs" />
      <mimeMap fileExtension=".mjs" mimeType="text/javascript" />
      <remove fileExtension=".json" />
      <mimeMap fileExtension=".json" mimeType="application/json" />
      <remove fileExtension=".woff2" />
      <mimeMap fileExtension=".woff2" mimeType="font/woff2" />
    </staticContent>
  </system.webServer>
</configuration>
```

```powershell
iisreset
```

**No hay alternativa por HTTP**: con `ENVIRONMENT=production` la sesión no se mantiene sin HTTPS (ver [README.md](README.md#por-qué-hace-falta-https)), y no se debe desactivar.

---

## 7. Primer administrador

Solo en una instalación nueva (si traes datos, los usuarios viajan con la base):

```powershell
cd C:\BRDP\app\backend
.venv\Scripts\python scripts\create_admin_user.py
```

Pide correo y contraseña y crea un usuario con rol global `admin`. **El correo tiene que tener un dominio real**: el script comprueba el correo igual que el login y rechaza, sin crear nada, los dominios reservados (`.local`, `.localhost`, `.test`, `.invalid`).

---

## 8. Catálogos y ficheros que necesita la app

No hay que copiar ficheros aparte: el backend usa `sources\S3.0.1`, `sources\S4.1`, `sources\S4.2` (XSD del BREX), `public\brdp-template-*.xlsx` y `backend\schema_cards\` del propio repositorio.

Catálogos oficiales (instalación nueva; si traes datos ya vienen en la base):

```powershell
cd C:\BRDP\app\backend
.venv\Scripts\python scripts\import_brdp_catalog.py catalog_sources\s1000d_4.2.xlsx "S1000D 4.2"
.venv\Scripts\python scripts\import_brdp_catalog.py catalog_sources\s1000d_4.1.xlsx "S1000D 4.1"
.venv\Scripts\python scripts\import_brdp_catalog.py catalog_sources\s1000d_301_attributes_catalog.xlsx "S1000D 3.0.1"
.venv\Scripts\python scripts\import_brdp_catalog.py catalog_sources\dita_1.3.xlsx "DITA 1.3 Xpath2.0"
.venv\Scripts\python scripts\import_brdp_catalog.py catalog_sources\dita_1.3.xlsx "DITA 1.3 Xpath3.0"
```

Resultado esperado: 427, 552, 27, 100 y 100 filas. Sus embeddings se calculan con «Compute embeddings» la primera vez que se use Sugerir.

---

## 9. Comprobación final

1. `Invoke-RestMethod https://brdp.example.local/health` (desde el propio servidor, con el nombre real): `status = ok`, `up_to_date = True`.
2. Desde otro equipo, `https://brdp.example.local`: entra con el administrador y **recarga la página**; tienes que seguir dentro.
3. Una pregunta en «Preguntar» (Ask) dentro de una BRDP: tiene que responder. Comprobación en la base:
   ```powershell
   psql -U brdp -h localhost -d brdp_manager -c "SELECT created_at, kind, result, upstream_status FROM llm_calls WHERE kind = 'chat' ORDER BY created_at DESC LIMIT 5;"
   ```
   La última fila debe tener `result = ok`.
4. Una BRDP *Validated* y «Compute embeddings»: tiene que terminar sin error.

---

## 10. Copias de seguridad

Un script `C:\BRDP\tools\backup.ps1`:

```powershell
$dir = "D:\Backups\brdp"
New-Item -ItemType Directory -Force $dir | Out-Null
$env:PGPASSFILE = "C:\BRDP\tools\pgpass.conf"
& "C:\Program Files\PostgreSQL\16\bin\pg_dump.exe" -h localhost -U brdp -d brdp_manager -Fc -f "$dir\brdp_$(Get-Date -Format yyyy-MM-dd).dump"
Get-ChildItem $dir -Filter "brdp_*.dump" | Where-Object LastWriteTime -lt (Get-Date).AddDays(-14) | Remove-Item
```

- `pg_dump -f` escribe el fichero directamente. **Nunca** `pg_dump … > fichero` en PowerShell: estropea el volcado binario.
- `C:\BRDP\tools\pgpass.conf` tiene una línea `localhost:5432:brdp_manager:brdp:<CONTRASEÑA_BD>`; ciérralo con `icacls` igual que `.env` (solo administradores y la cuenta que ejecute la tarea).
- Prográmalo a diario con el Programador de tareas (`taskschd.msc`), con una cuenta de servicio que pueda escribir en `D:\Backups\brdp`, o:
  ```powershell
  $a = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File C:\BRDP\tools\backup.ps1"
  $t = New-ScheduledTaskTrigger -Daily -At 2:30am
  Register-ScheduledTask -TaskName "BRDP backup" -Action $a -Trigger $t -User "SYSTEM" -RunLevel Highest
  ```

Guarda también, fuera del servidor y en un sitio seguro, `C:\BRDP\app\backend\.env` y `C:\BRDP\app\backend\keys\` (no están en git). Las copias contienen usuarios y datos de cliente: confidenciales. Restaurar: [migracion-datos.md](migracion-datos.md), paso 3.

---

## 11. Actualizar a una versión nueva

Primero una copia de la base (paso 10, a mano). Después:

```powershell
Stop-Service brdp-backend
cd C:\BRDP\app
git pull
cd backend
.venv\Scripts\python -m pip install --require-hashes -r requirements.lock.txt
.venv\Scripts\alembic upgrade head
cd ..
npm ci
npm run build
Remove-Item C:\inetpub\brdp\* -Recurse -Force -Exclude web.config
Copy-Item C:\BRDP\app\dist\* C:\inetpub\brdp -Recurse -Force
icacls C:\BRDP\app /grant "brdp:(OI)(CI)RX" /T /Q
Start-Service brdp-backend
Invoke-RestMethod http://127.0.0.1:8000/health
```

`git pull` como administrador puede avisar de «dubious ownership» si el clon lo hizo otra cuenta: `git config --global --add safe.directory C:/BRDP/app`.

---

## 12. Problemas típicos

| Síntoma | Causa y arreglo |
|---|---|
| Al recargar la página vuelve al login | Se entra por HTTP: la cookie es `Secure`. Entra por `https://`. En el propio servidor por `http://localhost` sí funciona: no sirve como prueba |
| `create_admin_user.py` dice «Invalid email … special-use or reserved name» | Dominio reservado (`.local`, `.test`…): vuelve a ejecutarlo con un dominio real |
| El servicio no arranca o se para enseguida | `C:\BRDP\logs\backend.log`; casi siempre `.env` (paso 4.2), las claves (4.3) o los permisos (4.7) |
| `UnicodeDecodeError: 'utf-8' codec can't decode byte 0xff` al arrancar | `.env` guardado en UTF-16: vuelve a guardarlo como UTF-8 (paso 4.2) |
| `502.3 Bad Gateway` en `/api` | Backend parado (`Get-Service brdp-backend`) o ARR sin activar (paso 6.1) |
| `404` en `/api/...` | URL Rewrite o ARR no instalados, o falta `web.config` (paso 6.3) |
| Una ruta como `/projects/…` da `404` al recargar | Falta la regla `spa` de `web.config` |
| Subir un Excel o un BREX da `413` o `404.13` | Falta `maxAllowedContentLength` en `web.config` |
| La IA corta antes de 5 minutos con `502.3` | Falta `/timeout:"00:05:30"` en ARR (paso 6.1) |
| Adjuntar un PDF en AI Extract no hace nada o da error | Falta el `mimeMap` de `.mjs` en `web.config` |
| `extension "vector" is not available` | pgvector sin compilar o instalado en otra versión de PostgreSQL (paso 2.1) |
| La IA falla con `SSLCertVerificationError` en el log | Falta `AppEnvironmentExtra SSL_CERT_FILE=…` en el servicio (paso 4.6) |
| `npm ci` falla con `SELF_SIGNED_CERT_IN_CHAIN` | `$env:NODE_EXTRA_CA_CERTS` (paso 5) |
| `/health` con `up_to_date: False` | `.venv\Scripts\alembic upgrade head` |
