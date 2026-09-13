<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Crypt;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;
use Illuminate\Validation\Rule;
use Throwable;

/**
 * Per-company Meta app credentials (supports MULTIPLE apps).
 *
 * Stored on companies.settings.meta_apps = [
 *   [
 *     'id'         => uuid,
 *     'label'      => human name,
 *     'kind'       => 'facebook' | 'whatsapp',
 *     'app_id'     => public App ID,
 *     'app_secret' => encrypted at rest,
 *     'config_id'  => optional (embedded login / embedded signup),
 *   ],
 * ]
 *
 * Secrets are encrypted with Crypt (APP_KEY) and never returned — only a
 * masked preview and whether they exist. This removes the single-app .env
 * limitation: each company (or each account) can bring its own Meta app.
 */
class MetaAppConfigController extends Controller
{
    private const KINDS = ['facebook', 'whatsapp'];

    /** GET /api/meta-apps — list configured Meta apps (secrets masked) */
    public function index(Request $request): JsonResponse
    {
        $company = $request->user()->company;
        $apps    = $this->getApps($company);

        return response()->json([
            'data' => collect($apps)->map(fn ($app) => $this->present($app))->values(),
        ]);
    }

    /** POST /api/meta-apps — add a Meta app */
    public function store(Request $request): JsonResponse
    {
        $company = $request->user()->company;

        $data = $request->validate([
            'label'      => 'required|string|max:100',
            'kind'       => ['required', Rule::in(self::KINDS)],
            'app_id'     => 'required|string|max:100',
            'app_secret' => 'required|string|max:200',
            'config_id'  => 'nullable|string|max:100',
        ]);

        $apps = $this->getApps($company);

        if (collect($apps)->contains('app_id', $data['app_id'])) {
            return response()->json(['message' => '该 App ID 已存在。'], 422);
        }

        $apps[] = [
            'id'         => (string) \Illuminate\Support\Str::uuid(),
            'label'      => $data['label'],
            'kind'       => $data['kind'],
            'app_id'     => $data['app_id'],
            'app_secret' => Crypt::encryptString($data['app_secret']),
            'config_id'  => $data['config_id'] ?? null,
        ];

        $this->saveApps($company, $apps);

        Log::info('Meta app added', ['company_id' => $company->id, 'kind' => $data['kind']]);

        return response()->json(['data' => $this->present(end($apps))], 201);
    }

    /** PUT /api/meta-apps/{id} — update label/secret/config (secret optional) */
    public function update(Request $request, string $id): JsonResponse
    {
        $company = $request->user()->company;
        $apps    = $this->getApps($company);
        $index   = collect($apps)->search(fn ($a) => ($a['id'] ?? null) === $id);

        if ($index === false) {
            return response()->json(['message' => '未找到该应用配置。'], 404);
        }

        $data = $request->validate([
            'label'      => 'sometimes|string|max:100',
            'kind'       => ['sometimes', Rule::in(self::KINDS)],
            'app_secret' => 'sometimes|nullable|string|max:200',
            'config_id'  => 'sometimes|nullable|string|max:100',
        ]);

        if (isset($data['label']))     $apps[$index]['label']     = $data['label'];
        if (isset($data['kind']))      $apps[$index]['kind']      = $data['kind'];
        if (isset($data['config_id'])) $apps[$index]['config_id'] = $data['config_id'];

        if (! empty($data['app_secret'])) {
            $apps[$index]['app_secret'] = Crypt::encryptString($data['app_secret']);
        }

        $this->saveApps($company, $apps);

        return response()->json(['data' => $this->present($apps[$index])]);
    }

    /** DELETE /api/meta-apps/{id} */
    public function destroy(Request $request, string $id): JsonResponse
    {
        $company = $request->user()->company;
        $apps    = $this->getApps($company);

        $remaining = collect($apps)->reject(fn ($a) => ($a['id'] ?? null) === $id)->values()->all();

        if (count($remaining) === count($apps)) {
            return response()->json(['message' => '未找到该应用配置。'], 404);
        }

        $this->saveApps($company, $remaining);

        return response()->json(['message' => 'deleted']);
    }

    /** POST /api/meta-apps/{id}/verify — ping the Graph API to check the app works */
    public function verify(Request $request, string $id): JsonResponse
    {
        $company = $request->user()->company;
        $app     = collect($this->getApps($company))->first(fn ($a) => ($a['id'] ?? null) === $id);

        if (! $app) {
            return response()->json(['message' => '未找到该应用配置。'], 404);
        }

        try {
            $secret = Crypt::decryptString($app['app_secret']);
        } catch (Throwable) {
            return response()->json(['message' => '密钥解密失败（APP_KEY 是否变更过？）。'], 500);
        }

        $resp = Http::timeout(15)->get('https://graph.facebook.com/oauth/access_token', [
            'client_id'     => $app['app_id'],
            'client_secret' => $secret,
            'grant_type'    => 'client_credentials',
        ]);

        if ($resp->successful() && $resp->json('access_token')) {
            return response()->json(['data' => ['valid' => true, 'app_id' => $app['app_id']]]);
        }

        $err = $resp->json('error.message') ?? "HTTP {$resp->status()}";
        return response()->json(['data' => ['valid' => false, 'error' => $err]]);
    }

    // ── Public helpers for other controllers ─────────────────────────────────

    /**
     * Resolve Meta app credentials for a company, preferring the given id or
     * falling back to the first app of that kind. Returns [app_id, secret, config_id].
     *
     * @return array{ app_id: string, app_secret: string, config_id: ?string }|null
     */
    public static function resolveFor(string $companyId, string $kind, ?string $appId = null): ?array
    {
        $company = \App\Models\Company::find($companyId);
        if (! $company) return null;

        $apps = collect($company->settings['meta_apps'] ?? [])
            ->filter(fn ($a) => ($a['kind'] ?? null) === $kind);

        $app = $appId
            ? $apps->first(fn ($a) => ($a['app_id'] ?? null) === $appId)
            : $apps->first();

        if (! $app) return null;

        try {
            $secret = Crypt::decryptString($app['app_secret']);
        } catch (Throwable) {
            return null;
        }

        return [
            'app_id'     => $app['app_id'],
            'app_secret' => $secret,
            'config_id'  => $app['config_id'] ?? null,
        ];
    }

    // ── Private ───────────────────────────────────────────────────────────────

    private function getApps($company): array
    {
        return $company->settings['meta_apps'] ?? [];
    }

    private function saveApps($company, array $apps): void
    {
        $settings              = $company->settings ?? [];
        $settings['meta_apps'] = array_values($apps);
        $company->settings     = $settings;
        $company->save();
    }

    private function present(array $app): array
    {
        return [
            'id'          => $app['id'],
            'label'       => $app['label'],
            'kind'        => $app['kind'],
            'app_id'      => $app['app_id'],
            'config_id'   => $app['config_id'] ?? null,
            'has_secret'  => ! empty($app['app_secret']),
            'secret_hint' => '••••' . substr($app['app_id'], -4),
        ];
    }
}
