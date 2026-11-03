# Inwise desktop visual contract

Reference: https://inwise-execution-simulator.shravani-vatti.chatgpt.site/desktop-surfaces?v=10 (Inwise Product Design System 3.0).

Use true-white surfaces, Owl Deep Teal `#013d54`, Owl Teal `#0f7894`, Aqua `#61b2b0`, Mint `#a8cfc1`, and Ice `#e9f2ee`. Use the 12/13/15/18 type scale. Compact screens use thin dividers, restrained status tints, and 4/8/16px control/card/window radii. Readable muted text is slightly stronger than the reference's translucent small text.

`src/renderer/owl.css` owns CSS roles, `theme/owl.ts` maps Chakra overlays to the same roles, and `popup/owl-desktop.css` applies the approved compact layout. Standalone recorder and daily-plan entry points import the shared roles too. Do not substitute a dark main-window theme for this design.

Preserve all existing recording, review, task, people, integration, consent, and recovery behaviour. Use real stored values for counts and statuses; do not copy fictional simulator content or claim connections that are not present.

## Verification

- `npm test`: existing domain/platform/silence regressions.
- `node scripts/run-recording-recovery-tests.cjs` after building: actual Chromium decoder and capture finalisation, saved-audio retry/export, failed insights, restart recovery, simulated-microphone recovery interface.
- `npx electron scripts/test-design-ui.cjs`: actual renderer + real IPC with isolated synthetic storage. Captures main tabs, detail pages, sheets, confirmation/merge/snooze states, menu/search/About, all settings/integration sections and their lower content, all five transcript review tabs, empty states, compact/wide layouts, all three onboarding steps, and the standalone daily plan.
- `npx electron scripts/test-recorder-design.cjs`: isolated simulated-audio recorder, borderless white surface, live glow, silence prompt.

Screenshots and machine-readable results go to ignored local QA artifacts. Keep credentials and actual user recordings out of fixtures. These checks do not certify every device, operating-system dialog, provider account, or external service.

## Brand lockup

<img src="../src/renderer/assets/inwise-owl.jpg" alt="Approved Inwise owl" width="64" height="64" /> **inwise**

Use the supplied owl artwork unchanged, with lowercase `inwise` immediately beside it in deep teal DM Sans. The shared renderer component is `src/renderer/components/InwiseBrand.tsx`.
