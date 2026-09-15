<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Jobs\ConversationResolvedAnalyticsJob;
use App\Models\Conversation;
use App\Models\ConversationAssignment;
use App\Services\RealtimeEventPublisher;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Throwable;

class ConversationController extends Controller
{
    public function __construct(private readonly RealtimeEventPublisher $realtime) {}

    /**
     * GET /api/conversations
     * Cursor-based pagination — cursor = id conversation terakhir di halaman sebelumnya.
     *
     * Query params:
     *   filter : mine | all | unassigned | pending (default: mine)
     *   cursor : UUID conversation (opsional)
     *   limit  : integer 1-100 (default: 30)
     */
    public function index(Request $request): JsonResponse
    {
        $user   = $request->user();
        $filter = $request->input('filter', 'mine');
        $limit  = min((int) $request->input('limit', 30), 100);
        $cursor = $request->input('cursor');

        // Agents only see conversations from channels assigned to them.
        $query = Conversation::with(['contact', 'channel', 'assignedAgent'])
            ->where('company_id', $user->company_id)
            ->visibleToAgent($user)
            ->whereIn('status', ['pending', 'open', 'snoozed']);

        match ($filter) {
            'mine'       => $query->where('assigned_agent_id', $user->id),
            'unassigned' => $query->whereNull('assigned_agent_id')->where('status', 'pending'),
            'pending'    => $query->where('status', 'pending'),
            default      => null, // 'all' — tidak ada filter tambahan
        };

        if ($cursor) {
            $pivot = Conversation::withoutGlobalScopes()
                ->where('id', $cursor)
                ->where('company_id', $user->company_id)
                ->value('last_message_at');

            if ($pivot) {
                $query->where('last_message_at', '<', $pivot);
            }
        }

        $conversations = $query->orderByDesc('last_message_at')->limit($limit + 1)->get();

        $hasMore    = $conversations->count() > $limit;
        $data       = $conversations->take($limit);
        $nextCursor = $hasMore ? $data->last()?->id : null;

        return response()->json([
            'data'        => $data->map(fn($c) => $this->formatSummary($c)),
            'next_cursor' => $nextCursor,
            'has_more'    => $hasMore,
        ]);
    }

    /**
     * GET /api/conversations/{id}
     */
    public function show(Request $request, string $id): JsonResponse
    {
        $conv = Conversation::with(['contact', 'channel', 'assignedAgent'])
            ->where('company_id', $request->user()->company_id)
            ->visibleToAgent($request->user())
            ->findOrFail($id);

        return response()->json($this->formatDetail($conv));
    }

    /**
     * POST /api/conversations/{id}/resolve
     */
    public function resolve(Request $request, string $id): JsonResponse
    {
        $conv = $this->findOwned($request, $id);

        $conv->update([
            'status'      => 'resolved',
            'resolved_at' => now(),
        ]);

        $this->realtime->conversationResolved($conv);

        // Analytics is a side effect of resolving, not part of it. An unguarded
        // dispatch here meant a queue outage returned 500 *after* the
        // conversation had already been marked resolved and the realtime event
        // pushed — the caller saw a failure for an action that had succeeded.
        try {
            ConversationResolvedAnalyticsJob::dispatch($conv->id);
        } catch (Throwable $e) {
            Log::error('Failed to queue resolve analytics', [
                'conversation_id' => $conv->id,
                'company_id'      => $conv->company_id,
                'error'           => $e->getMessage(),
            ]);
        }

        return response()->json(['status' => 'resolved']);
    }

    /**
     * PUT /api/conversations/{id}/read
     *
     * The agent chat has been calling this since before it existed, swallowing
     * the 404 with .catch(() => {}) — so unread badges never cleared when a
     * message arrived in an already-open conversation.
     *
     * MessageController::index also zeroes the counter, but only when loading
     * the first page. This is the explicit path for "the conversation is open
     * and the agent is looking at it right now".
     */
    public function markRead(Request $request, string $id): JsonResponse
    {
        $conv = $this->findOwned($request, $id);

        if ($conv->unread_count > 0) {
            $conv->update(['unread_count' => 0]);
        }

        return response()->json(['id' => $conv->id, 'unread_count' => 0]);
    }

    /**
     * POST /api/conversations/{id}/reopen
     */
    public function reopen(Request $request, string $id): JsonResponse
    {
        $conv = $this->findOwned($request, $id);

        $conv->update([
            'status'      => 'open',
            'resolved_at' => null,
        ]);

        $this->realtime->conversationReopened($conv);

        return response()->json(['status' => 'open']);
    }

    /**
     * POST /api/conversations/{id}/assign
     * Body: { agent_id: uuid }
     */
    public function assign(Request $request, string $id): JsonResponse
    {
        $validated = $request->validate(['agent_id' => 'required|uuid']);

        $conv    = $this->findOwned($request, $id);
        $agentId = $validated['agent_id'];

        DB::transaction(function () use ($conv, $agentId, $request) {
            $conv->update([
                'assigned_agent_id' => $agentId,
                'status'            => $conv->isPending() ? 'open' : $conv->status,
                'first_response_at' => $conv->first_response_at ?? now(),
            ]);

            ConversationAssignment::create([
                'conversation_id' => $conv->id,
                'company_id'      => $conv->company_id,
                'assigned_to'     => $agentId,
                'assigned_by'     => $request->user()->id,
                'reason'          => 'manual',
                'created_at'      => now(),
            ]);
        });

        $this->realtime->conversationAssigned($conv->fresh(), $agentId);

        return response()->json(['assigned_agent_id' => $agentId]);
    }

    /**
     * POST /api/conversations/{id}/snooze
     * Body: { until: ISO 8601 timestamp }
     */
    public function snooze(Request $request, string $id): JsonResponse
    {
        $validated = $request->validate(['until' => 'required|date|after:now']);

        $conv = $this->findOwned($request, $id);
        $conv->update([
            'status'        => 'snoozed',
            'snoozed_until' => $validated['until'],
        ]);

        return response()->json(['status' => 'snoozed', 'snoozed_until' => $validated['until']]);
    }

    // ── Private ───────────────────────────────────────────────────────────────

    private function findOwned(Request $request, string $id): Conversation
    {
        return Conversation::where('company_id', $request->user()->company_id)
            ->visibleToAgent($request->user())
            ->findOrFail($id);
    }

    private function formatSummary(Conversation $c): array
    {
        return [
            'id'                     => $c->id,
            'contact_name'           => $c->contact?->name,
            'contact_avatar'         => $c->contact?->avatar_url,
            'channel_type'           => $c->channel?->type,
            'last_message_preview'   => $c->last_message_preview,
            'last_message_at'        => $c->last_message_at?->toISOString(),
            'last_message_direction' => $c->last_message_direction,
            'status'                 => $c->status,
            'unread_count'           => $c->unread_count,
            'assigned_agent_id'      => $c->assigned_agent_id,
            'assigned_agent_name'    => $c->assignedAgent?->name,
            'priority'               => $c->priority ?? 'normal',
        ];
    }

    private function formatDetail(Conversation $c): array
    {
        return [
            ...$this->formatSummary($c),
            'channel_id'      => $c->channel_id,
            'channel_name'    => $c->channel?->name,
            'contact_id'      => $c->contact_id,
            'contact_email'   => $c->contact?->email,
            'contact_phone'   => $c->contact?->phone,
            'subject'         => $c->subject,
            'intent_tags'     => $c->intent_tags,
            'message_count'   => $c->message_count,
            'first_response_at' => $c->first_response_at?->toISOString(),
            'resolved_at'     => $c->resolved_at?->toISOString(),
            'snoozed_until'   => $c->snoozed_until?->toISOString(),
            'created_at'      => $c->created_at?->toISOString(),
        ];
    }
}
