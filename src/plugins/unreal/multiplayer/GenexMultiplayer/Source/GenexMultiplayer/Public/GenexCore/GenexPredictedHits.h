// Predicted hits (PROTOCOL.md §17.9 *Predicted hits*): a hit shown the moment a player's own shot
// reaches a target on their screen, instead of a round trip later when the server's word arrives. The
// client runs the server's own two tests against the entities as it draws them: a projectile's path
// between two frames (`ctx.projectiles.sweep`'s rule) and a ray (`ctx.rewind.hitscan`'s rule, which the
// server judges at these same drawn positions, §17.5). The server still decides: the states that follow
// confirm the hit or cancel it (SettleHit).
//
// Port of packages/multiplayer/src/authority/predicted-hits.ts (`sweepHits`, `hitscanHit`, `settleHit`):
// doubles in the reference's order, unfused (GENEX_FP_STRICT_BEGIN), `std::sqrt` the only function beside
// + − × ÷. Held to packages/netcode-bench/conformance/authority/predicted-hits.json, bit for bit, by
// genex_predicted_hits_check.
#pragma once

#include "GenexCore/GenexConfig.h"

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace genex::hits {

/** A point: x, y, z. */
struct HitPoint {
  double x = 0.0;
  double y = 0.0;
  double z = 0.0;
};

/** An entity a shot may hit, where it is drawn. */
struct HitTarget {
  std::string id;
  double x = 0.0;
  double y = 0.0;
  double z = 0.0;
};

/** A target a test found, and how far along the path or the ray. */
struct HitFound {
  std::string id;
  double dist = 0.0;
};

/** The radius a hitscan tests with when none is given (the server's default). */
inline constexpr double kHitscanRadius = 0.5;

/** What a predicted hit came from. */
enum class HitKind : std::uint8_t { Hitscan, Projectile };
/** What settles a predicted hit: the target's health in the states that follow, or the game alone. */
enum class HitSettle : std::uint8_t { Health, Manual };
/** Where a predicted hit stands. */
enum class HitState : std::uint8_t { Pending, Confirmed, Cancelled };

/** The reference's spellings: `hitscan`, `projectile`; `health`, `manual`; `pending`, `confirmed`, `cancelled`. */
GENEX_CORE_API const char* HitKindName(HitKind kind);
GENEX_CORE_API const char* HitSettleName(HitSettle settle);
GENEX_CORE_API const char* HitStateName(HitState state);

/** A predicted hit waiting for the server's word. */
struct PendingHit {
  HitKind kind = HitKind::Hitscan;
  HitSettle settle = HitSettle::Health;
  /** The input that fired the shot. */
  double seq = 0.0;
  /** The target's `hp` the hit is held against: as predicted, and for a hitscan as it stood in the last
   *  state before its shot was judged. */
  double hp = 0.0;
  /** The target's `epoch` when the hit was predicted. */
  double epoch = 0.0;
  /** When it was predicted, ms on the local clock. */
  double at = 0.0;
};

/** A target as a state holds it. */
struct HitTargetState {
  double hp = 0.0;
  double epoch = 0.0;
};

/** One look at a pending hit. */
struct HitLook {
  /** The input the state's entities are as of. */
  double ack = 0.0;
  /** The target in that state; none when it has none. */
  std::optional<HitTargetState> target;
  /** Now, ms on the local clock, and how long a hit may wait. */
  double now = 0.0;
  double ttl = 0.0;
};

/** The spheres of `radius` around `targets` that the straight path `a` → `b` crosses: nearest first,
 *  ties by id in UTF-16 code-unit order (JavaScript's string order); `dist` is how far along the path a
 *  sphere is entered, 0 when the path starts inside it. `ctx.projectiles.sweep`'s rule, over what the
 *  client draws. */
GENEX_CORE_API std::vector<HitFound> SweepHits(const HitPoint& a, const HitPoint& b, const std::vector<HitTarget>& targets, double radius);

/** The first of `targets` a ray from `origin` along `dir` passes within `radius` (none, or below 0:
 *  kHitscanRadius) of, no further along it than `range` (none, or below 0: no limit); of two at the same
 *  distance, the first listed. None for no target, or for a `dir` with no length. `ctx.rewind.hitscan`'s
 *  rule, over what the client draws. */
GENEX_CORE_API std::optional<HitFound> HitscanHit(const HitPoint& origin, const HitPoint& dir, const std::vector<HitTarget>& targets,
                                                  std::optional<double> range = std::nullopt, std::optional<double> radius = std::nullopt);

/** One look at a pending hit (§17.9 *Predicted hits*, *Settling*). Settled by health, a target that is
 *  gone, in another life (`epoch`) or lower in `hp` is hurt. A projectile's hit is confirmed by the first
 *  state that shows that. A hitscan's shot is judged in the tick its input is applied, so the first state
 *  whose `ack` covers the input decides: hurt confirms, unhurt cancels; before it, what happens to the
 *  target is someone else's doing (gone or in another life cancels, any other `hp` is what the hit is held
 *  against from then on: `hit.hp` is rewritten). A hit nothing settled within `ttl` is cancelled; one the
 *  game settles (HitSettle::Manual) only ever waits that out. */
GENEX_CORE_API HitState SettleHit(PendingHit& hit, const HitLook& seen);

}  // namespace genex::hits
