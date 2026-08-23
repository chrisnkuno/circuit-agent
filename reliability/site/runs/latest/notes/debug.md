# Debug run

Fixed.

- **Bug:** `math.mjs:1` implemented `multiply` as `a + b`, so `multiply(6, 7)` returned `13` instead of `42`.
- **Fix:** changed the operator to `a * b` — the single smallest change, no new files or dependencies.
- **Verified:** `node --test math.test.mjs` passes: 1 test, 1 pass, 0 fail.
