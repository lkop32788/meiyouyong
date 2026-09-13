# Project knowledge

OmniClick — omnichannel customer-messaging platform (WhatsApp, Telegram, LINE, Email) with a multi-tenant backend, webhook gateway, realtime server, and React frontend.

## Quickstart

Prereqs: PHP 8.3+, Composer, Node 20+, SQL Server (1433), MongoDB (27017), Redis (6379), RabbitMQ (5672). No docker-compose in repo — run infra yourself.

```bash
# Backend (Laravel, port 8000) — also runs queue worker, logs (pail), and vite
cd backend
composer install && cp .env.example .env && php artisan key:generate
php artisan migrate
composer dev          # serve + queue:listen + pail + vite concurrently
composer test         # artisan test (PHPUnit)

# Gateway (Express webhook receiver, port 3001)
cd gateway
npm install && cp .env.example .env
npm run dev           # node --watch
npm test              # jest --runInBand (NODE_ENV=test)

# Realtime server (Socket.io, port 3002)
cd realtime-server
npm install && cp .env.example .env
npm run dev           # node --watch

# Frontend (React 18 + TS + Vite, port 5173)
cd frontend
npm install && cp .env.example .env
npm run dev           # vite
npm run build         # tsc && vite build — the typecheck gate

# Production web deploy (builds frontend + atomic symlink swap to /var/www/omniclick-web)
./deploy.sh           # rollback: ./deploy.sh rollback
```

## Architecture

Key directories:

- `backend/` — Laravel 13 API. `app/Services/` (BotFlowEngine, ConversationOrchestrator, OutboundMessageService, RealtimeEventPublisher, JwtService…), `app/Jobs/` (queue jobs: inbound processing, broadcast chunks, analytics rollups), `app/Models/` (multi-tenant, scoped via `app/Models/Scopes`).
- `backend/routes/` — `api.php` (public auth + sanctum `auth:sanctum` + `tenant` middleware), `internal.php` (service-to-service, guarded by `INTERNAL_API_KEY`), `web.php`, `console.php`.
- `gateway/` — Express webhook receiver. Flow: `routes/` (per-channel endpoints) → `middleware/verifySignature.js` (provider signature verify) → `services/channelResolver.js` (resolve channel creds) → `normalizer/` (per-channel adapters to canonical schema) → `services/publisher.js` (RabbitMQ). Shared clients in `lib/` (amqpClient, redisClient, redisKeys, sqlPool, canonicalSchema).
- `realtime-server/` — Socket.io server. `middleware/socketAuth.js` (JWT), `socket/handlers/` (connection, messaging, presence), `redis/` (subscriber + publisher — two separate Redis connections are required), `socket/rooms.js`.
- `frontend/src/` — React SPA. `stores/` (zustand: auth, inbox, conversations, presence, socket), `lib/` (api.ts axios client, socket.ts, socketEventHandlers.ts), `pages/` (inbox, login, bot, broadcast, analytics).
- `docs/` — phase specs (BCA, Realtime/Frontend, Webhook Gateway) and DB schema designs (`mongodb_schema.js`, `redis_key_design.js`).

Data flow (inbound): provider webhook → gateway (verify → resolve → normalize) → RabbitMQ → backend `ProcessInboundMessage` (persist to MongoDB/SQL, bot flow, assignment) → `RealtimeEventPublisher` → Redis → realtime-server → Socket.io → frontend. Outbound: backend `OutboundMessageService` → channel APIs. Analytics: hourly/daily aggregation jobs.

Storage: SQL Server = primary relational DB (`omnichannel`), MongoDB = message store, Redis = cache/session/realtime fanout, RabbitMQ = queue transport.

## Conventions

- Formatting/linting: Laravel Pint for PHP (`vendor/bin/pint`); frontend typechecked via `npm run build` (tsc strict). pino for Node logging (pino-pretty in dev).
- Multi-tenancy: everything tenant-scoped — `tenant` middleware + `Company`; conversation IDs are UUIDs (validate with `where('id', '[0-9a-f-]{36}')` route constraints).
- Shared secrets (copy between services when changing): backend `APP_KEY` ↔ gateway (decrypts channel credentials), `APP_JWT_SECRET` ↔ realtime-server (socket JWT), `INTERNAL_API_KEY` ↔ realtime-server (internal API calls). `CREDENTIAL_ENCRYPTION_KEY` must be exactly 32 chars.
- Language: backend locale is `id` (Indonesian); comments in `.env.example` files are partly Indonesian — keep that style there. User-facing strings in Indonesian.
- Things to avoid: NEVER commit `.env` files; never log or hardcode credentials (channel creds are encrypted at rest); don't bypass the canonical schema in gateway normalizers; don't publish realtime events directly from backend to Socket.io — always via Redis through `RealtimeEventPublisher`.
- Testing: backend `composer test`, gateway `npm test` (jest). Tests are sparse (scaffold `ExampleTest`s) — add tests next to the code you change; follow existing `tests/Feature` / `tests/Unit` layout.
