// The room clock's round-trip samples (PROTOCOL.md §17.3 *The clock's samples*), a port of
// packages/multiplayer/src/authority/clock-samples.ts. The Colyseus clock smooths its round trip with a fixed weight
// per sample, and takes a sample from every state that acknowledges a new input: every state, while a seat plays. Other
// entities are drawn half that smoothed round trip behind the clock's estimate of the server (and a shot's render time
// says so), so the render time moves with it. Two things followed from the weight being per sample:
//  - how fast it follows the link depended on how often the room sends: three times as fast at 60 updates a second as
//    on the 50 ms timer the weight was tuned on;
//  - a WebSocket stall's burst (TCP hands over what it held at once, each state late by its wait) pulled it up by every
//    state in it: 26 ms for three on the timer, 46 ms for nine at 60 a second, which stepped the render time back 23 ms
//    in a frame and drew other players going backwards.
// So the session hands the clock one round trip per SampleMs on average, whatever the room's rate: the others reach it
// as states that carry none (the clock still takes their stamp).
//
//
// The arrival of a state (§17.3 *A state's arrival*). The TypeScript client hears of a state when its socket has it.
// Under Unity the socket's states wait for the frame: the session drains them in Frame(), and what lands after that
// is posted to the main thread, which runs it once a frame. So all this client knows of an arrival is the drain that
// read it, and taking the drain's own time for it puts the wait for the frame, up to a frame, into every sample: half
// of it into the clock's offset and all of it into the round trip, so the render time sat that much further behind
// the server, by a wait that at a frame rate near the room's update rate is the same for seconds and creeps.
// GenexPolledArrival times every state by its stamp instead: a state stamped S arrives at S plus the link's time, one
// number for the link, whichever frame reads it and however late it came. That number is the shortest time from stamp
// to read of the first second and a half (a frame rate off the room's rate walks the reads across the frame, and the
// shortest is the link's own time; at the room's own rate nothing shows the wait for the frame, and it stays in), and
// from then on it is held. Where the frames fall no longer moves it. Only the link does: a state read more than a
// frame before it says (the link is faster: it is taken a frame past that read, and past two the link's time is found
// again), a second in which every state was still missing at a drain after it says (slower), an answer to an input
// before that input left. So a state is taken to arrive within a frame of when it did, or within two after the link
// has become faster. And the render time is read off those arrivals: GenexPacedClock answers, as the round trip, the
// one that puts the server's time less half of it on the stamp of a state arriving now. A link's jitter and its
// stalls do not reach the render time this way; the render delay is what covers them (RenderDelay.cs, which is fed
// the reads themselves). The port of the Unreal core's `PolledArrival` (GenexClockSamples.h), row for row with its
// check.
//
// Held to the TypeScript's own test rows (authority-clock-samples.test.ts) by Tests~/GenexSmoke `clock-samples`, with
// the arrival's rows beside them. Engine-agnostic: no UnityEngine.
using System;
using System.Collections.Generic;
using Colyseus;

namespace Genex.Multiplayer.Authority
{
    /// <summary>Which round trips reach the room clock (clock-samples.ts <c>createClockSamples</c>). A fresh one passes the next.</summary>
    public sealed class GenexClockSamples
    {
        /// <summary>The time one round trip handed to the clock pays for, ms: the period of the 50 ms patch timer the clock's
        /// per-sample weight (0.1) was tuned on, so its smoothing keeps that time constant.</summary>
        public const double SampleMs = 50;
        /// <summary>How early a state's round trip may be handed over, ms: a room that sends every 50 ms hands over every one
        /// though a jittery link lands its states up to this far apart from that, and what came early is owed back, so the
        /// average stays one per <see cref="SampleMs"/>.</summary>
        public const double SampleEarlyMs = 20;

        /// <summary>Time not yet paid for by a round trip handed over, ms: at most one sample's worth.</summary>
        private double credit = SampleMs;
        private double seenAt = double.NaN;

        /// <summary>A state arrived at <paramref name="nowMs"/> (any steady clock) carrying the round trip
        /// <paramref name="rttMs"/> (below 0: none): what to hand the clock for it, <paramref name="rttMs"/> or -1 for none.</summary>
        public double Take(double nowMs, double rttMs)
        {
            if (double.IsNaN(nowMs) || double.IsInfinity(nowMs)) return -1;
            // A clock that stepped back earns nothing: nothing is held against a time that is gone.
            var passed = double.IsNaN(seenAt) ? 0 : Math.Max(0, nowMs - seenAt);
            seenAt = nowMs;
            credit = Math.Min(SampleMs, credit + passed);
            if (!(rttMs >= 0) || credit < SampleMs - SampleEarlyMs) return -1;
            credit -= SampleMs;
            return rttMs;
        }

        /// <summary><paramref name="clock"/> with a pacer in front of its <see cref="RoomClock.Sample"/>, timed by
        /// <paramref name="now"/> (ms); a clock that is paced already is returned as it is.</summary>
        public static RoomClock Pace(RoomClock clock, Func<double> now)
        {
            if (clock == null) throw new ArgumentNullException(nameof(clock));
            if (now == null) throw new ArgumentNullException(nameof(now));
            return clock is GenexPacedClock ? clock : new GenexPacedClock(clock, now);
        }
    }

    /// <summary>The least of the values noted in the last stretch of time (a sliding window's minimum).</summary>
    internal sealed class GenexWindowLeast
    {
        /// <summary>[when, value], the least first and every later one that can become it.</summary>
        private readonly LinkedList<KeyValuePair<double, double>> kept = new LinkedList<KeyValuePair<double, double>>();

        public bool Empty => kept.Count == 0;
        /// <summary>The least (only when not <see cref="Empty"/>).</summary>
        public double Value => kept.First.Value.Value;
        public void Clear() => kept.Clear();

        /// <summary>Notes <paramref name="value"/> at <paramref name="atMs"/> (never before the last one noted) and drops what
        /// is older than <paramref name="windowMs"/>.</summary>
        public void Note(double atMs, double value, double windowMs)
        {
            // A value no later one can outlast: whatever this one beats, it beats until it leaves.
            while (kept.Count > 0 && kept.Last.Value.Value >= value) kept.RemoveLast();
            kept.AddLast(new KeyValuePair<double, double>(atMs, value));
            while (kept.Count > 0 && kept.First.Value.Key < atMs - windowMs) kept.RemoveFirst();
        }
    }

    /// <summary>When a state arrived, for a client that reads its socket once a frame (see the top of this file).</summary>
    public sealed class GenexPolledArrival
    {
        /// <summary>How long after its first state the shortest time from stamp to read is taken for the link's own, ms: the
        /// clock's own warm-up (RoomClock: 30 round trips, at one per <see cref="GenexClockSamples.SampleMs"/>).</summary>
        public const double SettleMs = 30 * GenexClockSamples.SampleMs;
        /// <summary>How long every state must have been late for the link itself to be the slower one, ms: a stall, as the
        /// render delay tells one from jitter (§17.3 *The render delay*, STALL_MS).</summary>
        public const double LateRunMs = 1000;

        /// <summary>The link's time as this client's clock less the room's, ms: a state stamped S is taken to arrive at S + transit.</summary>
        private double transit;
        private bool has;
        private double firstRead;
        /// <summary>The read from which the shortest time from stamp to read is being taken for <see cref="SettleMs"/>.</summary>
        private double settleFrom;
        private double lastStamp;
        private double lastRead;
        /// <summary>The drain before less stamp, the least of the states of the last <see cref="LateRunMs"/>: all of them were
        /// still missing that long after their stamps.</summary>
        private readonly GenexWindowLeast missing = new GenexWindowLeast();
        /// <summary>Less the wait between a state's two drains, the least of the last <see cref="LateRunMs"/>: the longest such
        /// wait, a frame.</summary>
        private readonly GenexWindowLeast gaps = new GenexWindowLeast();

        private static bool Finite(double v) => !double.IsNaN(v) && !double.IsInfinity(v);

        /// <summary>
        /// A state stamped <paramref name="stampMs"/> on the room's clock was read at <paramref name="readMs"/> on this
        /// client's, by a drain that reads whatever arrived since <paramref name="sinceMs"/> (the drain before it; no
        /// number: not known), acknowledging an input that left at <paramref name="answersMs"/> (no number: none). Returns
        /// when it is taken to have arrived, its stamp plus the link's time (which can be after this read, by under a
        /// frame), and <paramref name="readMs"/> itself for a stamp or a read that is no number. A stamp not after the last
        /// one teaches nothing.
        /// </summary>
        public double Note(double stampMs, double sinceMs, double readMs, double answersMs)
        {
            if (!Finite(stampMs) || !Finite(readMs)) return readMs;
            // A clock that stepped back: what was kept is of a time that is gone.
            if (has && readMs < lastRead) Reset();
            if (has && !(stampMs > lastStamp)) return stampMs + transit;
            lastStamp = stampMs;
            lastRead = readMs;
            var read = readMs - stampMs;
            var windowed = Finite(sinceMs) && sinceMs < readMs;
            // A frame: the longest wait between two drains of the last LateRunMs. One drain right behind another (the
            // frame after a stalled one) says nothing of how long a state waits for its frame.
            if (windowed) gaps.Note(readMs, sinceMs - readMs, LateRunMs);
            if (!has)
            {
                // Nothing says where between the two drains it arrived: at the read, until a sooner read shows the link faster.
                transit = read;
                firstRead = readMs;
                settleFrom = readMs;
                has = true;
            }
            else if (readMs - settleFrom < SettleMs)
            {
                transit = Math.Min(transit, read);
            }
            else if (windowed)
            {
                // The link takes no longer than stamp to read, and the wait for a frame is under the frame: never more than a
                // frame past a read (a second and a half in which every state missed its frame by a little leaves it that
                // far). More than two past one, the link has become faster: this read is the first of it, and its shortest
                // time is found again.
                var frame = -gaps.Value;
                if (read + 2 * frame < transit)
                {
                    transit = read;
                    settleFrom = readMs;
                }
                else
                {
                    transit = Math.Min(transit, read + frame);
                }
            }
            if (windowed)
            {
                // It was still missing at the drain before. When that drain was past the link's time for every state of
                // LateRunMs, the link has become slower.
                missing.Note(readMs, sinceMs - stampMs, LateRunMs);
                if (readMs - firstRead >= LateRunMs) transit = Math.Max(transit, missing.Value);
            }
            // It answers an input, so it left the room after that input left here.
            if (Finite(answersMs) && answersMs <= readMs) transit = Math.Max(transit, answersMs - stampMs);
            return stampMs + transit;
        }

        /// <summary>A new socket: nothing is known of its link.</summary>
        public void Reset()
        {
            transit = 0;
            has = false;
            firstRead = 0;
            settleFrom = 0;
            lastStamp = 0;
            lastRead = 0;
            missing.Clear();
            gaps.Clear();
        }
    }

    /// <summary>
    /// A room clock read through a pacer (clock-samples.ts <c>paceClockSamples</c>), in <c>room.Clock</c>, so the SDK's
    /// own state frames and the fast channel's snapshots alike go through it: every sample reaches the clock it stands
    /// in front of with its stamp, and with its round trip only when the pacer hands it over, and what is read is that
    /// clock's (<see cref="RoomClock.RenderNow"/> is this one's own slew over that clock's <see cref="ServerNow"/>), but
    /// for the round trip a render time is placed by (<see cref="SmoothedRtt"/>, §17.3 *A state's arrival*).
    /// <see cref="RoomClock.Reset"/> is not virtual and would not reach the clock behind; Colyseus 0.18 never calls it,
    /// and a reconnect keeps the clock.
    /// </summary>
    public sealed class GenexPacedClock : RoomClock
    {
        /// <summary>The weight of one state in the arriving stamp (RoomClock EmaAlpha, as its round trip's).</summary>
        private const double Weight = 0.1;
        /// <summary>A round trip past this many times the smoothed one is left out (RoomClock RttOutlierX).</summary>
        private const double Outlier = 4;

        private readonly RoomClock clock;
        private readonly Func<double> now;
        private readonly GenexClockSamples samples = new GenexClockSamples();
        private readonly GenexPolledArrival arrival = new GenexPolledArrival();
        /// <summary>The stamp of a state arriving now, less this client's clock, ms: seeded by the first state whose round
        /// trip was handed over, then a tenth of each later one's stamp less its arrival.</summary>
        private double arriving;
        private bool arrives;

        /// <summary>
        /// Since when the drain that is reading the socket now reads (the drain before it, ms on this clock's
        /// <c>now</c>), or no number when states reach the clock as they arrive (a WebGL socket's callbacks, a host
        /// that dispatches off the frame). The session sets it; unset, every state is timed at its read.
        /// </summary>
        public Func<double> PolledSince;

        internal GenexPacedClock(RoomClock clock, Func<double> now)
        {
            this.clock = clock;
            this.now = now;
        }

        public override double Now() => clock.Now();
        public override double ServerNow() => clock.ServerNow();
        public override double Rtt() => clock.Rtt();
        /// <summary>
        /// The round trip a render time is placed by, ms: the one that puts <see cref="ServerNow"/> less half of it on
        /// the stamp of a state arriving now, each state timed by <see cref="GenexPolledArrival"/> where the session says
        /// since when its socket was drained, by its read otherwise. So everything that draws at the server's time less
        /// a delay and half the round trip (the session, the SDK's input handle and its Predict) draws at that stamp less
        /// the delay. The clock's own smoothed round trip (<see cref="LinkRtt"/>) and its offset are not read off the
        /// same thing: both take the drain's instant for an arrival, the round trip counts the wait for the room's next
        /// update after an input lands, and the offset leaves most of that wait out (its gate), so the offset less half
        /// that round trip moved with where a frame fell between two updates. The clock's own until a round trip was
        /// handed over.
        /// </summary>
        public override double SmoothedRtt() => arrives ? 2 * (clock.ServerNow() - clock.Now() - arriving) : clock.SmoothedRtt();
        /// <summary>The clock's own smoothed round trip, ms: every round trip handed over, as the drains read them.</summary>
        public double LinkRtt => clock.SmoothedRtt();
        public override double Jitter() => clock.Jitter();
        public override double LastServerTime() => clock.LastServerTime();
        public override double PatchInterval() => clock.PatchInterval();
        public override void SetPatchInterval(double milliseconds) => clock.SetPatchInterval(milliseconds);

        public override void Sample(double sNow, double rttSample)
        {
            var read = now();
            var since = PolledSince != null ? PolledSince() : double.NaN;
            var polled = !double.IsNaN(since) && !double.IsInfinity(since) && since < read;
            // The input this state answers left a round trip before the read.
            var arrived = polled ? arrival.Note(sNow, since, read, rttSample >= 0 ? read - rttSample : double.NaN) : read;
            var handed = samples.Take(read, rttSample);
            // The clock leaves a round trip past four times its smoothed one out (RttOutlierX): so does the arriving stamp.
            var before = clock.SmoothedRtt();
            var carries = handed >= 0 && !(before > 0 && handed > before * Outlier);
            clock.Sample(sNow, handed);
            if (!carries || double.IsNaN(sNow) || double.IsInfinity(sNow)) return;
            arriving = arrives ? arriving * (1 - Weight) + (sNow - arrived) * Weight : sNow - arrived;
            arrives = true;
        }
    }
}
