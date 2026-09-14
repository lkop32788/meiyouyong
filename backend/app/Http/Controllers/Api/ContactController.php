<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Contact;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

class ContactController extends Controller
{
    /**
     * GET /api/contacts — paginated list
     */
    public function index(Request $request): JsonResponse
    {
        $query = Contact::query()->orderByDesc('created_at');

        if ($request->query('search')) {
            $q = $request->query('search');
            $query->where(function ($sub) use ($q) {
                $sub->where('name', 'like', "%{$q}%")
                    ->orWhere('phone', 'like', "%{$q}%")
                    ->orWhere('email', 'like', "%{$q}%");
            });
        }

        if ($request->query('tag')) {
            $tag = $request->query('tag');
            $query->whereJsonContains('tags', $tag);
        }

        $perPage = min((int) $request->query('limit', 20), 100);
        $contacts = $query->paginate($perPage);

        return response()->json($contacts);
    }

    /**
     * GET /api/contacts/{id}
     */
    public function show(Request $request, string $id): JsonResponse
    {
        $contact = Contact::with('channelIdentities')
            ->where('company_id', $request->user()->company_id)
            ->findOrFail($id);

        return response()->json($this->format($contact));
    }

    /**
     * POST /api/contacts — create a contact
     */
    public function store(Request $request): JsonResponse
    {
        $data = $request->validate([
            'name'  => 'required|string|max:255',
            'phone' => 'nullable|string|max:30',
            'email' => 'nullable|email|max:255',
            'tags'  => 'nullable|array',
            'tags.*' => 'string|max:50',
        ]);

        $contact = Contact::create([
            'company_id' => $request->user()->company_id,
            'name'       => $data['name'],
            'phone'      => $data['phone'] ?? null,
            'email'      => $data['email'] ?? null,
            'tags'       => $data['tags'] ?? [],
        ]);

        return response()->json($this->format($contact), 201);
    }

    /**
     * PATCH /api/contacts/{id}
     */
    public function update(Request $request, string $id): JsonResponse
    {
        $contact = Contact::where('company_id', $request->user()->company_id)->findOrFail($id);

        $validated = $request->validate([
            'name'              => 'sometimes|string|max:255',
            'email'             => 'sometimes|nullable|email|max:255',
            'phone'             => 'sometimes|nullable|string|max:30',
            'locale'            => 'sometimes|nullable|string|max:10',
            'timezone'          => 'sometimes|nullable|string|max:50',
            'custom_attributes' => 'sometimes|array',
            'tags'              => 'sometimes|array',
            'tags.*'            => 'string|max:50',
        ]);

        if (isset($validated['name'])) {
            $validated['name_is_manual'] = true;
        }

        $contact->update($validated);

        return response()->json($this->format($contact->fresh('channelIdentities')));
    }

    /**
     * DELETE /api/contacts/{id}
     */
    public function destroy(Request $request, string $id): JsonResponse
    {
        $contact = Contact::where('company_id', $request->user()->company_id)->findOrFail($id);
        $contact->delete();

        return response()->json(['message' => 'deleted']);
    }

    /**
     * POST /api/contacts/import — CSV bulk import
     */
    public function import(Request $request): JsonResponse
    {
        $request->validate([
            'file' => 'required|file|mimes:csv,txt|max:10240', // max 10MB
        ]);

        $file = $request->file('file');
        $handle = fopen($file->getRealPath(), 'r');

        $header = fgetcsv($handle);
        if (!$header) {
            return response()->json(['message' => 'CSV 文件为空'], 422);
        }

        // Normalize header: trim + lowercase
        $header = array_map(fn($h) => strtolower(trim($h)), $header);
        $colMap = array_flip($header);

        $imported = 0;
        $skipped = 0;
        $errors = [];

        while (($row = fgetcsv($handle)) !== false) {
            $phone = isset($colMap['phone']) ? trim($row[$colMap['phone']] ?? '') : '';
            $name  = isset($colMap['name'])  ? trim($row[$colMap['name']]  ?? '') : '';
            $email = isset($colMap['email']) ? trim($row[$colMap['email']] ?? '') : '';
            $tagsRaw = isset($colMap['tags']) ? trim($row[$colMap['tags']] ?? '') : '';

            if (empty($phone) && empty($email)) {
                $skipped++;
                continue;
            }

            $tags = [];
            if ($tagsRaw !== '') {
                $tags = array_filter(array_map('trim', explode(';', $tagsRaw)));
            }

            try {
                Contact::create([
                    'company_id' => $request->user()->company_id,
                    'name'      => $name ?: ($phone ?: 'Unknown'),
                    'phone'     => $phone ?: null,
                    'email'     => $email ?: null,
                    'tags'      => $tags,
                ]);
                $imported++;
            } catch (\Throwable $e) {
                $skipped++;
            }
        }

        fclose($handle);

        return response()->json([
            'message'  => "导入完成：新增 {$imported} 条，跳过 {$skipped} 条",
            'imported' => $imported,
            'skipped'  => $skipped,
        ]);
    }

    /**
     * GET /api/contacts/export — CSV export
     */
    public function export(Request $request)
    {
        $companyId = $request->user()->company_id;

        $contacts = Contact::where('company_id', $companyId)
            ->orderByDesc('created_at')
            ->get(['name', 'phone', 'email', 'tags', 'created_at']);

        $rows = [['name', 'phone', 'email', 'tags', 'created_at']];
        foreach ($contacts as $c) {
            $rows[] = [
                $c->name,
                $c->phone ?? '',
                $c->email ?? '',
                implode(';', $c->tags ?? []),
                $c->created_at?->toDateTimeString() ?? '',
            ];
        }

        $csv = '';
        foreach ($rows as $row) {
            $csv .= "\xEF\xBB\xBF" . implode(',', array_map(fn($v) => '"' . str_replace('"', '""', $v) . '"', $row)) . "\n";
        }

        return response($csv, 200, [
            'Content-Type'        => 'text/csv; charset=UTF-8',
            'Content-Disposition' => 'attachment; filename="contacts-' . date('Y-m-d') . '.csv"',
        ]);
    }

    /**
     * GET /api/contacts/template — download CSV template
     */
    public function template(): \Symfony\Component\HttpFoundation\StreamedResponse
    {
        $rows = [
            ['name', 'phone', 'email', 'tags'],
            ['张三', '13800138000', 'zhangsan@example.com', 'VIP;客户'],
            ['李四', '13900139000', '', '潜在客户'],
        ];

        $csv = '';
        foreach ($rows as $row) {
            $csv .= "\xEF\xBB\xBF" . implode(',', array_map(fn($v) => '"' . str_replace('"', '""', $v) . '"', $row)) . "\n";
        }

        return response()->streamDownload(function () use ($csv) {
            echo $csv;
        }, 'contacts-template.csv', [
            'Content-Type' => 'text/csv; charset=UTF-8',
        ]);
    }

    // ── Private ───────────────────────────────────────────────────────────────

    private function format(Contact $c): array
    {
        return [
            'id'               => $c->id,
            'name'             => $c->name,
            'name_is_manual'   => $c->name_is_manual,
            'email'            => $c->email,
            'phone'            => $c->phone,
            'avatar_url'       => $c->avatar_url,
            'locale'           => $c->locale,
            'timezone'         => $c->timezone,
            'tags'             => $c->tags ?? [],
            'custom_attributes' => $c->custom_attributes ?? [],
            'lifetime_conversation_count' => $c->lifetime_conversation_count,
            'last_contacted_at' => $c->last_contacted_at?->toISOString(),
            'created_at'       => $c->created_at?->toISOString(),
            'channel_identities' => $c->channelIdentities->map(fn($i) => [
                'channel_type' => $i->channel_type,
                'external_id'  => $i->external_id,
                'display_name' => $i->display_name,
            ]),
        ];
    }
}
