---
name: onboarding
description: >
  Explicit doorway to the Mymir onboarding subagent. Use only when the user types
  /mymir:onboarding directly. For natural-language onboarding requests (the user
  asks to import an existing repo into Mymir), the /mymir skill or the assistant
  dispatches the onboarding agent via the Task tool — do not invoke this skill
  for that path.
---

Dispatch the `onboarding` subagent via the Task tool with `subagent_type: "onboarding"`. Pass the user's full request as the prompt. The canonical workflow lives in the agent definition; do not duplicate it here.
