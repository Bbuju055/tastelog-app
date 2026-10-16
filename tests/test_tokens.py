"""Tests for capture token lifecycle — provisioning and revocation."""

from unittest.mock import MagicMock, patch
from uuid import UUID

import pytest
from fastapi.testclient import TestClient

from api.main import create_app
from api.dependencies import get_current_user_id, get_user_db

FAKE_USER_ID = UUID("00000000-0000-0000-0000-000000000001")


class FakeQueryResult:
    """Minimal mock for Supabase query results."""

    def __init__(self, data):
        self.data = data


class FakeTableBuilder:
    """In-memory mock for Supabase table operations on capture_tokens."""

    def __init__(self):
        self.rows: list[dict] = []
        self._filters: dict = {}
        self._select_cols: str | None = None
        self._is_maybe_single: bool = False

    def select(self, cols: str = "*"):
        self._select_cols = cols
        self._filters = {}
        self._is_maybe_single = False
        return self

    def insert(self, row: dict):
        import uuid as _uuid
        from datetime import datetime, timezone

        row.setdefault("id", str(_uuid.uuid4()))
        row.setdefault("scope", "capture")
        row.setdefault("created_at", datetime.now(timezone.utc).isoformat())
        row.setdefault("expires_at", None)
        row.setdefault("revoked_at", None)
        row.setdefault("last_used_at", None)
        self.rows.append(row)
        return self

    def update(self, updates: dict):
        self._updates = updates
        self._filters = {}
        return self

    def eq(self, col: str, val):
        self._filters[col] = val
        return self

    def order(self, col: str, desc: bool = False):
        return self

    def maybe_single(self):
        self._is_maybe_single = True
        return self

    def execute(self):
        if hasattr(self, "_updates"):
            updates = self._updates
            del self._updates
            for row in self.rows:
                if all(str(row.get(k)) == str(v) for k, v in self._filters.items()):
                    row.update(updates)
            self._filters = {}
            return FakeQueryResult(None)

        matched = [
            r
            for r in self.rows
            if all(str(r.get(k)) == str(v) for k, v in self._filters.items())
        ]
        is_single = self._is_maybe_single
        self._filters = {}
        self._is_maybe_single = False

        if is_single:
            # maybe_single: return dict or None
            return FakeQueryResult(matched[0] if matched else None)

        # Regular query: return list
        return FakeQueryResult(matched if matched else [])


class FakeDB:
    """Minimal Supabase client mock that routes .table() calls."""

    def __init__(self):
        self._tables: dict[str, FakeTableBuilder] = {}

    def table(self, name: str):
        if name not in self._tables:
            self._tables[name] = FakeTableBuilder()
        return self._tables[name]


@pytest.fixture()
def token_client(app):
    """Test client with auth + db overrides for token route tests."""
    fake_db = FakeDB()

    app.dependency_overrides[get_current_user_id] = lambda: FAKE_USER_ID
    app.dependency_overrides[get_user_db] = lambda: fake_db
    try:
        with TestClient(app) as c:
            yield c, fake_db
    finally:
        app.dependency_overrides.pop(get_current_user_id, None)
        app.dependency_overrides.pop(get_user_db, None)


@pytest.fixture()
def app():
    return create_app()


# ---------------------------------------------------------------------------
# Provisioning
# ---------------------------------------------------------------------------


class TestTokenProvisioning:
    """POST /api/tokens — create or rotate."""

    def test_creates_new_token(self, token_client):
        client, fake_db = token_client
        res = client.post("/api/tokens", json={"name": "Mobile (auto)"})

        assert res.status_code == 201
        body = res.json()
        assert body["name"] == "Mobile (auto)"
        assert body["scope"] == "capture"
        assert "token" in body
        assert body["token"].startswith("tl_cap_")
        assert body.get("revoked_at") is None

    def test_rotates_existing_token(self, token_client):
        client, fake_db = token_client

        # First provisioning
        res1 = client.post("/api/tokens", json={"name": "Mobile (auto)"})
        assert res1.status_code == 201
        token1 = res1.json()["token"]

        # Second provisioning — same name → rotation
        res2 = client.post("/api/tokens", json={"name": "Mobile (auto)"})
        assert res2.status_code == 201
        token2 = res2.json()["token"]

        # New plaintext returned, different from first
        assert token2.startswith("tl_cap_")
        assert token1 != token2

    def test_rotation_clears_revoked_at(self, token_client):
        client, fake_db = token_client

        # Create token
        res1 = client.post("/api/tokens", json={"name": "Mobile (auto)"})
        assert res1.status_code == 201
        token_id = res1.json()["id"]

        # Revoke it
        res_revoke = client.delete(f"/api/tokens/{token_id}")
        assert res_revoke.status_code == 204

        # Verify revoked
        table = fake_db.table("capture_tokens")
        revoked_row = next(r for r in table.rows if r["id"] == token_id)
        assert revoked_row["revoked_at"] is not None

        # Re-provision with same name → should rotate and clear revoked_at
        res2 = client.post("/api/tokens", json={"name": "Mobile (auto)"})
        assert res2.status_code == 201
        assert res2.json()["token"].startswith("tl_cap_")

        # The row should now have revoked_at = None
        row_after = next(r for r in table.rows if r["id"] == token_id)
        assert row_after["revoked_at"] is None

    def test_singleton_invariant(self, token_client):
        """Only one row per (user_id, name) regardless of how many provisions."""
        client, fake_db = token_client

        client.post("/api/tokens", json={"name": "Mobile (auto)"})
        client.post("/api/tokens", json={"name": "Mobile (auto)"})
        client.post("/api/tokens", json={"name": "Mobile (auto)"})

        table = fake_db.table("capture_tokens")
        auto_rows = [r for r in table.rows if r["name"] == "Mobile (auto)"]
        assert len(auto_rows) == 1


# ---------------------------------------------------------------------------
# Revocation
# ---------------------------------------------------------------------------


class TestTokenRevocation:
    """DELETE /api/tokens/{id} — soft-delete."""

    def test_revoke_sets_revoked_at(self, token_client):
        client, fake_db = token_client

        res = client.post("/api/tokens", json={"name": "test"})
        token_id = res.json()["id"]

        res_revoke = client.delete(f"/api/tokens/{token_id}")
        assert res_revoke.status_code == 204

        table = fake_db.table("capture_tokens")
        row = next(r for r in table.rows if r["id"] == token_id)
        assert row["revoked_at"] is not None

    def test_revoke_is_idempotent(self, token_client):
        client, fake_db = token_client

        res = client.post("/api/tokens", json={"name": "test"})
        token_id = res.json()["id"]

        res1 = client.delete(f"/api/tokens/{token_id}")
        assert res1.status_code == 204

        res2 = client.delete(f"/api/tokens/{token_id}")
        assert res2.status_code == 204

    def test_revoke_nonexistent_returns_404(self, token_client):
        client, _ = token_client

        res = client.delete("/api/tokens/00000000-0000-0000-0000-000000000099")
        assert res.status_code == 404
