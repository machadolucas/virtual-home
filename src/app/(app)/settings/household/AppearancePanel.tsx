"use client";

import { Panel } from "@/ui";
import { HouseBackgroundControl } from "@/features/settings/HouseBackgroundControl";
import type { HouseBackground } from "@/house/model/background";

/**
 * Settings → Household → Appearance.
 *
 * The same control as the House workspace's **Rendering** section, because it is the same
 * household-level setting. It is here as well as there for the ordinary reason: somebody looking
 * for "where do I change how this looks" comes to Settings first, and somebody actually choosing a
 * colour wants to be standing in front of the model while they do it.
 *
 * A separate client component rather than a `"use client"` on the page: the page stays a server
 * component so `requireSessionPage()` and the household read happen on the server.
 */
export function AppearancePanel({ background }: { background: HouseBackground }) {
  return (
    <Panel
      title="Appearance"
      subtitle="What sits behind the house in the 3D view. Both household members see the same background — it is stored with the household, not with your account."
    >
      <HouseBackgroundControl value={background} layout="full" className="max-w-md" />
    </Panel>
  );
}
