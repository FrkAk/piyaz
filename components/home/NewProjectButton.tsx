"use client";

import { useState } from "react";
import { Button } from "@/components/shared/Button";
import { GetStartedModal } from "@/components/home/GetStartedModal";
import { IconPlus } from "@/components/shared/icons";

/**
 * Primary CTA in the home-page header, rendered once the user has projects.
 * Opens {@link GetStartedModal} with the "talk to your agent" copy. Project
 * creation itself happens in the user's coding agent via MCP — the button is
 * a pointer, not a form. The zero-project home hides it; FirstRunPanel
 * carries the setup guide there.
 *
 * @returns Secondary-variant button paired with the modal it triggers.
 */
export function NewProjectButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="secondary"
        size="md"
        icon={<IconPlus size={12} />}
        onClick={() => setOpen(true)}
      >
        New project
      </Button>
      <GetStartedModal open={open} onClose={() => setOpen(false)} />
    </>
  );
}

export default NewProjectButton;
