# KS-E — the governance-verifying HTTP retrieval endpoint

The Knowledge System's **HTTP MCP retrieval endpoint** on the
**kb.arkology.studio** VPS, which lets external agents (e.g. a guest's Claude
Code) read the brain with a **governance-minted token**. The endpoint is
`gbrain serve --http`: OAuth 2.1 MCP that verifies `hab_at_`/`hab_pat_` tokens by
RFC 7662 introspection against
[habitat-governance](https://github.com/arkologystudio/habitat-governance).

> **Status: deployed and verified.** The endpoint has been running since
> 2026-07-15 as `knowledge-system-http.service`, and governance introspection is
> live against it. This document was reconciled against the running box on
> 2026-07-29 — it now describes **what is deployed**, plus how to rebuild it.
> Earlier revisions described a plan that has since been overtaken; where the
> plan and the deployment diverged, the deployment is what is recorded here.

## What changed versus the original plan

| Original plan | What was actually deployed | Why |
|---|---|---|
| `--bind 127.0.0.1` | `--bind 172.18.0.1` | The nginx proxy that fronts the hostname is a **container**; loopback on the host is unreachable from inside it. `172.18.0.1` is the `knowledge-base_habitat` bridge gateway — still not routable from outside the box. |
| Tunnel ingress → `localhost:3131` | Tunnel → nginx → KS | A reverse proxy splits `kb.arkology.studio` by path: the OAuth surface and `/v1/*` go to governance, **everything else** to KS. No KS-specific tunnel hostname was added. |
| Introspect via `https://gov.arkology.studio/v1/introspect` | `http://127.0.0.1:8100/v1/introspect` | `gov.arkology.studio` was never provisioned and is retired. Governance is co-located, so introspection is a loopback call — off the public internet entirely. |
| `/root/.bun/bin/gbrain` in `ExecStart` | `/usr/local/bin/gbrain` | Symlink chain to the same bun-linked checkout; matches the other units. |

## Depends on / blocks

- **GOV-DEPLOY — done.** Governance is deployed, both confidential clients are
  registered, and the `ks-engine` (`introspect`) credentials are installed at
  `/etc/gbrain/governance.env`.
- **KS-D — still outstanding.** Real ZOA reads additionally need the `zoa` space
  carved and a guest grant issued; that is blocked on KS-G. Governance currently
  holds grants only on the `default` space and zero memberships, so a
  governance-minted token authenticates but **resolves to zero readable
  sources**. That is fail-closed and correct, not a defect — but it means the
  read path is not yet useful to a guest.

## Topology

```
  Cloudflare tunnel (dashboard-managed token tunnel)
     kb.arkology.studio ──► reverse-proxy (nginx container)
                                   │  splits by path
                   ┌───────────────┴────────────────┐
                   ▼                                ▼
     /authorize /token /register              everything else
     /.well-known/oauth-authorization-server         │
     /v1/*                                           │
                   │                                 │
  kb-vps           ▼                                 ▼
  (169.239.183.141)
     habitat-governance                  systemd: knowledge-system-http.service
     gov:8100 (container)                gbrain serve --http --port 3131
        ▲                                          --bind 172.18.0.1
        │                                (whole brain; per-token source scoping)
        └──── hab_at_/hab_pat_ introspection ───────┘
              http://127.0.0.1:8100/v1/introspect  (loopback, not the tunnel)
```

Two consequences worth internalising:

- **`/health` is not reachable at `https://kb.arkology.studio/health` as a KS
  check you can trust.** That path does route to KS, but the hostname sits behind
  Cloudflare Access, which answers unauthenticated probes with a `302` before KS
  ever sees them. Health-check on the box, not through the tunnel.
- **The auth hot path never leaves the machine.** Introspection is loopback, so
  it is unaffected by the edge, by Access policy, or by tunnel availability.

Governance introspection is **opt-in** (`GBRAIN_GOVERNANCE_INTROSPECT_URL`) and
**fails closed** (URL set + creds missing → governance tokens DENIED, loud
startup warning). Promoting KS `staging → master` is therefore safe on its own —
introspection stays dormant until the env is set.

---

## Rebuilding this from scratch

The steps below are the install path, written so a fresh box can be brought to
the current state. On the **existing** box they are already done; running them
again is either a no-op or actively wrong (noted per step).

### 1. Engine on `master`

The GOV-2 introspection code (+ KS-C RLS) is already on `master`. Safe to
promote independently — dormant until step 3.

```bash
git fetch origin && git push origin origin/staging:master   # or a staging→master PR
```

### 2. Update the engine checkout on the box

There is **no build step** — `/usr/local/bin/gbrain` symlinks into the source
checkout, so a pull plus a restart is the deploy.

```bash
ssh root@169.239.183.141
cd /root/knowledge-system
git fetch origin && git checkout master && git pull --ff-only
bun install --frozen-lockfile        # if deps changed
systemctl restart knowledge-system-http
```

### 3. Install the governance env + systemd unit

```bash
# governance creds — the `ks-engine` client from habitat-governance's
# register-governance-clients.sh. That script is NOT idempotent and has already
# been run on this box; re-running it registers DUPLICATE clients. To rotate,
# register a fresh client and retire the old one.
install -m 600 -o root -g root ops/kb-vps/governance.env.example /etc/gbrain/governance.env
$EDITOR /etc/gbrain/governance.env      # fill GBRAIN_GOVERNANCE_CLIENT_ID/SECRET

# the unit is committed as-deployed — no placeholder substitution needed
install -m 644 ops/kb-vps/knowledge-system-http.service \
        /etc/systemd/system/knowledge-system-http.service
systemctl daemon-reload
```

The unit also loads `/etc/gbrain/http.env`, which carries
`GBRAIN_ADMIN_BOOTSTRAP_TOKEN`, `GBRAIN_HTTP_CORS_ORIGIN` and
`GBRAIN_HTTP_TRUST_PROXY` (set because requests arrive via nginx + the tunnel).
That file is provisioned by hand and is not in this repo.

### 4. Public routing

**Nothing to add.** KS is the default route for `kb.arkology.studio` — the nginx
edge sends everything that isn't the OAuth surface or `/v1/*` to
`172.18.0.1:3131`. The edge config is versioned in
`habitat-governance/ops/edge/`. Do not add a separate tunnel hostname for KS.

### 5. Enable + start, then health-gate

```bash
systemctl enable --now knowledge-system-http.service
journalctl -u knowledge-system-http.service -n 40 --no-pager
# expect: "[serve-http] Governance token introspection ENABLED → http://127.0.0.1:8100/v1/introspect"
curl -fsS http://172.18.0.1:3131/health         # {"status":"ok"}
```

A startup line reading `WARNING: … CLIENT_ID/CLIENT_SECRET are not …` means the
creds in step 3 are missing — fix before relying on it.

---

## Verify the governance seam — no credentials needed

The token **prefix** selects the verification path, so two bogus tokens prove the
routing without any secret:

```bash
ssh root@169.239.183.141
for t in hab_at_probe_does_not_exist nope_not_a_gov_token; do
  curl -s -X POST http://172.18.0.1:3131/mcp \
    -H "Authorization: Bearer $t" -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'; echo
done
```

| token | expected response | meaning |
|---|---|---|
| `hab_at_…` | `{"error":"invalid_token","error_description":"Token inactive"}` | introspection ran against governance and failed closed — **the seam works** |
| anything else | `{"error":"invalid_token","error_description":"Invalid token"}` | local DB path; governance never consulted |

If **both** return `Invalid token`, introspection is off: check that the unit is
loading `/etc/gbrain/governance.env` and that the startup log says `ENABLED`.

### Full read path (needs KS-D)

Once KS-D lands and a guest holds a `zoa` grant, a governance-minted token
(Path A issues a PAT; Path B mints on passkey login) should introspect active and
return `zoa` content. Before KS-D the same token authenticates and resolves to
zero sources — expected.

## Rollback

```bash
systemctl stop knowledge-system-http.service
systemctl disable knowledge-system-http.service
```

The `sync` + `dream` units are untouched (they never load `governance.env`). To
keep the endpoint but disable governance verification, blank
`GBRAIN_GOVERNANCE_INTROSPECT_URL` in `/etc/gbrain/governance.env` and restart —
the endpoint reverts to its own OAuth tokens only.

## As-deployed facts (verified on kb-vps, 2026-07-29)

- `knowledge-system-http.service` **active**, listening on `172.18.0.1:3131`.
- Startup log confirms `Governance token introspection ENABLED →
  http://127.0.0.1:8100/v1/introspect` (cache TTL 0ms → every read
  re-introspects → instant revocation).
- The seam probe above returns the two distinct errors — verified, not assumed.
- `gbrain` resolves `/usr/local/bin/gbrain` → `/root/.bun/bin/gbrain` →
  `…/node_modules/gbrain/src/cli.ts`; brain env `/etc/gbrain/gbrain.env`; brain
  repo `/srv/brain-repos/arkology`; KS Postgres container on `:5433`.
- Governance holds grants on the `default` space only, `memberships` = 0 — KS-D
  is not done.
