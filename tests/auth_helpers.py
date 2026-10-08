"""Shared helpers for the Python test-suite.

`proof()` builds the authentication proof that every decision now requires. The
operator entry points (CLI, console) obtain such a proof by verifying a signed
token or a session; the tests state it directly so the trajectory of a decision
stays readable.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

TEST_SECRET = "secret-de-test-1234"

AUTHENTICATED_AT = "2026-10-08T09:00:00+00:00"


def proof(actor_id: str, role: str, *, method: str = "cli-token", authenticated_at: str = AUTHENTICATED_AT) -> dict[str, Any]:
    """A well-formed proof for one actor and one role."""
    return {
        "actor_id": actor_id,
        "role": role,
        "method": method,
        "authenticated_at": authenticated_at,
        "realtime": False,
    }


def actor_token(
    root: str | Path,
    actor_id: str,
    role: str,
    *,
    secret: str = TEST_SECRET,
    created_by: str = "awa.mainteneur",
) -> str:
    """Create one local account in a temporary registry and return a bearer token."""
    from scripts.actor_registry import create_actor, issue_token, list_actors

    known = {actor["actor_id"] for actor in list_actors(root=root, include_revoked=True)}
    if actor_id not in known:
        create_actor(
            actor_id,
            display_name="Compte de test",
            role=role,
            secret=secret,
            created_by=created_by,
            root=root,
        )
    return str(issue_token(actor_id, secret, root=root)["token"])
