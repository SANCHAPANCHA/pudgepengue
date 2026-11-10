# Bobble Run bot

Autoplays https://unboxbobble.com/run using the game's own built-in demo AI: dodges obstacles and collects coins.
Requires **Node.js 20+**.

```bash
npm install
npx playwright install chromium
```

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

## Network options (both modes)

- `--proxy=http://host:port:user:pass` (also `user:pass@host:port`, `socks5://...`) or env `BOBBLE_PROXY`.
- Game traffic is fetched through Node because some networks stall the browser's own requests to Cloudflare;
  `--direct` disables that.

`bobble-profile/` contains your wallet extension data: never share or commit it.
