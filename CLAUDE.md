# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

OmniClick is an omnichannel customer messaging platform supporting WhatsApp, Telegram, LINE, Email, Facebook, and voice calls. It connects to multiple messaging providers via a webhook gateway, processes messages through a Laravel backend with queue workers, and delivers real-time updates to a React frontend via Socket.io.

## Infrastructure Prerequisites

- PHP 8.3+ with Composer
- Node 20+ with npm
- MySQL/MariaDB (3306)
- MongoDB (27017) — message store
- Redis (6379) — cache, sessions, realtime fanout
- RabbitMQ (5672) — queue transport

No docker-compose in this repo. Run infrastructure yourself.

## Development Commands

```bash
# Backend (Laravel 13, port 8000) — serves API, runs queue worker, logs, vite
cd backend
composer install && cp .env.example .env && php artisan key:generate
php artisan migrate
composer dev          # serve + queue:listen + pail + vite concurrently
composer test         # php artisan test (PHPUnit) — needs the test schemas below

# Gateway (Express webhook receiver, port 3001)
cd gateway
npm install && cp .env.example .env
npm run dev           # node --watch
npm test              # jest --runInBand

# Realtime server (Socket.io, port 3002)
cd realtime-server
npm install && cp .env.example .env
npm run dev           # node --watch

# Frontend (React 18 + TypeScript + Vite, port 5173)
cd frontend
npm install && cp .env.example .env
npm run dev           # vite dev server
npm run build         # tsc && vite build — typecheck gate

# Production deploy (atomic symlink swap)
./deploy.sh           # builds frontend, deploys to /var/www/omniclick-web
./deploy.sh rollback  # revert to previous release
```

## Architecture

### Data Flow (Inbound Messages)

```
Provider webhook → gateway
  → verify signature (middleware/verifySignature.js)
  → resolve channel credentials (services/channelResolver.js)
  → normalize to canonical schema (normalizer/*)
  → publish to RabbitMQ (services/publisher.js)
→ backend ProcessInboundMessage job
  → idempotency check
  → identity resolution (IdentityResolutionService)
  → conversation lookup/create (ConversationOrchestrator)
  → persist to MongoDB (MessagePersistenceService)
  → update SQL conversation
  → publish event to Redis (RealtimeEventPublisher)
→ realtime-server subscribes to Redis channel
  → emits via Socket.io
→ frontend receives realtime event
```

### Backend (Laravel 13)

- `app/Services/` — core business logic:
  - `BotFlowEngine.php` — executes bot flow state machines
  - `ConversationOrchestrator.php` — find/create conversations
  - `IdentityResolutionService.php` — resolve or create contacts
  - `MessagePersistenceService.php` — MongoDB message storage
  - `OutboundMessageService.php` — outbound message delivery
  - `RealtimeEventPublisher.php` — Redis pub/sub for Socket.io events
  - `AiClientService.php` — multi-provider AI (OpenAI, Claude, Claude, Gemini, Anthropic NIM, custom)
  - `Channels/` — channel adapters (WhatsApp Cloud, LINE, Telegram, Email, Facebook)
  - `ChannelHealthService.php` — automatic channel health checks with auto-deactivation
- `app/Jobs/` — queue jobs:
  - `ProcessInboundMessage.php` — main message processing pipeline
  - `ProcessBroadcastChunkJob.php` — broadcast campaign chunk processing
  - `AgentDailyRollupJob.php`, `HourlyVolumeAggregationJob.php` — analytics aggregation
- `backend/routes/api.php` — public API with `auth:sanctum` + `tenant` middleware
- `backend/routes/internal.php` — service-to-service API guarded by `X-Internal-Key`

### Gateway (Express)

- `server.js` — entry point; uses raw body capture before JSON parse for HMAC verification
- `routes/` — per-channel webhook endpoints (whatsapp, whatsappCalls, line, email, telegram, facebook)
- `middleware/verifySignature.js` — provider signature verification
- `services/channelResolver.js` — resolves channel credentials (decrypted from SQL)
- `services/publisher.js` — RabbitMQ publish
- `normalizer/` — per-channel adapters to canonical schema
- `lib/` — shared clients (amqpClient, redisClient, sqlPool, canonicalSchema)
- Voice calling: `services/aiVoiceBridge.js` bridges WhatsApp calls to AI agents

### Realtime Server (Socket.io)

- `server.js` — Socket.io with JWT auth
- `middleware/socketAuth.js` — validates JWT from frontend
- `socket/handlers/` — connection, messaging, presence handlers
- `redis/` — two separate Redis connections (subscriber + publisher)
- Subscribes to Redis channels published by backend for real-time event routing

### Frontend (React 18 + TypeScript + Vite)

- `src/stores/` — Zustand stores: auth, inbox, conversations, presence, socket
- `src/lib/` — axios client (api.ts), Socket.io client, socket event handlers
- `src/pages/` — route pages (Inbox, BotFlows, Broadcast, Analytics, Settings)
- `src/components/conversation/` — conversation UI components
- `src/components/inbox/` — inbox list components

## Key Patterns

### Multi-Tenancy

Everything is tenant-scoped via `tenant` middleware + `Company` model. Always include `company_id` in queries. Conversation IDs are UUIDs (enforced with route constraint: `where('id', '[0-9a-f-]{36}')`).

### Shared Secrets

Copy between services when changing:
- `APP_KEY` — backend to gateway (decrypts channel credentials)
- `APP_JWT_SECRET` — backend to realtime-server (socket JWT)
- `INTERNAL_API_KEY` — backend to realtime-server (internal API calls)
- `CREDENTIAL_ENCRYPTION_KEY` — must be exactly 32 chars

### Logging

- Backend: Laravel's default logging (pail for real-time viewing)
- Node services: pino (pino-pretty in dev)
- Never log raw_payload (contains PII: names, phone numbers, message content). Log only: event_id, company_id, channel_type, content_type.

### AI Integration

`AiClientService` supports multiple providers configured per-company in `companies.settings.ai_config`. Supported providers: OpenAI, Claude, xAI (Grok), Google Gemini, Anthropic Claude, Anthropic NIM, and custom OpenAI-compatible endpoints.

## Code Quality

- PHP: Laravel Pint (`vendor/bin/pint`)
- Frontend: TypeScript strict mode enforced via `npm run build` (tsc + vite build)
- Tests: Backend `composer test`, Gateway `npm test` (Jest). Add tests next to the code you change.

### Backend test databases

The suite runs against **MySQL, not sqlite** — the app uses `DAYOFWEEK`,
`TIMESTAMPDIFF` and `JSON_CONTAINS`, none of which sqlite has, and running on
sqlite let three SQL-dialect bugs ship undetected. `phpunit.xml` pins the
schemas; create them once:

```sql
CREATE DATABASE omnichannel_test CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
GRANT ALL PRIVILEGES ON omnichannel_test.* TO '<DB_USERNAME>'@'127.0.0.1';
```

`RefreshDatabase` truncates whatever `DB_DATABASE` points at, so this must never
be the application schema. Mongo-backed tests use `omnichannel_messages_test`
(created on first write) via the `RefreshesMongo` trait, and skip themselves if
no MongoDB is reachable.

## Language

Backend locale is `id` (Indonesian). Comments in `.env.example` are partly Indonesian. Keep that style there. User-facing strings in frontend are in Chinese. Channel credentials are encrypted at rest — decrypt with `Crypt::decryptString()` before use in adapters.

## Important Rules

- Never commit `.env` files
- Never bypass the canonical schema in gateway normalizers
- Never publish realtime events directly from backend to Socket.io — always via `RealtimeEventPublisher` through Redis
- Operations touching two databases (SQL + MongoDB) cannot be wrapped in one DB transaction. Safe order: SQL first, MongoDB second
