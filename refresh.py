#!/usr/bin/env python3
"""Build docs/catalog.json from allowlist.yaml using the YouTube Data API v3.

videos.list is asked for snippet, contentDetails and statistics in one call, so
view counts cost no extra quota.

Quota notes (1 unit each, never search.list which costs 100):
  channels.list      one call per unresolved handle, one per 50 channel IDs
  playlistItems.list one call per page of 50 items
  videos.list        one call per 50 video IDs

Usage: YT_API_KEY=... python refresh.py
"""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

import requests
import yaml

API = "https://www.googleapis.com/youtube/v3"
ROOT = Path(__file__).resolve().parent
ALLOWLIST = ROOT / "allowlist.yaml"
DOCS = ROOT / "docs"
CATALOG = DOCS / "catalog.json"
CHANNELS_CACHE = DOCS / "channels.json"

VIDEO_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")
DURATION = re.compile(
    r"^P(?:(?P<d>\d+)D)?(?:T(?:(?P<h>\d+)H)?(?:(?P<m>\d+)M)?(?:(?P<s>\d+)S)?)?$"
)

DEFAULTS = {
    "min_duration_seconds": 180,
    "max_videos_per_channel": 30,
    "exclude_live": True,
    "max_pages_per_source": 4,
}


class RefreshError(Exception):
    """A problem that should stop the run with a readable message."""


def warn(msg: str) -> None:
    print(f"warning: {msg}", file=sys.stderr)


# --------------------------------------------------------------------------- API


class YouTube:
    def __init__(self, key: str):
        self.key = key
        self.session = requests.Session()
        self.quota = 0

    def get(self, endpoint: str, **params) -> dict:
        params["key"] = self.key
        self.quota += 1
        try:
            resp = self.session.get(f"{API}/{endpoint}", params=params, timeout=30)
        except requests.RequestException as exc:
            raise RefreshError(f"network error calling {endpoint}: {exc}") from exc
        if resp.status_code == 200:
            return resp.json()
        try:
            err = resp.json()["error"]
            reason = (err.get("errors") or [{}])[0].get("reason", "")
            message = err.get("message", resp.text)
        except (ValueError, KeyError, TypeError):
            reason, message = "", resp.text[:300]
        if reason == "quotaExceeded":
            raise RefreshError(
                "YouTube API quota exceeded for today (10,000 units by default). "
                "Lower max_videos_per_channel or wait until the quota resets at midnight Pacific time."
            )
        if resp.status_code in (400, 403) and reason in ("keyInvalid", "forbidden", "accessNotConfigured"):
            raise RefreshError(
                f"YouTube API rejected the key ({reason}): {message}\n"
                "Check that YT_API_KEY is correct and that 'YouTube Data API v3' is enabled in Google Cloud."
            )
        raise RefreshError(f"YouTube API error {resp.status_code} on {endpoint} ({reason}): {message}")

    def paged(self, endpoint: str, max_pages: int, **params):
        token = None
        for _ in range(max_pages):
            if token:
                params["pageToken"] = token
            data = self.get(endpoint, **params)
            yield data
            token = data.get("nextPageToken")
            if not token:
                break


# ----------------------------------------------------------------------- helpers


def chunks(seq: list, n: int):
    for i in range(0, len(seq), n):
        yield seq[i : i + n]


def parse_duration(iso: str) -> int:
    m = DURATION.match(iso or "")
    if not m:
        return 0
    d, h, mi, s = (int(m.group(k) or 0) for k in ("d", "h", "m", "s"))
    return d * 86400 + h * 3600 + mi * 60 + s


def best_thumbnail(thumbs: dict, vid: str) -> str:
    for size in ("medium", "high", "standard", "default"):
        if size in thumbs and thumbs[size].get("url"):
            return thumbs[size]["url"]
    return f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg"


def load_allowlist() -> dict:
    if not ALLOWLIST.exists():
        raise RefreshError(f"{ALLOWLIST.name} not found next to refresh.py")
    try:
        data = yaml.safe_load(ALLOWLIST.read_text(encoding="utf-8")) or {}
    except yaml.YAMLError as exc:
        raise RefreshError(f"{ALLOWLIST.name} is not valid YAML: {exc}") from exc
    if not isinstance(data, dict):
        raise RefreshError(f"{ALLOWLIST.name} must be a mapping with settings/blocked_videos/shelves")
    settings = {**DEFAULTS, **(data.get("settings") or {})}
    for key in ("min_duration_seconds", "max_videos_per_channel", "max_pages_per_source"):
        if not isinstance(settings[key], int) or settings[key] < 0:
            raise RefreshError(f"settings.{key} must be a non-negative integer")
    blocked = set()
    for vid in data.get("blocked_videos") or []:
        if not VIDEO_ID.match(str(vid)):
            raise RefreshError(f"blocked_videos entry {vid!r} is not an 11-character video id")
        blocked.add(str(vid))
    shelves = data.get("shelves") or []
    if not isinstance(shelves, list) or not shelves:
        raise RefreshError("allowlist.yaml needs at least one shelf under 'shelves:'")
    clean = []
    for i, shelf in enumerate(shelves, 1):
        if not isinstance(shelf, dict) or not shelf.get("name"):
            raise RefreshError(f"shelf #{i} needs a 'name'")
        for vid in shelf.get("videos") or []:
            if not VIDEO_ID.match(str(vid)):
                raise RefreshError(f"shelf {shelf['name']!r}: video id {vid!r} is not 11 characters")
        clean.append(
            {
                "name": str(shelf["name"]),
                "channels": [str(c).strip() for c in shelf.get("channels") or []],
                "playlists": [str(p).strip() for p in shelf.get("playlists") or []],
                "videos": [str(v).strip() for v in shelf.get("videos") or []],
            }
        )
    return {"settings": settings, "blocked": blocked, "shelves": clean}


def load_cache() -> dict:
    if CHANNELS_CACHE.exists():
        try:
            cache = json.loads(CHANNELS_CACHE.read_text(encoding="utf-8"))
            if isinstance(cache, dict):
                cache.setdefault("handles", {})
                cache.setdefault("channels", {})
                return cache
        except ValueError:
            warn(f"{CHANNELS_CACHE.name} is unreadable, rebuilding it")
    return {"handles": {}, "channels": {}}


def write_json(path: Path, data) -> bool:
    """Write deterministic JSON. Returns True if the file content changed."""
    text = json.dumps(data, indent=1, sort_keys=True, ensure_ascii=False) + "\n"
    old = path.read_text(encoding="utf-8") if path.exists() else None
    if old == text:
        return False
    path.write_text(text, encoding="utf-8")
    return True


# ---------------------------------------------------------------------- resolve


def resolve_channels(yt: YouTube, refs: list[str], cache: dict) -> dict[str, str]:
    """Map each handle or channel id in refs to a channel id, filling the cache."""
    result: dict[str, str] = {}
    need_meta: list[str] = []
    for ref in refs:
        if ref.startswith("@"):
            handle = ref.lower()
            cid = cache["handles"].get(handle)
            if not cid:
                data = yt.get("channels", part="snippet,contentDetails", forHandle=ref)
                items = data.get("items") or []
                if not items:
                    warn(f"handle {ref} not found on YouTube, skipping")
                    continue
                cid = items[0]["id"]
                cache["handles"][handle] = cid
                cache["channels"][cid] = channel_meta(items[0])
            result[ref] = cid
        elif ref.startswith("UC") and len(ref) == 24:
            result[ref] = ref
        else:
            warn(f"channel {ref!r} is neither an @handle nor a UC... id, skipping")
            continue
        if "avatar" not in cache["channels"].get(result[ref], {}):
            need_meta.append(result[ref])  # not cached, or cached before avatars were stored
    for batch in chunks(sorted(set(need_meta)), 50):
        data = yt.get("channels", part="snippet,contentDetails", id=",".join(batch))
        for item in data.get("items") or []:
            cache["channels"][item["id"]] = channel_meta(item)
    for ref, cid in list(result.items()):
        if cid not in cache["channels"]:
            warn(f"channel {ref} ({cid}) not found on YouTube, skipping")
            del result[ref]
    return result


def channel_meta(item: dict) -> dict:
    thumbs = item["snippet"].get("thumbnails") or {}
    avatar = (thumbs.get("default") or thumbs.get("medium") or {}).get("url", "")
    return {
        "title": item["snippet"]["title"],
        "handle": item["snippet"].get("customUrl", ""),
        "uploads": item["contentDetails"]["relatedPlaylists"]["uploads"],
        "avatar": avatar,
    }


# ------------------------------------------------------------------------ fetch


def fetch_videos(yt: YouTube, ids: list[str]) -> dict[str, dict]:
    """videos.list in batches of 50. Returns id -> normalized video dict."""
    out: dict[str, dict] = {}
    for batch in chunks(ids, 50):
        data = yt.get("videos", part="snippet,contentDetails,statistics", id=",".join(batch), maxResults=50)
        for item in data.get("items") or []:
            sn, cd = item["snippet"], item["contentDetails"]
            views = (item.get("statistics") or {}).get("viewCount")  # absent when the uploader hides it
            out[item["id"]] = {
                "views": int(views) if views is not None else None,
                "id": item["id"],
                "title": sn.get("title", ""),
                "channel": sn.get("channelTitle", ""),
                "channelId": sn.get("channelId", ""),
                "published": sn.get("publishedAt", ""),
                "duration": parse_duration(cd.get("duration", "")),
                "live": sn.get("liveBroadcastContent", "none"),
                "thumbnail": best_thumbnail(sn.get("thumbnails") or {}, item["id"]),
            }
    return out


def keep(video: dict, settings: dict, blocked: set) -> bool:
    if video["id"] in blocked:
        return False
    if settings["exclude_live"] and video["live"] != "none":
        return False
    if video["duration"] < settings["min_duration_seconds"]:
        return False
    return True


def videos_from_playlist(yt: YouTube, playlist_id: str, settings: dict, blocked: set, label: str) -> list[dict]:
    """Walk a playlist newest-first, filter, stop once max_videos_per_channel are kept."""
    limit = settings["max_videos_per_channel"]
    kept: list[dict] = []
    seen: set[str] = set()
    if limit == 0:
        return kept
    try:
        pages = yt.paged(
            "playlistItems",
            settings["max_pages_per_source"],
            part="contentDetails",
            playlistId=playlist_id,
            maxResults=50,
        )
        for page in pages:
            ids = []
            for item in page.get("items") or []:
                vid = item["contentDetails"].get("videoId")
                if vid and vid not in seen:
                    seen.add(vid)
                    ids.append(vid)
            found = fetch_videos(yt, ids)
            for vid in ids:  # preserve playlist order (newest first for uploads)
                v = found.get(vid)
                if v and keep(v, settings, blocked):
                    kept.append(v)
                    if len(kept) >= limit:
                        return kept
    except RefreshError as exc:
        if "playlistNotFound" in str(exc) or "404" in str(exc):
            warn(f"{label}: playlist {playlist_id} not found, skipping")
            return kept
        raise
    return kept


def public_video(v: dict) -> dict:
    return {k: v[k] for k in ("id", "title", "channel", "channelId", "published", "duration", "views", "thumbnail")}


def build_shelf(yt: YouTube, shelf: dict, settings: dict, blocked: set, cache: dict) -> dict:
    name = shelf["name"]
    collected: dict[str, dict] = {}

    channel_ids = resolve_channels(yt, shelf["channels"], cache)
    for ref, cid in channel_ids.items():
        uploads = cache["channels"][cid]["uploads"]
        vids = videos_from_playlist(yt, uploads, settings, blocked, f"{name} / {ref}")
        for v in vids:
            collected.setdefault(v["id"], v)
        print(f"  {ref}: {len(vids)} videos")

    for pl in shelf["playlists"]:
        vids = videos_from_playlist(yt, pl, settings, blocked, f"{name} / playlist {pl}")
        for v in vids:
            collected.setdefault(v["id"], v)
        print(f"  playlist {pl}: {len(vids)} videos")

    singles = [v for v in shelf["videos"] if v not in collected]
    if singles:
        found = fetch_videos(yt, singles)
        for vid in singles:
            if vid in blocked:
                warn(f"{name}: video {vid} is in blocked_videos, not shown")
            elif vid in found:
                collected[vid] = found[vid]  # single videos bypass duration/live filters
            else:
                warn(f"{name}: video {vid} not found on YouTube, skipping")
        print(f"  single videos: {len([v for v in singles if v in collected])}")

    videos = sorted(collected.values(), key=lambda v: (v["published"], v["id"]), reverse=True)

    # Channels of this shelf: allowlisted ones first, in allowlist order, then any
    # other channel that appeared through a playlist or a single video.
    order: list[str] = []
    for cid in channel_ids.values():
        if cid not in order:
            order.append(cid)
    for v in videos:
        if v["channelId"] and v["channelId"] not in order:
            order.append(v["channelId"])
    counts: dict[str, int] = {}
    names: dict[str, str] = {}
    for v in videos:
        counts[v["channelId"]] = counts.get(v["channelId"], 0) + 1
        names.setdefault(v["channelId"], v["channel"])
    shelf_channels = [
        {
            "id": cid,
            "name": cache["channels"].get(cid, {}).get("title") or names.get(cid, ""),
            "avatar": cache["channels"].get(cid, {}).get("avatar", ""),
            "count": counts.get(cid, 0),
        }
        for cid in order
        if counts.get(cid)
    ]
    return {"name": name, "channels": shelf_channels, "videos": [public_video(v) for v in videos]}


# ------------------------------------------------------------------------- main


def main() -> int:
    key = os.environ.get("YT_API_KEY", "").strip()
    if not key:
        print(
            "refresh.py: YT_API_KEY is not set.\n"
            "Create a YouTube Data API v3 key in Google Cloud and run:\n"
            "  YT_API_KEY=your-key python refresh.py",
            file=sys.stderr,
        )
        return 2

    allow = load_allowlist()
    settings, blocked = allow["settings"], allow["blocked"]
    cache = load_cache()
    yt = YouTube(key)
    DOCS.mkdir(exist_ok=True)

    shelves = []
    for shelf in allow["shelves"]:
        print(f"shelf: {shelf['name']}")
        shelves.append(build_shelf(yt, shelf, settings, blocked, cache))

    # Avatars for the channels we know (allowlisted ones). Playlist videos from
    # other channels simply have no avatar and the site shows an initial instead.
    used = {v["channelId"] for s in shelves for v in s["videos"]}
    channels = {
        cid: {"name": cache["channels"][cid]["title"], "avatar": cache["channels"][cid].get("avatar", "")}
        for cid in sorted(used)
        if cid in cache["channels"]
    }
    catalog = {
        "version": 3,
        "channels": channels,
        "settings": {
            "min_duration_seconds": settings["min_duration_seconds"],
            "max_videos_per_channel": settings["max_videos_per_channel"],
            "exclude_live": bool(settings["exclude_live"]),
        },
        "shelves": shelves,
    }
    cache["handles"] = dict(sorted(cache["handles"].items()))
    cache["channels"] = dict(sorted(cache["channels"].items()))

    changed_catalog = write_json(CATALOG, catalog)
    changed_cache = write_json(CHANNELS_CACHE, cache)

    total = sum(len(s["videos"]) for s in shelves)
    print(
        f"\n{total} videos across {len(shelves)} shelves -> docs/{CATALOG.name}"
        f" ({'updated' if changed_catalog else 'unchanged'}),"
        f" docs/{CHANNELS_CACHE.name} ({'updated' if changed_cache else 'unchanged'})"
    )
    print(f"estimated quota used: {yt.quota} units (daily default is 10,000)")
    if total == 0:
        warn("the catalog is empty; check the handles in allowlist.yaml")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except RefreshError as exc:
        print(f"refresh.py: {exc}", file=sys.stderr)
        sys.exit(1)
    except KeyboardInterrupt:
        sys.exit(130)
