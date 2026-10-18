<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * Gate untuk route manajemen (channel, credential, broadcast, analytics, …).
 *
 * Frontend hanya menampilkan halaman-halaman ini untuk supervisor+, tapi UI
 * bukan security boundary — token Sanctum milik role agent tetap bisa memanggil
 * API langsung. Middleware ini yang menegakkannya di server.
 */
class EnsureCanManageCompany
{
    public function handle(Request $request, Closure $next): Response
    {
        $user = $request->user();

        if (! $user || ! $user->canOverrideAssignment()) {
            return response()->json(['message' => 'Forbidden. Manager role required.'], 403);
        }

        return $next($request);
    }
}
