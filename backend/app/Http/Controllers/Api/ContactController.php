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
     * POST /api/contacts/import — CSV bulk import (upsert by phone)
     *
     * Supports columns: name, phone, email, tags
     * Tags can be separated by ; or |
     * If phone already exists, updates name/email/tags instead of creating duplicate.
     */
    public function import(Request $request): JsonResponse
    {
        $request->validate([
            'file' => 'required|file|mimes:csv,txt|max:10240',
        ]);

        $companyId = $request->user()->company_id;
        $file = $request->file('file');

        // Read and strip BOM
        $content = file_get_contents($file->getRealPath());
        $content = preg_replace('/^\xEF\xBB\xBF/', '', $content);
        $lines = array_filter(preg_split('/\r?\n/', $content), fn($l) => trim($l) !== '');

        if (count($lines) < 2) {
            return response()->json(['message' => 'CSV 文件为空或无有效数据行'], 422);
        }

        // Parse header row
        $headers = array_map(
            fn($h) => strtolower(trim(str_replace(['"', "'"], '', $h))),
            str_getcsv($lines[0])
        );

        $results = ['created' => 0, 'updated' => 0, 'failed' => 0, 'errors' => []];

        // Process data rows
        for ($i = 1; $i < count($lines); $i++) {
            $values = array_map(
                fn($v) => trim(str_replace(['"', "'"], '', $v)),
                str_getcsv($lines[$i])
            );
            $row = array_combine($headers, $values) ?: [];

            // Phone: strip non-digits, require
            $phone = preg_replace('/[^0-9]/', '', $row['phone'] ?? '');
            if (empty($phone)) {
                $results['failed']++;
                $results['errors'][] = ['row' => $i + 1, 'error' => '缺少手机号'];
                continue;
            }

            $name  = trim($row['name'] ?? '') ?: 'Unknown';
            $email = trim($row['email'] ?? '') ?: null;
            $tagsRaw = trim($row['tags'] ?? '');
            $tags = $tagsRaw !== ''
                ? array_values(array_filter(array_map('trim', preg_split('/[;|]/', $tagsRaw))))
                : [];

            try {
                $existing = Contact::where('company_id', $companyId)
                    ->where('phone', $phone)
                    ->first();

                if ($existing) {
                    $existing->update(['name' => $name, 'email' => $email, 'tags' => $tags]);
                    $results['updated']++;
                } else {
                    Contact::create([
                        'company_id' => $companyId,
                        'name'  => $name,
                        'phone' => $phone,
                        'email' => $email,
                        'tags'  => $tags,
                    ]);
                    $results['created']++;
                }
            } catch (\Throwable $e) {
                $results['failed']++;
                $results['errors'][] = ['row' => $i + 1, 'phone' => $phone, 'error' => $e->getMessage()];
            }
        }

        $msg = "导入完成：新增 {$results['created']} 条，更新 {$results['updated']} 条";
        if ($results['failed'] > 0) {
            $msg .= "，失败 {$results['failed']} 条";
        }

        return response()->json(['message' => $msg, 'data' => $results]);
    }

    /**
     * GET /api/contacts/export — CSV export
     */
    public function export(Request $request)
    {
        $contacts = Contact::where('company_id', $request->user()->company_id)
            ->orderByDesc('created_at')
            ->get(['name', 'phone', 'email', 'tags', 'created_at']);

        $esc = fn($v) => '"' . str_replace('"', '""', (string) ($v ?? '')) . '"';

        // BOM only once at the start
        $csv = "\xEF\xBB\xBFName,Phone,Email,Tags,Created At\n";

        foreach ($contacts as $c) {
            $csv .= implode(',', [
                $esc($c->name),
                $esc($c->phone ?? ''),
                $esc($c->email ?? ''),
                $esc(implode(';', $c->tags ?? [])),
                $esc($c->created_at?->toDateTimeString() ?? ''),
            ]) . "\n";
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
        $csv = "\xEF\xBB\xBFName,Phone,Email,Tags\n";
        $csv .= '"张三",13800138000,zhangsan@example.com,"VIP;客户"\n';
        $csv .= '"李四",13900139000,,"潜在客户"\n';

        return response()->streamDownload(fn() => print($csv), 'contacts-template.csv', [
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
