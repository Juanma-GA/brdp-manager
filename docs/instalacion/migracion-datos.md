# BRDP Manager — Migración de datos al servidor

Cómo pasar los datos de la instalación actual (PostgreSQL en Docker en un portátil Windows: contenedor `brdp-postgres`, usuario `brdp`, base `brdp_manager`) a un servidor nuevo instalado con [linux-ubuntu.md](linux-ubuntu.md), [linux-rhel.md](linux-rhel.md) o [windows-server.md](windows-server.md).

Se copia la base entera con `pg_dump` y `pg_restore`.

**Probado** en Linux (Ubuntu 24.04, PostgreSQL 16, pgvector 0.6.0) con una base de desarrollo con proyectos, BRDP, reglas, embeddings, historial, catálogos y registros: volcado, restauración en una base nueva, `alembic current`, recuentos por tabla idénticos, y el backend arrancado contra la base restaurada con login correcto. El volcado desde Docker en Windows (paso 2) está revisado, **no ejecutado**: los comandos de PowerShell son los mismos que se usan en Linux dentro del contenedor.

---

## 1. Qué viaja y qué no

| Viaja (está en la base) | No viaja |
|---|---|
| Usuarios, con sus contraseñas (cifradas) y roles por proyecto | Las claves JWT (`backend/keys/`): el servidor genera las suyas |
| Proyectos, su configuración y la Papelera | `backend/.env`: se escribe nuevo en el servidor |
| BRDP, reglas y su estado, pruebas registradas | Los ficheros del repositorio (se clonan en el servidor) |
| Embeddings (BRDP y catálogo) | La base de tests (`brdp_manager_test`): no se migra |
| Historial de cada BRDP | |
| Catálogos oficiales (`brdp_catalog`) | |
| Registro de auditoría (`audit_log`) y de llamadas a la IA (`llm_calls`) | |
| Trabajos de import, embeddings y AI Extract | |

Consecuencias:

- **Todos vuelven a iniciar sesión** en el servidor nuevo (otras claves y otra dirección), con su usuario y contraseña de siempre. Nadie tiene que cambiar nada.
- **No se ejecuta `create_admin_user.py`** ni se cargan los catálogos en el servidor: vienen en la base.
- El fichero del volcado contiene todos los datos de cliente y los usuarios: trátalo como confidencial y bórralo de los dos sitios al terminar.

---

## 2. En el portátil: comprobar y volcar (PowerShell)

### 2.1 Comprobaciones

1. Para el backend del portátil (Ctrl+C en la ventana de uvicorn), para que no quede ningún trabajo a medias. El contenedor de PostgreSQL sigue en marcha:
   ```powershell
   docker start brdp-postgres
   ```
2. Versión de la base (migración de Alembic) y versiones de PostgreSQL y pgvector:
   ```powershell
   docker exec brdp-postgres psql -U brdp -d brdp_manager -Atc "SELECT version_num FROM alembic_version"
   docker exec brdp-postgres psql -U brdp -d brdp_manager -Atc "SHOW server_version"
   docker exec brdp-postgres psql -U brdp -d brdp_manager -Atc "SELECT extversion FROM pg_extension WHERE extname = 'vector'"
   ```
   Anota los tres valores. El código del servidor tiene que estar en esa migración **o en una posterior** (si el servidor tiene la misma versión del repositorio o una más nueva, se cumple). Si en el portátil la migración no es la última, ejecuta antes, desde `backend\`: `.venv\Scripts\alembic upgrade head`.
3. Recuentos por tabla (para comparar al final). Guarda la salida:
   ```powershell
   $q = @'
   SELECT table_name AS tabla,
          (xpath('/row/n/text()',
                 query_to_xml(format('SELECT count(*) AS n FROM public.%I', table_name), false, true, '')))[1]::text::bigint AS filas
   FROM information_schema.tables
   WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
   ORDER BY table_name;
   '@
   docker exec brdp-postgres psql -U brdp -d brdp_manager -c $q
   ```

### 2.2 Volcado

**No uses `>` en PowerShell para el volcado.** En Windows PowerShell 5.1, `pg_dump … > fichero.dump` pasa la salida por texto y la escribe en UTF-16: el fichero queda estropeado y `pg_restore` dice `input file does not appear to be a valid archive`. El volcado se hace **dentro del contenedor**, con `-f`, y se saca con `docker cp`:

```powershell
docker exec brdp-postgres pg_dump -U brdp -d brdp_manager -Fc --no-owner --no-acl -f /tmp/brdp_manager.dump
docker cp brdp-postgres:/tmp/brdp_manager.dump .\brdp_manager.dump
docker exec brdp-postgres rm /tmp/brdp_manager.dump
Get-FileHash .\brdp_manager.dump -Algorithm SHA256
```

- `-Fc` es el formato propio de PostgreSQL (comprimido, el que lee `pg_restore`).
- `--no-owner --no-acl`: el volcado no lleva quién es el dueño de cada tabla; en el servidor todo será del usuario `brdp`.
- Anota la huella SHA-256 para comprobar la copia en el servidor.

Si el PostgreSQL de origen está instalado en Windows (no en Docker), el equivalente es `pg_dump -h localhost -U brdp -d brdp_manager -Fc --no-owner --no-acl -f brdp_manager.dump` (también con `-f`, nunca con `>`).

### 2.3 Copiar al servidor

A un servidor Linux:

```powershell
scp .\brdp_manager.dump <usuario>@brdp.example.local:/tmp/brdp_manager.dump
```

A un Windows Server: por una carpeta compartida o por `scp` si tiene OpenSSH, a `C:\BRDP\brdp_manager.dump`.

En el servidor, comprueba que la huella coincide: `sha256sum /tmp/brdp_manager.dump` (Linux) o `Get-FileHash C:\BRDP\brdp_manager.dump -Algorithm SHA256` (Windows).

---

## 3. En el servidor: restaurar

Requisitos: el servidor instalado hasta el paso 4.4 de su guía (PostgreSQL con pgvector, la base `brdp_manager` **recién creada y vacía**, con la extensión `vector`, y el backend instalado), **sin** haber ejecutado `alembic upgrade head` ni `create_admin_user.py`. Si ya lo ejecutaste, borra y vuelve a crear la base (paso 2.2 de la guía): restaurar encima de una base con tablas falla con `relation "alembic_version" already exists`.

### 3.1a Restaurar (Linux)

```bash
sudo cp /tmp/brdp_manager.dump /var/lib/postgresql/brdp_manager.dump    # en RHEL: /var/lib/pgsql/
sudo chown postgres: /var/lib/postgresql/brdp_manager.dump
sudo -u postgres bash -c 'pg_restore -l /var/lib/postgresql/brdp_manager.dump | grep -v " EXTENSION " > /var/lib/postgresql/brdp_restore.list'
sudo -u postgres pg_restore -d brdp_manager --no-owner --no-acl --role=brdp --exit-on-error \
     -L /var/lib/postgresql/brdp_restore.list /var/lib/postgresql/brdp_manager.dump
echo $?      # 0 = sin errores
```

- La lista (`-L`) quita del volcado la extensión `vector` (ya la creaste) y su comentario: sin quitarlos, la restauración se para con `must be owner of extension vector`.
- `--role=brdp` hace que todo lo restaurado sea del usuario `brdp`, el que usa la app.
- En RHEL, si `pg_restore` no está en el `PATH`, está en `/usr/pgsql-16/bin/pg_restore`.

### 3.1b Restaurar (Windows Server, PowerShell)

```powershell
$dump = "C:\BRDP\brdp_manager.dump"
pg_restore -l $dump | Where-Object { $_ -notmatch ' EXTENSION ' } | Set-Content -Encoding ascii C:\BRDP\brdp_restore.list
pg_restore -h localhost -U brdp -d brdp_manager --no-owner --no-acl --exit-on-error -L C:\BRDP\brdp_restore.list $dump
$LASTEXITCODE      # 0 = sin errores
```

- La lista se escribe con `Set-Content -Encoding ascii` (con `>` o `Out-File` saldría en UTF-16 y `pg_restore` no la entendería).
- Se restaura conectando como `brdp` (pide su contraseña): así todo es suyo.

### 3.2 Versión del esquema

```bash
cd /opt/brdp/app/backend                      # Windows: cd C:\BRDP\app\backend
sudo -u brdp .venv/bin/alembic current        # Windows: .venv\Scripts\alembic current
```

- Si dice el mismo número que anotaste en el portátil seguido de `(head)`: listo.
- Si dice un número sin `(head)` (el código del servidor es más nuevo): ejecuta `alembic upgrade head` (Linux: `sudo -u brdp .venv/bin/alembic upgrade head`; Windows: `.venv\Scripts\alembic upgrade head`). Las migraciones solo añaden lo que falta.
- Si da un error del tipo `Can't locate revision identified by '00xx'`: el portátil tiene una migración que el código del servidor no conoce. Actualiza el código del servidor (`git pull`) y repite.

### 3.3 Arrancar

Sigue la guía del servidor desde el paso 4.6 (servicio), 5 (frontend) y 6 (proxy), **sin** los pasos 7 (administrador) y 8 (catálogos). Si el servicio ya estaba en marcha, reinícialo (`sudo systemctl restart brdp-backend` / `Restart-Service brdp-backend`).

---

## 4. Comprobar que está todo

1. **Recuentos**: la misma consulta del paso 2.1.3 en el servidor tiene que dar **exactamente los mismos números en todas las tablas**.

   Linux (guarda la consulta en `/tmp/brdp_counts.sql`):
   ```bash
   cat > /tmp/brdp_counts.sql <<'SQL'
   SELECT table_name AS tabla,
          (xpath('/row/n/text()',
                 query_to_xml(format('SELECT count(*) AS n FROM public.%I', table_name), false, true, '')))[1]::text::bigint AS filas
   FROM information_schema.tables
   WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
   ORDER BY table_name;
   SQL
   sudo -u postgres psql -d brdp_manager -f /tmp/brdp_counts.sql
   ```
   Windows: el mismo `$q` del paso 2.1.3 y `psql -U brdp -h localhost -d brdp_manager -c $q`.

   Si `alembic upgrade head` aplicó migraciones nuevas en el servidor, `alembic_version` sigue con 1 fila, pero alguna migración puede haber añadido o cambiado filas (lo dice su salida). El resto de tablas tienen que coincidir.

   Comprobación rápida de los embeddings:
   ```sql
   SELECT (SELECT count(*) FROM brdps WHERE embedding IS NOT NULL) AS brdps_con_embedding,
          (SELECT count(*) FROM brdp_catalog WHERE embedding IS NOT NULL) AS catalogo_con_embedding;
   ```
2. **`/health`**: `curl -s https://brdp.example.local/health` (Windows: `Invoke-RestMethod`) con `"up_to_date": true`.
3. **En la app**, desde otro equipo por `https://`:
   - entra con tu usuario de siempre y recarga la página: sigues dentro;
   - abre un proyecto: mismas BRDP, mismas reglas *Verified*, mismos indicadores de prueba;
   - **Generar** del proyecto: sale el documento, igual al del portátil;
   - una pregunta en «Preguntar» y un «Sugerir Definición»: Mistral responde desde el servidor y no aparece el aviso de embeddings pendientes.
4. Opcional: borra las sesiones antiguas, que en el servidor no sirven de nada (el navegador nunca las enviará a la dirección nueva):
   ```sql
   DELETE FROM refresh_tokens;
   ```
5. Borra el fichero del volcado y la lista de los dos sitios.

---

## 5. Embeddings

Viajan con la base y siguen valiendo **si el servidor usa el mismo modelo de embeddings** (`MISTRAL_EMBED_MODEL=mistral-embed`, el de siempre). Si cambias de modelo, los guardados ya no son comparables con los nuevos: vacíalos y vuelve a calcularlos.

```sql
UPDATE brdps SET embedding = NULL, embedding_text_hash = NULL;
UPDATE brdp_catalog SET embedding = NULL, embedding_text_hash = NULL;
```

Después, en cada proyecto, «Compute embeddings» (las BRDP *Validated* y el catálogo de su standard).

---

## 6. Versiones distintas de PostgreSQL o de pgvector

| Caso | Qué hacer |
|---|---|
| PostgreSQL del servidor **igual** que el de origen | Lo normal: como arriba |
| PostgreSQL del servidor **mayor** (p. ej. origen 16, servidor 17) | Funciona tal cual: `pg_restore` lee volcados de versiones anteriores. Usa el `pg_restore` del servidor (el de su versión) y, después, ejecuta en la base restaurada `ANALYZE;` para que PostgreSQL recalcule sus estadísticas |
| PostgreSQL del servidor **menor** (p. ej. origen 16, servidor 15) | **No soportado.** Un `pg_restore` más viejo no lee el volcado (`unsupported version … in file header`) y PostgreSQL no garantiza que un volcado cargue en una versión anterior. Instala en el servidor la misma versión o una mayor (repositorio PGDG en Linux, instalador de EDB en Windows) |
| pgvector distinto | La app solo usa el tipo `vector(1024)` (sin índices de vectores), que es igual en todas las versiones desde la 0.5. Funciona. Después de restaurar, si el servidor tiene una versión más nueva que la creada en la base: `ALTER EXTENSION vector UPDATE;` (como `postgres`) |
| pgvector ausente en el servidor | La restauración falla en la primera tabla con una columna `vector`: instala pgvector (paso 2.1 de la guía) y crea la extensión antes de restaurar |

Versiones conocidas: el contenedor de desarrollo usa la imagen `pgvector/pgvector` (PostgreSQL 16); compruébalo con el paso 2.1.2.

---

## 7. Si algo sale mal

| Síntoma | Causa y arreglo |
|---|---|
| `pg_restore: error: input file does not appear to be a valid archive` | El volcado se hizo con `>` en PowerShell o se copió mal. Repite el paso 2.2 con `docker cp` y compara la huella |
| `must be owner of extension vector` | Falta la lista `-L` que quita la extensión (paso 3.1a o 3.1b) |
| `relation "…" already exists` | La base no estaba vacía (se ejecutó `alembic upgrade head` o una restauración anterior): bórrala, créala otra vez (paso 2.2 de la guía) y repite |
| `extension "vector" is not available` / `type "vector" does not exist` | Falta pgvector o la extensión en la base nueva (paso 2 de la guía) |
| `permission denied for table …` al usar la app | Se restauró sin `--role=brdp` (Linux) o como `postgres` (Windows): repite la restauración sobre una base vacía |
| Los recuentos no coinciden | Se volcó con el backend del portátil en marcha, o se restauró con errores. Repite desde el paso 2 |
| Nadie puede entrar | Normal la primera vez si se esperaba la sesión anterior: hay que iniciar sesión otra vez. Si el login falla con la contraseña correcta, mira el log del backend |
