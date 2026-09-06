import "server-only";

import { db } from "@/lib/db";

/**
 * Replaces the tag set on a record. Tags are created on demand within the
 * workspace, which is what makes tagging feel free-form while still being
 * relational underneath.
 */
export async function setTags(
  workspaceId: string,
  entityType: string,
  entityId: string,
  names: string[],
) {
  const clean = Array.from(new Set(names.map((n) => n.trim()).filter(Boolean)));

  const existing = await db.tag.findMany({
    where: { workspaceId, name: { in: clean } },
    select: { id: true, name: true },
  });
  const byName = new Map(existing.map((t) => [t.name, t.id]));

  for (const name of clean) {
    if (!byName.has(name)) {
      const created = await db.tag.create({ data: { workspaceId, name } });
      byName.set(name, created.id);
    }
  }

  const tagIds = clean.map((n) => byName.get(n)!).filter(Boolean);

  await db.tagLink.deleteMany({ where: { entityType, entityId, tagId: { notIn: tagIds } } });
  for (const tagId of tagIds) {
    await db.tagLink.upsert({
      where: { tagId_entityType_entityId: { tagId, entityType, entityId } },
      create: { workspaceId, tagId, entityType, entityId },
      update: {},
    });
  }
}

/** Tag names for a batch of records, keyed by record id. */
export async function tagsForEntities(entityType: string, entityIds: string[]) {
  if (entityIds.length === 0) return new Map<string, { name: string; color: string }[]>();

  const links = await db.tagLink.findMany({
    where: { entityType, entityId: { in: entityIds } },
    select: { entityId: true, tag: { select: { name: true, color: true } } },
  });

  const map = new Map<string, { name: string; color: string }[]>();
  for (const link of links) {
    const list = map.get(link.entityId) ?? [];
    list.push(link.tag);
    map.set(link.entityId, list);
  }
  return map;
}
