<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\QuickReply;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

class QuickReplyController extends Controller
{
    public function index(Request $request): JsonResponse
    {
        $replies = QuickReply::where('company_id', $request->user()->company_id)
            ->orderBy('sort_order')
            ->orderBy('title')
            ->get();

        return response()->json(['data' => $replies]);
    }

    public function store(Request $request): JsonResponse
    {
        $data = $request->validate([
            'title'    => 'required|string|max:100',
            'shortcut' => 'nullable|string|max:50',
            'message'  => 'required|string|max:2000',
            'sort_order' => 'nullable|integer|min:0',
        ]);

        $reply = QuickReply::create([
            'company_id' => $request->user()->company_id,
            'title'      => $data['title'],
            'shortcut'   => $data['shortcut'] ?? null,
            'message'    => $data['message'],
            'sort_order' => $data['sort_order'] ?? 0,
        ]);

        return response()->json(['data' => $reply], 201);
    }

    public function update(Request $request, string $id): JsonResponse
    {
        $reply = QuickReply::where('company_id', $request->user()->company_id)
            ->findOrFail($id);

        $data = $request->validate([
            'title'     => 'sometimes|string|max:100',
            'shortcut'  => 'nullable|string|max:50',
            'message'   => 'sometimes|string|max:2000',
            'sort_order' => 'nullable|integer|min:0',
        ]);

        $reply->fill($data);
        $reply->save();

        return response()->json(['data' => $reply]);
    }

    public function destroy(Request $request, string $id): JsonResponse
    {
        $reply = QuickReply::where('company_id', $request->user()->company_id)
            ->findOrFail($id);

        $reply->delete();

        return response()->json(['message' => 'deleted']);
    }
}
