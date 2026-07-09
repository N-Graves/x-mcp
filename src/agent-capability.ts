/**
 * OpenClaw has no per-agent MCP tool scoping in this version (all agents
 * share the same MCP server process - confirmed platform limitation,
 * openclaw/openclaw#67682, closed not planned). This checks the *claimed*
 * calling agent's identity against the fleet board's own capability
 * records before allowing a real, consequential action.
 *
 * Honest limitation: agent_id is self-reported by the caller, not
 * cryptographically bound by the platform. This does not stop a genuinely
 * malicious actor from lying about its own identity - what it does is turn
 * a silent, undetected wrong-agent action into a loud, immediate, auditable
 * rejection, which is the same fix already applied to muse-image-tools.
 */
const FLEET_BOARD_URL = process.env.FLEET_BOARD_URL || "http://127.0.0.1:8420";

export class CapabilityError extends Error {}

export async function requireCapability(agentId: string | undefined, capability: string): Promise<void> {
  if (!agentId) {
    throw new CapabilityError(
      `agent_id is required for this action (must hold the "${capability}" capability).`,
    );
  }
  const res = await fetch(`${FLEET_BOARD_URL}/agents/${encodeURIComponent(agentId)}/capabilities`);
  if (!res.ok) {
    throw new CapabilityError(
      `Could not verify capabilities for agent "${agentId}" (fleet board returned ${res.status}) - action rejected.`,
    );
  }
  const caps = (await res.json()) as unknown;
  if (!Array.isArray(caps) || !caps.includes(capability)) {
    throw new CapabilityError(
      `Agent "${agentId}" does not hold the "${capability}" capability - action rejected.`,
    );
  }
}
