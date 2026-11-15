// Predicted hits (PROTOCOL.md §17.9 *Predicted hits*), a port of packages/multiplayer/src/authority/predicted-hits.ts:
// a hit shown the moment a player's own shot reaches a target on their screen, instead of a round trip later when the
// server's word arrives. The client runs the server's own two tests against the entities as it draws them: a
// projectile's path between two frames (`ctx.projectiles.sweep`'s rule) and a ray (`ctx.rewind.hitscan`'s rule, which
// the server judges at these same drawn positions, §17.5). The server still decides: the states that follow confirm the
// hit or cancel it (SettleHit). Nothing here reaches the wire.
//
// Pure: float64 in the order the reference writes it, each operation its own statement (no fused multiply-add, as
// Projectile.cs explains); the square root is the only function beside + − × ÷. Held bit for bit to
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

        /// <summary>The kind a TypeScript name spells; null for any other text.</summary>
        public static GenexHitKind? KindOf(string name) =>
            name == "hitscan" ? GenexHitKind.Hitscan : name == "projectile" ? GenexHitKind.Projectile : (GenexHitKind?)null;

        /// <summary>The settling a TypeScript name spells; null for any other text.</summary>
        public static GenexHitSettle? SettleOf(string name) =>
            name == "health" ? GenexHitSettle.Health : name == "manual" ? GenexHitSettle.Manual : (GenexHitSettle?)null;

        /// <summary>
        /// The spheres of <paramref name="radius"/> around <paramref name="targets"/> that the straight path
        /// <paramref name="a"/> → <paramref name="b"/> crosses: nearest first, ties by id in code-unit order;
        /// <c>Dist</c> is how far along the path a sphere is entered, 0 when the path starts inside it.
        /// <c>ctx.projectiles.sweep</c>'s rule, over what the client draws. The list is <paramref name="into"/>, emptied
        /// first, when one is given (a per-frame caller reuses it).
        /// </summary>
        public static List<GenexHitFound> SweepHits(GenexHitPoint a, GenexHitPoint b, IReadOnlyList<GenexHitTarget> targets, double radius, List<GenexHitFound> into = null)
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
                // Insertion in order: nearest first, then by id (no sort implementation is relied on).
                var at = hits.Count;
                while (at > 0)
                {
                    var before = hits[at - 1];
                    if (before.Dist < along || (before.Dist == along && string.CompareOrdinal(before.Id, target.Id) <= 0)) break;
                    at -= 1;
                }
                hits.Insert(at, new GenexHitFound { Id = target.Id, Dist = along });
            }
            return hits;
        }

        /// <summary>
        /// The first of <paramref name="targets"/> a ray from <paramref name="origin"/> along <paramref name="dir"/> passes
        /// within <paramref name="radius"/> (none, or one that is not a number at least 0: <see cref="HitscanRadius"/>) of,
        /// no further along it than <paramref name="range"/> (none, or one that is not a number at least 0: no limit); of
        /// two at the same distance, the first listed. Null for none, or for a <paramref name="dir"/> with no length.
        /// <c>ctx.rewind.hitscan</c>'s rule, over what the client draws.
        /// </summary>
        public static GenexHitFound? HitscanHit(GenexHitPoint origin, GenexHitPoint dir, IReadOnlyList<GenexHitTarget> targets, double? range = null, double? radius = null)
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
