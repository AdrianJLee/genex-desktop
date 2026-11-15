// The room clock's round-trip samples (PROTOCOL.md §17.3 *The clock's samples*). A clock smooths its round
// trip with a fixed weight per sample and gets a sample from every state that acknowledges a new input:
// every state, while a seat plays. Other entities are drawn half that smoothed round trip behind the clock's
// estimate of the server (and an input's render-time stamp says so), so the render time moves with it. Two
// things followed from the weight being per sample:
//  - how fast it follows the link depended on how often the room sends: three times as fast at 60 updates a
//    second as on the 50 ms timer the weight was tuned on;
//  - a WebSocket stall's burst (TCP hands over what it held at once, each state late by its wait) pulled it
//    up by every state in it: 21 ms for four on the timer, 39 ms for eleven at 60 a second (update-rate.ts's
//    180 ms hold on a 50 ms link), which steps the render time back by half of it in one frame and draws
//    other players going backwards.
// So one round trip per kClockSampleMs reaches the estimate, whatever the room's rate.
//
// ClockSamples is the port of packages/multiplayer/src/authority/clock-samples.ts (`createClockSamples`),
// row for row with its test. The TypeScript session puts it in front of its SDK's `clock.sample`. The
// Colyseus C core samples its own clock inside its WebSocket decode, where nothing can stand in front, so
// here the session keeps the round trip it draws by itself: PacedRoundTrip, the clock's own round-trip
// estimate (RoomClock.ts: seeded by the first sample, a tenth of each later one, one past four times the
// estimate left out) fed through ClockSamples from both channels, and beside it the stamp of a state arriving
// now. The render time, the inputs' render-time stamps and AuthoritySession::Rtt() read it
// (GenexAuthoritySession.cpp).
//
// The arrival of a state. The TypeScript client hears of a state when its socket has it. This client reads
// its socket once a frame (GenexPump.h), so all it knows of an arrival is the frame that read it: the state
// came after the poll before and by this one. Taking the poll's own time for it puts the wait for the poll,
// up to a frame, into every sample: half of it into the clock's offset and all of it into the round trip, so
// the render time sat that much further behind the server. At a frame rate near the room's update rate that
// wait is the same for seconds and creeps (59.95 frames a second against 60 updates: a frame's worth in 20 s,
// then back at once), and where a frame falls right at an update, states are read now a frame late and now
// not. Car-ball's release-1 room on a 100 ms link, the editor at 60 frames a second: other cars were drawn 148
// to 157 ms behind in one run, moving second by second with the frames that read no state, and their motion
// read 13.5 from the server's own where it read 6.1 against each second's own lag.
// So PolledArrival times every state by its stamp: a state stamped S arrives at S plus the link's time, one
// number for the link, whichever frame reads it and however late it came. That number is the shortest time
// from stamp to read of the first second and a half (a frame rate off the room's rate walks the reads across
// the frame, and the shortest is the link's own time; at the room's own rate nothing shows the wait for the
// frame, and it stays in), and from then on it is held. Where the frames fall no longer moves it. Only the
// link does: a state read more than a frame before it says (the link is faster: it is taken a frame past that
// read, and past two the link's time is found again), a second in which every state was still missing at a
// poll after it says (slower), an answer to an input before that input left. So a state is taken to arrive
// within a frame of when it did, or within two after the link has become faster. A link's jitter and its
// stalls do not reach the render time this way; the render delay is what covers them (GenexRenderDelay.h,
// which is fed the reads themselves).
// And the render time is read off those arrivals: other entities are drawn at the stamp of a state arriving
// now (PacedRoundTrip::ArrivingMs) less the render delay. That is what the room's time less half the round
// trip comes to (§17.3) when both are read from the same arrivals. Taken from the C core's clock and a round
// trip they are not: the round trip counts the wait for the room's next update after an input lands, up to an
// update's interval, which moves with where a frame falls too, and that clock's offset leaves most of the
// wait out (its gate takes round trips near the shortest), so the difference moved by half an interval on a
// link shorter than five intervals (7.5 ms in a cycle of 20 s on a 10 ms link, once the arrival no longer
// hid it).
#pragma once

#include "GenexCore/GenexConfig.h"

#include <deque>
#include <utility>

namespace genex::clock_samples {

/** The time one round trip handed over pays for, ms: the period of the 50 ms patch timer the clock's
 *  per-sample weight was tuned on, so its smoothing keeps that time constant. */
inline constexpr double kClockSampleMs = 50.0;
/** How early a state's round trip may be handed over, ms: a room that sends every 50 ms hands over every
 *  one though a jittery link lands its states up to this far apart from that, and what came early is owed
 *  back, so the average stays one per kClockSampleMs. */
inline constexpr double kClockSampleEarlyMs = 20.0;
/** What a state without a round trip carries, and what Take answers for one not handed over. */
inline constexpr double kNoRoundTrip = -1.0;
/** The weight of one round trip in the smoothed one (RoomClock.ts EMA_ALPHA). */
inline constexpr double kRoundTripWeight = 0.1;
/** A round trip past this many times the smoothed one is left out (RoomClock.ts RTT_OUTLIER_X). */
inline constexpr double kRoundTripOutlier = 4.0;
/** How long after its first state PolledArrival takes the shortest time from stamp to read for the link's own, ms:
 *  the SDK clock's own warm-up (RoomClock.ts RTT_GATE_WARMUP, 30 round trips) at one round trip per kClockSampleMs. */
inline constexpr double kArrivalSettleMs = 30.0 * kClockSampleMs;
/** How long every state must have been late for the link itself to be the slower one, ms: a stall, as the render
 *  delay tells one from jitter (§17.3 *The render delay*, STALL_MS). */
inline constexpr double kLateRunMs = 1000.0;

/** Which round trips reach the estimate. A fresh one hands over the next round trip. */
class GENEX_CORE_API ClockSamples {
 public:
  /** A state arrived at `nowMs` (any steady clock) carrying the round trip `rttMs` (below 0, or no number:
   *  none): what to hand over for it, `rttMs` or kNoRoundTrip. A state that carries none spends nothing, a
   *  clock that stepped back earns nothing, and a time that is no number hands nothing. */
  double Take(double nowMs, double rttMs);

 private:
  /** Time not yet paid for by a round trip handed over, ms: at most one sample's worth. */
  double credit_ = kClockSampleMs;
  bool seen_ = false;
  double seenAt_ = 0.0;
};

/** The least of the values noted in the last stretch of time (a sliding window's minimum). */
class GENEX_CORE_API WindowLeast {
 public:
  /** Notes `value` at `atMs` (never before the last one noted) and drops what is older than `windowMs`. */
  void Note(double atMs, double value, double windowMs);
  /** The least (after a Note). */
  double Value() const { return kept_.front().second; }
  void Clear() { kept_.clear(); }

 private:
  /** [when, value], the least first and every later one that can become it. */
  std::deque<std::pair<double, double>> kept_;
};

/** When a state arrived, for a client that reads its socket once a frame (see the top of this file). */
class GENEX_CORE_API PolledArrival {
 public:
  /** A state stamped `stampMs` on the room's clock was read at `readMs` on this client's, by a poll that reads
   *  whatever arrived since `sinceMs` (the poll before it; no number: not known), acknowledging an input that left
   *  at `answersMs` (no number: none). Returns when it is taken to have arrived, its stamp plus the link's time
   *  (which can be after this read, by under a frame), and `readMs` itself for a stamp or a read that is no
   *  number. A stamp not after the last one teaches nothing. */
  double Note(double stampMs, double sinceMs, double readMs, double answersMs);
  /** A new socket: nothing is known of its link. */
  void Reset();

 private:
  /** The link's time as this client's clock less the room's, ms: a state stamped S is taken to arrive at
   *  S + transit_. */
  double transit_ = 0.0;
  bool has_ = false;
  double firstRead_ = 0.0;
  /** The read from which the shortest time from stamp to read is being taken for kArrivalSettleMs. */
  double settleFrom_ = 0.0;
  double lastStamp_ = 0.0;
  double lastRead_ = 0.0;
  /** The poll before less stamp, the least of the states of the last kLateRunMs: all of them were still missing
   *  that long after their stamps. */
  WindowLeast missing_;
  /** Less the wait between a state's two polls, the least of the last kLateRunMs: the longest such wait, a frame. */
  WindowLeast gaps_;
};

/** What a session draws by: the smoothed round trip, every state's round trip through ClockSamples and then the
 *  clock's own estimate, and the stamp of a state arriving now, read from the same states. */
class GENEX_CORE_API PacedRoundTrip {
 public:
  /** A state stamped `stampMs` on the room's clock arrived at `arrivedMs` on this client's, carrying the round
   *  trip `rttMs` (below 0: none). Returns what ClockSamples handed over, `rttMs` or kNoRoundTrip: what a clock
   *  fed beside this one is given. A time that is no number is not noted. */
  double Note(double arrivedMs, double stampMs, double rttMs);
  /** The smoothed round trip, ms; 0 until the first one handed over. */
  double SmoothedMs() const { return smoothed_; }
  /** Whether a round trip was handed over: before it nothing says what stamp arrives now. */
  bool Arrives() const { return has_; }
  /** The stamp of a state arriving now, less this client's clock, ms (0 until Arrives): seeded by the first state
   *  whose round trip was handed over, then a tenth of each later one's stamp less its arrival. */
  double ArrivingMs() const { return arriving_; }
  /** A reconnect: both start again from the next round trip. */
  void Reset();

 private:
  ClockSamples samples_;
  double smoothed_ = 0.0;
  double arriving_ = 0.0;
  bool has_ = false;
};

/** The render delay an input handle is told, ms, so the render time it stamps on an input is the one the session
 *  draws at. The handle stamps its own clock's `serverNow − (delay + clockRttMs / 2)`, `clockRttMs` being that
 *  clock's smoothed round trip; the session draws other entities at the stamp of a state arriving now less
 *  `renderDelayMs`, and the handle's clock reads the server's time `clockPastArrivingMs` past that stamp. So the
 *  delay carries the difference, never below 0 (the handle's own floor). A round trip that is no number, or below
 *  0, counts as none (0), and so does a `clockPastArrivingMs` that is no number. */
GENEX_CORE_API double StampDelayMs(double renderDelayMs, double clockRttMs, double clockPastArrivingMs);

/** How far behind the stamp of a state arriving now less `renderDelayMs` a session draws other entities, ms, so that
 *  the input handle can say the instant it draws (§17.3: an input's stamp is the render time its frame drew at). The
 *  handle takes no delay below 0, so the newest instant it can stamp is its clock's server time less half that
 *  clock's round trip, which is `clockPastArrivingMs − clockRttMs / 2` past the arriving stamp. That clock takes
 *  every state's round trip, so on a jittery link half of it is more than its server time reads past the arriving
 *  stamp, and a render delay shorter than the difference would be drawn nearer the server than any stamp says: a
 *  shot rewound further than it was aimed. 0 wherever the render delay reaches that far back, which the default
 *  does on a playable link once the estimates have settled. `StampDelayMs(renderDelayMs + this, …)` is then never
 *  held at its floor. Arguments that are no numbers count as in StampDelayMs. */
GENEX_CORE_API double StampHoldMs(double renderDelayMs, double clockRttMs, double clockPastArrivingMs);

}  // namespace genex::clock_samples
