# Toidispy Login-State Detection

## Behavior
The Toidispy scraping automation (`scripts/toidispy-cdp.js`) runs via a Playwright connection over CDP to an existing Chrome browser. Since it operates on a user profile, it expects the browser to already be authenticated with Toidispy.

## Detection
If the session is not authenticated, the platform automatically redirects navigation from `/posts` or `/libraries` to `/login`.
The automation script intercepts this state by checking the current URL immediately after the initial navigation.
If the URL contains `/login`, it aborts execution and throws an error with the code `TOIDISPY_LOGIN_REQUIRED`.

## Manual Intervention Requirement
Because the Chrome session is managed outside of the Node.js automation process, the system cannot automatically log in.
When this error occurs:
1. The diagnostic system catches the error code and propagates it to the database (`health_snapshot.code`).
2. The UI intercepts this code and displays a specific user-friendly prompt: "Toidispy login required. Open Chrome CDP profile, login to Toidispy, then retry."
3. The user must manually open the Chrome browser bound to the CDP port, navigate to Toidispy, log in, and then re-trigger the collection run.

## Check Toidispy Login Utility
A dedicated "Check Toidispy Login" button in the collection modal performs a fast test run (`maxItems: 1`) to proactively verify the session state without waiting for full timeouts.


## Agent-Reach Parity Updates
Toidispy login state is now explicitly handled by the UI gating system and the `/api/toidispy/check-login` endpoint. The setup wizard and real backend verifier identify `TOIDISPY_LOGIN_REQUIRED` rather than reporting a generic failure.