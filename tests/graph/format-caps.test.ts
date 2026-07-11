import { expect, test } from "bun:test";
import { MAX_BUNDLE_LIST_LINES } from "@/lib/context/format";
import { formatSummary } from "@/lib/graph/format-responses";

test("summary lens caps a hub task's edge list with narrowing guidance", () => {
  const edgeCount = MAX_BUNDLE_LIST_LINES + 20;
  const edges = Array.from({ length: edgeCount }, (_, i) => ({
    edgeType: "depends_on" as const,
    direction: "outgoing" as const,
    connectedTaskId: crypto.randomUUID(),
    connectedTaskRef: `HUB-${i + 2}`,
    connectedTaskTitle: `Dependent ${i}`,
    connectedTaskStatus: "draft",
    note: "",
  }));

  const text = formatSummary({
    node: {
      taskRef: "HUB-1",
      title: "Hub task",
      status: "draft",
      description: "",
      category: null,
      priority: null,
      estimate: null,
      prUrl: null,
    },
    parent: null,
    edgeCount: { depends_on: edgeCount, relates_to: 0 },
    edges,
    acceptanceCriteriaCount: 0,
    decisionsCount: 0,
    assigneeCount: 0,
    hasImplementationPlan: false,
    links: [],
    feed: { notes: [], overflow: [], linked: [], truncated: false },
  });

  expect(text).toContain(`\`HUB-${MAX_BUNDLE_LIST_LINES + 1}\``);
  expect(text).not.toContain(`\`HUB-${MAX_BUNDLE_LIST_LINES + 2}\``);
  expect(text).toContain("+20 more");
  expect(text).toContain("piyaz_map view='neighbors' task='HUB-1'");
});
