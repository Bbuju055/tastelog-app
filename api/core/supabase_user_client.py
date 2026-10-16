"""
Tastelog: User-scoped Supabase client factory.

Creates request-specific clients that respect RLS via user JWT.
NOT cached — each request gets its own client with the user's token.
"""

from supabase import Client, create_client, ClientOptions

from api.core.config import get_settings


def get_user_supabase_client(access_token: str) -> Client:
    """Create a user-scoped Supabase client for RLS-enforced operations.

    Uses anon key + user JWT so auth.uid() resolves correctly in RLS policies.
    Do NOT cache globally — token is request-specific.
    """
    settings = get_settings()
    settings.require_supabase()

    if not settings.supabase_anon_key:
        raise RuntimeError("SUPABASE_ANON_KEY is not configured.")

    return create_client(
        str(settings.supabase_url),
        settings.supabase_anon_key,
        options=ClientOptions(headers={"Authorization": f"Bearer {access_token}"}),
    )
