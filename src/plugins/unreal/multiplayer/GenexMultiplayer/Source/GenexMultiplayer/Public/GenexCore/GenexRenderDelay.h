// The render delay (PROTOCOL.md §17.3 *The render delay*): how far behind the server a client draws
// every entity it does not predict. A fixed delay is right for one link only: on a steady one it adds
// latency nothing needs, and on a jittery one a sample that lands later than the delay covers leaves the
// interpolation holding its newest pose, then jumping when the next arrives (a rubber band). So a client
// measures its own link: each sample's lateness against the best transit of the last ten seconds, plus
// the step to the sample before it, is the delay that sample needed. The delay follows the worst of them
// between the floor (the game's own delay, protocol::authority_timing::kRenderDelayMs by default) and the
// ceiling the room publishes, rising fast (playback slows by a fifth) and falling slowly (a fiftieth), so
// nothing drawn ever steps. The client stamps its inputs with the delay it draws at, and the room rewinds
// no further than its ceiling explains (§17.5), which is why the ceiling is the room's: a room that
// publishes none (an older host, a stand with the setting off) keeps every client at the floor.
//
// Port of packages/multiplayer/src/authority/render-delay.ts (`createRenderDelay`,
// `presetRenderDelayMax`): doubles, only + − × and comparisons, in the reference's order, unfused
// (GENEX_FP_STRICT_BEGIN). Held to packages/netcode-bench/conformance/authority/render-delay.json, bit
// for bit, by genex_render_delay_check. The server's half (`resolveRenderDelayMax`) is not ported: no
// client resolves a module's config.
#pragma once

#include "GenexCore/GenexConfig.h"
#include "GenexCore/GenexProtocol.h"

#include <cstddef>
#include <deque>
#include <limits>
#include <optional>
#include <string_view>

namespace genex::render_delay {

/** How long a sample counts, ms: the worst of this window sizes the delay. */
inline constexpr double kWindowMs = 10000.0;
/** The most samples kept (a 120 Hz stream fills the window past this; the oldest go first). */
inline constexpr std::size_t kMaxSamples = 1024;
/** Added to what the worst sample needed, ms: a frame's worth of room. */
inline constexpr double kMarginMs = 10.0;
/** How fast the delay rises, ms per ms of frame time: other entities play at four fifths speed meanwhile. */
inline constexpr double kRise = 0.2;
/** How fast it falls, ms per ms: they play a fiftieth faster, which nobody sees. */
inline constexpr double kFall = 0.02;
/** A step or a silence longer than this is a stall, not jitter, ms: nothing interpolates across it. */
inline constexpr double kStallMs = 1000.0;
/** The most frame time one frame moves the delay by, ms (a game that slept). */
inline constexpr double kFrameMaxMs = 250.0;

/** The render delay of one client, as it measures its link. A fresh buffer's floor and ceiling are
 *  kRenderDelayMs (a fixed delay) until Bounds. */
class GENEX_CORE_API RenderDelayBuffer {
 public:
  /** The delay other entities are drawn behind now, ms. */
  double Delay() const { return delay_; }
  /** How many samples the window holds. */
  std::size_t Samples() const { return samples_.size(); }
  /** Sets the floor (not a number at least 0: kRenderDelayMs) and the ceiling (not a number above the
   *  floor: the floor, a fixed delay). The delay is held to them at once. */
  void Bounds(double floorMs, double ceilMs);
  /** A sample landed: `arrivalMs` on the local clock, `stampMs` the server time it is placed at on the
   *  render timeline, `drawnMs` the local time of the last frame drawn before it landed (not a number before
   *  `arrivalMs`: its lateness counts to the landing). The lateness counts from that frame, the last one that
   *  had to draw without the sample: a frame of the client's own that stalls reads the states that waited for
   *  it together, and none of them was late for a frame. A stamp that is not after the last one, or an arrival
   *  or a stamp that is no number, is ignored. */
  void Note(double arrivalMs, double stampMs, double drawnMs = std::numeric_limits<double>::quiet_NaN());
  /** What the window's worst sample needed, within the bounds: where the delay is heading. */
  double Target() const;
  /** Moves the delay towards the target for the frame time since the last call; returns it. */
  double Frame(double nowMs);

 private:
  struct Sample {
    double arrival = 0.0;
    double transit = 0.0;
    double need = 0.0;
  };
  double floor_ = protocol::authority_timing::kRenderDelayMs;
  double ceil_ = protocol::authority_timing::kRenderDelayMs;
  double delay_ = protocol::authority_timing::kRenderDelayMs;
  std::deque<Sample> samples_;
  bool hasLast_ = false;
  double lastArrival_ = 0.0;
  double lastStamp_ = 0.0;
  std::optional<double> lastFrame_;
};

/** The room's ceiling as a client reads it from the state's `preset` text (JSON, its `interpolation`
 *  key, read the way input_repeat::InputRepeatOf reads `inputs`): a whole number above kRenderDelayMs and
 *  at most kRenderDelayMaxMs, else none (an older host, a room without the setting, or a hostile value:
 *  the fixed delay). */
GENEX_CORE_API std::optional<double> PresetRenderDelayMax(std::string_view presetText);

}  // namespace genex::render_delay
