<?php

namespace Tests\Feature;

use App\Models\Company;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

/**
 * routes/api.php wraps every management route in the company.manager
 * middleware. An agent-role Sanctum token must get 403 on all of them —
 * the frontend hiding those pages is not a security boundary — while the
 * endpoints an agent genuinely needs (conversations, quick replies) stay open.
 */
class ManagerRoleGateTest extends TestCase
{
    use RefreshDatabase;

    /** Representative endpoint per management controller. */
    private const MANAGEMENT_ENDPOINTS = [
        ['GET',  '/api/contacts'],
        ['GET',  '/api/contacts/export'],
        ['POST', '/api/agents'],
        ['GET',  '/api/agent-channels'],
        ['GET',  '/api/channels'],
        ['POST', '/api/channels'],
        ['GET',  '/api/bot-flows'],
        ['GET',  '/api/campaigns'],
        ['POST', '/api/campaigns'],
        ['GET',  '/api/templates'],
        ['GET',  '/api/meta-apps'],
        ['GET',  '/api/voice/agents'],
        ['GET',  '/api/ai-config'],
        ['PUT',  '/api/ai-config'],
        ['GET',  '/api/analytics/overview'],
        ['GET',  '/api/analytics/export/00000000-0000-0000-0000-000000000000/status'],
    ];

    public function test_agent_gets_403_on_every_management_endpoint(): void
    {
        $company = Company::factory()->create();
        Sanctum::actingAs(User::factory()->for($company)->agent()->create(), ['*']);

        foreach (self::MANAGEMENT_ENDPOINTS as [$method, $uri]) {
            $status = $this->json($method, $uri)->getStatusCode();

            $this->assertSame(403, $status, "Expected 403 for {$method} {$uri}, got {$status}");
        }
    }

    public function test_agent_still_reaches_conversations_and_quick_replies(): void
    {
        $company = Company::factory()->create();
        Sanctum::actingAs(User::factory()->for($company)->agent()->create(), ['*']);

        $this->getJson('/api/conversations')->assertOk();
        $this->getJson('/api/quick-replies')->assertOk();
        // Read-only members list stays open (presence / teammates), writes don't.
        $this->getJson('/api/agents')->assertOk();
    }

    public function test_supervisor_passes_the_manager_gate(): void
    {
        $company = Company::factory()->create();
        Sanctum::actingAs(User::factory()->for($company)->supervisor()->create(), ['*']);

        $this->getJson('/api/channels')->assertOk();
        $this->getJson('/api/meta-apps')->assertOk();
        $this->getJson('/api/ai-config')->assertOk();
        $this->getJson('/api/contacts')->assertOk();
        $this->getJson('/api/bot-flows')->assertOk();
    }

    public function test_admin_and_super_admin_pass_the_manager_gate(): void
    {
        $company = Company::factory()->create();

        Sanctum::actingAs(User::factory()->for($company)->admin()->create(), ['*']);
        $this->getJson('/api/channels')->assertOk();

        Sanctum::actingAs(User::factory()->for($company)->create(['role' => 'super_admin']), ['*']);
        $this->getJson('/api/channels')->assertOk();
    }
}
