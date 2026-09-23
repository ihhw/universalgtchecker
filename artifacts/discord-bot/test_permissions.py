"""Unit tests for the role/permission gate added to the Discord bot.

These test only the pure functions (no live gateway connection, no real
Discord objects) — has_required_role_ids and member_role_ids never touch
the network, so they can be verified honestly in this sandbox, unlike the
bot's actual command handling which needs a real Discord connection.
"""
import os

os.environ.setdefault("DISCORD_BOT_TOKEN", "test-token-not-real")

from bot import has_required_role, has_required_role_ids, member_role_ids  # noqa: E402


def test_no_required_role_means_unrestricted():
    assert has_required_role_ids([], required_role_id=0) is True
    assert has_required_role_ids([1, 2, 3], required_role_id=0) is True


def test_required_role_present_grants_access():
    assert has_required_role_ids([111, 222, 333], required_role_id=222) is True


def test_required_role_absent_denies_access():
    assert has_required_role_ids([111, 333], required_role_id=222) is False
    assert has_required_role_ids([], required_role_id=222) is False


class _FakeRole:
    def __init__(self, role_id: int) -> None:
        self.id = role_id


class _FakeMember:
    """Stands in for discord.Member: has a .roles list of role-like objects."""
    def __init__(self, role_ids: list[int]) -> None:
        self.roles = [_FakeRole(r) for r in role_ids]


class _FakeUser:
    """Stands in for discord.User (e.g. in a DM): no .roles attribute at all."""


def test_member_role_ids_reads_real_role_objects():
    member = _FakeMember([10, 20, 30])
    assert member_role_ids(member) == [10, 20, 30]


def test_member_role_ids_handles_a_plain_user_with_no_roles_attribute():
    assert member_role_ids(_FakeUser()) == []


def test_has_required_role_wires_member_role_ids_through_when_unrestricted():
    # REQUIRED_ROLE_ID is read once at import time from an unset env var in
    # this test process, so has_required_role() is unrestricted here; the
    # restricted path is already covered directly via has_required_role_ids.
    assert has_required_role(_FakeMember([555, 999])) is True
    assert has_required_role(_FakeMember([])) is True
    assert has_required_role(_FakeUser()) is True
