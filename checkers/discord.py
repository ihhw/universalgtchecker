"""Discord username availability checker.

Adapted from SNIPERR checker for the Universal GT Checker.
"""
from __future__ import annotations

import base64
import json
import math
import os
import queue
import random
import re
import sqlite3
import string
import threading
import time
import uuid
from collections import deque
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Optional
from urllib.parse import quote

try:
    from curl_cffi import requests as curl_requests
    from curl_cffi.requests import Session as CurlSession
    HAS_CURL_CFFI = True
except ImportError:
    curl_requests = None
    CurlSession = None
    HAS_CURL_CFFI = False

try:
    import tls_client
    HAS_TLS_CLIENT = True
except ImportError:
    tls_client = None
    HAS_TLS_CLIENT = False

try:
    import requests as std_requests
except ImportError:
    std_requests = None

if not HAS_CURL_CFFI and not HAS_TLS_CLIENT and std_requests is None:
    raise SystemExit("Missing dependency.\nRun: pip install curl_cffi requests")


DISCORD_PATH = "/api/v9/unique-username/username-attempt-unauthed"
DISCORD_HOSTS = ["https://discord.com", "https://canary.discord.com", "https://ptb.discord.com"]

SETTINGS_FILE = "discord-checker-settings.json"
PROXY_FILE = "proxies.txt"
RESULTS_FILE = "discord-available.txt"
HISTORY_FILE = "discord-history.sqlite3"

MIN_CPS = 1.0
MAX_CPS = 5000.0
DEFAULT_CPS = 200.0
DEFAULT_TIMEOUT_MS = 2500

CIRCUIT_BREAK_THRESHOLD = 3
CIRCUIT_BREAK_SEC = 6.0
ROUTE_COOLDOWN = 0.15
MAX_PER_ROUTE = 12
SESSION_MAX_REQUESTS = 50
PROXY_DEAD_STRIKES = 3
PROXY_DEAD_COOLDOWN = 60.0
UNKNOWN_RETRY_ATTEMPTS = 3

RATELIMIT_SAFETY_PCT = 0.90
BUCKET_TRACK_MAX = 512

MIN_WORKERS = 64
MAX_WORKERS = 500
WORKER_CPS_FACTOR = 3.0
READY_DELAY_SEC = 5

ALNUM = string.ascii_lowercase + string.digits
LETTERS = string.ascii_lowercase
DIGITS = string.digits

RESET = "\033[0m"
RED = "\033[91m"
GREEN = "\033[92m"
YELLOW = "\033[93m"
GREY = "\033[90m"
WHITE = "\033[97m"


def _gen_installation_id() -> str:
    return str(uuid.uuid4())

def _gen_launch_signature() -> str:
    return base64.b64encode(os.urandom(16)).decode().rstrip("=")

def _build_super_properties(host: str) -> str:
    if "canary" in host: channel = "canary"
    elif "ptb" in host: channel = "ptb"
    else: channel = "stable"
    props = {
        "os": "Windows",
        "browser": "Discord Client",
        "release_channel": channel,
        "client_version": "1.0.9166",
        "os_version": "10.0.22631",
        "os_arch": "x64",
        "system_locale": "en-US",
        "client_build_number": random.randint(270000, 275000),
        "native_build_number": random.randint(43000, 45000),
        "client_event_source": None,
        "launch_signature": _gen_launch_signature(),
        "installation_id": _gen_installation_id(),
    }
    return base64.b64encode(json.dumps(props, separators=(",", ":")).encode("utf-8")).decode("ascii")

def _build_x_fingerprint() -> str:
    fp = {
        "os": "Windows",
        "browser": "Discord Client",
        "release_channel": "stable",
        "client_version": "1.0.9166",
        "os_version": "10.0.22631",
        "os_arch": "x64",
        "system_locale": "en-US",
        "client_build_number": random.randint(270000, 275000),
        "native_build_number": random.randint(43000, 45000),
    }
    return base64.b64encode(json.dumps(fp, separators=(",", ":")).encode("utf-8")).decode("ascii")

def _build_headers(host: str) -> dict:
    return {
        "accept": "*/*",
        "accept-encoding": "gzip, deflate, br, zstd",
        "accept-language": "en-US,en;q=0.9",
        "cache-control": "no-cache",
        "content-type": "application/json",
        "origin": "https://discord.com",
        "pragma": "no-cache",
        "priority": "u=1, i",
        "referer": "https://discord.com/channels/@me",
        "sec-ch-ua": '"Google Chrome";v="120", "Chromium";v="120", "Not(A:Brand";v="24"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
        "sec-fetch-user": "?1",
        "upgrade-insecure-requests": "1",
        "user-agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/120.0.0.0 Safari/537.36"
        ),
        "x-debug-options": "bugReporterEnabled",
        "x-discord-locale": "en-US",
        "x-discord-timezone": "America/New_York",
        "x-super-properties": _build_super_properties(host),
        "x-fingerprint": _build_x_fingerprint(),
    }


# ═══════════════════════════════════════════════════════════════════════════
# WORD POOLS
# ═══════════════════════════════════════════════════════════════════════════

SHORT_WORD_BLOB = (
    "acidaeroagedallyapexarchariaatomauraaxisbanebeambetabiteblipblurboltbrimbyte"
    "calmcavecharclawcodecoldcorecosycrowdawndazedeckdripduskechoedgeepicfangfern"
    "fluxfoamgaleglowgridgrimhalohazehushirisjadejoltkilokitelarklavalimelinkluna"
    "lynxmacemintmistmusemythnavyneonnovaonyxopalpalepeakplumrainriftsagesilksnow"
    "solostarstemtidevoidwavewispwolfxenoyarnyetizealzerozinczonearilbuhrcymafane"
    "ilexixiajapekelpkithlinnrimewoadyarefardfoudhylekamemiltuveafirn"
)
SHORT_WORDS = [SHORT_WORD_BLOB[i:i+4] for i in range(0, len(SHORT_WORD_BLOB), 4)]

RARE_WORD_BLOB = (
    "amberazureemberfablefrostorbitpixelpulsequillslatesparkabysmadretaegisaglet"
    "alateamiceanileapianarborardorargotaskewattarauricazothbardobezelbightbohea"
    "boricbrumecairncalyxchertchirkcivetcladeclarycoigndightdongadrossducaleagree"
    "clateduceelideenvoiergotetweefetorfirthflumefrondgamicgaultghyllglebeglume"
    "goralgrithguyothalerhelvehilumhouriicticinurnjabotjorumkedgeknurllaitylathyl"
    "emanlumenmaclemaundmerlemurexnacrenivalnonceockerogiveorlopoxterpavidpewit"
    "pingoplicaprillquernquoinratalroblesakersalepscurfsepalshawmsilexsizarskirl"
    "soughstoupswaletargetigontopertronaulemaumbelurialvaticvelarvireowhealwight"
    "xeniczayinzebeczonda"
)
RARE_WORDS = [RARE_WORD_BLOB[i:i+5] for i in range(0, len(RARE_WORD_BLOB), 5)]

OBSCURE_WORD_BLOB = (
    "abditablowaboonabsitacmicaduncaegiraiveralbeealephalgidalureambitamoleanelean"
    "entannalanomyarameargalarlesaroidasconascusaulicavensavisoaxileazidebairnbalky"
    "bardebaricbassibattubawtybeanobedelbeedibemixbermebirleblateblawnblentblore"
    "boartbocceboffobolarbonceboralbortyboskybractbramebromebunducadgecairdcalky"
    "camuscavieceorlceredchapechirmchirtchylecimarclepeclourcoblecogoncoombcozen"
    "crakecreelcronkcruseculchculetcusecdavitdeavedeedydemitdizendobladoorndoura"
    "dowiedrantdreckdunamealedephoretapeettlefanalfaughfeuarflaryfleamfliskflong"
    "flotaforbyfrapefrithfuglegallyganevgawkygibusgimelgiponglairgleetgliskgopak"
    "gricegromagrykegurshhainthamalhaughhaverhelothormehoughinklejagerjambujiber"
    "juralkabobkaiakkalamkepiskirbykvasslairdlanailarumlaverleachlearylimenlorel"
    "lurrymaficmalicmargemashymesicmoraemowramucidmungonairunaresnievenogalnooky"
    "oaredoctadodyleollavopineorpinottarpangapannepareupavispeerypeisepiculpisky"
    "pleonpraamproemquirtrabatraneerenterhemerhyneriantronderubleruchesabalsagum"
    "samelscaupsegarselahsengiseracshielsmazesnecksnoodsorelspeansteddstirksward"
    "tabortawietentythirltichytorsktrullulnarunlayvarecvenalvinalvolarwackewaled"
    "wealdwiddywirrawurstxylanyamenyapokyestyzabrazibetzillszoril"
)
OBSCURE_WORDS = [OBSCURE_WORD_BLOB[i:i+5] for i in range(0, len(OBSCURE_WORD_BLOB), 5)]
ALL_WORDS = list(dict.fromkeys(SHORT_WORDS + RARE_WORDS + OBSCURE_WORDS))

POOL_A = (
    "north south east west upper lower inner outer red blue black white green gold "
    "silver pink purple orange gray grey brown cyan teal navy lime mint coral ruby "
    "jade pearl ivory onyx amber cherry copper bronze indigo violet dawn dusk morning "
    "evening night day noon midnight sunrise sunset twilight summer winter spring autumn "
    "wild calm cool warm cold hot fresh old new young sharp smooth rough soft hard "
    "quick slow fast bright dark dull clear foggy cloudy sunny stormy quiet loud silent "
    "roaring sky sea ocean coast river lake forest wood tree leaf stone rock sand snow "
    "rain wind storm cloud sun moon star fire water ice earth mountain hill valley canyon "
    "desert cliff cave spring tide wave thunder lightning breeze mist frost hail drizzle "
    "flood drought blizzard tornado hurricane monsoon cyclone peace joy love hope dream "
    "fear brave kind pride rage fury soul spirit ghost mercy grace honor glory faith trust "
    "truth memory secret whisper promise fate destiny karma fall rise run walk jump fly "
    "swim dive climb break crack burn glow shine spark hit kick punch slash cut chop slice "
    "dash sprint chase hunt seek find keep lose sword shield crown ring gem coin book key "
    "lock door gate wall tower bridge road path trail camp tent hut house home castle "
    "throne spear bow arrow axe hammer dagger blade helm armor cloak robe mask glove boot "
    "belt wolf fox bear lion tiger eagle hawk crow raven owl snake shark whale deer elk "
    "moose hare rabbit mouse cat dog lynx panther leopard jaguar puma boar stag"
).split()

POOL_B = (
    "town city village hamlet fort keep manor hall temple shrine church market port "
    "harbor dock bay cove inlet isle head hand foot arm leg eye ear nose mouth tooth "
    "claw fang wing tail horn steel iron brass copper glass cloth silk wool leather "
    "paper clay one two three four five six seven eight nine ten comet meteor planet "
    "orbit galaxy nebula cosmos ether void abyss zenith horizon aurora eclipse solstice "
    "rifle pistol cannon mortar mine bomb grenade missile rocket sniper scope trigger "
    "bullet shell song tune beat rhythm chord melody anthem hymn chorus verse pixel "
    "byte code chip data cyber crypto laser radar signal circuit matrix nexus vector "
    "blaze ash smoke dust mud thorn ivy moss fern reed vine root bark branch seed "
    "flower petal bloom berry fruit apple grape lemon peach plum pear bite drink eat "
    "sleep wake sing dance play laugh cry shout yell scream talk speak listen hear see "
    "look watch search explore wander happy sad angry tired hungry thirsty sleepy awake "
    "alive dead real fake true false good bad evil holy clean dirty rich poor wise"
).split()

POOL_C = (
    "shadow phantom specter wraith banshee revenant sorrow bliss chaos infinite "
    "infinity eternity forever always never mystic magical sacred holy divine cursed "
    "blessed gaming gamer player gamemaster gameover epic legend legendary mythical "
    "mythic mythos alpha beta gamma delta omega sigma theta lambda victory triumph "
    "defeat glory shame puzzle riddle mystery enigma cipher wanderlust adventure "
    "quest voyage expedition harmony melody tempo tune silence echo murmur hum buzz "
    "phoenix dragon unicorn griffin pegasus sphinx cyberpunk neon chrome vapor synth "
    "retro future cosmic starlight moonlight twilight hunter tracker ranger scout "
    "explorer pioneer warrior fighter boxer wrestler samurai ninja shinobi sailor "
    "pirate captain admiral commander general knight paladin templar crusader guardian "
    "warden wizard mage sorcerer warlock enchanter conjurer bard minstrel troubadour "
    "poet artist painter monk priest cleric bishop cardinal pope king queen prince "
    "princess royal noble emperor empress smith mason weaver tanner tailor baker "
    "butcher doctor healer medic physician surgeon nurse teacher scholar student pupil "
    "master apprentice thief rogue bandit outlaw smuggler spy agent assassin marksman "
    "scout spirit soul essence being entity presence velocity momentum gravity inertia "
    "entropy cosmos void zenith abyss eternity infinity"
).split()

COMBO_WORDS = list(dict.fromkeys(POOL_A + POOL_B + POOL_C))
DICTIONARY_WORDS = list(dict.fromkeys(POOL_A + POOL_B + POOL_C))
MEGA_WORDS = list(dict.fromkeys(COMBO_WORDS + ALL_WORDS + DICTIONARY_WORDS))

IMPERSONATE_PROFILES = ["chrome110", "chrome116", "chrome119", "chrome120"]


MODE_MAP = {
    "1": ("semi_3c_both", "Semi 3C BOTH", "a_7x / .q2m"),
    "2": ("semi_3c_dot", "Semi 3C DOT", "a.7x / .q2m"),
    "3": ("semi_3c_under", "Semi 3C _", "a_7x / _q2m"),
    "4": ("semi_3n_both", "Semi 3N BOTH", "1.23 / 4_56"),
    "5": ("semi_3n_dot", "Semi 3N DOT", "1.23 / 45.6"),
    "6": ("semi_3n_under", "Semi 3N _", "1_23 / 12_3"),
    "7": ("semi_4n_both", "Semi 4N BOTH", "1.234 / 12_34"),
    "8": ("semi_4n_dot", "Semi 4N DOT", "1.234 / 12.34"),
    "9": ("semi_4n_under", "Semi 4N _", "1_234 / 12_34"),
    "10": ("2c", "2C", "a7"),
    "11": ("3c_smart", "3C Smart", "v0m"),
    "12": ("4c_smart", "4C Smart", "q7m2"),
    "13": ("5c", "5C Smart", "q7m2x"),
    "14": ("3l", "3L", "abc"),
    "15": ("4l", "4L", "abcd"),
    "16": ("5l", "5L", "abcde"),
    "17": ("3n", "3N", "123"),
    "18": ("4n", "4N", "1234"),
    "19": ("5n", "5N", "12345"),
    "20": ("word_short", "Short words", "acid / nova"),
    "21": ("word_rare", "Rare words", "amber / lumen"),
    "22": ("word_obscure", "Obscure words", "abdit / cronk"),
    "23": ("word_all", "All word pools", "all embedded"),
    "24": ("word_sep", "Word + . / _", "lumen_ / .lumen"),
    "25": ("word_join", "Word pairs", "eastcoast / firefly"),
    "26": ("word_dict", "Big dictionary", "dragon / phoenix"),
    "27": ("word_dict_join", "Dictionary pairs", "silentwolf / starborn"),
    "28": ("word_mega_join", "ALL words paired", "everything combined"),
    "M": ("word_num_word", "MIX: word+num+word", "fire7wolf / nova.42.sky"),
}
MODE_BY_ID = {v[0]: v for v in MODE_MAP.values()}


@dataclass
class Settings:
    timeout_ms: int = DEFAULT_TIMEOUT_MS
    proxies: str = ""
    webhook: str = ""
    mode: str = "4c_smart"
    target_cps: float = DEFAULT_CPS
    show_taken: bool = True

    def sanitize(self):
        self.timeout_ms = max(900, min(8000, int(self.timeout_ms or DEFAULT_TIMEOUT_MS)))
        self.target_cps = max(MIN_CPS, min(MAX_CPS, float(self.target_cps or DEFAULT_CPS)))
        self.webhook = str(self.webhook or "").strip()
        self.proxies = str(self.proxies or "")
        if self.mode not in MODE_BY_ID:
            self.mode = "4c_smart"
        return self


def load_settings(base: Path) -> Settings:
    p = base / SETTINGS_FILE
    if not p.exists():
        return Settings()
    try:
        raw = json.loads(p.read_text(encoding="utf-8"))
        return Settings(**{k: v for k, v in raw.items() if k in Settings.__dataclass_fields__}).sanitize()
    except Exception:
        return Settings()


def save_settings(base: Path, settings: Settings) -> None:
    (base / SETTINGS_FILE).write_text(json.dumps(asdict(settings.sanitize()), indent=2), encoding="utf-8")


class PersistentHistory:
    def __init__(self, path: Path):
        self.conn = sqlite3.connect(path, check_same_thread=False)
        self.lock = threading.Lock()
        with self.conn:
            self.conn.execute("CREATE TABLE IF NOT EXISTS seen (name TEXT PRIMARY KEY, ts REAL NOT NULL)")

    def claim(self, name: str) -> bool:
        with self.lock:
            try:
                with self.conn:
                    self.conn.execute("INSERT INTO seen(name, ts) VALUES (?, ?)", (name, time.time()))
                return True
            except sqlite3.IntegrityError:
                return False

    def count(self) -> int:
        with self.lock:
            row = self.conn.execute("SELECT COUNT(*) FROM seen").fetchone()
            return int(row[0]) if row else 0

    def close(self) -> None:
        with self.lock:
            self.conn.close()


def _decode_base(index: int, charset: str, length: int) -> str:
    base = len(charset)
    chars = [charset[0]] * length
    for pos in range(length - 1, -1, -1):
        index, rem = divmod(index, base)
        chars[pos] = charset[rem]
    return "".join(chars)


def _decode_semi(idx: int, seps: str, body_len: int, charset: str) -> str:
    per_sep = (body_len + 1) * (len(charset) ** body_len)
    sep_idx, rest = divmod(idx, per_sep)
    pos, body_idx = divmod(rest, len(charset) ** body_len)
    body = _decode_base(body_idx, charset, body_len)
    chars = list(body)
    chars.insert(pos, seps[sep_idx])
    return "".join(chars)


class NameGenerator:
    def __init__(self, mode: str, seed: Optional[int] = None):
        self.mode = mode
        self.rng = random.Random(seed if seed is not None else random.SystemRandom().getrandbits(64))
        self.counter = 0
        self.total = self._total()
        self.bits = max(1, (self.total - 1).bit_length())
        self.mask = (1 << self.bits) - 1
        self.rounds = []
        for _ in range(4):
            self.rounds.append((
                self.rng.randrange(1, self.mask + 1) | 1,
                self.rng.randrange(0, self.mask + 1),
                self.rng.randint(1, max(1, self.bits - 1)),
                self.rng.randint(1, max(1, self.bits - 1)),
            ))

    def _total(self) -> int:
        m = self.mode
        n = len(ALNUM)
        if m == "semi_3c_both": return 2 * 4 * (n ** 3)
        if m == "semi_3c_dot": return 4 * (n ** 3)
        if m == "semi_3c_under": return 4 * (n ** 3)
        if m == "semi_3n_both": return 2 * 4 * (10 ** 3)
        if m == "semi_3n_dot": return 4 * (10 ** 3)
        if m == "semi_3n_under": return 4 * (10 ** 3)
        if m == "semi_4n_both": return 2 * 5 * (10 ** 4)
        if m == "semi_4n_dot": return 5 * (10 ** 4)
        if m == "semi_4n_under": return 5 * (10 ** 4)
        if m == "2c": return n ** 2
        if m == "3c_smart": return n ** 3
        if m == "4c_smart": return n ** 4
        if m == "5c": return n ** 5
        if m == "3l": return len(LETTERS) ** 3
        if m == "4l": return len(LETTERS) ** 4
        if m == "5l": return len(LETTERS) ** 5
        if m == "3n": return len(DIGITS) ** 3
        if m == "4n": return len(DIGITS) ** 4
        if m == "5n": return len(DIGITS) ** 5
        if m == "word_short": return len(SHORT_WORDS)
        if m == "word_rare": return len(RARE_WORDS)
        if m == "word_obscure": return len(OBSCURE_WORDS)
        if m == "word_all": return len(ALL_WORDS)
        if m == "word_sep": return len(ALL_WORDS) * 4
        if m == "word_join":
            k = len(COMBO_WORDS); return k * (k - 1)
        if m == "word_dict": return len(DICTIONARY_WORDS)
        if m == "word_dict_join":
            k = len(DICTIONARY_WORDS); return k * (k - 1)
        if m == "word_mega_join":
            k = len(MEGA_WORDS); return k * (k - 1)
        if m == "word_num_word":
            k = len(MEGA_WORDS); return 4 * k * 10 * (k - 1)
        raise ValueError(f"unknown mode: {self.mode}")

    def _decode(self, idx: int) -> str:
        m = self.mode
        n = len(ALNUM)
        if m == "semi_3c_both": return _decode_semi(idx, "._", 3, ALNUM)
        if m == "semi_3c_dot":  return _decode_semi(idx, ".", 3, ALNUM)
        if m == "semi_3c_under":return _decode_semi(idx, "_", 3, ALNUM)
        if m == "semi_3n_both": return _decode_semi(idx, "._", 3, DIGITS)
        if m == "semi_3n_dot":  return _decode_semi(idx, ".", 3, DIGITS)
        if m == "semi_3n_under":return _decode_semi(idx, "_", 3, DIGITS)
        if m == "semi_4n_both": return _decode_semi(idx, "._", 4, DIGITS)
        if m == "semi_4n_dot":  return _decode_semi(idx, ".", 4, DIGITS)
        if m == "semi_4n_under":return _decode_semi(idx, "_", 4, DIGITS)
        if m == "2c": return _decode_base(idx, ALNUM, 2)
        if m == "3c_smart": return _decode_base(idx, ALNUM, 3)
        if m == "4c_smart": return _decode_base(idx, ALNUM, 4)
        if m == "5c": return _decode_base(idx, ALNUM, 5)
        if m == "3l": return _decode_base(idx, LETTERS, 3)
        if m == "4l": return _decode_base(idx, LETTERS, 4)
        if m == "5l": return _decode_base(idx, LETTERS, 5)
        if m == "3n": return _decode_base(idx, DIGITS, 3)
        if m == "4n": return _decode_base(idx, DIGITS, 4)
        if m == "5n": return _decode_base(idx, DIGITS, 5)
        if m == "word_short": return SHORT_WORDS[idx]
        if m == "word_rare": return RARE_WORDS[idx]
        if m == "word_obscure": return OBSCURE_WORDS[idx]
        if m == "word_all": return ALL_WORDS[idx]
        if m == "word_sep":
            wi, f = divmod(idx, 4); w = ALL_WORDS[wi]
            return (w + ".", w + "_", "." + w, "_" + w)[f]
        if m == "word_join":
            k = len(COMBO_WORDS); a, b = divmod(idx, k - 1)
            if b >= a: b += 1
            return COMBO_WORDS[a] + COMBO_WORDS[b]
        if m == "word_dict": return DICTIONARY_WORDS[idx]
        if m == "word_dict_join":
            k = len(DICTIONARY_WORDS); a, b = divmod(idx, k - 1)
            if b >= a: b += 1
            return DICTIONARY_WORDS[a] + DICTIONARY_WORDS[b]
        if m == "word_mega_join":
            k = len(MEGA_WORDS); a, b = divmod(idx, k - 1)
            if b >= a: b += 1
            return MEGA_WORDS[a] + MEGA_WORDS[b]
        if m == "word_num_word":
            k = len(MEGA_WORDS)
            sep_id = idx % 4; idx //= 4
            digit = idx % 10; idx //= 10
            w2 = idx % k; idx //= k
            w1 = idx % k
            if w2 == w1: w2 = (w2 + 1) % k
            a = MEGA_WORDS[w1]; b = MEGA_WORDS[w2]
            if sep_id == 0: return f"{a}{digit}{b}"
            if sep_id == 1: return f"{a}_{digit}_{b}"
            if sep_id == 2: return f"{a}.{digit}.{b}"
            return f"{a}{digit}.{b}"
        raise ValueError(m)

    def _permute_index(self, value: int) -> int:
        if self.total <= 1: return 0
        x = value & self.mask
        while True:
            for mult, add, sa, sb in self.rounds:
                x = (x + add) & self.mask
                x ^= x >> sa
                x = (x * mult) & self.mask
                x ^= x >> sb
                x &= self.mask
            if x < self.total:
                return x

    def next(self) -> str:
        idx = self._permute_index(self.counter)
        self.counter = (self.counter + 1) % self.total
        return self._decode(idx)


def normalize_proxy(raw: str) -> Optional[str]:
    raw = raw.strip()
    if not raw or raw.startswith("#"): return None
    if raw.startswith(("http://", "https://", "socks5://", "socks5h://")):
        return raw.rstrip("/")
    if "@" in raw:
        auth, address = raw.rsplit("@", 1)
        if ":" in auth and ":" in address:
            user, password = auth.split(":", 1)
            host, port = address.rsplit(":", 1)
            if user and host and port.isdigit():
                return f"http://{quote(user, safe='')}:{quote(password, safe='')}@{host}:{port}"
    parts = raw.split(":")
    if len(parts) == 2:
        host, port = parts
        if host and port.isdigit():
            return f"http://{host}:{port}"
    if len(parts) >= 4:
        host, port, user = parts[0], parts[1], parts[2]
        password = ":".join(parts[3:])
        if host and port.isdigit() and user:
            return f"http://{quote(user, safe='')}:{quote(password, safe='')}@{host}:{port}"
    return None


def load_proxies(base: Path, settings: Settings) -> list:
    rows = []
    configured = settings.proxies.strip()
    if configured:
        rows.extend(re.split(r"[\r\n,]+", settings.proxies))
    else:
        p = base / PROXY_FILE
        if p.exists():
            try:
                rows.extend(p.read_text(encoding="utf-8", errors="ignore").splitlines())
            except OSError:
                pass
    out, seen = [], set()
    for row in rows:
        proxy = normalize_proxy(row)
        if proxy and proxy not in seen:
            out.append(proxy)
            seen.add(proxy)
    return out


@dataclass
class CheckResult:
    state: str
    status: int = 0
    retry_after: float = 0.0
    detail: str = ""
    latency_ms: float = 0.0


def format_stats(checked: int, taken: int, available: int, limited: int = 0) -> str:
    return (f"Checked {checked:,} | Taken {taken:,} | Available {available:,} "
            f"| Limited {limited:,}")


def worker_count_for(target_cps: float, proxy_count: int = 0) -> int:
    if proxy_count <= 0:
        return max(4, min(16, math.ceil(min(target_cps, 10.0) * 1.5)))
    return max(MIN_WORKERS, min(MAX_WORKERS, math.ceil(float(target_cps) * WORKER_CPS_FACTOR)))


# ═══════════════════════════════════════════════════════════════════════════
# WEBHOOK
# ═══════════════════════════════════════════════════════════════════════════

def _build_webhook_payload(username: str, mode_label: str) -> dict:
    return {
        "content": f"**AVAILABLE** `{username}`  ·  mode: {mode_label or 'unknown'}",
        "username": "Universal GT Checker",
    }


def _mask_url(url: str) -> str:
    url = url.strip()
    m = re.match(r"^(https://[^\s/]+/api/webhooks/\d+)/([^\s/?#]+)", url)
    if m:
        token = m.group(2)
        if len(token) > 10:
            return f"{m.group(1)}/{token[:4]}...{token[-4:]}"
        return f"{m.group(1)}/{token}"
    return url[:60] + ("..." if len(url) > 60 else "")


def _try_send_webhook(url: str, username: str, mode_label: str, timeout: int = 10) -> tuple:
    payload = _build_webhook_payload(username, mode_label)
    body_text = json.dumps(payload)
    errors = []

    if std_requests is not None:
        try:
            s = std_requests.Session()
            s.trust_env = False
            r = s.post(url, data=body_text,
                       headers={"Content-Type": "application/json"}, timeout=timeout)
            try: s.close()
            except Exception: pass
            if 200 <= r.status_code < 300:
                return True, "requests", ""
            errors.append(f"requests HTTP {r.status_code}")
        except Exception as e:
            errors.append(f"requests {type(e).__name__}: {str(e)[:120]}")

    try:
        import urllib.request as urlreq
        import urllib.error as urlerr
        req = urlreq.Request(url, data=body_text.encode("utf-8"),
                             headers={"Content-Type": "application/json", "User-Agent": "checker/1.0"},
                             method="POST")
        opener = urlreq.build_opener(urlreq.ProxyHandler({}))
        try:
            with opener.open(req, timeout=timeout) as resp:
                if 200 <= resp.status < 300:
                    return True, "urllib", ""
        except urlerr.HTTPError as he:
            errors.append(f"urllib HTTP {he.code}")
    except Exception as e:
        errors.append(f"urllib {type(e).__name__}: {str(e)[:120]}")

    return False, "none", " | ".join(errors)


class WebhookSender:
    RATE_LIMIT_PER_MIN = 25
    MAX_ATTEMPTS = 3

    def __init__(self, url: str):
        self.url = url.strip()
        self._queue: queue.Queue = queue.Queue()
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._request_times = deque()
        self._lock = threading.Lock()
        self._sent = 0
        self._failed = 0

    def start(self) -> bool:
        if self._thread is not None: return True
        self._thread = threading.Thread(target=self._run, daemon=True, name="webhook")
        self._thread.start()
        print(f"{GREY}[WEBHOOK] armed → {_mask_url(self.url)}{RESET}")
        return True

    def enqueue(self, username: str, mode_label: str) -> None:
        if not self.url: return
        self._queue.put_nowait((username, mode_label))

    def _wait_for_slot(self) -> None:
        while True:
            with self._lock:
                now = time.time()
                while self._request_times and self._request_times[0] < now - 60:
                    self._request_times.popleft()
                if len(self._request_times) < self.RATE_LIMIT_PER_MIN:
                    self._request_times.append(now); return
                wait_time = (self._request_times[0] + 60) - now
            if wait_time > 0:
                time.sleep(min(wait_time + 0.05, 5.0))

    def _run(self) -> None:
        try:
            while not self._stop.is_set() or not self._queue.empty():
                try:
                    username, mode_label = self._queue.get(timeout=0.5)
                except queue.Empty:
                    continue
                self._wait_for_slot()
                success = False
                for attempt in range(self.MAX_ATTEMPTS):
                    success, _b, _e = _try_send_webhook(self.url, username, mode_label)
                    if success: break
                    time.sleep(0.7 * (attempt + 1))
                with self._lock:
                    if success: self._sent += 1
                    else: self._failed += 1
        except Exception:
            pass

    def stop(self, drain_timeout: float = 15.0) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=drain_timeout)
        with self._lock:
            sent = self._sent; failed = self._failed
        if sent or failed:
            print(f"{GREY}[WEBHOOK] {sent} sent · {failed} failed{RESET}")


# ═══════════════════════════════════════════════════════════════════════════
# CHECKER ENGINE
# ═══════════════════════════════════════════════════════════════════════════

CF_MARKERS = ("cf-chl", "cf_chl", "challenge-platform", "cf-please-wait",
              "<!doctype html", "<html", "just a moment")


def _is_cf_challenge(body: str) -> bool:
    if not body: return False
    low = body[:500].lower()
    return any(m in low for m in CF_MARKERS)


class RouteState:
    __slots__ = ("cooldown_until", "consec_429", "circuit_open_until",
                 "inflight", "consec_fail", "dead_until")
    def __init__(self):
        self.cooldown_until = 0.0
        self.consec_429 = 0
        self.circuit_open_until = 0.0
        self.inflight = 0
        self.consec_fail = 0
        self.dead_until = 0.0

    def is_dead(self): return time.monotonic() < self.dead_until
    def mark_fail(self):
        self.consec_fail += 1
        if self.consec_fail >= PROXY_DEAD_STRIKES:
            self.dead_until = time.monotonic() + PROXY_DEAD_COOLDOWN
            self.consec_fail = 0
    def mark_ok(self): self.consec_fail = 0


class SessionHolder:
    __slots__ = ("session", "req_count", "proxy", "host", "backend")
    def __init__(self, session, proxy, host, backend):
        self.session = session
        self.proxy = proxy
        self.host = host
        self.backend = backend
        self.req_count = 0


class BucketTracker:
    def __init__(self):
        self._buckets = {}
        self._lock = threading.Lock()

    def update_from_headers(self, headers) -> None:
        try:
            bucket = headers.get("x-ratelimit-bucket")
            if not bucket: return
            remaining = headers.get("x-ratelimit-remaining")
            reset_after = headers.get("x-ratelimit-reset-after")
            if remaining is None or reset_after is None: return
            remaining = int(remaining)
            reset_after = float(reset_after)
            with self._lock:
                if len(self._buckets) >= BUCKET_TRACK_MAX:
                    self._buckets.clear()
                self._buckets[bucket] = {
                    "remaining": remaining,
                    "reset_at": time.monotonic() + reset_after,
                }
        except Exception:
            pass

    def should_back_off(self) -> float:
        with self._lock:
            now = time.monotonic()
            max_wait = 0.0
            for b, data in self._buckets.items():
                if data["reset_at"] <= now: continue
                if data["remaining"] <= max(1, int(RATELIMIT_SAFETY_PCT * 5)):
                    w = data["reset_at"] - now
                    if w > max_wait: max_wait = w
            return max_wait


class Checker:
    def __init__(self, timeout_ms: int, proxies: list):
        self.timeout = timeout_ms / 1000.0
        self.proxies = proxies
        self.route_index = 0
        self.lock = threading.Lock()
        self.local = threading.local()
        self.routes = {p: RouteState() for p in proxies}
        self.routes_lock = threading.Lock()
        self.buckets = BucketTracker()
        if not HAS_CURL_CFFI:
            print(f"{YELLOW}WARNING: curl_cffi not installed — using requests fallback.{RESET}")
            time.sleep(2)

    @staticmethod
    def _new_session(proxy, host):
        headers = _build_headers(host)
        if HAS_CURL_CFFI:
            s = CurlSession(impersonate=random.choice(IMPERSONATE_PROFILES))
            if proxy: s.proxies = {"http": proxy, "https": proxy}
            s.headers.update(headers)
            return s, "curl_cffi"
        elif HAS_TLS_CLIENT:
            ident = random.choice(["chrome_110", "chrome_116", "chrome_119", "chrome_120"])
            s = tls_client.Session(client_identifier=ident, random_tls_extension_order=True)
            if proxy: s.proxies = {"http": proxy, "https": proxy}
            s.headers.update(headers)
            return s, "tls_client"
        else:
            s = std_requests.Session()
            s.trust_env = False
            from requests.adapters import HTTPAdapter
            adapter = HTTPAdapter(pool_connections=24, pool_maxsize=24, max_retries=0)
            s.mount("https://", adapter)
            s.mount("http://", adapter)
            s.headers.update(headers)
            if proxy: s.proxies.update({"http": proxy, "https": proxy})
            return s, "requests"

    @staticmethod
    def _seed_cf(session, host):
        try: session.get(host + "/", timeout=6, allow_redirects=True)
        except Exception: pass

    def _route_state(self, proxy):
        with self.routes_lock:
            rs = self.routes.get(proxy)
            if rs is None:
                rs = RouteState(); self.routes[proxy] = rs
            return rs

    def _pick(self):
        if not self.proxies: return None, None, None
        bucket_wait = self.buckets.should_back_off()
        if bucket_wait > 0:
            time.sleep(min(bucket_wait, 2.0))
        now = time.monotonic()
        with self.lock:
            n = len(self.proxies); start = self.route_index
            self.route_index += 1
        chosen = None; best_wait = None
        for i in range(n):
            p = self.proxies[(start + i) % n]
            rs = self._route_state(p)
            if rs.is_dead() or rs.inflight >= MAX_PER_ROUTE: continue
            if rs.cooldown_until <= now and rs.circuit_open_until <= now:
                chosen = p; break
            w = max(rs.cooldown_until, rs.circuit_open_until) - now
            if best_wait is None or w < best_wait:
                best_wait = w; chosen = p
        if chosen is None:
            chosen = min(self.proxies,
                         key=lambda x: max(self._route_state(x).dead_until,
                                           self._route_state(x).cooldown_until,
                                           self._route_state(x).circuit_open_until))
        rs = self._route_state(chosen)
        with self.routes_lock: rs.inflight += 1
        host = random.choice(DISCORD_HOSTS)
        holders = getattr(self.local, "holders", None)
        if holders is None:
            holders = {}; self.local.holders = holders
        key = (chosen, host)
        holder = holders.get(key)
        if holder is None or holder.req_count >= SESSION_MAX_REQUESTS:
            if holder is not None:
                try: holder.session.close()
                except Exception: pass
            sess, backend = self._new_session(chosen, host)
            self._seed_cf(sess, host)
            holder = SessionHolder(sess, chosen, host, backend)
            holders[key] = holder
        return holder, chosen, host

    def _release(self, proxy):
        if proxy is None: return
        rs = self._route_state(proxy)
        with self.routes_lock:
            if rs.inflight > 0: rs.inflight -= 1

    def _drop_holder(self, holder):
        if holder is None: return
        holders = getattr(self.local, "holders", None)
        if not holders: return
        holders.pop((holder.proxy, holder.host), None)
        try: holder.session.close()
        except Exception: pass

    def _mark_429(self, proxy):
        rs = self._route_state(proxy)
        with self.routes_lock:
            rs.consec_429 += 1
            now = time.monotonic()
            if rs.consec_429 >= CIRCUIT_BREAK_THRESHOLD:
                rs.circuit_open_until = now + CIRCUIT_BREAK_SEC
                rs.consec_429 = 0
            else:
                rs.cooldown_until = now + ROUTE_COOLDOWN

    def _mark_ok(self, proxy):
        rs = self._route_state(proxy)
        with self.routes_lock:
            rs.consec_429 = 0; rs.mark_ok()

    def _mark_fail(self, proxy):
        rs = self._route_state(proxy)
        with self.routes_lock: rs.mark_fail()

    def check(self, username):
        holder, proxy, host = self._pick()
        if holder is None:
            return CheckResult("error", detail="no live proxy")
        url = host + DISCORD_PATH
        holder.req_count += 1
        try:
            start = time.perf_counter()
            try:
                r = holder.session.post(url, json={"username": username}, timeout=self.timeout)
            except Exception as e:
                self._drop_holder(holder); self._mark_fail(proxy)
                return CheckResult("error", detail=str(e)[:120])
            latency = (time.perf_counter() - start) * 1000
            status = r.status_code
            try: self.buckets.update_from_headers(r.headers)
            except Exception: pass
            body = ""
            try: body = r.text or ""
            except Exception: pass

            if _is_cf_challenge(body):
                self._mark_429(proxy); self._drop_holder(holder)
                return CheckResult("rate_limited", status or 403, detail="cf", latency_ms=latency)
            if status == 429:
                self._mark_429(proxy); self._drop_holder(holder)
                return CheckResult("rate_limited", 429, latency_ms=latency)
            if status == 407:
                self._drop_holder(holder); self._mark_fail(proxy)
                return CheckResult("error", 407, detail="proxy auth")
            if status in (401, 403):
                self._mark_429(proxy); self._drop_holder(holder)
                return CheckResult("rate_limited", status, latency_ms=latency)
            self._mark_ok(proxy)
            try: data = r.json()
            except Exception: return CheckResult("error", status, detail="non-json", latency_ms=latency)
            taken = data.get("taken")
            if isinstance(taken, bool):
                return CheckResult("taken" if taken else "available", status, latency_ms=latency)
            if data.get("rate_limited"):
                self._mark_429(proxy)
                return CheckResult("rate_limited", status, latency_ms=latency)
            self._mark_429(proxy)
            return CheckResult("rate_limited", status, latency_ms=latency)
        finally:
            self._release(proxy)


def _check_one(checker, name):
    last = None
    for _ in range(UNKNOWN_RETRY_ATTEMPTS):
        result = checker.check(name)
        if result.state in ("taken", "available"): return name, result
        last = result
    return name, last


# ═══════════════════════════════════════════════════════════════════════════
# RUNNER
# ═══════════════════════════════════════════════════════════════════════════

def run_checker(base, settings):
    proxies = load_proxies(base, settings)
    if not proxies:
        clear(); discord_banner()
        print(f"\n  {RED}No proxies loaded.{RESET}")
        print(f"  {YELLOW}Add them to {PROXY_FILE} (one per line) or use menu [3].{RESET}\n")
        input("  Press Enter to return..."); return

    effective_cps = settings.target_cps
    checker = Checker(settings.timeout_ms, proxies)
    gen = NameGenerator(settings.mode)
    history = PersistentHistory(base / HISTORY_FILE)
    mode_label = MODE_BY_ID[settings.mode][1]
    workers = worker_count_for(effective_cps, len(proxies))

    webhook_sender = None
    if settings.webhook:
        webhook_sender = WebhookSender(settings.webhook)
        webhook_sender.start()

    clear(); discord_banner()
    print(f"  {WHITE}MODE{RESET}       {mode_label}")
    print(f"  {WHITE}CONNECTION{RESET} {len(proxies)} proxies")
    print(f"  {WHITE}PACE{RESET}       {effective_cps:.1f} CPS    {WHITE}WORKERS{RESET} {workers}")
    print(f"  {WHITE}TOTAL{RESET}      {gen.total:,} combos")
    print("  " + "-" * 58)
    print()

    for i in range(READY_DELAY_SEC, 0, -1):
        print(f"\r  {GREY}Starting in {i}...{RESET}", end="", flush=True)
        time.sleep(1)
    print(f"\r  {GREEN}GO!{RESET}                     ")
    print()

    checked = taken = unknown = available = limited = 0
    results_path = base / RESULTS_FILE
    results_path.parent.mkdir(parents=True, exist_ok=True)

    TAG_TAKEN = f"{RED}TAKEN{RESET}    "
    TAG_AVAILABLE = f"{GREEN}AVAILABLE{RESET}"

    try:
        while True:
            try:
                with results_path.open("a", encoding="utf-8") as results_file, ThreadPoolExecutor(
                    max_workers=workers, thread_name_prefix="discord"
                ) as pool:
                    inflight = {}
                    next_submit = time.monotonic()
                    while True:
                        now = time.monotonic()
                        while len(inflight) < workers and now >= next_submit:
                            name = gen.next()
                            fut = pool.submit(_check_one, checker, name)
                            inflight[fut] = name
                            interval = 1.0 / max(MIN_CPS, effective_cps)
                            next_submit += interval
                            if next_submit < now - 0.05: next_submit = now
                            now = time.monotonic()
                        if not inflight:
                            time.sleep(0.002); continue
                        done, _ = wait(tuple(inflight), timeout=0.004, return_when=FIRST_COMPLETED)
                        if not done: continue
                        for fut in done:
                            name = inflight.pop(fut, "?")
                            try: _name, result = fut.result()
                            except Exception: continue
                            state = result.state
                            if state == "taken":
                                checked += 1; taken += 1
                                if settings.show_taken:
                                    print(f"{TAG_TAKEN} {name:<20} "
                                          f"{GREY}{format_stats(checked, taken, available, limited)}{RESET}")
                            elif state == "available":
                                checked += 1; available += 1
                                print(f"{TAG_AVAILABLE} {name:<20} "
                                      f"{GREY}{format_stats(checked, taken, available, limited)}{RESET}")
                                try:
                                    results_file.write(name + "\n"); results_file.flush()
                                except OSError: pass
                                try: history.claim(name)
                                except Exception: pass
                                if webhook_sender: webhook_sender.enqueue(name, mode_label)
                            elif state == "rate_limited":
                                checked += 1; taken += 1
                            else:
                                pass
            except KeyboardInterrupt:
                raise
            except Exception as exc:
                print(f"{YELLOW} RECOVER   {RESET} {str(exc)[:120]}")
                time.sleep(0.35)
    except KeyboardInterrupt:
        print("\n" + GREY + "Stopped." + RESET)
    finally:
        if webhook_sender: webhook_sender.stop()
        history.close()
        print(format_stats(checked, taken, available, limited))


# ═══════════════════════════════════════════════════════════════════════════
# DISCORD MENU
# ═══════════════════════════════════════════════════════════════════════════

def clear() -> None:
    os.system("cls" if os.name == "nt" else "clear")


def discord_banner() -> None:
    print(RED + "=" * 62)
    print("        Universal GT Checker — Discord")
    print("=" * 62 + RESET)


def looks_like_discord_webhook(url):
    u = url.strip()
    return (u.startswith("https://discord.com/api/webhooks/") or
            u.startswith("https://discordapp.com/api/webhooks/") or
            u.startswith("https://canary.discord.com/api/webhooks/") or
            u.startswith("https://ptb.discord.com/api/webhooks/"))


YIELD_HINT = {
    "semi_3c_both": "low", "semi_3c_dot": "low", "semi_3c_under": "low",
    "semi_3n_both": "low", "semi_3n_dot": "low", "semi_3n_under": "low",
    "semi_4n_both": "med", "semi_4n_dot": "med", "semi_4n_under": "med",
    "2c": "dead", "3c_smart": "dead", "4c_smart": "dead",
    "5c": "~0.3%", "3l": "dead", "4l": "~0.1%", "5l": "~1.5%",
    "3n": "dead", "4n": "~0.05%", "5n": "~0.5%",
    "word_short": "~5%", "word_rare": "~15%", "word_obscure": "~30%",
    "word_all": "~20%", "word_sep": "~25%",
    "word_join": "~25%", "word_dict": "~20%", "word_dict_join": "~30%",
    "word_mega_join": "~35%", "word_num_word": "~50%",
}


def choose_mode(settings):
    clear(); discord_banner()
    print(RED + "\nChoose username type\n" + RESET)
    print(f"{GREY}MIX is the highest-yield — hits within seconds.{RESET}\n")
    for key, (mid, label, example) in MODE_MAP.items():
        marker = GREEN + "*" + RESET if settings.mode == mid else " "
        yh = YIELD_HINT.get(mid, "?")
        star = f"{GREEN}*{RESET}" if mid in ("word_num_word", "word_mega_join",
                                              "word_dict_join", "word_obscure") else " "
        print(f" {marker}{star}[{key:>2}] {label:<22} {GREY}{yh:<12}{RESET} {GREY}{example}{RESET}")
    print(f"\n  {GREEN}* = best yield{RESET}")
    print("\n  [0] Back")
    val = input("\nSelect: ").strip()
    if val in MODE_MAP: settings.mode = MODE_MAP[val][0]
    elif val.upper() in MODE_MAP: settings.mode = MODE_MAP[val.upper()][0]


def choose_speed(settings):
    print(f"\nCurrent target: {settings.target_cps:.1f} CPS")
    raw = input(f"Target CPS ({MIN_CPS:g}-{MAX_CPS:g}, blank keeps current): ").strip()
    if not raw: return
    try: settings.target_cps = max(MIN_CPS, min(MAX_CPS, float(raw)))
    except ValueError: print(YELLOW + "Invalid CPS." + RESET)


def choose_connection(base, settings):
    while True:
        clear(); discord_banner()
        proxies = load_proxies(base, settings)
        print(RED + "\nConnection\n" + RESET)
        print(f"  [1] Load proxies from {PROXY_FILE} ({len(proxies)} found)")
        print("  [2] Paste proxy/proxy list now")
        print("  [0] Back")
        choice = input("\nSelect: ").strip()
        if choice == "0": return
        if choice == "1":
            settings.proxies = ""
            print(GREEN + f"Using {len(load_proxies(base, settings))} proxies.{RESET}")
            input("Press Enter...")
        elif choice == "2":
            print("Paste proxies. One per line. Blank line when done.")
            rows = []
            while True:
                row = input().strip()
                if not row: break
                rows.append(row)
            settings.proxies = "\n".join(rows)
            print(GREEN + f"Stored {len(rows)} proxies.{RESET}")
            input("Press Enter...")


def choose_webhook(settings):
    clear(); discord_banner(); print(RED + "\nDiscord webhook\n" + RESET)
    if settings.webhook:
        print(f"{GREY}Current: {_mask_url(settings.webhook)}{RESET}\n")
    print("  [1] Set / replace webhook URL")
    print("  [2] Send test")
    print("  [3] Clear webhook")
    print("  [0] Back")
    ch = input("\nSelect: ").strip()
    if ch == "1":
        url = input("Paste Discord webhook URL: ").strip()
        if not looks_like_discord_webhook(url):
            print(YELLOW + "Invalid webhook URL." + RESET)
            input("Press Enter..."); return
        settings.webhook = url
        print(GREEN + "Webhook saved." + RESET)
        ok, _b, err = _try_send_webhook(url, "test_username", "Test")
        print((GREEN + "Test sent." if ok else RED + f"Failed: {err}") + RESET)
        input("Press Enter...")
    elif ch == "2":
        if not settings.webhook:
            print(YELLOW + "Set a webhook first." + RESET); input("Press Enter..."); return
        ok, _b, err = _try_send_webhook(settings.webhook, "test", "Test")
        print((GREEN + "Sent." if ok else RED + f"{err}") + RESET)
        input("Press Enter...")
    elif ch == "3":
        settings.webhook = ""


def print_status(settings, proxies, history_count):
    mode = MODE_BY_ID[settings.mode][1]
    conn = f"{len(proxies)} proxies" if proxies else f"{RED}NO PROXIES{RESET}"
    wh = "enabled" if settings.webhook else "disabled"
    print(GREY + f"Mode: {mode} | Connection: {conn} | Webhook: {wh} | History: {history_count}" + RESET)


def discord_main():
    base = Path(__file__).resolve().parent.parent
    settings = load_settings(base)

    while True:
        clear(); discord_banner()
        proxies = load_proxies(base, settings)
        print_status(settings, proxies, history_count=0)
        print()
        print("  [1] Start checker")
        print("  [2] Choose username type")
        print("  [3] Choose connection / proxies")
        print("  [4] Target CPS")
        print("  [5] Discord webhook")
        print("  [6] Save current settings")
        print("  [7] Toggle show TAKEN")
        print("  [0] Back to main menu")
        print()
        choice = input("Select: ").strip()

        if choice == "0": return
        if choice == "1": run_checker(base, settings)
        elif choice == "2": choose_mode(settings)
        elif choice == "3": choose_connection(base, settings)
        elif choice == "4": choose_speed(settings)
        elif choice == "5": choose_webhook(settings)
        elif choice == "6":
            save_settings(base, settings)
            print(GREEN + "Settings saved." + RESET)
            time.sleep(0.8)
        elif choice == "7":
            settings.show_taken = not settings.show_taken
