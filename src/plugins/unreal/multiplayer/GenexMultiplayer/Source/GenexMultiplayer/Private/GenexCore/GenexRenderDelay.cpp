// See GenexRenderDelay.h (render-delay.ts). Every line of arithmetic is the reference's, in its order.
#include "GenexCore/GenexRenderDelay.h"

#include "GenexCore/GenexJson.h"

#include <cmath>
#include <limits>

GENEX_FP_STRICT_BEGIN

namespace genex::render_delay {

namespace render_delay_detail {

namespace timing = ::genex::protocol::authority_timing;

/** render-delay.ts `clamp`: `v < lo ? lo : v > hi ? hi : v`. */
double Clamp(double v, double lo, double hi) {
  if (v < lo) return lo;
  return v > hi ? hi : v;
}

/** render-delay.ts `isCeiling`: a whole number in [kRenderDelayMs, kRenderDelayMaxMs]. */
bool IsCeiling(const Json* v) {
  if (v == nullptr || !v->IsNumber()) return false;
  const double n = v->AsNumber();
  return std::isfinite(n) && std::floor(n) == n && n >= timing::kRenderDelayMs && n <= timing::kRenderDelayMaxMs;
}

}  // namespace render_delay_detail

void RenderDelayBuffer::Bounds(double floorMs, double ceilMs) {
  floor_ = std::isfinite(floorMs) && floorMs >= 0 ? floorMs : protocol::authority_timing::kRenderDelayMs;
  ceil_ = std::isfinite(ceilMs) && ceilMs > floor_ ? ceilMs : floor_;
  delay_ = render_delay_detail::Clamp(delay_, floor_, ceil_);
}

void RenderDelayBuffer::Note(double arrivalMs, double stampMs, double drawnMs) {
  if (!std::isfinite(arrivalMs) || !std::isfinite(stampMs)) return;
  double step = 0;
  if (hasLast_) {
    step = stampMs - lastStamp_;
    if (!(step > 0)) return;
    if (step > kStallMs || arrivalMs - lastArrival_ > kStallMs) {
      samples_.clear();
      step = 0;
    }
  }
  hasLast_ = true;
  lastArrival_ = arrivalMs;
  lastStamp_ = stampMs;
  const double seen = std::isfinite(drawnMs) && drawnMs < arrivalMs ? drawnMs : arrivalMs;
  samples_.push_back(Sample{arrivalMs, arrivalMs - stampMs, seen - stampMs + step});
  while (!samples_.empty() && (samples_.front().arrival < arrivalMs - kWindowMs || samples_.size() > kMaxSamples)) samples_.pop_front();
}

void RenderDelayBuffer::Restart() {
  samples_.clear();
  hasLast_ = false;
}

double RenderDelayBuffer::Target() const {
  if (samples_.empty()) return floor_;
  double base = std::numeric_limits<double>::infinity();
  double worst = -std::numeric_limits<double>::infinity();
  for (const Sample& s : samples_) {
    if (s.transit < base) base = s.transit;
    if (s.need > worst) worst = s.need;
  }
  return render_delay_detail::Clamp(worst - base + kMarginMs, floor_, ceil_);
}

double RenderDelayBuffer::Frame(double nowMs) {
  if (!std::isfinite(nowMs)) return delay_;
  if (!lastFrame_) {
    lastFrame_ = nowMs;
    return delay_;
  }
  const double dt = render_delay_detail::Clamp(nowMs - *lastFrame_, 0, kFrameMaxMs);
  lastFrame_ = nowMs;
  const double to = Target();
  if (to > delay_) {
    // Math.min(to, delay + RISE * dt)
    const double risen = delay_ + kRise * dt;
    delay_ = to < risen ? to : risen;
  } else {
    // Math.max(to, delay - FALL * dt)
    const double fallen = delay_ - kFall * dt;
    delay_ = to > fallen ? to : fallen;
  }
  return delay_;
}

std::optional<double> PresetRenderDelayMax(std::string_view presetText) {
  const std::optional<Json> spec = Json::Parse(presetText);
  const Json* setting = spec && spec->IsObject() ? spec->Find("interpolation") : nullptr;
  const Json* ceiling = setting != nullptr && setting->IsObject() ? setting->Find("maxDelayMs") : nullptr;
  if (!render_delay_detail::IsCeiling(ceiling) || !(ceiling->AsNumber() > protocol::authority_timing::kRenderDelayMs)) return std::nullopt;
  return ceiling->AsNumber();
}

}  // namespace genex::render_delay

GENEX_FP_STRICT_END
