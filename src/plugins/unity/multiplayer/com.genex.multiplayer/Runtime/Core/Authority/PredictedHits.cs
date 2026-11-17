// Predicted hits (PROTOCOL.md §17.9 *Predicted hits*), a port of packages/multiplayer/src/authority/predicted-hits.ts:
// a hit shown the moment a player's own shot reaches a target on their screen, instead of a round trip later when the
// server's word arrives. The client runs the server's own two tests against the entities as it draws them: a
// projectile's path between two frames (`ctx.projectiles.sweep`'s rule) and a ray (`ctx.rewind.hitscan`'s rule, which
// the server judges at these same drawn positions, §17.5). The server still decides: the states that follow confirm the
// hit or cancel it (SettleHit). Nothing here reaches the wire.
//
// A target is a sphere of `radius` round the entity's position, or, with a GenexHitShape, the upright capsule a body is
// (§17.9 *Target shapes*): a preset body's position is its feet, and a sphere there cannot stand for it.
//
// Pure: float64 in the order the reference writes it, each operation its own statement (no fused multiply-add, as
// Projectile.cs explains; a sub-expression the reference writes twice is computed once, the same bits); the square root
// is the only function beside + − × ÷. Held bit for bit to
// packages/netcode-bench/conformance/authority/predicted-hits.json by Tests~/GenexSmoke `predicted-hits`.
// Engine-agnostic: no UnityEngine.
using System;
using System.Collections.Generic;

namespace Genex.Multiplayer.Authority
{
    /// <summary>A point, or a direction: x, y, z (x/y the ground plane, +z up, as the presets').</summary>
    public struct GenexHitPoint
    {
        public double X, Y, Z;

        public GenexHitPoint(double x, double y, double z)
        {
            X = x;
            Y = y;
            Z = z;
        }
    }

    /// <summary>An entity a shot may hit, where it is drawn.</summary>
    public struct GenexHitTarget
    {
        public string Id;
        public double X, Y, Z;
        /// <summary>Its duck amount as drawn, 0 standing to 1 fully ducked: read only by a <see cref="GenexHitShape"/> with
        /// a <c>DuckHeight</c>. No finite number: 0.</summary>
        public double Duck;
    }

    /// <summary>A target that is a body, not a sphere at its position (§17.9 <i>Target shapes</i>): an upright capsule of
    /// the test's radius standing on the entity's position, <c>Height</c> tall, and <c>DuckHeight</c> tall when the entity
    /// is fully ducked (§17.7's <c>standHeight</c> and <c>crouchHeight</c>).</summary>
    public struct GenexHitShape
    {
        public double Height;
        /// <summary>Null: a duck amount changes nothing.</summary>
        public double? DuckHeight;
    }

    /// <summary>What a height and a ducked height ask a test for (TypeScript <c>HitShapeKind</c>: <c>sphere</c>,
    /// <c>capsule</c>, <c>refused</c>).</summary>
    public enum GenexHitShapeKind
    {
        Sphere,
        Capsule,
        Refused,
    }

    /// <summary>A target a test found, and how far along the path or the ray.</summary>
    public struct GenexHitFound
    {
        public string Id;
        public double Dist;
    }

    /// <summary>What a predicted hit came from (TypeScript <c>HitKind</c>: <c>hitscan</c>, <c>projectile</c>).</summary>
    public enum GenexHitKind
    {
        Hitscan,
        Projectile,
    }

    /// <summary>What settles a predicted hit (TypeScript <c>HitSettle</c>: <c>health</c>, <c>manual</c>): the target's
    /// health in the states that follow, or the game alone.</summary>
    public enum GenexHitSettle
    {
        Health,
        Manual,
    }

    /// <summary>Where a predicted hit stands (TypeScript <c>HitState</c>: <c>pending</c>, <c>confirmed</c>, <c>cancelled</c>).</summary>
    public enum GenexHitState
    {
        Pending,
        Confirmed,
        Cancelled,
    }

    /// <summary>A predicted hit waiting for the server's word.</summary>
    public sealed class GenexPendingHit
    {
        public GenexHitKind Kind;
        public GenexHitSettle Settle;
        /// <summary>The input that fired the shot.</summary>
        public double Seq;
        /// <summary>The target's <c>hp</c> the hit is held against: as predicted, and for a hitscan as it stood in the last
        /// state before its shot was judged.</summary>
        public double Hp;
        /// <summary>The target's <c>epoch</c> when the hit was predicted.</summary>
        public double Epoch;
        /// <summary>When it was predicted, ms on the local clock.</summary>
        public double At;
    }

    /// <summary>One look at a pending hit.</summary>
    public struct GenexHitLook
    {
        /// <summary>The input the state's entities are as of.</summary>
        public double Ack;
        /// <summary>Whether that state has the target; its <c>hp</c> and <c>epoch</c> there when it does.</summary>
        public bool HasTarget;
        public double TargetHp, TargetEpoch;
        /// <summary>Now, ms on the local clock, and how long a hit may wait.</summary>
        public double Now, Ttl;
    }

    /// <summary>The two tests of a predicted hit and its settling (§17.9 <i>Predicted hits</i>).</summary>
    public static class GenexPredictedHits
    {
        /// <summary>The radius a hitscan tests with when none is given (the server's default).</summary>
        public const double HitscanRadius = 0.5;

        /// <summary>A kind in the TypeScript's spelling.</summary>
        public static string Name(GenexHitKind kind) => kind == GenexHitKind.Projectile ? "projectile" : "hitscan";
        /// <summary>A settling in the TypeScript's spelling.</summary>
        public static string Name(GenexHitSettle settle) => settle == GenexHitSettle.Manual ? "manual" : "health";
        /// <summary>A state in the TypeScript's spelling.</summary>
        public static string Name(GenexHitState state) => state == GenexHitState.Confirmed ? "confirmed" : state == GenexHitState.Cancelled ? "cancelled" : "pending";

        /// <summary>A shape kind in the TypeScript's spelling.</summary>
        public static string Name(GenexHitShapeKind kind) => kind == GenexHitShapeKind.Capsule ? "capsule" : kind == GenexHitShapeKind.Refused ? "refused" : "sphere";

        /// <summary>The kind a TypeScript name spells; null for any other text.</summary>
        public static GenexHitKind? KindOf(string name) =>
            name == "hitscan" ? GenexHitKind.Hitscan : name == "projectile" ? GenexHitKind.Projectile : (GenexHitKind?)null;

        /// <summary>The settling a TypeScript name spells; null for any other text.</summary>
        public static GenexHitSettle? SettleOf(string name) =>
            name == "health" ? GenexHitSettle.Health : name == "manual" ? GenexHitSettle.Manual : (GenexHitSettle?)null;

        /// <summary><see cref="CapsuleEntry"/>'s answer for a path that never enters.</summary>
        public const double NoEntry = -1;

        /// <summary>
        /// What <paramref name="height"/> and <paramref name="duckHeight"/> (null: not given) ask for: neither is the sphere,
        /// a height that is a finite number at least 0 is a capsule (with a ducked height, if given, that is one too), and
        /// anything else is refused, a ducked height without a height included.
        /// </summary>
        public static GenexHitShapeKind HitShapeKind(double? height, double? duckHeight)
        {
            if (!height.HasValue) return duckHeight.HasValue ? GenexHitShapeKind.Refused : GenexHitShapeKind.Sphere;
            if (!IsSize(height.Value)) return GenexHitShapeKind.Refused;
            return !duckHeight.HasValue || IsSize(duckHeight.Value) ? GenexHitShapeKind.Capsule : GenexHitShapeKind.Refused;
        }

        /// <summary>A height a shape takes: a finite number at least 0.</summary>
        private static bool IsSize(double v) => !double.IsNaN(v) && !double.IsInfinity(v) && v >= 0;

        /// <summary>The shape <paramref name="height"/> and <paramref name="duckHeight"/> name, in <paramref name="shape"/>:
        /// null for the sphere. False when they are refused.</summary>
        public static bool HitShapeOf(double? height, double? duckHeight, out GenexHitShape? shape)
        {
            var kind = HitShapeKind(height, duckHeight);
            shape = kind == GenexHitShapeKind.Capsule ? new GenexHitShape { Height = height.Value, DuckHeight = duckHeight } : (GenexHitShape?)null;
            return kind != GenexHitShapeKind.Refused;
        }

        /// <summary>
        /// The axis of the capsule of <paramref name="radius"/> standing on <paramref name="target"/> (§17.9 <i>Target
        /// shapes</i>), heights on +z: from <c>z + radius</c> to <c>z + H − radius</c>, <c>H</c> the shape's height at the
        /// target's duck amount (no finite number: 0; held to [0, 1]; §17.7's <c>hull(level)</c>). A body no taller than it
        /// is wide has the one point <c>z + H / 2</c>: the two ends are then equal, and the capsule is the sphere there.
        /// </summary>
        public static void CapsuleAxis(GenexHitTarget target, double radius, GenexHitShape shape, out double z0, out double z1)
        {
            double duck = double.IsNaN(target.Duck) || double.IsInfinity(target.Duck) ? 0 : target.Duck;
            double level = duck < 0 ? 0 : duck > 1 ? 1 : duck;
            double height = shape.Height;
            if (shape.DuckHeight.HasValue)
            {
                double drop = shape.DuckHeight.Value - shape.Height;
                double ducked = drop * level;
                height = shape.Height + ducked;
            }
            z0 = target.Z + radius;
            double top = target.Z + height;
            z1 = top - radius;
            if (z1 > z0) return;
            double half = height / 2;
            double mid = target.Z + half;
            z0 = mid;
            z1 = mid;
        }

        /// <summary>
        /// Where the path <c>a + d · u</c> (u ≥ 0) enters the upright capsule of <paramref name="radius"/> round the axis
        /// (<paramref name="x"/>, <paramref name="y"/>, <paramref name="z0"/> to <paramref name="z1"/>): <c>u</c>, 0 for a
        /// path that starts inside, <see cref="NoEntry"/> for one that never enters. The caller holds <c>u</c> to its own
        /// end (1 for a path a → a + d, a range for a ray). §17.9 <i>Target shapes</i>, step by step: the start, then the
        /// side, then the two ends, the smallest of them.
        /// </summary>
        public static double CapsuleEntry(GenexHitPoint a, GenexHitPoint d, double x, double y, double z0, double z1, double radius)
        {
            double r2 = radius * radius;
            double fx = a.X - x;
            double fy = a.Y - y;
            double zc = a.Z < z0 ? z0 : a.Z > z1 ? z1 : a.Z;
            double fz = a.Z - zc;
            double fxx = fx * fx;
            double fyy = fy * fy;
            double fzz = fz * fz;
            // fx·fx + fy·fy: the first two terms of every sum of three below, left to right.
            double across = fxx + fyy;
            double ff = across + fzz;
            if (ff <= r2) return 0;
            double dxx = d.X * d.X;
            double dyy = d.Y * d.Y;
            double dzz = d.Z * d.Z;
            double flat = dxx + dyy;
            double dd = flat + dzz;
            if (!(dd > 0)) return NoEntry;
            double u = NoEntry;
            double fdx = fx * d.X;
            double fdy = fy * d.Y;
            double fd = fdx + fdy;
            // The side.
            if (flat > 0)
            {
                double fd2 = fd * fd;
                double gap = across - r2;
                double scaled = flat * gap;
                double disc = fd2 - scaled;
                if (disc >= 0)
                {
                    double root = Math.Sqrt(disc);
                    double near = -fd - root;
                    double side = near / flat;
                    double rise = d.Z * side;
                    double zh = a.Z + rise;
                    if (side >= 0 && zh >= z0 && zh <= z1) u = side;
                }
            }
            // The ends: one when the axis is a point.
            var ends = z0 == z1 ? 1 : 2;
            for (var end = 0; end < ends; end++)
            {
                double gz = a.Z - (end == 0 ? z0 : z1);
                double gzz = gz * gz;
                double gg = across + gzz;
                double gdz = gz * d.Z;
                double gd = fd + gdz;
                double gd2 = gd * gd;
                double gap = gg - r2;
                double scaled = dd * gap;
                double disc = gd2 - scaled;
                if (disc < 0) continue;
                double root = Math.Sqrt(disc);
                double near = -gd - root;
                double ue = near / dd;
                if (ue >= 0 && (u < 0 || ue < u)) u = ue;
            }
            return u;
        }

        /// <summary><paramref name="hits"/> with a hit <paramref name="dist"/> along on <paramref name="id"/>, in order:
        /// nearest first, then by id in code-unit order (no sort implementation is relied on).</summary>
        private static void InsertHit(List<GenexHitFound> hits, string id, double dist)
        {
            var at = hits.Count;
            while (at > 0)
            {
                var before = hits[at - 1];
                if (before.Dist < dist || (before.Dist == dist && string.CompareOrdinal(before.Id, id) <= 0)) break;
                at -= 1;
            }
            hits.Insert(at, new GenexHitFound { Id = id, Dist = dist });
        }

        /// <summary>
        /// The spheres of <paramref name="radius"/> around <paramref name="targets"/> that the straight path
        /// <paramref name="a"/> → <paramref name="b"/> crosses: nearest first, ties by id in code-unit order;
        /// <c>Dist</c> is how far along the path a sphere is entered, 0 when the path starts inside it.
        /// <c>ctx.projectiles.sweep</c>'s rule, over what the client draws. The list is <paramref name="into"/>, emptied
        /// first, when one is given (a per-frame caller reuses it). With a <paramref name="shape"/> each target is its
        /// upright capsule instead (§17.9 <i>Target shapes</i>), entered the same way.
        /// </summary>
        public static List<GenexHitFound> SweepHits(GenexHitPoint a, GenexHitPoint b, IReadOnlyList<GenexHitTarget> targets, double radius, List<GenexHitFound> into = null,
            GenexHitShape? shape = null)
        {
            var hits = into ?? new List<GenexHitFound>();
            hits.Clear();
            double r2 = radius * radius;
            double dx = b.X - a.X;
            double dy = b.Y - a.Y;
            double dz = b.Z - a.Z;
            double dxx = dx * dx;
            double dyy = dy * dy;
            double dzz = dz * dz;
            double dd = dxx + dyy;
            dd = dd + dzz;
            double len = Math.Sqrt(dd);
            if (targets == null) return hits;
            if (shape.HasValue)
            {
                var d = new GenexHitPoint(dx, dy, dz);
                for (var i = 0; i < targets.Count; i++)
                {
                    var target = targets[i];
                    CapsuleAxis(target, radius, shape.Value, out var z0, out var z1);
                    double u = CapsuleEntry(a, d, target.X, target.Y, z0, z1, radius);
                    if (u < 0 || u > 1) continue;
                    double along = u * len;
                    InsertHit(hits, target.Id, along);
                }
                return hits;
            }
            for (var i = 0; i < targets.Count; i++)
            {
                var target = targets[i];
                double fx = a.X - target.X;
                double fy = a.Y - target.Y;
                double fz = a.Z - target.Z;
                double fxx = fx * fx;
                double fyy = fy * fy;
                double fzz = fz * fz;
                double ff = fxx + fyy;
                ff = ff + fzz;
                double along = 0;
                if (ff > r2)
                {
                    if (!(dd > 0)) continue;
                    double fdx = fx * dx;
                    double fdy = fy * dy;
                    double fdz = fz * dz;
                    double fd = fdx + fdy;
                    fd = fd + fdz;
                    double fd2 = fd * fd;
                    double gap = ff - r2;
                    double scaled = dd * gap;
                    double disc = fd2 - scaled;
                    if (disc < 0) continue;
                    double root = Math.Sqrt(disc);
                    double near = -fd - root;
                    double u = near / dd;
                    if (u < 0 || u > 1) continue;
                    along = u * len;
                }
                InsertHit(hits, target.Id, along);
            }
            return hits;
        }

        /// <summary>
        /// The first of <paramref name="targets"/> a ray from <paramref name="origin"/> along <paramref name="dir"/> passes
        /// within <paramref name="radius"/> (none, or one that is not a number at least 0: <see cref="HitscanRadius"/>) of,
        /// no further along it than <paramref name="range"/> (none, or one that is not a number at least 0: no limit); of
        /// two at the same distance, the first listed. Null for none, or for a <paramref name="dir"/> with no length.
        /// <c>ctx.rewind.hitscan</c>'s rule, over what the client draws. With a <paramref name="shape"/> each target is its
        /// upright capsule (§17.9 <i>Target shapes</i>): the first whose capsule the ray enters within
        /// <paramref name="range"/>, <c>Dist</c> where it enters (0 for a ray that starts inside), ties as before.
        /// </summary>
        public static GenexHitFound? HitscanHit(GenexHitPoint origin, GenexHitPoint dir, IReadOnlyList<GenexHitTarget> targets, double? range = null, double? radius = null,
            GenexHitShape? shape = null)
        {
            double dxx = dir.X * dir.X;
            double dyy = dir.Y * dir.Y;
            double dzz = dir.Z * dir.Z;
            double dd = dxx + dyy;
            dd = dd + dzz;
            double len = Math.Sqrt(dd);
            if (!(len > 0)) return null;
            double ux = dir.X / len;
            double uy = dir.Y / len;
            double uz = dir.Z / len;
            double reach = range.HasValue && range.Value >= 0 ? range.Value : double.PositiveInfinity;
            double r = radius.HasValue && radius.Value >= 0 ? radius.Value : HitscanRadius;
            double rr = r * r;
            GenexHitFound? best = null;
            if (targets == null) return best;
            if (shape.HasValue)
            {
                var unit = new GenexHitPoint(ux, uy, uz);
                for (var i = 0; i < targets.Count; i++)
                {
                    var target = targets[i];
                    CapsuleAxis(target, r, shape.Value, out var z0, out var z1);
                    double u = CapsuleEntry(origin, unit, target.X, target.Y, z0, z1, r);
                    if (u < 0 || u > reach) continue;
                    if (!best.HasValue || u < best.Value.Dist) best = new GenexHitFound { Id = target.Id, Dist = u };
                }
                return best;
            }
            for (var i = 0; i < targets.Count; i++)
            {
                var target = targets[i];
                double tx = target.X - origin.X;
                double ty = target.Y - origin.Y;
                double tz = target.Z - origin.Z;
                double ax = tx * ux;
                double ay = ty * uy;
                double az = tz * uz;
                double along = ax + ay;
                along = along + az;
                if (along < 0 || along > reach) continue;
                double sx = ux * along;
                double sy = uy * along;
                double sz = uz * along;
                double px = origin.X + sx;
                px = px - target.X;
                double py = origin.Y + sy;
                py = py - target.Y;
                double pz = origin.Z + sz;
                pz = pz - target.Z;
                double pxx = px * px;
                double pyy = py * py;
                double pzz = pz * pz;
                double off = pxx + pyy;
                off = off + pzz;
                if (off > rr) continue;
                if (!best.HasValue || along < best.Value.Dist) best = new GenexHitFound { Id = target.Id, Dist = along };
            }
            return best;
        }

        /// <summary>
        /// One look at a pending hit (§17.9 <i>Predicted hits</i>, <i>Settling</i>). Settled by health, a target that is
        /// gone, in another life (<c>epoch</c>) or lower in <c>hp</c> is hurt. A projectile's hit is confirmed by the first
        /// state that shows that. A hitscan's shot is judged in the tick its input is applied, so the first state whose
        /// <c>Ack</c> covers the input decides: hurt confirms, unhurt cancels; before it, what happens to the target is
        /// someone else's doing (gone or in another life cancels, any other <c>hp</c> is what the hit is held against
        /// from then on: <paramref name="hit"/>'s <c>Hp</c> is rewritten). A hit nothing settled within <c>Ttl</c> is
        /// cancelled; one the game settles (<see cref="GenexHitSettle.Manual"/>) only ever waits that out.
        /// </summary>
        public static GenexHitState SettleHit(GenexPendingHit hit, GenexHitLook seen)
        {
            if (hit.Settle == GenexHitSettle.Health)
            {
                var otherLife = !seen.HasTarget || seen.TargetEpoch != hit.Epoch;
                var lower = seen.HasTarget && seen.TargetHp < hit.Hp;
                var hurt = otherLife || lower;
                var judged = seen.Ack >= hit.Seq;
                if (hit.Kind == GenexHitKind.Projectile && hurt) return GenexHitState.Confirmed;
                if (hit.Kind == GenexHitKind.Hitscan && judged) return hurt ? GenexHitState.Confirmed : GenexHitState.Cancelled;
                if (hit.Kind == GenexHitKind.Hitscan && otherLife) return GenexHitState.Cancelled;
                if (hit.Kind == GenexHitKind.Hitscan && seen.HasTarget) hit.Hp = seen.TargetHp;
            }
            double waited = seen.Now - hit.At;
            return waited > seen.Ttl ? GenexHitState.Cancelled : GenexHitState.Pending;
        }
    }
}
