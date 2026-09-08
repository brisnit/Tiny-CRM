import { Paperclip } from "lucide-react";

import { BetaUnavailable } from "@/components/app/beta-unavailable";
import { requireActor } from "@/lib/auth/access";

export const metadata = { title: "Files" };

/**
 * Held back from the private beta.
 *
 * The screen invited people to attach proposals and contracts to a record, and
 * there was no upload control anywhere in the product: `STORAGE_DRIVER` is
 * `none`, deliberately, because uploads without a malware scanner are a
 * liability rather than a feature.
 *
 * The validation is written and tested — extension allowlist with SVG
 * excluded, magic-byte checks against the declared type, generated storage
 * keys, attachment-only downloads — and `REQUIRE_MALWARE_SCAN` fails uploads
 * closed until a scanner exists. None of that is removed here.
 */
export default async function FilesPage() {
  await requireActor();

  return (
    <BetaUnavailable
      title="Files"
      icon={Paperclip}
      what="Proposals, contracts and documents, attached to the record they belong to."
      why="File storage is not switched on for this beta. Uploads stay off until malware scanning is in place, so for now keep documents where they already live and link to them from a note."
    />
  );
}
