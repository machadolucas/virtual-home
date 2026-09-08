/**
 * Relink suggestions for broken Home Assistant links — the pure half of §7.2's "replacement" case.
 *
 * When a device is re-paired, HA creates a *new* registry entry with the same integration
 * `unique_id` on the same platform. The old link goes `missing`. Matching the two is mechanical;
 * accepting the match is not, because it asserts "this is physically the same thing", which only
 * the owner of the house can say. So this module proposes and never decides — the action behind
 * the button is a separate, audited call.
 *
 * Pure, so `tests/unit/features/assets` can exercise every branch with plain objects.
 */

/** A link that needs help, in the shape the suggestion needs. */
export interface BrokenLink {
  linkId: string;
  assetId: string;
  assetName: string;
  role: string;
  /** The registry id the link points at, which is no longer live. */
  haEntityRegistryId: string | null;
  haDeviceId: string | null;
  platformSnapshot: string | null;
  uniqueIdSnapshot: string | null;
  entityIdSnapshot: string | null;
}

/** A live registry entry the suggestion could point at instead. */
export interface CandidateEntity {
  registryId: string;
  entityId: string;
  platform: string | null;
  uniqueId: string | null;
  deviceId: string | null;
  name: string | null;
}

export type RelinkConfidence = "exact" | "likely";

export interface RelinkSuggestion {
  linkId: string;
  assetId: string;
  assetName: string;
  /** The registry id to repoint to. */
  registryId: string;
  entityId: string;
  confidence: RelinkConfidence;
  /** Shown next to the button, so the user can judge the claim. */
  reason: string;
}

/**
 * One suggestion per broken link, or none.
 *
 * Ambiguity is deliberately not a suggestion: if two live entries share the snapshot's
 * `(platform, unique_id)` — which should be impossible, but registries have been stranger — we
 * offer nothing rather than a coin flip. Same for the weak entity-id fallback.
 */
export function suggestRelinks(
  links: readonly BrokenLink[],
  candidates: readonly CandidateEntity[],
): RelinkSuggestion[] {
  const byUnique = new Map<string, CandidateEntity[]>();
  const byEntityId = new Map<string, CandidateEntity[]>();
  for (const candidate of candidates) {
    if (candidate.platform !== null && candidate.uniqueId !== null) {
      const key = `${candidate.platform} ${candidate.uniqueId}`;
      byUnique.set(key, [...(byUnique.get(key) ?? []), candidate]);
    }
    byEntityId.set(candidate.entityId, [...(byEntityId.get(candidate.entityId) ?? []), candidate]);
  }

  const out: RelinkSuggestion[] = [];
  for (const link of links) {
    const match = pickMatch(link, byUnique, byEntityId);
    if (match === null) continue;
    out.push({
      linkId: link.linkId,
      assetId: link.assetId,
      assetName: link.assetName,
      registryId: match.candidate.registryId,
      entityId: match.candidate.entityId,
      confidence: match.confidence,
      reason: match.reason,
    });
  }
  return out;
}

function pickMatch(
  link: BrokenLink,
  byUnique: ReadonlyMap<string, CandidateEntity[]>,
  byEntityId: ReadonlyMap<string, CandidateEntity[]>,
): { candidate: CandidateEntity; confidence: RelinkConfidence; reason: string } | null {
  if (link.platformSnapshot !== null && link.uniqueIdSnapshot !== null) {
    const hits = byUnique.get(`${link.platformSnapshot} ${link.uniqueIdSnapshot}`) ?? [];
    if (hits.length === 1) {
      return {
        candidate: hits[0]!,
        confidence: "exact",
        reason:
          `Same integration id (${link.platformSnapshot} / ${link.uniqueIdSnapshot}) — ` +
          "almost certainly the same device, re-paired.",
      };
    }
    if (hits.length > 1) return null;
  }

  // Weak fallback, and labelled as such: an entity id can be typed by hand and reused.
  if (link.entityIdSnapshot !== null) {
    const hits = byEntityId.get(link.entityIdSnapshot) ?? [];
    if (hits.length === 1) {
      return {
        candidate: hits[0]!,
        confidence: "likely",
        reason:
          `A live entity now uses the id ${link.entityIdSnapshot}. Entity ids are renameable, ` +
          "so check this is the same hardware before you accept it.",
      };
    }
  }

  return null;
}

export interface RelinkGroup {
  assetId: string;
  assetName: string;
  suggestions: RelinkSuggestion[];
}

/** Group suggestions by asset, so the page can show them under the equipment they repair. */
export function groupSuggestionsByAsset(
  suggestions: readonly RelinkSuggestion[],
): RelinkGroup[] {
  const groups = new Map<string, RelinkGroup>();
  for (const suggestion of suggestions) {
    const group = groups.get(suggestion.assetId) ?? {
      assetId: suggestion.assetId,
      assetName: suggestion.assetName,
      suggestions: [],
    };
    group.suggestions.push(suggestion);
    groups.set(suggestion.assetId, group);
  }
  return [...groups.values()].sort((a, b) => a.assetName.localeCompare(b.assetName));
}
