"""Discord control plane for the GTagHunter API."""

from __future__ import annotations

import asyncio
import json
import logging
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import aiohttp
import discord
from discord import app_commands
from discord.ext import commands


logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("gtaghunter.discord")

API_BASE = os.getenv("GAMERTAG_API_URL", "http://127.0.0.1:8080/api").rstrip("/")
TOKEN = os.getenv("DISCORD_BOT_TOKEN")
CHANNEL_ID = int(os.getenv("DISCORD_CHANNEL_ID", "0") or "0")
# Optional role gate for every bot command (prefix and slash alike). Unset
# (0) means unrestricted, matching CHANNEL_ID's own default-off behaviour.
REQUIRED_ROLE_ID = int(os.getenv("DISCORD_REQUIRED_ROLE_ID", "0") or "0")
# Remote-control presets. Each maps a short name to a generation config for the
# API, which validates it (Xbox gamertags are 3-15 characters and start with a
# letter). The full mode system is available in the web app.
PRESETS: dict[str, dict[str, Any]] = {
    "3L": {"mode": "letters", "params": {"minLength": 3, "maxLength": 3}},
    "4L": {"mode": "letters", "params": {"minLength": 4, "maxLength": 4}},
    "5L": {"mode": "letters", "params": {"minLength": 5, "maxLength": 5}},
    "3C": {"mode": "mixed", "params": {"minLength": 3, "maxLength": 3}},
    "4C": {"mode": "mixed", "params": {"minLength": 4, "maxLength": 4}},
    "5C": {"mode": "mixed", "params": {"minLength": 5, "maxLength": 5}},
    "COMMON": {
        "mode": "word_number",
        "params": {"minWordLength": 3, "maxWordLength": 5, "minDigits": 0, "maxDigits": 0},
    },
    "WORDS": {
        "mode": "word_number",
        "params": {"minWordLength": 4, "maxWordLength": 12, "minDigits": 0, "maxDigits": 0},
    },
}
FORMATS = set(PRESETS)
FORMAT_HELP = "3L, 4L, 5L, 3C, 4C, 5C, COMMON, or WORDS"
HEARTBEAT_SECONDS = 30
MAX_RATE = 1000
SEARCH_STATE_PATH = Path(__file__).with_name("search_state.json")


def has_required_role_ids(role_ids: "list[int] | frozenset[int]", required_role_id: int = REQUIRED_ROLE_ID) -> bool:
    """Pure permission check, kept free of any Discord object so it's unit-testable."""
    if not required_role_id:
        return True
    return required_role_id in set(role_ids)


def member_role_ids(user: "discord.abc.User | discord.Member") -> list[int]:
    """A plain discord.User (e.g. in a DM) has no .roles; treat that as no roles."""
    roles = getattr(user, "roles", None)
    return [role.id for role in roles] if roles else []


def has_required_role(user: "discord.abc.User | discord.Member") -> bool:
    return has_required_role_ids(member_role_ids(user))


class PermissionedTree(app_commands.CommandTree):
    """Applies the same channel + role gate to slash commands that prefix
    commands already get from the `allowed_channel` check below. Slash
    commands previously ignored DISCORD_CHANNEL_ID entirely — closing that
    gap here, not just adding the new role gate."""

    async def interaction_check(self, interaction: discord.Interaction) -> bool:
        if CHANNEL_ID and interaction.channel_id != CHANNEL_ID:
            return False  # silent, matching the existing channel gate's behaviour
        if not has_required_role(interaction.user):
            try:
                await interaction.response.send_message(
                    "You don't have permission to use this command.", ephemeral=True
                )
            except discord.HTTPException:
                log.exception("Could not report a permission denial to Discord")
            return False
        return True


@dataclass
class SearchSession:
    session_id: str
    format: str
    rate: int
    task: asyncio.Task[None]
    guild_id: int
    run_ethan_policy_check: bool


class GTagHunterBot(commands.Bot):
    def __init__(self) -> None:
        intents = discord.Intents.default()
        # Slash commands work with the default gateway intents. Prefix commands
        # are opt-in because Discord requires Message Content Intent for them.
        intents.message_content = os.getenv("DISCORD_ENABLE_PREFIX_COMMANDS", "").lower() == "true"
        super().__init__(command_prefix="!", intents=intents, tree_cls=PermissionedTree)
        self.api_http: aiohttp.ClientSession | None = None
        self.sessions: dict[int, SearchSession] = {}
        self.restore_task: asyncio.Task[None] | None = None
        self.heartbeat_task: asyncio.Task[None] | None = None

    async def setup_hook(self) -> None:
        self.api_http = aiohttp.ClientSession(
            timeout=aiohttp.ClientTimeout(total=20),
            headers={"Accept": "application/json"},
        )
        synced = await self.tree.sync()
        log.info("Registered %d Discord slash commands", len(synced))
        self.heartbeat_task = asyncio.create_task(self.heartbeat_loop())

    async def heartbeat_loop(self) -> None:
        """Report to the API so System status can show a real bot state."""
        while True:
            try:
                if self.is_ready():
                    await self.api("POST", "/bot/heartbeat", json={"guilds": len(self.guilds)})
            except asyncio.CancelledError:
                raise
            except Exception:
                log.debug("Heartbeat to the API failed", exc_info=True)
            await asyncio.sleep(HEARTBEAT_SECONDS)

    async def close(self) -> None:
        if self.restore_task:
            self.restore_task.cancel()
        if self.heartbeat_task:
            self.heartbeat_task.cancel()
        if self.api_http:
            await self.api_http.close()
        await super().close()

    def persist_searches(self) -> None:
        if not self.sessions:
            try:
                SEARCH_STATE_PATH.unlink()
            except FileNotFoundError:
                pass
            return
        payload = {
            str(channel_id): {
                "session_id": session.session_id,
                "guild_id": session.guild_id,
                "format": session.format,
                "rate": session.rate,
                "run_ethan_policy_check": session.run_ethan_policy_check,
            }
            for channel_id, session in self.sessions.items()
        }
        try:
            SEARCH_STATE_PATH.write_text(json.dumps(payload), encoding="utf-8")
        except OSError:
            log.exception("Could not persist Discord search state")

    def load_persisted_searches(self) -> dict[str, Any]:
        try:
            return json.loads(SEARCH_STATE_PATH.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            return {}

    async def restore_searches(self) -> None:
        """Reconnect to or recreate a search after a bot/API restart."""
        saved = self.load_persisted_searches()
        for channel_key, config in saved.items():
            try:
                channel_id = int(channel_key)
                channel = self.get_channel(channel_id) or await self.fetch_channel(channel_id)
                if not isinstance(channel, discord.abc.Messageable):
                    continue
                guild_id = int(config.get("guild_id", 0))
                format_name = str(config.get("format", "3C"))
                rate = int(config.get("rate", 8))
                ethan = bool(config.get("run_ethan_policy_check", False))
                session_id = str(config.get("session_id", ""))
                code, data = await self.api("GET", f"/gamertag/sessions/{session_id}") if session_id else (404, {})
                if code != 200 or data.get("state") != "running":
                    session_id = await self.create_api_search(format_name, rate, ethan)
                if not session_id:
                    log.warning("Could not restore search for channel %s yet", channel_id)
                    continue
                watcher = asyncio.create_task(
                    self.watch_session(channel, channel_id, session_id, guild_id, channel.send)
                )
                self.sessions[channel_id] = SearchSession(
                    session_id, format_name, rate, watcher, guild_id, ethan
                )
                self.persist_searches()
                await self.safe_send(
                    channel.send,
                    f"♻️ Search recovered at `{rate}/s` after a service restart.",
                )
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("Could not restore search for channel %s", channel_key)

    async def create_api_search(self, format_name: str, rate: int, ethan: bool) -> str | None:
        preset = PRESETS.get(format_name.upper())
        if preset is None:
            log.warning("Unknown search format %r; it is no longer supported", format_name)
            return None
        try:
            status, data = await self.api(
                "POST",
                "/gamertag/search",
                json={
                    "config": preset,
                    "rate": rate,
                    "runEthanPolicyCheck": ethan,
                },
            )
        except (aiohttp.ClientError, asyncio.TimeoutError):
            return None
        return str(data["sessionId"]) if status == 201 and data.get("sessionId") else None

    async def api(self, method: str, path: str, **kwargs: Any) -> tuple[int, Any]:
        if not self.api_http:
            raise RuntimeError("HTTP client is not ready")
        async with self.api_http.request(method, f"{API_BASE}{path}", **kwargs) as response:
            body = await response.text()
            try:
                data = json.loads(body) if body else {}
            except json.JSONDecodeError:
                data = {"raw": body[:500]}
            return response.status, data

    async def stream_results(
        self,
        channel: discord.abc.Messageable,
        session_id: str,
        guild_id: int,
        send: Any,
    ) -> None:
        if not self.api_http:
            return
        url = f"{API_BASE}/gamertag/sessions/{session_id}/stream"
        try:
            async with self.api_http.get(url, timeout=aiohttp.ClientTimeout(total=None)) as response:
                event = ""
                async for raw_line in response.content:
                    line = raw_line.decode("utf-8", "ignore").rstrip("\n")
                    if line.startswith("event:"):
                        event = line.split(":", 1)[1].strip()
                    elif line.startswith("data:") and event == "result":
                        result = json.loads(line.split(":", 1)[1].strip())
                        if result.get("status") == "available" and result.get("alertable") is True:
                            tag = result.get("gamertag", "")
                            log.info("Available gamertag %s found for guild %s", tag, guild_id)
                            await self.safe_send(
                                send,
                                f"🎮 **Available gamertag found:** `{tag}` "
                                f"({result.get('cps', 0)}/s)",
                            )
                    elif event == "done":
                        return
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("SSE watcher stopped for session %s", session_id)

    async def report_progress(
        self,
        channel: discord.abc.Messageable,
        channel_id: int,
        session_id: str,
        send: Any,
    ) -> None:
        """Poll status so Discord visibly confirms that the worker is making progress."""
        first_update = True
        try:
            while True:
                await asyncio.sleep(3 if first_update else 15)
                first_update = False
                code, data = await self.api("GET", f"/gamertag/sessions/{session_id}")
                if code != 200:
                    return
                if data.get("state") != "running":
                    return
                attempts = int(data.get("attempts", 0))
                found = int(data.get("found", 0))
                await self.safe_send(
                    send,
                    f"🔎 Search active: `{attempts:,}` gamertags checked, "
                    f"`{found:,}` available. Use `/stop` to stop it."
                )
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("Progress watcher stopped for session %s", session_id)

    async def safe_send(self, send: Any, content: str) -> None:
        """A Discord permission error must not terminate the Xbox watcher."""
        try:
            await send(content)
        except discord.Forbidden:
            log.warning(
                "Could not send a Discord update because the bot lacks access "
                "to the command channel; search continues"
            )
        except discord.NotFound:
            log.warning("Discord interaction follow-up expired; search continues")
        except discord.HTTPException:
            log.exception("Discord rejected a search update; search continues")

    async def watch_session(
        self,
        channel: discord.abc.Messageable,
        channel_id: int,
        session_id: str,
        guild_id: int,
        send: Any,
    ) -> None:
        current_id = session_id
        while True:
            await asyncio.gather(
                self.stream_results(channel, current_id, guild_id, send),
                self.report_progress(channel, channel_id, current_id, send),
                return_exceptions=True,
            )
            if channel_id not in self.sessions:
                return
            try:
                code, data = await self.api("GET", f"/gamertag/sessions/{current_id}")
            except (aiohttp.ClientError, asyncio.TimeoutError):
                await asyncio.sleep(5)
                continue
            if code == 200 and data.get("state") == "running":
                # The SSE connection may have dropped while the API kept working.
                await asyncio.sleep(2)
                continue
            if code == 200 and data.get("state") == "cancelled":
                self.sessions.pop(channel_id, None)
                self.persist_searches()
                return

            # A process restart removes in-memory API sessions. Recreate the
            # infinite search instead of leaving Discord with a dead watcher.
            active = self.sessions.get(channel_id)
            if not active:
                return
            while channel_id in self.sessions:
                current_id = await self.create_api_search(
                    active.format, active.rate, active.run_ethan_policy_check
                ) or ""
                if current_id:
                    active.session_id = current_id
                    self.persist_searches()
                    await self.safe_send(
                        send,
                        f"♻️ API session was lost; search automatically resumed at `{active.rate}/s`.",
                    )
                    break
                await asyncio.sleep(5)

bot = GTagHunterBot()


@bot.check
async def allowed_channel(ctx: commands.Context[commands.Bot]) -> bool:
    if CHANNEL_ID and ctx.channel.id != CHANNEL_ID:
        return False
    return has_required_role(ctx.author)


async def start_search_for_channel(
    channel: discord.abc.Messageable,
    channel_id: int,
    guild_id: int,
    send: Any,
    format_name: str = "3C",
    rate: int = 8,
    run_ethan_policy_check: bool = False,
) -> None:
    format_name = format_name.upper()
    if format_name not in FORMATS:
        await send(f"Unknown format. Choose one of: {', '.join(sorted(FORMATS))}")
        return
    if not 1 <= rate <= MAX_RATE:
        await send(f"Rate must be between 1 and {MAX_RATE} checks/second.")
        return

    existing = bot.sessions.get(channel_id)
    if existing:
        await send(f"A search is already running (`{existing.format}` at {existing.rate}/s). Use `!stop` or `/stop` first.")
        return

    try:
        session_id = await bot.create_api_search(format_name, rate, run_ethan_policy_check)
    except (aiohttp.ClientError, asyncio.TimeoutError) as exc:
        log.exception("Could not reach GTagHunter API")
        await send(f"Could not reach the GTagHunter API at `{API_BASE}`: {exc}")
        return
    if not session_id:
        await send("Could not start search: the API is unavailable or rejected the rate.")
        return

    watcher = asyncio.create_task(
        bot.watch_session(channel, channel_id, session_id, guild_id, send)
    )
    bot.sessions[channel_id] = SearchSession(
        session_id, format_name, rate, watcher, guild_id, run_ethan_policy_check
    )
    bot.persist_searches()
    policy_note = " Double Check is ON." if run_ethan_policy_check else ""
    await send(
        f"▶️ Started infinite `{format_name}` search at `{rate}/s`.{policy_note} "
        "Use `!stop` or `/stop` to stop it."
    )


async def start_search(ctx: commands.Context[commands.Bot], format_name: str = "3C", rate: int = 8) -> None:
    await start_search_for_channel(
        ctx.channel,
        ctx.channel.id,
        ctx.guild.id if ctx.guild else 0,
        ctx.send,
        format_name,
        rate,
    )


@bot.command()
async def start(ctx: commands.Context[commands.Bot], format_name: str = "3C", rate: int = 8) -> None:
    await start_search(ctx, format_name, rate)


@bot.command(name="add_list")
async def add_list(ctx: commands.Context[commands.Bot], format_name: str = "3C", rate: int = 8) -> None:
    await start_search(ctx, format_name, rate)


async def stop_channel(channel_id: int, send: Any) -> None:
    session = bot.sessions.pop(channel_id, None)
    if not session:
        bot.persist_searches()
        await send("No active gamertag search in this channel. The Discord bot is still online.")
        return
    bot.persist_searches()
    try:
        status, data = await bot.api("DELETE", f"/gamertag/sessions/{session.session_id}")
    except (aiohttp.ClientError, asyncio.TimeoutError) as exc:
        session.task.cancel()
        await asyncio.gather(session.task, return_exceptions=True)
        await send(f"Search watcher stopped, but the API could not be reached: {exc}")
        return
    session.task.cancel()
    await asyncio.gather(session.task, return_exceptions=True)
    if status == 200:
        await send("⏹️ **Gamertag search stopped.** The Discord bot remains online; use `!start` or `/start` to search again.")
    else:
        await send(f"Search watcher stopped, but the API returned `{status}`: {data.get('error', data)}")


@bot.command()
async def stop(ctx: commands.Context[commands.Bot]) -> None:
    await stop_channel(ctx.channel.id, ctx.send)


@bot.command()
async def pause(ctx: commands.Context[commands.Bot]) -> None:
    session = bot.sessions.get(ctx.channel.id)
    if not session:
        await ctx.send("No active search in this channel.")
        return
    status, _ = await bot.api("POST", f"/gamertag/sessions/{session.session_id}/pause")
    await ctx.send("⏸️ Search paused." if status == 200 else "Could not pause the search.")


@bot.command()
async def resume(ctx: commands.Context[commands.Bot]) -> None:
    session = bot.sessions.get(ctx.channel.id)
    if not session:
        await ctx.send("No active search in this channel.")
        return
    status, _ = await bot.api("POST", f"/gamertag/sessions/{session.session_id}/resume")
    await ctx.send("▶️ Search resumed." if status == 200 else "Could not resume the search.")


@bot.command()
async def status(ctx: commands.Context[commands.Bot]) -> None:
    session = bot.sessions.get(ctx.channel.id)
    if not session:
        await ctx.send("No active search in this channel.")
        return
    code, data = await bot.api("GET", f"/gamertag/sessions/{session.session_id}")
    if code != 200:
        await ctx.send(f"Could not read status: {data.get('error', data)}")
        return
    await ctx.send(
        f"📡 `{data['state']}` · `{data['type']}` · "
        f"{data['attempts']:,} checks · {data['found']:,} available · `{data.get('cps', 0)}/s`"
    )


@bot.command(name="check_gt")
async def check_gt(ctx: commands.Context[commands.Bot], tag: str) -> None:
    code, data = await bot.api("GET", f"/gamertag/verify/{tag.upper()}")
    if code != 200:
        await ctx.send(f"Verification failed: {data.get('error', data)}")
        return
    await ctx.send(
        f"`{data['gamertag']}` → **{data['status']}** "
        f"(confidence: {data['confidence']})"
    )


@bot.command()
async def claim(ctx: commands.Context[commands.Bot], tag: str) -> None:
    code, data = await bot.api("POST", "/gamertag/claim", json={"gamertag": tag.upper()})
    message = data.get("message", data.get("error", "Unknown response"))
    await ctx.send(("✅ " if data.get("success") else "❌ ") + message)


@bot.tree.command(name="start", description="Start an infinite Xbox gamertag search")
@app_commands.describe(
    format_name=FORMAT_HELP,
    rate="Checks per second",
    ethan_check="Require Double Check approval before sending available tags",
)
async def slash_start(
    interaction: discord.Interaction,
    format_name: str = "3C",
    rate: int = 8,
    ethan_check: bool = False,
) -> None:
    await interaction.response.defer()
    await start_search_for_channel(
        interaction.channel,
        interaction.channel_id,
        interaction.guild_id or 0,
        interaction.followup.send,
        format_name,
        rate,
        ethan_check,
    )


@bot.tree.command(name="search", description="Start an infinite Xbox gamertag search")
@app_commands.describe(
    format_name=FORMAT_HELP,
    rate="Checks per second",
    ethan_check="Require Double Check approval before sending available tags",
)
async def slash_search(
    interaction: discord.Interaction,
    format_name: str = "3C",
    rate: int = 8,
    ethan_check: bool = False,
) -> None:
    await interaction.response.defer()
    await start_search_for_channel(
        interaction.channel,
        interaction.channel_id,
        interaction.guild_id or 0,
        interaction.followup.send,
        format_name,
        rate,
        ethan_check,
    )


@bot.tree.command(name="add_list", description="Start a format list search")
@app_commands.describe(
    format_name=FORMAT_HELP,
    rate="Checks per second",
    ethan_check="Require Double Check approval before sending available tags",
)
async def slash_add_list(
    interaction: discord.Interaction,
    format_name: str = "3C",
    rate: int = 8,
    ethan_check: bool = False,
) -> None:
    await interaction.response.defer()
    await start_search_for_channel(
        interaction.channel,
        interaction.channel_id,
        interaction.guild_id or 0,
        interaction.followup.send,
        format_name,
        rate,
        ethan_check,
    )


@bot.tree.command(name="stop", description="Stop the active gamertag search")
async def slash_stop(interaction: discord.Interaction) -> None:
    await interaction.response.defer()
    await stop_channel(interaction.channel_id, interaction.followup.send)


@bot.tree.command(name="status", description="Show search and bot status")
async def slash_status(interaction: discord.Interaction) -> None:
    await interaction.response.defer()
    session = bot.sessions.get(interaction.channel_id)
    if not session:
        await interaction.followup.send("🤖 **Bot online.** No gamertag search is running in this channel.")
        return
    code, data = await bot.api("GET", f"/gamertag/sessions/{session.session_id}")
    if code != 200:
        await interaction.followup.send(f"Bot online, but API status failed: {data.get('error', data)}")
        return
    await interaction.followup.send(
        f"🤖 **Bot online** · 📡 search `{data['state']}` · `{data['type']}` · "
        f"{data['attempts']:,} checks · {data['found']:,} available · `{data.get('cps', 0)}/s`"
    )


@bot.tree.command(name="check_gt", description="Check one Xbox gamertag")
@app_commands.describe(tag="Gamertag to verify")
async def slash_check_gt(interaction: discord.Interaction, tag: str) -> None:
    await interaction.response.defer()
    code, data = await bot.api("GET", f"/gamertag/verify/{tag.upper()}")
    if code != 200:
        await interaction.followup.send(f"Verification failed: {data.get('error', data)}")
        return
    await interaction.followup.send(
        f"`{data['gamertag']}` → **{data['status']}** "
        f"(confidence: {data['confidence']})"
    )


@bot.tree.command(name="claim", description="Claim an exact available gamertag")
@app_commands.describe(tag="Gamertag to claim")
async def slash_claim(interaction: discord.Interaction, tag: str) -> None:
    await interaction.response.defer()
    code, data = await bot.api("POST", "/gamertag/claim", json={"gamertag": tag.upper()})
    message = data.get("message", data.get("error", "Unknown response"))
    await interaction.followup.send(("✅ " if data.get("success") else "❌ ") + message)


@bot.tree.command(name="pause", description="Pause the active gamertag search")
async def slash_pause(interaction: discord.Interaction) -> None:
    await interaction.response.defer()
    session = bot.sessions.get(interaction.channel_id)
    if not session:
        await interaction.followup.send("🤖 Bot online, but no search is running in this channel.")
        return
    code, _ = await bot.api("POST", f"/gamertag/sessions/{session.session_id}/pause")
    await interaction.followup.send("⏸️ Search paused." if code == 200 else "Could not pause the search.")


@bot.tree.command(name="resume", description="Resume the paused gamertag search")
async def slash_resume(interaction: discord.Interaction) -> None:
    await interaction.response.defer()
    session = bot.sessions.get(interaction.channel_id)
    if not session:
        await interaction.followup.send("🤖 Bot online, but no search is running in this channel.")
        return
    code, _ = await bot.api("POST", f"/gamertag/sessions/{session.session_id}/resume")
    await interaction.followup.send("▶️ Search resumed." if code == 200 else "Could not resume the search.")


@bot.tree.error
async def on_app_command_error(interaction: discord.Interaction, error: app_commands.AppCommandError) -> None:
    log.exception("Discord slash command failed", exc_info=error)
    message = "Discord command failed, but the bot is still online. Try the command again."
    try:
        if interaction.response.is_done():
            await interaction.followup.send(message)
        else:
            await interaction.response.send_message(message)
    except discord.HTTPException:
        log.exception("Could not report slash command failure to Discord")


@bot.event
async def on_ready() -> None:
    log.info("Discord bot connected as %s", bot.user)
    if bot.restore_task is None or bot.restore_task.done():
        bot.restore_task = asyncio.create_task(bot.restore_searches())


if __name__ == "__main__":
    if not TOKEN:
        raise SystemExit("DISCORD_BOT_TOKEN is required; add it as a Replit Secret.")
    bot.run(TOKEN)