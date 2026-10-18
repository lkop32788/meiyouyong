# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

OmniClick is a multi-tenant omnichannel customer-messaging platform: WhatsApp (Cloud API and personal accounts via Baileys QR), Telegram, LINE, Email, Facebook Messenger, Twilio SMS, and AI-driven WhatsApp voice calls. Four deployable units: a Laravel 13 backend (API + queue workers), an Express webhook gateway, a Socket.io realtime server, and a React frontend.

## Infrastructure Prerequisites

- PHP 8.3+ with Composer; Node 20+ with npm
- MySQL/MariaDB — primary relational DB (`omnichannel`), schema managed by Laravel migrations
- MongoDB (27017) — message store
- Redis (6379) — cache, sessions, realtime fanout
- RabbitMQ (5672) — queue transport

No docker-compose in this repo. Run infrastructure yourself.

**SQL Server leftovers:** `backend/.env.example` and `config/database.php` still default to `sqlsrv` (port 1433, user `sa`), but the gateway reads the same database via `mysql2` (`gateway/lib/sqlPool.js` — "replaces the former mssql pool", MySQL protocol only). A working full stack therefore needs MySQL/MariaDB and `DB_CONNECTION=mysql` in `backend/.env`; don't trust the sqlsrv defaults in either `.env.example`.

## Development Commands

```bash
# Backend (Laravel 13, port 8000)
cd backend
composer install && cp .env.example .env && php artisan key:generate
php artisan migrate
composer dev          # serve + queue:listen + pail + vite concurrently
composer test         # php artisan test (PHPUnit)
php artisan test --filter=AgentManagementTest   # single class (also works with a method name)
vendor/bin/pint       # PHP formatter

# Gateway (Express webhook receiver, port 3001)
cd gateway
npm install && cp .env.example .env
npm run dev           # node --watch
npm test              # jest --runInBand — configured, but no test files exist yet

# Realtime server (Socket.io, port 3002)
cd realtime-server
npm install && cp .env.example .env
npm run dev           # node --watch (no tests)

# Frontend (React 18 + TypeScript + Vite, port 5173)
cd frontend
npm install && cp .env.example .env
npm run dev
npm run build         # tsc && vite build — the typecheck gate (no separate lint)

# Production deploy (frontend only — atomic symlink swap, keeps 5 releases)
./deploy.sh           # builds frontend, deploys to /var/www/omniclick-web
./deploy.sh rollback  # revert to previous release
```

## Architecture

### Data Flow (Inbound Messages)

```
Provider webhook → gateway (3001)
  → verify provider signature (middleware/verifySignature.js; raw body captured before JSON parse)
  → resolve channel + decrypt credentials from SQL (services/channelResolver.js)
  → normalize to canonical schema (normalizer/*)
  → publish to RabbitMQ (services/publisher.js)
→ backend ProcessInboundMessage job
  → idempotency check
  → identity resolution (IdentityResolutionService)
  → conversation lookup/create (ConversationOrchestrator)
  → persist to MongoDB (MessagePersistenceService), update SQL conversation
  → bot flow / assignment
  → publish event to Redis (RealtimeEventPublisher)
→ realtime-server subscribes to Redis → emits via Socket.io → frontend
```

Outbound: backend `OutboundMessageService` → `Channels\AdapterRegistry` (adapters bound in `AppServiceProvider`) → provider APIs. Adapters: WhatsAppCloud, WhatsAppQr, FacebookMessenger, Line, TwilioSms, SmtpEmail. There is no Telegram outbound adapter yet (Telegram is inbound-only via the gateway). WhatsAppQr sends are relayed to the gateway's internal API — the Baileys socket and session files live on the gateway.

### Backend (Laravel 13, `backend/`)

- `app/Services/` — core business logic: BotFlowEngine (bot flow state machines), ConversationOrchestrator, IdentityResolutionService, MessagePersistenceService (MongoDB), OutboundMessageService, RealtimeEventPublisher, AiClientService, ChannelHealthService (health checks with auto-deactivation), JwtService (signs the Socket.io JWT), `Channels/` adapters
- `app/Jobs/` — ProcessInboundMessage (main pipeline), ProcessBroadcastChunkJob (campaign chunks), AgentDailyRollupJob / HourlyVolumeAggregationJob (analytics)
- Route files (middleware aliases registered in `bootstrap/app.php`):
  - `routes/api.php` — public API, `auth:sanctum` + `tenant`
  - `routes/system.php` — `/api/system/*` cross-tenant admin (companies, users), super_admin only via `system.admin` middleware
  - `routes/internal.php` — service-to-service, `internal.key` middleware expects `X-Internal-Key`; called by gateway (cache invalidation, voice sessions) and realtime-server (agent presence, skills, conversation state)

### Gateway (Express, `gateway/`)

- `server.js` — entry point; captures raw body before JSON parse for HMAC verification
- `routes/` — per-channel webhook endpoints (whatsapp, whatsappCalls, line, email, telegram, facebook) plus `internal.js` — Baileys control API called by the backend (QR start/status/send/disconnect/sync)
- `services/baileysManager.js` — WhatsApp personal-account sessions (QR pairing) via Baileys
- `services/aiVoiceBridge.js` — bridges WhatsApp voice calls to AI agents (werift WebRTC + opus)
- `normalizer/` — whatsapp, line, telegram, email adapters → canonical schema
- `lib/` — amqpClient, redisClient, redisKeys, sqlPool (mysql2), canonicalSchema

### Realtime Server (Socket.io, `realtime-server/`)

- `middleware/socketAuth.js` — validates the JWT issued by backend `JwtService` (shared `APP_JWT_SECRET`)
- `socket/handlers/` — connection, messaging, presence
- `redis/` — two separate Redis connections required (subscriber + publisher)

### Frontend (React 18 + TypeScript + Vite, `frontend/`)

- `src/stores/` — zustand stores: auth, inbox, conversations, presence, socket
- `src/lib/` — api.ts (axios client), socket.ts, socketEventHandlers.ts
- Routing in `App.tsx`: manager roles (super_admin/admin/supervisor) get the AppShell sidebar pages (inbox, bot flows, broadcast, voice agents, analytics, settings); the `agent` role is locked to the standalone full-screen `/agent` chat page (`AgentOnly` guard, `RequireRole` redirects everyone else); `/system/*` pages are super_admin only

### docs/

Phase specs (bot/broadcast/analytics, realtime server, frontend, webhook gateway) and DB schema designs (`mongodb_schema.js`, `redis_key_design.js`). Useful background for intended behavior; the code may have moved on.

## Key Patterns

### Multi-Tenancy

Everything is tenant-scoped via `tenant` middleware + `Company` model. Always include `company_id` in queries. Conversation IDs are UUIDs (enforced with route constraint: `where('id', '[0-9a-f-]{36}')`).

### Roles & Permissions

`users.role`: `super_admin` > `admin` > `supervisor` > `agent`. On `User`: `canOverrideAssignment()` (manager check), `assignableRoles()` and `canManageMember()` form an explicit matrix — supervisors manage only agents; super_admin is never grantable through the API (DB bootstrap only). Agents see only conversations of channels assigned to them via `agent_channels` (`Conversation::scopeVisibleToAgent()`, applied on every read/write entry point, fail-closed when nothing is assigned). Mirror backend rule changes in the frontend guards (`App.tsx`) and vice versa.

### Shared Secrets

Copy between services when changing:
- `APP_KEY` — backend ↔ gateway (gateway decrypts channel credentials encrypted by Laravel `Crypt`)
- `APP_JWT_SECRET` — backend ↔ realtime-server (socket JWT)
- `INTERNAL_API_KEY` — all three services. Backend's internal routes expect header `X-Internal-Key`; the gateway's internal routes expect `X-Internal-Api-Key` (same key value, different header names)
- `CREDENTIAL_ENCRYPTION_KEY` — must be exactly 32 chars

### Logging

- Backend: Laravel's default logging (pail for real-time viewing); Node services: pino (pino-pretty in dev)
- Never log raw_payload (contains PII: names, phone numbers, message content). Log only: event_id, company_id, channel_type, content_type.

### AI Integration

`AiClientService` providers, configured per-company in `companies.settings.ai_config` (API key stored encrypted; env fallback `AI_PROVIDER`/`AI_API_KEY`/`AI_BASE_URL`/`AI_MODEL`): `openai`, `deepseek`, `xai` (Grok), `gemini`, `anthropic`, `nvidia` (NIM), `custom`. All speak the OpenAI-compatible chat API except `anthropic`, which uses the native Messages API.

## Code Quality & Tests

- PHP: Laravel Pint (`vendor/bin/pint`); frontend: TypeScript strict mode enforced via `npm run build`
- Real tests exist only in `backend/tests/Feature` (agent management, agent-channel assignment, conversation channel scoping). Gateway has jest+supertest configured but no test files; realtime-server and frontend have none. Add tests next to the code you change.

## Language

Backend locale is `id` (Indonesian); backend code comments and `.env.example` comments are partly Indonesian — keep that style there. Frontend user-facing strings are in Chinese. Git commit messages are Chinese (recent history) or English.

## Important Rules

- Never commit `.env` files
- Never bypass the canonical schema in gateway normalizers
- Never publish realtime events directly from backend to Socket.io — always via `RealtimeEventPublisher` through Redis
- Operations touching two databases (SQL + MongoDB) cannot be wrapped in one DB transaction. Safe order: SQL first, MongoDB second
- Channel credentials are encrypted at rest — decrypt with `Crypt::decryptString()` before use in adapters
