# End-to-end HTTPS with an API-only subdomain, without touching the Fyers login

Owner question (31 Oct, decision 1): can an API-only subdomain behind a reverse proxy give end-to-end HTTPS **without changing the Fyers redirect**, keeping `quant_auth` exactly as it is? Investigation only: nothing was changed. Labels as in `REPORT.md` (Verified / Tested on paper / Unverified). No addresses, hostnames or port numbers here.

## Answer: yes

**The Fyers redirect does not go through the API.** Verified on the host (value compared, not printed): `FYERS_REDIRECT_URI` is plain HTTP to **this server's auth port**, served by `quant_auth` (`src/config/auth.ts:17,122`). A proxy that answers only on the HTTPS port, for one API hostname, and forwards only to `quant_api` never sees that traffic. So:

| Unchanged | Why |
|---|---|
| `quant_auth`, its port, its container | the proxy does not route to it |
| `FYERS_REDIRECT_URI` in `.env` and the Fyers app settings | the redirect still targets the auth port over HTTP |
| the 07:45 login from the Telegram link | same path as today |

The login link itself stays plain HTTP, as it is today. Moving it to HTTPS would mean changing the Fyers app settings, which this design avoids.

## Design (Tested on paper)

```
browser ──HTTPS──> Vercel /api rewrite ──HTTPS──> api.<your-domain> : proxy (Caddy) ──HTTP, container network──> quant_api
phone (later) ──HTTPS + device token──────────────> api.<your-domain>
Fyers redirect ──HTTP──> auth port ──> quant_auth        (unchanged)
```

- **Proxy**: one new compose service (Caddy, pinned version), publishing the HTTP and HTTPS ports, with a two-line site block: the API hostname → `reverse_proxy quant_api:<api port>`. Caddy gets and renews a Let's Encrypt certificate itself. For `text/event-stream` responses it flushes immediately, so SSE should pass through unbuffered (**Unverified**: check with `scripts/sse_soak.sh` against the new route).
- **Vercel**: `vercel.json` rewrite destination becomes `https://api.<your-domain>/api/:path*`. This also **removes the server address from the public dashboard repo** (audit D5).
- **Then the API port can leave the internet**: `quant_api` stops publishing its port (or binds it to loopback); the proxy reaches it on the compose network. Today Vercel needs the public port because it has no fixed source address; after the switch it only needs the HTTPS port.

## What the owner has to provide (no AWS change by an agent)

1. **A domain or subdomain you control**, with an `A` record for the API hostname pointing at the server. A paid domain has a yearly fee; free dynamic-DNS names also work. Avoid services that put the server's address inside the hostname (for example "<address>.<service>" names): that publishes the address again.
2. **A stable public address.** DNS breaks if the address changes on a stop/start. Whether the instance has an Elastic IP is **Unverified**: the read-only AWS check was blocked in this session. To check yourself: EC2 console → Instances → the instance → "Elastic IP addresses" field (or `aws ec2 describe-addresses --region ap-south-1` from your own machine).
3. **Cloud firewall**: allow inbound HTTPS (and HTTP, for the certificate challenge and the HTTP→HTTPS redirect) from anywhere. Later, remove the rule for the API port.

## Cost and load

- Domain: a yearly fee unless a free name is used. No other AWS cost (same instance, no load balancer).
- Caddy's memory on this host: **Unverified**, expected small. The host has about 1.1 GB available (Verified 31 Oct). Measure with `docker stats` after the first evening, and set a memory limit on the service.

## Rollout (three separate evenings, after Redis lock-down and `/api/v1` tokens)

1. **Proxy up, nothing switched**: add the Caddy service + DNS + firewall rules; check `https://api.<domain>/api/health` returns 200 with a valid certificate. The dashboard still uses the old route. Rollback: remove the service.
2. **Switch the dashboard**: change `vercel.json`; run the browser check (phone + desktop, `/api` all 200) and a 300 s SSE soak through Vercel. Rollback: `git revert -m 1 <merge>` on the dashboard (Vercel redeploys in about two minutes).
3. **Close the API port**: stop publishing it; an external TCP probe must show it closed. Rollback: restore the port line and recreate `quant_api`.
4. **The next trading morning**: confirm the 07:45 login and 09:00 boot work as before (they should, since nothing on their path changed).

## Risks

| Risk | Mitigation |
|---|---|
| Proxy down → dashboard has no API | `restart: unless-stopped`; the step-2 rollback is one revert |
| Certificate issuance fails (DNS not propagated, firewall closed) | step 1 is done before anything depends on it |
| SSE buffered by the proxy | soak test in step 2 before closing the old port |
| Address changes (no Elastic IP) | check item 2 first; otherwise DNS must be updated by hand |
| Forwarded-header spoofing in Fastify (audit §4.3) | trust proxy headers only from the proxy; update `fastify` first |
