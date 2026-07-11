# BRDP Manager

A comprehensive Business Rules Decision Points (BRDP) management system for S1000D and DITA technical documentation projects. Manage BRDP records, validate technical decisions, generate BREX Data Modules and Schematron files, extract BRDPs from documents using AI, and interact with an AI assistant for expert guidance.

## Features

- **BRDP Records Management** — Import, search, filter, sort, and export BRDP records
- **BREX Generation** — Generate BREX Data Modules for S1000D 4.2 and 3.0.1, with guaranteed BRDP coverage and deterministic finalization
- **Schematron Generation** — Generate Schematron 1.0 validation schemas (produced deterministically from a BREX 3.0.1 base)
- **AI Extract** — Extract BRDPs from a document (`.docx` / `.pdf`) or from pasted plain text, with automatic deduplication and a preview before import
- **AI Assistant** — Expert guidance on S1000D, DITA, and technical documentation
- **Multi-Provider LLM Support** — Anthropic Claude, OpenAI, Mistral, or custom endpoints
- **Project Configuration** — Manage S1000D project metadata and identifiers
- **Excel Import/Export** — Bulk import and export BRDP records
- **Notes System** — Attach persistent notes to BRDP records
- **Local Data Persistence** — All data saved in a SQLite database on disk

## Requirements

- **Node.js** 20 or higher
- **npm** 9 or higher

> **Note on Node.js 24+ and `better-sqlite3`:** `better-sqlite3` is a native module. On very recent Node versions it may not have a prebuilt binary and will try to compile from source, which requires C++ build tools (Visual Studio "Desktop development with C++" on Windows). If you hit a build error on install, use a recent `better-sqlite3` that ships a prebuilt binary for your Node version (`npm install better-sqlite3@latest`), or use a Node LTS release (20 or 22), which has prebuilt binaries available.

## Installation

```bash
git clone <repo-url>
cd brdp-manager
npm install
```

If `npm install` fails while building `better-sqlite3` (native module), see the note above. A common workaround is:

```bash
npm install --ignore-scripts        # install everything without native rebuilds
npm install better-sqlite3@latest   # pull a version with a prebuilt binary
```

## Quick Start (Production)

```bash
npm run build
npm start
```

Open http://localhost:3000 in your browser.

To use a different port:

```bash
PORT=8080 npm start
```

## Development

```bash
npm run dev
```

Open http://localhost:5173 in your browser.

In development mode, the Vite dev server handles proxying. In production, Express handles everything.

## Troubleshooting: Corporate Network / SSL-Inspecting Proxy

If you're on a corporate network with SSL inspection (e.g. Zscaler), you may hit certificate errors in two different, unrelated places. Both share the same root cause (npm and Node don't trust your organization's proxy root CA), but each needs its own fix.

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

### 2. The app itself (`npm start`) fails with the same certificate error

Affects: running `server.js` at runtime (calls to external LLM APIs like Mistral).

**Cause:** the same corporate SSL-inspecting proxy — but a distinct problem, because Node.js at runtime doesn't use npm's configuration or Windows' certificate store by default.

**Fix:** already built into the code (`win-ca`, auto-enabled only on Windows, no-op on Linux/Mac) — no manual action needed. Unlike problem #1 above, this one is already solved for you.

## Configuration

### AI Configuration

1. Go to **Settings → AI Configuration**
2. Select your provider (Anthropic, OpenAI, Mistral, or Custom)
3. Enter your API key and model name
4. Optionally enter a custom endpoint
5. Click **Save** then **Test Connection** to verify

### Project Configuration

1. Go to **Settings → Project Configuration**
2. Enter your S1000D project details:
   - Project Name
   - Model Ident Code (CAGE code)
   - System Diff Code (default: A)
   - Issue Number (default: 001)
   - Language and Country ISO codes
   - Security Classification
   - Enterprise Code
3. Click **Save Configuration**

## Usage

### Managing BRDPs

- **Import:** Settings → Data Management → Choose Excel file
- **Search:** Use the search bar to find specific BRDPs
- **Filter:** Filter by validation status (All, Validated, Refused, Pending)
- **View/Edit:** Click a row to see full details, edit fields, and add notes
- **Export:** Export to Excel or CSV format

### Generating BREX / Schematron

1. Click **Generate BREX / Schematron** in the header
2. Select the output format:
   - **BREX — S1000D 4.2**
   - **BREX — S1000D 3.0.1**
   - **Schematron 1.0**
3. Click **Generate** — the LLM produces the output using your validated BRDPs as input
4. Download the resulting file

All three generators guarantee that every validated BRDP is represented in the output (as an executable rule, or — as a last resort — as a traceability entry), so no rule is ever silently dropped.

### Extracting BRDPs with AI

1. Click **AI Extract** in the header
2. Choose the input mode:
   - **Upload file** — drop or browse a `.docx` or `.pdf`
   - **Paste text** — paste plain text directly (e.g. a style guide excerpt or BREX text)
3. Click **Extract BRDPs**
4. Review the preview table — possible duplicates against existing records are flagged
5. Choose to add to or replace existing BRDPs, deselect any you don't want, and import

If the source contains explicit rule identifiers (e.g. `BRDP-S1-00123`, `BR002`), they are referenced in the extracted BRDP's source/comment field. New records always receive automatically assigned IDs.

### Using the AI Assistant

1. Click **BRDP Assistant** in the header
2. Ask questions about your BRDPs, S1000D rules, or DITA

## Data

All data is stored in a SQLite database at `data/brdp.db`. This file is created automatically on first run.

- **Backup:** Copy `data/brdp.db` to keep a backup of all your BRDPs and configuration.
- **Reset:** Use Settings → Reset data → Reset to demo data to restore the original demo dataset.

## Docker

```bash
docker-compose up --build
```

Open http://localhost:8080 in your browser.

> **Note:** The Docker setup uses nginx and does not include the Express server or SQLite persistence. It is suitable for demo/preview purposes only.

## Project Structure

```
brdp-manager/
├── src/
│   ├── api/                   # LLM generators + document extraction
│   │   ├── generateBREX.js        # BREX S1000D 4.2 + shared helpers
│   │   ├── generateBREX301.js     # BREX S1000D 3.0.1
│   │   ├── generateBREXSch.js     # Schematron 1.0 (via BREX 3.0.1 + converter)
│   │   ├── brexToSchematron.js    # Deterministic BREX → Schematron converter
│   │   ├── buildBREXdocReport.js  # BREXdoc report builder
│   │   ├── extractBRDPs.js        # AI Extract (DOCX/PDF/plain text → BRDPs)
│   │   └── llmAPI.js              # Provider-agnostic LLM client
│   ├── components/            # React components
│   ├── context/               # BRDPContext (global state)
│   ├── db/                    # SQLite schema and database connection
│   ├── hooks/                 # Custom React hooks
│   ├── pages/                 # Page components
│   ├── services/              # API service layer (REST calls to Express)
│   └── utils/                 # Helpers (Excel utils, etc.)
├── public/                    # Static assets and schema JSON files
├── data/                      # SQLite database (auto-created, not in git)
├── server.js                  # Express server (production)
└── dist/                      # Vite build output (not in git)
```

## Key Dependencies

- **react / react-dom** — UI
- **express** — production server, REST API, LLM proxy
- **better-sqlite3** — local SQLite persistence
- **mammoth** — DOCX text extraction (AI Extract)
- **pdfjs-dist** — PDF text extraction (AI Extract)
- **xlsx** — Excel import/export

## License

Proprietary — All rights reserved
