# Ready-to-paste prompt for the agent on the Mac mini

Copy everything inside the fence into a fresh Claude Code session **running on the Mac mini**, then
answer the questions it asks. Replace the two bracketed values first if you already know them.

```text
Install and bring up "virtual-home", a self-hosted home-management web app, on this Mac mini. You are
running on the machine that will serve it.

Inputs
- Repository (public, contains no household data): https://github.com/machadolucas/virtual-home.git
- Clone it to ~/git/virtual-home
- The 3D house-model package is a zip at: [PATH TO house-model.zip]
- The public origin this will be served on (Caddy already runs here): [https://example.invalid]

Authoritative instructions
Read, in this order, and then follow them exactly rather than improvising:
1. CLAUDE.md in the repository root (hard rules; the most important one is that no household data,
   photo, database or secret ever goes into this public repo).
2. docs/deploy-mac-mini.md — the step-by-step install for this machine. It is the plan; do not
   invent a different one.
3. docs/operations.md for anything you need afterwards (update, backup, restore, recovery), and
   docs/security.md for the trust model.

What I have to give you, and you must ask for rather than guess
- The two account passwords (at least 12 characters each) — you will run `pnpm vh-admin init-users`,
  which prompts for them; let me type them into that prompt myself. Never accept a password as a
  command-line argument and never echo one.
- A Home Assistant long-lived access token, and the Home Assistant base URL. The token is optional
  at install time: if I do not have it ready, set HA_TOKEN empty, finish the install, and tell me how
  to add it later. Never print the token, never put it anywhere except
  ~/virtual-home-data/secrets/vh.env (mode 0600), and never include it in a report or a log.

Guardrails for this machine, which runs other services
- Stop and ask me before: editing the existing Caddy configuration, reloading or restarting Caddy,
  enabling automatic login, installing anything as a LaunchDaemon (root), or touching any service
  that is not virtual-home. Show me the exact diff or command you propose.
- Do not create a cloudflared tunnel; I will do that separately.
- If the installer reports that port 3010 is taken, tell me what holds it and propose a free port
  rather than stopping the other process.
- Do not commit or push anything. If you had to change a file in the repo to get the install
  working, show me the diff and explain why instead of committing it.

Do the work
Follow docs/deploy-mac-mini.md: prerequisites, both installer passes, the secrets file, init-users,
unzip and import the house model (verify model.json sits at the top level of the folder you import),
then the Caddy site block (ask first), then Home Assistant if I gave you a token.

Verify honestly and report
Run `pnpm vh-admin doctor`, the health endpoint, and `launchctl print` for the web and worker jobs.
Then give me a short report with:
- what is installed and running, with the actual command output for the health and launchd checks;
- the model import result (model id, fingerprint, any warnings);
- whether Home Assistant is connected (state, version) or why not;
- the exact next steps that need me: signing in for the first time, adding notify services per
  person under Settings → Users, importing equipment from Home Assistant, and creating the first
  real maintenance plans (do not invent maintenance schedules or equipment on my behalf);
- anything that failed, verbatim, with what you tried. Do not report a step as done if you could not
  verify it.
Finish by running `WARMUP_S=600 ./scripts/measure-resources.sh` in the background if I am not in a
hurry, and record the numbers in docs/operations.md's measured table (that edit I do want, but leave
it uncommitted for me to review).
```

## After it finishes, the parts only you can do

1. Sign in at your origin as `lucas`, set the theme you want in the account menu.
2. Settings → Users: add each person's notify service, otherwise nobody is notified.
3. Settings → Home Assistant → import: create equipment from the devices that matter (the Parmair
   ventilation unit, the two heat pumps, the water heater, the sauna heater, the battery sensors) and
   link their entities.
4. Create the real maintenance plans with your own intervals. The app deliberately never invents a
   schedule: for the ventilation filters it can offer Home Assistant's own last-change date as a
   starting point, and everything else (chimney sweeping, sauna, heat-pump filters, batteries) is
   yours to set.
5. Attach the manuals you want available on a phone (Parmair, the heat pumps, the water heater, the
   sauna heater) to their equipment records.
6. Watch the first week of notifications, then tell me what the cadence should be if 09:00 or the
   seven-day repeat is wrong.
