# Marketplace SOCKS5 proxy — TDD evidence

## Source and user journeys

The journeys were derived from the user's request to add SOCKS5 proxies to the
Marketplace UI and run them server-side with the Everbee executor.

1. A user can save a labelled SOCKS5 profile without exposing its credentials.
2. A user can assign or remove a proxy profile for a saved marketplace account.
3. A capture forwards only the resolved proxy URL to the Everbee launch call.

## RED → GREEN evidence

| Behaviour | Test | RED evidence | GREEN evidence |
| --- | --- | --- | --- |
| Encode and launch a SOCKS5 proxy | `test/marketplace-proxy.test.js` | `Cannot find module '../src/marketplaces/proxy'` | 5 proxy/capture unit tests passed. |
| Create and assign encrypted proxy profiles over HTTP | `test/marketplace-proxy-api.test.js` | API returned the dashboard HTML, which could not be parsed as JSON because the endpoint did not exist. | Proxy profile creation and account assignment returned `201`/`200` without disclosing the password. |
| Expose proxy controls in the dashboard | `test/marketplace-ui.test.js` | Required proxy element IDs/functions were missing. | Static UI contract passed for proxy form and account assignment controls. |

## Verification

```text
node --test test\\marketplace-capture.test.js test\\marketplace-api.test.js test\\marketplace-login.test.js test\\marketplace-storage-state.test.js test\\marketplace-proxy.test.js test\\marketplace-proxy-api.test.js test\\marketplace-ui.test.js
23 passed, 0 failed

node --test --experimental-test-coverage [same focused targets]
line coverage: 82.57%
```

The tests do not make an external proxy connection or attempt to bypass a
marketplace challenge. They prove encryption boundaries, account assignment,
UI availability, and propagation of a configured SOCKS5 URL into the server
browser launch options.
