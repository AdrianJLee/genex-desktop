// The render delay (PROTOCOL.md §17.3 *The render delay*), a port of packages/multiplayer/src/authority/render-delay.ts:
// how far behind the server a client draws every entity it does not predict. A fixed delay is right for one link only:
// on a jittery one a sample that lands later than the delay covers leaves the interpolation holding its newest pose,
// then jumping when the next arrives (a rubber band). So a client measures its own link: each sample's lateness against
// the best transit of the last ten seconds, plus the step to the sample before it, is the delay that sample needed. The
// delay follows the worst of them between the room's floor (AuthorityTiming.RENDER_DELAY_MS, or the game's own choice)
// and the ceiling the room publishes, rising fast (playback slows by a fifth) and falling slowly (a fiftieth), so
// nothing drawn ever steps. The client stamps its inputs with the delay it draws at, and the room rewinds no further
// than its ceiling explains (§17.5), which is why the ceiling is the room's: a room that publishes none keeps every
// client at the floor.
//
// Pure: float64, only + − × and comparisons, each its own statement in the order the reference writes them. Held bit
// for bit to packages/netcode-bench/conformance/authority/render-delay.json by Tests~/GenexSmoke `render-delay`.
// Engine-agnostic: no UnityEngine.
using System;
using System.Collections.Generic;
using A = Genex.Multiplayer.GenexProtocol.Authority;

namespace Genex.Multiplayer.Authority
{
    /// <summary>The render delay's constants (§17.3 <i>The render delay</i>) and the ceiling a client reads.</summary>
    public static class GenexRenderDelay
    {
        /// <summary>How long a sample counts, ms: the worst of this window sizes the delay.</summary>
        public const double WindowMs = 10000;
        /// <summary>The most samples kept (a 120 Hz stream fills the window past this; the oldest go first).</summary>
        public const int MaxSamples = 1024;
        /// <summary>Added to what the worst sample needed, ms: a frame's worth of room.</summary>
        public const double MarginMs = 10;
        /// <summary>How fast the delay rises, ms per ms of frame time: other entities play at four fifths speed meanwhile.</summary>
        public const double Rise = 0.2;
        /// <summary>How fast it falls, ms per ms: they play a fiftieth faster, which nobody sees.</summary>
        public const double Fall = 0.02;
        /// <summary>A step or a silence longer than this is a stall, not jitter, ms: nothing interpolates across it.</summary>
        public const double StallMs = 1000;
        /// <summary>The most frame time one frame moves the delay by, ms (a loop that slept).</summary>
        public const double FrameMaxMs = 250;

        /// <summary>
        /// The room's ceiling as a client reads it from the state's <c>preset</c> text (JSON, its <c>interpolation</c>
        /// key's <c>maxDelayMs</c>): a whole number above <c>RENDER_DELAY_MS</c> and at most <c>RENDER_DELAY_MAX_MS</c>,
        /// else null (an older host, a room without the setting, or a hostile value: the fixed delay).
        /// </summary>
        public static double? PresetRenderDelayMax(string presetText)
        {
            if (string.IsNullOrEmpty(presetText) || !GenexJson.TryParse(presetText, out var spec)) return null;
            if (!(spec is IDictionary<string, object> o) || !o.TryGetValue("interpolation", out var setting)) return null;
            if (!(setting is IDictionary<string, object> i) || !i.TryGetValue("maxDelayMs", out var value) || !(value is double ceiling)) return null;
            var whole = !double.IsNaN(ceiling) && !double.IsInfinity(ceiling) && Math.Floor(ceiling) == ceiling;
            return whole && ceiling > A.Timing.RenderDelayMs && ceiling <= A.Timing.RenderDelayMaxMs ? ceiling : (double?)null;
        }
    }

    /// <summary>
    /// The render delay of one client, as it measures its link (render-delay.ts <c>createRenderDelay</c>). A fresh
    /// buffer has its floor and its ceiling at <c>RENDER_DELAY_MS</c> (a fixed delay) until <see cref="Bounds"/>.
    /// </summary>
    public sealed class GenexRenderDelayBuffer
    {
        // The window, oldest first, in a ring one larger than the most kept: a sample is added before the oldest go.
        private const int Capacity = GenexRenderDelay.MaxSamples + 1;
        private readonly double[] arrivals = new double[Capacity];
        private readonly double[] transits = new double[Capacity];
        private readonly double[] needs = new double[Capacity];
        private int head, count;
        private double floor = A.Timing.RenderDelayMs;
        private double ceil = A.Timing.RenderDelayMs;
        private double delay = A.Timing.RenderDelayMs;
        private bool hasLast, hasFrame;
        private double lastArrival, lastStamp, lastFrame;

        private static bool IsFinite(double v) => !double.IsNaN(v) && !double.IsInfinity(v);
        private static double Clamp(double v, double lo, double hi) => v < lo ? lo : v > hi ? hi : v;

        /// <summary>The delay other entities are drawn behind now, ms.</summary>
        public double Delay => delay;
        /// <summary>How many samples the window holds.</summary>
        public int Samples => count;
        /// <summary>The least the delay is, ms.</summary>
        public double Floor => floor;
        /// <summary>The most the delay is, ms: the floor itself for a fixed delay.</summary>
        public double Ceiling => ceil;

        /// <summary>Sets the floor (not a number at least 0: <c>RENDER_DELAY_MS</c>) and the ceiling (not a number above the
        /// floor: the floor, a fixed delay). The delay is held to them at once.</summary>
        public void Bounds(double floorMs, double ceilMs)
        {
            floor = IsFinite(floorMs) && floorMs >= 0 ? floorMs : A.Timing.RenderDelayMs;
            ceil = IsFinite(ceilMs) && ceilMs > floor ? ceilMs : floor;
            delay = Clamp(delay, floor, ceil);
        }

        /// <summary>A sample landed: <paramref name="arrivalMs"/> on the local clock, <paramref name="stampMs"/> the server
        /// time it is placed at on the render timeline, <paramref name="drawnMs"/> the local time of the last frame drawn
        /// before it landed (not a number before <paramref name="arrivalMs"/>: its lateness counts to the landing). The
        /// lateness counts from that frame, the last one that had to draw without the sample: a frame of the client's own
        /// that stalls is handed the states that waited for it together, and none of them was late for a frame. A stamp
        /// that is not after the last one, or an arrival or a stamp that is no number, is ignored.</summary>
        public void Note(double arrivalMs, double stampMs, double drawnMs = double.NaN)
        {
            if (!IsFinite(arrivalMs) || !IsFinite(stampMs)) return;
            double step = 0;
            if (hasLast)
            {
                step = stampMs - lastStamp;
                if (!(step > 0)) return;
                var silence = arrivalMs - lastArrival;
                if (step > GenexRenderDelay.StallMs || silence > GenexRenderDelay.StallMs)
                {
                    // A stall, not jitter: the window starts over with this sample.
                    head = 0;
                    count = 0;
                    step = 0;
                }
            }
            hasLast = true;
            lastArrival = arrivalMs;
            lastStamp = stampMs;
            var at = (head + count) % Capacity;
            arrivals[at] = arrivalMs;
            transits[at] = arrivalMs - stampMs;
            var seen = IsFinite(drawnMs) && drawnMs < arrivalMs ? drawnMs : arrivalMs;
            needs[at] = seen - stampMs + step;
            count++;
            var oldest = arrivalMs - GenexRenderDelay.WindowMs;
            while (count > 0 && (arrivals[head] < oldest || count > GenexRenderDelay.MaxSamples))
            {
                head = (head + 1) % Capacity;
                count--;
            }
        }

        /// <summary>What the window's worst sample needed, within the bounds: where the delay is heading.</summary>
        public double Target()
        {
            if (count == 0) return floor;
            var best = double.PositiveInfinity;
            var worst = double.NegativeInfinity;
            for (var i = 0; i < count; i++)
            {
                var at = (head + i) % Capacity;
                var transit = transits[at];
                if (transit < best) best = transit;
                var needed = needs[at];
                if (needed > worst) worst = needed;
            }
            var spread = worst - best;
            var asked = spread + GenexRenderDelay.MarginMs;
            return Clamp(asked, floor, ceil);
        }

        /// <summary>Moves the delay towards the target for the frame time since the last call (at most
        /// <see cref="GenexRenderDelay.FrameMaxMs"/> of it; the first call only starts the clock); returns it.</summary>
        public double Frame(double nowMs)
        {
            if (!IsFinite(nowMs)) return delay;
            if (!hasFrame)
            {
                hasFrame = true;
                lastFrame = nowMs;
                return delay;
            }
            var dt = Clamp(nowMs - lastFrame, 0, GenexRenderDelay.FrameMaxMs);
            lastFrame = nowMs;
            var to = Target();
            if (to > delay)
            {
                var risen = GenexRenderDelay.Rise * dt;
                var up = delay + risen;
                delay = to < up ? to : up;
            }
            else
            {
                var fallen = GenexRenderDelay.Fall * dt;
                var down = delay - fallen;
                delay = to > down ? to : down;
            }
            return delay;
        }
    }
}
