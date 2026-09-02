# QA browser fixture cleanup

## Incident record — 2026-08-28

A temporary QA UI fixture was left running after browser acceptance. It listened
on IPv6 `*:3780`, while the intended service listened only on IPv4
`127.0.0.1:3780`. A browser resolving `localhost` preferred the fixture, so the
user saw the QA application instead of the intended service. The fixture was
terminated and `localhost/ping` recovered.

## Required procedure

1. Never bind a QA fixture to the user-facing port `3780`. Bind to port `0`
   (or another explicit random test port) and pass the selected port to the
   browser test.
2. Every browser/fixture listener must have a cleanup owner. Stop it in a
   `finally` block; test suites must also stop it in `afterAll` as a fallback.
3. Before reporting QA completion, run:

   ```bash
   lsof -nP -iTCP:3780 -sTCP:LISTEN
   ```

   Confirm no QA fixture owns the listener. If an intended user service is
   running, verify its PID, cwd, and bind address rather than assuming
   `localhost` resolves to it.
4. Record the fixture PID, cwd, and selected port in the QA report whenever a
   real browser fixture is started. Confirm it is gone before the final report.

## Review gate

Browser acceptance is incomplete until listener cleanup and the port-3780 audit
both pass. A green UI assertion does not waive this gate.
