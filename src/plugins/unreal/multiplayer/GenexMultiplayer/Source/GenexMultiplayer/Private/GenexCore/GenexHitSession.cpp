// See GenexHitSession.h (hit-session.ts). Every line of arithmetic is the reference's, in its order.
#include "GenexCore/GenexHitSession.h"

#include <algorithm>
#include <cmath>
#include <limits>

GENEX_FP_STRICT_BEGIN

namespace genex::hits {

namespace hit_session_detail {

/** JavaScript's Math.max of two numbers: NaN when either is. */
double JsMax(double a, double b) {
  if (std::isnan(a) || std::isnan(b)) return std::numeric_limits<double>::quiet_NaN();
  return a > b ? a : b;
}

}  // namespace hit_session_detail

void AckCeiling::Snapshot(double sentMs, double ack) {
  if (!kept_.empty() && sentMs <= kept_.back().sent) return;
  if (sentMs < stamp_) return;
  kept_.push_back(Kept{sentMs, ack});
  if (kept_.size() > kAckCeilingKept) kept_.erase(kept_.begin(), kept_.end() - static_cast<std::ptrdiff_t>(kAckCeilingKept));
}

void AckCeiling::Patch(double stampMs) {
  if (!(stampMs > stamp_)) return;
  stamp_ = stampMs;
  kept_.erase(std::remove_if(kept_.begin(), kept_.end(), [stampMs](const Kept& s) { return !(s.sent >= stampMs); }), kept_.end());
}

double AckCeiling::Upper() const { return kept_.empty() ? std::numeric_limits<double>::infinity() : kept_.front().ack; }

void AckCeiling::Reset() {
  kept_.clear();
  stamp_ = -std::numeric_limits<double>::infinity();
}

std::optional<double> LookAck(double seq, double lower, double upper) {
  if (lower >= seq) return lower;
  if (upper < seq) return upper;
  return std::nullopt;
}

HitLook WaitingLook(const PendingHit& pending, double now, double ttl) {
  HitLook look;
  look.ack = pending.seq - 1;
  look.target = HitTargetState{pending.hp, pending.epoch};
  look.now = now;
  look.ttl = ttl;
  return look;
}

HitPoint PathPoint(const HitPoint& a, const HitPoint& b, double dist) {
  const double dx = b.x - a.x;
  const double dy = b.y - a.y;
  const double dz = b.z - a.z;
  const double len = std::sqrt(dx * dx + dy * dy + dz * dz);
  if (!(len > 0)) return a;
  const double u = dist / len;
  return HitPoint{a.x + dx * u, a.y + dy * u, a.z + dz * u};
}

HitPoint RayEntry(const HitPoint& origin, const HitPoint& dir, const HitTarget& target, const HitFound& found, std::optional<double> radius) {
  const double len = std::sqrt(dir.x * dir.x + dir.y * dir.y + dir.z * dir.z);
  if (!(len > 0)) return origin;
  const double ux = dir.x / len;
  const double uy = dir.y / len;
  const double uz = dir.z / len;
  const double r = radius && *radius >= 0 ? *radius : kHitscanRadius;
  const double px = origin.x + ux * found.dist - target.x;
  const double py = origin.y + uy * found.dist - target.y;
  const double pz = origin.z + uz * found.dist - target.z;
  const double inside = r * r - (px * px + py * py + pz * pz);
  const double entry = hit_session_detail::JsMax(0, found.dist - std::sqrt(hit_session_detail::JsMax(0, inside)));
  return HitPoint{origin.x + ux * entry, origin.y + uy * entry, origin.z + uz * entry};
}

}  // namespace genex::hits

GENEX_FP_STRICT_END
