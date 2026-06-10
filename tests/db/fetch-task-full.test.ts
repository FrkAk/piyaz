import { expect, test } from "bun:test";
import { DEPTH_PROJECTIONS } from "@/lib/db/raw/fetch-task-full";

test("agent depth keeps every column planning and working read", () => {
  const agent = DEPTH_PROJECTIONS.agent;
  const flags = Object.keys(agent) as (keyof typeof agent)[];

  for (const depth of ["planning", "working"] as const) {
    for (const flag of flags) {
      if (DEPTH_PROJECTIONS[depth][flag]) {
        expect({ depth, flag, agentKeeps: agent[flag] }).toEqual({
          depth,
          flag,
          agentKeeps: true,
        });
      }
    }
  }
});
