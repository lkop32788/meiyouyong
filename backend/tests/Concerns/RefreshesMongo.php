<?php

namespace Tests\Concerns;

use App\Models\Message;

/**
 * RefreshDatabase only manages the SQL connection, so MongoDB documents leak
 * between tests. Opt in where a test exercises MessagePersistenceService.
 *
 * Skips the whole test when no MongoDB is reachable rather than failing — the
 * SQL-only suite should stay runnable without it.
 */
trait RefreshesMongo
{
    protected function setUpRefreshesMongo(): void
    {
        try {
            Message::truncate();
        } catch (\Throwable $e) {
            $this->markTestSkipped('MongoDB unavailable: ' . $e->getMessage());
        }
    }

    protected function tearDownRefreshesMongo(): void
    {
        try {
            Message::truncate();
        } catch (\Throwable) {
            // Nothing to clean up if it was never reachable.
        }
    }
}
