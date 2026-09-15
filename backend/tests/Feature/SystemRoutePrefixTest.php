<?php

namespace Tests\Feature;

use PHPUnit\Framework\Attributes\DataProvider;
use Tests\TestCase;

/**
 * The /system admin module was registered under a bare `system` prefix while
 * the SPA has a single axios instance with baseURL '/api' — so every call went
 * to /api/system/* and 404'd, and nginx only proxies /api/ anyway.
 *
 * 401 (not 404) is the assertion that matters here: it proves the route exists
 * and the auth middleware ran. No database needed.
 */
class SystemRoutePrefixTest extends TestCase
{
    public static function systemEndpoints(): array
    {
        return [
            'stats'     => ['/api/system/stats'],
            'users'     => ['/api/system/users'],
            'companies' => ['/api/system/companies'],
        ];
    }

    #[DataProvider('systemEndpoints')]
    public function test_system_endpoints_are_reachable_under_the_api_prefix(string $uri): void
    {
        $this->getJson($uri)->assertUnauthorized();
    }

    #[DataProvider('systemEndpoints')]
    public function test_system_endpoints_render_json_not_html(string $uri): void
    {
        // Living under api/* also brings these into shouldRenderJsonWhen(),
        // so framework errors stop rendering as HTML error pages.
        $this->getJson($uri)->assertHeader('content-type', 'application/json');
    }

    public function test_the_old_bare_system_prefix_is_gone(): void
    {
        $this->getJson('/system/stats')->assertNotFound();
    }
}
