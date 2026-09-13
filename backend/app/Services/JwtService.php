<?php

namespace App\Services;

use RuntimeException;

/**
 * Minimal HS256 JWT implementation — dipakai khusus untuk Socket.io auth.
 * REST API tetap menggunakan Laravel Sanctum token.
 *
 * Payload format (sesuai phase4a_realtime_server_spec.md):
 *   sub          : agent UUID
 *   company_id   : company UUID
 *   role         : agent | supervisor | admin
 *   skill_tags   : string[]
 *   iat / exp    : Unix timestamps
 */
class JwtService
{
    private string $secret;
    private int    $ttlSeconds;

    public function __construct()
    {
        $this->secret     = config('app.jwt_secret');
        $this->ttlSeconds = (int) config('app.jwt_ttl_hours', 24) * 3600;
    }

    public function encode(array $payload): string
    {
        $header = $this->b64url(json_encode(['typ' => 'JWT', 'alg' => 'HS256']));

        $payload['iat'] = time();
        $payload['exp'] = time() + $this->ttlSeconds;
        $body = $this->b64url(json_encode($payload));

        $sig = $this->b64url(
            hash_hmac('sha256', "{$header}.{$body}", $this->secret, binary: true)
        );

        return "{$header}.{$body}.{$sig}";
    }

    /**
     * @throws RuntimeException Jika signature tidak valid atau token expired
     */
    public function decode(string $token): array
    {
        $parts = explode('.', $token);
        if (count($parts) !== 3) {
            throw new RuntimeException('Malformed JWT');
        }

        [$header, $body, $sig] = $parts;

        $expected = $this->b64url(
            hash_hmac('sha256', "{$header}.{$body}", $this->secret, binary: true)
        );

        if (! hash_equals($expected, $sig)) {
            throw new RuntimeException('Invalid JWT signature');
        }

        $payload = json_decode($this->b64urlDecode($body), true);

        if (! is_array($payload)) {
            throw new RuntimeException('Invalid JWT payload');
        }

        if (($payload['exp'] ?? 0) < time()) {
            throw new RuntimeException('JWT expired');
        }

        return $payload;
    }

    // ── Private ───────────────────────────────────────────────────────────────

    private function b64url(string $data): string
    {
        return rtrim(strtr(base64_encode($data), '+/', '-_'), '=');
    }

    private function b64urlDecode(string $data): string
    {
        return base64_decode(strtr($data, '-_', '+/'));
    }
}
