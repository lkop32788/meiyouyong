<?php

namespace App\Http\Controllers\Internal;

use App\Http\Controllers\Controller;
use App\Models\Conversation;
use App\Services\DispatcherBridge;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Redis;

/**
 * Baca conversation state dari Redis — dipakai Realtime Server untuk
 * authorization join:conversation dan event routing.
 *
 * Jika cache Redis sudah expired (TTL 1 jam), fallback ke SQL dan tulis
 * ulang cache-nya. Conversation yang tidak ada / beda company → null,
 * dan Realtime Server WAJIB menolak akses (fail-closed).
 */
class ConversationStateController extends Controller
{
    public function __construct(private readonly DispatcherBridge $dispatcher) {}

    /**
     * GET /internal/conversations/{id}/state
     *
     * Query params: company_id (required — validasi kepemilikan)
     */
    public function show(Request $request, string $id): JsonResponse
    {
        $validated = $request->validate([
            'company_id' => 'required|uuid',
        ]);

        $key   = "conv:state:{$validated['company_id']}:{$id}";
        $state = Redis::hGetAll($key);

        if (! empty($state)) {
            return response()->json(['state' => $state]);
        }

        // Cache miss — rebuild dari SQL (company scope tetap dijaga)
        $conv = Conversation::withoutGlobalScopes()
            ->where('id', $id)
            ->where('company_id', $validated['company_id'])
            ->first();

        if (! $conv) {
            return response()->json(['state' => null], 200);
        }

        $this->dispatcher->syncConversationState($conv);

        return response()->json(['state' => Redis::hGetAll($key)]);
    }
}
