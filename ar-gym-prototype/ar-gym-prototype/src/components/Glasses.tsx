/**
 * The glasses the participant "wears".
 *
 * With the phone sideways, everything the participant sees sits inside one
 * wide lens: a rounded window onto the camera, surrounded by a dark frame that
 * is a little thicker along the top, has a nose-bridge notch at the bottom
 * center and darker temple areas at the sides. A few quiet lens effects
 * (vignette, a diagonal glare, a slight cool tint, a thin highlight on the
 * frame edge) sit above the camera and below the HUD. The middle of the view
 * is never darkened or blurred.
 *
 * With the phone upright there is no frame: the camera fills the screen and
 * the same HUD sits on top of it.
 *
 * It is a picture of glasses, not a simulation of optics: one continuous view,
 * no separate lenses, no distortion.
 */
import { useEffect, useState, type ReactNode } from 'react';

interface Props {
  /** Before "Put on the glasses": the frame is only hinted at and the lens is dark. */
  off?: boolean;
  /** Plays the one-second power-on: the frame fades in and the HUD boots. */
  booting?: boolean;
  /** Dims the camera behind the HUD (the survey and the thank-you). */
  dim?: boolean;
  cameraLive: boolean;
  children: ReactNode;
}

function clockText(): string {
  const now = new Date();
  return `${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}`;
}

interface BatteryLike {
  level: number;
  addEventListener: (type: 'levelchange', listener: () => void) => void;
  removeEventListener: (type: 'levelchange', listener: () => void) => void;
}

/** The tiny strip in the top corner: camera dot, battery, clock. */
function StatusStrip({ cameraLive }: { cameraLive: boolean }) {
  const [time, setTime] = useState(clockText);
  // The phone's real battery where the browser shares it (iPhone Safari does not): otherwise a plain full icon.
  const [level, setLevel] = useState<number | null>(null);

  useEffect(() => {
    const interval = window.setInterval(() => setTime(clockText()), 10_000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    const getBattery = (navigator as Navigator & { getBattery?: () => Promise<BatteryLike> }).getBattery;
    if (!getBattery) return;
    let battery: BatteryLike | null = null;
    let cancelled = false;
    const update = () => battery && setLevel(battery.level);
    void getBattery
      .call(navigator)
      .then((found) => {
        if (cancelled) return;
        battery = found;
        update();
        found.addEventListener('levelchange', update);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      battery?.removeEventListener('levelchange', update);
    };
  }, []);

  const fill = level === null ? 1 : Math.max(0.08, Math.min(1, level));
  return (
    <div className="status-strip" aria-hidden="true">
      <span className={`status-dot${cameraLive ? ' is-live' : ''}`} />
      <svg className="status-battery" width="22" height="11" viewBox="0 0 22 11">
        <rect x="0.5" y="0.5" width="18" height="10" rx="2.6" fill="none" stroke="currentColor" opacity="0.7" />
        <rect x="2" y="2" width={15 * fill} height="7" rx="1.4" fill="currentColor" />
        <rect x="19.6" y="3.4" width="1.8" height="4.2" rx="0.9" fill="currentColor" opacity="0.7" />
      </svg>
      <span className="status-time">{time}</span>
    </div>
  );
}

export function Glasses({ off, booting, dim, cameraLive, children }: Props) {
  const classes = ['glasses', off ? 'is-off' : '', booting ? 'is-booting' : '', dim ? 'is-dim' : ''].filter(Boolean).join(' ');
  return (
    <div className={classes}>
      <div className="lens">
        <div className="lens-dim" aria-hidden="true" />
        <div className="lens-fx" aria-hidden="true" />
        <div className="hud">{children}</div>
        {!off && <StatusStrip cameraLive={cameraLive} />}
        <div className="lens-edge" aria-hidden="true" />
        <div className="lens-boot" aria-hidden="true" />
      </div>
      {/* Frame details, drawn over the dark surround. */}
      <div className="frame-temple frame-temple-left" aria-hidden="true" />
      <div className="frame-temple frame-temple-right" aria-hidden="true" />
      <div className="frame-bridge" aria-hidden="true" />
    </div>
  );
}
