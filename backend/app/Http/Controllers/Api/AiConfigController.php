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
 * POST  /api/ai/append-nodes      → append an AI-designed segment to an existing graph
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
            'provider' => 'required|in:openai,deepseek,xai,gemini,anthropic,nvidia,custom',
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
     * Reasoning models (Nemotron, DeepSeek-R1 style) may emit <think> traces
     * or reasoning text around the JSON. Extract the last balanced JSON object
     * so stray braces in thinking text can't break parsing.
     */
    public static function extractJsonObject(string $raw): ?array
    {
        // Strip <think>…</think> blocks if present
        $text = preg_replace('/<think>.*?<\/think>/is', '', $raw) ?? $raw;

        // Fast path: whole payload is JSON
        $direct = json_decode(trim($text), true);
        if (json_last_error() === JSON_ERROR_NONE && is_array($direct)) {
            return $direct;
        }

        // Scan for balanced {…} segments (string-aware), keep the LAST parseable one
        $candidates = [];
        $depth = 0;
        $start = -1;
        $inStr = false;
        $esc = false;
        $len = mb_strlen($text);
        for ($i = 0; $i < $len; $i++) {
            $ch = mb_substr($text, $i, 1);
            if ($inStr) {
                if ($esc) { $esc = false; }
                elseif ($ch === '\\') { $esc = true; }
                elseif ($ch === '"') { $inStr = false; }
                continue;
            }
            if ($ch === '"') { $inStr = true; continue; }
            if ($ch === '{') { if ($depth === 0) { $start = $i; } $depth++; }
            elseif ($ch === '}' && $depth > 0) {
                $depth--;
                if ($depth === 0 && $start >= 0) {
                    $candidates[] = mb_substr($text, $start, $i - $start + 1);
                    $start = -1;
                }
            }
        }

        for ($i = count($candidates) - 1; $i >= 0; $i--) {
            $obj = json_decode($candidates[$i], true);
            if (json_last_error() === JSON_ERROR_NONE && is_array($obj)) {
                return $obj;
            }
        }

        return null;
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

        // Reasoning models wrap output in thinking text — extract the JSON object
        $flow = self::extractJsonObject($raw);

        if ($flow === null || ! isset($flow['flow_graph']['nodes'])) {
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

    /**
     * POST /api/ai/append-nodes  { nodes: FlowNode[], target?: string, instruction?: string }
     *
     * Given the CURRENT flow graph nodes (context) and an optional target node
     * to splice after, asks the AI to design the NEXT segment and returns
     * { nodes, edges } ready to merge into the editor's local state.
     * The caller keeps ownership of saving.
     */
    public function appendNodes(Request $request): JsonResponse
    {
        $data = $request->validate([
            'nodes'        => 'required|array|min:1|max:100',
            'nodes.*.id'   => 'required|string|max:60',
            'nodes.*.type' => 'required|string|max:40',
            'nodes.*.data' => 'nullable|array',
            'target'       => 'nullable|string|max:60',
            'instruction'  => 'nullable|string|max:1000',
        ]);

        $companyId = $request->user()->company_id;
        $allowed   = ['send_message', 'collect_input', 'condition', 'set_variable', 'api_call', 'handoff', 'end'];

        // Existing-node digest for context (id, type, short text — no payload bloat)
        $digest = collect($data['nodes'])
            ->map(fn ($n) => sprintf(
                '- id=%s type=%s %s',
                $n['id'],
                $n['type'],
                isset($n['data']['text']) ? 'text="' . mb_substr((string) $n['data']['text'], 0, 40) . '"' : ''
            ))
            ->implode("\n");

        $target = collect($data['nodes'])->firstWhere('id', $data['target'] ?? null);
        $targetLine = $target
            ? "接入点节点：id={$target['id']} type={$target['type']}（新节点必须接在它之后）"
            : '没有指定接入点：新节点应接在流程末尾。';

        $system = <<<'PROMPT'
你是客服机器人流程设计师。用户已有一个流程，现在要【追加】一段新节点。

严格只输出一个 JSON 对象（不要 markdown、不要解释）：
{
  "nodes": [ { "id": "n1", "type": "send_message", "data": { "text": "..." } } ],
  "entry_label": ""
}

节点类型只能是：send_message, collect_input, condition, set_variable, api_call, handoff, end。
规则：
1. 生成 2-5 个新节点，内部连线自然连贯；若流程该收尾就以 end 节点结束，否则可留待继续追加。
2. 新节点 id 用 n1、n2…（系统会重写 id，不要复用已有节点 id）。
3. 只生成【新增】部分，不要重复已有节点。
4. 所有文案简体中文，语气友好专业。
5. 按用户追加需求设计，没提的信息不要编造。
6. entry_label 仅当接入点是 condition 节点时填 "true" 或 "false"，否则留空字符串。
PROMPT;

        try {
            $raw = $this->ai->chat($companyId, [
                ['role' => 'system', 'content' => $system],
                ['role' => 'user', 'content' => "现有流程节点：\n{$digest}\n\n{$targetLine}\n\n追加需求：" . ($data['instruction'] ?? '按常理补全后续流程')],
            ], maxTokens: 1500, temperature: 0.3);
        } catch (Throwable $e) {
            return response()->json(['message' => $e->getMessage()], 502);
        }

        $gen = self::extractJsonObject($raw);
        if ($gen === null || ! isset($gen['nodes']) || ! is_array($gen['nodes'])) {
            Log::warning('AI append-nodes produced invalid JSON', ['company_id' => $companyId]);
            return response()->json(['message' => 'AI 返回的节点结构不完整，请重试。'], 502);
        }

        // Sanitize + rewrite ids to unique ai-<ts>-<i> so they can't clash
        $ts    = time();
        $nodes = collect($gen['nodes'])
            ->filter(fn ($n) => is_array($n) && in_array($n['type'] ?? '', $allowed, true) && isset($n['id']))
            ->values()
            ->map(fn ($n, $i) => [
                'id'   => "ai-{$ts}-{$i}",
                'type' => $n['type'],
                'data' => is_array($n['data'] ?? null) ? $n['data'] : [],
            ])
            ->all();

        if (count($nodes) < 1) {
            return response()->json(['message' => 'AI 没有生成有效节点，请换个说法。'], 502);
        }

        // Chain generated nodes in sequence internally
        $edges = [];
        for ($i = 0; $i < count($nodes) - 1; $i++) {
            $edges[] = ['source' => $nodes[$i]['id'], 'target' => $nodes[$i + 1]['id']];
        }

        // If the splice point is a condition node, the entry edge gets a branch label
        $entryLabel = null;
        if ($target && $target['type'] === 'condition' && in_array($gen['entry_label'] ?? '', ['true', 'false'], true)) {
            $entryLabel = $gen['entry_label'];
        }

        return response()->json(['data' => [
            'nodes'       => $nodes,
            'edges'       => $edges,
            'entry_label' => $entryLabel,
        ]]);
    }
}
