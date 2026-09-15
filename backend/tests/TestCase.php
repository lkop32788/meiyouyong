<?php

namespace Tests;

use App\Models\Company;
use App\Models\User;
use Illuminate\Foundation\Testing\TestCase as BaseTestCase;
use Illuminate\Support\Facades\Redis;
use Laravel\Sanctum\Sanctum;

abstract class TestCase extends BaseTestCase
{
    /** Presence hash the faked Redis returns; see fakePresence(). */
    protected array $presence = [];

    protected function setUp(): void
    {
        parent::setUp();

        $this->resetTenant();

        // AgentController reads presence out of Redis for every member payload;
        // phpunit.xml has no Redis override, so fake it by default.
        //
        // Mocked once and resolved lazily: re-mocking a facade that already
        // holds a Mockery instance makes Mockery try to mock the proxy class
        // and kills the PHP process outright.
        $this->presence = [];
        Redis::shouldReceive('hGetAll')->andReturnUsing(fn () => $this->presence);
    }

    /**
     * TenantScope resolves app('tenant.company_id') and does NOT take its
     * console early-return under tests, so the binding has to exist before any
     * tenant-scoped model (Channel, Conversation, Contact, ...) is touched
     * outside a request. Binding null makes the scope a no-op — apply() guards
     * on a falsy value.
     *
     * Call this again after an HTTP request: TenantMiddleware pins the binding
     * to the acting user's company and the container is rebuilt per test, not
     * per request, so it leaks into later assertions.
     */
    protected function resetTenant(): void
    {
        $this->app->instance('tenant.company_id', null);
    }

    /** Set the presence hash that every Redis::hGetAll call returns. */
    protected function fakePresence(array $presence = []): void
    {
        $this->presence = $presence;
    }

    /**
     * Authenticate as a new member of $company (created if omitted).
     *
     * @return array{0: User, 1: Company}
     */
    protected function actingAsRole(string $role, ?Company $company = null): array
    {
        $company ??= Company::factory()->create();

        $user = User::factory()->for($company)->create(['role' => $role]);

        Sanctum::actingAs($user, ['*']);

        return [$user, $company];
    }
}
