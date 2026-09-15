<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Conversation;
use App\Models\Message;
use App\Services\OutboundMessageService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

class MessageController extends Controller
{
    public function __construct(private readonly OutboundMessageService $outbound) {}

    /**
     * GET /api/conversations/{id}/messages
     *
     * Query params:
     *   limit  : integer 1-50 (default: 30)
     *   before : MongoDB _id — load pesan lebih lama dari ini (scroll ke atas)
     *
     * Response: { data: Message[], has_more: bool }
     */
    public function index(Request $request, string $id): JsonResponse
    {
        $conv  = $this->findOwned($request, $id);
        $limit = min((int) $request->input('limit', 30), 50);
        $before = $request->input('before');

        $query = Message::where('company_id', $conv->company_id)
            ->where('conversation_id', $conv->id)
            ->orderByDesc('provider_timestamp');

        if ($before) {
            $pivot = Message::where('_id', $before)->value('provider_timestamp');
            if ($pivot) {
                $query->where('provider_timestamp', '<', $pivot);
            }
        }

        $messages = $query->limit($limit + 1)->get();
        $hasMore  = $messages->count() > $limit;
        $data     = $messages->take($limit)->reverse()->values();

        // Reset unread saat messages di-load (conversation sedang dibuka)
        if (! $before) {
            $conv->update(['unread_count' => 0]);
        }

        return response()->json([
            'data'     => $data->map(fn($m) => $this->formatMessage($m)),
            'has_more' => $hasMore,
        ]);
    }

    /**
     * POST /api/conversations/{id}/messages
     *
     * Body: {
     *   content_type : text | image | audio | video | file
     *   content      : { body?, url?, filename?, caption?, ... }
     *   reply_to_provider_msg_id : string (opsional)
     * }
     */
    public function store(Request $request, string $id): JsonResponse
    {
        $conv = $this->findOwned($request, $id);

        $validated = $request->validate([
            'content_type'             => 'required|in:text,image,audio,video,file',
            'content'                  => 'required|array',
            'content.body'             => 'required_if:content_type,text|string|max:4096',
            'content.url'              => 'required_unless:content_type,text|url',
            'reply_to_provider_msg_id' => 'sometimes|nullable|string|max:255',
        ]);

        $contact = $conv->contact;
        if (! $contact) {
            return response()->json(['error' => 'Contact not found for this conversation'], 422);
        }

        $mongoId = $this->outbound->send(
            conv:                   $conv,
            contact:                $contact,
            agentId:                $request->user()->id,
            contentType:            $validated['content_type'],
            content:                $validated['content'],
            replyToProviderMsgId:   $validated['reply_to_provider_msg_id'] ?? null,
        );

        $message = Message::where('_id', $mongoId)->first();

        return response()->json(
            ['message' => $message ? $this->formatMessage($message) : ['id' => $mongoId]],
            201
        );
    }

    // ── Private ───────────────────────────────────────────────────────────────

    private function findOwned(Request $request, string $id): Conversation
    {
        return Conversation::with('contact')
            ->where('company_id', $request->user()->company_id)
            ->visibleToAgent($request->user())
            ->findOrFail($id);
    }

    private function formatMessage($m): array
    {
        return [
            'id'                  => (string) $m->_id,
            'conversation_id'     => $m->conversation_id,
            'direction'           => $m->direction,
            'sender_type'         => $m->sender_type,
            'sender_id'           => $m->sender_id,
            'content_type'        => $m->content_type,
            'content'             => $m->content,
            'status'              => $m->status,
            'provider_message_id' => $m->provider_message_id,
            'provider_timestamp'  => $m->provider_timestamp,
            'quoted_message_id'   => $m->quoted_message_id,
            'is_deleted'          => $m->is_deleted ?? false,
            'created_at'          => $m->created_at?->toISOString(),
        ];
    }
}
