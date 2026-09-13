<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Services\AiClientService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Crypt;
use Illuminate\Support\Facades\Log;
use Throwable;

/**
 * AI settings + flow generation.
 *
 * GET   /api/ai-config            → current config (key masked)
 * PUT   /api/ai-config            → update config
 * POST  /api/ai-config/test       → ping the provider with a 1-token prompt
 * POST  /api/ai/generate-flow     → natural-language description → flow_graph JSON
 */
class AiConfigController extends Controller
{
    public function __construct(private readonly AiClientService $ai) {}

    public function show(Request $request): JsonResponse
    {
        $cfg = $request->user()->company->settings['ai_config'] ?? [];

        return response()->json(['data' => [
            'provider'   => $cfg['provider'] ?? env('AI_PROVIDER', 'openai'),
            'base_url'   => $cfg['base_url'] ?? null,
            'model'      => $cfg['model'] ?? null,
            'has_key'    => ! empty($cfg['api_key']) || (bool) env('AI_API_KEY'),
            'providers'  => AiClientService::providers(),
        ]]);
    }

    public function update(Request $request): JsonResponse
    {
        $data = $request->validate([
            'provider' => 'required|in:openai,deepseek,xai,gemini,anthropic,custom',
            'api_key'  => 'sometimes|nullable|string|max:300',
            'base_url' => 'sometimes|nullable|string|max:300',
            'model'    => 'sometimes|nullable|string|max:120',
        ]);

        $company  = $request->user()->company;
        $settings = $company->settings ?? [];
        $existing = $settings['ai_config'] ?? [];

        $config = [
            'provider' => $data['provider'],
            'base_url' => $data['base_url'] ?? null,
            'model'    => $data['model'] ?? null,
        ];

        if (! empty($data['api_key'])) {
            $config['api_key'] = Crypt::encryptString($data['api_key']);
        } elseif (isset($existing['api_key'])) {
            $config['api_key'] = $existing['api_key']; // keep old key
        }

        $settings['ai_config'] = $config;
        $company->settings = $settings;
        $company->save();

        return response()->json(['message' => 'saved']);
    }

    public function test(Request $request): JsonResponse
    {
        try {
            $reply = $this->ai->chat(
                $request->user()->company_id,
                [['role' => 'user', 'content' => '回复“OK”两个字母即可']],
                maxTokens: 10,
            );

            return response()->json(['data' => ['ok' => true, 'reply' => mb_substr($reply, 0, 50)]]);
        } catch (Throwable $e) {
            return response()->json(['data' => ['ok' => false, 'error' => $e->getMessage()]], 200);
        }
    }

    /**
     * POST /api/ai/generate-flow  { description: string, name?: string }
     * Returns a complete BotFlow payload (name/trigger/flow_graph) that the
     * editor can adopt directly.
     */
    public function generateFlow(Request $request): JsonResponse
    {
        $data = $request->validate([
            'description' => 'required|string|min:5|max:4000',
            'name'        => 'nullable|string|max:150',
        ]);

        $companyId = $request->user()->company_id;

        $system = <<<'PROMPT'
你是客服机器人流程设计师。根据用户的自然语言描述，生成一个客服机器人流程。

严格只输出一个 JSON 对象（不要 markdown 代码块、不要解释），结构如下：
{
  "name": "流程名称（简短中文）",
  "trigger_type": "keyword|any_message|intent|event",
  "trigger_config": { "keywords": ["..."] },
  "flow_graph": {
    "nodes": [
      { "id": "start", "type": "send_message", "data": { "text": "..." } },
      { "id": "ask1", "type": "collect_input", "data": { "variable": "user_name", "prompt": "请问您怎么称呼？", "timeout_seconds": 60 } },
      { "id": "cond1", "type": "condition", "data": { "variable": "...", "operator": "eq|neq|contains|gte|lte", "value": "..." } },
      { "id": "set1", "type": "set_variable", "data": { "variable": "...", "value": "..." } },
      { "id": "api1", "type": "api_call", "data": { "url": "https://...", "method": "GET" } },
      { "id": "handoff1", "type": "handoff", "data": { "handoff_message": "..." } },
      { "id": "end1", "type": "end", "data": {} }
    ],
    "edges": [
      { "source": "start", "target": "ask1" },
      { "source": "cond1", "target": "handoff1", "label": "true" }
    ]
  }
}

节点类型只能是：send_message, collect_input, condition, set_variable, api_call, handoff, end。
规则：
1. 第一个节点 id 必须是 "start"（通常是 send_message 欢迎语）。
2. 流程必须以一个 end 节点收尾。
3. 每个非 end 节点都要有出发的 edge；condition 节点用 label "true"/"false" 分支。
4. 所有文案用简体中文，语气友好专业。
5. 描述里没有的信息不要编造（如需外部数据可用 api_call 占位）。
PROMPT;

        try {
            $raw = $this->ai->chat($companyId, [
                ['role' => 'system', 'content' => $system],
                ['role' => 'user', 'content' => $data['description']],
            ], maxTokens: 3000, temperature: 0.3);
        } catch (Throwable $e) {
            return response()->json(['message' => $e->getMessage()], 502);
        }

        // The model may wrap JSON in ```json fences — strip anything non-JSON.
        if (! preg_match('/\{.*\}/s', $raw, $m)) {
            return response()->json(['message' => 'AI 返回的内容无法解析为流程。'], 502);
        }

        $flow = json_decode($m[0], true);
        $error = json_last_error();

        if ($error !== JSON_ERROR_NONE || ! isset($flow['flow_graph']['nodes'])) {
            Log::warning('AI flow generation produced invalid JSON', ['company_id' => $companyId]);
            return response()->json(['message' => 'AI 返回的流程结构不完整，请重试或换个描述。'], 502);
        }

        // Sanitize: enforce known node types and required shape
        $allowed = ['send_message', 'collect_input', 'condition', 'set_variable', 'api_call', 'handoff', 'end'];
        $nodes   = collect($flow['flow_graph']['nodes'] ?? [])
            ->filter(fn ($n) => is_array($n) && in_array($n['type'] ?? '', $allowed, true) && isset($n['id']))
            ->map(fn ($n) => ['id' => (string) $n['id'], 'type' => $n['type'], 'data' => is_array($n['data'] ?? null) ? $n['data'] : []])
            ->values();
        $nodeIds = $nodes->pluck('id')->all();

        $edges = collect($flow['flow_graph']['edges'] ?? [])
            ->filter(fn ($e) => in_array($e['source'] ?? '', $nodeIds, true) && in_array($e['target'] ?? '', $nodeIds, true))
            ->map(fn ($e) => array_filter([
                'source' => $e['source'],
                'target' => $e['target'],
                'label'  => isset($e['label']) ? (string) $e['label'] : null,
            ]))
            ->values();

        $result = [
            'name'           => $data['name'] ?? ($flow['name'] ?? 'AI 生成的流程'),
            'trigger_type'   => in_array($flow['trigger_type'] ?? '', ['keyword', 'any_message', 'intent', 'event'], true)
                ? $flow['trigger_type'] : 'keyword',
            'trigger_config' => is_array($flow['trigger_config'] ?? null) ? $flow['trigger_config'] : ['keywords' => []],
            'flow_graph'     => ['nodes' => $nodes, 'edges' => $edges],
        ];

        return response()->json(['data' => $result]);
    }
}
