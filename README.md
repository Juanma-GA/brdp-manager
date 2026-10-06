# BRDP Manager

Business Rules Decision Points (BRDP) management for S1000D and DITA technical documentation projects: a React (Vite) frontend and a FastAPI + Postgres backend, multi-project, with users and per-project roles.

## Features

- **Projects and BRDP Records** — per-project BRDPs with search, filters, history, trash and Excel import/export
- **Rules** — one rule per BRDP (BREX S1000D 4.2 / 4.1 / 3.0.1 or Schematron for DITA 1.3) with To Do / Draft / Verified status and a rule test with examples
- **Generate** — BREX Data Module or Schematron for the project, assembled from its approved rules (no AI involved)
- **Assistant** — Ask, Suggest Definition / Proposal / Rule, side-by-side comparison of two BRDPs
- **AI Extract** — create BRDPs from an existing BREX or Schematron file, or from pasted text / a `.txt`, `.md`, `.docx` or `.pdf` document, with a review table before import
- **Server-side LLM access** — the LLM provider, endpoint and key live only in the backend configuration (`/api/llm-proxy`)

## Requirements

- **Node.js** 20 or higher, **npm** 9 or higher (frontend)
- **Python** 3.11 or higher and **PostgreSQL** with the `pgvector` extension (backend)

## Installation

The dependencies are pinned in lockfiles: `package-lock.json` for the frontend and `backend/requirements*.lock.txt` for the backend. Install from them, so everyone gets exactly the same versions.

Linux / macOS:

```bash
git clone <repo-url>
cd brdp-manager
npm ci

cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install --require-hashes -r requirements-dev.lock.txt
cp .env.example .env             # then fill in the database URL, keys and LLM provider
alembic upgrade head
python scripts/create_admin_user.py
```

Windows (PowerShell):

```powershell
git clone <repo-url>
cd brdp-manager
npm ci

cd backend
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install --require-hashes -r requirements-dev.lock.txt
Copy-Item .env.example .env      # then fill in the database URL, keys and LLM provider
alembic upgrade head
python scripts/create_admin_user.py
```

`requirements-dev.lock.txt` is for development and tests (pytest, `pip-system-certs`); a server installs `requirements.lock.txt` instead (no dev tools). Both are valid on Windows and Linux: platform-only packages carry a marker (`colorama` only on Windows, `uvloop` never on Windows) and every package has its hashes for all platforms. The app is not installed as a package: the backend runs from `backend/` (`uvicorn app.main:app`, `alembic`, `pytest` all start there).

### Updating the backend lockfiles

`backend/pyproject.toml` keeps the version ranges; the lockfiles are generated from it with [uv](https://docs.astral.sh/uv/) (`pip install uv`), from `backend/`:

```bash
uv pip compile pyproject.toml --universal --python-version 3.11 --generate-hashes -o requirements.lock.txt
uv pip compile pyproject.toml --extra dev --universal --python-version 3.11 --generate-hashes -o requirements-dev.lock.txt
```

These commands keep the versions already in the lockfiles (uv reuses them); they only add or remove what changed in `pyproject.toml`. To move one package to a newer version add `--upgrade-package <name>` to both; `--upgrade` moves everything. Commit `pyproject.toml` and both lockfiles together.

## Development

Two processes, in two terminals:

```bash
# Terminal 1 -- the FastAPI backend (port 8000)
cd backend && source .venv/bin/activate
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

```bash
# Terminal 2 -- the Vite dev server (hot-reloading React frontend, port 5173)
npm run dev
```

Open http://localhost:5173 in your browser. Vite proxies `/api/*` to the backend on port 8000 -- it only forwards the requests, it does not start the backend for you.

## Production build

```bash
npm run build
```

The static frontend in `dist/` is served by nginx (`nginx.conf`, `Dockerfile`); the API is the FastAPI backend.

## Comprobaciones

Un solo comando comprueba todo lo que no necesita navegador. Es igual en PowerShell y en Linux (son scripts de Node, sin sintaxis de shell); se ejecuta desde la raíz del repo:

```bash
npm run check:all
```

- `npm run check` -- lint, build, tests JS (`scripts/test-*.mjs`), snapshot de prompts y lint de las plantillas, parando en el primer fallo.
- `npm run check:all` -- lo mismo más los tests del backend (pytest). Necesita Postgres arrancado (Linux: `service postgresql start`; Windows con Docker: `docker start brdp-postgres`) y la base migrada (`alembic upgrade head`).
- Por partes: `npm run lint`, `npm run build`, `npm run test:js`, `npm run check:prompts`, `npm run lint:templates`, `npm run test:backend`. Con `--` se pasan opciones: `npm run test:js -- rule-test` (solo esos ficheros), `npm run test:backend -- -k similar -x` (opciones de pytest).

Cada comando termina con un resumen (qué pasó, qué falló, cuánto tardó) y, si todo pasa, con la línea `TODO OK`. Código de salida: 0 todo bien, 1 algo falla, 2 falta algo del entorno (el Python del backend o la base de datos), que no es un fallo de la app.

El Python del backend se busca en `backend/.venv` (`Scripts\python.exe` en Windows, `bin/python` en Linux); otro se indica con la variable `BACKEND_PYTHON` (PowerShell: `$env:BACKEND_PYTHON = "C:\ruta\python.exe"`; Linux: `export BACKEND_PYTHON=/ruta/python`). La base de datos de los tests es la de `DATABASE_URL` (`backend/.env`).

## Troubleshooting: Corporate Network / SSL-Inspecting Proxy

If you're on a corporate network with SSL inspection (e.g. Zscaler), you may hit certificate errors in two different places. Both share the same root cause (npm and Python each maintain their own trust store and neither trusts your organization's proxy root CA by default), but each needs its own fix.

### 1. `npm ci` / `npm install` fails with `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`

Affects: any `npm ci` or `npm install` — the initial one, or adding any new dependency later. This is an npm tooling issue, not something wrong with this app's code.

**Cause:** your corporate SSL-inspecting proxy (confirmed with Zscaler in our case) re-signs HTTPS traffic with its own root certificate, which npm doesn't recognize.

**Recommended fix (permanent, safer):**
```bash
npm config set cafile "C:\path\to\corporate-root-cert.pem"
```
Ask your IT department for your organization's root CA `.pem` file, or export it yourself from Windows: `certmgr.msc` → *Trusted Root Certification Authorities*.

**Quick fix (only if you don't have the certificate on hand, temporary):**
```bash
npm config set strict-ssl false
npm ci
npm config set strict-ssl true
```
⚠️ This disables npm's SSL verification while active. Re-enable `strict-ssl` immediately after the install completes — don't leave it disabled.

### 2. The backend (`uvicorn`) fails with `SSLCertVerificationError` calling Mistral/Qwen

Affects: `POST /api/llm-proxy` (Ask, Suggest Definition, and any other AI feature) — confirmed live with a real traceback (see backend log) after adding explicit logging around the upstream call; without that logging this used to surface only as a bare 500 with nothing in the console.

**Cause:** the same corporate SSL-inspecting proxy as problem #1 above — but a distinct problem, because Python doesn't use npm's config or Windows' certificate store either. `httpx` (the backend's HTTP client) needs its own trust anchor.

**Recommended fix for local development:**
```bash
pip install --require-hashes -r requirements-dev.lock.txt
uvicorn app.main:app --reload
```
That's it — no certificate path to find, no environment variable to set. `pip-system-certs` is in the `[dev]` extras (and so in `requirements-dev.lock.txt`) specifically for this: it patches Python's `ssl` module (via a `.pth` file that runs automatically every time the interpreter starts, in this venv, no import needed anywhere in the app's own code) to validate against the OS's certificate store instead of only `certifi`'s bundled list. Your corporate root CA is normally already in the OS store (that's what makes your browser and other apps work on this network), so this "just works" without you having to locate the `.pem` file yourself.

⚠️ **Dev-only, not a production fix.** `pip-system-certs` is deliberately in `[dev]`, never in the production dependency list. A real deployment installs the corporate root CA into the server OS's trust store directly (the normal, correct way to do this for a server) — nothing in this app's own code or dependencies should be relying on this shortcut in production.

**Manual alternative** (if you'd rather not add the dev dependency, or need this outside the `[dev]` extras): point Python at your organization's root CA `.pem` before starting `uvicorn`:
```bash
set SSL_CERT_FILE=C:\path\to\corporate-root-cert.pem
set REQUESTS_CA_BUNDLE=C:\path\to\corporate-root-cert.pem
uvicorn app.main:app --reload
```
(`export` instead of `set` on Linux/Mac.) Same `.pem` file as problem #1 — ask IT or export it from `certmgr.msc` → *Trusted Root Certification Authorities* if you don't have it yet. Both variables point to the same file; between them they cover `httpx` and the other Python HTTP libraries in the dependency chain, so set both rather than guessing which one your setup needs.

## Usage

- **Projects:** create a project and pick its standard; its configuration (Model Ident Code, schema location, etc.) is in **Project Configuration**.
- **BRDP Records:** search, filter by Proposal or Rule status, click a row to edit it, write or suggest its rule, test it and verify it.
- **Data management (Project Configuration):** import or export Excel, download the template, and AI Extract.
- **Generate:** pick the output (BREX or Schematron) and download it.

## Data

All data lives in the PostgreSQL database configured in `backend/.env`; the schema is managed with Alembic (`backend/alembic/versions/`). Back it up with the usual PostgreSQL tools.

## Docker

```bash
docker-compose up --build
```

Open http://localhost:8080 in your browser.

> **Note:** The Docker setup serves the built frontend with nginx only; it does not include the FastAPI backend or PostgreSQL yet.

## Project Structure

```
brdp-manager/
├── src/
│   ├── api/                   # Generators (BREX, Schematron), report, LLM client
│   ├── components/            # React components
│   ├── hooks/                 # React hooks
│   ├── layouts/, pages/       # Routes and pages
│   ├── prompts/               # LLM prompts (pure functions)
│   ├── services/apiClient.js  # Authenticated fetch to the backend
│   ├── utils/, validation/    # Rule test engine, schema checks, helpers
│   └── i18n/                  # English and Spanish texts
├── backend/                   # FastAPI app, Alembic migrations, tests, scripts
├── public/                    # Static assets, schema vocabularies, Excel templates
├── scripts/                   # Verification and test scripts (Node, Playwright)
└── dist/                      # Vite build output (not in git)
```

## Key Dependencies

- **react / react-dom**, **react-router-dom**, **@tanstack/react-query**, **react-i18next** — UI
- **fontoxpath**, **xmllint-wasm** — XPath evaluation and XSD validation in the browser
- **mammoth**, **pdfjs-dist** — DOCX and PDF text extraction (AI Extract)
- Backend: **FastAPI**, **SQLAlchemy** (async), **Alembic**, **pgvector**, **lxml**, **openpyxl** (Excel)

## License

Proprietary — All rights reserved
