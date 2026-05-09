---
name: decompose
description: >
  Explicit doorway to the Mymir decompose subagent. Use only when the user types
  /mymir:decompose directly. For natural-language decompose requests (the user
  asks to break a project description into tasks), the /mymir skill or the
  assistant dispatches the decompose agent via the Task tool — do not invoke this
  skill for that path.
---

Dispatch the `decompose` subagent via the Task tool with `subagent_type: "decompose"`. Pass the user's full request as the prompt. The canonical workflow lives in the agent definition; do not duplicate it here.
