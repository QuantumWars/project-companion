---
paths:
  - "app/**/*.{ts,tsx}"
  - "components/**/*.{ts,tsx}"
  - "hooks/**/*.{ts,tsx}"
---

# Frontend rules: components

1. Give every screen four states: loading, empty, error and ready. Show each one on purpose.
2. Keep a component to one job. Split it when it fetches data and also lays out a page.
3. Use a server component by default in the Next.js App Router. Add `"use client"` only when the component needs
   state, effects or browser events.
4. Keep data fetching out of leaf components. Pass data down as props.
5. Name a component after what the user sees, for example `ReceiptEmailPreview`, not `Wrapper2`.
6. Write a test for each acceptance criterion the component meets. Name the criterion ID in the test name.
