// The session's half of predicted hits (PROTOCOL.md §17.9 *Predicted hits*), a port of
// packages/multiplayer/src/authority/hit-session.ts: where on a path or a ray a hit is shown, and what a state has
// acknowledged while the seat is on the fast channel (§17.12), where a state's `hp` and its list come by WebSocket and
// its acknowledgement, an entity's place and its `epoch` by snapshot. The two tests and the settling rule are
// PredictedHits.cs's. Held to the TypeScript's test cases (authority-hit-session.test.ts) by Tests~/GenexSmoke
// `predicted-hits`. Engine-agnostic: no UnityEngine.
using System;
using System.Collections.Generic;

namespace Genex.Multiplayer.Authority
{
    /// <summary>
    /// The most a WebSocket state can have acknowledged while the seat is on the fast channel (hit-session.ts
    /// <c>ackCeiling</c>). There a state's own facts (an entity's <c>hp</c>, whether it is in the list) come by WebSocket and
    /// the acknowledgement by snapshot, one snapshot with each patch under the same server stamp. A projectile's settling
    /// only needs an acknowledgement the list is at least as new as (the newest snapshot not after the patch). A
    /// hitscan's needs the other bound too: a state not yet known to cover its input is read as "before the shot was
    /// judged" only when a snapshot not older than the patch says so. Without it, a patch that overtakes its snapshot (or
    /// whose snapshot was lost) shows the shot's own damage as someone else's, and the hit it should confirm is cancelled.
    /// </summary>
    internal sealed class GenexAckCeiling
    {
        /// <summary>Snapshots kept: the patches' pace against a WebSocket seconds behind.</summary>
        public const int Kept = 64;

        private readonly List<KeyValuePair<double, double>> kept = new List<KeyValuePair<double, double>>();
        private double stamp = double.NegativeInfinity;

        /// <summary>A snapshot sent at server time <paramref name="sentMs"/> was applied; the channel's ack is now
        /// <paramref name="ack"/>. One not after the last kept, or older than the last patch, changes nothing.</summary>
        public void Snapshot(double sentMs, double ack)
        {
            if (kept.Count > 0 && sentMs <= kept[kept.Count - 1].Key) return;
            if (sentMs < stamp) return;
            kept.Add(new KeyValuePair<double, double>(sentMs, ack));
            if (kept.Count > Kept) kept.RemoveRange(0, kept.Count - Kept);
        }

        /// <summary>A WebSocket patch stamped <paramref name="stampMs"/> was decoded: the snapshots older than it say nothing
        /// of it. One not after the last patch changes nothing.</summary>
        public void Patch(double stampMs)
        {
            if (!(stampMs > stamp)) return;
            stamp = stampMs;
            kept.RemoveAll(s => !(s.Key >= stampMs));
        }

        /// <summary>The ack of the oldest snapshot kept that is not older than the last patch: no state the WebSocket told
        /// has acknowledged more. Infinity while no such snapshot came.</summary>
        public double Upper() => kept.Count > 0 ? kept[0].Value : double.PositiveInfinity;

        /// <summary>A new link: nothing kept.</summary>
        public void Reset()
        {
            kept.Clear();
            stamp = double.NegativeInfinity;
        }
    }

    /// <summary>What a session keeps around the two tests and the settling rule (hit-session.ts).</summary>
    internal static class GenexHitSession
    {
        /// <summary>
        /// One look's acknowledgement for a hit fired by input <paramref name="seq"/>, from the two bounds of what the state
        /// read has acknowledged: <paramref name="lower"/> when the state is known to cover the input,
        /// <paramref name="upper"/> when it is known not to, and null when it cannot be told yet (the hit then only waits).
        /// </summary>
        public static double? LookAck(double seq, double lower, double upper)
        {
            if (lower >= seq) return lower;
            return upper < seq ? upper : (double?)null;
        }

        /// <summary>A look that says nothing new of a hit's target: only the time limit can settle it.</summary>
        public static GenexHitLook WaitingLook(GenexPendingHit pending, double now, double ttl) => new GenexHitLook
        {
            Ack = pending.Seq - 1, HasTarget = true, TargetHp = pending.Hp, TargetEpoch = pending.Epoch, Now = now, Ttl = ttl,
        };

        /// <summary>Where a path <paramref name="a"/> → <paramref name="b"/> is <paramref name="dist"/> along it;
        /// <paramref name="a"/> for a path with no length.</summary>
        public static GenexHitPoint PathPoint(GenexHitPoint a, GenexHitPoint b, double dist)
        {
            var dx = b.X - a.X;
            var dy = b.Y - a.Y;
            var dz = b.Z - a.Z;
            var len = Math.Sqrt(dx * dx + dy * dy + dz * dz);
            if (!(len > 0)) return a;
            var u = dist / len;
            return new GenexHitPoint(a.X + dx * u, a.Y + dy * u, a.Z + dz * u);
        }

        /// <summary>Where a ray from <paramref name="origin"/> along <paramref name="dir"/> enters the sphere of
        /// <paramref name="radius"/> (default the hitscan's) round <paramref name="target"/>, which the hitscan test found
        /// <paramref name="found"/>'s <c>Dist</c> along it; <paramref name="origin"/> for a ray that starts inside.</summary>
        public static GenexHitPoint RayEntry(GenexHitPoint origin, GenexHitPoint dir, GenexHitTarget target, GenexHitFound found, double? radius = null)
        {
            var len = Math.Sqrt(dir.X * dir.X + dir.Y * dir.Y + dir.Z * dir.Z);
            if (!(len > 0)) return origin;
            var ux = dir.X / len;
            var uy = dir.Y / len;
            var uz = dir.Z / len;
            var r = radius.HasValue && radius.Value >= 0 ? radius.Value : GenexPredictedHits.HitscanRadius;
            var px = origin.X + ux * found.Dist - target.X;
            var py = origin.Y + uy * found.Dist - target.Y;
            var pz = origin.Z + uz * found.Dist - target.Z;
            var inside = r * r - (px * px + py * py + pz * pz);
            var entry = Math.Max(0, found.Dist - Math.Sqrt(Math.Max(0, inside)));
            return new GenexHitPoint(origin.X + ux * entry, origin.Y + uy * entry, origin.Z + uz * entry);
        }
    }
}
