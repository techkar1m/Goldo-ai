[README (1).md](https://github.com/user-attachments/files/31027185/README.1.md)
# Goldo — Investor Matching (landing page)

A single-page site that embeds the Goldo Botpress chatbot. The public URL goes
on page 1 of the assignment report and is what you screen-record for the demo.

## Files
- `index.html` — the whole site (styles and the Botpress embed are inline)

## Deploy on GitHub Pages (free, ~5 minutes)

1. Create a GitHub account if you don't have one, at github.com.
2. **New repository** → name it e.g. `goldo` → Public → Create.
3. On the repo page: **Add file → Upload files** → drag in `index.html` →
   **Commit changes**.
4. **Settings → Pages** (left sidebar).
5. Under **Build and deployment → Source**, choose **Deploy from a branch**.
6. Branch: **main**, folder: **/ (root)** → **Save**.
7. Wait ~1 minute, then refresh. Pages shows your live URL, like:
   `https://YOUR-USERNAME.github.io/goldo/`

Open it in a private window to confirm the chat button appears bottom-right and
the "Open Goldo" button launches it.

## Updating the bot later
The page loads the bot from Botpress's CDN, so any change you publish in
Botpress appears on the site automatically — no need to re-upload `index.html`.
Only re-upload if you change the page itself.

## If the chat doesn't appear
- Confirm the bot is **published** in Botpress (Publish button, top right).
- Confirm Webchat is **enabled** and **shared/public** in Botpress → Channels.
- Check the two `<script>` tags at the bottom of `index.html` still match the
  embed snippet in Botpress → Webchat → Share (they can change if you recreate
  the bot).
