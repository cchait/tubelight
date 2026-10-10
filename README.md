# tubelight

A kids' video site that shows **only the YouTube channels and videos a parent
has allowlisted**. It hosts no video and has no YouTube search, no comments, no
recommendations and no links out. The search box only filters the videos
already on the shelves. Everything plays through YouTube's own embedded
player on `www.youtube-nocookie.com`.

The site itself cannot stop a child from opening youtube.com. Enforcement
happens on the kids' devices: block `youtube.com`, `www.youtube.com` and
`m.youtube.com` in DNS, and leave `youtube-nocookie.com`, `googlevideo.com`
and `ytimg.com` open. With those three hosts blocked the embedded player still
plays, and the YouTube logo inside the player leads to a dead page.

Live demo of the layout (with the example allowlist):
<https://cchait.github.io/tubelight/>

## What it is not

- **Not a downloader.** Nothing is copied or cached. Videos stream from
  YouTube exactly as any embed does.
- **Not a circumvention tool.** It does not hide ads, strip branding or modify
  the player. YouTube's terms forbid that, and tubelight adds nothing inside
  the iframe.
- **Not a filter.** It does not inspect content. It shows what you list and
  nothing else, so the quality of the experience is the quality of your list.

## How it works

```
allowlist.yaml  ──refresh.py──▶  docs/catalog.json  ──GitHub Pages──▶  phone / tablet
 (you edit)      (daily Action)   (titles, thumbs)                    (embedded player)
```

- `allowlist.yaml` is the only file you edit: shelves of channel handles,
  playlists and single videos, plus a few settings and a block list.
- `refresh.py` resolves handles once (cached in `docs/channels.json`), reads
  each channel's uploads playlist, fetches durations and view counts, applies
  your settings and writes `docs/catalog.json`. It uses only 1-unit API calls
  and prints the quota it spent. A typical allowlist of ten channels costs
  about 40 units of the 10,000 you get per day; fifty channels about 200.
- Each shelf shows the newest `max_videos_per_channel` videos per channel as a
  rolling window: new uploads appear after the next refresh and the oldest
  drop off. View counts and "3 days ago" labels are as of the last refresh.
- `docs/` is a static site: shelves of thumbnails on `index.html`, the player
  on `watch.html?v=<id>`. It refuses to play any id that is not in the catalog.
- A GitHub Action runs the refresh every day at 02:00 UTC and commits the
  catalog only when something changed.

## Setup

1. **Fork this repository** (or click "Use this template").
2. **Get a YouTube Data API v3 key.** In [Google Cloud Console](https://console.cloud.google.com/)
   create a project, enable *YouTube Data API v3* under *APIs & Services*, then
   *Credentials → Create credentials → API key*. Restrict the key to the
   YouTube Data API. It is free and the default quota is plenty.
3. **Add the key as a repository secret** named `YT_API_KEY`:
   *Settings → Secrets and variables → Actions → New repository secret*.
4. **Edit `allowlist.yaml`.** Replace the example handles with your own.
   Handles (`@name`) are in the URL of any channel page; video ids are the 11
   characters after `v=`.
5. **Enable GitHub Pages**: *Settings → Pages → Source: Deploy from a branch →
   `main` / `/docs`*. Your site will be at `https://<you>.github.io/tubelight/`.
6. **Run the workflow once**: *Actions → Refresh catalog → Run workflow*.
   On a fork you first have to click *"I understand my workflows, go ahead and
   enable them"* on the Actions tab. From then on it runs daily.

Each time you change the allowlist, either wait for the nightly run or trigger
the workflow by hand.

### Allowlist format

```yaml
settings:
  min_duration_seconds: 180      # drops Shorts
  max_videos_per_channel: 30
  exclude_live: true

blocked_videos:                  # hidden even if the channel is allowed
  - "dQw4w9WgXcQ"

shelves:
  - name: Music lessons
    channels: ["@handle", "UCxxxxxxxxxxxxxxxxxxxxxx"]   # handles or channel ids
    playlists: ["PLxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"]
    videos: ["dQw4w9WgXcQ"]                              # always shown, filters do not apply
```

### Local preview

```sh
pip install -r requirements.txt
YT_API_KEY=your-key python refresh.py
python3 -m http.server 8000 -d docs
```

Then open <http://localhost:8000/>. Do not open the HTML from `file://`: the
YouTube embed returns **error 153** without an http(s) origin.

## Enforcement on the kids' devices

tubelight only works together with a block on the kids' devices. The rule is
simple:

| Host                         | Action | Why                                    |
| ---------------------------- | ------ | -------------------------------------- |
| `youtube.com`                | block  | the full site                          |
| `www.youtube.com`            | block  | the full site, and the logo/title link |
| `m.youtube.com`              | block  | the mobile site                        |
| `www.youtube-nocookie.com`   | allow  | the embedded player                    |
| `*.googlevideo.com`          | allow  | the video stream                       |
| `*.ytimg.com`                | allow  | thumbnails and player assets           |
| `yt3.ggpht.com`              | allow  | channel avatars (cosmetic, optional)   |

### AdGuard Home / AdGuard DNS

In *Filters → Custom filtering rules*:

```
||youtube.com^
@@||youtube-nocookie.com^
@@||googlevideo.com^
@@||ytimg.com^
```

Point the kids' devices (or your router's DHCP) at the AdGuard Home server and
turn off "secure DNS"/DoH in their browsers so they cannot bypass it. Pi-hole,
NextDNS and most router parental controls can express the same rule: block the
domain `youtube.com` including subdomains, and allow the three others.

### Test it on a laptop first

Add these lines to your hosts file (`/etc/hosts` on macOS/Linux,
`C:\Windows\System32\drivers\etc\hosts` on Windows, as administrator):

```
0.0.0.0 youtube.com
0.0.0.0 www.youtube.com
0.0.0.0 m.youtube.com
```

Flush DNS (`sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder` on
macOS, `ipconfig /flushdns` on Windows), disable "Use secure DNS" in the
browser for the test, and open your tubelight site. Videos should play.
Clicking the YouTube logo in the player should lead to a page that does not
load. Remove the lines afterwards.

## Known limits

- **The YouTube app** does not use the browser and is not affected by this
  block, so remove it or block it with the device's parental controls (Screen
  Time on iOS, Family Link on Android).
- **The end-of-video screen** is YouTube's. With `rel=0` the suggestions come
  from the same channel, but they are still YouTube's choice, not yours.
- **A fixed allowlist needs pruning.** Channels change direction; glance at
  the shelves every few weeks and use `blocked_videos` for one-offs.
- **Shorts are filtered by duration**, so a channel that only posts Shorts
  will show nothing. Lower `min_duration_seconds` if that is what you want.
- **DNS blocking is only as good as the device's DNS.** Browsers with
  DNS-over-HTTPS enabled, VPNs and mobile data all bypass a home DNS server.

## Privacy

The site sets no cookies and loads nothing from third parties except YouTube's
player and thumbnails. "Continue watching" is kept in the browser's
localStorage on the device and never leaves it. The `youtube-nocookie.com`
embed is YouTube's privacy-enhanced mode; see Google's privacy policy for what
it does and does not store.

## License

[MIT](LICENSE).
