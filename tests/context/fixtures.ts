import { seedUserOrgProject, serviceRoleConnect } from "@/tests/setup/seed";

/** A rich context fixture: the central task id plus its owner user id. */
export type RichContextFixture = { taskId: string; userId: string };

/**
 * Seed a fully-populated central task plus one done upstream dependency (with
 * an execution record) and one downstream dependent. The central task carries
 * every droppable column the depth-aware fetch gates: implementation_plan,
 * execution_record, files, history, category, tags, priority, estimate, an
 * acceptance criterion, a decision, a pull_request link, and an assignee. The
 * golden snapshots built on this fixture are the byte-identity contract for
 * the per-depth column projection.
 *
 * @param suffix - Slug/email/identifier suffix so fixtures don't collide.
 * @returns The central task id and the owner user id.
 */
export async function seedRichContextTask(
  suffix: string,
): Promise<RichContextFixture> {
  const fx = await seedUserOrgProject(suffix);
  const sr = serviceRoleConnect();
  try {
    const [main] = await sr<{ id: string }[]>`
      INSERT INTO tasks
        ("project_id", "title", "sequence_number", "description", "status",
         "implementation_plan", "execution_record", "files", "tags", "priority",
         "estimate", "category", "history")
      VALUES
        (${fx.projectId}, 'Central task', 2, 'Central description', 'in_review',
         'Step one then step two', 'Built the thing',
         '["lib/a.ts", "lib/b.ts"]'::jsonb, '["alpha", "beta"]'::jsonb,
         'high', 3, 'feature',
         '[{"id": "h1", "date": "2026-05-16T00:00:00.000Z", "action": "created"}]'::jsonb)
      RETURNING id`;
    const [prereq] = await sr<{ id: string }[]>`
      INSERT INTO tasks
        ("project_id", "title", "sequence_number", "description", "status",
         "execution_record")
      VALUES
        (${fx.projectId}, 'Prereq task', 1, 'Prereq description', 'done',
         'Prereq execution record')
      RETURNING id`;
    const [downstream] = await sr<{ id: string }[]>`
      INSERT INTO tasks
        ("project_id", "title", "sequence_number", "description")
      VALUES (${fx.projectId}, 'Downstream task', 3, 'Downstream description')
      RETURNING id`;
    await sr`
      INSERT INTO task_edges (source_task_id, target_task_id, edge_type, note)
      VALUES (${main.id}, ${prereq.id}, 'depends_on', 'needs prereq output')`;
    await sr`
      INSERT INTO task_edges (source_task_id, target_task_id, edge_type, note)
      VALUES (${downstream.id}, ${main.id}, 'depends_on', 'consumes central')`;
    await sr`
      INSERT INTO task_acceptance_criteria (id, task_id, position, text, checked)
      VALUES (gen_random_uuid(), ${main.id}, 0, 'It works', false)`;
    await sr`
      INSERT INTO task_decisions (id, task_id, position, text, source, decision_date)
      VALUES (gen_random_uuid(), ${main.id}, 0, 'Use approach X', 'explicit', '2026-05-16')`;
    await sr`
      INSERT INTO task_links (task_id, url, kind, label)
      VALUES (${main.id}, 'https://example.test/pr/1', 'pull_request', 'PR 1')`;
    await sr`
      INSERT INTO task_assignees (task_id, user_id)
      VALUES (${main.id}, ${fx.userId})`;
    return { taskId: main.id, userId: fx.userId };
  } finally {
    await sr.end({ timeout: 5 });
  }
}

/** Matches any v4-shaped UUID for golden normalization. */
const UUID_PATTERN =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/**
 * Normalize a rendered context golden so per-run-random identifiers don't
 * defeat the snapshot. Collapses the seeded project's sequence-suffixed
 * identifier and any embedded UUIDs to stable placeholders.
 *
 * @param s - Rendered context string.
 * @param suffix - The fixture suffix used in the project identifier.
 * @returns The normalized string.
 */
export function normalizeContextGolden(s: string, suffix: string): string {
  return s.replaceAll(`PRJ${suffix}`, "PRJ").replace(UUID_PATTERN, "<uuid>");
}
