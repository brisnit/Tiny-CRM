import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

import { runAsTestIdentity } from "../../src/lib/auth/context";
import { resetRateLimit } from "../../src/lib/rate-limit";
import { createTenant, cleanupTenants, db, type Tenant } from "../helpers/fixtures";

/**
 * Notes on an opportunity: one concept, visible, and gone when deleted.
 *
 * What these guard against, each of which was true before:
 *
 *  - a note written from the obvious button was a timeline activity, and never
 *    appeared in the opportunity's Notes list;
 *  - a note moved to the Trash still appeared on the opportunity, because the
 *    query never excluded archived notes;
 *  - permanently deleting a note left its title and opening text on the
 *    timeline entry that recorded it.
 *
 * Every refusal is paired with the matching success, so an implementation that
 * simply refuses everything cannot pass.
 */

let A: Tenant;
let B: Tenant;

const asOwner = <T>(fn: () => Promise<T>) => runAsTestIdentity(A.ownerId, fn);
const asMember = <T>(fn: () => Promise<T>) => runAsTestIdentity(A.memberId, fn);
const asViewer = <T>(fn: () => Promise<T>) => runAsTestIdentity(A.viewerId, fn);

/** The mutation policy is right for a person and too tight for a suite; reset, never loosen. */
async function clearLimits() {
  for (const t of [A, B]) {
    for (const id of [t.ownerId, t.memberId, t.viewerId, t.workspaceId]) {
      await resetRateLimit("mutation", { user: id, workspace: id, global: id });
    }
  }
}

async function opportunityNotes(tenant: Tenant) {
  const { getOpportunity } = await import("../../src/lib/data/opportunities");
  const opportunity = await getOpportunity({ workspaceIds: [tenant.workspaceId], userId: tenant.ownerId, restrictedWorkspaceIds: [] }, tenant.opportunityId);
  assert.ok(opportunity, "the opportunity could not be read");
  return opportunity;
}

async function addNote(title: string, body: string, as = asMember) {
  const { createNote } = await import("../../src/lib/actions/notes");
  const result = await as(() =>
    createNote({ workspaceId: A.workspaceId, title, body, opportunityId: A.opportunityId }),
  );
  assert.equal(result.ok, true, `createNote failed: ${JSON.stringify(result)}`);
  if (!result.ok) throw new Error("unreachable");
  return result.data.id;
}

describe("notes on an opportunity", () => {
  before(async () => {
    A = await createTenant("NotesAlpha");
    B = await createTenant("NotesBeta");
  });
  after(async () => {
    await cleanupTenants([A, B]);
    await db.$disconnect();
  });

  test("a note added to an opportunity is a real note, listed on it, with a linked timeline entry", async () => {
    await clearLimits();
    const id = await addNote("Kickoff call", "<p>Buyer wants WCAG 2.2 AA</p>");

    const opportunity = await opportunityNotes(A);
    const listed = opportunity.notes.find((n) => n.id === id);
    assert.ok(listed, "the note does not appear on the opportunity");
    assert.match(listed.body, /WCAG 2\.2 AA/);

    const entry = await db.activity.findFirst({ where: { noteId: id } });
    assert.ok(entry, "adding a note left no timeline history");
    assert.equal(entry.type, "note");
    assert.equal(entry.opportunityId, A.opportunityId, "the timeline entry is not on the opportunity");
    assert.ok(
      opportunity.activities.some((a) => a.noteId === id),
      "the opportunity's timeline does not carry the note's entry",
    );
  });

  test("script in a note never reaches the opportunity page, whichever path wrote it", async () => {
    await clearLimits();
    const hostile = '<p>fine</p><script>alert(1)</script><img src=x onerror="alert(2)">';
    const viaAction = await addNote("Hostile via action", hostile);

    // A row written without the action's sanitiser, as a migration or a future
    // write path might. The read side must hold on its own.
    const viaDatabase = await db.note.create({
      data: {
        workspaceId: A.workspaceId, title: "Hostile via database", body: hostile,
        plainText: "fine", authorId: A.memberId, opportunityId: A.opportunityId,
      },
    });

    const opportunity = await opportunityNotes(A);
    for (const id of [viaAction, viaDatabase.id]) {
      const note = opportunity.notes.find((n) => n.id === id);
      assert.ok(note, `note ${id} is missing — the test would pass for the wrong reason`);
      assert.match(note.body, /fine/, "sanitising removed the legitimate text too");
      assert.doesNotMatch(note.body, /<script/i, "a script tag reached the page");
      assert.doesNotMatch(note.body, /onerror/i, "an event handler reached the page");
    }
  });

  test("an edit needs the current version, and a stale one is refused", async () => {
    await clearLimits();
    const { updateNote } = await import("../../src/lib/actions/notes");
    const id = await addNote("Versioned", "<p>v1</p>");
    const seen = (await opportunityNotes(A)).notes.find((n) => n.id === id)!;

    const first = await asMember(() => updateNote(id, { body: "<p>v2</p>", version: seen.version }));
    assert.equal(first.ok, true, `a current edit was refused: ${JSON.stringify(first)}`);

    const stale = await asMember(() => updateNote(id, { body: "<p>stale</p>", version: seen.version }));
    assert.equal(stale.ok, false, "an edit against an old version overwrote a newer one");

    const stored = await db.note.findUniqueOrThrow({ where: { id } });
    assert.match(stored.body, /v2/, "the newer edit was lost");
  });

  test("a deleted note leaves the opportunity, and Undo brings it back", async () => {
    await clearLimits();
    const { archiveNote, restoreNote } = await import("../../src/lib/actions/notes");
    const id = await addNote("Moves to Trash", "<p>temporary</p>");

    const archived = await asMember(() => archiveNote(id));
    assert.equal(archived.ok, true, "a member could not delete their note");
    assert.ok(
      !(await opportunityNotes(A)).notes.some((n) => n.id === id),
      "a note in the Trash is still shown on the opportunity",
    );

    const restored = await asMember(() => restoreNote(id));
    assert.equal(restored.ok, true, "Undo failed");
    assert.ok(
      (await opportunityNotes(A)).notes.some((n) => n.id === id),
      "Undo did not bring the note back",
    );
  });

  test("a member can move a note to the Trash but not destroy it; an owner can, and its words leave the timeline", async () => {
    await clearLimits();
    const { deleteNote } = await import("../../src/lib/actions/notes");
    const id = await addNote("Pricing strategy", "<p>Our floor is $120k</p>");
    const entry = await db.activity.findFirstOrThrow({ where: { noteId: id } });
    assert.match(`${entry.title} ${entry.body}`, /Pricing strategy|\$120k/, "precondition: the entry snapshots the note");

    const byMember = await asMember(() => deleteNote(id, "Pricing strategy"));
    assert.equal(byMember.ok, false, "a member permanently destroyed a note");
    assert.ok(await db.note.findUnique({ where: { id } }), "the refused delete removed the note anyway");

    const byOwner = await asOwner(() => deleteNote(id, "Pricing strategy"));
    assert.equal(byOwner.ok, true, `an owner could not delete: ${JSON.stringify(byOwner)}`);
    assert.equal(await db.note.findUnique({ where: { id } }), null, "the note still exists");

    const kept = await db.activity.findUnique({ where: { id: entry.id } });
    assert.ok(kept, "the timeline lost the fact that a note existed");
    assert.equal(kept.title, "Deleted a note");
    assert.equal(kept.body, null, "the deleted note's text is still on the timeline");

    const leftovers = await db.activity.count({
      where: {
        workspaceId: A.workspaceId,
        OR: [{ title: { contains: "Pricing strategy" } }, { body: { contains: "$120k" } }],
      },
    });
    assert.equal(leftovers, 0, "the deleted note's words survive somewhere on the timeline");
  });

  test("a viewer cannot add a note; a member can", async () => {
    await clearLimits();
    const { createNote } = await import("../../src/lib/actions/notes");
    const input = { workspaceId: A.workspaceId, title: "Role check", body: "<p>x</p>", opportunityId: A.opportunityId };

    const byViewer = await asViewer(() => createNote(input));
    assert.equal(byViewer.ok, false, "a viewer added a note");

    const byMember = await asMember(() => createNote(input));
    assert.equal(byMember.ok, true, "a member could not add a note");
  });

  test("a note cannot be attached to another workspace's opportunity", async () => {
    await clearLimits();
    const { createNote } = await import("../../src/lib/actions/notes");

    const foreign = await asMember(() =>
      createNote({ workspaceId: A.workspaceId, body: "<p>probe</p>", opportunityId: B.opportunityId }),
    );
    assert.equal(foreign.ok, false, "a note was attached to another tenant's opportunity");

    const own = await asMember(() =>
      createNote({ workspaceId: A.workspaceId, body: "<p>probe</p>", opportunityId: A.opportunityId }),
    );
    assert.equal(own.ok, true, "a note could not be attached to the member's own opportunity");
  });

  test("another workspace's note cannot be edited or deleted from here", async () => {
    await clearLimits();
    const { createNote, updateNote, archiveNote } = await import("../../src/lib/actions/notes");
    const theirs = await runAsTestIdentity(B.memberId, () =>
      createNote({ workspaceId: B.workspaceId, title: "Beta only", body: "<p>private</p>", opportunityId: B.opportunityId }),
    );
    assert.equal(theirs.ok, true);
    if (!theirs.ok) return;

    const edit = await asOwner(() => updateNote(theirs.data.id, { body: "<p>defaced</p>" }));
    assert.equal(edit.ok, false, "edited another tenant's note");
    const remove = await asOwner(() => archiveNote(theirs.data.id));
    assert.equal(remove.ok, false, "deleted another tenant's note");

    const untouched = await db.note.findUniqueOrThrow({ where: { id: theirs.data.id } });
    assert.match(untouched.body, /private/, "the refused edit changed the note anyway");
    assert.equal(untouched.archivedAt, null, "the refused delete moved the note anyway");

    // The same owner can still do both to a note of their own.
    const mine = await addNote("Alpha own", "<p>mine</p>", asOwner);
    const ownEdit = await asOwner(() => updateNote(mine, { body: "<p>edited</p>" }));
    assert.equal(ownEdit.ok, true, "the owner could not edit their own note");
  });

  test("a note in the Trash never reaches Tiny AI's record context, nor does its timeline snapshot; a live note does", async () => {
    await clearLimits();
    const { archiveNote } = await import("../../src/lib/actions/notes");
    const { buildRecordContext } = await import("../../src/lib/ai/context");

    await addNote("Live strategy", "<p>LIVE-MARKER-4071</p>");
    const trashed = await addNote("Trashed strategy", "<p>TRASH-MARKER-9352</p>");
    const archived = await asMember(() => archiveNote(trashed));
    assert.equal(archived.ok, true);

    const context = await buildRecordContext(
      { workspaceIds: [A.workspaceId], userId: A.ownerId, restrictedWorkspaceIds: [], workspaceNames: new Map([[A.workspaceId, "Alpha"]]) },
      "opportunity",
      A.opportunityId,
    );
    assert.ok(context, "no record context was built");
    // Paired: the context is not simply empty.
    assert.match(context.text, /LIVE-MARKER-4071/, "a live note is missing from the AI context");
    assert.doesNotMatch(context.text, /TRASH-MARKER-9352/, "a deleted note's text would be sent to the AI provider");
    assert.doesNotMatch(context.text, /Trashed strategy/, "a deleted note's title would be sent to the AI provider");
  });

  test("a note in the Trash is not in Tiny AI's workspace snapshot; a live note's entry is", async () => {
    await clearLimits();
    const { archiveNote } = await import("../../src/lib/actions/notes");
    const { buildWorkspaceSnapshot } = await import("../../src/lib/ai/context");

    await addNote("Snapshot live 5530", "<p>kept</p>");
    const trashed = await addNote("Snapshot trashed 7718", "<p>gone</p>");
    assert.equal((await asMember(() => archiveNote(trashed))).ok, true);

    const snapshot = await buildWorkspaceSnapshot(
      { workspaceIds: [A.workspaceId], userId: A.ownerId, restrictedWorkspaceIds: [], workspaceNames: new Map([[A.workspaceId, "Alpha"]]) },
      { limit: 50 },
    );
    assert.match(snapshot.text, /Snapshot live 5530/, "a live note's timeline entry is missing from the snapshot");
    assert.doesNotMatch(snapshot.text, /Snapshot trashed 7718/, "a deleted note's entry would be sent to the AI provider");
  });

  test("search does not find a note in the Trash; it does find a live one", async () => {
    await clearLimits();
    const { archiveNote } = await import("../../src/lib/actions/notes");
    const { searchEverything } = await import("../../src/lib/data/search");

    const live = await addNote("Searchable quokka live", "<p>findable</p>");
    const trashed = await addNote("Searchable quokka trashed", "<p>hidden</p>");
    assert.equal((await asMember(() => archiveNote(trashed))).ok, true);

    const hits = await searchEverything({ workspaceIds: [A.workspaceId], userId: A.ownerId, restrictedWorkspaceIds: [] }, "quokka");
    const ids = hits.filter((h) => h.type === "note").map((h) => h.id);
    assert.ok(ids.includes(live), "search no longer finds a live note");
    assert.ok(!ids.includes(trashed), "search surfaces a note that is in the Trash");
  });
});
