// Sahaba Club — membership tier checks
// ------------------------------------------------------------
// Shared by any page that needs to know "can this visitor see this" —
// today that's events.html gating Premium-only events; later it'll be
// the Learning Library and coach booking too. One function, one shape
// of answer, so every page checks tier the same way.
import { supabase } from "./supabase-client.js?v=8917e84e6a";

// tier is "guest" (not signed in), "standard", or "premium".
export async function getAccessLevel() {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return { session: null, tier: "guest" };

  const { data, error } = await supabase
    .from("subscriptions")
    .select("tier")
    .eq("user_id", session.user.id)
    .maybeSingle();

  // A signed-in member always has a subscriptions row (see the Phase 1
  // migration's new-user trigger) — falling back to "standard" here is
  // just a safety net, not the expected path.
  if (error || !data) return { session, tier: "standard" };
  return { session, tier: data.tier };
}

export function canSeeTier(accessLevel, tierRequired) {
  if (!tierRequired || tierRequired === "all") return true;
  if (tierRequired === "premium") return accessLevel.tier === "premium";
  return true;
}
