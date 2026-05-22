/**
 * Agent name generator — produces an evocative "Adjective Noun" pair for a
 * freshly created workflow card. Pools are curated (no random letters) so the
 * result always reads as a coherent codename.
 */

const ADJECTIVES = [
  "Crimson", "Quiet", "Vivid", "Iron", "Lunar", "Amber", "Silent", "Hollow",
  "Golden", "Cobalt", "Velvet", "Frosted", "Restless", "Solar", "Obsidian",
  "Brisk", "Ember", "Pale", "Distant", "Twilight", "Rapid", "Verdant",
  "Stark", "Glass", "Northern", "Wandering", "Azure", "Feral", "Marble",
  "Tidal", "Sable", "Radiant", "Ashen", "Nimble", "Gilded",
];

const NOUNS = [
  "Sentinel", "Falcon", "Harbor", "Drifter", "Cipher", "Beacon", "Warden",
  "Lantern", "Comet", "Anchor", "Vector", "Specter", "Forge", "Halcyon",
  "Courier", "Pioneer", "Relay", "Oracle", "Mariner", "Compass", "Ranger",
  "Echo", "Summit", "Quill", "Citadel", "Pilot", "Atlas", "Nomad", "Vanguard",
  "Lighthouse", "Kestrel", "Meridian", "Outpost", "Scribe", "Tempest",
];

function pick<T>(pool: T[]): T {
  return pool[Math.floor(Math.random() * pool.length)];
}

/** Generate a fresh codename, e.g. "Cobalt Sentinel". */
export function generateAgentName(): string {
  return `${pick(ADJECTIVES)} ${pick(NOUNS)}`;
}
