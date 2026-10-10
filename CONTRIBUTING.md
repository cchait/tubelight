# Contributing to tubelight

Thanks for helping. tubelight is deliberately small: a static site, one Python
script and one workflow. Please keep it that way.

## Ground rules

- **No framework, no build step.** The site stays plain HTML, CSS and JS that
  GitHub Pages can serve as-is.
- **Only `requests` and `pyyaml`** as Python dependencies for `refresh.py`.
- **Never call `search.list`.** It costs 100 quota units; everything we need is
  available for 1 unit per call.
- **Respect YouTube's terms.** Do not overlay, crop, resize or restyle the
  embedded player, hide its branding, or add anything that downloads video.
  Everything we add lives outside the iframe.
- **No YouTube search.** The search box filters `catalog.json` in the browser
  and must never call YouTube; the allowlist is the whole universe.
- **No external links.** The site must not link to youtube.com or anywhere
  else. Kids use this with youtube.com blocked at DNS; a link that leads to a
  dead page is confusing, a link that works is a hole.
- **Deterministic output.** `refresh.py` must produce byte-identical
  `catalog.json` for identical API data, so the daily Action only commits real
  changes. No timestamps in generated files.

## Local development

```sh
pip install -r requirements.txt
YT_API_KEY=your-key python refresh.py
python3 -m http.server 8000 -d docs
```

Open <http://localhost:8000/>. Opening `docs/index.html` from `file://` does
not work: the embed returns error 153 without an http(s) origin.

Before opening a pull request, check in DevTools (Network tab) that no request
goes to `www.youtube.com` or `m.youtube.com`.

## Reporting problems

Open an issue with your `allowlist.yaml` (remove anything private), the output
of `refresh.py`, and your browser and device if the problem is on the site.
