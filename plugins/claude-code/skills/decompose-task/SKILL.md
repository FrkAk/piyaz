---
name: decompose-task
description: >
  Explicit doorway to the Piyaz decompose-task subagent. Use only when the user types
  /piyaz:decompose-task directly. For natural-language requests to split an existing
  oversize task (the user says "split this task" or composer's oversize handler
  routes here), the /piyaz skill or the assistant dispatches the decompose-task
  agent via the Task tool. Do not invoke this skill for that path.
---

Dispatch the `decompose-task` subagent via the Task tool with `subagent_type: "decompose-task"`. Pass the user's full request as the prompt, including the target taskRef. The canonical workflow lives in the agent definition; do not duplicate it here.
