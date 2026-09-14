<?php

use App\Http\Controllers\System\SystemCompanyController;
use App\Http\Controllers\System\SystemUserController;
use Illuminate\Support\Facades\Route;

/*
|--------------------------------------------------------------------------
| System Admin Routes  (super_admin only — middleware applied in bootstrap/app.php)
|--------------------------------------------------------------------------
*/

Route::get('/', fn () => response()->json(['message' => 'System API']));

Route::get('/companies',        [SystemCompanyController::class, 'index']);
Route::post('/companies',       [SystemCompanyController::class, 'store']);
Route::get('/companies/{id}',   [SystemCompanyController::class, 'show']);
Route::put('/companies/{id}',  [SystemCompanyController::class, 'update']);
Route::delete('/companies/{id}', [SystemCompanyController::class, 'destroy']);

Route::get('/users',            [SystemUserController::class, 'index']);
Route::post('/users',           [SystemUserController::class, 'store']);
Route::get('/users/{id}',       [SystemUserController::class, 'show']);
Route::put('/users/{id}',       [SystemUserController::class, 'update']);
Route::delete('/users/{id}',    [SystemUserController::class, 'destroy']);

Route::get('/stats', [SystemCompanyController::class, 'stats']);
