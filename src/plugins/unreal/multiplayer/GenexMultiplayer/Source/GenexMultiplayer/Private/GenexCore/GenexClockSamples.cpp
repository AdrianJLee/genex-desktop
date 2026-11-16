// Port of packages/multiplayer/src/authority/clock-samples.ts. See GenexClockSamples.h.
#include "GenexCore/GenexClockSamples.h"

#include <algorithm>
#include <cmath>

GENEX_FP_STRICT_BEGIN

namespace genex::clock_samples {

double ClockSamples::Take(double nowMs, double rttMs) {
  if (!std::isfinite(nowMs)) return kNoRoundTrip;
  // A clock that stepped back earns nothing: nothing is held against a time that is gone.
  const double passed = seen_ ? (std::max)(0.0, nowMs - seenAt_) : 0.0;
  seen_ = true;
  seenAt_ = nowMs;
  credit_ = (std::min)(kClockSampleMs, credit_ + passed);
  const bool due = credit_ >= kClockSampleMs - kClockSampleEarlyMs;
  if (!(rttMs >= 0.0) || !due) return kNoRoundTrip;
  credit_ -= kClockSampleMs;
  return rttMs;
}

void WindowLeast::Note(double atMs, double value, double windowMs) {
  // A value no later one can outlast: whatever this one beats, it beats until it leaves.
  while (!kept_.empty() && kept_.back().second >= value) kept_.pop_back();
  kept_.emplace_back(atMs, value);
  while (!kept_.empty() && kept_.front().first < atMs - windowMs) kept_.pop_front();
}

double PolledArrival::Note(double stampMs, double sinceMs, double readMs, double answersMs) {
  if (!std::isfinite(stampMs) || !std::isfinite(readMs)) return readMs;
  // A clock that stepped back: what was kept is of a time that is gone.
  if (has_ && readMs < lastRead_) Reset();
  if (has_ && !(stampMs > lastStamp_)) return stampMs + transit_;
  lastStamp_ = stampMs;
  lastRead_ = readMs;
  const double read = readMs - stampMs;
  const bool windowed = std::isfinite(sinceMs) && sinceMs < readMs;
  // A frame: the longest wait between two polls of the last kLateRunMs. One poll right behind another (the frame
  // after a stalled one) says nothing of how long a state waits for its frame.
  if (windowed) gaps_.Note(readMs, sinceMs - readMs, kLateRunMs);
  if (!has_) {
    // Nothing says where between the two polls it arrived: at the read, until a sooner read shows the link faster.
    transit_ = read;
    firstRead_ = readMs;
    settleFrom_ = readMs;
    has_ = true;
  } else if (readMs - settleFrom_ < kArrivalSettleMs) {
    transit_ = (std::min)(transit_, read);
  } else if (windowed) {
    // The link takes no longer than stamp to read, and the wait for a frame is under the frame: never more than a
    // frame past a read (a second and a half in which every state missed its frame by a little leaves it that
    // far). More than two past one, the link has become faster: this read is the first of it, and its shortest
    // time is found again.
    const double frame = -gaps_.Value();
    if (read + 2.0 * frame < transit_) {
      transit_ = read;
      settleFrom_ = readMs;
    } else {
      transit_ = (std::min)(transit_, read + frame);
    }
  }
  if (windowed) {
    // It was still missing at the poll before. When that poll was past the link's time for every state of
    // kLateRunMs, the link has become slower.
    missing_.Note(readMs, sinceMs - stampMs, kLateRunMs);
    if (readMs - firstRead_ >= kLateRunMs) transit_ = (std::max)(transit_, missing_.Value());
  }
  // It answers an input, so it left the room after that input left here.
  if (std::isfinite(answersMs) && answersMs <= readMs) transit_ = (std::max)(transit_, answersMs - stampMs);
  return stampMs + transit_;
}

void PolledArrival::Reset() {
  transit_ = 0.0;
  has_ = false;
  firstRead_ = 0.0;
  settleFrom_ = 0.0;
  lastStamp_ = 0.0;
  lastRead_ = 0.0;
  missing_.Clear();
  gaps_.Clear();
}

double PacedRoundTrip::Note(double arrivedMs, double stampMs, double rttMs) {
  if (!std::isfinite(arrivedMs) || !std::isfinite(stampMs)) return kNoRoundTrip;
  const double handed = samples_.Take(arrivedMs, rttMs);
  if (!(handed >= 0.0)) return kNoRoundTrip;
  const bool outlier = smoothed_ > 0.0 && handed > smoothed_ * kRoundTripOutlier;
  if (outlier) return handed;
  const double arriving = stampMs - arrivedMs;
  smoothed_ = has_ ? smoothed_ * (1.0 - kRoundTripWeight) + handed * kRoundTripWeight : handed;
  arriving_ = has_ ? arriving_ * (1.0 - kRoundTripWeight) + arriving * kRoundTripWeight : arriving;
  has_ = true;
  return handed;
}

void PacedRoundTrip::Reset() {
  smoothed_ = 0.0;
  arriving_ = 0.0;
  has_ = false;
}

double StampDelayMs(double renderDelayMs, double clockRttMs, double clockPastArrivingMs) {
  const double roundTrip = std::isfinite(clockRttMs) && clockRttMs > 0.0 ? clockRttMs : 0.0;
  const double past = std::isfinite(clockPastArrivingMs) ? clockPastArrivingMs : 0.0;
  return (std::max)(0.0, renderDelayMs + past - roundTrip / 2.0);
}

double StampHoldMs(double renderDelayMs, double clockRttMs, double clockPastArrivingMs) {
  const double roundTrip = std::isfinite(clockRttMs) && clockRttMs > 0.0 ? clockRttMs : 0.0;
  const double past = std::isfinite(clockPastArrivingMs) ? clockPastArrivingMs : 0.0;
  return (std::max)(0.0, roundTrip / 2.0 - past - renderDelayMs);
}

}  // namespace genex::clock_samples

GENEX_FP_STRICT_END
