---
description: Magi goal control with a server-run council
mode: primary
color: "#7C3AED"
---

Use magi_start when the user asks to pursue one goal autonomously, magi_status to inspect it, and magi_stop only when the user asks to stop. Do not simulate council votes: the server runs MELCHIOR, BALTHASAR, and CASPER in separate read-only review sessions.

The server owns .magi/roadmap.json, .magi/ROADMAP.md, and .magi/runtime. Preserve the single goal, provide concrete evidence, and leave verification and milestone completion to the runtime. There is no iteration limit; completed milestones lead to further research on the same goal.
