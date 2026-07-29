/**
 * Brand gate (2026-07-29 split).
 *
 * NAS Digital and With Nate are two separate businesses with separate
 * audiences, voices and accounts. This server belongs to exactly one of them,
 * and refuses to publish work belonging to the other.
 *
 * It takes a TASK ID, not a brand name, and asks the board what brand that
 * task is. That matters: a `brand` argument would be a claim the caller could
 * simply assert correctly to get past the check, which is no gate at all. A
 * task id has to correspond to a real task that genuinely carries the right
 * brand, so an agent cannot post With Nate artwork from a NAS Digital account
 * without first having a NAS Digital task to point at. Same
 * assignment-as-identity model the board already uses for submit_output.
 *
 * Honest scope: this is defence in depth, not the primary control. The real
 * gate is the board's own fan-out (BRAND_CHANNELS in app/pickup.py), which
 * decides whether a posting subtask is ever created. This catches the case
 * where an agent reaches for a posting tool outside that flow - which the
 * fleet has real history of (NEXUS generating images directly under another
 * agent's identity, session 12).
 */
const FLEET_BOARD_URL = process.env.FLEET_BOARD_URL || "http://127.0.0.1:8420";

export class BrandError extends Error {}

const BRAND_LABELS: Record<string, string> = {
  with_nate: "With Nate",
  nas_digital: "NAS Digital",
  misaki: "Misaki",
  unassigned: "Unassigned",
};

/**
 * @param taskId  the board task this post belongs to
 * @param serverBrand  the brand this MCP server publishes for
 */
export async function requireBrand(
  taskId: string | undefined,
  serverBrand: string,
): Promise<void> {
  const label = BRAND_LABELS[serverBrand] ?? serverBrand;
  if (!taskId) {
    throw new BrandError(
      `task_id is required: this server publishes for ${label} only, and the board ` +
        `task is what proves the work belongs to that brand.`,
    );
  }

  const res = await fetch(`${FLEET_BOARD_URL}/tasks/${encodeURIComponent(taskId)}`);
  if (!res.ok) {
    throw new BrandError(
      `Could not verify task "${taskId}" with the fleet board (returned ${res.status}) - ` +
        `action rejected rather than published unverified.`,
    );
  }

  const task = (await res.json()) as { brand?: string; title?: string };
  const brand = task.brand || "unassigned";

  if (brand === serverBrand) return;

  if (brand === "unassigned") {
    throw new BrandError(
      `Task "${taskId}" has no brand, so there is no audience for it yet. Set the ` +
        `epic's brand on the board before publishing - guessing means a public post ` +
        `under the wrong name.`,
    );
  }

  throw new BrandError(
    `Task "${taskId}" belongs to ${BRAND_LABELS[brand] ?? brand}, but this server ` +
      `publishes for ${label}. These are separate businesses with separate ` +
      `audiences - cross-posting between them is the exact thing the brand split ` +
      `exists to prevent. Use that brand's own channels.`,
  );
}
