# Bobble Run bot

Autoplays https://unboxbobble.com/run using the game's own built-in demo AI: dodges obstacles and collects coins.
Requires **Node.js 20+**.

```bash
npm install
npx playwright install chromium
```

## Control panel (recommended)

```bash
npm run ui            # or double-click start-panel.bat on Windows
```

Opens http://127.0.0.1:5577 (only reachable from this computer). There you add profiles, set the proxy
(shared by all profiles) and per-profile score/coin limits, and use Start / Pause after run / Resume /
End run / Stop buttons with live score, coins and save results. Settings are stored in `bobble-ui.json`
(contains proxy passwords: do not share it). Each profile can have its own proxy (the BOBBLE team recommended
separate IPs for multiple wallets); profiles without one use the shared proxy. `npm run ui -- --guest` runs a demo.

## Guest mode (default): nothing is saved

```bash
npm run bot -- --headed            # visible window
npm run bot -- --runs=3 --maxSeconds=120
```

Fresh browser profile, no wallet; every request except game assets is blocked.

## Online mode: runs are saved to your wallet

Bot use with a connected wallet was confirmed by the BOBBLE team (@unboxbobble, Nov 2026), as long as runs
go through the official game without exploiting bugs.

```bash
npm run bot -- --online
```

1. A separate Chrome/Edge window opens with its own profile (`bobble-profile/`, kept between launches).
2. First time only: install your wallet extension in that window, reload the game, connect the wallet,
   sign the message and finish the X steps. Use a dedicated wallet; sign-in is a signature only.
3. The bot starts automatically after sign-in and plays runs until you press Ctrl+C.
   Each run is submitted by the game itself; the bot prints the server answer.

Options: `--runs=N` (0 = unlimited), `--maxRunMinutes=50` (stops steering after N minutes so the run ends
while the game session is still valid), `--profile=DIR`, `--channel=chrome|msedge|chromium`.

### Score / coin limits and hotkeys

`--stopScore=N` and/or `--stopCoins=N`: when a run reaches the limit the bot releases control, the character
crashes, the run is saved, and the bot pauses. The score may overshoot slightly before the crash.

Keys in the terminal: `L` end the current run now, `P` pause/resume between runs,
`S` (while paused) type new limits and start the next run, `Ctrl+C` quit.

### Several wallets

The BOBBLE team allowed running the bot on multiple wallets / X accounts "within reasonable limits" (Nov 2026).
Each account gets its own profile folder with its own MetaMask, game sign-in and X session:

```bash
npm run bot -- --online --profile=profile-1
npm run bot -- --online --profile=profile-2
```

A profile can be open in one bot at a time; different profiles can run in parallel in separate terminals.

## Network options (both modes)

- `--proxy=http://host:port:user:pass` (also `user:pass@host:port`, `socks5://...`) or env `BOBBLE_PROXY`.
- Game traffic is fetched through Node because some networks stall the browser's own requests to Cloudflare;
  `--direct` disables that.

`bobble-profile/` contains your wallet extension data: never share or commit it.
