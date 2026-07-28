import { afterEach, expect, test } from "bun:test";
import { truncateAll } from "@/tests/setup/schema";
import { seedUserOrgProject, serviceRoleConnect } from "@/tests/setup/seed";
import { withUserContext } from "@/lib/db/rls";
import {
  aggregateProjectTags,
  MAX_PROJECT_TAGS,
} from "@/lib/db/raw/aggregate-project-tags";
import { tagVocabularyCutoff } from "@/lib/graph/format-responses";

/**
 * Coverage for the tag-vocabulary read cap and its rendered marker.
 *
 * The tag set is caller-grown with no project-wide ceiling, so the read is
 * capped at {@link MAX_PROJECT_TAGS} most-used rows and the rendered line
 * must say so: an agent silently shown a partial list coins a tag that
 * already exists further down the tail.
 */

afterEach(async () => {
  await truncateAll();
});

test("the tag vocabulary read is capped at the most-used rows", async () => {
  const fx = await seedUserOrgProject("tagcap");
  const sr = serviceRoleConnect();
  try {
    // 51 tasks x 10 distinct tags = 510 distinct tags, past the 500 cap.
    // One repeated tag proves most-used ordering survives the cap.
    for (let i = 0; i < 51; i++) {
      const tags = ["always-on"].concat(
        Array.from({ length: 10 }, (_, j) => `tag-${i * 10 + j}`),
      );
      await sr`
        INSERT INTO tasks (project_id, title, sequence_number, tags)
        VALUES (${fx.projectId}, ${`T${i}`}, ${i + 1}, ${sr.json(tags)})`;
    }
  } finally {
    await sr.end({ timeout: 5 });
  }

  const rows = await withUserContext(fx.userId, (tx) =>
    aggregateProjectTags(tx, fx.projectId),
  );

  expect(rows.length).toBe(MAX_PROJECT_TAGS);
  expect(rows[0]!.tag).toBe("always-on");
  expect(rows[0]!.count).toBe(51);
});

test("the cutoff marker fires at the cap and stays silent under it", () => {
  expect(tagVocabularyCutoff(MAX_PROJECT_TAGS)).toContain("most-used");
  expect(tagVocabularyCutoff(MAX_PROJECT_TAGS + 1)).toContain("most-used");
  expect(tagVocabularyCutoff(MAX_PROJECT_TAGS - 1)).toBe("");
  expect(tagVocabularyCutoff(0)).toBe("");
});
