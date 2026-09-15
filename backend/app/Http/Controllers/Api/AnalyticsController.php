<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

class AnalyticsController extends Controller
{
    public function overview(Request $request): JsonResponse
    {
        $companyId = $request->user()->company_id;
        $from      = $request->input('date_from', now()->subDays(7)->toDateString());
        $to        = $request->input('date_to', now()->toDateString());

        $row = DB::table('analytics_conversation_facts')
            ->where('company_id', $companyId)
            ->whereBetween('resolved_date', [$from, $to])
            ->selectRaw("
                COUNT(*)                                         AS total_conversations,
                AVG(CAST(first_response_seconds AS FLOAT))       AS avg_first_response,
                AVG(CAST(resolution_seconds AS FLOAT))           AS avg_resolution,
                SUM(CASE WHEN met_first_response_sla = 1 THEN 1 ELSE 0 END) * 100.0
                    / NULLIF(COUNT(*), 0)                        AS sla_compliance_pct,
                AVG(CAST(csat_score AS FLOAT))                   AS csat_avg,
                SUM(CASE WHEN was_bot_handled = 1 THEN 1 ELSE 0 END) * 100.0
                    / NULLIF(COUNT(*), 0)                        AS bot_containment_pct
            ")
            ->first();

        return response()->json($row);
    }

    public function volumeTrend(Request $request): JsonResponse
    {
        $companyId = $request->user()->company_id;
        $from      = $request->input('date_from', now()->subDays(7)->toDateString());
        $to        = $request->input('date_to', now()->toDateString());

        $rows = DB::table('analytics_conversation_facts')
            ->where('company_id', $companyId)
            ->whereBetween('resolved_date', [$from, $to])
            ->selectRaw("
                resolved_date                                             AS date,
                COUNT(*)                                                  AS total,
                AVG(first_response_seconds)                               AS avg_first_response,
                SUM(CASE WHEN met_first_response_sla = 1 THEN 1 ELSE 0 END) AS met_sla_count
            ")
            ->groupBy('resolved_date')
            ->orderBy('resolved_date')
            ->get();

        return response()->json($rows);
    }

    public function channelBreakdown(Request $request): JsonResponse
    {
        $companyId = $request->user()->company_id;
        $from      = $request->input('date_from', now()->subDays(7)->toDateString());
        $to        = $request->input('date_to', now()->toDateString());

        $rows = DB::table('analytics_conversation_facts')
            ->where('company_id', $companyId)
            ->whereBetween('resolved_date', [$from, $to])
            ->selectRaw("
                channel_type,
                COUNT(*)                   AS total,
                AVG(first_response_seconds) AS avg_first_response,
                SUM(CASE WHEN met_first_response_sla = 1 THEN 1 ELSE 0 END)
                    * 100.0 / NULLIF(COUNT(*), 0) AS sla_pct
            ")
            ->groupBy('channel_type')
            ->get();

        return response()->json($rows);
    }

    public function agentPerformance(Request $request): JsonResponse
    {
        $companyId = $request->user()->company_id;
        $date      = $request->input('date', now()->subDay()->toDateString());
        $sortBy    = $request->input('sort_by', 'conversations');

        $orderCol = match ($sortBy) {
            'csat'          => 'ad.avg_csat_score',
            'response_time' => 'ad.avg_first_response_seconds',
            default         => 'ad.conversations_handled',
        };

        $rows = DB::table('analytics_agent_daily as ad')
            ->join('users as u', 'u.id', '=', 'ad.agent_id')
            ->where('ad.company_id', $companyId)
            ->where('ad.date_bucket', $date)
            ->select(
                'u.id as agent_id',
                'u.name',
                'ad.conversations_handled',
                'ad.avg_first_response_seconds',
                'ad.avg_resolution_seconds',
                'ad.avg_csat_score',
                'ad.online_seconds'
            )
            ->orderByDesc($orderCol)
            ->get();

        return response()->json($rows);
    }

    public function hourlyHeatmap(Request $request): JsonResponse
    {
        $companyId = $request->user()->company_id;
        $weeks     = (int) $request->input('weeks', 4);

        $rows = DB::table('analytics_hourly_volume')
            ->where('company_id', $companyId)
            ->where('hour_bucket', '>=', now()->subWeeks($weeks))
            // DAYOFWEEK() is 1=Sunday..7=Saturday; -1 gives the 0=Sunday..6=Saturday
            // index the frontend's ['周日'..'周六'] array is keyed by.
            ->selectRaw('
                DAYOFWEEK(hour_bucket) - 1 AS day_of_week,
                HOUR(hour_bucket)          AS hour_of_day,
                SUM(inbound_count)         AS volume
            ')
            // Group by the aliases, not the raw expressions: under
            // ONLY_FULL_GROUP_BY, `DAYOFWEEK(x) - 1` in SELECT does not match a
            // bare `DAYOFWEEK(x)` in GROUP BY and the query is rejected.
            ->groupByRaw('day_of_week, hour_of_day')
            ->orderByRaw('day_of_week, hour_of_day')
            ->get()
            // Cast: MySQL returns SUM() as a string, but the frontend types this
            // tuple as [number, number, number] and does arithmetic on it.
            ->map(fn ($r) => [(int) $r->day_of_week, (int) $r->hour_of_day, (int) $r->volume]);

        return response()->json($rows);
    }

    public function slaBreaches(Request $request): JsonResponse
    {
        $companyId = $request->user()->company_id;

        $rows = DB::table('conversations as c')
            ->join('sla_configs as sc', function ($join) {
                $join->on('sc.company_id', '=', 'c.company_id')
                     ->where(fn ($q) => $q->where('sc.channel_id', DB::raw('c.channel_id'))
                                          ->orWhereNull('sc.channel_id'));
            })
            ->leftJoin('users as u', 'u.id', '=', 'c.assigned_agent_id')
            ->where('c.company_id', $companyId)
            ->whereIn('c.status', ['open', 'pending'])
            ->whereNull('c.first_response_at')
            ->whereRaw('TIMESTAMPDIFF(SECOND, c.created_at, UTC_TIMESTAMP()) > sc.first_response_seconds')
            ->select(
                'c.id as conversation_id',
                'c.last_message_preview',
                'c.created_at',
                DB::raw('TIMESTAMPDIFF(SECOND, c.created_at, UTC_TIMESTAMP()) AS age_seconds'),
                'sc.first_response_seconds AS threshold_seconds',
                'u.name as agent_name'
            )
            ->orderBy('c.created_at')
            ->limit(50)
            ->get();

        return response()->json($rows);
    }

    public function export(Request $request): JsonResponse
    {
        $type  = $request->input('type', 'conversations');
        $from  = $request->input('date_from');
        $to    = $request->input('date_to');

        // Dispatch async export job
        $jobId = \Illuminate\Support\Str::uuid()->toString();

        \App\Jobs\ExportReportJob::dispatch(
            $request->user()->company_id,
            $type,
            $from,
            $to,
            $jobId
        );

        return response()->json(['job_id' => $jobId]);
    }
}
