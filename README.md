# Bobble Run guest bot

Autoplays https://unboxbobble.com/run in **guest mode only**: dodges obstacles and collects coins.

```bash
# requires Node.js 20+
npm install
npx playwright install chromium
npm run bot                       # 1 run, headless
npm run bot -- --runs=3 --headed  # visible browser, 3 runs
npm run bot -- --maxSeconds=120 --screenshot=/tmp/shot
```

How it works: the page's `game.js` is patched on load so the game's built-in demo AI
(the one playing on the title screen) also drives guest runs.

Runs are never saved or submitted: fresh browser profile without a wallet, every request
except static game assets is aborted (`/api/*`, analytics), and the bot exits if auth is detected.
If the site updates `game.js` and the hook is not found, the bot stops with an error.
