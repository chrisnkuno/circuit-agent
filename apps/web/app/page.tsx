import { redirect } from "next/navigation";

/**
 * The product is the chat: one surface where a person talks to Nova and watches the E2B
 * sandboxes that work is actually running in. There is no separate landing page to keep
 * in sync with it, so the root simply is that surface.
 */
export default function RootPage() {
  redirect("/messages");
}
