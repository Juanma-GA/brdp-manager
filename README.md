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

```bash
git clone <repo-url>
cd brdp-manager
npm install

cd backend
python -m venv .venv
source .venv/bin/activate        # .venv\Scripts\activate on Windows
pip install -e ".[dev]"
cp .env.example .env             # then fill in the database URL, keys and LLM provider
alembic upgrade head
python scripts/create_admin_user.py
```

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

## Troubleshooting: Corporate Network / SSL-Inspecting Proxy

If you're on a corporate network with SSL inspection (e.g. Zscaler), you may hit certificate errors in two different places. Both share the same root cause (npm and Python each maintain their own trust store and neither trusts your organization's proxy root CA by default), but each needs its own fix.

### 1. `npm install` fails with `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`

Affects: any `npm install` — the initial one, or adding any new dependency later. This is an npm tooling issue, not something wrong with this app's code.

**Cause:** your corporate SSL-inspecting proxy (confirmed with Zscaler in our case) re-signs HTTPS traffic with its own root certificate, which npm doesn't recognize.

**Recommended fix (permanent, safer):**
```bash
npm config set cafile "C:\path\to\corporate-root-cert.pem"
```
Ask your IT department for your organization's root CA `.pem` file, or export it yourself from Windows: `certmgr.msc` → *Trusted Root Certification Authorities*.

**Quick fix (only if you don't have the certificate on hand, temporary):**
```bash
npm config set strict-ssl false
npm install
npm config set strict-ssl true
```
⚠️ This disables npm's SSL verification while active. Re-enable `strict-ssl` immediately after the install completes — don't leave it disabled.

### 2. The backend (`uvicorn`) fails with `SSLCertVerificationError` calling Mistral/Qwen

Affects: `POST /api/llm-proxy` (Ask, Suggest Definition, and any other AI feature) — confirmed live with a real traceback (see backend log) after adding explicit logging around the upstream call; without that logging this used to surface only as a bare 500 with nothing in the console.

**Cause:** the same corporate SSL-inspecting proxy as problem #1 above — but a distinct problem, because Python doesn't use npm's config or Windows' certificate store either. `httpx` (the backend's HTTP client) needs its own trust anchor.

**Recommended fix for local development:**
```bash
pip install -e ".[dev]"
uvicorn app.main:app --reload
```
That's it — no certificate path to find, no environment variable to set. `pip-system-certs` is in the `[dev]` extras specifically for this: it patches Python's `ssl` module (via a `.pth` file that runs automatically every time the interpreter starts, in this venv, no import needed anywhere in the app's own code) to validate against the OS's certificate store instead of only `certifi`'s bundled list. Your corporate root CA is normally already in the OS store (that's what makes your browser and other apps work on this network), so this "just works" without you having to locate the `.pem` file yourself.

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
