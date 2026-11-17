// See GenexPredictedHits.h (predicted-hits.ts). Every line of arithmetic is the reference's, in its order.
#include "GenexCore/GenexPredictedHits.h"

#include <cmath>
#include <cstddef>
#include <limits>
#include <utility>

GENEX_FP_STRICT_BEGIN

namespace genex::hits {

namespace predicted_hits_detail {

/** The next character of UTF-8 `s` from `i` as its UTF-16 code units (`second` 0 for one unit), moving `i`
 *  past it; a byte that starts no well-formed sequence is one unit of its own value, so any two strings
 *  still order the same way every time. */
std::pair<unsigned, unsigned> NextUnits(const std::string& s, std::size_t& i) {
  const auto octet = [&](std::size_t at) { return static_cast<unsigned>(static_cast<unsigned char>(s[at])); };
  const auto tail = [&](std::size_t at) { return at < s.size() && (octet(at) & 0xC0u) == 0x80u; };
  const unsigned lead = octet(i);
  unsigned point = lead;
  std::size_t length = 1;
  if (lead >= 0xC2u && lead <= 0xDFu && tail(i + 1)) {
    point = ((lead & 0x1Fu) << 6) | (octet(i + 1) & 0x3Fu);
    length = 2;
  } else if (lead >= 0xE0u && lead <= 0xEFu && tail(i + 1) && tail(i + 2)) {
    point = ((lead & 0x0Fu) << 12) | ((octet(i + 1) & 0x3Fu) << 6) | (octet(i + 2) & 0x3Fu);
    length = 3;
  } else if (lead >= 0xF0u && lead <= 0xF4u && tail(i + 1) && tail(i + 2) && tail(i + 3)) {
    point = ((lead & 0x07u) << 18) | ((octet(i + 1) & 0x3Fu) << 12) | ((octet(i + 2) & 0x3Fu) << 6) | (octet(i + 3) & 0x3Fu);
    length = 4;
  }
  i += length;
  if (point < 0x10000u) return {point, 0u};
  const unsigned rest = point - 0x10000u;
  return {0xD800u + (rest >> 10), 0xDC00u + (rest & 0x3FFu)};
}

/** JavaScript's `a <= b` on two strings: by UTF-16 code unit, a prefix first. Two ids differ in UTF-8's
 *  byte order only where one holds a character past U+FFFF and the other one from U+E000 to U+FFFF. */
bool IdAtMost(const std::string& a, const std::string& b) {
  std::size_t i = 0;
  std::size_t j = 0;
  while (i < a.size() && j < b.size()) {
    const std::pair<unsigned, unsigned> ua = NextUnits(a, i);
    const std::pair<unsigned, unsigned> ub = NextUnits(b, j);
    if (ua != ub) return ua < ub;
  }
  return i >= a.size();
}

/** `found` with a hit `dist` along on `id`, in order: nearest first, then by id (no sort implementation is
 *  relied on). */
void InsertHit(std::vector<HitFound>& found, const std::string& id, double dist) {
  std::size_t at = found.size();
  while (at > 0) {
    const HitFound& before = found[at - 1];
    if (before.dist < dist || (before.dist == dist && IdAtMost(before.id, id))) break;
    at -= 1;
  }
  found.insert(found.begin() + static_cast<std::ptrdiff_t>(at), HitFound{id, dist});
}

/** A height a shape takes: a finite number at least 0. */
bool IsSize(double v) { return std::isfinite(v) && v >= 0; }

}  // namespace predicted_hits_detail

const char* HitKindName(HitKind kind) {
  switch (kind) {
    case HitKind::Hitscan:
      return "hitscan";
    case HitKind::Projectile:
      return "projectile";
  }
  return "";
}

const char* HitSettleName(HitSettle settle) {
  switch (settle) {
    case HitSettle::Health:
      return "health";
    case HitSettle::Manual:
      return "manual";
  }
  return "";
}

const char* HitStateName(HitState state) {
  switch (state) {
    case HitState::Pending:
      return "pending";
    case HitState::Confirmed:
      return "confirmed";
    case HitState::Cancelled:
      return "cancelled";
  }
  return "";
}

const char* HitShapeKindName(HitShapeKind kind) {
  switch (kind) {
    case HitShapeKind::Sphere:
      return "sphere";
    case HitShapeKind::Capsule:
      return "capsule";
    case HitShapeKind::Refused:
      return "refused";
  }
  return "";
}

HitShapeKind HitShapeKindOf(std::optional<double> height, std::optional<double> duckHeight) {
  if (!height) return duckHeight ? HitShapeKind::Refused : HitShapeKind::Sphere;
  if (!predicted_hits_detail::IsSize(*height)) return HitShapeKind::Refused;
  return !duckHeight || predicted_hits_detail::IsSize(*duckHeight) ? HitShapeKind::Capsule : HitShapeKind::Refused;
}

std::optional<HitShape> HitShapeOf(std::optional<double> height, std::optional<double> duckHeight) {
  if (HitShapeKindOf(height, duckHeight) != HitShapeKind::Capsule) return std::nullopt;
  return HitShape{*height, duckHeight};
}

CapsuleAxis CapsuleAxisOf(const HitTarget& target, double radius, const HitShape& shape) {
  const double duck = std::isfinite(target.duck) ? target.duck : 0;
  const double level = duck < 0 ? 0 : duck > 1 ? 1 : duck;
  const double height = !shape.duckHeight ? shape.height : shape.height + (*shape.duckHeight - shape.height) * level;
  const double z0 = target.z + radius;
  const double z1 = target.z + height - radius;
  if (!(z1 > z0)) {
    const double mid = target.z + height / 2;
    return CapsuleAxis{mid, mid};
  }
  return CapsuleAxis{z0, z1};
}

double CapsuleEntry(const HitPoint& a, const HitPoint& d, double x, double y, const CapsuleAxis& axis, double radius) {
  const double z0 = axis.z0;
  const double z1 = axis.z1;
  const double r2 = radius * radius;
  const double fx = a.x - x;
  const double fy = a.y - y;
  const double zc = a.z < z0 ? z0 : a.z > z1 ? z1 : a.z;
  const double fz = a.z - zc;
  if (fx * fx + fy * fy + fz * fz <= r2) return 0;
  const double dd = d.x * d.x + d.y * d.y + d.z * d.z;
  if (!(dd > 0)) return kNoEntry;
  double u = kNoEntry;
  const double flat = d.x * d.x + d.y * d.y;
  if (flat > 0) {
    const double fd = fx * d.x + fy * d.y;
    const double disc = fd * fd - flat * (fx * fx + fy * fy - r2);
    if (disc >= 0) {
      const double side = (-fd - std::sqrt(disc)) / flat;
      const double zh = a.z + d.z * side;
      if (side >= 0 && zh >= z0 && zh <= z1) u = side;
    }
  }
  const int ends = z0 == z1 ? 1 : 2;
  for (int end = 0; end < ends; ++end) {
    const double gz = a.z - (end == 0 ? z0 : z1);
    const double gg = fx * fx + fy * fy + gz * gz;
    const double gd = fx * d.x + fy * d.y + gz * d.z;
    const double disc = gd * gd - dd * (gg - r2);
    if (disc < 0) continue;
    const double ue = (-gd - std::sqrt(disc)) / dd;
    if (ue >= 0 && (u < 0 || ue < u)) u = ue;
  }
  return u;
}

std::vector<HitFound> SweepHits(const HitPoint& a, const HitPoint& b, const std::vector<HitTarget>& targets, double radius, const std::optional<HitShape>& shape) {
  const double r2 = radius * radius;
  const double dx = b.x - a.x;
  const double dy = b.y - a.y;
  const double dz = b.z - a.z;
  const double dd = dx * dx + dy * dy + dz * dz;
  const double len = std::sqrt(dd);
  std::vector<HitFound> found;
  if (shape) {
    const HitPoint d{dx, dy, dz};
    for (const HitTarget& target : targets) {
      const double u = CapsuleEntry(a, d, target.x, target.y, CapsuleAxisOf(target, radius, *shape), radius);
      if (u < 0 || u > 1) continue;
      predicted_hits_detail::InsertHit(found, target.id, u * len);
    }
    return found;
  }
  for (const HitTarget& target : targets) {
    const double fx = a.x - target.x;
    const double fy = a.y - target.y;
    const double fz = a.z - target.z;
    const double ff = fx * fx + fy * fy + fz * fz;
    double along = 0;
    if (ff > r2) {
      if (!(dd > 0)) continue;
      const double fd = fx * dx + fy * dy + fz * dz;
      const double disc = fd * fd - dd * (ff - r2);
      if (disc < 0) continue;
      const double u = (-fd - std::sqrt(disc)) / dd;
      if (u < 0 || u > 1) continue;
      along = u * len;
    }
    predicted_hits_detail::InsertHit(found, target.id, along);
  }
  return found;
}

std::optional<HitFound> HitscanHit(const HitPoint& origin, const HitPoint& dir, const std::vector<HitTarget>& targets, std::optional<double> range,
                                   std::optional<double> radius, const std::optional<HitShape>& shape) {
  const double len = std::sqrt(dir.x * dir.x + dir.y * dir.y + dir.z * dir.z);
  if (!(len > 0)) return std::nullopt;
  const double ux = dir.x / len;
  const double uy = dir.y / len;
  const double uz = dir.z / len;
  const double reach = range && *range >= 0 ? *range : std::numeric_limits<double>::infinity();
  const double r = radius && *radius >= 0 ? *radius : kHitscanRadius;
  std::optional<HitFound> best;
  if (shape) {
    const HitPoint unit{ux, uy, uz};
    for (const HitTarget& target : targets) {
      const double u = CapsuleEntry(origin, unit, target.x, target.y, CapsuleAxisOf(target, r, *shape), r);
      if (u < 0 || u > reach) continue;
      if (!best || u < best->dist) best = HitFound{target.id, u};
    }
    return best;
  }
  for (const HitTarget& target : targets) {
    const double along = (target.x - origin.x) * ux + (target.y - origin.y) * uy + (target.z - origin.z) * uz;
    if (along < 0 || along > reach) continue;
    const double px = origin.x + ux * along - target.x;
    const double py = origin.y + uy * along - target.y;
    const double pz = origin.z + uz * along - target.z;
    if (px * px + py * py + pz * pz > r * r) continue;
    if (!best || along < best->dist) best = HitFound{target.id, along};
  }
  return best;
}

HitState SettleHit(PendingHit& hit, const HitLook& seen) {
  if (hit.settle == HitSettle::Health) {
    const std::optional<HitTargetState>& target = seen.target;
    const bool otherLife = !target || target->epoch != hit.epoch;
    const bool lower = target && target->hp < hit.hp;
    const bool hurt = otherLife || lower;
    const bool judged = seen.ack >= hit.seq;
    if (hit.kind == HitKind::Projectile && hurt) return HitState::Confirmed;
    if (hit.kind == HitKind::Hitscan && judged) return hurt ? HitState::Confirmed : HitState::Cancelled;
    if (hit.kind == HitKind::Hitscan && otherLife) return HitState::Cancelled;
    if (hit.kind == HitKind::Hitscan && target) hit.hp = target->hp;
  }
  return seen.now - hit.at > seen.ttl ? HitState::Cancelled : HitState::Pending;
}

}  // namespace genex::hits

GENEX_FP_STRICT_END
