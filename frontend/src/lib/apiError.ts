interface LaravelErrorBody {
  message?: string;
  errors?: Record<string, string[]>;
}

/**
 * Pull the most useful message out of an axios error.
 *
 * Laravel returns field errors under `errors` for 422 and a bare `message` for
 * 403/404/500, so prefer the first field error and fall back from there.
 */
export function extractApiError(error: unknown, fallback: string): string {
  const body = (error as { response?: { data?: LaravelErrorBody } })?.response?.data;

  const firstFieldError = body?.errors ? Object.values(body.errors)[0]?.[0] : undefined;

  return firstFieldError ?? body?.message ?? fallback;
}
