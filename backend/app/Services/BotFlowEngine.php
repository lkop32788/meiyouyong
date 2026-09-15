<?php

namespace App\Services;

use App\Jobs\ProcessBotTimeout;
use App\Models\BotFlow;
use App\Models\BotSession;
use App\Models\Conversation;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;

class BotFlowEngine
{
    public function __construct(
        private readonly OutboundMessageService $outbound,
        private readonly RealtimeEventPublisher $realtime,
    ) {}

    /**
     * 7-step algorithm: match flow → load/create session → execute node → handle result.
     */
    public function processMessage(string $conversationId, string $companyId, string $text): void
    {
        // Step 1 — Check for active session
        $session = BotSession::where('conversation_id', $conversationId)
            ->where('is_active', true)
            ->first();

        // Step 2 — If no session, try to match a bot flow
        if (! $session) {
            $flow = $this->matchFlow($companyId, $text);
            if (! $flow) {
                return; // No bot should handle this
            }

            $graph      = $flow->flow_graph;
            $startNode  = collect($graph['nodes'] ?? [])->firstWhere('type', 'start')
                ?? ($graph['nodes'][0] ?? null);

            if (! $startNode) {
                return;
            }

            $session = BotSession::create([
                'conversation_id'  => $conversationId,
                'company_id'       => $companyId,
                'bot_flow_id'      => $flow->id,
                'bot_flow_version' => $flow->version,
                'current_node_id'  => $startNode['id'],
                'variables'        => [],
                'retry_count'      => 0,
                'is_active'        => true,
                'waiting_for_input'=> null,
            ]);
        }

        // Step 3 — If waiting for input, store user reply and advance
        if ($session->waiting_for_input) {
            $nodeId = $session->waiting_for_input;
            $session->variables = array_merge($session->variables ?? [], [
                "__input_{$nodeId}" => $text,
            ]);
            $session->waiting_for_input = null;
            $session->save();
        }

        // Step 4 — Load current flow graph
        $flow  = BotFlow::find($session->bot_flow_id);
        if (! $flow) {
            $this->endSession($session);
            return;
        }

        // Step 5 — Execute node chain
        $conversation = Conversation::find($conversationId);
        $this->executeFrom($session, $flow, $conversation);
    }

    private function executeFrom(BotSession $session, BotFlow $flow, Conversation $conversation): void
    {
        $nodes   = collect($flow->flow_graph['nodes'] ?? []);
        $edges   = collect($flow->flow_graph['edges'] ?? []);
        $maxHops = 20; // Guard against infinite loops
        $hops    = 0;

        while ($hops++ < $maxHops) {
            $node = $nodes->firstWhere('id', $session->current_node_id);
            if (! $node) {
                $this->endSession($session);
                return;
            }

            $result = $this->executeNode($node, $session, $conversation);

            match ($result['action']) {
                'wait'     => $this->handleWait($session, $node),
                'advance'  => $this->advanceSession($session, $node, $edges, $result['edge_label'] ?? null),
                'handoff'  => $this->handleHandoff($session, $conversation, $node),
                'end'      => $this->endSession($session),
                default    => $this->endSession($session),
            };

            if (in_array($result['action'], ['wait', 'handoff', 'end'])) {
                return;
            }
        }

        // Exceeded max hops
        $this->endSession($session);
    }

    private function executeNode(array $node, BotSession $session, Conversation $conversation): array
    {
        return match ($node['type']) {
            'send_message' => $this->execSendMessage($node, $session, $conversation),
            'collect_input'=> $this->execCollectInput($node, $session),
            'condition'    => $this->execCondition($node, $session),
            'set_variable' => $this->execSetVariable($node, $session),
            'api_call'     => $this->execApiCall($node, $session),
            'handoff'      => ['action' => 'handoff'],
            'end'          => ['action' => 'end'],
            'jump'         => ['action' => 'advance', 'edge_label' => null],
            default        => ['action' => 'end'],
        };
    }

    private function execSendMessage(array $node, BotSession $session, Conversation $conv): array
    {
        $text = $this->interpolate($node['data']['text'] ?? '', $session->variables ?? []);

        // 'body', not 'text': that is the key every adapter and the preview
        // builder read. The old call also passed 2 args to a 6-arg signature.
        $this->outbound->sendSystemMessage($conv, 'text', ['body' => $text]);

        return ['action' => 'advance'];
    }

    private function execCollectInput(array $node, BotSession $session): array
    {
        $inputKey = "__input_{$node['id']}";

        if (isset(($session->variables ?? [])[$inputKey])) {
            // Input already collected — store to named variable and advance
            $varName = $node['data']['variable'] ?? 'input';
            $session->variables = array_merge($session->variables ?? [], [
                $varName => $session->variables[$inputKey],
            ]);
            $session->save();
            return ['action' => 'advance'];
        }

        return ['action' => 'wait'];
    }

    private function execCondition(array $node, BotSession $session): array
    {
        $variable = $node['data']['variable'] ?? '';
        $operator = $node['data']['operator'] ?? 'eq';
        $expected = $node['data']['value'] ?? '';
        $actual   = ($session->variables ?? [])[$variable] ?? '';

        $match = match ($operator) {
            'eq'       => $actual == $expected,
            'neq'      => $actual != $expected,
            'contains' => str_contains((string) $actual, (string) $expected),
            'gte'      => $actual >= $expected,
            'lte'      => $actual <= $expected,
            default    => false,
        };

        return ['action' => 'advance', 'edge_label' => $match ? 'true' : 'false'];
    }

    private function execSetVariable(array $node, BotSession $session): array
    {
        $key   = $node['data']['variable'] ?? '';
        $value = $this->interpolate($node['data']['value'] ?? '', $session->variables ?? []);

        if ($key) {
            $session->variables = array_merge($session->variables ?? [], [$key => $value]);
            $session->save();
        }

        return ['action' => 'advance'];
    }

    private function execApiCall(array $node, BotSession $session): array
    {
        try {
            $url     = $this->interpolate($node['data']['url'] ?? '', $session->variables ?? []);
            $method  = strtolower($node['data']['method'] ?? 'get');
            $headers = $node['data']['headers'] ?? [];
            $body    = $node['data']['body'] ?? [];

            $response = Http::withHeaders($headers)->{$method}($url, $body);
            $data     = $response->json() ?? [];

            // Map response fields to variables
            foreach ($node['data']['response_mapping'] ?? [] as $mapping) {
                $value = data_get($data, $mapping['path']);
                $session->variables = array_merge($session->variables ?? [], [
                    $mapping['variable'] => $value,
                ]);
            }
            $session->save();

            return ['action' => 'advance', 'edge_label' => $response->successful() ? 'success' : 'error'];
        } catch (\Throwable) {
            return ['action' => 'advance', 'edge_label' => 'error'];
        }
    }

    private function handleWait(BotSession $session, array $node): void
    {
        $session->waiting_for_input = $node['id'];
        $session->save();

        $timeoutSeconds = $node['data']['timeout_seconds'] ?? null;
        if ($timeoutSeconds) {
            ProcessBotTimeout::dispatch(
                $session->conversation_id,
                $session->bot_flow_version
            )->delay(now()->addSeconds($timeoutSeconds));
        }
    }

    private function advanceSession(BotSession $session, array $node, $edges, ?string $edgeLabel): void
    {
        $nextEdge = $edges->first(function ($e) use ($node, $edgeLabel) {
            return $e['source'] === $node['id']
                && (is_null($edgeLabel) || ($e['label'] ?? null) === $edgeLabel);
        });

        if (! $nextEdge) {
            $this->endSession($session);
            return;
        }

        $session->current_node_id = $nextEdge['target'];
        $session->save();
    }

    private function handleHandoff(BotSession $session, Conversation $conv, array $node): void
    {
        $summary = $node['data']['handoff_message'] ?? 'Bot handoff ke agen.';

        // Store handoff context in conversation custom_attributes
        $attrs = $conv->custom_attributes ?? [];
        $attrs['bot_handoff_summary']  = $summary;
        $attrs['bot_handoff_variables']= $session->variables ?? [];
        $conv->custom_attributes = $attrs;
        $conv->save();

        $this->endSession($session);

        // Publish event for dispatcher to pick up
        $this->realtime->publish($conv->company_id, 'BOT_HANDOFF', [
            'conversation_id' => $conv->id,
            'summary'         => $summary,
        ]);
    }

    private function endSession(BotSession $session): void
    {
        $session->is_active = false;
        $session->save();
    }

    private function matchFlow(string $companyId, string $text): ?BotFlow
    {
        $flows = BotFlow::where('company_id', $companyId)
            ->where('is_active', true)
            ->get();

        foreach ($flows as $flow) {
            $config = $flow->trigger_config ?? [];

            if ($flow->trigger_type === 'any_message') {
                return $flow;
            }

            if ($flow->trigger_type === 'keyword') {
                $keywords = $config['keywords'] ?? [];
                foreach ($keywords as $kw) {
                    if (stripos($text, $kw) !== false) {
                        return $flow;
                    }
                }
            }
        }

        return null;
    }

    private function interpolate(string $template, array $variables): string
    {
        foreach ($variables as $key => $value) {
            $template = str_replace("{{$key}}", (string) $value, $template);
        }
        return $template;
    }
}
