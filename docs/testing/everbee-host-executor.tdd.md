# Everbee host executor — TDD evidence

## User journeys

Derived from the request to run Capture through the configured Chromium in
`D:\sharre\everbee`, rather than the Docker browser or CDP.

1. A Marketplace capture is sent from Docker to an authenticated executor on the Windows host.
2. The executor launches the CloakBrowser package installed under `D:\sharre\everbee` with an isolated persistent collector profile.
3. The executor receives decrypted session/proxy data only for the duration of the request and returns HTML, never secrets.

## RED → GREEN evidence

| Behaviour | Test | RED evidence | GREEN evidence |
| --- | --- | --- | --- |
| Authenticated Docker-to-host capture transport | `test/everbee-host-executor.test.js` | `Cannot find module '../src/marketplaces/everbee-host-client'` | Request token, HTML response handling, and safe errors pass. |
| Marketplace capture uses the host executor | `test/marketplace-capture.test.js` | Test attempted the old local browser path because `hostCapture` was unsupported. | Capture passes its normalized account state to the host executor and reports `everbee_host`. |

## Verification

```text
node --test test\\everbee-host-executor.test.js test\\marketplace-capture.test.js
12 passed, 0 failed

Docker → host health: HTTP 200
Host executor smoke capture: HTTP 200, final host www.etsy.com
```

The host process binds `127.0.0.1:9333`. Docker reaches it using
`host.docker.internal:9333`; the request carries an HMAC-style token derived
from the existing server encryption key. This is an application HTTP endpoint,
not Chrome DevTools/CDP.

Known operational requirement: `scripts/start-everbee-host-executor.ps1` must
be started on the Windows host after a reboot before Docker captures can run.
