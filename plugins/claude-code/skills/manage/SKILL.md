---
name: manage
description: >
  Explicit doorway to the Piyaz manage subagent. Use only when the user types
  /piyaz:manage directly. For natural-language manage requests (strategic review,
  graph health audit, rebalancing, deep planning, housekeeping), the /piyaz skill
  or the assistant dispatches the manage agent via the Task tool — do not invoke
  this skill for that path.
---

Dispatch the `manage` subagent via the Task tool with `subagent_type: "manage"`. Pass the user's full request as the prompt. The canonical workflow lives in the agent definition; do not duplicate it here.
