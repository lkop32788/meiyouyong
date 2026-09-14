<?php

namespace App\Http\Controllers\System;

use App\Http\Controllers\Controller;
use App\Models\Company;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

class SystemCompanyController extends Controller
{
    /** Platform-wide company list. */
    public function index(Request $request): JsonResponse
    {
        $query = Company::query()->orderByDesc('created_at');

        if ($request->query('search')) {
            $q = $request->query('search');
            $query->where(function ($sub) use ($q) {
                $sub->where('name', 'like', "%{$q}%")
                    ->orWhere('slug', 'like', "%{$q}%");
            });
        }

        $companies = $query->withCount('users')->paginate(20);

        return response()->json($companies);
    }

    /** Single company with user count. */
    public function show(string $id): JsonResponse
    {
        $company = Company::withCount('users')->findOrFail($id);

        return response()->json($company);
    }

    /** Create a new company. */
    public function store(Request $request): JsonResponse
    {
        $data = $request->validate([
            'name'     => 'required|string|max:120',
            'slug'     => 'required|string|max:60|alpha_num|unique:companies,slug',
            'timezone' => 'nullable|string|max:60',
            'locale'   => 'nullable|string|max:10',
            'is_active' => 'nullable|boolean',
        ]);

        $company = Company::create($data + ['is_active' => $data['is_active'] ?? true]);

        return response()->json($company, 201);
    }

    /** Update a company. */
    public function update(Request $request, string $id): JsonResponse
    {
        $company = Company::findOrFail($id);

        $data = $request->validate([
            'name'      => 'sometimes|string|max:120',
            'slug'      => 'sometimes|string|max:60|alpha_num|unique:companies,slug,' . $id,
            'timezone'  => 'nullable|string|max:60',
            'locale'    => 'nullable|string|max:10',
            'is_active' => 'nullable|boolean',
            'plan'      => 'nullable|string|max:40',
        ]);

        $company->update($data);

        return response()->json($company);
    }

    /** Soft-delete a company. */
    public function destroy(string $id): JsonResponse
    {
        Company::findOrFail($id)->delete();

        return response()->json(['message' => 'deleted']);
    }

    /** Platform statistics. */
    public function stats(): JsonResponse
    {
        return response()->json([
            'total_companies'    => Company::count(),
            'active_companies'   => Company::where('is_active', true)->count(),
            'total_users'        => DB::table('users')->count(),
            'total_conversations' => DB::table('conversations')->count(),
            'total_channels'    => DB::table('channels')->count(),
        ]);
    }
}
