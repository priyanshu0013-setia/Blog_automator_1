# 🚀 Blog Automator

<p align="center">
  <strong>AI-assisted blog production pipeline with real-time tracking, quality gates, and optional Google Docs publishing.</strong>
</p>

<p align="center">
  <img alt="Monorepo" src="https://img.shields.io/badge/Monorepo-pnpm-ffb300?logo=pnpm&logoColor=white" />
  <img alt="Runtime" src="https://img.shields.io/badge/Node-22%2B-339933?logo=node.js&logoColor=white" />
  <img alt="Backend" src="https://img.shields.io/badge/Backend-Express%205-000000?logo=express&logoColor=white" />
  <img alt="Frontend" src="https://img.shields.io/badge/Frontend-React%20%2B%20Vite-646CFF?logo=vite&logoColor=white" />
  <img alt="Database" src="https://img.shields.io/badge/Database-PostgreSQL-4169E1?logo=postgresql&logoColor=white" />
  <img alt="ORM" src="https://img.shields.io/badge/ORM-Drizzle-C5F74F" />
</p>

---

## ✨ What this project does

Blog Automator runs an end-to-end blog generation workflow:

- Create a single article or batch (up to 3 concurrent)
- Generate research, article drafts, and humanized rewrites
- Enforce quality checks (keyword density, em-dashes, FAQs, optional Copyleaks)
- Generate SEO metadata
- Optionally publish final content to Google Docs
- Track everything from dashboard + pipeline logs in real time

---

## 🧭 Quick navigation

- [Architecture graph](#-architecture-graph)
- [Pipeline state graph](#-pipeline-state-graph)
- [Request sequence graph](#-request-sequence-graph)
- [Monorepo structure](#-monorepo-structure)
- [How it really works (full logic)](#-how-it-really-works-full-logic)
- [Data model](#-data-model)
- [Environment variables](#-environment-variables)
- [Local development](#-local-development)
- [API endpoints](#-api-endpoints)
- [Build & deployment](#-build--deployment)
- [Troubleshooting](#-troubleshooting)

---

## 🏗️ Architecture graph

```mermaid
flowchart LR
    U[User in Web UI] --> FE[React + Vite Frontend]
    FE -->|REST /api| API[Express API Server]
    API --> DB[(PostgreSQL)]
    API --> PIPE[Pipeline Orchestrator]
    PIPE --> CLAUDE[Anthropic Claude]
    PIPE --> COPY[Copyleaks Optional]
    PIPE --> GDOCS[Google Docs Optional]
    PIPE --> DB
    DB --> FE
```

---

## 🔄 Pipeline state graph

```mermaid
stateDiagram-v2
    [*] --> queued
    queued --> researching
    researching --> writing
    writing --> humanizing
    humanizing --> checking
    checking --> formatting
    checking --> retrying
    retrying --> checking
    retrying --> flagged
    formatting --> completed
    queued --> failed
    researching --> failed
    writing --> failed
    humanizing --> failed
    checking --> failed
    formatting --> failed
```

---

## 🧵 Request sequence graph

```mermaid
sequenceDiagram
    participant User
    participant UI as Frontend
    participant API as API Server
    participant DB as PostgreSQL
    participant AI as Claude
    participant CL as Copyleaks
    participant GD as Google Docs

    User->>UI: Submit article input
    UI->>API: POST /api/articles
    API->>DB: Insert article (queued)
    API-->>UI: 201 Created

    API->>AI: Research prompt
    AI-->>API: Research brief
    API->>AI: Writing prompt
    AI-->>API: Draft article
    API->>AI: Humanization + fixes
    AI-->>API: Finalized article content

    opt Copyleaks configured
      API->>CL: Submit AI detection scan
      CL-->>API: AI score
    end

    API->>AI: SEO metadata prompt
    AI-->>API: title/meta/slug/tags

    opt Google Docs configured
      API->>GD: Create + format document
      GD-->>API: document URL
    end

    API->>DB: Save output + metrics + logs
    UI->>API: GET /api/stats/active and /api/articles/:id/logs (polling)
    API-->>UI: Live statuses and step logs
```

---

## 📦 Monorepo structure

```text
/home/runner/work/Blog_Automator/Blog_Automator
├─ artifacts/
│  ├─ api-server/          # Express API + pipeline orchestrator
│  ├─ blog-automation/     # React frontend (Vite)
│  └─ mockup-sandbox/      # UI sandbox artifact
├─ lib/
│  ├─ db/                  # Drizzle schema + DB connection
│  ├─ api-spec/            # OpenAPI contract + Orval config
│  ├─ api-zod/             # Generated Zod validators/types
│  └─ api-client-react/    # Generated React Query client
├─ scripts/
├─ render.yaml
└─ pnpm-workspace.yaml
```

### Tech stack

- **Runtime:** Node.js 22+
- **Package manager:** pnpm
- **Language:** TypeScript
- **Backend:** Express 5 + Drizzle ORM + PostgreSQL
- **Frontend:** React + Vite + TanStack Query + Wouter
- **Validation/codegen:** OpenAPI + Orval + Zod
- **AI provider:** Anthropic (Claude)
- **Optional integrations:** Copyleaks + Google Docs/Drive API

---

## 🧠 How it really works (full logic)

### 1) Article creation and queueing

Frontend (`/new`) sends:
- `POST /api/articles` (single)
- `POST /api/articles/batch` (batch)

Server (`artifacts/api-server/src/routes/articles.ts`):
- validates payload with generated Zod schemas
- enforces **maximum 3 active pipeline articles**
- inserts rows with `queued` status
- starts async execution via `setImmediate(() => runPipeline(articleId))`

### 2) Pipeline statuses and terminal outcomes

Main progression:

`queued → researching → writing → humanizing → checking → retrying → formatting → completed`

Terminal outcomes:
- `failed` = hard failure
- `flagged` = still above Copyleaks threshold after max retries

Each step writes a row to `pipeline_logs`, which powers real-time UI logs.

### 3) Pipeline execution (`runPipeline` in `pipeline.ts`)

#### A. Startup checks
- fetch article from DB
- require `ANTHROPIC_API_KEY`
- fail fast if missing

#### B. Research generation
- Claude produces a research brief with:
  - 5–7 section outline
  - audience pain points
  - content gaps
  - facts/stats
  - FAQ ideas
  - differentiating angle

#### C. Article drafting
- Claude writes the main article with enforced constraints:
  - heading structure (H1/H2/H3)
  - keyword targeting
  - formatting variety
  - FAQ section format and uniqueness
  - anti-pattern bans (including em-dashes)

#### D. Humanization pass
- Claude rewrites to reduce detectable AI patterns while preserving structure.

#### E. Subheading safety pass
- detects negative-framing headings
- rewrites only flagged H2/H3 headings to neutral SEO-safe forms

#### F. Section-structure de-duplication
- detects repetitive adjacent H2 section patterns
- restructures repeated sections while preserving meaning/data

#### G. Quality checks
- word count
- primary/secondary keyword density
- em-dash count
- FAQ count

#### H. Copyleaks check (optional)
If configured:
- submit content to Copyleaks
- if score > 10%, rewrite and retry up to 3 times
- if still >10% after retries → mark `flagged`

If not configured, step is skipped.

#### I. SEO metadata generation
- generates title, meta description, slug, tags
- falls back to defaults on parsing failure

#### J. Google Docs publishing (optional)
If configured:
- create Google Doc
- convert markdown-like content to structured docs operations
- insert headings, bullets, and tables
- optionally move to target Drive folder
- store resulting URL + document name

#### K. Completion
- persist final content, metrics, SEO fields, retry count, timestamps
- mark article `completed`

### 4) Real-time UI behavior

- **Dashboard:** polls summary stats + active pipeline cards
- **Pipeline Status:** auto-refreshes every 3s, expandable logs
- **History:** full article table, filtering, retry, delete
- **Article Detail:** content, SEO, logs, and quality scorecards

### 5) API-contract-first flow

Source of truth:
- `lib/api-spec/openapi.yaml`

Codegen:
- `pnpm --filter @workspace/api-spec run codegen`
- outputs:
  - `lib/api-client-react` (React Query hooks)
  - `lib/api-zod` (runtime schemas/types)

This keeps backend validation and frontend consumption in sync.

---

## 📊 Quality gate summary

| Metric | Target | Used for pass/fail |
|---|---:|---|
| Copyleaks AI Score | `< 10%` | Retry or flag if too high |
| Primary keyword density | `1.3% – 1.7%` | SEO quality check |
| Em-dash count | `0` | strict style rule |
| FAQ count | `5 – 8` | content completeness |

---

## 🗃️ Data model

### `articles`
Stored fields include:
- input metadata (topic, keywords, audience, target words)
- pipeline status + retries + error info
- generated content
- quality metrics
- SEO metadata
- optional Google Docs fields
- created/completed timestamps

Schema:
- `lib/db/src/schema/articles.ts`

### `pipeline_logs`
Stored fields include:
- `articleId`
- `stepName`
- `status` (`running` / `completed` / `failed`)
- details
- timestamp

Schema:
- `lib/db/src/schema/pipeline-logs.ts`

---

## 🔐 Environment variables

### Required
- `DATABASE_URL` — PostgreSQL connection string
- `PORT` — server port (in Render, injected automatically)
- `ANTHROPIC_API_KEY` — required for pipeline generation

### Optional
- `COPYLEAKS_EMAIL`
- `COPYLEAKS_API_KEY`
- `GOOGLE_SERVICE_ACCOUNT_JSON` (full service account JSON as string)
- `GOOGLE_DRIVE_FOLDER_ID`
- `STATIC_FILES_PATH` (override frontend static path)
- `BASE_PATH` (frontend base path, default `/`)
- `HOST`, `LOG_LEVEL`, `NODE_ENV`

---

## 🛠️ Local development

### 1) Prerequisites
- Node.js 22+
- pnpm
- PostgreSQL

### 2) Install

```bash
cd /home/runner/work/Blog_Automator/Blog_Automator
pnpm install
```

### 3) Configure environment
Set at least:
- `DATABASE_URL`
- `PORT`
- `ANTHROPIC_API_KEY`

### 4) Prepare DB schema

```bash
pnpm --filter @workspace/db run push
```

### 5) Run services

API:
```bash
pnpm --filter @workspace/api-server run dev
```

Frontend:
```bash
pnpm --filter @workspace/blog-automation run dev
```

### 6) Useful commands

```bash
pnpm run typecheck
pnpm run build
pnpm --filter @workspace/api-spec run codegen
```

---

## 🌐 API endpoints

Health:
- `GET /api/healthz`

Articles:
- `GET /api/articles`
- `POST /api/articles`
- `POST /api/articles/batch`
- `GET /api/articles/:id`
- `DELETE /api/articles/:id`
- `POST /api/articles/:id/retry`
- `GET /api/articles/:id/logs`

Stats:
- `GET /api/stats/dashboard`
- `GET /api/stats/active`

Full contract:
- `lib/api-spec/openapi.yaml`

---

## 🚢 Build & deployment

Render blueprint:
- `render.yaml`

Default Render commands:
- Build: `pnpm install && pnpm --filter @workspace/db run push && pnpm -r --if-present run build`
- Start: `node --enable-source-maps ./artifacts/api-server/dist/index.mjs`

Deployment notes:
- Render injects `PORT`; do not hardcode it there
- ensure `DATABASE_URL` is linked
- schema push is run automatically during the build command

---

## 🧯 Troubleshooting

### Pipeline fails immediately
Check:
- `ANTHROPIC_API_KEY`
- `DATABASE_URL`

### Article status becomes `flagged`
Copyleaks score remained above threshold after max retries; manual review is expected.

### Google Doc is not created
Check:
- valid `GOOGLE_SERVICE_ACCOUNT_JSON`
- Google Docs + Drive APIs enabled
- Drive folder shared with service-account email

### Frontend not served by API process
Ensure build output exists at:
- `artifacts/blog-automation/dist/public`

or set `STATIC_FILES_PATH`.

---

## 🔎 Core file map

- Pipeline orchestrator: `artifacts/api-server/src/lib/pipeline.ts`
- Google Docs integration: `artifacts/api-server/src/lib/google-docs.ts`
- Article routes + stats: `artifacts/api-server/src/routes/articles.ts`
- App/server wiring: `artifacts/api-server/src/app.ts`
- DB schema: `lib/db/src/schema/*.ts`
- API contract: `lib/api-spec/openapi.yaml`
- Frontend screens: `artifacts/blog-automation/src/pages/*.tsx`

---

## 🔒 Security/ops notes

- Pino logger redacts auth/cookie headers
- Rate limits:
  - `/api/*` → 60 req/min
  - `/api/articles*` → 5 generation req/min
- Workspace includes supply-chain hardening (`minimumReleaseAge` in `pnpm-workspace.yaml`)
