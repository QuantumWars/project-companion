---
paths:
  - "**/*.css"
  - "components/**/*.tsx"
  - "app/**/*.tsx"
---

# Frontend rules: styling

1. Use the project's existing styling system (for example Tailwind and shadcn/ui). Do not add a second one.
2. Use the existing design tokens for colour, spacing and type. Do not hard-code a colour that a token covers.
3. Make each layout work from 360 px wide upward, without horizontal scrolling.
4. Do not shift layout as content loads: reserve space for images and loaded data.
