# KS-E — deploy the governance-verifying HTTP retrieval endpoint

Stands up the Knowledge System's **HTTP MCP retrieval endpoint** on the
**kb.arkology.studio** VPS so external agents (e.g. Douglas's Claude Code) can
read the brain with a **governance-minted token**. The endpoint is
`gbrain serve --http`: OAuth 2.1 MCP that verifies `hab_at_`/`hab_pat_` tokens
by RFC 7662 introspection against [habitat-governance](https://github.com/arkologystudio/habitat-governance).

> **State today:** the box runs only the `sync` (wiki reindex) and `dream`
> (nightly) units — there is **no HTTP retrieval endpoint running** and no app
> port listening. KS-E adds one. The GOV-2 introspection code is already on
> `staging` (PR #9/#10).

## Depends on / blocks

- **Requires GOV-DEPLOY** — needs `https://gov.arkology.studio/v1/introspect`
  reachable and the `ks-engine` (`introspect` scope) client credentials.
- **Real ZOA reads also need KS-D** (the `zoa` space carved + Douglas's grant),
  which is blocked on KS-G. KS-E can be stood up and health-green *before*
  KS-D — a governance token simply resolves to zero readable sources until the
  grant exists (fail-closed, correct).

## Topology

```
  Cloudflare tunnel (dashboard-managed)
     <KS_PUBLIC_URL e.g. kb.arkology.studio> ──► http://localhost:3131
                                                      │
  kb-vps (169.239.183.141)                            ▼
   systemd: knowledge-system-http.service
     gbrain serve --http --port 3131 --bind 127.0.0.1   (whole brain; per-token scoping)
        │  verifies hab_at_/hab_pat_ via ──► gov.arkology.studio/v1/introspect
        └─ same brain/DB (Postgres :5433) as the sync + dream units
```

Governance introspection is **opt-in** (`GBRAIN_GOVERNANCE_INTROSPECT_URL`) and
**fails closed** (URL set + creds missing → governance tokens DENIED, loud
startup warning). Promoting KS `staging → master` is therefore safe on its own —
introspection stays dormant until the env is set.

---

## Steps (human — kb-vps + Cloudflare dashboard)

### 1. Promote `staging → master`

Brings the GOV-2 introspection code (+ KS-C RLS) to production. Safe: dormant
until step 3.

```bash
git fetch origin && git push origin origin/staging:master   # or a staging→master PR
```

### 2. Update the engine checkout on the box

```bash
ssh kb-vps
cd /root/knowledge-system
git fetch origin && git checkout master && git pull --ff-only
bun install --frozen-lockfile        # if deps changed
# (confirm this matches the box's engine-update convention for /root/knowledge-system)
```

### 3. Install the governance env + systemd unit

Copy the two files from `ops/kb-vps/` in this repo:

```bash
# governance creds (from GOV-DEPLOY client registration → ks-engine client)
install -m 600 -o root -g root ops/kb-vps/governance.env.example /etc/gbrain/governance.env
$EDITOR /etc/gbrain/governance.env      # fill GBRAIN_GOVERNANCE_CLIENT_ID/SECRET

# the HTTP endpoint unit — set <KS_PUBLIC_URL> to the tunnel hostname first
sed 's#<KS_PUBLIC_URL>#https://kb.arkology.studio#' \
    ops/kb-vps/knowledge-system-http.service > /etc/systemd/system/knowledge-system-http.service
systemctl daemon-reload
```

### 4. Cloudflare tunnel ingress

In **Zero Trust → Networks → Tunnels**, on the tunnel already serving this box,
add / confirm a public hostname:

- **Hostname:** the KS retrieval host (matches `--public-url`; e.g. `kb.arkology.studio`)
- **Service:** `http://localhost:3131`

> If cloudflared runs as a bridge Docker container, use `http://172.17.0.1:3131`
> or attach it to the right network — same caveat as GOV-DEPLOY.

### 5. Enable + start, then health-gate

```bash
systemctl enable --now knowledge-system-http.service
journalctl -u knowledge-system-http.service -n 40 --no-pager
# expect: "[serve-http] Governance token introspection ENABLED → …/v1/introspect"
curl -fsS http://localhost:3131/health         # {"status":"ok"}
curl -fsS https://kb.arkology.studio/health     # once the tunnel ingress is live
```

A startup line reading `WARNING: … CLIENT_ID/CLIENT_SECRET are not …` means step
3's creds are missing — fix before relying on it.

---

## Verify governance reads (end-to-end)

Once GOV-DEPLOY + KS-D are both done and Douglas has a `zoa` grant:

```bash
# A governance-minted token for Douglas should introspect active and read zoa.
# (Path A issues him a PAT; Path B mints on passkey login.)
curl -sS -H "Authorization: Bearer hab_pat_…" https://kb.arkology.studio/…  # returns zoa content
```

Before KS-D, the same token authenticates but resolves to zero sources — expected.

## Rollback

```bash
systemctl stop knowledge-system-http.service
systemctl disable knowledge-system-http.service
```

The `sync` + `dream` units are untouched (they never loaded governance.env). To
disable only governance verification but keep the endpoint, blank
`GBRAIN_GOVERNANCE_INTROSPECT_URL` in `/etc/gbrain/governance.env` and restart —
the endpoint reverts to its own OAuth tokens only.

## Preflight facts (verified on kb-vps, 2026-07-13)

- `gbrain` at `/root/.bun/bin/gbrain`; brain env at `/etc/gbrain/gbrain.env`;
  brain repo `/srv/brain-repos/arkology`; Postgres (KS) container on `:5433`.
- No process listens on `:3131` yet — no collision.
- Units follow `EnvironmentFile=/etc/gbrain/gbrain.env`,
  `PATH=/root/.bun/bin:…`, `Restart=always`, `User=root`,
  `After=…docker.service` — mirrored by `knowledge-system-http.service`.
