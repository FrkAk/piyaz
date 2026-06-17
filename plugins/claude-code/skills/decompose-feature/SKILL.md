---
name: decompose-feature
description: >
  Explicit doorway to the Mymir decompose-feature subagent. Use only when the user
  types /mymir:decompose-feature directly. For natural-language requests to add a
  new feature or capability cluster to an active project, the /mymir skill or the
  assistant dispatches the decompose-feature agent via the Task tool. Do not invoke
  this skill for that path.
---

Dispatch the `decompose-feature` subagent via the Task tool with `subagent_type: "decompose-feature"`. Pass the user's full request as the prompt, including the feature description and target project context. The canonical workflow lives in the agent definition; do not duplicate it here.
