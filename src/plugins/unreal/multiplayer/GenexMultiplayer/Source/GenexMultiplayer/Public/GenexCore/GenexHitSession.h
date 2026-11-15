// The session's half of predicted hits (PROTOCOL.md §17.9 *Predicted hits*, *Settling*): where on a path or
// a ray a hit is shown, and what a state has acknowledged while the seat is on the fast channel (§17.12),
// where a state's `hp` comes by WebSocket patch and its acknowledgement by snapshot. The two tests and the
// settling rule are GenexPredictedHits.h's; this is what genex::AuthoritySession keeps around them.
//
// Port of the pure pieces of packages/multiplayer/src/authority/hit-session.ts (`ackCeiling`, `lookAck`,
// `waitingLook`, `pathPoint`, `rayEntry`), in the reference's order, unfused; held to the rows of
// packages/multiplayer/test/authority-hit-session.test.ts by genex_offline_check (tools/offline_hits.cpp).
#pragma once

#include "GenexCore/GenexConfig.h"
#include "GenexCore/GenexPredictedHits.h"

#include <cstddef>
#include <limits>
#include <optional>
#include <vector>

namespace genex::hits {

/** Snapshots an ack ceiling keeps: the patches' pace against a WebSocket seconds behind. */
inline constexpr std::size_t kAckCeilingKept = 64;

/**
 * The most a WebSocket state can have acknowledged while the seat is on the fast channel (§17.12). There a
 * state's own facts (an entity's `hp`, whether it is in the list) come by WebSocket and the acknowledgement
 * by snapshot, one snapshot with each patch under the same server stamp. A projectile's settling only needs
 * an acknowledgement the list is at least as new as (the newest snapshot not after the patch,
 * fast::SettleAckTrail). A hitscan's needs the other bound too: a state not yet known to cover its input is
 * read as "before the shot was judged" only when a snapshot not older than the patch says so. Without it, a
 * patch that overtakes its snapshot (or whose snapshot was lost) shows the shot's own damage as someone
 * else's, and the hit it should confirm is cancelled.
 */
class GENEX_CORE_API AckCeiling {
 public:
  /** A snapshot sent at server time `sentMs` was applied; the channel's ack is now `ack`. */
  void Snapshot(double sentMs, double ack);
  /** A WebSocket patch stamped `stampMs` was decoded. */
  void Patch(double stampMs);
  /** The ack of the oldest snapshot kept that is not older than the last patch: no state the WebSocket told
   *  has acknowledged more. Infinity while no such snapshot came. */
  double Upper() const;
  /** A new link: nothing kept. */
  void Reset();

 private:
  struct Kept {
    double sent = 0.0;
    double ack = 0.0;
  };
  std::vector<Kept> kept_;
  /** The last patch's stamp. */
  double stamp_ = -std::numeric_limits<double>::infinity();
};

/** One look's acknowledgement for a hit fired by input `seq`, from the two bounds of what the state read has
 *  acknowledged: `lower` when the state is known to cover the input, `upper` when it is known not to, and
 *  none when it cannot be told yet (the hit then only waits). */
GENEX_CORE_API std::optional<double> LookAck(double seq, double lower, double upper);

/** A look that says nothing new of a hit's target: only the time limit can settle it. */
GENEX_CORE_API HitLook WaitingLook(const PendingHit& pending, double now, double ttl);

/** Where a path `a` → `b` is `dist` along it; `a` for a path with no length. */
GENEX_CORE_API HitPoint PathPoint(const HitPoint& a, const HitPoint& b, double dist);

/** Where a ray from `origin` along `dir` enters the sphere of `radius` (none, or below 0: kHitscanRadius)
 *  round `target`, which HitscanHit found `found.dist` along it; `origin` for a ray that starts inside. */
GENEX_CORE_API HitPoint RayEntry(const HitPoint& origin, const HitPoint& dir, const HitTarget& target, const HitFound& found,
                                 std::optional<double> radius = std::nullopt);

}  // namespace genex::hits
