---
name: brainstorm
description: >
  Explicit doorway to the Piyaz brainstorm subagent. Use only when the user types
  /piyaz:brainstorm directly. For natural-language brainstorm requests (the user
  describes a net-new project idea), the /piyaz skill or the assistant dispatches
  the brainstorm agent via the Task tool — do not invoke this skill for that path.
---

Dispatch the `brainstorm` subagent via the Task tool with `subagent_type: "brainstorm"`. Pass the user's full request as the prompt. The canonical workflow lives in the agent definition; do not duplicate it here.
