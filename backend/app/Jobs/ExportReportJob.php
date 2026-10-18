<?php

namespace App\Jobs;

use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Storage;

class ExportReportJob implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable;

    public int $timeout = 300;

    public function __construct(
        private readonly string $companyId,
        private readonly string $type,
        private readonly ?string $from,
        private readonly ?string $to,
        private readonly string $jobId,
    ) {}

    public function handle(): void
    {
        // Key menyertakan company_id — status endpoint membaca dengan company
        // milik user yang login, jadi jobId company lain tidak bisa di-probe.
        $prefix = "export:{$this->companyId}:{$this->jobId}";

        Cache::put("{$prefix}:status", 'running', now()->addHour());

        try {
            $rows = match ($this->type) {
                'conversations' => $this->queryConversations(),
                'agents'        => $this->queryAgents(),
                default         => collect(),
            };

            $csv  = $this->toCsv($rows);
            $path = "exports/{$this->jobId}.csv";
            Storage::put($path, $csv);

            Cache::put("{$prefix}:status", 'completed', now()->addHour());
            Cache::put("{$prefix}:path", $path, now()->addHour());
        } catch (\Throwable $e) {
            Cache::put("{$prefix}:status", 'failed', now()->addHour());
        }
    }

    private function queryConversations(): \Illuminate\Support\Collection
    {
        return DB::table('analytics_conversation_facts')
            ->where('company_id', $this->companyId)
            ->when($this->from && $this->to, fn ($q) =>
                $q->whereBetween('resolved_date', [$this->from, $this->to])
            )
            ->get();
    }

    private function queryAgents(): \Illuminate\Support\Collection
    {
        return DB::table('analytics_agent_daily')
            ->where('company_id', $this->companyId)
            ->when($this->from && $this->to, fn ($q) =>
                $q->whereBetween('date_bucket', [$this->from, $this->to])
            )
            ->get();
    }

    private function toCsv(\Illuminate\Support\Collection $rows): string
    {
        if ($rows->isEmpty()) {
            return '';
        }

        $headers = array_keys((array) $rows->first());
        $lines   = [implode(',', $headers)];

        foreach ($rows as $row) {
            $lines[] = implode(',', array_map(
                fn ($v) => '"' . str_replace('"', '""', (string) ($v ?? '')) . '"',
                (array) $row
            ));
        }

        return implode("\n", $lines);
    }
}
